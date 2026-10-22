/**
 * Incremental, chunk-boundary-safe lexer.
 *
 * This is the engine behind the streaming SAX interface. Feed it arbitrary
 * slices of the input via {@link Lexer.write}, even ones that split a tag, an
 * attribute, an entity, or a delimiter like `<![CDATA[` down the middle, and
 * call {@link Lexer.end} once the input is exhausted.
 *
 * The tokens themselves are read by effect-parse grammars (`tokens.ts`). The
 * lexer keeps the unconsumed input in a buffer and runs the grammar for the
 * current tokenizer state at the cursor, in partial mode until the input has
 * ended: a grammar that runs out of buffer reports "Incomplete", and is tried
 * again once more input has arrived. Retries wait for the pending input to
 * grow by half, so a token split over many chunks is read in linear time.
 *
 * Coupled drivers (the HTML tree builder) instead {@link Lexer.push} input and
 * {@link Lexer.pull} one token at a time, adjusting {@link Lexer.suppressRawText}
 * in between.
 *
 * The lexer is framework-agnostic and synchronous; the Effect `Stream`
 * integration lives in `Sax.ts`, which constructs a fresh instance per stream
 * materialization.
 */
import { Input, ParseError } from "@thomasfosterau/effect-parse"
import {
  InvalidEntity,
  LimitExceeded,
  MalformedDeclaration,
  UnexpectedCharacter,
  UnexpectedEndOfInput,
  type LexError,
} from "../Error.ts"
import type { Position, Span } from "../Position.ts"
import { declarationContexts } from "./declarations.ts"
import type { Dtd } from "./dtd.ts"
import { grammars, type Grammars, type Issue, type RawKind, type Step, type Tok } from "./tokens.ts"

// -----------------------------------------------------------------------------
// Output model
// -----------------------------------------------------------------------------

export interface LexAttribute {
  readonly name: string
  readonly value: string
  readonly span: Span
}

export type LexEvent =
  | { readonly _tag: "StartElement"; readonly name: string; readonly attributes: ReadonlyArray<LexAttribute>; readonly selfClosing: boolean; readonly span: Span }
  | { readonly _tag: "EndElement"; readonly name: string; readonly span: Span }
  | { readonly _tag: "Text"; readonly data: string; readonly span: Span }
  | { readonly _tag: "CData"; readonly data: string; readonly span: Span }
  | { readonly _tag: "Comment"; readonly data: string; readonly span: Span }
  | { readonly _tag: "ProcessingInstruction"; readonly target: string; readonly data: string; readonly span: Span }
  | { readonly _tag: "Doctype"; readonly name: string; readonly publicId: string | null; readonly systemId: string | null; readonly internalSubset: string | null; readonly span: Span }
  | { readonly _tag: "XmlDeclaration"; readonly version: string; readonly encoding: string | null; readonly standalone: boolean | null; readonly span: Span }
  | { readonly _tag: "EntityReference"; readonly name: string; readonly span: Span }

/** A fatal fault. The SAX stream turns these into typed failures. */
export interface LexFault {
  readonly _tag: "Fault"
  readonly error: LexError | LimitExceeded
}

export type LexOutput = LexEvent | LexFault

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface LexerOptions {
  /** `"xml"` is strict (unknown entities / malformed markup are faults); `"html"` recovers. */
  readonly mode: "xml" | "html"
  /** Named entity table. */
  readonly entities: Record<string, string>
  /** Declared entities, for XML with `dtd: "internal"`. */
  readonly dtd?: Dtd
}

/** HTML elements whose contents the tokenizer reads as raw text. */
const RAW_KINDS: ReadonlyMap<string, RawKind | "plaintext"> = new Map([
  ["script", "script"],
  ["style", "rawtext"],
  ["noframes", "rawtext"],
  ["noembed", "rawtext"],
  ["iframe", "rawtext"],
  ["xmp", "rawtext"],
  ["title", "rcdata"],
  ["textarea", "rcdata"],
  ["plaintext", "plaintext"],
])

