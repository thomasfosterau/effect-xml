/**
 * Schema-aware parsing: validating SAX events against a {@link Model} as they
 * stream, and building the typed value of the document.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import { Runtime } from "../internal/xsd/runtime.ts";
import { Validator, type Failure } from "../internal/xsd/validator.ts";
import type { Limits } from "../Limits.ts";
import * as Sax from "../Sax.ts";
import type { XsdSchemaError, XsdValidationError } from "./Error.ts";
import type { Model } from "./Model.ts";
import type { Validated, XsdValue } from "./Value.ts";

/**
 * Everything schema-aware parsing can fail with: a parse error, a schema the
 * model can't be validated with, or the first way the document is invalid.
 *
 * @since 0.3.0
 * @category errors
 */
export type XsdError = SaxError | XsdSchemaError | XsdValidationError;

/**
 * Options for validating: which global element the document must have as its root.
 *
 * @since 0.3.0
 * @category options
 */
export interface ValidateOptions {
  /** The expanded name (`{namespace}local`) the document element must have; any global element otherwise. */
  readonly root?: string | undefined;
}

/**
 * Options for the parsing functions: the validation options plus the SAX options that apply to XML.
 *
 * @since 0.3.0
 * @category options
 */
export interface ParseOptions extends ValidateOptions {
  /** Named entity table override. */
  readonly entities?: Record<string, string> | undefined;
  /** Resource limits; the ones left out keep their defaults (see {@link Limits}). */
  readonly limits?: Partial<Limits> | undefined;
  /** Interpret the DOCTYPE internal subset (see {@link Sax.SaxOptions.dtd}); default `"ignore"`. */
  readonly dtd?: "ignore" | "internal" | undefined;
  /** An external encoding hint for byte input, such as the `charset` of a `Content-Type`. */
  readonly encoding?: string | undefined;
}

const saxOptions = (options: ParseOptions | undefined): Sax.SaxBytesOptions => ({
  mode: "xml",
  entities: options?.entities,
  limits: options?.limits,
  dtd: options?.dtd,
  encoding: options?.encoding,
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

const noFailure = (): Failure | null => null;

/** Feed a chunk of events to a validator: the first failure, or `null`. */
const acceptAll = (validator: Validator, events: ReadonlyArray<Sax.SaxEvent>): Failure | null =>
  Arr.reduce(events, noFailure(), (failure, ev): Failure | null => failure ?? validator.accept(ev));

/**
 * Validate a stream of SAX events against a schema as they pass through,
 * failing the stream at the first violation.
 *
 * @since 0.3.0
 * @category validating
 */
export const validate =
  (model: Model, options?: ValidateOptions) =>
  <E, R>(events: Stream.Stream<Sax.SaxEvent, E, R>): Stream.Stream<Sax.SaxEvent, E | XsdError, R> =>
    Stream.suspend(() => {
      const validator = new Validator(runtimeOf(model), options);
      const body = Stream.mapArrayEffect(events, (chunk) => {
        const failure = acceptAll(validator, chunk);
        return failure === null ? Effect.succeed(chunk) : Effect.fail(failure);
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
 * @since 0.3.0
 * @category validating
 */
export const decode =
  (model: Model, options?: ValidateOptions) =>
  <E, R>(events: Stream.Stream<Sax.SaxEvent, E, R>): Effect.Effect<Validated, E | XsdError, R> =>
    Effect.suspend(() => {
      const validator = new Validator(runtimeOf(model), options);
      return Stream.runForEachArray(events, (chunk) => {
        const failure = acceptAll(validator, chunk);
        return failure === null ? Effect.void : Effect.fail(failure);
      }).pipe(
        Effect.flatMap(() => {
          const failure = validator.finish();
          return failure === null
            ? Effect.succeed(
                Option.getOrElse(validator.result, (): Validated => ({ name: "", value: null })),
              )
            : Effect.fail(failure);
        }),
      );
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
 * @since 0.3.0
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
 * @since 0.3.0
 * @category parsing
 */
export const parseStream =
  (model: Model, options?: ParseOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<Validated, E | XsdError, R> =>
    input.pipe(Sax.tokenize(saxOptions(options)), decode(model, options));

/**
 * Parse and validate XML bytes against a schema, detecting the encoding.
 *
 * @since 0.3.0
 * @category parsing
 */
export const parseBytes = (
  model: Model,
  input: Uint8Array,
  options?: ParseOptions,
): Effect.Effect<Validated, XsdError> =>
  Stream.make(input).pipe(Sax.tokenizeBytes(saxOptions(options)), decode(model, options));

/**
 * Parse and validate a stream of XML bytes against a schema, detecting the encoding.
 *
 * @since 0.3.0
 * @category parsing
 */
export const parseBytesStream =
  (model: Model, options?: ParseOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Effect.Effect<Validated, E | XsdError, R> =>
    input.pipe(Sax.tokenizeBytes(saxOptions(options)), decode(model, options));

/**
 * A parser for documents whose root is one global element, producing values of type `A`.
 *
 * @since 0.3.0
 * @category parsing
 */
export interface Parser<A> {
  /** The root element's expanded name. */
  readonly element: string;
  readonly parse: (input: string, options?: ParseOptions) => Effect.Effect<A, XsdError>;
  readonly parseBytes: (input: Uint8Array, options?: ParseOptions) => Effect.Effect<A, XsdError>;
  readonly parseStream: (
    options?: ParseOptions,
  ) => <E, R>(input: Stream.Stream<string, E, R>) => Effect.Effect<A, E | XsdError, R>;
  readonly parseBytesStream: (
    options?: ParseOptions,
  ) => <E, R>(input: Stream.Stream<Uint8Array, E, R>) => Effect.Effect<A, E | XsdError, R>;
  readonly decode: <E, R>(
    events: Stream.Stream<Sax.SaxEvent, E, R>,
  ) => Effect.Effect<A, E | XsdError, R>;
}

/**
 * A parser for documents rooted at the global element `element` (an expanded
 * name), whose values are typed `A`.
 *
 * `A` is the caller's claim about the values the element's type produces;
 * `Xsd.generate` writes these types from the same model, so a generated
 * module's parsers are typed correctly by construction.
 *
 * @since 0.3.0
 * @category parsing
 */
export const parser = <A = XsdValue>(model: Model, element: string): Parser<A> => {
  const rooted = (options: ParseOptions | undefined): ParseOptions => ({
    ...options,
    root: element,
  });
  // SAFETY: validation against `element`'s declaration builds exactly the
  // values its type describes; `A` is that description, written by the caller
  // (or by `Xsd.generate`) from the same model.
  const value = (v: Validated): A => v.value as A;
  return {
    element,
    parse: (input, options) => Effect.map(parse(model, input, rooted(options)), value),
    parseBytes: (input, options) => Effect.map(parseBytes(model, input, rooted(options)), value),
    parseStream: (options) => (input) =>
      Effect.map(parseStream(model, rooted(options))(input), value),
    parseBytesStream: (options) => (input) =>
      Effect.map(parseBytesStream(model, rooted(options))(input), value),
    decode: (events) => Effect.map(decode(model, { root: element })(events), value),
  };
};
