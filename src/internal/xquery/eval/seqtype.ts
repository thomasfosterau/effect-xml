/**
 * Sequence types at run time (XPath 3.1 §2.5): resolving the AST's types,
 * matching values against them (`instance of`, `treat as`, `typeswitch`),
 * subtyping between them (function signatures), and the function conversion
 * rules (§3.1.5.2) that coerce arguments and results.
 *
 * Every tree here is untyped: elements are annotated `xs:untyped`,
 * attributes `xs:untypedAtomic`, so a kind test with another type name
 * matches nothing.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { atomicType, AtomicTypes, derivesFrom, isNumericType, type AtomicType } from "../types.ts";
import { AtomicValue } from "../atomic.ts";
import {
  ArrayItem,
  atomize,
  FunctionItem,
  isAtomic,
  isNode,
  MapItem,
  type Item,
  type Sequence,
} from "../item.ts";
import type { XdmNode } from "../node.ts";
import type {
  EQName,
  ItemType as ItemTypeT,
  SequenceType as SequenceTypeT,
} from "../parser/ast.ts";
import { ItemType, SequenceType } from "../parser/ast.ts";
import type { ExpandedName, NameKind } from "../parser/analyze.ts";
import { Namespaces } from "../parser/builtins.ts";
import { castAtomic } from "./cast.ts";
import { raise, unwrap } from "./raise.ts";
import {
  anySequence,
  arityOf,
  callFunction,
  Closure,
  isCallable,
  type ItemTest,
  type SeqType,
  type Signature,
} from "./runtime.ts";

/** Resolves a name as written to its expanded name. */
export type Resolve = (name: EQName, kind: NameKind) => ExpandedName;

const clarkOf = (n: ExpandedName): string => `{${n.uri}}${n.local}`;

const nodeTest = (
  nodeKind: XdmNode["kind"] | undefined,
  name: string | undefined,
  matches: (node: XdmNode) => boolean,
  annotation?: string,
  content?: ItemTest,
): ItemTest => ({ kind: "node", nodeKind, name, annotation, content, matches });

/** The annotation a kind test's type name requires: none for the types every element or attribute has. */
const annotationOf = (type: Option.Option<EQName>, resolve: Resolve): string | undefined =>
  Option.getOrUndefined(
    Option.filter(
      Option.map(type, (t) => resolve(t, "type")),
      (n) =>
        !(
          n.uri === Namespaces.xs && ["anyType", "anySimpleType", "anyAtomicType"].includes(n.local)
        ),
    ).pipe(Option.map(clarkOf)),
  );

const nameOf = (node: XdmNode): string =>
  Option.match(node.name, {
    onNone: () => "",
    onSome: (q) => `{${Option.getOrElse(q.namespace, () => "")}}${q.local}`,
  });

/** Whether a type annotation named in a kind test admits untyped nodes of `kind`. */
const admitsUntyped = (
  type: Option.Option<EQName>,
  kind: "element" | "attribute",
  resolve: Resolve,
) =>
  Option.match(type, {
    onNone: () => true,
    onSome: (t) => {
      const n = resolve(t, "type");
      const ok =
        kind === "element"
          ? ["anyType", "untyped"]
          : ["anyType", "anySimpleType", "anyAtomicType", "untypedAtomic"];
      return n.uri === Namespaces.xs && ok.includes(n.local);
    },
  });

/** An element or attribute test: the kind, the name unless it is a wildcard, and the type. */
const namedTest = (
  kind: "element" | "attribute",
  name: Option.Option<EQName>,
  type: Option.Option<EQName>,
  resolve: Resolve,
): ItemTest => {
  const clark = Option.map(
    Option.filter(name, (n) => n.local !== "*"),
    (n) => clarkOf(resolve(n, kind)),
  );
  const typed = admitsUntyped(type, kind, resolve);
  const wanted = Option.getOrUndefined(clark);
  return nodeTest(
    kind,
    wanted,
    (node) => typed && node.kind === kind && (wanted === undefined || nameOf(node) === wanted),
    annotationOf(type, resolve),
  );
};

