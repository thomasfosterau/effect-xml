/**
 * Reading XML Schema documents into a {@link Model}.
 *
 * The documents arrive parsed (namespaces resolved) and already gathered, the
 * `include` / `import` graph followed by the caller. Reading indexes every
 * global component of every document, then compiles each one: references are
 * resolved, model groups and attribute groups are inlined, and complex types
 * are flattened into their effective attribute uses and content models
 * (extension appends to the base's content, restriction restates it).
 *
 * Prefixes in attribute values (`type="xs:string"`) are resolved against the
 * namespaces in scope at the element that carries them, which the reader
 * tracks as it descends. A document included into a namespace while having
 * none of its own (a "chameleon" include) takes the including namespace for
 * its components and its unqualified references.
 */
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { Namespaces } from "../../Name.ts";
import type { XmlElement } from "../../Xml/Node.ts";
import { XsdSchemaError } from "../../Xsd/Error.ts";
import {
  builtin,
  clark,
  XS,
  type AttributeDeclaration,
  type AttributeUse,
  type ComplexType,
  type Content,
  type Derivation,
  type ElementDeclaration,
  type Facets,
  type IdentityConstraint,
  type MaxOccurs,
  type Model,
  type NamespaceConstraint,
  type Particle,
  type SimpleType,
  type TypeDefinition,
  type Wildcard,
} from "../../Xsd/Model.ts";
import { anyTypeDefinition } from "./components.ts";
import { builtinBase, isBuiltinSimple } from "./datatypes.ts";
import { translate } from "./regex.ts";

/** A schema document, as the reader sees it. */
export interface SchemaDocument {
  /** Where it was loaded from, for messages (`null` for the entry given as text). */
  readonly location: string | null;
  readonly root: XmlElement;
  /** The namespace a chameleon include puts it in, when it has none of its own. */
  readonly chameleon?: string | undefined;
}

type R<A> = Result.Result<A, XsdSchemaError>;

interface DocContext {
  readonly location: string | null;
  readonly tns: string;
  readonly chameleon: boolean;
  readonly elementQualified: boolean;
  readonly attributeQualified: boolean;
  readonly blockDefault: ReadonlyArray<Derivation>;
}

/** An element of a schema document with the namespaces in scope there. */
interface Node {
  readonly el: XmlElement;
  readonly ns: Readonly<Record<string, string>>;
  readonly doc: DocContext;
}

const anyType = builtin("anyType");
const anySimpleType = builtin("anySimpleType");

const fail = (doc: DocContext, reason: string): R<never> =>
  Result.fail(new XsdSchemaError({ reason, location: doc.location }));

// -----------------------------------------------------------------------------
// Navigating schema documents
// -----------------------------------------------------------------------------

