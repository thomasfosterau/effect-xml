/**
 * Incremental, chunk-boundary-safe lexer.
 *
 * This is the engine behind the streaming SAX interface. Unlike the previous
 * implementation (which required the whole document up front and re-parsed each
 * chunk as an independent document), this lexer is a true character state
 * machine: feed it arbitrary slices of the input via {@link Lexer.write} — even
 * ones that split a tag, an attribute, an entity, or a multi-character delimiter
 * like `<![CDATA[` down the middle — and it carries the partial state across
 * calls. Call {@link Lexer.end} once the input is exhausted to flush.
 *
 * The lexer is deliberately framework-agnostic and synchronous; the Effect
 * `Stream` integration lives in `Sax.ts`. It is mutable by design (one instance
 * per parse) for throughput; `Sax.ts` constructs a fresh instance per stream
 * materialization so this mutability is never observable.
 */
import {
  InvalidEntity,
  UnexpectedCharacter,
  UnexpectedEndOfInput,
  type LexError,
} from "../Error.ts"
import { advance, type Position, type Span } from "../Position.ts"
import { decode, htmlLegacyEntities } from "./entities.ts"

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

/** A recoverable-or-fatal fault. The SAX stream turns these into typed failures. */
export interface LexFault {
  readonly _tag: "Fault"
  readonly error: LexError
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
}

const HTML_RAWTEXT = new Set(["script", "style", "noframes", "noembed", "iframe", "xmp"])
const HTML_RCDATA = new Set(["title", "textarea"])

// -----------------------------------------------------------------------------
// Character classification
// -----------------------------------------------------------------------------

const isWhitespace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r"

const isNameStart = (c: string): boolean => {
  if (c === "_" || c === ":") return true
  const code = c.charCodeAt(0)
  return (
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code > 127 // permissive for the rest of Unicode
  )
}

