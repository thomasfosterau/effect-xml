/**
 * Generating a TypeScript module from a compiled schema: a `Schema` and its
 * type per type, the model as a literal, and a parser per global element that
 * decodes through its element's schema (with a stream, named in `streams`,
 * per child of the root element that can occur more than once).
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as HashSet from "effect/HashSet";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  derivedTypes,
  localOf,
  typeOf,
  anyType,
  type ElementSlot,
  type Layout,
} from "../internal/xsd/components.ts";
import { normalize, type SimpleChecker } from "../internal/xsd/datatypes.ts";
import { quote } from "../internal/quote.ts";
import { Runtime } from "../internal/xsd/runtime.ts";
import type { XsdSchemaError } from "./Error.ts";
import type { ComplexType, Model } from "./Model.ts";

/**
 * Options for {@link generate}.
 *
 * @since 0.1.0
 * @category options
 */
export interface GenerateOptions {
  /** The module the generated code imports the library from (default `"@thomasfosterau/effect-xml"`). */
  readonly importFrom?: string;
  /** The global elements (expanded names) to write parsers for; all of them by default. */
  readonly roots?: ReadonlyArray<string>;
  /** A line saying where the schema came from, for the generated file's header. */
  readonly source?: string;
}

const reserved: ReadonlyArray<string> =
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with as implements interface let package private protected public static yield any boolean number string symbol bigint object never unknown undefined await type".split(
    " ",
  );

const words = (name: string): ReadonlyArray<string> =>
  Arr.filter(name.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/), (w) => w !== "");