/** The namespaces in scope at `el`, given those in scope at its parent. */
const scopeOf = (
  el: XmlElement,
  parent: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> =>
  Arr.reduce(el.attributes, parent, (scope, a) =>
    a.name.namespace === Namespaces.xmlns
      ? { ...scope, [a.name.local]: a.value }
      : a.name.prefix === null && a.name.local === "xmlns"
        ? { ...scope, "": a.value }
        : scope,
  );

const isXs = (node: Node, ...locals: ReadonlyArray<string>): boolean =>
  node.el.name.namespace === XS && locals.includes(node.el.name.local);

/** The XSD child elements of a node (annotations and foreign elements left out). */
const kids = (node: Node): ReadonlyArray<Node> =>
  Arr.filterMap(node.el.elements, (el) =>
    el.name.namespace === XS && el.name.local !== "annotation"
      ? Result.succeed({ el, ns: scopeOf(el, node.ns), doc: node.doc })
      : Result.failVoid,
  );

const kid = (node: Node, ...locals: ReadonlyArray<string>): Option.Option<Node> =>
  Arr.findFirst(kids(node), (k) => isXs(k, ...locals));

const attr = (node: Node, name: string): Option.Option<string> =>
  node.el.attributeNS(null, name).pipe(Option.map((v) => v.trim()));

const flag = (node: Node, name: string): boolean =>
  Option.match(attr(node, name), { onNone: () => false, onSome: (v) => v === "true" || v === "1" });

const optionalFlag = (node: Node, name: string): boolean | undefined =>
  flag(node, name) ? true : undefined;

const derivations = (value: string): ReadonlyArray<Derivation> =>
  value === "#all"
    ? ["extension", "restriction", "substitution"]
    : Arr.filter(
        value.split(/\s+/),
        (d): d is Derivation => d === "extension" || d === "restriction" || d === "substitution",
      );

/** Resolve a `QName`-valued attribute value to an expanded name. */
const resolveQName = (node: Node, raw: string): R<string> => {
  const value = raw.trim();
  const colon = value.indexOf(":");
  const prefix = colon < 0 ? "" : value.slice(0, colon);
  const local = value.slice(colon + 1);
  const ns =
    prefix === "xml" ? Namespaces.xml : (node.ns[prefix] ?? (prefix === "" ? "" : undefined));
  if (ns === undefined) return fail(node.doc, `the prefix "${prefix}" in "${value}" is not bound`);
  return Result.succeed(clark(ns === "" && node.doc.chameleon ? node.doc.tns : ns, local));
};

const qnameAttr = (node: Node, name: string): R<Option.Option<string>> =>
  Option.match(attr(node, name), {
    onNone: () => Result.succeed(Option.none()),
    onSome: (raw) => Result.map(resolveQName(node, raw), Option.some),
  });

const occurs = (node: Node): R<{ readonly min: number; readonly max: MaxOccurs }> => {
  const min = Option.getOrElse(attr(node, "minOccurs"), () => "1");
  const max = Option.getOrElse(attr(node, "maxOccurs"), () => "1");
  if (!/^\d+$/.test(min) || !(/^\d+$/.test(max) || max === "unbounded"))
    return fail(node.doc, `invalid occurrence bounds minOccurs="${min}" maxOccurs="${max}"`);
  const bounds = {
    min: Number(min),
    max: max === "unbounded" ? "unbounded" : Number(max),
  } as const;
  return bounds.max !== "unbounded" && bounds.max < bounds.min
    ? fail(node.doc, `maxOccurs="${max}" is less than minOccurs="${min}"`)
    : Result.succeed(bounds);
};

/** `min` / `max` as the model writes them: left out when they are the default 1. */
const bounds = (b: { readonly min: number; readonly max: MaxOccurs }) => ({
  min: b.min === 1 ? undefined : b.min,
  max: b.max === 1 ? undefined : b.max,
});

const unsupported = ["redefine", "override", "assert", "assertion", "alternative", "openContent"];

// -----------------------------------------------------------------------------
// Wildcards
// -----------------------------------------------------------------------------

const wildcardOf = (node: Node): Wildcard => {
  const tns = node.doc.tns;
  const tokens = Option.getOrElse(attr(node, "namespace"), () => "##any").split(/\s+/);
  const listed = Arr.map(tokens, (t) =>
    t === "##targetNamespace" ? tns : t === "##local" ? "" : t,
  );
  const namespaces: NamespaceConstraint = tokens.includes("##any")
    ? { _tag: "Any" }
    : tokens.includes("##other")
      ? { _tag: "Not", namespaces: Arr.dedupe([tns, ""]) }
      : { _tag: "Only", namespaces: Arr.dedupe(listed) };
  const process = Option.getOrElse(attr(node, "processContents"), () => "strict");
  return {
    namespaces,
    process: process === "lax" || process === "skip" ? process : "strict",
  };
};

/** A namespace constraint as a set: the namespaces listed, or all but them. */
interface NamespaceSet {
  readonly negated: boolean;
  readonly namespaces: ReadonlyArray<string>;
}

const toSet = (c: NamespaceConstraint): NamespaceSet =>
  Match.valueTags(c, {
    Any: () => ({ negated: true, namespaces: [] }),
    Not: (n) => ({ negated: true, namespaces: n.namespaces }),
    Only: (o) => ({ negated: false, namespaces: o.namespaces }),
  });

const fromSet = (s: NamespaceSet): NamespaceConstraint =>
  !s.negated
    ? { _tag: "Only", namespaces: s.namespaces }
    : Arr.isReadonlyArrayEmpty(s.namespaces)
      ? { _tag: "Any" }
      : { _tag: "Not", namespaces: s.namespaces };

const intersect = (a: NamespaceConstraint, b: NamespaceConstraint): NamespaceConstraint => {
  const [x, y] = [toSet(a), toSet(b)];
  if (x.negated && y.negated)
    return fromSet({ negated: true, namespaces: Arr.union(x.namespaces, y.namespaces) });
  if (!x.negated && !y.negated)
    return fromSet({ negated: false, namespaces: Arr.intersection(x.namespaces, y.namespaces) });
  const [only, not] = x.negated ? [y, x] : [x, y];
  return fromSet({ negated: false, namespaces: Arr.difference(only.namespaces, not.namespaces) });
};

const unite = (a: NamespaceConstraint, b: NamespaceConstraint): NamespaceConstraint => {
  const [x, y] = [toSet(a), toSet(b)];
  if (x.negated && y.negated)
    return fromSet({ negated: true, namespaces: Arr.intersection(x.namespaces, y.namespaces) });
  if (!x.negated && !y.negated)
    return fromSet({ negated: false, namespaces: Arr.union(x.namespaces, y.namespaces) });
  const [only, not] = x.negated ? [y, x] : [x, y];
  return fromSet({ negated: true, namespaces: Arr.difference(not.namespaces, only.namespaces) });
};

const combineWildcards = (
  a: Wildcard | undefined,
  b: Wildcard | undefined,
  op: (x: NamespaceConstraint, y: NamespaceConstraint) => NamespaceConstraint,
): Wildcard | undefined =>
  a === undefined
    ? b
    : b === undefined
      ? a
      : { namespaces: op(a.namespaces, b.namespaces), process: b.process };

// -----------------------------------------------------------------------------
// Particles
// -----------------------------------------------------------------------------

/** Does a particle contain any element or wildcard? */
const hasTerms = (p: Particle): boolean =>
  Predicate.isTagged(p, "Element") || Predicate.isTagged(p, "Any") || p.particles.some(hasTerms);

const facetNames: ReadonlyArray<string> = [
  "length",
  "minLength",
  "maxLength",
  "totalDigits",
  "fractionDigits",
  "minInclusive",
  "maxInclusive",
  "minExclusive",
  "maxExclusive",
  "whiteSpace",
  "enumeration",
  "pattern",
];

const numericFacets = [
  "length",
  "minLength",
  "maxLength",
  "totalDigits",
  "fractionDigits",
] as const;
const boundFacets = ["minInclusive", "maxInclusive", "minExclusive", "maxExclusive"] as const;

const facetKeys: ReadonlyArray<keyof Facets> = [
  ...numericFacets,
  ...boundFacets,
  "patterns",
  "enumeration",
  "whiteSpace",
];

/** The global components of every document, by kind and expanded name. */
interface Index {
  readonly elements: MutableHashMap.MutableHashMap<string, Node>;
  readonly types: MutableHashMap.MutableHashMap<string, Node>;
  readonly attributes: MutableHashMap.MutableHashMap<string, Node>;
  readonly groups: MutableHashMap.MutableHashMap<string, Node>;
  readonly attributeGroups: MutableHashMap.MutableHashMap<string, Node>;
}

const kindOf = (node: Node): keyof Index | undefined =>
  isXs(node, "element")
    ? "elements"
    : isXs(node, "complexType", "simpleType")
      ? "types"
      : isXs(node, "attribute")
        ? "attributes"
        : isXs(node, "group")
          ? "groups"
          : isXs(node, "attributeGroup")
            ? "attributeGroups"
            : undefined;

const contextOf = (doc: SchemaDocument): DocContext => {
  const root: Node = {
    el: doc.root,
    ns: {},
    doc: {
      location: doc.location,
      tns: "",
      chameleon: false,
      elementQualified: false,
      attributeQualified: false,
      blockDefault: [],
    },
  };
  const own = Option.getOrElse(attr(root, "targetNamespace"), () => "");
  const tns = own === "" ? (doc.chameleon ?? "") : own;
  return {
    location: doc.location,
    tns,
    chameleon: own === "" && tns !== "",
    elementQualified: Option.contains(attr(root, "elementFormDefault"), "qualified"),
    attributeQualified: Option.contains(attr(root, "attributeFormDefault"), "qualified"),
    blockDefault: Option.match(attr(root, "blockDefault"), {
      onNone: () => [],
      onSome: derivations,
    }),
  };
};

/** The built-in declarations of the `xml:` attributes, for schemas that refer to them without importing xml.xsd. */
const xmlAttributes: Readonly<Record<string, AttributeDeclaration>> = Record.fromEntries(
  Arr.map(
    [
      ["lang", "string"],
      ["space", "NCName"],
      ["base", "anyURI"],
      ["id", "ID"],
    ] as const,
    ([local, type]) => {
      const name = clark(Namespaces.xml, local);
      return [name, { name, type: builtin(type) }] as const;
    },
  ),
);

/**
 * Compile a set of schema documents (the entry and everything it includes and
 * imports, in any order) into a model.
 */
export const read = (documents: ReadonlyArray<SchemaDocument>): R<Model> => {
  const index: Index = {
    elements: MutableHashMap.empty(),
    types: MutableHashMap.empty(),
    attributes: MutableHashMap.empty(),
    groups: MutableHashMap.empty(),
    attributeGroups: MutableHashMap.empty(),
  };
  const elements = MutableHashMap.empty<string, ElementDeclaration>();
  const types = MutableHashMap.empty<string, TypeDefinition>();
  const attributes = MutableHashMap.empty<string, AttributeDeclaration>();
  /** Types being compiled, to catch a type derived from itself. */
  const compiling = MutableHashSet.empty<string>();
  /** Groups being inlined, to catch a group that contains itself. */
  const inlining = MutableHashSet.empty<string>();
  let counter = 0;
  const fresh = (prefix: string) => `#${prefix}${++counter}`;

  // ---------------------------------------------------------------------------
  // Indexing
  // ---------------------------------------------------------------------------

  const indexDocument = (doc: SchemaDocument): R<void> => {
    const context = contextOf(doc);
    const root: Node = { el: doc.root, ns: scopeOf(doc.root, {}), doc: context };
    if (root.el.name.namespace !== XS || root.el.name.local !== "schema")
      return fail(context, `the document element is <${root.el.name.qualified}>, not xs:schema`);
    return Result.gen(function* () {
      yield* Result.all(
        Arr.map(kids(root), (node): R<void> => {
          if (unsupported.includes(node.el.name.local))
            return fail(context, `xs:${node.el.name.local} is not supported`);
          const kind = kindOf(node);
          if (kind === undefined) return Result.void;
          return Option.match(attr(node, "name"), {
            onNone: () => fail(context, `a global xs:${node.el.name.local} has no name`),
            onSome: (local) => {
              const name = clark(context.tns, local);
              const table = index[kind];
              if (MutableHashMap.has(table, name))
                return fail(
                  context,
                  `${name} is defined twice (as a global ${node.el.name.local})`,
                );
              MutableHashMap.set(table, name, node);
              return Result.void;
            },
          });
        }),
      );
    });
  };

  const lookup = (kind: keyof Index, node: Node, name: string): R<Node> =>
    Option.match(MutableHashMap.get(index[kind], name), {
      onNone: () => fail(node.doc, `no ${kind.replace(/s$/, "")} named ${name} is defined`),
      onSome: Result.succeed,
    });

  // ---------------------------------------------------------------------------
  // Simple types
  // ---------------------------------------------------------------------------

  const isListBuiltin = (key: string) =>
    [builtin("NMTOKENS"), builtin("IDREFS"), builtin("ENTITIES")].includes(key);

  /** The variety of a simple type, compiling it if needed. */
  const variety = (node: Node, key: string): R<SimpleType["variety"]> => {
    if (isBuiltinSimple(key)) return Result.succeed(isListBuiltin(key) ? "list" : "atomic");
    return Result.flatMap(typeDefinition(node, key), (def) =>
      Predicate.isTagged(def, "SimpleType")
        ? Result.succeed(def.variety)
        : fail(node.doc, `${key} is a complex type where a simple type is required`),
    );
  };

  /** Does the simple type `key` derive from the built-in type `ancestor`? */
  const derivesFrom = (key: string, ancestor: string): boolean => {
    if (key === ancestor) return true;
    const next = isBuiltinSimple(key)
      ? builtinBase(key)
      : Option.flatMap(MutableHashMap.get(types, key), (def) =>
          Predicate.isTagged(def, "SimpleType") && def.variety === "atomic"
            ? Option.some(def.base)
            : Option.none(),
        );
    return Option.match(next, {
      onNone: () => false,
      onSome: (base) => base !== key && base !== anySimpleType && derivesFrom(base, ancestor),
    });
  };

  const facetsOf = (node: Node, base: string): R<Facets> => {
    const children = kids(node);
    const values = (name: string) =>
      Arr.filterMap(children, (k) =>
        isXs(k, name) ? Result.fromOption(attr(k, "value"), () => undefined) : Result.failVoid,
      );
    const isQName = derivesFrom(base, builtin("QName")) || derivesFrom(base, builtin("NOTATION"));
    const enumeration = isQName
      ? Result.all(
          Arr.filterMap(children, (k) =>
            isXs(k, "enumeration")
              ? Result.succeed(
                  resolveQName(
                    k,
                    Option.getOrElse(attr(k, "value"), () => ""),
                  ),
                )
              : Result.failVoid,
          ),
        )
      : Result.succeed(
          Arr.filterMap(children, (k) =>
            isXs(k, "enumeration")
              ? Result.succeed(k.el.attribute("value") ?? "")
              : Result.failVoid,
          ),
        );
    return Result.gen(function* () {
      const unknown = Arr.findFirst(
        children,
        (k) => !facetNames.includes(k.el.name.local) && !isXs(k, "simpleType"),
      );
      if (Option.isSome(unknown))
        return yield* fail(node.doc, `xs:${unknown.value.el.name.local} is not a facet`);
      const enumerated = yield* enumeration;
      const numeric = Record.fromEntries(
        Arr.filterMap(numericFacets, (f) =>
          Result.fromOption(
            Option.map(Arr.head(values(f)), (v) => [f, Number(v)] as const),
            () => undefined,
          ),
        ),
      );
      const ranges = Record.fromEntries(
        Arr.filterMap(boundFacets, (f) =>
          Result.fromOption(
            Option.map(Arr.head(values(f)), (v) => [f, v] as const),
            () => undefined,
          ),
        ),
      );
      const patterns = values("pattern");
      const badPattern = Arr.findFirst(Arr.map(patterns, translate), Result.isFailure);
      if (Option.isSome(badPattern) && Result.isFailure(badPattern.value))
        return yield* fail(node.doc, badPattern.value.failure);
      const whiteSpace = Arr.head(values("whiteSpace"));
      const facets: Facets = {
        ...numeric,
        ...ranges,
        patterns: Arr.isReadonlyArrayEmpty(patterns) ? undefined : patterns,
        enumeration: Arr.isReadonlyArrayEmpty(enumerated) ? undefined : enumerated,
        whiteSpace: Option.getOrUndefined(
          Option.filter(
            whiteSpace,
            (ws): ws is "preserve" | "replace" | "collapse" =>
              ws === "preserve" || ws === "replace" || ws === "collapse",
          ),
        ),
      };
      return facets;
    });
  };

  /** A simple type given inline or by name in `attribute`, or the default. */
  const simpleTypeRef = (node: Node, attribute: string, fallback: string): R<string> =>
    Option.match(kid(node, "simpleType"), {
      onSome: (inline) => anonymousType(inline),
      onNone: () =>
        Result.flatMap(qnameAttr(node, attribute), (name) =>
          Option.match(name, {
            onNone: () => Result.succeed(fallback),
            onSome: (key) => knownType(node, key),
          }),
        ),
    });

  /** A type reference, checked to name a type that exists. */
  const knownType = (node: Node, key: string): R<string> =>
    key === anyType || isBuiltinSimple(key) || MutableHashMap.has(index.types, key)
      ? Result.succeed(key)
      : fail(node.doc, `no type named ${key} is defined`);

  const readSimpleType = (node: Node, key: string): R<SimpleType> =>
    Result.gen(function* () {
      const restriction = kid(node, "restriction");
      if (Option.isSome(restriction)) {
        const base = yield* simpleTypeRef(restriction.value, "base", anySimpleType);
        const baseVariety = yield* variety(restriction.value, base);
        const facets = yield* facetsOf(restriction.value, base);
        const def: SimpleType = {
          _tag: "SimpleType",
          name: key,
          variety: baseVariety,
          base,
          facets,
        };
        return def;
      }
      const list = kid(node, "list");
      if (Option.isSome(list)) {
        const itemType = yield* simpleTypeRef(list.value, "itemType", anySimpleType);
        const def: SimpleType = {
          _tag: "SimpleType",
          name: key,
          variety: "list",
          base: anySimpleType,
          itemType,
        };
        return def;
      }
      const union = kid(node, "union");
      if (Option.isSome(union)) {
        const named = yield* Result.all(
          Arr.map(
            Option.match(attr(union.value, "memberTypes"), {
              onNone: () => [],
              onSome: (v) => Arr.filter(v.split(/\s+/), (s) => s !== ""),
            }),
            (raw) => resolveQName(union.value, raw),
          ),
        );
        const inline = yield* Result.all(
          Arr.map(
            Arr.filter(kids(union.value), (k) => isXs(k, "simpleType")),
            anonymousType,
          ),
        );
        const def: SimpleType = {
          _tag: "SimpleType",
          name: key,
          variety: "union",
          base: anySimpleType,
          memberTypes: [...named, ...inline],
        };
        return def;
      }
      return yield* fail(node.doc, `the simple type ${key} has no restriction, list or union`);
    });

  // ---------------------------------------------------------------------------
  // Type definitions
  // ---------------------------------------------------------------------------

  /** Compile an anonymous type and return its key. */
  const anonymousType = (node: Node): R<string> => {
    const key = fresh("t");
    const def: R<TypeDefinition> = isXs(node, "simpleType")
      ? readSimpleType(node, key)
      : readComplexType(node, key);
    return Result.map(def, (d) => {
      MutableHashMap.set(types, key, d);
      return key;
    });
  };

  /** The definition of a named type, compiling it on first use. */
  const typeDefinition = (from: Node, key: string): R<TypeDefinition> => {
    const done = MutableHashMap.get(types, key);
    if (Option.isSome(done)) return Result.succeed(done.value);
    if (MutableHashSet.has(compiling, key))
      return fail(from.doc, `the type ${key} is derived from itself`);
    return Result.flatMap(lookup("types", from, key), (node) => {
      MutableHashSet.add(compiling, key);
      const def: R<TypeDefinition> = isXs(node, "simpleType")
        ? readSimpleType(node, key)
        : readComplexType(node, key);
      MutableHashSet.remove(compiling, key);
      return Result.map(def, (d) => {
        MutableHashMap.set(types, key, d);
        return d;
      });
    });
  };

  /** A base type, as a complex type (a simple type is the content of an attribute-less one). */
  const complexBase = (node: Node, key: string): R<ComplexType> => {
    if (key === anyType) return Result.succeed(anyTypeDefinition);
    if (isBuiltinSimple(key)) return Result.succeed(simpleContentType(key));
    return Result.map(typeDefinition(node, key), (def) =>
      Predicate.isTagged(def, "ComplexType") ? def : simpleContentType(key),
    );
  };

  const simpleContentType = (key: string): ComplexType => ({
    _tag: "ComplexType",
    name: key,
    attributes: [],
    content: { _tag: "Simple", type: key },
  });

  interface Attributes {
    readonly uses: ReadonlyArray<AttributeUse>;
    readonly prohibited: ReadonlyArray<string>;
    readonly wildcard: Wildcard | undefined;
  }

  const readAttributeUse = (node: Node): R<Option.Option<AttributeUse>> =>
    Result.gen(function* () {
      const ref = yield* qnameAttr(node, "ref");
      const use = Option.getOrElse(attr(node, "use"), () => "optional");
      const base = Option.isSome(ref)
        ? yield* globalAttribute(node, ref.value)
        : yield* localAttribute(node);
      if (use === "prohibited") return Option.none();
      const declared = Option.isSome(ref)
        ? MutableHashMap.get(index.attributes, ref.value)
        : Option.none();
      const raw = (n: Node, name: string) => n.el.attributeNS(null, name);
      const fixedValue = Option.orElse(raw(node, "fixed"), () =>
        Option.flatMap(declared, (d) => raw(d, "fixed")),
      );
      const defaultValue = Option.orElse(raw(node, "default"), () =>
        Option.flatMap(declared, (d) => raw(d, "default")),
      );
      const out: AttributeUse = {
        ...base,
        required: use === "required" ? true : undefined,
        fixed: Option.getOrUndefined(fixedValue),
        default: Option.getOrUndefined(defaultValue),
      };
      return Option.some(out);
    });

  const prohibitedName = (node: Node): R<Option.Option<string>> =>
    Option.contains(attr(node, "use"), "prohibited")
      ? Result.flatMap(qnameAttr(node, "ref"), (ref) =>
          Option.match(ref, {
            onSome: (name) => Result.succeed(Option.some(name)),
            onNone: () => Result.map(localAttribute(node), (a) => Option.some(a.name)),
          }),
        )
      : Result.succeed(Option.none());

  const localAttribute = (node: Node): R<AttributeDeclaration> =>
    Option.match(attr(node, "name"), {
      onNone: () => fail(node.doc, "a local xs:attribute has neither a name nor a ref"),
      onSome: (local) => {
        const qualified = Option.match(attr(node, "form"), {
          onNone: () => node.doc.attributeQualified,
          onSome: (f) => f === "qualified",
        });
        return Result.map(simpleTypeRef(node, "type", anySimpleType), (type) => ({
          name: clark(qualified ? node.doc.tns : "", local),
          type,
        }));
      },
    });

  const globalAttribute = (from: Node, name: string): R<AttributeDeclaration> => {
    const done = MutableHashMap.get(attributes, name);
    if (Option.isSome(done)) return Result.succeed(done.value);
    const builtinXml = xmlAttributes[name];
    if (builtinXml !== undefined && !MutableHashMap.has(index.attributes, name))
      return Result.succeed(builtinXml);
    return Result.flatMap(lookup("attributes", from, name), (node) =>
      Result.map(simpleTypeRef(node, "type", anySimpleType), (type) => {
        const decl: AttributeDeclaration = { name, type };
        MutableHashMap.set(attributes, name, decl);
        return decl;
      }),
    );
  };

  /** The attribute uses, prohibitions and wildcard of a type or attribute group's children. */
  const readAttributes = (node: Node): R<Attributes> =>
    Arr.reduce(kids(node), noAttributes, (acc, k) =>
      Result.flatMap(acc, (so) => addAttributes(so, k)),
    );

  const noAttributes: R<Attributes> = Result.succeed({
    uses: [],
    prohibited: [],
    wildcard: undefined,
  });

  const addAttributes = (so: Attributes, k: Node): R<Attributes> => {
    if (isXs(k, "attribute"))
      return Result.flatMap(readAttributeUse(k), (use) =>
        Result.map(prohibitedName(k), (prohibited) => ({
          ...so,
          uses: Option.match(use, { onNone: () => so.uses, onSome: (u) => [...so.uses, u] }),
          prohibited: [...so.prohibited, ...Option.toArray(prohibited)],
        })),
      );
    if (isXs(k, "attributeGroup"))
      return Result.map(attributeGroup(k), (g) => mergeAttributes(so, g));
    if (isXs(k, "anyAttribute"))
      return Result.succeed({
        ...so,
        wildcard: combineWildcards(so.wildcard, wildcardOf(k), intersect),
      });
    return Result.succeed(so);
  };

  const mergeAttributes = (a: Attributes, b: Attributes): Attributes => ({
    uses: [...a.uses, ...b.uses],
    prohibited: [...a.prohibited, ...b.prohibited],
    wildcard: combineWildcards(a.wildcard, b.wildcard, intersect),
  });

  const attributeGroup = (ref: Node): R<Attributes> =>
    Result.gen(function* () {
      const name = yield* qnameAttr(ref, "ref");
      if (Option.isNone(name)) return yield* fail(ref.doc, "a local xs:attributeGroup has no ref");
      if (MutableHashSet.has(inlining, name.value))
        return yield* fail(ref.doc, `the attribute group ${name.value} refers to itself`);
      const group = yield* lookup("attributeGroups", ref, name.value);
      MutableHashSet.add(inlining, name.value);
      const out = readAttributes(group);
      MutableHashSet.remove(inlining, name.value);
      return yield* out;
    });

  /** Base uses overridden by the derived type's, less the prohibited ones. */
  const deriveAttributes = (
    base: ReadonlyArray<AttributeUse>,
    own: Attributes,
  ): ReadonlyArray<AttributeUse> => {
    const replaced = [...Arr.map(own.uses, (u) => u.name), ...own.prohibited];
    return [...Arr.filter(base, (u) => !replaced.includes(u.name)), ...own.uses];
  };

  // ---------------------------------------------------------------------------
  // Complex types
  // ---------------------------------------------------------------------------

  const block = (node: Node): ReadonlyArray<Derivation> | undefined =>
    Option.match(attr(node, "block"), {
      onNone: () =>
        Arr.isReadonlyArrayEmpty(node.doc.blockDefault) ? undefined : node.doc.blockDefault,
      onSome: (v) => derivations(v),
    });

  const contentOf = (particle: Option.Option<Particle>, mixed: boolean): Content =>
    Option.match(
      Option.filter(particle, (p) => mixed || hasTerms(p)),
      {
        onNone: (): Content =>
          mixed
            ? { _tag: "Elements", particle: { _tag: "Sequence", particles: [] } }
            : { _tag: "Empty" },
        onSome: (p): Content => ({ _tag: "Elements", particle: p }),
      },
    );

  /** The content particle among a type's (or derivation's) children, if any. */
  const ownParticle = (node: Node): R<Option.Option<Particle>> =>
    Option.match(kid(node, "sequence", "choice", "all", "group"), {
      onNone: () => Result.succeed(Option.none()),
      onSome: (k) => Result.map(particle(k), Option.some),
    });

  const readComplexType = (node: Node, key: string): R<ComplexType> =>
    Result.gen(function* () {
      const header = {
        _tag: "ComplexType" as const,
        name: key,
        abstract: flag(node, "abstract") ? true : undefined,
        block: block(node),
      };
      const simple = kid(node, "simpleContent");
      if (Option.isSome(simple)) return yield* simpleContent(simple.value, header);
      const complex = kid(node, "complexContent");
      if (Option.isSome(complex))
        return yield* complexContent(complex.value, header, flag(node, "mixed"));
      const mixed = flag(node, "mixed");
      const own = yield* readAttributes(node);
      const particle = yield* ownParticle(node);
      const def: ComplexType = {
        ...header,
        mixed: mixed ? true : undefined,
        base: anyType,
        derivation: "restriction",
        attributes: own.uses,
        anyAttribute: own.wildcard,
        content: contentOf(particle, mixed),
      };
      return def;
    });

  type Header = Pick<ComplexType, "_tag" | "name" | "abstract" | "block">;

  const derivationOf = (node: Node): R<readonly [Node, "extension" | "restriction", string]> =>
    Option.match(kid(node, "extension", "restriction"), {
      onNone: () => fail(node.doc, `xs:${node.el.name.local} has no extension or restriction`),
      onSome: (d) =>
        Result.map(
          Result.flatMap(qnameAttr(d, "base"), (b) =>
            Result.fromOption(
              b,
              () =>
                new XsdSchemaError({
                  reason: "a derivation has no base",
                  location: d.doc.location,
                }),
            ),
          ),
          (base) =>
            [d, d.el.name.local === "extension" ? "extension" : "restriction", base] as const,
        ),
    });

  const simpleContent = (node: Node, header: Header): R<ComplexType> =>
    Result.gen(function* () {
      const [derivation, how, baseKey] = yield* derivationOf(node);
      const base = yield* complexBase(derivation, baseKey);
      if (!Predicate.isTagged(base.content, "Simple"))
        return yield* fail(
          node.doc,
          `the base ${baseKey} of a simple content type has no simple content`,
        );
      const own = yield* readAttributes(derivation);
      const contentType =
        how === "extension"
          ? base.content.type
          : yield* restrictedContent(derivation, base.content.type);
      const def: ComplexType = {
        ...header,
        ...inherit(baseKey, how, base, own),
        content: { _tag: "Simple", type: contentType },
      };
      return def;
    });

  /** What a derived type takes from its base: extension adds to the base's attributes, restriction restates them. */
  const inherit = (
    baseKey: string,
    how: "extension" | "restriction",
    base: ComplexType,
    own: Attributes,
  ): Pick<ComplexType, "base" | "derivation" | "attributes" | "anyAttribute"> => ({
    base: baseKey,
    derivation: how,
    attributes:
      how === "extension"
        ? [...base.attributes, ...own.uses]
        : deriveAttributes(base.attributes, own),
    anyAttribute:
      how === "extension" ? combineWildcards(base.anyAttribute, own.wildcard, unite) : own.wildcard,
  });

  /** The content type of a simple content restriction: the base's, restricted by the facets given. */
  const restrictedContent = (derivation: Node, baseType: string): R<string> =>
    Result.gen(function* () {
      const inline = kid(derivation, "simpleType");
      const base = Option.isSome(inline) ? yield* anonymousType(inline.value) : baseType;
      const facets = yield* facetsOf(derivation, base);
      if (facetKeys.every((k) => facets[k] === undefined)) return base;
      const key = fresh("t");
      const def: SimpleType = {
        _tag: "SimpleType",
        name: key,
        variety: yield* variety(derivation, base),
        base,
        facets,
      };
      MutableHashMap.set(types, key, def);
      return key;
    });

  const complexContent = (node: Node, header: Header, typeMixed: boolean): R<ComplexType> =>
    Result.gen(function* () {
      const [derivation, how, baseKey] = yield* derivationOf(node);
      const base = yield* complexBase(derivation, baseKey);
      const mixed = Option.match(attr(node, "mixed"), {
        onNone: () => typeMixed,
        onSome: (v) => v === "true" || v === "1",
      });
      const own = yield* readAttributes(derivation);
      const particle = yield* ownParticle(derivation);
      const content =
        how === "restriction"
          ? contentOf(particle, mixed)
          : extendContent(base.content, particle, mixed);
      if (how === "extension" && Predicate.isTagged(base.content, "Simple"))
        return yield* fail(
          node.doc,
          `${header.name} extends the simple content of ${baseKey} with complex content`,
        );
      const def: ComplexType = {
        ...header,
        mixed: mixed ? true : undefined,
        ...inherit(baseKey, how, base, own),
        content,
      };
      return def;
    });

  const extendContent = (
    base: Content,
    particle: Option.Option<Particle>,
    mixed: boolean,
  ): Content => {
    const own = Option.filter(particle, hasTerms);
    if (!Predicate.isTagged(base, "Elements")) return contentOf(own, mixed);
    return Option.match(own, {
      onNone: () => base,
      onSome: (p) => ({
        _tag: "Elements",
        particle: { _tag: "Sequence", particles: [base.particle, p] },
      }),
    });
  };

  // ---------------------------------------------------------------------------
  // Particles and element declarations
  // ---------------------------------------------------------------------------

  const particle = (node: Node): R<Particle> =>
    Result.flatMap(occurs(node), (b): R<Particle> => {
      if (isXs(node, "element")) return elementParticle(node, b);
      if (isXs(node, "any"))
        return Result.succeed({ _tag: "Any", wildcard: wildcardOf(node), ...bounds(b) });
      if (isXs(node, "group")) return groupParticle(node, b);
      if (isXs(node, "sequence", "choice", "all")) return modelGroup(node, b);
      return fail(node.doc, `xs:${node.el.name.local} can't appear in a content model`);
    });

  const modelGroup = (
    node: Node,
    b: { readonly min: number; readonly max: MaxOccurs },
  ): R<Particle> =>
    Result.map(
      Result.all(
        Arr.map(
          Arr.filter(kids(node), (k) =>
            isXs(k, "element", "any", "group", "sequence", "choice", "all"),
          ),
          particle,
        ),
      ),
      (particles): Particle => ({
        _tag:
          node.el.name.local === "sequence"
            ? "Sequence"
            : node.el.name.local === "choice"
              ? "Choice"
              : "All",
        particles: Arr.filter(particles, (p) => p.max !== 0),
        ...bounds(b),
      }),
    );

  const groupParticle = (
    ref: Node,
    b: { readonly min: number; readonly max: MaxOccurs },
  ): R<Particle> =>
    Result.gen(function* () {
      const name = yield* qnameAttr(ref, "ref");
      if (Option.isNone(name)) return yield* fail(ref.doc, "a local xs:group has no ref");
      if (MutableHashSet.has(inlining, name.value))
        return yield* fail(ref.doc, `the model group ${name.value} contains itself`);
      const group = yield* lookup("groups", ref, name.value);
      const body = kid(group, "sequence", "choice", "all");
      if (Option.isNone(body))
        return yield* fail(
          group.doc,
          `the model group ${name.value} has no sequence, choice or all`,
        );
      MutableHashSet.add(inlining, name.value);
      const inner = modelGroup(body.value, { min: 1, max: 1 });
      MutableHashSet.remove(inlining, name.value);
      const p = yield* inner;
      return Predicate.isTagged(p, "Element") || Predicate.isTagged(p, "Any")
        ? p
        : { ...p, ...bounds(b) };
    });

  const elementParticle = (
    node: Node,
    b: { readonly min: number; readonly max: MaxOccurs },
  ): R<Particle> =>
    Result.gen(function* () {
      const ref = yield* qnameAttr(node, "ref");
      if (Option.isSome(ref)) {
        yield* lookup("elements", node, ref.value);
        return { _tag: "Element", element: ref.value, ...bounds(b) } as const;
      }
      const local = attr(node, "name");
      if (Option.isNone(local))
        return yield* fail(node.doc, "a local xs:element has neither a name nor a ref");
      const qualified = Option.match(attr(node, "form"), {
        onNone: () => node.doc.elementQualified,
        onSome: (f) => f === "qualified",
      });
      const key = fresh("e");
      const decl = yield* declaration(node, clark(qualified ? node.doc.tns : "", local.value));
      MutableHashMap.set(elements, key, decl);
      return { _tag: "Element", element: key, ...bounds(b) } as const;
    });

  /** The type of a declaration: given by name or inline, the substitution group head's, or `anyType`. */
  const declaredType = (node: Node, head: Option.Option<string>): R<string> =>
    Result.gen(function* () {
      const inline = kid(node, "complexType", "simpleType");
      if (Option.isSome(inline)) return yield* anonymousType(inline.value);
      const named = yield* qnameAttr(node, "type");
      if (Option.isSome(named)) return yield* knownType(node, named.value);
      if (Option.isSome(head)) {
        const decl = yield* globalElement(node, head.value);
        return decl.type;
      }
      return anyType;
    });

  const constraintsOf = (node: Node): R<ReadonlyArray<IdentityConstraint>> =>
    Result.all(
      Arr.map(
        Arr.filter(kids(node), (k) => isXs(k, "unique", "key", "keyref")),
        (k) => identityConstraint(k),
      ),
    );

  const identityConstraint = (node: Node): R<IdentityConstraint> =>
    Result.gen(function* () {
      const local = attr(node, "name");
      if (Option.isNone(local)) return yield* fail(node.doc, "an identity constraint has no name");
      const selector = Option.flatMap(kid(node, "selector"), (s) => attr(s, "xpath"));
      if (Option.isNone(selector))
        return yield* fail(node.doc, `the identity constraint ${local.value} has no selector`);
      const fields = Arr.filterMap(kids(node), (k) =>
        isXs(k, "field") ? Result.fromOption(attr(k, "xpath"), () => undefined) : Result.failVoid,
      );
      const refer = yield* qnameAttr(node, "refer");
      const tag =
        node.el.name.local === "key"
          ? "Key"
          : node.el.name.local === "keyref"
            ? "KeyRef"
            : "Unique";
      const constraint: IdentityConstraint = {
        _tag: tag,
        name: clark(node.doc.tns, local.value),
        refer: Option.getOrUndefined(refer),
        selector: selector.value,
        fields,
        namespaces: Record.filter(node.ns, (_, prefix) => prefix !== ""),
      };
      if (tag === "KeyRef" && Option.isNone(refer))
        return yield* fail(node.doc, `the keyref ${local.value} has no refer`);
      return constraint;
    });

  const declaration = (node: Node, name: string): R<ElementDeclaration> =>
    Result.gen(function* () {
      const head = yield* qnameAttr(node, "substitutionGroup");
      const type = yield* declaredType(node, head);
      const constraints = yield* constraintsOf(node);
      const blocked = block(node);
      const decl: ElementDeclaration = {
        name,
        type,
        nillable: flag(node, "nillable") ? true : undefined,
        abstract: optionalFlag(node, "abstract"),
        // Values are kept as written: the element's type decides their whitespace.
        fixed: Option.getOrUndefined(node.el.attributeNS(null, "fixed")),
        default: Option.getOrUndefined(node.el.attributeNS(null, "default")),
        substitutionGroup: Option.getOrUndefined(head),
        block: blocked,
        constraints: Arr.isReadonlyArrayEmpty(constraints) ? undefined : constraints,
      };
      return decl;
    });

  /** A global element declaration, compiled on first use. */
  const globalElement = (from: Node, name: string): R<ElementDeclaration> => {
    const done = MutableHashMap.get(elements, name);
    if (Option.isSome(done)) return Result.succeed(done.value);
    if (MutableHashSet.has(compiling, name))
      return fail(from.doc, `the substitution group of ${name} contains itself`);
    return Result.flatMap(lookup("elements", from, name), (node) => {
      MutableHashSet.add(compiling, name);
      const decl = declaration(node, name);
      MutableHashSet.remove(compiling, name);
      return Result.map(decl, (d) => {
        MutableHashMap.set(elements, name, d);
        return d;
      });
    });
  };

  // ---------------------------------------------------------------------------
  // Everything
  // ---------------------------------------------------------------------------

  const compileAll = <A>(
    table: MutableHashMap.MutableHashMap<string, Node>,
    compile: (node: Node, name: string) => R<A>,
  ): R<void> =>
    Result.map(
      Result.all(Arr.map(Arr.fromIterable(table), ([name, node]) => compile(node, name))),
      () => undefined,
    );

  return Result.gen(function* () {
    yield* Result.all(Arr.map(documents, indexDocument));
    yield* compileAll(index.types, typeDefinition);
    yield* compileAll(index.elements, globalElement);
    yield* compileAll(index.attributes, globalAttribute);
    const model: Model = {
      elements: Record.fromEntries(Arr.fromIterable(elements)),
      types: Record.fromEntries(Arr.fromIterable(types)),
      attributes: Record.fromEntries(Arr.fromIterable(attributes)),
    };
    return model;
  });
};
