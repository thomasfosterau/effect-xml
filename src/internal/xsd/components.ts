/**
 * Questions about a compiled {@link Model} that both validation and code
 * generation ask: which elements can stand in for a substitution group head,
 * how one type derives from another, what a wildcard admits, and how a complex
 * type's value is laid out as a record.
 */
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import {
  builtin,
  type ComplexType,
  type ElementDeclaration,
  type MaxOccurs,
  type Model,
  type Particle,
  type TypeDefinition,
  type Wildcard,
} from "../../Xsd/Model.ts";
import { builtinBase, isBuiltinSimple } from "./datatypes.ts";
import { isIn, tagSet } from "../tagSet.ts";

export const anyType = builtin("anyType");
export const anySimpleType = builtin("anySimpleType");

/** `xs:anyType`: any attributes, any content, mixed. */
export const anyTypeDefinition: ComplexType = {
  _tag: "ComplexType",
  name: anyType,
  mixed: true,
  attributes: [],
  anyAttribute: { namespaces: { _tag: "Any" }, process: "lax" },
  content: {
    _tag: "Elements",
    particle: {
      _tag: "Sequence",
      particles: [
        {
          _tag: "Any",
          wildcard: { namespaces: { _tag: "Any" }, process: "lax" },
          min: 0,
          max: "unbounded",
        },
      ],
    },
  },
};

/** The namespace of an expanded name in Clark notation (`""` for none). */
export const namespaceOf = (name: string): string =>
  name.startsWith("{") ? name.slice(1, name.indexOf("}")) : "";

/** The local part of an expanded name in Clark notation. */
export const localOf = (name: string): string =>
  name.startsWith("{") ? name.slice(name.indexOf("}") + 1) : name;

/** Does a wildcard admit a name in `namespace`? */
export const allows = (wildcard: Wildcard, namespace: string): boolean =>
  Match.valueTags(wildcard.namespaces, {
    Any: () => true,
    Only: (c) => c.namespaces.includes(namespace),
    Not: (c) => !c.namespaces.includes(namespace),
  });

/** A type definition by key: user-defined, `anyType`, or (for a built-in simple type) nothing. */
export const typeOf = (model: Model, key: string): Option.Option<TypeDefinition> =>
  key === anyType ? Option.some(anyTypeDefinition) : Record.get(model.types, key);

/** The type a type is derived from, and how; nothing for `anyType`. */
const baseOf = (
  model: Model,
  key: string,
): Option.Option<readonly [string, "extension" | "restriction"]> => {
  if (key === anyType) return Option.none();
  if (isBuiltinSimple(key)) return Option.map(builtinBase(key), (b) => [b, "restriction"] as const);
  return Option.map(Record.get(model.types, key), (def) =>
    Predicate.isTagged(def, "SimpleType")
      ? ([def.base, "restriction"] as const)
      : ([def.base ?? anyType, def.derivation ?? "restriction"] as const),
  );
};

/** The derivation methods on the way from `base` down to `derived`, if `derived` derives from `base`. */
export const derivationPath = (
  model: Model,
  derived: string,
  base: string,
): Option.Option<ReadonlyArray<"extension" | "restriction">> => {
  if (derived === base) return Option.some([]);
  return Option.flatMap(baseOf(model, derived), ([next, how]) =>
    next === derived
      ? Option.none()
      : Option.map(derivationPath(model, next, base), (rest) => [how, ...rest]),
  );
};

/** The types derived from `key` (not `key` itself) that the model defines by name. */
export const derivedTypes = (model: Model, key: string): ReadonlyArray<string> =>
  Arr.filter(
    Record.keys(model.types),
    (k) => !k.startsWith("#") && k !== key && Option.isSome(derivationPath(model, k, key)),
  );

/**
 * The elements that may appear where the global element `head` is expected
 * (`head` itself included unless abstract), as `[name, declaration key]`. A
 * member is left out when the head blocks substitution or the derivation of its
 * type.
 */
