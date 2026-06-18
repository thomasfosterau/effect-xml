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
import { Data, Effect, Option, Stream } from "effect"
import type { SaxError } from "./Error.ts"
import { Lexer, type LexEvent } from "./internal/lexer.ts"
import { xmlEntities, htmlEntities } from "./internal/entities.ts"
import {
  unsafeAttrName,
  unsafeTagName,
  type AttrName,
  type TagName,
} from "./Name.ts"
import type { Span } from "./Position.ts"

// -----------------------------------------------------------------------------
// Public event model
// -----------------------------------------------------------------------------

/** A resolved attribute on a start tag. */
export interface Attribute {
  readonly name: AttrName
  readonly value: string
  readonly span: Span
}

/**
 * The typed SAX event stream alphabet. Defined as a `Data.TaggedEnum`, so it
 * comes with value equality, exhaustive `$match`, and `$is` guards for free.
 */
export type SaxEvent = Data.TaggedEnum<{
  StartElement: {
    readonly name: TagName
    readonly attributes: ReadonlyArray<Attribute>
    readonly selfClosing: boolean
    readonly span: Span
  }
  EndElement: { readonly name: TagName; readonly span: Span }
  Text: { readonly data: string; readonly span: Span }
  CData: { readonly data: string; readonly span: Span }
  Comment: { readonly data: string; readonly span: Span }
  ProcessingInstruction: {
    readonly target: string
    readonly data: string
    readonly span: Span
  }
  Doctype: {
    readonly name: string
    readonly publicId: string | null
    readonly systemId: string | null
    readonly internalSubset: string | null
    readonly span: Span
  }
  XmlDeclaration: {
    readonly version: string
    readonly encoding: string | null
    readonly standalone: boolean | null
    readonly span: Span
  }
}>

/** Constructors and matchers for {@link SaxEvent}. */
export const SaxEvent = Data.taggedEnum<SaxEvent>()

// Convenient narrowing guards (re-exported from the tagged enum).
export const isStartElement = SaxEvent.$is("StartElement")
export const isEndElement = SaxEvent.$is("EndElement")
export const isText = SaxEvent.$is("Text")
export const isComment = SaxEvent.$is("Comment")
export const isCData = SaxEvent.$is("CData")
export const isProcessingInstruction = SaxEvent.$is("ProcessingInstruction")
export const isDoctype = SaxEvent.$is("Doctype")
export const isXmlDeclaration = SaxEvent.$is("XmlDeclaration")

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface SaxOptions {
  /**
   * `"xml"` (default) is strict: unknown entities and malformed markup become
   * typed failures. `"html"` is lenient and recovers, and switches the tokenizer
   * into raw-text mode inside `<script>`/`<style>` and rcdata inside
   * `<title>`/`<textarea>`.
   */
  readonly mode?: "xml" | "html"
  /** Named entity table. Defaults to the XML predefined set (or the HTML subset in html mode). */
  readonly entities?: Record<string, string>
  /** How to treat whitespace in text nodes. */
  readonly whitespace?: "preserve" | "collapse"
  /** Drop `Text` events that contain only whitespace (after the whitespace policy). */
  readonly dropWhitespaceOnlyText?: boolean
}

interface ResolvedOptions {
  readonly mode: "xml" | "html"
  readonly entities: Record<string, string>
  readonly whitespace: "preserve" | "collapse"
  readonly dropWhitespaceOnlyText: boolean
}

const resolve = (options: SaxOptions | undefined): ResolvedOptions => {
  const mode = options?.mode ?? "xml"
  return {
    mode,
    entities: options?.entities ?? (mode === "html" ? htmlEntities : xmlEntities),
    whitespace: options?.whitespace ?? "preserve",
    dropWhitespaceOnlyText: options?.dropWhitespaceOnlyText ?? false,
  }
}

// -----------------------------------------------------------------------------
// Conversion
// -----------------------------------------------------------------------------

const isWhitespaceOnly = (s: string): boolean => /^\s*$/.test(s)

