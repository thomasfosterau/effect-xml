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
import { Input, ParseError, Parser } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  InvalidDocumentStructure,
  InvalidEntity,
  LimitExceeded,
  MalformedDeclaration,
  UnexpectedCharacter,
  UnexpectedEndOfInput,
  type LexError,
} from "../Error.ts";
import type { Position, Span } from "../Position.ts";
import { declarationContexts } from "./declarations.ts";
import { drive } from "./drive.ts";
import { quote } from "./quote.ts";
import type { Dtd } from "./dtd.ts";
import { grammars, type Grammars, Issue, type RawKind, type Tok } from "./tokens.ts";

// -----------------------------------------------------------------------------
// Output model
// -----------------------------------------------------------------------------

interface LexAttribute {
  readonly name: string;
  readonly value: string;
  readonly span: Span;
}

export type LexEvent =
  | {
      readonly _tag: "StartElement";
      readonly name: string;
      readonly attributes: ReadonlyArray<LexAttribute>;
      readonly selfClosing: boolean;
      readonly span: Span;
    }
  | { readonly _tag: "EndElement"; readonly name: string; readonly span: Span }
  | { readonly _tag: "Text"; readonly data: string; readonly span: Span }
  | { readonly _tag: "CData"; readonly data: string; readonly span: Span }
  | { readonly _tag: "Comment"; readonly data: string; readonly span: Span }
  | {
      readonly _tag: "ProcessingInstruction";
      readonly target: string;
      readonly data: string;
      readonly span: Span;
    }
  | {
      readonly _tag: "Doctype";
      readonly name: string;
      readonly publicId: string | null;
      readonly systemId: string | null;
      readonly internalSubset: string | null;
      readonly span: Span;
    }
  | {
      readonly _tag: "XmlDeclaration";
      readonly version: string;
      readonly encoding: string | null;
      readonly standalone: boolean | null;
      readonly span: Span;
    }
  | { readonly _tag: "EntityReference"; readonly name: string; readonly span: Span };

/** A fatal fault. The SAX stream turns these into typed failures. */
export interface LexFault {
  readonly _tag: "Fault";
  readonly error: LexError | LimitExceeded | InvalidDocumentStructure;
}

export type LexOutput = LexEvent | LexFault;

// The guards below run per token. Each is its own function with a direct
// tag check, not a `$is` guard: `Predicate.isTagged` (what `$is` returns) is
// one function shared by every guard in the program, so its property reads
// see every tagged shape and go megamorphic, which costs the SAX path about a
// third of its throughput (`vp run bench`).

/** Is this output a fault? */
export const isFault = (o: LexOutput): o is Extract<LexOutput, { readonly _tag: "Fault" }> =>
  o._tag === "Fault";

/** Guards for the {@link LexEvent} kinds the drivers branch on. */
export const isStartElementEvent = (
  o: LexOutput,
): o is Extract<LexOutput, { readonly _tag: "StartElement" }> => o._tag === "StartElement";
export const isEndElementEvent = (
  o: LexOutput,
): o is Extract<LexOutput, { readonly _tag: "EndElement" }> => o._tag === "EndElement";
export const isDoctypeEvent = (
  o: LexOutput,
): o is Extract<LexOutput, { readonly _tag: "Doctype" }> => o._tag === "Doctype";
export const isXmlDeclarationEvent = (
  o: LexOutput,
): o is Extract<LexOutput, { readonly _tag: "XmlDeclaration" }> => o._tag === "XmlDeclaration";
export const isEntityReferenceEvent = (
  o: LexOutput,
): o is Extract<LexOutput, { readonly _tag: "EntityReference" }> => o._tag === "EntityReference";

const isEndTag = (t: Tok): t is Extract<Tok, { readonly _tag: "EndElement" }> =>
  t._tag === "EndElement";
const isStartTag = (t: Tok): t is Extract<Tok, { readonly _tag: "StartElement" }> =>
  t._tag === "StartElement";