type LexState =
  | { readonly _tag: "Data" }
  | { readonly _tag: "Raw"; readonly name: string; readonly kind: RawKind }
  | { readonly _tag: "Plaintext" }

const DATA: LexState = { _tag: "Data" }
const PLAINTEXT: LexState = { _tag: "Plaintext" }

// -----------------------------------------------------------------------------
// Positions
// -----------------------------------------------------------------------------

/**
 * Line/column/offset of indices into the (CRLF-normalized) input. `offset`
 * counts raw UTF-16 units, so each collapsed `\r\n` adds one. Queries are
 * expected to move forward; one behind the last falls back to the anchor
 * (the start of the current token).
 */
class Positions {
  /** Absolute indices of `\n`s that were `\r\n` in the raw input, ascending. */
  readonly crlf: Array<number> = []
  private anchorIndex = 0
  private anchorPos: Position = { offset: 0, line: 1, column: 1 }
  private anchorCrlf = 0
  private index = 0
  private pos: Position = this.anchorPos
  private crlfNext = 0

  constructor(private readonly source: { readonly buf: string; readonly base: number }) {}

  at(index: number): Position {
    if (index < this.index) {
      this.index = this.anchorIndex
      this.pos = this.anchorPos
      this.crlfNext = this.anchorCrlf
    }
    if (index === this.index) return this.pos
    const { buf, base } = this.source
    let { line, column } = this.pos
    // Lines: count the newlines in between; the column restarts after the last.
    // Only the characters in between are scanned (an `indexOf` would run on to
    // the next newline, which may be the end of a long buffer, every time).
    let last = -1
    for (let i = this.index - base; i < index - base; i++) {
      if (buf.charCodeAt(i) === 10) {
        line++
        last = i
      }
    }
    column = last === -1 ? column + (index - this.index) : index - base - last
    // Offsets: one per character, plus one per collapsed CRLF.
    let k = this.crlfNext
    while (k < this.crlf.length && this.crlf[k]! < index) k++
    const offset = this.pos.offset + (index - this.index) + (k - this.crlfNext)
    this.index = index
    this.pos = { offset, line, column }
    this.crlfNext = k
    return this.pos
  }

  /** Make `index` (the start of a token) the point to fall back to. */
  anchor(index: number): void {
    const pos = this.at(index)
    this.anchorIndex = index
    this.anchorPos = pos
    this.anchorCrlf = this.crlfNext
  }

  /** Forget CRLF records before `index` (the buffer has been trimmed). */
  trim(index: number): void {
    let n = 0
    while (n < this.crlf.length && this.crlf[n]! < index) n++
    if (n > 0) {
      this.crlf.splice(0, n)
      this.crlfNext -= n
      this.anchorCrlf -= n
    }
  }
}

// -----------------------------------------------------------------------------
// The lexer
// -----------------------------------------------------------------------------

export class Lexer {
  /** Unconsumed input (with `\r\n` and `\r` normalized to `\n`), from absolute index `base`. */
  buf = ""
  base = 0
  /** Buffer index of the next token. */
  private cursor = 0
  private pendingCR = false
  private ended = false
  /** After an Incomplete token: the buffer length to wait for before retrying. */
  private retryAt = 0
  private failed = false
  private state: LexState = DATA
  private readonly grammars: Grammars
  private readonly positions: Positions = new Positions(this)

  /**
   * When set by a coupled tree builder, raw-text/rcdata/plaintext elements are
   * NOT switched into their raw tokenizer state (used inside foreign content).
   */
  suppressRawText = false

  constructor(private readonly options: LexerOptions) {
    this.grammars = grammars(options.mode, options.entities, options.dtd)
  }

  /** Feed a chunk of input. Returns every output produced by this chunk. */
  write(input: string): ReadonlyArray<LexOutput> {
    this.push(input)
    return this.drain()
  }

