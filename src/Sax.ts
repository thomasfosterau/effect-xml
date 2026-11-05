/**
 * Streaming SAX interface.
 *
 * `Sax` exposes the {@link Lexer} as composable Effect `Stream` pipelines that
 * turn a stream of input chunks into a stream of strongly-typed {@link SaxEvent}s.
 * Faults raised by the lexer surface as typed failures in the stream's error
 * channel ({@link SaxError}); nothing is thrown.
 *
 * The classic SAX "event handler" model maps onto `Stream.runForEach`; richer
 * processing uses the full `Stream` combinator library (filter, scan, grouped,
 * etc.). Tag/attribute names are branded ({@link TagName} / {@link AttrName}) so
 * an element name can never be confused with an arbitrary string.
 */
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import type { SaxError } from "./Error.ts";
import { type LimitExceeded, MalformedDeclaration } from "./Error.ts";
import { Dtd } from "./internal/dtd.ts";
import { applyDefaults, Expander } from "./internal/expansion.ts";
import { Guard } from "./internal/guard.ts";
import {
  isDoctypeEvent,
  isEntityReferenceEvent,
  isFault,
  isStartElementEvent,
  Lexer,
  type LexOutput,
} from "./internal/lexer.ts";
import { convert } from "./internal/convert.ts";
import { quote } from "./internal/quote.ts";
import { xmlEntities, htmlEntities } from "./internal/entities.ts";
import type { AttrName, TagName } from "./Name.ts";
import type { Span } from "./Position.ts";
import { resolveLimits, type Limits } from "./Limits.ts";
import * as Encoding from "./Encoding.ts";

// -----------------------------------------------------------------------------
// Public event model
// -----------------------------------------------------------------------------

/**
 * A resolved attribute on a start tag.
 *
 * @since 0.2.0
 * @category models
 */
export interface Attribute {
  readonly name: AttrName;
  readonly value: string;
  readonly span: Span;
}

/**
 * The typed SAX event stream alphabet. Defined as a `Data.TaggedEnum`, so it
 * comes with value equality, exhaustive `$match`, and `$is` guards for free.
 *
 * @since 0.2.0
 * @category models
 */
export type SaxEvent = Data.TaggedEnum<{
  StartElement: {
    readonly name: TagName;
    readonly attributes: ReadonlyArray<Attribute>;
    readonly selfClosing: boolean;
    readonly span: Span;
  };
  EndElement: { readonly name: TagName; readonly span: Span };
  Text: { readonly data: string; readonly span: Span };
  CData: { readonly data: string; readonly span: Span };
  Comment: { readonly data: string; readonly span: Span };
  ProcessingInstruction: {
    readonly target: string;
    readonly data: string;
    readonly span: Span;
  };
  Doctype: {
    readonly name: string;
    readonly publicId: string | null;
    readonly systemId: string | null;
    readonly internalSubset: string | null;
    readonly span: Span;
  };
  XmlDeclaration: {
    readonly version: string;
    readonly encoding: string | null;
    readonly standalone: boolean | null;
    readonly span: Span;
  };
}>;

/**
 * Constructors and matchers for {@link SaxEvent}.
 *
 * @since 0.2.0
 * @category models
 */
export const SaxEvent = Data.taggedEnum<SaxEvent>();

// Convenient narrowing guards (re-exported from the tagged enum).

/**
 * Is this event a `StartElement`?
 *
 * @since 0.2.0
 * @category guards
 */
export const isStartElement = SaxEvent.$is("StartElement");

/**
 * Is this event an `EndElement`?
 *
 * @since 0.2.0
 * @category guards
 */
export const isEndElement = SaxEvent.$is("EndElement");

/**
 * Is this event a `Text` run?
 *
 * @since 0.2.0
 * @category guards
 */
export const isText = SaxEvent.$is("Text");

/**
 * Is this event a `Comment`?
 *
 * @since 0.2.0
 * @category guards
 */
export const isComment = SaxEvent.$is("Comment");

/**
 * Is this event a `CData` section?
 *
 * @since 0.2.0
 * @category guards
 */
export const isCData = SaxEvent.$is("CData");

/**
 * Is this event a `ProcessingInstruction`?
 *
 * @since 0.2.0
 * @category guards
 */