const pascal = (name: string): string => {
  const out = Arr.map(words(name), (w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return out === "" || /^\d/.test(out) ? `T${out}` : out;
};

const camel = (name: string): string => {
  const p = pascal(name);
  const out = p.charAt(0).toLowerCase() + p.slice(1);
  return reserved.includes(out) ? `${out}_` : out;
};

/** The first of `name`, `name2`, `name3`, … not in `taken`. */
const fresh = (taken: ReadonlyArray<string>, name: string, n = 1): string => {
  const candidate = n === 1 ? name : `${name}${n}`;
  return taken.includes(candidate) || reserved.includes(candidate)
    ? fresh(taken, name, n + 1)
    : candidate;
};

const propertyKey = (name: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : quote(name);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

/** The names a generated module binds itself or uses, which no type or parser may take. */
const moduleBindings = [
  "model",
  "Xsd",
  "Xml",
  "Schema",
  "BigDecimal",
  "Option",
  "ReadonlyArray",
  "Readonly",
  "Record",
  "Uint8Array",
];

/** Uniquely named: each wanted name, numbered when it is taken. */
const uniquely = (
  wanted: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<readonly [string, string]> =>
  Arr.reduce(wanted, Arr.empty<readonly [string, string]>(), (out, [key, name]) => [
    ...out,
    [
      key,
      fresh(
        Arr.map(out, ([, n]) => n),
        name,
      ),
    ] as const,
  ]);

/** The TypeScript names given to the schema's types. */
const nameTypes = (model: Model): Readonly<Record<string, string>> => {
  const named = Arr.filter(R.keys(model.types), (k) => !k.startsWith("#"));
  // Anonymous complex types are named after the first element that has them, global ones first.
  const elements = R.toEntries(model.elements);
  const ordered = [
    ...Arr.filter(elements, ([k]) => !k.startsWith("#")),
    ...Arr.filter(elements, ([k]) => k.startsWith("#")),
  ];
  const anonymous = Arr.dedupeWith(
    Arr.filter(
      ordered,
      ([, decl]) =>
        decl.type.startsWith("#") &&
        Option.exists(typeOf(model, decl.type), (t) => P.isTagged(t, "ComplexType")),
    ),
    ([, a], [, b]) => a.type === b.type,
  );
  return R.fromEntries(
    Arr.drop(
      uniquely([
        ...Arr.map(moduleBindings, (n) => [n, n] as const),
        ...Arr.map(named, (k) => [k, pascal(localOf(k))] as const),
        ...Arr.map(anonymous, ([, decl]) => [decl.type, pascal(localOf(decl.name))] as const),
      ]),
      moduleBindings.length,
    ),
  );
};

const quoted = (normalized: string): Option.Option<string> => Option.some(quote(normalized));

/** How an enumerated value of each kind is written as a TypeScript literal, where it can be. */
interface Literals {
  readonly [key: string]: (normalized: string) => Option.Option<string>;
}

const literals: Literals = {
  string: quoted,
  temporal: quoted,
  duration: quoted,
  qname: quoted,
  number: (v) => (/^[+-]?\d+(\.\d+)?$/.test(v) ? Option.some(String(Number(v))) : Option.none()),
  integer: (v) =>
    /^[+-]?\d+$/.test(v) ? Option.some(`${BigInt(v.replace(/^\+/, ""))}n`) : Option.none(),
  boolean: (v) => Option.some(v === "true" || v === "1" ? "true" : "false"),
};

/** A literal of a simple type's value, if an enumerated lexical form can be written as one. */
const literal = (checker: SimpleChecker, lexical: string): Option.Option<string> =>
  Option.flatMap(
    R.get<string, (normalized: string) => Option.Option<string>>(literals, checker.kind),
    (write) => write(normalize(lexical, checker.whiteSpace)),
  );

/** How a value kind is written: its TypeScript type and its schema. */
interface KindCode {
  readonly [kind: string]: readonly [ts: string, schema: string];
}

const kindCode: KindCode = {
  string: ["string", "Schema.String"],
  temporal: ["string", "Schema.String"],
  duration: ["string", "Schema.String"],
  qname: ["string", "Schema.String"],
  boolean: ["boolean", "Schema.Boolean"],
  decimal: ["BigDecimal.BigDecimal", "Schema.BigDecimal"],
  integer: ["bigint", "Schema.BigInt"],
  int: ["number", "Schema.Int"],
  number: ["number", "Schema.Number"],
  binary: ["Uint8Array", "Schema.Uint8Array"],
};

/** A simple type's value space, which its TypeScript type and its schema are written from. */
type Space = Data.TaggedEnum<{
  Atom: { readonly kind: string };
  Literals: { readonly values: Arr.NonEmptyReadonlyArray<string> };
  List: { readonly item: Space };
  Union: { readonly members: Arr.NonEmptyReadonlyArray<Space> };
}>;

const Space = Data.taggedEnum<Space>();

/** A simple type's value space. */
const spaceOf = (checker: SimpleChecker): Space => {
  const enumerated = Option.flatMap(Option.fromNullishOr(checker.enumeration), (values) =>
    Option.all(Arr.map(values, (v) => literal(checker, v))),
  );
  if (Option.isSome(enumerated) && Arr.isReadonlyArrayNonEmpty(enumerated.value))
    return Space.Literals({ values: Arr.dedupe(enumerated.value) });
  if (checker.kind === "list")
    return Space.List({
      item: checker.item === undefined ? Space.Atom({ kind: "string" }) : spaceOf(checker.item),
    });
  const members = checker.members ?? [];
  if (checker.kind === "union")
    return Arr.isReadonlyArrayNonEmpty(members)
      ? Space.Union({ members: Arr.map(members, spaceOf) })
      : Space.Atom({ kind: "string" });
  // Integers that fit a `number` (`int`, `short`, …) are checked as integers.
  return Space.Atom({
    kind: checker.kind === "number" && checker.primitive === "decimal" ? "int" : checker.kind,
  });
};

const wrap = (ts: string): string => (ts.includes(" | ") ? `(${ts})` : ts);

/** The TypeScript type of a value space. */
const spaceTs: (space: Space) => string = Space.$match({
  Atom: ({ kind }) => kindCode[kind]?.[0] ?? "string",
  Literals: ({ values }) => values.join(" | "),
  List: ({ item }) => `ReadonlyArray<${wrap(spaceTs(item))}>`,
  Union: ({ members }) => Arr.dedupe(Arr.map(members, spaceTs)).join(" | "),
});

const literalsSchema = (values: ReadonlyArray<string>): string =>
  values.length === 1
    ? `Schema.Literal(${values.join("")})`
    : `Schema.Literals([${values.join(", ")}])`;

/** A union of schemas, or the one schema when there is only one. */
const union = (schemas: ReadonlyArray<string>): string => {
  const distinct = Arr.dedupe(schemas);
  return distinct.length === 1 ? distinct.join("") : `Schema.Union([${distinct.join(", ")}])`;
};

/** The literals of a union whose members are all enumerations, merged. */
const unionLiterals = (members: ReadonlyArray<Space>): Option.Option<ReadonlyArray<string>> =>
  Option.map(
    Option.all(
      Arr.map(members, (m) => (Space.$is("Literals")(m) ? Option.some(m.values) : Option.none())),
    ),
    (values) => Arr.dedupe(Arr.flatten(values)),
  );

/** The schema of a value space. */
const spaceSchema: (space: Space) => string = Space.$match({
  Atom: ({ kind }) => kindCode[kind]?.[1] ?? "Schema.String",
  Literals: ({ values }) => literalsSchema(values),
  List: ({ item }) => `Schema.Array(${spaceSchema(item)})`,
  Union: ({ members }) =>
    Option.match(unionLiterals(members), {
      onNone: () => union(Arr.map(members, spaceSchema)),
      onSome: literalsSchema,
    }),
});

/** Whether a value space's TypeScript type names `BigDecimal`. */
const usesDecimal: (space: Space) => boolean = Space.$match({
  Atom: ({ kind }) => kind === "decimal",
  Literals: () => false,
  List: ({ item }) => usesDecimal(item),
  Union: ({ members }) => Arr.some(members, usesDecimal),
});

/** The nodes reachable from `start`, `start` included. */
const closure =
  (edges: (node: string) => ReadonlyArray<string>) =>
  (start: string): HashSet.HashSet<string> => {
    const grow = (
      frontier: ReadonlyArray<string>,
      seen: HashSet.HashSet<string>,
    ): HashSet.HashSet<string> => {
      const next = Arr.dedupe(
        Arr.filter(Arr.flatMap(frontier, edges), (node) => !HashSet.has(seen, node)),
      );
      return Arr.isReadonlyArrayEmpty(next)
        ? seen
        : grow(
            next,
            Arr.reduce(next, seen, (set, node) => HashSet.add(set, node)),
          );
    };
    return grow([start], HashSet.make(start));
  };

/**
 * Write a TypeScript module for a compiled schema: a `Schema` for the values
 * of each type, with its type alias, the model itself (so nothing is compiled
 * at run time), and a {@link Parser} for each global element that decodes
 * through its element's schema.
 *
 * Each schema describes the {@link XsdValue} validation builds and decodes
 * it as it is: its `Encoded` and `Type` are the same, and the module's types
 * are its schemas' (`export type Line = typeof Line.Type`). Simple types are
 * `Schema.String`, `Schema.Boolean`, `Schema.Int` (integers that fit a
 * `number`), `Schema.Number` (`float`, `double`), `Schema.BigInt`,
 * `Schema.BigDecimal`, `Schema.Uint8Array`, `Schema.Array` of the item for a
 * list and `Schema.Union` of the members for a union; enumerations of
 * strings, numbers and booleans are `Schema.Literals`. Complex types are
 * `Schema.Struct`s laid out as {@link XsdRecord} describes: an optional
 * property is a `Schema.optionalKey`, a nillable element a `Schema.Option`,
 * wildcard matches DOM elements (`Schema.toType(Xml.XmlElement)`) and an
 * `xs:anyType` element an {@link XsdRecord}. An element whose declared type
 * has named derived types may hold any of them (by `xsi:type`): its schema is
 * the union, each derived type marked with its `$type` and listed before the
 * declared type, whose schema would otherwise take (and strip) their values.
 * A type whose values can contain its own is written out as an object type,
 * which its schema's `Schema.suspend` references name. Property names are
 * written as strings, as they are XML names; parsers are named after their
 * elements in camel case, schemas and types in Pascal case.
 *
 * The module imports only `effect/Schema` (and, for written-out types,
 * `effect/BigDecimal` and `effect/Option` types) and the library's `Xsd` and
 * `Xml` namespaces from `importFrom`.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xsd } from "@thomasfosterau/effect-xml"
 *
 * const model = Effect.runSync(
 *   Xsd.compile(`
 *     <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
 *       <xs:element name="greeting" type="xs:string"/>
 *     </xs:schema>`)
 * )
 * const source = Effect.runSync(Xsd.generate(model))
 * console.log(source.includes(`export const greeting = Xsd.parser(model, "greeting", Schema.String);`)) // true
 * ```
 *
 * @since 0.1.0
 * @category generating
 */
export const generate = (
  model: Model,
  options?: GenerateOptions,
): Effect.Effect<string, XsdSchemaError> =>
  Effect.suspend(() => {
    const runtime = new Runtime(model);
    const failed = Arr.findFirst(R.keys(model.types), (key) => Result.isFailure(runtime.type(key)));
    if (Option.isSome(failed)) return Effect.as(Effect.fromResult(runtime.type(failed.value)), "");
    return Effect.succeed(write(model, runtime, options));
  });

/** One of the types an element's values may have, as a schema. */
interface Alternative {
  /** The complex type it is made from, when it references one. */
  readonly type: Option.Option<string>;
  /** Its TypeScript type, for a suspended reference's annotation. */
  readonly ts: string;
  readonly schema: string;
}

/** The simple type of a complex type's simple content. */
const contentType = (def: ComplexType): Option.Option<string> =>
  P.isTagged(def.content, "Simple") ? Option.some(def.content.type) : Option.none();

/** A reference to a type in the same cycle is suspended, as the type may not be declared yet. */
const reference =
  (cycle: ReadonlyArray<string>) =>
  (alt: Alternative): string =>
    Option.exists(alt.type, (t) => cycle.includes(t))
      ? `Schema.suspend((): Schema.Codec<${alt.ts}> => ${alt.schema})`
      : alt.schema;

const write = (model: Model, runtime: Runtime, options?: GenerateOptions): string => {
  const names = nameTypes(model);
  const used = { decimal: false, xml: false, option: false };

  const isComplex = (key: string): boolean =>
    Option.exists(typeOf(model, key), (t) => P.isTagged(t, "ComplexType"));

  const spaceAt = (key: string): Space =>
    Option.match(Result.getSuccess(runtime.checker(key)), {
      onNone: () => Space.Atom({ kind: "string" }),
      onSome: spaceOf,
    });

  // ---- TypeScript types: written for the interfaces of recursive types ----

  const simpleTs = (key: string): string => {
    const name = names[key];
    if (name !== undefined) return name;
    const space = spaceAt(key);
    if (usesDecimal(space)) used.decimal = true;
    return spaceTs(space);
  };

  /** The type of a type's values, by reference. */
  const typeTs = (key: string): string => {
    if (key === anyType) return "Xsd.XsdRecord";
    return isComplex(key) ? (names[key] ?? "Xsd.XsdRecord") : simpleTs(key);
  };

  /** The complex types derived from an element's declared type, which `xsi:type` may name. */
  const derivedOf = (type: string): ReadonlyArray<string> =>
    isComplex(type)
      ? Arr.filter(
          derivedTypes(model, type),
          (k) =>
            names[k] !== undefined &&
            Option.exists(
              typeOf(model, k),
              (t) => P.isTagged(t, "ComplexType") && t.abstract !== true,
            ),
        )
      : [];

  const isAbstract = (type: string): boolean =>
    Option.exists(typeOf(model, type), (t) => P.isTagged(t, "ComplexType") && t.abstract === true);

  const variantTs = (k: string): string => `${typeTs(k)} & { readonly $type: ${quote(k)} }`;

  /** The type of an element's values: its type, or any named type derived from it, as an `Option` if nillable. */
  const elementTs = (declKey: string): string =>
    Option.match(runtime.element(declKey), {
      onNone: () => "Xsd.XsdValue",
      onSome: (decl) => {
        const derived = derivedOf(decl.type);
        const alternatives = [
          ...(isAbstract(decl.type) && Arr.isReadonlyArrayNonEmpty(derived)
            ? []
            : [typeTs(decl.type)]),
          ...Arr.map(derived, (k) => `(${variantTs(k)})`),
        ].join(" | ");
        if (decl.nillable !== true) return alternatives;
        used.option = true;
        return `Option.Option<${alternatives}>`;
      },
    });

  const slotTs = (slot: ElementSlot): string =>
    Arr.dedupe(Arr.map(slot.elements, elementTs)).join(" | ");

  const membersTs = (layout: Layout, def: ComplexType): ReadonlyArray<string> => {
    if (layout.any) used.xml = true;
    return [
      ...Arr.map(
        layout.attributes,
        (slot) =>
          `  /** The attribute ${slot.name}. */\n  readonly ${propertyKey(slot.property)}${slot.always ? "" : "?"}: ${simpleTs(slot.type)};`,
      ),
      ...Arr.map(layout.elements, (slot) => {
        const ts = slotTs(slot);
        const doc = `  /** The element${slot.cardinality === "many" ? "s" : ""} ${slot.name}. */\n`;
        return slot.cardinality === "many"
          ? `${doc}  readonly ${propertyKey(slot.property)}: ReadonlyArray<${wrap(ts)}>;`
          : `${doc}  readonly ${propertyKey(slot.property)}${slot.cardinality === "optional" ? "?" : ""}: ${ts};`;
      }),
      ...(layout.text === "value"
        ? [
            `  /** The simple content. */\n  readonly $value: ${Option.match(contentType(def), { onNone: () => "string", onSome: simpleTs })};`,
          ]
        : []),
      ...(layout.text === "mixed"
        ? [`  /** The text of the mixed content. */\n  readonly $text: string;`]
        : []),
      ...(layout.any
        ? [
            `  /** Elements matched by wildcards. */\n  readonly $any: ReadonlyArray<Xml.XmlElement>;`,
          ]
        : []),
      ...(layout.anyAttribute
        ? [
            `  /** Attributes matched by \`anyAttribute\`, by expanded name. */\n  readonly $attributes?: Readonly<Record<string, string>>;`,
          ]
        : []),
    ];
  };

  // ---- Schemas ----

  const simpleSchema = (key: string): string => names[key] ?? spaceSchema(spaceAt(key));

  /** The schema of a type's values, by reference. */
  const typeSchema = (key: string): string => {
    if (key === anyType) return "Xsd.XsdRecord";
    return isComplex(key) ? (names[key] ?? "Xsd.XsdRecord") : simpleSchema(key);
  };

  /**
   * The schema of an element's values. The types derived from its declared
   * type come first: each has the properties of the declared type, and more.
   */
  const elementSchema = (declKey: string, cycle: ReadonlyArray<string>): string =>
    Option.match(runtime.element(declKey), {
      onNone: () => "Xsd.XsdValue",
      onSome: (decl) => {
        const derived = derivedOf(decl.type);
        const alternatives: ReadonlyArray<Alternative> = [
          ...Arr.map(derived, (k) => ({
            type: Option.some(k),
            ts: variantTs(k),
            schema: `Schema.Struct({ ...${typeSchema(k)}.fields, "$type": Schema.Literal(${quote(k)}) })`,
          })),
          ...(isAbstract(decl.type) && Arr.isReadonlyArrayNonEmpty(derived)
            ? []
            : [
                {
                  type: isComplex(decl.type) ? Option.some(decl.type) : Option.none(),
                  ts: names[decl.type] ?? "",
                  schema: typeSchema(decl.type),
                },
              ]),
        ];
        const schema = union(Arr.map(alternatives, reference(cycle)));
        return decl.nillable === true ? `Schema.Option(${schema})` : schema;
      },
    });

  /** How many types derive from a declaration's type: more derived types sort first. */
  const derivedCount = (declKey: string): number =>
    Option.match(runtime.element(declKey), {
      onNone: () => 0,
      onSome: (decl) => derivedTypes(model, decl.type).length,
    });

  /**
   * The schema of a slot's values. Elements whose types derive from another's
   * come before it, so the other's schema doesn't take (and strip) their values.
   */
  const slotSchema = (slot: ElementSlot, cycle: ReadonlyArray<string>): string =>
    union(
      Arr.map(Arr.sortWith(slot.elements, derivedCount, Order.Number), (declKey) =>
        elementSchema(declKey, cycle),
      ),
    );

  const membersSchema = (
    layout: Layout,
    def: ComplexType,
    cycle: ReadonlyArray<string>,
  ): ReadonlyArray<string> => {
    if (layout.any) used.xml = true;
    return [
      ...Arr.map(layout.attributes, (slot) => {
        const schema = simpleSchema(slot.type);
        return `  /** The attribute ${slot.name}. */\n  ${quote(slot.property)}: ${slot.always ? schema : `Schema.optionalKey(${schema})`},`;
      }),
      ...Arr.map(layout.elements, (slot) => {
        const schema = slotSchema(slot, cycle);
        const doc = `  /** The element${slot.cardinality === "many" ? "s" : ""} ${slot.name}. */\n`;
        const field =
          slot.cardinality === "many"
            ? `Schema.Array(${schema})`
            : slot.cardinality === "optional"
              ? `Schema.optionalKey(${schema})`
              : schema;
        return `${doc}  ${quote(slot.property)}: ${field},`;
      }),
      ...(layout.text === "value"
        ? [
            `  /** The simple content. */\n  "$value": ${Option.match(contentType(def), { onNone: () => "Schema.String", onSome: simpleSchema })},`,
          ]
        : []),
      ...(layout.text === "mixed"
        ? [`  /** The text of the mixed content. */\n  "$text": Schema.String,`]
        : []),
      ...(layout.any
        ? [
            `  /** Elements matched by wildcards. */\n  "$any": Schema.Array(Schema.toType(Xml.XmlElement)),`,
          ]
        : []),
      ...(layout.anyAttribute
        ? [
            `  /** Attributes matched by \`anyAttribute\`, by expanded name. */\n  "$attributes": Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),`,
          ]
        : []),
    ];
  };

  // ---- Declarations ----

  const describe = (key: string): string => {
    const owner = Arr.findFirst(R.values(model.elements), (d) => d.type === key);
    return key.startsWith("#")
      ? `the type of the element ${Option.match(owner, { onNone: () => "", onSome: (d) => d.name })}`
      : `the type ${key}`;
  };

  const simpleDeclarations = Arr.filterMap(R.toEntries(names), ([key, name]) =>
    Option.exists(typeOf(model, key), (t) => P.isTagged(t, "SimpleType"))
      ? Result.succeed(
          [
            `/** The schema of ${describe(key)}. */`,
            `export const ${name} = ${spaceSchema(spaceAt(key))};`,
            `/** The values of ${describe(key)}. */`,
            `export type ${name} = typeof ${name}.Type;`,
          ].join("\n"),
        )
      : Result.failVoid,
  );

  /** The complex types to declare, with their layouts. */
  const complexTypes = Arr.filterMap(R.toEntries(names), ([key]) =>
    Option.match(typeOf(model, key), {
      onNone: () => Result.failVoid,
      onSome: (def) =>
        P.isTagged(def, "ComplexType")
          ? Result.match(runtime.type(key), {
              onFailure: () => Result.failVoid,
              onSuccess: (rt) =>
                P.isTagged(rt, "Complex")
                  ? Result.succeed([key, def, rt.layout] as const)
                  : Result.failVoid,
            })
          : Result.failVoid,
    }),
  );
  const complexKeys = Arr.map(complexTypes, ([key]) => key);
  const layouts = R.fromEntries(
    Arr.map(complexTypes, ([key, def, layout]) => [key, [def, layout] as const]),
  );

  /** The complex types a complex type's values contain. */
  const references = (key: string): ReadonlyArray<string> =>
    Option.match(R.get(layouts, key), {
      onNone: () => [],
      onSome: ([, layout]) =>
        Arr.filter(
          Arr.flatMap(layout.elements, (slot) =>
            Arr.flatMap(slot.elements, (declKey) =>
              Option.match(runtime.element(declKey), {
                onNone: () => [],
                onSome: (decl) => [decl.type, ...derivedOf(decl.type)],
              }),
            ),
          ),
          (k) => R.has(layouts, k),
        ),
    });

  const complexDeclaration = (key: string, cycle: ReadonlyArray<string>): string =>
    Option.match(R.get(layouts, key), {
      onNone: () => "",
      onSome: ([def, layout]) => {
        const name = names[key] ?? "";
        const fields = membersSchema(layout, def, cycle);
        const schema = Arr.isReadonlyArrayEmpty(fields)
          ? `Schema.Struct({})`
          : `Schema.Struct({\n${fields.join("\n")}\n})`;
        const constant = [
          `/** The schema of ${describe(key)}. */`,
          `export const ${name} = ${schema};`,
        ];
        if (!Arr.isReadonlyArrayNonEmpty(cycle))
          return [
            ...constant,
            `/** The values of ${describe(key)}. */`,
            `export type ${name} = typeof ${name}.Type;`,
          ].join("\n");
        // A recursive type is written out: its schema's type refers to it.
        const body = membersTs(layout, def);
        return [
          `/** The values of ${describe(key)}. */`,
          Arr.isReadonlyArrayEmpty(body)
            ? `export type ${name} = Record<never, never>;`
            : `export type ${name} = {\n${body.join("\n")}\n};`,
          ...constant,
        ].join("\n");
      },
    });

  // Declared dependencies first: a type reaches strictly more types than any
  // type it reaches that doesn't reach it back. A type in a cycle (one some
  // type it references reaches back) is written out, and its references into
  // the cycle suspended.
  const edges = R.fromEntries(Arr.map(complexKeys, (k) => [k, references(k)] as const));
  const reach = R.fromEntries(
    Arr.map(complexKeys, (k) => [k, closure((n) => edges[n] ?? [])(k)] as const),
  );
  const reaches = (from: string, to: string): boolean =>
    Option.exists(R.get(reach, from), (set) => HashSet.has(set, to));
  const cycleOf = (key: string): ReadonlyArray<string> =>
    Arr.some(edges[key] ?? [], (k) => reaches(k, key))
      ? Arr.filter(complexKeys, (k) => reaches(key, k) && reaches(k, key))
      : [];
  const complexDeclarations = Arr.map(
    Arr.sortWith(
      complexKeys,
      (k) => Option.match(R.get(reach, k), { onNone: () => 0, onSome: HashSet.size }),
      Order.Number,
    ),
    (key) => complexDeclaration(key, cycleOf(key)),
  );

  // ---- Parsers ----

  const roots = options?.roots ?? Arr.filter(R.keys(model.elements), (k) => !k.startsWith("#"));
  const rootDecls = Arr.filter(roots, (key) =>
    Option.exists(runtime.element(key), (decl) => decl.abstract !== true),
  );
  // The module's own bindings come first, so no parser can take their names.
  const parserNames = Arr.drop(
    uniquely([
      ...Arr.map(moduleBindings, (n) => [n, n] as const),
      ...Arr.map(rootDecls, (key) => [key, camel(localOf(key))] as const),
    ]),
    moduleBindings.length,
  );
  /** The child elements of a root that can occur more than once: the ones it gets a stream for. */
  const repeated = (key: string): ReadonlyArray<ElementSlot> =>
    Option.match(runtime.element(key), {
      onNone: () => [],
      onSome: (decl) =>
        Option.match(R.get(layouts, decl.type), {
          onNone: () => [],
          onSome: ([, layout]) =>
            Arr.filter(layout.elements, (slot) => slot.cardinality === "many"),
        }),
    });
  const parsers = Arr.map(parserNames, ([key, name]) => {
    const doc = `/** A parser for documents whose root is <${localOf(key)}> (${key}). */`;
    const head = `export const ${name} = Xsd.parser(model, ${quote(key)}, ${elementSchema(key, [])}`;
    const slots = repeated(key);
    if (Arr.isReadonlyArrayEmpty(slots)) return `${doc}\n${head});`;
    const children = Arr.map(
      slots,
      (slot) =>
        `  /** Streams the <${localOf(slot.name)}> children (${slot.name}). */\n  ${propertyKey(slot.property)}: { element: ${quote(slot.name)}, schema: ${slotSchema(slot, [])} },`,
    );
    return [doc, `${head}, {`, ...children, `});`].join("\n");
  });

  const library = options?.importFrom ?? "@thomasfosterau/effect-xml";
  const header = [
    "// Generated by @thomasfosterau/effect-xml (Xsd.generate). Do not edit.",
    ...(options?.source === undefined ? [] : [`// Source: ${options.source}`]),
  ];
  const declarations = [...simpleDeclarations, ...complexDeclarations];
  const imports = [
    ...(used.decimal ? [`import type * as BigDecimal from "effect/BigDecimal";`] : []),
    ...(used.option ? [`import type * as Option from "effect/Option";`] : []),
    ...(Arr.some([...declarations, ...parsers], (c) => c.includes("Schema."))
      ? [`import * as Schema from "effect/Schema";`]
      : []),
    `import { ${used.xml ? "Xml, " : ""}Xsd } from ${quote(library)};`,
  ];
  return (
    [
      header.join("\n"),
      imports.join("\n"),
      ...declarations,
      `/** The compiled schema. */\nexport const model: Xsd.Model = ${encodeJson(model)};`,
      ...parsers,
    ].join("\n\n") + "\n"
  );
};