/** Convert a lexer event to a public event, applying whitespace policy. Returns null to drop. */
const convert = (ev: LexEvent, opts: ResolvedOptions): SaxEvent | null => {
  switch (ev._tag) {
    case "StartElement":
      return SaxEvent.StartElement({
        name: unsafeTagName(ev.name),
        attributes: ev.attributes.map((a) => ({
          name: unsafeAttrName(a.name),
          value: a.value,
          span: a.span,
        })),
        selfClosing: ev.selfClosing,
        span: ev.span,
      })
    case "EndElement":
      return SaxEvent.EndElement({ name: unsafeTagName(ev.name), span: ev.span })
    case "Text": {
      let data = ev.data
      if (opts.whitespace === "collapse") data = data.replace(/\s+/g, " ").trim()
      if (opts.dropWhitespaceOnlyText && isWhitespaceOnly(data)) return null
      return SaxEvent.Text({ data, span: ev.span })
    }
    case "CData":
      return SaxEvent.CData({ data: ev.data, span: ev.span })
    case "Comment":
      return SaxEvent.Comment({ data: ev.data, span: ev.span })
    case "ProcessingInstruction":
      return SaxEvent.ProcessingInstruction({
        target: ev.target,
        data: ev.data,
        span: ev.span,
      })
    case "Doctype":
      return SaxEvent.Doctype({
        name: ev.name,
        publicId: ev.publicId,
        systemId: ev.systemId,
        internalSubset: ev.internalSubset,
        span: ev.span,
      })
    case "XmlDeclaration":
      return SaxEvent.XmlDeclaration({
        version: ev.version,
        encoding: ev.encoding,
        standalone: ev.standalone,
        span: ev.span,
      })
  }
}

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
 */
export const tokenize =
  (options?: SaxOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Stream.Stream<SaxEvent, SaxError | E, R> => {
    const opts = resolve(options)
    return Stream.suspend(() => {
      const lexer = new Lexer({ mode: opts.mode, entities: opts.entities })
      const body = input.pipe(Stream.mapConcat((chunk) => lexer.write(chunk)))
      const tail = Stream.unwrap(Effect.sync(() => Stream.fromIterable(lexer.end())))
      return Stream.concat(body, tail).pipe(
        Stream.flatMap((o) => {
          if (o._tag === "Fault") return Stream.fail(o.error)
          const ev = convert(o, opts)
          return ev === null ? Stream.empty : Stream.succeed(ev)
        })
      )
    })
  }

/** Tokenize a complete in-memory string into a stream of SAX events. */
export const tokenizeString = (
  input: string,
  options?: SaxOptions
): Stream.Stream<SaxEvent, SaxError> =>
  Stream.make(input).pipe(tokenize(options))

/** Collect every SAX event into an array (convenient for tests and small inputs). */
export const collect = (
  input: string,
  options?: SaxOptions
): Effect.Effect<ReadonlyArray<SaxEvent>, SaxError> =>
  tokenizeString(input, options).pipe(Stream.runCollect, Effect.map((c) => Array.from(c)))

// -----------------------------------------------------------------------------
// Stream selectors
// -----------------------------------------------------------------------------

/** Keep only `StartElement` events. */
export const startElements = <E, R>(self: Stream.Stream<SaxEvent, E, R>) =>
  Stream.filter(self, isStartElement)

/** Keep only `EndElement` events. */
export const endElements = <E, R>(self: Stream.Stream<SaxEvent, E, R>) =>
  Stream.filter(self, isEndElement)

/** Keep only `Text` events. */
export const texts = <E, R>(self: Stream.Stream<SaxEvent, E, R>) =>
  Stream.filter(self, isText)

/** Keep only start/end events whose name matches `name`. */
export const named =
  (name: string) =>
  <E, R>(self: Stream.Stream<SaxEvent, E, R>) =>
    Stream.filter(
      self,
      (ev): ev is Extract<SaxEvent, { name: TagName }> =>
        (isStartElement(ev) || isEndElement(ev)) && ev.name === name
    )

// -----------------------------------------------------------------------------
// Attribute helpers
// -----------------------------------------------------------------------------

/** Look up an attribute value by name on a start element. */
export const getAttribute = (
  element: Extract<SaxEvent, { _tag: "StartElement" }>,
  name: string
): Option.Option<string> => {
  const found = element.attributes.find((a) => a.name === name)
  return found ? Option.some(found.value) : Option.none()
}