const isNameChar = (c: string): boolean => {
  if (isNameStart(c)) return true
  if (c === "-" || c === ".") return true
  const code = c.charCodeAt(0)
  return code >= 48 && code <= 57 // 0-9
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

const enum S {
  Data,
  TagOpen,
  EndTagOpen,
  TagName,
  EndTagName,
  EndTagAfter,
  BeforeAttr,
  AttrName,
  AfterAttrName,
  BeforeAttrValue,
  AttrValueDQ,
  AttrValueSQ,
  AttrValueUQ,
  SelfClosing,
  MarkupDecl,
  Comment,
  BogusComment,
  CData,
  Doctype,
  PiBody,
  RawText,
  RcData,
  Plaintext,
}

/** Compute the position `relOffset` UTF-16 units into `raw`, starting from `from`. */
const positionAt = (from: Position, raw: string, relOffset: number): Position => {
  let pos = from
  for (let i = 0; i < relOffset && i < raw.length; i++) pos = advance(pos, raw[i]!)
  return pos
}

export class Lexer {
  private state: S = S.Data
  private pos: Position = { offset: 0, line: 1, column: 1 }
  private pendingCR = false
  private out: Array<LexOutput> = []

  // Accumulators
  private text = ""
  private textStart: Position = this.pos
  private tagStart: Position = this.pos
  private tagName = ""
  private attrs: Array<LexAttribute> = []
  private attrName = ""
  private attrValue = ""
  private attrStart: Position = this.pos
  private markupBuf = ""
  private commentDashes = 0
  private commentBang = false
  private cdataBrackets = 0
  private piBuf = ""
  private piQ = false
  private dtBuf = ""
  private dtQuote: string | null = null
  private dtBracket = 0
  /** In bogus DOCTYPE: `>` terminates and quotes/brackets are ignored. */
  private dtBogus = false
  /** A PUBLIC/SYSTEM quoted id just closed (the next unexpected char is bogus). */
  private dtJustClosed = false
  // raw text / rcdata end-tag matcher
  private rawName = ""
  private rawTarget = ""
  private rawMatch = 0
  private rawPending = ""
  /** Script-data escape level: 0 = data, 1 = escaped (<!--), 2 = double-escaped. */
  private sLevel = 0
  /**
   * When set by a coupled tree builder, raw-text/rcdata/plaintext elements are
   * NOT switched into their raw tokenizer state (used inside foreign content).
   */
  suppressRawText = false

  constructor(private readonly options: LexerOptions) {}

  private get strict(): boolean {
    return this.options.mode === "xml"
  }

  /** Feed a chunk of input. Returns every output produced by this chunk. */
  write(input: string): ReadonlyArray<LexOutput> {
    this.out = []
    for (let i = 0; i < input.length; i++) this.consume(input[i]!)
    return this.out
  }

  /** Signal end of input and flush any pending output. */
  end(): ReadonlyArray<LexOutput> {
    this.out = []
    this.flushAtEof()
    return this.out
  }

  // --- position handling (with CRLF normalization) -------------------------

  private consume(raw: string): void {
    if (raw === "\n" && this.pendingCR) {
      // The LF half of a CRLF pair: advance the offset only.
      this.pendingCR = false
      this.pos = { offset: this.pos.offset + 1, line: this.pos.line, column: this.pos.column }
      return
    }
    this.pendingCR = raw === "\r"
    const c = raw === "\r" ? "\n" : raw
    const at = this.pos
    this.feed(c, at)
    this.pos =
      c === "\n"
        ? { offset: at.offset + 1, line: at.line + 1, column: 1 }
        : { offset: at.offset + 1, line: at.line, column: at.column + 1 }
  }

  // --- emit helpers --------------------------------------------------------

  private emit(ev: LexEvent): void {
    this.out.push(ev)
  }

  private fault(error: LexError): void {
    this.out.push({ _tag: "Fault", error })
  }

  private emitText(end: Position): void {
    if (this.text.length === 0) return
    const decoded = this.decodeValue(this.text, this.textStart, false)
    if (decoded !== null) {
      this.emit({ _tag: "Text", data: decoded, span: { start: this.textStart, end } })
    }
    this.text = ""
  }

  private decodeValue(raw: string, start: Position, inAttribute: boolean): string | null {
    const res = decode(raw, {
      entities: this.options.entities,
      ...(this.options.mode === "html" ? { legacy: htmlLegacyEntities } : {}),
      strict: this.strict,
      inAttribute,
    })
    if (res._tag === "Ok") return res.value
    this.fault(
      new InvalidEntity({
        reference: res.error.reference,
        position: positionAt(start, raw, res.error.relativeOffset),
        reason: res.error.reason,
      })
    )
    return this.strict ? null : raw
  }

  private finishAttribute(end: Position): void {
    const value = this.decodeValue(this.attrValue, this.attrStart, true) ?? ""
    this.attrs.push({ name: this.attrName, value, span: { start: this.attrStart, end } })
    this.attrName = ""
    this.attrValue = ""
  }

  private emitStartElement(selfClosing: boolean, end: Position): void {
    const name = this.tagName
    this.emit({
      _tag: "StartElement",
      name,
      attributes: this.attrs,
      selfClosing,
      span: { start: this.tagStart, end },
    })
    this.attrs = []
    this.tagName = ""
    // In HTML, certain elements switch the tokenizer into a raw mode — unless we
    // are inside foreign (SVG/MathML) content, where they are ordinary elements.
    if (!selfClosing && this.options.mode === "html" && !this.suppressRawText) {
      const lower = name.toLowerCase()
      if (HTML_RAWTEXT.has(lower)) {
        this.enterRaw(lower, S.RawText)
        return
      }
      if (HTML_RCDATA.has(lower)) {
        this.enterRaw(lower, S.RcData)
        return
      }
      if (lower === "plaintext") {
        // Everything to EOF becomes text; there is no escape from PLAINTEXT.
        this.text = ""
        this.textStart = this.pos
        this.state = S.Plaintext
        return
      }
    }
    this.state = S.Data
  }

  private enterRaw(name: string, state: S.RawText | S.RcData): void {
    this.rawName = name
    this.rawTarget = "</" + name
    this.rawMatch = 0
    this.rawPending = ""
    this.text = ""
    this.textStart = this.pos
    this.sLevel = 0
    this.state = state
  }

  private emitEndElement(end: Position): void {
    this.emit({ _tag: "EndElement", name: this.tagName, span: { start: this.tagStart, end } })
    this.tagName = ""
    this.state = S.Data
  }

  // --- the state machine ---------------------------------------------------

  private feed(c: string, at: Position): void {
    switch (this.state) {
      case S.Data: {
        if (c === "<") {
          this.emitText(at)
          this.tagStart = at
          this.state = S.TagOpen
        } else {
          if (this.text.length === 0) this.textStart = at
          this.text += c
        }
        return
      }

      case S.TagOpen: {
        if (c === "/") {
          this.state = S.EndTagOpen
        } else if (c === "!") {
          this.state = S.MarkupDecl
          this.markupBuf = ""
        } else if (c === "?") {
          if (this.options.mode === "html") {
            // HTML has no processing instructions: `<?` opens a bogus comment
            // whose data starts at the '?'.
            this.state = S.BogusComment
            this.text = "?"
          } else {
            this.state = S.PiBody
            this.piBuf = ""
            this.piQ = false
          }
        } else if (isNameStart(c)) {
          this.tagName = c
          this.attrs = []
          this.state = S.TagName
        } else if (this.options.mode === "html") {
          // Lenient: a stray '<' is literal text.
          this.text = "<"
          this.textStart = this.tagStart
          this.state = S.Data
          this.feed(c, at)
        } else {
          this.fault(new UnexpectedCharacter({ char: c, position: at, context: "opening a tag" }))
          this.text = "<"
          this.textStart = this.tagStart
          this.state = S.Data
          this.feed(c, at)
        }
        return
      }

      case S.TagName: {
        if (isWhitespace(c)) {
          this.state = S.BeforeAttr
        } else if (c === "/") {
          this.state = S.SelfClosing
        } else if (c === ">") {
          this.emitStartElement(false, this.afterPos(at))
        } else {
          this.tagName += c
        }
        return
      }

      case S.BeforeAttr: {
        if (isWhitespace(c)) return
        if (c === "/") {
          this.state = S.SelfClosing
        } else if (c === ">") {
          this.emitStartElement(false, this.afterPos(at))
        } else {
          this.attrName = c
          this.attrValue = ""
          this.attrStart = at
          this.state = S.AttrName
        }
        return
      }

      case S.AttrName: {
        if (isWhitespace(c)) {
          this.state = S.AfterAttrName
        } else if (c === "=") {
          this.state = S.BeforeAttrValue
        } else if (c === "/") {
          this.finishAttribute(at)
          this.state = S.SelfClosing
        } else if (c === ">") {
          this.finishAttribute(at)
          this.emitStartElement(false, this.afterPos(at))
        } else {
          this.attrName += c
        }
        return
      }

      case S.AfterAttrName: {
        if (isWhitespace(c)) return
        if (c === "=") {
          this.state = S.BeforeAttrValue
        } else if (c === "/") {
          this.finishAttribute(at)
          this.state = S.SelfClosing
        } else if (c === ">") {
          this.finishAttribute(at)
          this.emitStartElement(false, this.afterPos(at))
        } else {
          // Boolean attribute followed by another attribute.
          this.finishAttribute(at)
          this.attrName = c
          this.attrValue = ""
          this.attrStart = at
          this.state = S.AttrName
        }
        return
      }

      case S.BeforeAttrValue: {
        if (isWhitespace(c)) return
        if (c === '"') {
          this.state = S.AttrValueDQ
        } else if (c === "'") {
          this.state = S.AttrValueSQ
        } else if (c === ">") {
          this.finishAttribute(at)
          this.emitStartElement(false, this.afterPos(at))
        } else if (this.options.mode === "html") {
          this.attrValue = c
          this.state = S.AttrValueUQ
        } else {
          this.fault(
            new UnexpectedCharacter({ char: c, position: at, context: "reading an attribute value" })
          )
          this.attrValue = c
          this.state = S.AttrValueUQ
        }
        return
      }

      case S.AttrValueDQ: {
        if (c === '"') {
          this.finishAttribute(this.afterPos(at))
          this.state = S.BeforeAttr
        } else {
          this.attrValue += c
        }
        return
      }

      case S.AttrValueSQ: {
        if (c === "'") {
          this.finishAttribute(this.afterPos(at))
          this.state = S.BeforeAttr
        } else {
          this.attrValue += c
        }
        return
      }

      case S.AttrValueUQ: {
        if (isWhitespace(c)) {
          this.finishAttribute(at)
          this.state = S.BeforeAttr
        } else if (c === ">") {
          this.finishAttribute(at)
          this.emitStartElement(false, this.afterPos(at))
        } else {
          this.attrValue += c
        }
        return
      }

      case S.SelfClosing: {
        if (c === ">") {
          this.emitStartElement(true, this.afterPos(at))
        } else if (this.options.mode === "html") {
          this.state = S.BeforeAttr
          this.feed(c, at)
        } else {
          this.fault(
            new UnexpectedCharacter({ char: c, position: at, context: "closing a self-closing tag" })
          )
          this.state = S.BeforeAttr
          this.feed(c, at)
        }
        return
      }

      case S.EndTagOpen: {
        if (isNameStart(c)) {
          this.tagName = c
          this.state = S.EndTagName
        } else if (this.options.mode === "html") {
          // `</>` or `</ ...` → bogus comment.
          this.state = S.BogusComment
          this.text = ""
          this.feed(c, at)
        } else {
          this.fault(new UnexpectedCharacter({ char: c, position: at, context: "opening an end tag" }))
          this.state = S.Data
        }
        return
      }

      case S.EndTagName: {
        if (isWhitespace(c)) {
          this.state = S.EndTagAfter
        } else if (c === ">") {
          this.emitEndElement(this.afterPos(at))
        } else if (isNameChar(c)) {
          this.tagName += c
        } else if (this.options.mode === "html") {
          this.tagName += c
        } else {
          this.fault(new UnexpectedCharacter({ char: c, position: at, context: "reading an end tag name" }))
        }
        return
      }

      case S.EndTagAfter: {
        if (isWhitespace(c)) return
        if (c === ">") {
          this.emitEndElement(this.afterPos(at))
        } else if (!this.strict) {
          // ignore junk in end tags
        } else {
          this.fault(new UnexpectedCharacter({ char: c, position: at, context: "after an end tag name" }))
        }
        return
      }

      case S.MarkupDecl: {
        this.markupBuf += c
        if (this.markupBuf === "--") {
          this.state = S.Comment
          this.text = ""
          // Seed the dash counter so an immediate `>` / `->` abruptly closes the
          // comment as empty (`<!-->` and `<!--->` are empty comments per spec).
          this.commentDashes = 2
          return
        }
        if (this.markupBuf === "[CDATA[") {
          this.state = S.CData
          this.text = ""
          this.cdataBrackets = 0
          return
        }
        if (this.markupBuf.toUpperCase() === "DOCTYPE") {
          this.state = S.Doctype
          this.dtBuf = ""
          this.dtQuote = null
          this.dtBracket = 0
          this.dtBogus = false
          this.dtJustClosed = false
          return
        }
        const upper = this.markupBuf.toUpperCase()
        const stillPrefix =
          "--".startsWith(this.markupBuf) ||
          "[CDATA[".startsWith(this.markupBuf) ||
          "DOCTYPE".startsWith(upper)
        if (!stillPrefix) {
          if (this.strict) {
            this.fault(
              new UnexpectedCharacter({ char: c, position: at, context: "reading a markup declaration" })
            )
          }
          this.state = S.BogusComment
          this.text = this.markupBuf
        }
        return
      }

      case S.Comment: {
        if (c === ">" && this.commentDashes >= 2) {
          // Strip the trailing "--" (or "--!" for the comment-end-bang state).
          const strip = this.commentBang ? 3 : 2
          this.emit({
            _tag: "Comment",
            data: this.text.slice(0, this.text.length - strip),
            span: { start: this.tagStart, end: this.afterPos(at) },
          })
          this.text = ""
          this.commentBang = false
          this.state = S.Data
        } else if (c === "!" && this.commentDashes >= 2) {
          // `--!`: comment-end-bang — a following `>` still closes the comment.
          this.commentBang = true
          this.text += c
        } else {
          this.commentBang = false
          this.commentDashes = c === "-" ? this.commentDashes + 1 : 0
          this.text += c
        }
        return
      }

      case S.BogusComment: {
        if (c === ">") {
          this.emit({
            _tag: "Comment",
            data: this.text,
            span: { start: this.tagStart, end: this.afterPos(at) },
          })
          this.text = ""
          this.state = S.Data
        } else {
          this.text += c
        }
        return
      }

      case S.CData: {
        if (c === ">" && this.cdataBrackets >= 2) {
          this.emit({
            _tag: "CData",
            data: this.text.slice(0, this.text.length - 2),
            span: { start: this.tagStart, end: this.afterPos(at) },
          })
          this.text = ""
          this.state = S.Data
        } else {
          this.cdataBrackets = c === "]" ? this.cdataBrackets + 1 : 0
          this.text += c
        }
        return
      }

      case S.Doctype: {
        const emitDoctype = (): void => {
          this.emit(this.parseDoctype(this.dtBuf, this.afterPos(at)))
          this.dtBuf = ""
          this.state = S.Data
        }
        if (this.dtBogus) {
          // Bogus DOCTYPE: consume everything until the next `>`.
          if (c === ">") emitDoctype()
          else this.dtBuf += c
          return
        }
        if (this.dtQuote !== null) {
          this.dtBuf += c
          if (c === this.dtQuote) {
            this.dtQuote = null
            this.dtJustClosed = true
          }
          return
        }
        // After a closed PUBLIC/SYSTEM id, an unexpected non-quote token makes
        // the DOCTYPE bogus.
        if (this.dtJustClosed && !isWhitespace(c)) {
          this.dtJustClosed = false
          if (c === ">") {
            emitDoctype()
            return
          }
          if (c !== '"' && c !== "'") {
            this.dtBogus = true
            this.dtBuf += c
            return
          }
        }
        // In HTML an internal-subset `[` makes the DOCTYPE bogus; XML tracks it.
        if (c === "[" && this.options.mode === "html") {
          this.dtBogus = true
          this.dtBuf += c
        } else if ((c === '"' || c === "'") && /PUBLIC|SYSTEM/i.test(this.dtBuf)) {
          // Quotes are only significant after a PUBLIC/SYSTEM keyword.
          this.dtQuote = c
          this.dtBuf += c
        } else if (c === "[") {
          this.dtBracket++
          this.dtBuf += c
        } else if (c === "]") {
          this.dtBracket--
          this.dtBuf += c
        } else if (c === ">" && this.dtBracket <= 0) {
          emitDoctype()
        } else {
          this.dtBuf += c
        }
        return
      }

      case S.PiBody: {
        if (c === ">" && this.piQ) {
          this.emit(this.parsePi(this.piBuf.slice(0, this.piBuf.length - 1), this.afterPos(at)))
          this.piBuf = ""
          this.piQ = false
          this.state = S.Data
        } else {
          this.piQ = c === "?"
          this.piBuf += c
        }
        return
      }

      case S.RawText:
        if (this.rawName === "script") this.feedScript(c, at)
        else this.feedRaw(c, at, false)
        return

      case S.RcData:
        this.feedRaw(c, at, true)
        return

      case S.Plaintext:
        this.text += c
        return
    }
  }

  /** Position immediately after the char at `at` (its half-open span end). */
  private afterPos(at: Position): Position {
    return { offset: at.offset + 1, line: at.line, column: at.column + 1 }
  }

  // --- script data (with escaped / double-escaped handling) ---------------

  /** Append raw script text, tracking the `<!-- ... <script> ... </script>` escape level. */
  private appendScriptText(s: string): void {
    for (const ch of s) {
      if (this.text.length === 0) this.textStart = this.pos
      this.text += ch
      const t = this.text
      if (this.sLevel === 0 && t.endsWith("<!--")) {
        this.sLevel = 1
      } else if (this.sLevel > 0 && t.endsWith("-->")) {
        this.sLevel = this.sLevel === 2 ? 1 : 0
      } else if (
        this.sLevel === 1 &&
        (isWhitespace(ch) || ch === "/" || ch === ">") &&
        /<script$/i.test(t.slice(0, -1))
      ) {
        this.sLevel = 2
      }
    }
  }

  private feedScript(c: string, at: Position): void {
    // Tentatively match the literal "</script" end tag.
    if (this.rawMatch < this.rawTarget.length) {
      if (c.toLowerCase() === this.rawTarget[this.rawMatch]) {
        this.rawMatch++
        this.rawPending += c
        return
      }
      this.appendScriptText(this.rawPending)
      this.rawPending = ""
      if (c.toLowerCase() === this.rawTarget[0]) {
        this.rawMatch = 1
        this.rawPending = c
      } else {
        this.rawMatch = 0
        this.appendScriptText(c)
      }
      return
    }
    // We matched "</script"; the next char decides.
    if (isWhitespace(c) || c === ">" || c === "/") {
      if (this.sLevel >= 2) {
        // Double-escaped: this is not the script's end tag; drop one level.
        this.appendScriptText(this.rawPending)
        this.rawPending = ""
        this.rawMatch = 0
        this.sLevel = 1
        this.appendScriptText(c)
        return
      }
      if (this.text.length > 0) {
        this.emit({ _tag: "Text", data: this.text, span: { start: this.textStart, end: this.tagStart } })
      }
      this.text = ""
      this.tagName = this.rawName
      this.tagStart = at
      this.rawMatch = 0
      this.rawPending = ""
      this.sLevel = 0
      if (c === ">") {
        this.emitEndElement(this.afterPos(at))
      } else if (c === "/") {
        this.state = S.SelfClosing
      } else {
        this.state = S.EndTagAfter
      }
      return
    }
    // e.g. `</scriptish` — not the end tag.
    this.appendScriptText(this.rawPending + c)
    this.rawPending = ""
    this.rawMatch = 0
  }

  // --- raw text / rcdata ---------------------------------------------------

  private feedRaw(c: string, at: Position, decodeEntities: boolean): void {
    if (this.rawMatch < this.rawTarget.length) {
      if (c.toLowerCase() === this.rawTarget[this.rawMatch]) {
        this.rawMatch++
        this.rawPending += c
        return
      }
      // Mismatch: the pending chars were ordinary text after all.
      this.text += this.rawPending
      this.rawPending = ""
      if (c.toLowerCase() === this.rawTarget[0]) {
        this.rawMatch = 1
        this.rawPending = c
      } else {
        this.rawMatch = 0
        if (this.text.length === 0) this.textStart = at
        this.text += c
      }
      return
    }
    // We have matched "</name"; the next char decides if it's really the end tag.
    if (isWhitespace(c) || c === ">" || c === "/") {
      // Flush the accumulated raw text.
      if (this.text.length > 0) {
        const data = decodeEntities ? this.decodeValue(this.text, this.textStart, false) : this.text
        if (data !== null) {
          this.emit({ _tag: "Text", data, span: { start: this.textStart, end: this.tagStart } })
        }
      }
      this.text = ""
      this.tagName = this.rawName
      this.tagStart = at // approximate; raw end tags are rarely diagnosed precisely
      this.rawMatch = 0
      this.rawPending = ""
      if (c === ">") {
        this.emitEndElement(this.afterPos(at))
      } else if (c === "/") {
        this.state = S.SelfClosing
      } else {
        this.state = S.EndTagAfter
      }
    } else {
      // e.g. `</scriptish` — not our end tag.
      this.text += this.rawPending + c
      this.rawPending = ""
      this.rawMatch = 0
    }
  }

  // --- declaration parsing -------------------------------------------------

  private parsePi(body: string, end: Position): LexEvent {
    const trimmed = body.replace(/^\s+/, "")
    const m = /^(\S+)\s*([\s\S]*)$/.exec(trimmed)
    const target = m ? m[1]! : trimmed
    const data = m ? m[2]! : ""
    if (target.toLowerCase() === "xml") {
      return this.parseXmlDeclaration(data, end)
    }
    return { _tag: "ProcessingInstruction", target, data, span: { start: this.tagStart, end } }
  }

  private parseXmlDeclaration(data: string, end: Position): LexEvent {
    const pseudo = (name: string): string | null => {
      const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`)
      const m = re.exec(data)
      return m ? (m[2] ?? m[3] ?? "") : null
    }
    const standaloneRaw = pseudo("standalone")
    return {
      _tag: "XmlDeclaration",
      version: pseudo("version") ?? "1.0",
      encoding: pseudo("encoding"),
      standalone: standaloneRaw === null ? null : standaloneRaw === "yes",
      span: { start: this.tagStart, end },
    }
  }

  private parseDoctype(body: string, end: Position): LexEvent {
    const bracketStart = body.indexOf("[")
    const internalSubset =
      bracketStart !== -1
        ? body.slice(bracketStart + 1, body.lastIndexOf("]"))
        : null
    const head = bracketStart !== -1 ? body.slice(0, bracketStart) : body
    const trimmed = head.trim()
    const nameMatch = /^(\S+)/.exec(trimmed)
    const name = nameMatch ? nameMatch[1]! : ""
    let publicId: string | null = null
    let systemId: string | null = null
    const pub = /PUBLIC\s*("([^"]*)"|'([^']*)')\s*("([^"]*)"|'([^']*)')?/i.exec(trimmed)
    if (pub) {
      publicId = pub[2] ?? pub[3] ?? null
      systemId = pub[5] ?? pub[6] ?? null
    } else {
      const sys = /SYSTEM\s*("([^"]*)"|'([^']*)')/i.exec(trimmed)
      if (sys) systemId = sys[2] ?? sys[3] ?? null
    }
    return {
      _tag: "Doctype",
      name,
      publicId,
      systemId,
      internalSubset: internalSubset === null ? null : internalSubset.trim() || null,
      span: { start: this.tagStart, end },
    }
  }

  // --- EOF -----------------------------------------------------------------

  private flushAtEof(): void {
    switch (this.state) {
      case S.Data:
        this.emitText(this.pos)
        return
      case S.RawText:
      case S.RcData:
        this.text += this.rawPending
        if (this.text.length > 0) {
          this.emit({ _tag: "Text", data: this.text, span: { start: this.textStart, end: this.pos } })
        }
        return
      case S.Plaintext:
        if (this.text.length > 0) {
          this.emit({ _tag: "Text", data: this.text, span: { start: this.textStart, end: this.pos } })
        }
        return
      case S.Doctype:
        // Unterminated DOCTYPE at EOF (HTML) still emits what was parsed.
        if (this.options.mode === "html") {
          this.emit(this.parseDoctype(this.dtBuf, this.pos))
          return
        }
        break
      case S.CData:
        // Unterminated CDATA at EOF: in HTML the accumulated content (including
        // any trailing `]]`) is emitted as-is; XML falls through to a fault.
        if (this.options.mode === "html") {
          this.emit({ _tag: "CData", data: this.text, span: { start: this.tagStart, end: this.pos } })
          return
        }
        break
      case S.Comment:
      case S.BogusComment:
        if (!this.strict) {
          // Strip a trailing incomplete "--"/"--!" (an unfinished "-->").
          let data = this.text
          if (this.state === S.Comment && this.commentDashes >= 2) {
            data = data.slice(0, data.length - (this.commentBang ? 3 : 2))
          }
          this.emit({ _tag: "Comment", data, span: { start: this.tagStart, end: this.pos } })
          return
        }
        break
      default:
        break
    }
    // HTML EOF recovery: an unfinished `<` / `</` becomes literal text and an
    // unfinished `<!` becomes an (empty) bogus comment.
    if (this.options.mode === "html") {
      if (this.state === S.TagOpen) {
        this.emit({ _tag: "Text", data: "<", span: { start: this.tagStart, end: this.pos } })
        return
      }
      if (this.state === S.EndTagOpen) {
        this.emit({ _tag: "Text", data: "</", span: { start: this.tagStart, end: this.pos } })
        return
      }
      if (this.state === S.MarkupDecl) {
        this.emit({ _tag: "Comment", data: this.markupBuf, span: { start: this.tagStart, end: this.pos } })
        return
      }
    }
    if (this.strict) {
      this.fault(
        new UnexpectedEndOfInput({ position: this.pos, context: "parsing markup" })
      )
    }
  }
}