const documentTest = (element: Option.Option<ItemTypeT>, resolve: Resolve): ItemTest => {
  const inner = Option.map(element, (e) => itemTest(e, resolve));
  const matches = (node: XdmNode): boolean => {
    if (node.kind !== "document") return false;
    return Option.match(inner, {
      onNone: () => true,
      onSome: (t) => {
        const elements = node.children.filter((c) => c.kind === "element");
        const [only] = elements;
        return (
          elements.length === 1 &&
          only !== undefined &&
          !node.children.some((c) => c.kind === "text") &&
          itemMatches(t, only)
        );
      },
    });
  };
  return nodeTest("document", undefined, matches, undefined, Option.getOrUndefined(inner));
};

const atomicTest = (name: EQName, resolve: Resolve): ItemTest => {
  const n = resolve(name, "type");
  if (n.uri === Namespaces.xs && n.local === "numeric") return { kind: "numeric" };
  return Option.match(atomicType(n.uri, n.local), {
    onNone: () => raise("XPST0051", `${n.local} is not an atomic type`, name.offset),
    onSome: (type): ItemTest => ({ kind: "atomic", type }),
  });
};

const kindOnly = (kind: XdmNode["kind"]): ItemTest =>
  nodeTest(kind, undefined, (node) => node.kind === kind);

/** Resolve an item type. */
export const itemTest = (t: ItemTypeT, resolve: Resolve): ItemTest =>
  ItemType.$match(t, {
    AnyItem: (): ItemTest => ({ kind: "item" }),
    Atomic: ({ name }) => atomicTest(name, resolve),
    AnyKind: () => nodeTest(undefined, undefined, () => true),
    Document: ({ element }) => documentTest(element, resolve),
    Element: ({ name, type }) => namedTest("element", name, type, resolve),
    Attribute: ({ name, type }) => namedTest("attribute", name, type, resolve),
    // Without a schema there are no element or attribute declarations to match.
    SchemaElement: () => nodeTest("element", undefined, () => false),
    SchemaAttribute: () => nodeTest("attribute", undefined, () => false),
    ProcessingInstruction: ({ target }) => {
      const wanted = Option.getOrUndefined(target);
      return nodeTest(
        "processing-instruction",
        wanted === undefined ? undefined : `{}${wanted}`,
        (node) =>
          node.kind === "processing-instruction" &&
          (wanted === undefined || Option.exists(node.name, (q) => q.local === wanted)),
      );
    },
    Comment: () => kindOnly("comment"),
    Text: () => kindOnly("text"),
    NamespaceNode: () => kindOnly("namespace"),
    AnyFunction: (): ItemTest => ({ kind: "function", params: undefined, result: anySequence }),
    TypedFunction: ({ parameters, result }): ItemTest => ({
      kind: "function",
      params: parameters.map((p) => sequenceType(p, resolve)),
      result: sequenceType(result, resolve),
    }),
    AnyMap: (): ItemTest => ({ kind: "map", key: undefined, value: anySequence }),
    TypedMap: ({ key, value }): ItemTest => {
      const k = atomicTest(key, resolve);
      return {
        kind: "map",
        key: k.kind === "atomic" ? k.type : AtomicTypes.anyAtomicType,
        value: sequenceType(value, resolve),
      };
    },
    AnyArray: (): ItemTest => ({ kind: "array", member: undefined }),
    TypedArray: ({ member }): ItemTest => ({
      kind: "array",
      member: sequenceType(member, resolve),
    }),
  });

/** The bounds of an occurrence indicator. */
const occurrence = (o: string): readonly [number, number] =>
  o === "?" ? [0, 1] : o === "*" ? [0, Infinity] : o === "+" ? [1, Infinity] : [1, 1];