const isEntityIssue = Issue.$is("Entity");

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface LexerOptions {
  /** `"xml"` is strict (unknown entities / malformed markup are faults); `"html"` recovers. */
  readonly mode: "xml" | "html";
  /** Named entity table. */
  readonly entities: Record<string, string>;
  /** Declared entities, for XML with `dtd: "internal"`. */
  readonly dtd?: Dtd | undefined;
  /**
   * XML: the input is content (an entity's replacement text), not a
   * document, so references and CDATA sections may appear at its top level.
   */
  readonly content: boolean;
  /**
   * HTML: the scripting flag. When set, `<noscript>` content is raw text, as
   * a browser with scripting enabled reads it.
   */
  readonly scripting?: boolean | undefined;
}

/** HTML elements whose contents the tokenizer reads as raw text. */
const RAW_KINDS = HashMap.make<ReadonlyArray<readonly [string, RawKind | "plaintext"]>>(
  ["script", "script"],
  ["style", "rawtext"],
  ["noframes", "rawtext"],
  ["noembed", "rawtext"],
  ["iframe", "rawtext"],
  ["xmp", "rawtext"],
  ["title", "rcdata"],
  ["textarea", "rcdata"],
  ["plaintext", "plaintext"],
);

type LexState =
  | { readonly _tag: "Data" }
  | { readonly _tag: "Raw"; readonly name: string; readonly kind: RawKind }
  | { readonly _tag: "Plaintext" }
  | { readonly _tag: "RcdataToEnd" };
const LexState = Data.taggedEnum<LexState>();

const matchState = LexState.$match;

/**
 * A character XML 1.0 does not allow anywhere in a document (§2.2 `Char`):
 * the C0 controls other than tab, LF and CR (a CR never reaches the buffer),
 * and U+FFFE / U+FFFF. Surrogates come in pairs in decoded input.
 */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const DATA: LexState = LexState.Data();
const PLAINTEXT: LexState = LexState.Plaintext();
const RCDATA_TO_END: LexState = LexState.RcdataToEnd();

// -----------------------------------------------------------------------------
// Positions
// -----------------------------------------------------------------------------

/**
 * Line/column/offset of indices into the (CRLF-normalized) input. `offset`
 * counts raw UTF-16 units, so each collapsed `\r\n` adds one. Queries are
 * expected to move forward; one behind the last falls back to the anchor
 * (the start of the current token).
 */
/**
 * The first position at or after `from` in the ascending CRLF records whose
 * index is not before `index` (a binary search: the records are sorted).
 */
const crlfBound = (crlf: ReadonlyArray<number>, from: number, index: number): number => {
  // The common case: no CRLF record between the last query and this one.
  const first = crlf[from];
  return first === undefined || first >= index
    ? from
    : crlfSearch(crlf, index, from + 1, crlf.length);
};

/** Binary search in `[lo, hi)` for the first record not before `index`. */
const crlfSearch = (crlf: ReadonlyArray<number>, index: number, lo: number, hi: number): number => {
  if (lo >= hi) return lo;
  const mid = (lo + hi) >>> 1;
  const at = crlf[mid];
  return at !== undefined && at < index
    ? crlfSearch(crlf, index, mid + 1, hi)
    : crlfSearch(crlf, index, lo, mid);
};

class Positions {
  /** Absolute indices of `\n`s that were `\r\n` in the raw input, ascending. */
  readonly crlf: Array<number> = [];
  private anchorIndex = 0;
  private anchorPos: Position = { offset: 0, line: 1, column: 1 };
  private anchorCrlf = 0;
  private index = 0;
  private pos: Position = this.anchorPos;
  private crlfNext = 0;
  /**
   * The first `\n` at or after absolute index {@link newlineFrom}, or -1 if
   * the buffer had none when it ended at {@link newlineLimit}. Each query
   * moves forward from it, so every newline is searched for once, rather
   * than the text between two positions being sliced and split per query.
   */
  private newlineFrom = 0;
  private newline = -1;
  private newlineLimit = 0;
  private readonly source: { readonly buf: string; readonly base: number };

  constructor(source: { readonly buf: string; readonly base: number }) {
    this.source = source;
  }

