/**
 * Schema-aware parsing: validating SAX events against a {@link Model} as they
 * stream, and building the typed value of the document.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import { localOf, namespaceOf } from "../internal/xsd/components.ts";
import { Runtime } from "../internal/xsd/runtime.ts";
import { compileStreamable } from "../internal/streamPath.ts";
import { Validator, type Failure } from "../internal/xsd/validator.ts";
import type { Limits } from "../Limits.ts";
import * as Sax from "../Sax.ts";
import type { CompileOptions, Path, XPathError } from "../Xml/XPath.ts";
import type { XsdSchemaError, XsdValidationError } from "./Error.ts";
import type { Model } from "./Model.ts";
import { XsdValue as XsdValueSchema, type Validated, type XsdValue } from "./Value.ts";
import { maybe } from "../internal/optional.ts";

/**
 * Everything schema-aware parsing can fail with: a parse error, a schema the
 * model can't be validated with, or the first way the document is invalid.
 *
 * @since 0.1.0
 * @category errors
 */
export type XsdError = SaxError | XsdSchemaError | XsdValidationError;

/**
 * Options for validating: which global element the document must have as its root.
 *
 * @since 0.1.0
 * @category options
 */
export interface ValidateOptions {
  /** The expanded name (`{namespace}local`) the document element must have; any global element otherwise. */
  readonly root?: string;
}

/**
 * Options for the parsing functions: the validation options plus the SAX options that apply to XML.
 *
 * @since 0.1.0
 * @category options
 */
export interface ParseOptions extends ValidateOptions {
  /** Named entity table override. */
  readonly entities?: Record<string, string>;
  /** Resource limits; the ones left out keep their defaults (see {@link Limits}). */
  readonly limits?: Partial<Limits>;
  /** Interpret the DOCTYPE internal subset (see {@link Sax.SaxOptions.dtd}); default `"ignore"`. */
  readonly dtd?: "ignore" | "internal";
  /** An external encoding hint for byte input, such as the `charset` of a `Content-Type`. */
  readonly encoding?: string;
}

const saxOptions = (options?: ParseOptions): Sax.SaxBytesOptions => ({
  ...options,
  mode: "xml",
});

/** Each model is compiled for validation once, however often it is used. */
const runtimes = new WeakMap<Model, Runtime>();

const runtimeOf = (model: Model): Runtime => {
  const known = runtimes.get(model);
  if (known !== undefined) return known;
  const runtime = new Runtime(model);
  runtimes.set(model, runtime);
  return runtime;
};

/** Feed a chunk of events to a validator: the first failure, if any. */
const acceptAll = (
  validator: Validator,
  events: ReadonlyArray<Sax.SaxEvent>,
): Option.Option<Failure> =>
  Arr.reduce(events, Option.none<Failure>(), (failure, ev) =>
    Option.isSome(failure) ? failure : Option.fromNullOr(validator.accept(ev)),
  );

/**
 * Validate a stream of SAX events against a schema as they pass through,
 * failing the stream at the first violation.
 *
 * @since 0.1.0
 * @category validating
 */
export const validate =
  (model: Model, options?: ValidateOptions) =>
  <E, R>(events: Stream.Stream<Sax.SaxEvent, E, R>): Stream.Stream<Sax.SaxEvent, E | XsdError, R> =>
    Stream.suspend(() => {
      const validator = new Validator(runtimeOf(model), options);
      const body = Stream.mapArrayEffect(events, (chunk) => {
        return Option.match(acceptAll(validator, chunk), {
          onNone: () => Effect.succeed(chunk),
          onSome: Effect.fail,
        });
      });
      const tail = Stream.suspend(() => {
        const failure = validator.finish();
        return failure === null ? Stream.empty : Stream.fail(failure);
      });
      return Stream.concat(body, tail);
    });

/**
 * Validate a stream of SAX events against a schema and build the document's typed value.
 *
 * @since 0.1.0
 * @category validating
 */
