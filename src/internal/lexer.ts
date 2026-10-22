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
import { Input, ParseError } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import {
  InvalidEntity,
  LimitExceeded,
  MalformedDeclaration,
  UnexpectedCharacter,
  UnexpectedEndOfInput,
  type LexError,
} from "../Error.ts";
import type { Position, Span } from "../Position.ts";
import { declarationContexts } from "./declarations.ts";
import type { Dtd } from "./dtd.ts";
import { grammars, type Grammars, Issue, type RawKind, type Step, Tok } from "./tokens.ts";

// -----------------------------------------------------------------------------
// Output model
// -----------------------------------------------------------------------------

export interface LexAttribute {
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
  readonly error: LexError | LimitExceeded;
}

export type LexOutput = LexEvent | LexFault;

/** Matchers for {@link LexEvent}. */
export const LexEvent = Data.taggedEnum<LexEvent>();

/** Matchers and guards for {@link LexOutput}. */
const LexOutput = Data.taggedEnum<LexOutput>();

/** Is this output a fault? */
export const isFault = LexOutput.$is("Fault");

// The tagged-enum matchers and guards, taken once: each property read of a
// `Data.taggedEnum` goes through a Proxy and builds a fresh function.
const matchTok = Tok.$match;
const isEndTag = Tok.$is("EndElement");
const isStartTag = Tok.$is("StartElement");
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
  readonly dtd?: Dtd;
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
  | { readonly _tag: "Plaintext" };
const LexState = Data.taggedEnum<LexState>();

const matchState = LexState.$match;
const DATA: LexState = LexState.Data();
const PLAINTEXT: LexState = LexState.Plaintext();

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

/** Quote a source excerpt for a message: a JSON string literal, escapes and all. */
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

class Positions {
  /** Absolute indices of `\n`s that were `\r\n` in the raw input, ascending. */
  readonly crlf: Array<number> = [];
  private anchorIndex = 0;
  private anchorPos: Position = { offset: 0, line: 1, column: 1 };
  private anchorCrlf = 0;
  private index = 0;
  private pos: Position = this.anchorPos;
  private crlfNext = 0;
  private readonly source: { readonly buf: string; readonly base: number };

  constructor(source: { readonly buf: string; readonly base: number }) {
    this.source = source;
  }

  at(index: number): Position {
    if (index < this.index) {
      this.index = this.anchorIndex;
      this.pos = this.anchorPos;
      this.crlfNext = this.anchorCrlf;
    }
    if (index === this.index) return this.pos;
    const { buf, base } = this.source;
    let { line, column } = this.pos;
    // Lines: count the newlines in between; the column restarts after the last.
    // (Both bounds clamp at 0, as `indexOf` does for a negative start.)
    const from = Math.max(0, this.index - base);
    const between = buf.slice(from, Math.max(from, index - base));
    const last = between.lastIndexOf("\n");
    if (last !== -1) line += between.split("\n").length - 1;
    column = last === -1 ? column + (index - this.index) : index - base - (from + last);
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
  private state: LexState = DATA;
  private readonly grammars: Grammars;
  private readonly positions: Positions = new Positions(this);

  /**
   * When set by a coupled tree builder, raw-text/rcdata/plaintext elements are
   * NOT switched into their raw tokenizer state (used inside foreign content).
   */
  suppressRawText = false;

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
    // SAFETY: a grammar's `step` returns its `Step` value or the `Input.Fail`
    // sentinel; the parser's `unknown`-typed entry point loses that.
    const step = this.grammar().step(state) as Step | Input.Fail;
    if (step === Input.Fail) {
      if (state.mode === "Incomplete" && !this.ended) {
        this.retryAt = this.buf.length + 1 + ((this.buf.length - start) >> 1);
        return null;
      }
      this.failed = true;
      return [{ _tag: "Fault", error: this.toError(state) }];
    }
    this.positions.anchor(this.base + start);
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
    state.pos = pos;
    state.partial = !this.ended;
    state.mode = "Backtrack";
    state.hintOffset = -1;
    state.hintExpected = [];
    state.deepest = undefined;
    state.depth = 0;
    return state;
  }
  private state_: Input.State<string> | undefined = undefined;