  /** The first `\n` at or after absolute index `from` (at or after the buffer's start), or -1. */
  private nextNewline(from: number): number {
    const { buf, base } = this.source;
    const end = base + buf.length;
    const known = this.newline;
    if (from >= this.newlineFrom && (known === -1 ? this.newlineLimit === end : from <= known)) {
      return known;
    }
    // Text before the limit is unchanged (input is only appended and the
    // buffer only trimmed at the front), so a search that found nothing
    // resumes at the limit.
    const resume =
      known === -1 && from >= this.newlineFrom ? Math.max(from, this.newlineLimit) : from;
    const at = buf.indexOf("\n", resume - base);
    this.newlineFrom = from;
    this.newline = at === -1 ? -1 : base + at;
    this.newlineLimit = end;
    return this.newline;
  }

  at(index: number): Position {
    if (index < this.index) {
      this.index = this.anchorIndex;
      this.pos = this.anchorPos;
      this.crlfNext = this.anchorCrlf;
    }
    if (index === this.index) return this.pos;
    let { line, column } = this.pos;
    // Lines: count the newlines in between; the column restarts after the last.
    // (The search starts at the buffer at the earliest.)
    const from = Math.max(this.index, this.source.base);
    const nl = this.nextNewline(from);
    if (nl === -1 || nl >= index) {
      column += index - this.index;
    } else {
      // From the first newline on: it is at index 0 of `between`.
      const { buf, base } = this.source;
      const between = buf.slice(nl - base, index - base);
      line += between.split("\n").length - 1;
      column = index - (nl + between.lastIndexOf("\n"));
    }
    // Offsets: one per character, plus one per collapsed CRLF.
    const k = crlfBound(this.crlf, this.crlfNext, index);
    const offset = this.pos.offset + (index - this.index) + (k - this.crlfNext);
    this.index = index;
    this.pos = { offset, line, column };
    this.crlfNext = k;
    return this.pos;
  }

  /** Make `index` (the start of a token) the point to fall back to. */
  anchor(index: number): void {
    const pos = this.at(index);
    this.anchorIndex = index;
    this.anchorPos = pos;
    this.anchorCrlf = this.crlfNext;
  }

  /** Forget CRLF records before `index` (the buffer has been trimmed). */
  trim(index: number): void {
    const n = crlfBound(this.crlf, 0, index);
    if (n > 0) {
      this.crlf.splice(0, n);
      this.crlfNext -= n;
      this.anchorCrlf -= n;
    }
  }
}

/** The (whole) character at `index`, or `""` past the end. */
const charAt = (s: string, index: number): string => {
  const cp = s.codePointAt(index);
  return cp === undefined ? "" : String.fromCodePoint(cp);
};

// -----------------------------------------------------------------------------
// The lexer
// -----------------------------------------------------------------------------

export class Lexer {
  /** Unconsumed input (with `\r\n` and `\r` normalized to `\n`), from absolute index `base`. */
  buf = "";
  base = 0;
  /** Buffer index of the next token. */
  private cursor = 0;
  private pendingCR = false;
  private ended = false;
  /** After an Incomplete token: the buffer length to wait for before retrying. */
  private retryAt = 0;
  private failed = false;
  /**
   * XML: the absolute index of the first character XML does not allow, or -1.
   * The token that takes it in fails, wherever the chunks were split.
   */
  private forbidden = -1;
  private state: LexState = DATA;
  /** XML: the number of elements open, for the checks outside the root element. */
  private depth = 0;
  /** XML: why the last token {@link misplaced} looked at is not well-formed. */
  private misplacement: Option.Option<InvalidDocumentStructure> = Option.none();
  private readonly grammars: Grammars;
  private readonly positions: Positions = new Positions(this);

  /**
   * When set by a coupled tree builder, raw-text/rcdata/plaintext elements are
   * NOT switched into their raw tokenizer state (used inside foreign content).
   */
  suppressRawText = false;

  /** The raw tokenizer state an HTML start tag of this name switches to, if any. */
  private rawKind(name: string): Option.Option<RawKind | "plaintext"> {
    return name === "noscript" && this.options.scripting === true
      ? Option.some("rawtext")
      : HashMap.get(RAW_KINDS, name);
  }

  /**
   * HTML fragment parsing: set the initial tokenizer state from the context
   * element (WHATWG "parsing HTML fragments", step 4). No start tag has been
   * emitted, so no end tag is appropriate: a raw-text context reads everything
   * to EOF as text (rcdata with its character references decoded).
   */
  startInContext(name: string): void {
    Option.map(this.rawKind(name), (kind) => {
      this.state = kind === "rcdata" ? RCDATA_TO_END : PLAINTEXT;
    });
  }

