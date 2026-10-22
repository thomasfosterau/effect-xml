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
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { SaxError } from "./Error.ts";
import { MalformedDeclaration } from "./Error.ts";
import { Dtd } from "./internal/dtd.ts";
import { applyDefaults, Expander } from "./internal/expansion.ts";
import { Guard } from "./internal/guard.ts";
import { LexEvent, Lexer, type LexOutput } from "./internal/lexer.ts";
import { xmlEntities, htmlEntities } from "./internal/entities.ts";
import { unsafeAttrName, unsafeTagName, type AttrName, type TagName } from "./Name.ts";
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
}

/** @internal */
export interface ResolvedOptions {
  readonly mode: "xml" | "html";
  readonly entities: Record<string, string>;
  readonly whitespace: "preserve" | "collapse";
  readonly dropWhitespaceOnlyText: boolean;
  readonly limits: Limits;
  readonly dtd: "ignore" | "internal";
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
  };
};

// -----------------------------------------------------------------------------
// Conversion
// -----------------------------------------------------------------------------

const isWhitespaceOnly = (s: string): boolean => /^\s*$/.test(s);

/** Convert a lexer event to a public event, applying whitespace policy. Returns null to drop. */
/** @internal Convert a raw lexer event into a SAX event (used by coupled drivers). */
export const convertLexEvent = (ev: LexEvent, opts: ResolvedOptions): SaxEvent | null =>
  matchLexEvent(ev, convertersFor(opts));

const matchLexEvent = LexEvent.$match;

/** The per-kind conversions for one options object (built once per options, not per event). */
const converters = new WeakMap<ResolvedOptions, ReturnType<typeof makeConverters>>();
const convertersFor = (opts: ResolvedOptions): ReturnType<typeof makeConverters> => {
  const cached = converters.get(opts);
  if (cached !== undefined) return cached;
  const made = makeConverters(opts);
  converters.set(opts, made);
  return made;
};

const makeConverters = (opts: ResolvedOptions) => ({
  StartElement: (ev: Extract<LexEvent, { _tag: "StartElement" }>): SaxEvent | null =>
    SaxEvent.StartElement({
      name: unsafeTagName(ev.name),
      attributes: ev.attributes.map((a) => ({
        name: unsafeAttrName(a.name),
        value: a.value,
        span: a.span,
      })),
      selfClosing: ev.selfClosing,
      span: ev.span,
    }),
  EndElement: (ev: Extract<LexEvent, { _tag: "EndElement" }>): SaxEvent | null =>
    SaxEvent.EndElement({ name: unsafeTagName(ev.name), span: ev.span }),
  Text: (ev: Extract<LexEvent, { _tag: "Text" }>): SaxEvent | null => {
    const data = opts.whitespace === "collapse" ? ev.data.replace(/\s+/g, " ").trim() : ev.data;
    if (opts.dropWhitespaceOnlyText && isWhitespaceOnly(data)) return null;
    return SaxEvent.Text({ data, span: ev.span });
  },
  CData: (ev: Extract<LexEvent, { _tag: "CData" }>): SaxEvent | null =>
    SaxEvent.CData({ data: ev.data, span: ev.span }),
  Comment: (ev: Extract<LexEvent, { _tag: "Comment" }>): SaxEvent | null =>
    SaxEvent.Comment({ data: ev.data, span: ev.span }),
  ProcessingInstruction: (
    ev: Extract<LexEvent, { _tag: "ProcessingInstruction" }>,
  ): SaxEvent | null =>
    SaxEvent.ProcessingInstruction({ target: ev.target, data: ev.data, span: ev.span }),
  Doctype: (ev: Extract<LexEvent, { _tag: "Doctype" }>): SaxEvent | null =>
    SaxEvent.Doctype({
      name: ev.name,
      publicId: ev.publicId,
      systemId: ev.systemId,
      internalSubset: ev.internalSubset,
      span: ev.span,
    }),
  XmlDeclaration: (ev: Extract<LexEvent, { _tag: "XmlDeclaration" }>): SaxEvent | null =>
    SaxEvent.XmlDeclaration({
      version: ev.version,
      encoding: ev.encoding,
      standalone: ev.standalone,
      span: ev.span,
    }),
  // Expanded before conversion (see `tokenize`).
  EntityReference: (): SaxEvent | null => null,
});

// -----------------------------------------------------------------------------
// Streaming API
// -----------------------------------------------------------------------------

/**
 * The core combinator: turn a stream of input chunks into a stream of SAX
 * events. Chunks may split markup arbitrarily — the lexer state is preserved
 * across them.
 *
 * @example
 * import { Stream } from "effect"
 * import { Sax } from "effect-sax"
 *
 * Stream.fromIterable(["<roo", "t>hi</root>"]).pipe(Sax.tokenize())
 *
 * @since 0.2.0
 * @category tokenizing
 */