export const decode =
  (model: Model, options?: ValidateOptions) =>
  <E, R>(events: Stream.Stream<Sax.SaxEvent, E, R>): Effect.Effect<Validated, E | XsdError, R> =>
    Effect.suspend(() => {
      const validator = new Validator(runtimeOf(model), options);
      return Stream.runForEachArray(events, (chunk) => {
        return Option.match(acceptAll(validator, chunk), {
          onNone: () => Effect.void,
          onSome: Effect.fail,
        });
      }).pipe(
        Effect.flatMap(() => {
          const failure = validator.finish();
          return failure === null
            ? Effect.succeed(
                Option.getOrElse(validator.result, (): Validated => ({
                  name: "",
                  value: Option.none(),
                })),
              )
            : Effect.fail(failure);
        }),
      );
    });

/**
 * Options for {@link select}: the validation options, plus the namespace
 * prefixes a string path is compiled with.
 *
 * @since 0.1.0
 * @category options
 */
export interface SelectOptions extends ValidateOptions, CompileOptions {}

/**
 * Validate a stream of SAX events against a schema, streaming out the typed
 * value of each element that matches `path` as soon as it is complete.
 *
 * This is how a large document is decoded in constant memory: each `row` of a
 * worksheet or `entry` of a feed is emitted and dropped, rather than kept in
 * the document's value. The whole document is still validated, and the
 * stream fails at the first violation anywhere in it, so values emitted
 * before a violation came from a document later found invalid.
 *
 * `path` is the streamable part of the XPath subset, as for `Sax.select`:
 * child (`/`) and descendant (`//`) steps with element name tests, and
 * predicates on the element's own attributes and name. A match inside a
 * selected element is part of its value, not emitted again.
 *
 * A selected element is not delivered to its parent, so the parent's value
 * changes shape in one way: a property for a repeated child stays an empty
 * array (so the generated types still hold), and a property for a child that
 * occurs at most once is left out.
 *
 * An element inside an identity-constraint scope (a `unique`, `key` or
 * `keyref` declared on it or an ancestor) is held until that scope's element
 * ends and its constraints hold, and then emitted.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 * import { Sax, Xsd } from "@thomasfosterau/effect-xml"
 *
 * const model = Effect.runSync(
 *   Xsd.compile(`
 *     <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
 *       <xs:element name="feed">
 *         <xs:complexType>
 *           <xs:sequence>
 *             <xs:element name="entry" maxOccurs="unbounded">
 *               <xs:complexType><xs:attribute name="n" type="xs:int"/></xs:complexType>
 *             </xs:element>
 *           </xs:sequence>
 *         </xs:complexType>
 *       </xs:element>
 *     </xs:schema>`)
 * )
 *
 * const entries = Stream.make(`<feed><entry n="1"/><entry n="2"/></feed>`).pipe(
 *   Sax.tokenize(),
 *   Xsd.select(model, "/feed/entry"),
 *   Stream.runCollect
 * )
 *
 * console.log(Effect.runSync(entries)) // [{ n: 1 }, { n: 2 }]
 * ```
 *
 * @since 0.1.0
 * @category validating
 */
export const select =
  (model: Model, path: string | Path, options?: SelectOptions) =>
  <E, R>(
    events: Stream.Stream<Sax.SaxEvent, E, R>,
  ): Stream.Stream<XsdValue, E | XsdError | XPathError, R> =>
    Stream.suspend((): Stream.Stream<XsdValue, E | XsdError | XPathError, R> => {
      const steps = compileStreamable(path, options);
      if (Result.isFailure(steps)) return Stream.fail(steps.failure);
      const validator = new Validator(runtimeOf(model), {
        ...maybe("root", options?.root),
        select: steps.success,
      });
      // Each chunk of events becomes the values it completed, then its failure if it has one.
      const body = Stream.mapArray(events, (chunk) => {
        const failure = acceptAll(validator, chunk);
        return [{ values: validator.drain(), failure }] as const;
      }).pipe(
        Stream.flatMap(({ values, failure }) =>
          Option.match(failure, {
            onNone: () => Stream.fromIterable(values),
            onSome: (f) => Stream.concat(Stream.fromIterable(values), Stream.fail(f)),
          }),
        ),
      );
      const tail = Stream.suspend(() => {
        const failure = validator.finish();
        return failure === null ? Stream.fromIterable(validator.drain()) : Stream.fail(failure);
      });
      return Stream.concat(body, tail);
    });