  private readonly options: LexerOptions;

  constructor(options: LexerOptions) {
    this.options = options;
    this.grammars = grammars(options.mode, options.entities, options.dtd);
  }

  /** Feed a chunk of input. Returns every output produced by this chunk. */
  write(input: string): ReadonlyArray<LexOutput> {
    this.push(input);
    return this.drain();
  }

  /** Signal end of input and flush any pending output. */
  end(): ReadonlyArray<LexOutput> {
    this.ended = true;
    return this.drain();
  }

  /** Length of the input buffered for a token that is not complete yet. */
  get pendingLength(): number {
    return this.buf.length - this.cursor;
  }

  /** Where the pending (incomplete) token starts. */
  pendingPosition(): Position {
    return this.at(this.cursor);
  }

  /** The position just past all the input written so far. */
  position(): Position {
    return this.at(this.buf.length);
  }

  /** Add input without lexing it (see {@link pull}). */
  push(input: string): void {
    if (Str.isEmpty(input)) return;
    let s = input;
    if (this.pendingCR && s.charCodeAt(0) === 10) {
      // The LF of a CRLF split across chunks: the CR is already in as `\n`.
      this.positions.crlf.push(this.base + this.buf.length - 1);
      s = s.slice(1);
    }
    this.pendingCR = s.charCodeAt(s.length - 1) === 13;
    // Keep only the unconsumed input: appending makes a new string anyway.
    if (this.cursor > 0) this.trimTo(this.cursor);
    if (s.indexOf("\r") !== -1) s = this.normalize(s);
    if (this.forbidden === -1 && this.options.mode === "xml") {
      const i = s.search(FORBIDDEN);
      if (i !== -1) this.forbidden = this.base + this.buf.length + i;
    }
    this.buf += s;
  }

  /** Signal end of input (see {@link pull}). */
  close(): void {
    this.ended = true;
  }

  /**
   * Lex the next token. Returns its outputs (possibly none), or `null` when
   * no token can be read until more input arrives (or ever, after the end).
   */
  pull(): ReadonlyArray<LexOutput> | null {
    if (this.failed || this.cursor >= this.buf.length) return null;
    if (!this.ended && this.buf.length < this.retryAt) return null;
    const start = this.cursor;
    const state = this.parseState(start);
    // The compiled grammar runs on the reused state; on a failure `Parser.run`
    // re-runs the interpreter, so `mode` and the reported failure are its.
    const step = Parser.run(this.grammar(), state);
    if (step === Input.Fail) {
      if (state.mode === "Incomplete" && !this.ended) {
        this.retryAt = this.buf.length + 1 + ((this.buf.length - start) >> 1);
        return null;
      }
      this.failed = true;
      return [{ _tag: "Fault", error: this.toError(state) }];
    }
    this.positions.anchor(this.base + start);
    if (this.forbidden !== -1 && this.forbidden < this.base + state.pos) {
      this.failed = true;
      return [{ _tag: "Fault", error: this.forbiddenCharacter() }];
    }
    if (this.options.mode === "xml" && step.some(this.misplaced)) {
      this.failed = true;
      // `misplaced` recorded why.
      return Arr.fromOption(
        Option.map(this.misplacement, (error): LexFault => ({ _tag: "Fault", error })),
      );
    }
    this.cursor = state.pos;
    this.retryAt = 0;
    const out = step.map((t) => this.event(t));
    this.compact();
    step.forEach((t) => this.transition(t));
    return out;
  }

  /**
   * A parse state at buffer index `pos`. One is reused while the buffer is
   * the same string, with its per-run fields reset.
   */
  private parseState(pos: number): Input.State<string> {
    const state = this.state_;
    if (state === undefined || state.input !== this.buf) {
      return (this.state_ = new Input.State(this.buf, { partial: !this.ended, offset: pos }));
    }
    // The grammars read no services, so the empty context `reset` restores is
    // the one the state was built with.
    return state.reset(pos, { partial: !this.ended });
  }
  private state_: Input.State<string> | undefined = undefined;