  private drain(): ReadonlyArray<LexOutput> {
    return Arr.unfold(undefined, () =>
      Option.map(Option.fromNullishOr(this.pull()), (outs) => [outs, undefined] as const),
    ).flat();
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
      Option.map(HashMap.get(RAW_KINDS, name), (kind) => {
        this.state = kind === "plaintext" ? PLAINTEXT : LexState.Raw({ name, kind });
      });
    }
  }

  // --- output --------------------------------------------------------------

  private at(index: number): Position {
    return this.positions.at(this.base + index);
  }

  private span(t: { readonly start: number; readonly end: number }): Span {
    return { start: this.at(t.start), end: this.at(t.end) };
  }

  private event(t: Tok): LexEvent {
    return matchTok(t, this.toEvent);
  }

  /** The grammar for each tokenizer state; built once per lexer. */
  private readonly grammarFor = {
    Data: () => this.grammars.data,
    Raw: ({ name, kind }: Extract<LexState, { _tag: "Raw" }>) => this.grammars.raw(name, kind),
    Plaintext: () => this.grammars.plaintext,
  };

  /** The output event for each token kind; built once per lexer. */
  private readonly toEvent = {
    StartElement: (t: Extract<Tok, { _tag: "StartElement" }>): LexEvent => {
      const start = this.at(t.start);
      const attributes = t.attributes.map((a) => ({
        name: a.name,
        value: a.value,
        span: this.span(a),
      }));
      return {
        _tag: "StartElement",
        name: t.name,
        attributes,
        selfClosing: t.selfClosing,
        span: { start, end: this.at(t.end) },
      };
    },
    EndElement: (t: Extract<Tok, { _tag: "EndElement" }>): LexEvent => ({
      _tag: "EndElement",
      name: t.name,
      span: this.span(t),
    }),
    Text: (t: Extract<Tok, { _tag: "Text" }>): LexEvent => ({
      _tag: "Text",
      data: t.data,
      span: this.span(t),
    }),
    CData: (t: Extract<Tok, { _tag: "CData" }>): LexEvent => ({
      _tag: "CData",
      data: t.data,
      span: this.span(t),
    }),
    Comment: (t: Extract<Tok, { _tag: "Comment" }>): LexEvent => ({
      _tag: "Comment",
      data: t.data,
      span: this.span(t),
    }),
    ProcessingInstruction: (t: Extract<Tok, { _tag: "ProcessingInstruction" }>): LexEvent => ({
      _tag: "ProcessingInstruction",
      target: t.target,
      data: t.data,
      span: this.span(t),
    }),
    Doctype: (t: Extract<Tok, { _tag: "Doctype" }>): LexEvent => ({
      _tag: "Doctype",
      name: t.name,
      publicId: t.publicId,
      systemId: t.systemId,
      internalSubset: t.internalSubset,
      span: this.span(t),
    }),
    XmlDeclaration: (t: Extract<Tok, { _tag: "XmlDeclaration" }>): LexEvent => ({
      _tag: "XmlDeclaration",
      version: t.version,
      encoding: t.encoding,
      standalone: t.standalone,
      span: this.span(t),
    }),
    EntityReference: (t: Extract<Tok, { _tag: "EntityReference" }>): LexEvent => ({
      _tag: "EntityReference",
      name: t.name,
      span: this.span(t),
    }),
  };

  /** The typed error for a failed (XML) token. */
  private toError(state: Input.State<string>): LexError | LimitExceeded {
    const failure = state.reportedFailure();
    const at = failure.offset;
    this.positions.anchor(this.base + this.cursor);
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
    const cp = this.buf.codePointAt(at);
    const char = cp === undefined ? "" : String.fromCodePoint(cp);
    if (issue !== undefined)
      return new UnexpectedCharacter({ char, position: this.at(at), context: issue.context });
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