export const isProcessingInstruction = SaxEvent.$is("ProcessingInstruction");

/**
 * Is this event a `Doctype`?
 *
 * @since 0.2.0
 * @category guards
 */
export const isDoctype = SaxEvent.$is("Doctype");

/**
 * Is this event an `XmlDeclaration`?
 *
 * @since 0.2.0
 * @category guards
 */
export const isXmlDeclaration = SaxEvent.$is("XmlDeclaration");

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

/**
 * Options for {@link tokenize} and the parsers built on it.
 *
 * @since 0.2.0
 * @category options
 */
export interface SaxOptions {
  /**
   * `"xml"` (default) is strict: unknown entities and malformed markup become
   * typed failures. `"html"` is lenient and recovers, and switches the tokenizer
   * into raw-text mode inside `<script>`/`<style>` and rcdata inside
   * `<title>`/`<textarea>`.
   */
  readonly mode?: "xml" | "html" | undefined;
  /** Named entity table. Defaults to the XML predefined set (or the HTML subset in html mode). */
  readonly entities?: Record<string, string> | undefined;
  /** How to treat whitespace in text nodes. */
  readonly whitespace?: "preserve" | "collapse" | undefined;
  /** Drop `Text` events that contain only whitespace (after the whitespace policy). */
  readonly dropWhitespaceOnlyText?: boolean | undefined;
  /** Resource limits; the ones left out keep their defaults (see {@link Limits}). */
  readonly limits?: Partial<Limits> | undefined;
  /**
   * What to do with a DOCTYPE internal subset (XML only). `"ignore"` (the
   * default) reads past it. `"internal"` interprets it: internal general
   * entities are expanded (markup included), within `limits.maxEntityExpansion`
   * and `limits.maxEntityDepth`, and `<!ATTLIST>` defaults are applied.
   * External and parameter entities are never fetched; referring to one is
   * an error.
   */
  readonly dtd?: "ignore" | "internal" | undefined;
  /**
   * HTML only: the scripting flag (default `false`). When set, `<noscript>`
   * content is raw text, as a browser with scripting enabled reads it.
   */
  readonly scripting?: boolean | undefined;
}

/** @internal */
export interface ResolvedOptions {
  readonly mode: "xml" | "html";
  readonly entities: Record<string, string>;
  readonly whitespace: "preserve" | "collapse";
  readonly dropWhitespaceOnlyText: boolean;
  readonly limits: Limits;
  readonly dtd: "ignore" | "internal";
  readonly scripting: boolean;
}

/** @internal */
export const resolveSaxOptions = (options: SaxOptions | undefined): ResolvedOptions => {
  const mode = options?.mode ?? "xml";
  return {
    mode,
    entities: options?.entities ?? (mode === "html" ? htmlEntities : xmlEntities),
    whitespace: options?.whitespace ?? "preserve",
    dropWhitespaceOnlyText: options?.dropWhitespaceOnlyText ?? false,
    limits: resolveLimits(options?.limits),
    dtd: options?.dtd ?? "ignore",
    scripting: options?.scripting ?? false,
  };
};

// -----------------------------------------------------------------------------
// Streaming API
// -----------------------------------------------------------------------------

/** The most events {@link tokenize} emits in one stream chunk. */
const BATCH = 1024;

/**
 * The core combinator: turn a stream of input chunks into a stream of SAX
 * events. Chunks may split markup arbitrarily — the lexer state is preserved
 * across them.
 *
 * @example
 * ```ts
 * import { Stream } from "effect"
 * import { Sax } from "@thomasfosterau/effect-xml"
 *
 * Stream.fromIterable(["<roo", "t>hi</root>"]).pipe(Sax.tokenize())
 * ```
 *
 * @since 0.2.0
 * @category tokenizing
 */