export const tokenize =
  (options?: SaxOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Stream.Stream<SaxEvent, SaxError | E, R> => {
    const opts = resolveSaxOptions(options);
    return Stream.suspend(() => {
      const dtd = opts.mode === "xml" && opts.dtd === "internal" ? new Dtd(opts.limits) : undefined;
      const lexer = new Lexer({
        mode: opts.mode,
        entities: opts.entities,
        ...(dtd !== undefined ? { dtd } : {}),
      });
      const expander = dtd === undefined ? undefined : new Expander(dtd, opts.entities);
      const guard = new Guard(opts.limits, opts.mode === "xml");
      /** Interpret the DTD-related outputs (with `dtd: "internal"`). */
      const interpret = (o: LexOutput): ReadonlyArray<LexOutput> => {
        if (dtd === undefined || expander === undefined) return [o];
        switch (o._tag) {
          case "Doctype": {
            const error = o.internalSubset === null ? null : dtd.declare(o.internalSubset);
            if (error === null) return [o];
            const found = o.internalSubset!.slice(error.offset, error.offset + 1);
            const fault = new MalformedDeclaration({
              construct: "DOCTYPE internal subset",
              expected: error.expected,
              found: found === "" ? "end of input" : JSON.stringify(found),
              position: o.span.start,
            });
            return [{ _tag: "Fault", error: fault }];
          }
          case "EntityReference":
            return expander.expand(o);
          case "StartElement":
            return [applyDefaults(dtd, o)];
          default:
            return [o];
        }
      };
      // Lex token by token, so a limit stops the lexer at the offending token
      // rather than after the whole chunk.
      const drain = (): ReadonlyArray<LexOutput> => {
        const out: Array<LexOutput> = [];
        for (let outs = lexer.pull(); outs !== null; outs = lexer.pull()) {
          for (const raw of outs) {
            for (const o of interpret(raw)) {
              const over = o._tag === "Fault" ? null : guard.event(o);
              out.push(over === null ? o : { _tag: "Fault", error: over });
              if (over !== null || o._tag === "Fault") return out;
            }
          }
        }
        return out;
      };
      const write = (chunk: string): ReadonlyArray<LexOutput> => {
        const over = guard.input(chunk.length, lexer);
        if (over !== null) return [{ _tag: "Fault", error: over }];
        lexer.push(chunk);
        const outs = drain();
        const pending = guard.pending(lexer);
        return pending === null ? outs : [...outs, { _tag: "Fault", error: pending }];
      };
      // One stream per input chunk, not per event: the events of a chunk are
      // converted in a loop, followed by the failure if there was one.
      const emit = (outs: ReadonlyArray<LexOutput>): Stream.Stream<SaxEvent, SaxError> => {
        const events: Array<SaxEvent> = [];
        for (const o of outs) {
          if (o._tag === "Fault")
            return Stream.concat(Stream.fromIterable(events), Stream.fail(o.error));
          const ev = convertLexEvent(o, opts);
          if (ev !== null) events.push(ev);
        }
        return Stream.fromIterable(events);
      };
      const body = input.pipe(Stream.flatMap((chunk) => emit(write(chunk))));
      const tail = Stream.suspend(() => {
        lexer.close();
        return emit(drain());
      });
      return Stream.concat(body, tail);
    });
  };

/** Options for byte input: the SAX options plus an external encoding hint. */
export interface SaxBytesOptions extends SaxOptions {
  /**
   * An external encoding hint, such as the `charset` of a `Content-Type`. It
   * overrides the document's own declaration (or `<meta charset>`), but not a
   * byte order mark.
   */
  readonly encoding?: string;
}

/** @internal The decoding options that match a set of SAX options. */
export const decodeOptions = (options: SaxBytesOptions | undefined): Encoding.DecodeOptions => ({
  mode: options?.mode ?? "xml",
  maxTotalBytes: resolveLimits(options?.limits).maxTotalBytes,
  ...(options?.encoding !== undefined ? { encoding: options.encoding } : {}),
});

/**
 * Turn a stream of bytes into a stream of SAX events. The encoding is detected
 * from the input (see {@link Encoding.sniffXml} and {@link Encoding.sniffHtml}),
 * and chunks may split multi-byte sequences anywhere.
 */
export const tokenizeBytes =
  (options?: SaxBytesOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Stream.Stream<SaxEvent, SaxError | E, R> =>
    input.pipe(Encoding.decode(decodeOptions(options)), tokenize(options));

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
 * import * as Effect from "effect/Effect"
 * import { Sax } from "effect-sax"
 *
 * const events = Effect.runSync(Sax.collect("<a>hi</a>"))
 * console.log(events.map((e) => e._tag)) // ["StartElement", "Text", "EndElement"]
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
 */
export { select } from "./Xml/Select.ts";

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