/** Resolve a sequence type. */
export const sequenceType = (t: SequenceTypeT, resolve: Resolve, text = ""): SeqType => {
  if (SequenceType.$is("EmptySequence")(t))
    return { item: undefined, min: 0, max: 0, text: text || "empty-sequence()" };
  const [min, max] = occurrence(t.occurrence);
  return { item: itemTest(t.item, resolve), min, max, text: text || "the declared type" };
};

/** A sequence type of one atomic type and an occurrence (for built-in signatures and constructor functions). */
const atomicSeqType = (type: AtomicType, min: number, max: number): SeqType => ({
  item: { kind: "atomic", type },
  min,
  max,
  text: `xs:${type.name}${min === 0 ? (max === 1 ? "?" : "*") : max === 1 ? "" : "+"}`,
});

// -----------------------------------------------------------------------------
// Matching
// -----------------------------------------------------------------------------

const xsAnyAtomic: SeqType = atomicSeqType(AtomicTypes.anyAtomicType, 1, 1);
const xsInteger: SeqType = atomicSeqType(AtomicTypes.integer, 1, 1);

/** The signature a function item has: its own, or what maps, arrays and host functions are typed as. */
export const signatureOf = (f: FunctionItem | MapItem | ArrayItem): Signature => {
  if (f instanceof Closure) return f.signature;
  if (f instanceof MapItem) return { params: [xsAnyAtomic], result: anySequence };
  if (f instanceof ArrayItem) return { params: [xsInteger], result: anySequence };
  return { params: Array.from({ length: f.arity }, () => anySequence), result: anySequence };
};

const functionMatches = (
  test: Extract<ItemTest, { kind: "function" }>,
  f: FunctionItem | MapItem | ArrayItem,
): boolean => {
  if (test.params === undefined) return true;
  if (arityOf(f) !== test.params.length) return false;
  if (f instanceof MapItem) return f.toEntries().every(([, v]) => sequenceMatches(test.result, v));
  if (f instanceof ArrayItem) return f.members.every((m) => sequenceMatches(test.result, m));
  const sig = signatureOf(f);
  return (
    test.params.every((p, i) => seqSubtype(p, sig.params[i] ?? anySequence)) &&
    seqSubtype(sig.result, test.result)
  );
};

/** Whether an item matches an item type. */
const itemMatches = (test: ItemTest, item: Item): boolean => {
  if (test.kind === "item") return true;
  if (test.kind === "atomic") return isAtomic(item) && derivesFrom(item.type, test.type);
  if (test.kind === "numeric") return isAtomic(item) && isNumericType(item.type);
  if (test.kind === "node") return isNode(item) && test.matches(item);
  if (test.kind === "function") return isCallable(item) && functionMatches(test, item);
  if (test.kind === "map")
    return (
      item instanceof MapItem &&
      (test.key === undefined ||
        item
          .toEntries()
          .every(
            ([k, v]) => derivesFrom(k.type, test.key ?? k.type) && sequenceMatches(test.value, v),
          ))
    );
  return (
    item instanceof ArrayItem &&
    (test.member === undefined ||
      item.members.every((m) => sequenceMatches(test.member ?? anySequence, m)))
  );
};

/** Whether a sequence matches a sequence type. */
export const sequenceMatches = (t: SeqType, s: Sequence): boolean => {
  if (s.length < t.min || s.length > t.max) return false;
  const item = t.item;
  return item === undefined ? Arr.isReadonlyArrayEmpty(s) : s.every((i) => itemMatches(item, i));
};

// -----------------------------------------------------------------------------
// Subtyping
// -----------------------------------------------------------------------------

const atomicSubtype = (a: ItemTest, b: ItemTest): boolean => {
  if (b.kind === "numeric")
    return a.kind === "numeric" || (a.kind === "atomic" && isNumericType(a.type));
  if (b.kind !== "atomic") return false;
  if (a.kind === "numeric") return b.type === AtomicTypes.anyAtomicType;
  return a.kind === "atomic" && derivesFrom(a.type, b.type);
};