export const substitutionsOf = (
  model: Model,
): ((head: string) => ReadonlyArray<readonly [string, string]>) => {
  const cache = MutableHashMap.empty<string, ReadonlyArray<readonly [string, string]>>();
  const headOf = (decl: ElementDeclaration) => decl.substitutionGroup;
  const inGroup = (key: string, head: string, depth: number): boolean => {
    if (key === head) return true;
    const next = Option.flatMap(Record.get(model.elements, key), (d) =>
      Option.fromNullishOr(headOf(d)),
    );
    return (
      depth < 64 &&
      Option.match(next, { onNone: () => false, onSome: (h) => inGroup(h, head, depth + 1) })
    );
  };
  const blocked = (head: ElementDeclaration, member: ElementDeclaration): boolean => {
    const blocks = tagSet(
      ...(head.block ?? []),
      ...Option.match(typeOf(model, head.type), {
        onNone: () => [],
        onSome: (t) => (Predicate.isTagged(t, "ComplexType") ? (t.block ?? []) : []),
      }),
    );
    return Option.match(derivationPath(model, member.type, head.type), {
      onNone: () => true,
      onSome: (path) => path.some((how) => isIn(blocks, how)),
    });
  };
  const compute = (head: string): ReadonlyArray<readonly [string, string]> =>
    Option.match(Record.get(model.elements, head), {
      onNone: () => [],
      onSome: (decl) =>
        decl.block?.includes("substitution")
          ? decl.abstract === true
            ? []
            : [[decl.name, head] as const]
          : Arr.filter(
              Record.toEntries(model.elements),
              ([key, member]) =>
                !key.startsWith("#") &&
                member.abstract !== true &&
                inGroup(key, head, 0) &&
                (key === head || !blocked(decl, member)),
            ).map(([key, member]) => [member.name, key] as const),
    });
  return (head) =>
    Option.getOrElse(MutableHashMap.get(cache, head), () => {
      // Local declarations are never substitution group heads.
      const out = head.startsWith("#")
        ? Arr.fromOption(
            Option.map(Record.get(model.elements, head), (d) => [d.name, head] as const),
          )
        : compute(head);
      MutableHashMap.set(cache, head, out);
      return out;
    });
};

// -----------------------------------------------------------------------------
// Layout: how a complex type's value is laid out as a record
// -----------------------------------------------------------------------------

/** How many values a property holds. */
export type Cardinality = "one" | "optional" | "many";

/** A property holding the values of child elements with one name. */
export interface ElementSlot {
  readonly name: string;
  readonly property: string;
  readonly cardinality: Cardinality;
  /** The declarations (by key) the elements are validated against. */
  readonly elements: ReadonlyArray<string>;
}

/** A property holding an attribute's value. */
export interface AttributeSlot {
  readonly name: string;
  readonly property: string;
  /** Present on every value: required, or given a default or fixed value. */
  readonly always: boolean;
  readonly type: string;
}

/** The record a complex type's values are. */
export interface Layout {
  readonly attributes: ReadonlyArray<AttributeSlot>;
  readonly elements: ReadonlyArray<ElementSlot>;
  readonly byName: Readonly<Record<string, ElementSlot>>;
  /** Elements matched by wildcards are kept, as DOM elements, under `$any`. */
  readonly any: boolean;
  /** Attributes matched by `anyAttribute` are kept, by expanded name, under `$attributes`. */
  readonly anyAttribute: boolean;
  /** Simple content is kept under `$value`; the text of mixed content under `$text`. */
  readonly text: "value" | "mixed" | "none";
}

type Range = readonly [number, number];

const toNumber = (max: MaxOccurs): number => (max === "unbounded" ? Infinity : max);

const scale = ([lo, hi]: Range, min: number, max: number): Range => [
  lo * min,
  hi === 0 || max === 0 ? 0 : hi * max,
];

const mergeWith = (
  a: Readonly<Record<string, Range>>,
  b: Readonly<Record<string, Range>>,
  f: (x: Range, y: Range) => Range,
  absent: Range,
): Readonly<Record<string, Range>> =>
  Record.fromEntries(
    Arr.map(
      Arr.union(Record.keys(a), Record.keys(b)),
      (k) => [k, f(a[k] ?? absent, b[k] ?? absent)] as const,
    ),
  );