  /**
   * Lex one token at a time, handing each output to `f` before the next token
   * is read, so a driver can react (switch raw text off, stop at a limit) in
   * between. Stops when `f` returns `false`, after a whole token once `full`
   * returns `true`, or when no more tokens can be read; returns whether it
   * stopped for the last reason.
   */
  pullEach(f: (output: LexOutput) => boolean, full?: (() => boolean) | undefined): boolean {
    return drive(() => this.pull(), f, full);
  }

  private drain(): ReadonlyArray<LexOutput> {
    const out: Array<LexOutput> = [];
    drive(
      () => this.pull(),
      (o) => {
        out.push(o);
        return true;
      },
    );
    return out;
  }

  /** Collapse `\r\n` and `\r` to `\n`, recording where a CRLF was. */
  private normalize(s: string): string {
    // Each CRLF collapsed so far shifts the output index of the next one back by one.
    let collapsed = 0;
    return s.replace(/\r\n?/g, (match, at: number) => {
      if (match.length === 2) {
        this.positions.crlf.push(this.base + this.buf.length + at - collapsed);
        collapsed++;
      }
      return "\n";
    });
  }

  /** Drop consumed input once it is most of the buffer. */
  private compact(): void {
    if (this.cursor >= 4096 && this.cursor >= this.buf.length >> 1) this.trimTo(this.cursor);
  }

  private trimTo(index: number): void {
    this.buf = this.buf.slice(index);
    this.base += index;
    this.cursor -= index;
    this.positions.trim(this.base);
  }

  private grammar() {
    return matchState(this.state, this.grammarFor);
  }

  /** The tokenizer state after a token. */
  private transition(t: Tok): void {
    if (isEndTag(t)) {
      this.state = DATA;
    } else if (
      isStartTag(t) &&
      !t.selfClosing &&
      this.options.mode === "html" &&
      !this.suppressRawText
    ) {
      // In HTML, certain elements switch the tokenizer into a raw mode — unless
      // we are inside foreign (SVG/MathML) content.
      const name = t.name.toLowerCase();
      Option.map(this.rawKind(name), (kind) => {
        this.state = kind === "plaintext" ? PLAINTEXT : LexState.Raw({ name, kind });
      });
    }
  }

  /**
   * XML: is `t` out of place (§2.1, §2.8)? An XML declaration must open the
   * document (an entity's replacement text has none), and outside the root
   * element there may be no references or CDATA sections. Records why in
   * {@link misplacement}, and counts the open elements as it goes.
   */
  // A `switch` and a method built once: this runs once per XML token.
  private readonly misplaced = (t: Tok): boolean => {
    switch (t._tag) {
      case "StartElement":
        if (!t.selfClosing) this.depth++;
        return false;
      case "EndElement":
        if (this.depth > 0) this.depth--;
        return false;
      case "XmlDeclaration":
        return (
          (this.options.content || this.base + t.start !== 0) &&
          this.misplace(t.start, "the XML declaration must be at the very start of the document")
        );
      case "Text":
        return (
          this.outside() &&
          this.buf.slice(t.start, t.end).indexOf("&") !== -1 &&
          this.misplace(t.start, "references are not allowed outside the root element")
        );
      case "EntityReference":
        return (
          this.outside() &&
          this.misplace(t.start, "references are not allowed outside the root element")
        );
      case "CData":
        return (
          this.outside() &&
          this.misplace(t.start, "CDATA sections are not allowed outside the root element")
        );
      default:
        return false;
    }
  };

  /** Is the lexer outside the root element of a document? */
  private outside(): boolean {
    return this.depth === 0 && !this.options.content;
  }

  /** Record why the token at `index` is out of place; always true. */
  private misplace(index: number, reason: string): true {
    this.misplacement = Option.some(
      new InvalidDocumentStructure({ position: this.at(index), reason }),
    );
    return true;
  }

  // --- output --------------------------------------------------------------

  private at(index: number): Position {
    return this.positions.at(this.base + index);
  }

  private span(t: { readonly start: number; readonly end: number }): Span {
    return { start: this.at(t.start), end: this.at(t.end) };
  }