export const tokenize =
  (options?: SaxOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Stream.Stream<SaxEvent, SaxError | E, R> => {
    const opts = resolveSaxOptions(options);
    return Stream.suspend(() => {
      const tokenizer = new Tokenizer(opts);
      // The events are emitted in batches of at most `BATCH`, read only as the
      // stream is pulled: a large chunk never has all its events in memory at
      // once, and each batch can be dropped before the next is built.
      let events: Array<SaxEvent> = [];
      const keep = (ev: SaxEvent): boolean => {
        events.push(ev);
        return true;
      };
      const full = (): boolean => events.length >= BATCH;
      /**
       * The events of the input written so far, then the fault if there is
       * one: once the input has ended, or else when the token the lexer is
       * still waiting on is already too long.
       */
      const lexed = (): Stream.Stream<SaxEvent, SaxError> =>
        Stream.fromPull(
          Effect.sync(() => {
            let dry = false;
            return Effect.suspend(
              (): Effect.Effect<Arr.NonEmptyReadonlyArray<SaxEvent>, SaxError | Cause.Done> => {
                if (tokenizer.fault === undefined && !dry) {
                  events = [];
                  dry = tokenizer.run(keep, full);
                  const batch = events;
                  if (Arr.isArrayNonEmpty(batch)) return Effect.succeed(batch);
                }
                const fault = tokenizer.fault;
                return fault === undefined ? Cause.done() : Effect.fail(fault);
              },
            );
          }),
        );
      const write = (chunk: string): Stream.Stream<SaxEvent, SaxError> => {
        const over = tokenizer.write(chunk);
        return over === undefined ? lexed() : Stream.fail(over);
      };
      const body = input.pipe(Stream.flatMap(write));
      const tail = Stream.suspend(() => {
        tokenizer.close();
        return lexed();
      });
      return Stream.concat(body, tail);
    });
  };

/**
 * @internal One stream's tokenizing: the lexer, the limits, and (with `dtd:
 * "internal"`) the DOCTYPE's entities, turning written input into SAX events.
 * Lexes token by token, so a limit stops the lexer at the offending token
 * rather than after the whole chunk, converting each output as it comes.
 */
export class Tokenizer {
  /** The failure that ended the events, once there is one. */
  fault: SaxError | undefined = undefined;
  private ended = false;
  private readonly lexer: Lexer;
  private readonly guard: Guard;
  private readonly opts: ResolvedOptions;
  private readonly dtd: Dtd | undefined;
  private readonly expander: Expander | undefined;
  /** The callback {@link run} hands events to. */
  private sink: (ev: SaxEvent) => boolean = () => true;

  /** `lean`: leave positions out where the lexer can (see `LexerOptions.lean`). */
  constructor(opts: ResolvedOptions, lean = false) {
    this.opts = opts;
    const dtd = opts.mode === "xml" && opts.dtd === "internal" ? new Dtd(opts.limits) : undefined;
    this.dtd = dtd;
    this.lexer = new Lexer({
      mode: opts.mode,
      entities: opts.entities,
      dtd,
      content: false,
      scripting: opts.scripting,
      lean,
    });
    this.expander = dtd === undefined ? undefined : new Expander(dtd, opts.entities);
    this.guard = new Guard(opts.limits, opts.mode === "xml");
  }

  /** Add input; a limit it breaks, if it does. */
  write(chunk: string): LimitExceeded | undefined {
    const over = this.guard.input(chunk.length, this.lexer);
    if (over !== null) return over;
    this.lexer.push(chunk);
    return undefined;
  }

  /** Signal the end of the input. */
  close(): void {
    this.ended = true;
    this.lexer.close();
  }

  /**
   * Hand the events of the input written so far to `f`, stopping when it
   * returns `false`, or after a whole token once `full` returns `true`.
   * Returns whether the lexer ran dry (or failed, setting {@link fault}).
   */
  run(f: (ev: SaxEvent) => boolean, full?: () => boolean): boolean {
    if (this.fault !== undefined) return true;
    this.sink = f;
    const dry = this.lexer.pullEach(this.each, full);
    if (dry && !this.ended && this.fault === undefined) {
      this.fault = this.guard.pending(this.lexer) ?? undefined;
    }
    return dry || this.fault !== undefined;
  }

  /** Keep one output; `false` once it is (or has become) a fault, or the sink is full. */
  private readonly accept = (o: LexOutput): boolean => {
    if (isFault(o)) {
      this.fault = o.error;
      return false;
    }
    const over = this.guard.event(o);
    if (over !== null) {
      this.fault = over;
      return false;
    }
    const ev = convert(o, this.opts);
    return ev === null || this.sink(ev);
  };

  /** Interpret a DOCTYPE or an entity reference (with `dtd: "internal"`). */
  private interpret(o: LexOutput): ReadonlyArray<LexOutput> {
    const { dtd, expander } = this;
    if (dtd === undefined || expander === undefined) return [o];
    if (isDoctypeEvent(o)) {
      const subset = o.internalSubset;
      const error = subset === null ? null : dtd.declare(subset);
      if (subset === null || error === null) return [o];
      const found = subset.slice(error.offset, error.offset + 1);
      const fault = new MalformedDeclaration({
        construct: "DOCTYPE internal subset",
        expected: error.expected,
        found: found === "" ? "end of input" : quote(found),
        position: o.span.start,
      });
      return [{ _tag: "Fault", error: fault }];
    }
    if (isEntityReferenceEvent(o)) return expander.expand(o);
    return [o];
  }

  // Only a DOCTYPE or an entity reference can stand for other outputs; the
  // rest are kept one for one, without an array per output.
  private readonly each = (raw: LexOutput): boolean => {
    const dtd = this.dtd;
    if (dtd === undefined) return this.accept(raw);
    return isDoctypeEvent(raw) || isEntityReferenceEvent(raw)
      ? this.interpret(raw).every(this.accept)
      : this.accept(isStartElementEvent(raw) ? applyDefaults(dtd, raw) : raw);
  };
}

/**
 * @internal Tokenize complete input synchronously, handing each event to `f`
 * (as {@link tokenize} would emit them for these chunks) until it returns a
 * failure. Returns the first failure, the tokenizer's or `f`'s. With `lean`,
 * events may have no positions (see `LexerOptions.lean`).
 */
export const runChunks = (
  { chunks, failure: last }: Chunks,
  options: SaxOptions | undefined,
  f: (ev: SaxEvent) => SaxError | null,
  lean = false,
): SaxError | null => {
  const tokenizer = new Tokenizer(resolveSaxOptions(options), lean);
  let failure: SaxError | null = null;
  const sink = (ev: SaxEvent): boolean => (failure = f(ev)) === null;
  const early = Arr.findFirst(chunks, (chunk): Option.Option<SaxError> => {
    if (chunk === "") return Option.none();
    const over = tokenizer.write(chunk);
    if (over !== undefined) return Option.some(over);
    tokenizer.run(sink);
    return Option.fromNullishOr(failure ?? tokenizer.fault);
  });
  if (Option.isSome(early)) return early.value;
  if (last !== undefined) return last;
  tokenizer.close();
  tokenizer.run(sink);
  return failure ?? tokenizer.fault ?? null;
};

/**
 * @internal Complete input as chunks of text, and the failure that follows
 * them (a decoding failure at the end of the bytes), if any.
 */
export interface Chunks {
  readonly chunks: ReadonlyArray<string>;
  readonly failure?: SaxError | undefined;
}

/**
 * @internal The text of a complete byte array, in the chunks {@link
 * tokenizeByteArray} tokenizes.
 */
export const decodeByteArray = (input: Uint8Array, options?: SaxBytesOptions): Chunks => {
  const decoder = new Encoding.ByteDecoder(decodeOptions(options));
  const first = decoder.write(input);
  if (!Predicate.isString(first)) return { chunks: [], failure: first };
  const rest = decoder.end();
  return Predicate.isString(rest) ? { chunks: [first, rest] } : { chunks: [first], failure: rest };
};

/**
 * Options for byte input: the SAX options plus an external encoding hint.
 *
 * @since 0.3.0
 * @category options
 */
export interface SaxBytesOptions extends SaxOptions {
  /**
   * An external encoding hint, such as the `charset` of a `Content-Type`. It
   * overrides the document's own declaration (or `<meta charset>`), but not a
   * byte order mark.
   */
  readonly encoding?: string | undefined;
}

/** @internal The decoding options that match a set of SAX options. */
export const decodeOptions = (options: SaxBytesOptions | undefined): Encoding.DecodeOptions => ({
  mode: options?.mode ?? "xml",
  maxTotalBytes: resolveLimits(options?.limits).maxTotalBytes,
  encoding: options?.encoding,
});

/**
 * Turn a stream of bytes into a stream of SAX events. The encoding is detected
 * from the input (see {@link Encoding.sniffXml} and {@link Encoding.sniffHtml}),
 * and chunks may split multi-byte sequences anywhere.
 *
 * @since 0.3.0
 * @category tokenizing
 */
export const tokenizeBytes =
  (options?: SaxBytesOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Stream.Stream<SaxEvent, SaxError | E, R> =>
    input.pipe(Encoding.decode(decodeOptions(options)), tokenize(options));

/**
 * @internal Tokenize a complete byte array, as {@link tokenizeBytes} does a
 * stream of that one chunk, but decoding it up front rather than through a
 * decoding stream: the same decoder calls and the same text chunks, without
 * a stream stage per document (a third of the cost of a small one).
 */
export const tokenizeByteArray = (
  input: Uint8Array,
  options?: SaxBytesOptions,
): Stream.Stream<SaxEvent, SaxError> =>
  Stream.suspend(() => {
    const decoder = new Encoding.ByteDecoder(decodeOptions(options));
    const first = decoder.write(input);
    if (!Predicate.isString(first)) return Stream.fail(first);
    const rest = decoder.end();
    // `decode` drops empty chunks; the end of the input may fail after the text.
    const text = Stream.fromIterable(first === "" ? [] : [first]);
    const chunks = Predicate.isString(rest)
      ? Stream.concat(text, Stream.fromIterable(rest === "" ? [] : [rest]))
      : Stream.concat(text, Stream.fail(rest));
    return chunks.pipe(tokenize(options));
  });

/**
 * Tokenize a complete in-memory string into a stream of SAX events.
 *
 * @since 0.2.0
 * @category tokenizing
 */
export const tokenizeString = (
  input: string,
  options?: SaxOptions,
): Stream.Stream<SaxEvent, SaxError> => Stream.make(input).pipe(tokenize(options));

/**
 * Collect every SAX event into an array (convenient for tests and small inputs).
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Sax } from "@thomasfosterau/effect-xml"
 *
 * const events = Effect.runSync(Sax.collect("<a>hi</a>"))
 * console.log(events.map((e) => e._tag)) // ["StartElement", "Text", "EndElement"]
 * ```
 *
 * @since 0.2.0
 * @category tokenizing
 */
export const collect = (
  input: string,
  options?: SaxOptions,
): Effect.Effect<ReadonlyArray<SaxEvent>, SaxError> =>
  tokenizeString(input, options).pipe(
    Stream.runCollect,
    Effect.map((c) => Arr.fromIterable(c)),
  );

// -----------------------------------------------------------------------------
// Stream selectors
// -----------------------------------------------------------------------------

/**
 * Keep only `StartElement` events.
 *
 * @since 0.2.0
 * @category selectors
 */
export const startElements = <E, R>(self: Stream.Stream<SaxEvent, E, R>) =>
  Stream.filter(self, isStartElement);

/**
 * Keep only `EndElement` events.
 *
 * @since 0.2.0
 * @category selectors
 */
export const endElements = <E, R>(self: Stream.Stream<SaxEvent, E, R>) =>
  Stream.filter(self, isEndElement);

/**
 * Keep only `Text` events.
 *
 * @since 0.2.0
 * @category selectors
 */
export const texts = <E, R>(self: Stream.Stream<SaxEvent, E, R>) => Stream.filter(self, isText);

/**
 * Keep only start/end events whose name matches `name`.
 *
 * @since 0.2.0
 * @category selectors
 */
export const named =
  (name: string) =>
  <E, R>(self: Stream.Stream<SaxEvent, E, R>) =>
    Stream.filter(
      self,
      (ev): ev is Extract<SaxEvent, { name: TagName }> =>
        (isStartElement(ev) || isEndElement(ev)) && ev.name === name,
    );

/**
 * Select the subtrees matching a path, each built into an element while the
 * rest of the document streams past (see `Xml/Select.ts`).
 *
 * @since 0.3.0
 * @category selectors
 */
export * from "./Xml/Select.ts";

// -----------------------------------------------------------------------------
// Attribute helpers
// -----------------------------------------------------------------------------

/**
 * Look up an attribute value by name on a start element.
 *
 * @since 0.2.0
 * @category attributes
 */
export const getAttribute = (
  element: Extract<SaxEvent, { _tag: "StartElement" }>,
  name: string,
): Option.Option<string> =>
  Option.map(
    Arr.findFirst(element.attributes, (a) => a.name === name),
    (a) => a.value,
  );