const sum = (x: Range, y: Range): Range => [x[0] + y[0], x[1] + y[1]];
const either = (x: Range, y: Range): Range => [Math.min(x[0], y[0]), Math.max(x[1], y[1])];

interface Occurrences {
  /** By element name, how often it occurs. */
  readonly ranges: Readonly<Record<string, Range>>;
  /** By element name, the declarations that apply, in document order. */
  readonly elements: ReadonlyArray<readonly [string, string]>;
  readonly any: boolean;
}

const occurrences = (
  substitutes: (head: string) => ReadonlyArray<readonly [string, string]>,
  particle: Particle,
): Occurrences => {
  const min = particle.min ?? 1;
  const max = toNumber(particle.max ?? 1);
  if (Predicate.isTagged(particle, "Any")) return { ranges: {}, elements: [], any: max > 0 };
  if (Predicate.isTagged(particle, "Element")) {
    const named = substitutes(particle.element);
    const single = named.length === 1;
    return {
      ranges: Record.fromEntries(
        Arr.map(
          named,
          ([name]) => [name, single ? ([min, max] as const) : ([0, max] as const)] as const,
        ),
      ),
      elements: named,
      any: false,
    };
  }
  const parts = Arr.map(particle.particles, (p) => occurrences(substitutes, p));
  const choice = Predicate.isTagged(particle, "Choice");
  const combined = Arr.reduce(parts, Option.none<Readonly<Record<string, Range>>>(), (acc, part) =>
    Option.some(
      Option.match(acc, {
        onNone: () => part.ranges,
        onSome: (so) =>
          choice
            ? mergeWith(so, part.ranges, either, [0, 0])
            : mergeWith(so, part.ranges, sum, [0, 0]),
      }),
    ),
  );
  return {
    ranges: Record.map(
      Option.getOrElse(combined, () => ({})),
      (r) => scale(r, min, max),
    ),
    elements: Arr.flatMap(parts, (p) => p.elements),
    any: max > 0 && parts.some((p) => p.any),
  };
};

const cardinality = ([lo, hi]: Range): Cardinality =>
  hi > 1 ? "many" : lo >= 1 ? "one" : "optional";

/** The first of `local`, `local$2`, `local$3`, … that isn't taken. */
const unique = (taken: ReadonlyArray<string>, wanted: string, n = 1): string => {
  const candidate = n === 1 ? wanted : `${wanted}$${n}`;
  return taken.includes(candidate) ? unique(taken, wanted, n + 1) : candidate;
};

/** The layout of a complex type's values. */
export const layoutOf = (
  substitutes: (head: string) => ReadonlyArray<readonly [string, string]>,
  def: ComplexType,
): Layout => {
  const occ = Predicate.isTagged(def.content, "Elements")
    ? occurrences(substitutes, def.content.particle)
    : { ranges: {}, elements: [], any: false };
  const names = Arr.dedupe(Arr.map(occ.elements, ([name]) => name));
  const elements = Arr.reduce(names, Arr.empty<ElementSlot>(), (slots, name) => [
    ...slots,
    {
      name,
      property: unique(
        Arr.map(slots, (s) => s.property),
        localOf(name),
      ),
      cardinality: cardinality(occ.ranges[name] ?? [0, 0]),
      elements: Arr.dedupe(Arr.filter(occ.elements, ([n]) => n === name).map(([, key]) => key)),
    },
  ]);
  const attributes = Arr.reduce(def.attributes, Arr.empty<AttributeSlot>(), (slots, use) => {
    const taken = [...Arr.map(elements, (e) => e.property), ...Arr.map(slots, (s) => s.property)];
    const local = localOf(use.name);
    return [
      ...slots,
      {
        name: use.name,
        property: taken.includes(local) ? unique(taken, `@${local}`) : local,
        always: use.required === true || use.default !== undefined || use.fixed !== undefined,
        type: use.type,
      },
    ];
  });
  return {
    attributes,
    elements,
    byName: Record.fromEntries(Arr.map(elements, (e) => [e.name, e] as const)),
    any: occ.any,
    anyAttribute: def.anyAttribute !== undefined,
    text: Predicate.isTagged(def.content, "Simple")
      ? "value"
      : def.mixed === true
        ? "mixed"
        : "none",
  };
};
