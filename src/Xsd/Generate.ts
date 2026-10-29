/**
 * Generating a TypeScript module from a compiled schema: an interface or type
 * alias per type, the model as a literal, and a typed parser per global element
 * (with a typed stream, under `streams`, per child of the root element that can
 * occur more than once).
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
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
 * @since 0.3.0
 * @category options
 */
export interface GenerateOptions {
  /** The module the generated code imports the library from (default `"@thomasfosterau/effect-xml"`). */
  readonly importFrom?: string | undefined;
  /** The global elements (expanded names) to write parsers for; all of them by default. */
  readonly roots?: ReadonlyArray<string> | undefined;
  /** A line saying where the schema came from, for the generated file's header. */
  readonly source?: string | undefined;
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

/** The names a generated module binds itself, which no type or parser may take. */
const moduleBindings = ["model", "Xsd", "Xml", "BigDecimal"];

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
  const named = Arr.filter(Record.keys(model.types), (k) => !k.startsWith("#"));
  // Anonymous complex types are named after the first element that has them, global ones first.
  const elements = Record.toEntries(model.elements);
  const ordered = [
    ...Arr.filter(elements, ([k]) => !k.startsWith("#")),
    ...Arr.filter(elements, ([k]) => k.startsWith("#")),
  ];
  const anonymous = Arr.dedupeWith(
    Arr.filter(
      ordered,
      ([, decl]) =>
        decl.type.startsWith("#") &&
        Option.exists(typeOf(model, decl.type), (t) => Predicate.isTagged(t, "ComplexType")),
    ),
    ([, a], [, b]) => a.type === b.type,
  );
  return Record.fromEntries(
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
const literals: Readonly<Record<string, (normalized: string) => Option.Option<string>>> = {
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
  Option.flatMap(Record.get(literals, checker.kind), (write) =>
    write(normalize(lexical, checker.whiteSpace)),
  );

const kindTypes: Readonly<Record<string, string>> = {
  string: "string",
  temporal: "string",
  duration: "string",
  qname: "string",
  boolean: "boolean",
  decimal: "BigDecimal.BigDecimal",
  integer: "bigint",
  number: "number",
  binary: "Uint8Array",
};

/** The TypeScript type of a simple type's values. */
const simpleTs = (checker: SimpleChecker): string => {
  const literals = Option.flatMap(Option.fromNullishOr(checker.enumeration), (values) =>
    Option.all(Arr.map(values, (v) => literal(checker, v))),
  );
  if (Option.isSome(literals) && Arr.isReadonlyArrayNonEmpty(literals.value))
    return Arr.dedupe(literals.value).join(" | ");
  if (checker.kind === "list")
    return `ReadonlyArray<${checker.item === undefined ? "string" : wrap(simpleTs(checker.item))}>`;
  if (checker.kind === "union")
    return Arr.dedupe(Arr.map(checker.members ?? [], simpleTs)).join(" | ") || "string";
  return kindTypes[checker.kind] ?? "string";
};

const wrap = (ts: string): string => (ts.includes(" | ") ? `(${ts})` : ts);

/**
 * Write a TypeScript module for a compiled schema: the types of the values
 * each type produces, the model itself (so nothing is compiled at run time),
 * and a typed {@link Parser} for each global element.
 *
 * Simple types become aliases (enumerations of strings, numbers and booleans
 * become unions of literals), complex types interfaces laid out as
 * {@link XsdRecord} describes. An element whose declared type has named
 * derived types may hold any of them (by `xsi:type`): its type is the union,
 * each derived type marked with its `$type`. Parsers are named after their
 * elements in camel case; types in Pascal case.
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
 * console.log(source.includes(`export const greeting = Xsd.parser<string>(model, "greeting");`)) // true
 * ```
 *
 * @since 0.3.0
 * @category generating
 */
export const generate = (
  model: Model,
  options?: GenerateOptions,
): Effect.Effect<string, XsdSchemaError> =>
  Effect.suspend(() => {
    const runtime = new Runtime(model);
    const failed = Arr.findFirst(Record.keys(model.types), (key) =>
      Result.isFailure(runtime.type(key)),
    );
    if (Option.isSome(failed))
      return Effect.flatMap(Effect.fromResult(runtime.type(failed.value)), () =>
        Effect.succeed(""),
      );
    return Effect.succeed(write(model, runtime, options));
  });

const write = (model: Model, runtime: Runtime, options: GenerateOptions | undefined): string => {
  const names = nameTypes(model);
  const used = { bigDecimal: false, xml: false };

  const simpleRef = (key: string): string => {
    const name = names[key];
    if (name !== undefined) return name;
    const checker = Result.getOrUndefined(runtime.checker(key));
    const ts = checker === undefined ? "string" : simpleTs(checker);
    if (ts.includes("BigDecimal")) used.bigDecimal = true;
    return ts;
  };

  /** The type of a type's values, by reference. */
  const typeRef = (key: string): string => {
    if (key === anyType) return "Xsd.XsdRecord";
    return Option.match(typeOf(model, key), {
      onNone: () => simpleRef(key),
      onSome: (def) =>
        Predicate.isTagged(def, "ComplexType") ? (names[key] ?? "Xsd.XsdRecord") : simpleRef(key),
    });
  };

  /** The type of an element's values: its type, or any named type derived from it, or `null` if nillable. */
  const elementRef = (declKey: string): string =>
    Option.match(runtime.element(declKey), {
      onNone: () => "Xsd.XsdValue",
      onSome: (decl) => {
        const own = typeOf(model, decl.type);
        const derived = Option.exists(own, (t) => Predicate.isTagged(t, "ComplexType"))
          ? Arr.filter(derivedTypes(model, decl.type), (k) =>
              Option.exists(
                typeOf(model, k),
                (t) => Predicate.isTagged(t, "ComplexType") && t.abstract !== true,
              ),
            )
          : [];
        const abstract = Option.exists(
          own,
          (t) => Predicate.isTagged(t, "ComplexType") && t.abstract === true,
        );
        const options = [
          ...(abstract && Arr.isReadonlyArrayNonEmpty(derived) ? [] : [typeRef(decl.type)]),
          ...Arr.map(derived, (k) => `(${typeRef(k)} & { readonly $type: ${quote(k)} })`),
          ...(decl.nillable === true ? ["null"] : []),
        ];
        return options.join(" | ");
      },
    });

  const members = (layout: Layout, def: ComplexType): ReadonlyArray<string> => {
    const attributes = Arr.map(
      layout.attributes,
      (slot) =>
        `  /** The attribute ${slot.name}. */\n  readonly ${propertyKey(slot.property)}${slot.always ? "" : "?"}: ${simpleRef(slot.type)};`,
    );
    const elements = Arr.map(layout.elements, (slot) => {
      const ts = Arr.dedupe(Arr.map(slot.elements, elementRef)).join(" | ");
      const doc = `  /** The element${slot.cardinality === "many" ? "s" : ""} ${slot.name}. */\n`;
      return slot.cardinality === "many"
        ? `${doc}  readonly ${propertyKey(slot.property)}: ReadonlyArray<${wrap(ts)}>;`
        : `${doc}  readonly ${propertyKey(slot.property)}${slot.cardinality === "optional" ? "?" : ""}: ${ts};`;
    });
    const content = Predicate.isTagged(def.content, "Simple") ? simpleRef(def.content.type) : "";
    if (layout.any) used.xml = true;
    return [
      ...attributes,
      ...elements,
      ...(layout.text === "value"
        ? [`  /** The simple content. */\n  readonly $value: ${content};`]
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

  const declarations = Arr.filterMap(Record.toEntries(names), ([key, name]) =>
    Option.match(typeOf(model, key), {
      onNone: () => Result.failVoid,
      onSome: (def) => {
        const owner = Arr.findFirst(Record.values(model.elements), (d) => d.type === key);
        const doc = key.startsWith("#")
          ? `/** The type of the element ${Option.match(owner, { onNone: () => "", onSome: (d) => d.name })}. */\n`
          : `/** The type ${key}. */\n`;
        if (Predicate.isTagged(def, "SimpleType")) {
          const checker = Result.getOrUndefined(runtime.checker(key));
          const ts = checker === undefined ? "string" : simpleTs(checker);
          if (ts.includes("BigDecimal")) used.bigDecimal = true;
          return Result.succeed(`${doc}export type ${name} = ${ts};`);
        }
        return Result.match(runtime.type(key), {
          onFailure: () => Result.failVoid,
          onSuccess: (rt) => {
            if (!Predicate.isTagged(rt, "Complex")) return Result.failVoid;
            const body = members(rt.layout, def);
            return Result.succeed(
              Arr.isReadonlyArrayEmpty(body)
                ? `${doc}export interface ${name} {}`
                : `${doc}export interface ${name} {\n${body.join("\n")}\n}`,
            );
          },
        });
      },
    }),
  );

  const roots =
    options?.roots ?? Arr.filter(Record.keys(model.elements), (k) => !k.startsWith("#"));
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
        Result.match(runtime.type(decl.type), {
          onFailure: () => [],
          onSuccess: (rt) =>
            Predicate.isTagged(rt, "Complex")
              ? Arr.filter(rt.layout.elements, (slot) => slot.cardinality === "many")
              : [],
        }),
    });
  const parsers = Arr.map(parserNames, ([key, name]) => {
    const doc = `/** A parser for documents whose root is <${localOf(key)}> (${key}). */`;
    const slots = repeated(key);
    if (Arr.isReadonlyArrayEmpty(slots))
      return `${doc}\nexport const ${name} = Xsd.parser<${elementRef(key)}>(model, ${quote(key)});`;
    const types = Arr.map(slots, (slot) => {
      const ts = Arr.dedupe(Arr.map(slot.elements, elementRef)).join(" | ");
      return `    /** Streams the <${localOf(slot.name)}> children (${slot.name}). */\n    readonly ${propertyKey(slot.property)}: ${ts};`;
    });
    const children = Arr.map(
      slots,
      (slot) => `  ${propertyKey(slot.property)}: ${quote(slot.name)},`,
    );
    return [
      doc,
      `export const ${name} = Xsd.parser<`,
      `  ${elementRef(key)},`,
      `  {`,
      ...types,
      `  }`,
      `>(model, ${quote(key)}, {`,
      ...children,
      `});`,
    ].join("\n");
  });

  const library = options?.importFrom ?? "@thomasfosterau/effect-xml";
  const header = [
    "// Generated by @thomasfosterau/effect-xml (Xsd.generate). Do not edit.",
    ...(options?.source === undefined ? [] : [`// Source: ${options.source}`]),
  ];
  const imports = [
    ...(used.bigDecimal ? [`import type * as BigDecimal from "effect/BigDecimal";`] : []),
    ...(used.xml ? [`import type { Xml } from ${quote(library)};`] : []),
    `import { Xsd } from ${quote(library)};`,
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