/** Whether a node test is at least as narrow as another: same kind, name, annotation and document content. */
const nodeSubtype = (a: ItemTest, b: Extract<ItemTest, { kind: "node" }>): boolean => {
  if (a.kind !== "node") return false;
  if (b.nodeKind === undefined) return true;
  if (a.nodeKind !== b.nodeKind || (b.name !== undefined && a.name !== b.name)) return false;
  if (b.annotation !== undefined && a.annotation !== b.annotation) return false;
  const content = b.content;
  return content === undefined || (a.content !== undefined && itemSubtype(a.content, content));
};

/** Subtyping against a function test: maps and arrays are functions of one argument. */
const functionSubtype = (a: ItemTest, b: Extract<ItemTest, { kind: "function" }>): boolean => {
  const params = b.params;
  if (params === undefined) return a.kind === "function" || a.kind === "map" || a.kind === "array";
  if (a.kind === "map") return params.length === 1 && seqSubtype(a.value, b.result);
  if (a.kind === "array")
    return params.length === 1 && seqSubtype(a.member ?? anySequence, b.result);
  if (a.kind !== "function" || a.params === undefined || a.params.length !== params.length)
    return false;
  const own = a.params;
  return (
    params.every((p, i) => seqSubtype(p, own[i] ?? anySequence)) && seqSubtype(a.result, b.result)
  );
};

const mapSubtype = (a: ItemTest, b: Extract<ItemTest, { kind: "map" }>): boolean => {
  if (a.kind !== "map") return false;
  if (b.key === undefined) return true;
  return a.key !== undefined && derivesFrom(a.key, b.key) && seqSubtype(a.value, b.value);
};

const arraySubtype = (a: ItemTest, b: Extract<ItemTest, { kind: "array" }>): boolean => {
  if (a.kind !== "array") return false;
  if (b.member === undefined) return true;
  return a.member !== undefined && seqSubtype(a.member, b.member);
};

/** Whether every item of type `a` is of type `b` (XPath 3.1 §2.5.6.2). */
const itemSubtype = (a: ItemTest, b: ItemTest): boolean => {
  if (b.kind === "item") return true;
  if (b.kind === "atomic" || b.kind === "numeric") return atomicSubtype(a, b);
  if (b.kind === "node") return nodeSubtype(a, b);
  if (b.kind === "function") return functionSubtype(a, b);
  if (b.kind === "map") return mapSubtype(a, b);
  return arraySubtype(a, b);
};

/** Whether every sequence of type `a` is of type `b`. */
const seqSubtype = (a: SeqType, b: SeqType): boolean => {
  if (a.item === undefined) return b.min === 0;
  if (b.item === undefined) return false;
  return a.min >= b.min && a.max <= b.max && itemSubtype(a.item, b.item);
};

// -----------------------------------------------------------------------------
// The function conversion rules
// -----------------------------------------------------------------------------

/** Convert an atomized value to an expected atomic type: cast `xs:untypedAtomic`, promote numbers and URIs. */
const convertAtomic = (a: AtomicValue, test: ItemTest, offset?: number): AtomicValue => {
  if (test.kind === "numeric") {
    return a.type === AtomicTypes.untypedAtomic
      ? castAtomic(a, AtomicTypes.double, undefined, offset)
      : a;
  }
  if (test.kind !== "atomic") return a;
  const target = test.type;
  if (a.type === AtomicTypes.untypedAtomic)
    return target === AtomicTypes.anyAtomicType || target === AtomicTypes.untypedAtomic
      ? a
      : castAtomic(a, target, undefined, offset);
  if (derivesFrom(a.type, target)) return a;
  const promotes =
    (target === AtomicTypes.double && isNumericType(a.type)) ||
    (target === AtomicTypes.float &&
      (a.type.primitive === "decimal" || a.type.primitive === "float")) ||
    (target === AtomicTypes.string && derivesFrom(a.type, AtomicTypes.anyURI));
  return promotes ? castAtomic(a, target, undefined, offset) : a;
};