  // A `switch`, not a `$match` table: this runs once per token, and a switch
  // lets V8 inline each case (and the `at` / `span` calls in it), where the
  // table's shared, megamorphic dispatch can't (see `vite.config.ts`).
  // Each event is built in the shape of its SAX event (the fields, then
  // `_tag`, as `SaxEvent.<Tag>(fields)` builds it), so the SAX layer can pass
  // it on instead of copying it.
  private event(t: Tok): LexEvent {
    switch (t._tag) {
      case "StartElement": {
        const start = this.at(t.start);
        const attributes = t.attributes.map((a): LexAttribute => ({
          name: a.name,
          value: a.value,
          span: this.span(a),
        }));
        return {
          name: t.name,
          attributes,
          selfClosing: t.selfClosing,
          span: { start, end: this.at(t.end) },
          _tag: "StartElement",
        };
      }
      case "EndElement":
        return { name: t.name, span: this.span(t), _tag: "EndElement" };
      case "Text":
        return { data: t.data, span: this.span(t), _tag: "Text" };
      case "CData":
        return { data: t.data, span: this.span(t), _tag: "CData" };
      case "Comment":
        return { data: t.data, span: this.span(t), _tag: "Comment" };
      case "ProcessingInstruction":
        return { target: t.target, data: t.data, span: this.span(t), _tag: t._tag };
      case "Doctype":
        return {
          name: t.name,
          publicId: t.publicId,
          systemId: t.systemId,
          internalSubset: t.internalSubset,
          span: this.span(t),
          _tag: t._tag,
        };
      case "XmlDeclaration":
        return {
          version: t.version,
          encoding: t.encoding,
          standalone: t.standalone,
          span: this.span(t),
          _tag: t._tag,
        };
      case "EntityReference":
        return { name: t.name, span: this.span(t), _tag: t._tag };
    }
  }

  /** The grammar for each tokenizer state; built once per lexer. */
  private readonly grammarFor = {
    Data: () => this.grammars.data,
    Raw: ({ name, kind }: Extract<LexState, { _tag: "Raw" }>) => this.grammars.raw(name, kind),
    Plaintext: () => this.grammars.plaintext,
    RcdataToEnd: () => this.grammars.rcdataToEnd,
  };

  /** The error for the first character XML does not allow (the token at the cursor takes it in). */
  private forbiddenCharacter(): UnexpectedCharacter {
    const at = this.forbidden - this.base;
    return new UnexpectedCharacter({
      char: charAt(this.buf, at),
      position: this.at(at),
      context: "reading a character XML does not allow",
    });
  }

  /** The typed error for a failed (XML) token. */
  private toError(state: Input.State<string>): LexError | LimitExceeded {
    const failure = state.reportedFailure();
    const at = failure.offset;
    this.positions.anchor(this.base + this.cursor);
    // The grammar may have stumbled over the character itself.
    if (this.forbidden !== -1 && this.forbidden <= this.base + at) return this.forbiddenCharacter();
    // SAFETY: every grammar here fails with an `Issue` (its error type `P<A>`);
    // the parse state's failure record stores causes as `unknown`.
    const issue = failure.hasCause ? (failure.cause as Issue) : undefined;
    if (issue !== undefined && isEntityIssue(issue) && issue.limit !== undefined) {
      return new LimitExceeded({
        limit: issue.limit.name,
        max: issue.limit.max,
        position: this.at(issue.offset),
      });
    }
    if (issue !== undefined && isEntityIssue(issue)) {
      return new InvalidEntity({
        reference: issue.reference,
        position: this.at(issue.offset),
        reason: issue.reason,
      });
    }
    if (this.ended && at >= this.buf.length) {
      return new UnexpectedEndOfInput({
        position: this.at(this.buf.length),
        context: "parsing markup",
      });
    }
    if (issue !== undefined) {
      return new UnexpectedCharacter({
        char: charAt(this.buf, issue.offset),
        position: this.at(issue.offset),
        context: issue.context,
      });
    }
    const char = charAt(this.buf, at);
    const construct = failure.context.find((c) => HashSet.has(declarationContexts, c));
    if (construct !== undefined) {
      return new MalformedDeclaration({
        construct,
        expected: Arr.isReadonlyArrayNonEmpty(failure.expected)
          ? ParseError.formatExpected(failure.expected)
          : (failure.message ?? "valid syntax"),
        found: quote(char),
        position: this.at(at),
      });
    }
    return new UnexpectedCharacter({ char, position: this.at(at), context: "parsing markup" });
  }
}