/**
 * Parse and validate an XML string against a schema, building its typed value.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xsd } from "@thomasfosterau/effect-xml"
 *
 * const model = Effect.runSync(
 *   Xsd.compile(`
 *     <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
 *       <xs:element name="order">
 *         <xs:complexType>
 *           <xs:sequence>
 *             <xs:element name="item" type="xs:string" maxOccurs="unbounded"/>
 *           </xs:sequence>
 *           <xs:attribute name="id" type="xs:int" use="required"/>
 *         </xs:complexType>
 *       </xs:element>
 *     </xs:schema>`)
 * )
 *
 * const order = Effect.runSync(Xsd.parse(model, `<order id="7"><item>Tea</item></order>`))
 * console.log(order.value) // { id: 7, item: ["Tea"] }
 *
 * const invalid = Effect.runSync(Effect.flip(Xsd.parse(model, `<order><item>Tea</item></order>`)))
 * console.log(invalid.message) // Invalid document at 1:1 (/order): the attribute id is required
 * ```
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  model: Model,
  input: string,
  options?: ParseOptions,
): Effect.Effect<Validated, XsdError> =>
  Sax.tokenizeString(input, saxOptions(options)).pipe(decode(model, options));

/**
 * Parse and validate a stream of XML text against a schema. Chunks may split markup anywhere.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseStream =
  (model: Model, options?: ParseOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<Validated, E | XsdError, R> =>
    input.pipe(Sax.tokenize(saxOptions(options)), decode(model, options));

/**
 * Parse and validate XML bytes against a schema, detecting the encoding.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseBytes = (
  model: Model,
  input: Uint8Array,
  options?: ParseOptions,
): Effect.Effect<Validated, XsdError> =>
  Sax.tokenizeByteArray(input, saxOptions(options)).pipe(decode(model, options));

/**
 * Parse and validate a stream of XML bytes against a schema, detecting the encoding.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseBytesStream =
  (model: Model, options?: ParseOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Effect.Effect<Validated, E | XsdError, R> =>
    input.pipe(Sax.tokenizeBytes(saxOptions(options)), decode(model, options));

/**
 * A child element of the document element that a {@link Parser} streams:
 * its expanded name, and the schema its values decode through.
 *
 * @since 0.2.0
 * @category parsing
 */
export interface Child<S extends Schema.Top = Schema.Top> {
  /** The child's expanded name (`{namespace}local`). */
  readonly element: string;
  /** The schema each child's value is decoded with. */
  readonly schema: S;
}

/**
 * The children a {@link Parser} streams, by name.
 *
 * @since 0.2.0
 * @category parsing
 */
export type Children<C = Record<string, Child>> = { readonly [K in keyof C]: Child };

/**
 * What a parser's decoding fails with: the {@link XsdError} of parsing and
 * validating, or the `SchemaError` of a value its schema does not describe.
 *
 * @since 0.2.0
 * @category errors
 */
export type ParserError = XsdError | Schema.SchemaError;

/**
 * A parser for documents whose root is one global element, decoding the
 * root's value through the schema `S`, with a typed stream per child
 * element named in `C`.
 *
 * Every method validates against the model first, then decodes the valid
 * value with `Schema.decodeUnknownEffect(schema)`: a value the schema does
 * not describe (a schema written for another model, say) fails with a
 * `Schema.SchemaError`, never as a value of the wrong type.
 *
 * @since 0.1.0
 * @category parsing
 */