const mismatch = (t: SeqType, s: Sequence, what: string, offset?: number): never => {
  const got =
    s.length === 1 && s[0] !== undefined && isAtomic(s[0])
      ? `an xs:${s[0].type.name}`
      : `${s.length} items`;
  return raise("XPTY0004", `${what} must be ${t.text}, not ${got}`, offset);
};

/**
 * Whether a map or array can stand for a function type unchanged: every
 * argument the type admits is a valid key (an atomic value for a map, an
 * integer for an array), every value is of the result type, and for a map the
 * result type admits the empty sequence a missing key returns (`map(K, V)` is
 * a `function(xs:anyAtomicType) as V?`, XPath 3.1 §2.5.6.1).
 */
const standsFor = (
  test: Extract<ItemTest, { kind: "function" }>,
  params: ReadonlyArray<SeqType>,
  item: MapItem | ArrayItem,
): boolean => {
  const own = signatureOf(item).params;
  return (
    params.every((p, i) => seqSubtype(p, own[i] ?? anySequence)) &&
    (item instanceof ArrayItem || test.result.min === 0) &&
    functionMatches(test, item)
  );
};

/**
 * A function item, map or array coerced to a function type (XPath 3.1
 * §3.1.5.3): called through a wrapper that converts its arguments to the
 * expected parameter types and its result to the expected result type. A map
 * or array that already stands for the type is passed through, so it stays a
 * map or array; one that does not (`[1, true()]` where a predicate is
 * expected) is wrapped like any other function item.
 */
const coerceFunction = (
  test: Extract<ItemTest, { kind: "function" }>,
  item: Item,
  what: string,
  offset?: number,
): Item => {
  if (test.params === undefined) return item;
  if (!isCallable(item) || arityOf(item) !== test.params.length)
    return raise("XPTY0004", `${what} must be a function of arity ${test.params.length}`, offset);
  const params = test.params;
  const isFunction = item instanceof FunctionItem;
  if (!isFunction && standsFor(test, params, item)) return item;
  const sig: Signature = { params, result: test.result };
  return new Closure(isFunction ? item.name : Option.none(), sig, (args) =>
    coerce(
      test.result,
      callFunction(
        item,
        args.map((a, i) => coerce(params[i] ?? anySequence, a, `argument ${i + 1}`, offset)),
        offset,
      ),
      "the result",
      offset,
    ),
  );
};

/**
 * `s` if it matches `t`, else `err:XPTY0004`: SequenceType matching with no
 * conversion, as a declared variable's or context item's value is checked
 * in XQuery 3.1 (§4.16, §4.17).
 */
export const matchType = (t: SeqType, s: Sequence, what: string, offset?: number): Sequence =>
  sequenceMatches(t, s) ? s : mismatch(t, s, what, offset);

/** The sequence type of exactly one item of `t`, as `declare context item as t` declares. */
export const singleItemType = (t: ItemTypeT, resolve: Resolve): SeqType => ({
  item: itemTest(t, resolve),
  min: 1,
  max: 1,
  text: "the declared context item type",
});

/** Exactly one item of any kind: the context item's type when none is declared. */
export const anySingleItem: SeqType = {
  item: { kind: "item" },
  min: 1,
  max: 1,
  text: "exactly one item",
};

/**
 * Apply the function conversion rules to a value for a parameter or result
 * of type `t`: atomize and convert for atomic types, coerce function items
 * to function types, then check the type, failing with `err:XPTY0004`.
 */
export const coerce = (t: SeqType, s: Sequence, what: string, offset?: number): Sequence => {
  const test = t.item;
  if (test === undefined) return Arr.isReadonlyArrayEmpty(s) ? s : mismatch(t, s, what, offset);
  let value = s;
  if (test.kind === "atomic" || test.kind === "numeric")
    value = unwrap(atomize(s), offset).map((a) => convertAtomic(a, test, offset));
  else if (test.kind === "function" && test.params !== undefined)
    value = s.map((item) => coerceFunction(test, item, what, offset));
  return sequenceMatches(t, value) ? value : mismatch(t, value, what, offset);
};