  /** Signal end of input and flush any pending output. */
  end(): ReadonlyArray<LexOutput> {
    this.ended = true
    return this.drain()
  }

  /** Length of the input buffered for a token that is not complete yet. */
  get pendingLength(): number {
    return this.buf.length - this.cursor
  }

  /** Where the pending (incomplete) token starts. */
  pendingPosition(): Position {
    return this.at(this.cursor)
  }

  /** The position just past all the input written so far. */
  position(): Position {
    return this.at(this.buf.length)
  }

  /** Add input without lexing it (see {@link pull}). */
  push(input: string): void {
    if (input.length === 0) return
    let s = input
    if (this.pendingCR && s.charCodeAt(0) === 10) {
      // The LF of a CRLF split across chunks: the CR is already in as `\n`.
      this.positions.crlf.push(this.base + this.buf.length - 1)
      s = s.slice(1)
    }
    this.pendingCR = s.charCodeAt(s.length - 1) === 13
    // Keep only the unconsumed input: appending makes a new string anyway.
    if (this.cursor > 0) this.trimTo(this.cursor)
    if (s.indexOf("\r") !== -1) s = this.normalize(s)
    this.buf += s
  }

  /** Signal end of input (see {@link pull}). */
  close(): void {
    this.ended = true
  }

  /**
   * Lex the next token. Returns its outputs (possibly none), or `null` when
   * no token can be read until more input arrives (or ever, after the end).
   */
  pull(): ReadonlyArray<LexOutput> | null {
    if (this.failed || this.cursor >= this.buf.length) return null
    if (!this.ended && this.buf.length < this.retryAt) return null
    const start = this.cursor
    const state = this.parseState(start)
    const step = this.grammar().step(state) as Step | Input.Fail
    if (step === Input.Fail) {
      if (state.mode === "Incomplete" && !this.ended) {
        this.retryAt = this.buf.length + 1 + ((this.buf.length - start) >> 1)
        return null
      }
      this.failed = true
      return [{ _tag: "Fault", error: this.toError(state) }]
    }
    this.positions.anchor(this.base + start)
    this.cursor = state.pos
    this.retryAt = 0
    const out = step.map((t) => this.event(t))
    this.compact()
    for (const t of step) this.transition(t)
    return out
  }

  /**
   * A parse state at buffer index `pos`. One is reused while the buffer is
   * the same string, with its per-run fields reset.
   */
  private parseState(pos: number): Input.State<string> {
    const state = this.state_
    if (state === undefined || state.input !== this.buf) {
      return (this.state_ = new Input.State(this.buf, { partial: !this.ended, offset: pos }))
    }
    state.pos = pos
    state.partial = !this.ended
    state.mode = "Backtrack"
    state.hintOffset = -1
    state.hintExpected = []
    state.deepest = undefined
    state.depth = 0
    return state
  }
  private state_: Input.State<string> | undefined = undefined

  private drain(): ReadonlyArray<LexOutput> {
    const out: Array<LexOutput> = []
    for (let outs = this.pull(); outs !== null; outs = this.pull()) {
      for (const o of outs) out.push(o)
    }
    return out
  }

  /** Collapse `\r\n` and `\r` to `\n`, recording where a CRLF was. */
  private normalize(s: string): string {
    let out = ""
    let from = 0
    for (let i = s.indexOf("\r"); i !== -1; i = s.indexOf("\r", i + 1)) {
      out += s.slice(from, i) + "\n"
      from = i + 1
      if (s.charCodeAt(i + 1) === 10) {
        this.positions.crlf.push(this.base + this.buf.length + out.length - 1)
        from++
        i++
      }
    }
    return out + s.slice(from)
  }

  /** Drop consumed input once it is most of the buffer. */
  private compact(): void {
    if (this.cursor >= 4096 && this.cursor >= this.buf.length >> 1) this.trimTo(this.cursor)
  }

  private trimTo(index: number): void {
    this.buf = this.buf.slice(index)
    this.base += index
    this.cursor -= index
    this.positions.trim(this.base)
  }