export interface Parser<S extends Schema.Top, C extends Children<C> = Record<string, never>> {
  /** The root element's expanded name. */
  readonly element: string;
  /** The schema the root's value is decoded with. */
  readonly schema: S;
  readonly parse: (
    input: string,
    options?: ParseOptions,
  ) => Effect.Effect<S["Type"], ParserError, S["DecodingServices"]>;
  readonly parseBytes: (
    input: Uint8Array,
    options?: ParseOptions,
  ) => Effect.Effect<S["Type"], ParserError, S["DecodingServices"]>;
  readonly parseStream: (
    options?: ParseOptions,
  ) => <E, R>(
    input: Stream.Stream<string, E, R>,
  ) => Effect.Effect<S["Type"], E | ParserError, R | S["DecodingServices"]>;
  readonly parseBytesStream: (
    options?: ParseOptions,
  ) => <E, R>(
    input: Stream.Stream<Uint8Array, E, R>,
  ) => Effect.Effect<S["Type"], E | ParserError, R | S["DecodingServices"]>;
  readonly decode: <E, R>(
    events: Stream.Stream<Sax.SaxEvent, E, R>,
  ) => Effect.Effect<S["Type"], E | ParserError, R | S["DecodingServices"]>;
  /**
   * Stream out the values of the elements matching `path` (see
   * {@link select}), each decoded with `schema`.
   */
  readonly stream: <B extends Schema.Top>(
    path: string | Path,
    schema: B,
    options?: CompileOptions,
  ) => <E, R>(
    events: Stream.Stream<Sax.SaxEvent, E, R>,
  ) => Stream.Stream<B["Type"], E | ParserError | XPathError, R | B["DecodingServices"]>;
  /**
   * The stream of a child named in {@link parser}'s `streams`:
   * `streams("line")` streams out each `line` child of the document element,
   * decoded with its schema, as `stream("/order/line", Line)` does.
   * `Xsd.generate` names one for every child element of a root that can
   * occur more than once.
   */
  readonly streams: <K extends keyof C>(
    child: K,
  ) => <E, R>(
    events: Stream.Stream<Sax.SaxEvent, E, R>,
  ) => Stream.Stream<
    C[K]["schema"]["Type"],
    E | ParserError | XPathError,
    R | C[K]["schema"]["DecodingServices"]
  >;
}

/** The path step for an expanded name under `prefix`, with the namespace it binds. */
const childStep = (name: string, prefix: string): readonly [string, Record<string, string>] => {
  const namespace = namespaceOf(name);
  const local = localOf(name);
  return namespace === "" ? [local, {}] : [`${prefix}:${local}`, { [prefix]: namespace }];
};

/** The child path `/root/child` of two expanded names, with the namespaces it uses. */
const childPath = (
  root: string,
  child: string,
): readonly [string, Readonly<Record<string, string>>] => {
  const [r, rootNs] = childStep(root, "r");
  const [c, childNs] = childStep(child, "c");
  return [`/${r}/${c}`, { ...rootNs, ...childNs }];
};