  private grammar() {
    switch (this.state._tag) {
      case "Data":
        return this.grammars.data
      case "Raw":
        return this.grammars.raw(this.state.name, this.state.kind)
      case "Plaintext":
        return this.grammars.plaintext
    }
  }

  /** The tokenizer state after a token. */
  private transition(t: Tok): void {
    if (t._tag === "EndElement") {
      this.state = DATA
    } else if (
      t._tag === "StartElement" &&
      !t.selfClosing &&
      this.options.mode === "html" &&
      !this.suppressRawText
    ) {
      // In HTML, certain elements switch the tokenizer into a raw mode — unless
      // we are inside foreign (SVG/MathML) content.
      const name = t.name.toLowerCase()
      const kind = RAW_KINDS.get(name)
      if (kind === "plaintext") this.state = PLAINTEXT
      else if (kind !== undefined) this.state = { _tag: "Raw", name, kind }
    }
  }

  // --- output --------------------------------------------------------------

  private at(index: number): Position {
    return this.positions.at(this.base + index)
  }

  private span(t: { readonly start: number; readonly end: number }): Span {
    return { start: this.at(t.start), end: this.at(t.end) }
  }

  private event(t: Tok): LexEvent {
    switch (t._tag) {
      case "StartElement": {
        const start = this.at(t.start)
        const attributes = t.attributes.map((a) => ({ name: a.name, value: a.value, span: this.span(a) }))
        return { _tag: "StartElement", name: t.name, attributes, selfClosing: t.selfClosing, span: { start, end: this.at(t.end) } }
      }
      case "EndElement":
        return { _tag: "EndElement", name: t.name, span: this.span(t) }
      case "Text":
      case "CData":
      case "Comment":
        return { _tag: t._tag, data: t.data, span: this.span(t) }
      case "ProcessingInstruction":
        return { _tag: t._tag, target: t.target, data: t.data, span: this.span(t) }
      case "Doctype":
        return { _tag: t._tag, name: t.name, publicId: t.publicId, systemId: t.systemId, internalSubset: t.internalSubset, span: this.span(t) }
      case "XmlDeclaration":
        return { _tag: t._tag, version: t.version, encoding: t.encoding, standalone: t.standalone, span: this.span(t) }
      case "EntityReference":
        return { _tag: t._tag, name: t.name, span: this.span(t) }
    }
  }

  /** The typed error for a failed (XML) token. */
  private toError(state: Input.State<string>): LexError | LimitExceeded {
    const failure = state.reportedFailure()
    const at = failure.offset
    this.positions.anchor(this.base + this.cursor)
    const issue = failure.hasCause ? (failure.cause as Issue) : undefined
    if (issue?._tag === "Entity" && issue.limit !== undefined) {
      return new LimitExceeded({ limit: issue.limit.name, max: issue.limit.max, position: this.at(issue.offset) })
    }
    if (issue?._tag === "Entity") {
      return new InvalidEntity({ reference: issue.reference, position: this.at(issue.offset), reason: issue.reason })
    }
    if (this.ended && at >= this.buf.length) {
      return new UnexpectedEndOfInput({ position: this.at(this.buf.length), context: "parsing markup" })
    }
    const cp = this.buf.codePointAt(at)
    const char = cp === undefined ? "" : String.fromCodePoint(cp)
    if (issue !== undefined) return new UnexpectedCharacter({ char, position: this.at(at), context: issue.context })
    const construct = failure.context.find((c) => declarationContexts.has(c))
    if (construct !== undefined) {
      return new MalformedDeclaration({
        construct,
        expected: failure.expected.length > 0 ? ParseError.formatExpected(failure.expected) : (failure.message ?? "valid syntax"),
        found: JSON.stringify(char),
        position: this.at(at),
      })
    }
    return new UnexpectedCharacter({ char, position: this.at(at), context: "parsing markup" })
  }
}