/** A parser whose root values go through `value`: a schema's decoder, or nothing for {@link XsdValue}. */
const make = <S extends Schema.Top, C extends Children<C>>(
  model: Model,
  element: string,
  schema: S,
  value: (v: XsdValue) => Effect.Effect<S["Type"], Schema.SchemaError, S["DecodingServices"]>,
  children: C,
): Parser<S, C> => {
  const rooted = (options?: ParseOptions): ParseOptions => ({
    ...options,
    root: element,
  });
  const root = (v: Validated) => value(v.value);
  const stream =
    <B extends Schema.Top>(path: string | Path, of: B, options?: CompileOptions) =>
    <E, R>(events: Stream.Stream<Sax.SaxEvent, E, R>) => {
      const decodeOf = Schema.decodeUnknownEffect(of);
      return Stream.mapEffect(select(model, path, { ...options, root: element })(events), (v) =>
        decodeOf(v),
      );
    };
  return {
    element,
    schema,
    parse: (input, options) => Effect.flatMap(parse(model, input, rooted(options)), root),
    parseBytes: (input, options) => Effect.flatMap(parseBytes(model, input, rooted(options)), root),
    parseStream: (options) => (input) =>
      Effect.flatMap(parseStream(model, rooted(options))(input), root),
    parseBytesStream: (options) => (input) =>
      Effect.flatMap(parseBytesStream(model, rooted(options))(input), root),
    decode: (events) => Effect.flatMap(decode(model, { root: element })(events), root),
    stream,
    streams: (name) => {
      const child = children[name];
      const [path, namespaces] = childPath(element, child.element);
      return stream(path, child.schema, { namespaces });
    },
  };
};

/**
 * A parser for documents rooted at the global element `element` (an
 * expanded name), decoding its value with `schema`.
 *
 * Validation builds the value the model's declaration of `element`
 * describes, as an {@link XsdValue}; `Schema.decodeUnknownEffect(schema)`
 * then turns it into `schema`'s type, failing with a `Schema.SchemaError`
 * where it does not match. The module `Xsd.generate` writes has a schema for
 * every type and a parser for every global element, made from the same
 * model, so its parsers decode every valid document; a schema written by
 * hand may describe part of a value (the properties it leaves out are
 * dropped).
 *
 * `streams` names child elements of the document element to stream out one
 * at a time, each with the schema of its values: see {@link Parser.streams}.
 *
 * Without a schema the parser's values are the {@link XsdValue}s validation
 * builds, as they are, with no decoding pass.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 * import { Sax, Xsd } from "@thomasfosterau/effect-xml"
 *
 * const model = Effect.runSync(
 *   Xsd.compile(`
 *     <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
 *       <xs:element name="order">
 *         <xs:complexType>
 *           <xs:sequence>
 *             <xs:element name="item" type="xs:string" maxOccurs="unbounded"/>
 *           </xs:sequence>
 *           <xs:attribute name="id" type="xs:int" use="required"/>
 *         </xs:complexType>
 *       </xs:element>
 *     </xs:schema>`)
 * )
 *
 * const Order = Schema.Struct({ id: Schema.Int, item: Schema.Array(Schema.String) })
 * const order = Xsd.parser(model, "order", Order, {
 *   item: { element: "item", schema: Schema.String }
 * })
 *
 * const input = `<order id="7"><item>Tea</item><item>Milk</item></order>`
 * console.log(Effect.runSync(order.parse(input))) // { id: 7, item: [ 'Tea', 'Milk' ] }
 *
 * const items = Sax.tokenizeString(input).pipe(order.streams("item"), Stream.runCollect)
 * console.log(Effect.runSync(items)) // [ 'Tea', 'Milk' ]
 *
 * // A schema that does not describe the model's values fails to decode.
 * const wrong = Xsd.parser(model, "order", Schema.Struct({ id: Schema.String }))
 * console.log(Effect.runSync(Effect.flip(wrong.parse(input)))._tag) // SchemaError
 * ```
 *
 * @since 0.1.0
 * @category parsing
 */
export function parser(model: Model, element: string): Parser<typeof XsdValueSchema>;
export function parser<S extends Schema.Top, const C extends Children<C> = Record<string, never>>(
  model: Model,
  element: string,
  schema: S,
  streams?: C,
): Parser<S, C>;
export function parser(
  model: Model,
  element: string,
  schema?: Schema.Top,
  streams?: Children,
): Parser<Schema.Top, Children> {
  return schema === undefined
    ? make(model, element, XsdValueSchema, Effect.succeed, {})
    : make(model, element, schema, Schema.decodeUnknownEffect(schema), streams ?? {});
}
