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
import { absurd } from "effect/Function";
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
import { LazyPosition, LazySpan, LineIndex } from "./position.ts";
import {
  type Context,
  Fallback,
  Incomplete,
  NAME_SLOTS,
  NO_SPAN,
  Reused,
  freshMarks,
  resetMarks,
  scanXml,
} from "./scan.ts";
import { declarationContexts } from "./declarations.ts";
import { type AttrName, type TagName, unsafeAttrName, unsafeTagName } from "../Name.ts";
import { drive } from "./drive.ts";
import { quote } from "./quote.ts";
import type { Dtd } from "./dtd.ts";
import { hasAsciiNames } from "./entities.ts";
import { grammars, type Grammars, Issue, type RawKind, type Tok } from "./tokens.ts";

// -----------------------------------------------------------------------------
// Output model
// -----------------------------------------------------------------------------

interface LexAttribute {
  readonly name: AttrName;
  readonly value: string;
  readonly span: Span;
}

export type LexEvent =
  | {
      readonly _tag: "StartElement";
      readonly name: TagName;
      readonly attributes: ReadonlyArray<LexAttribute>;
      readonly selfClosing: boolean;
      readonly span: Span;
    }
  | { readonly _tag: "EndElement"; readonly name: TagName; readonly span: Span }
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
      readonly forceQuirks: boolean;
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
const isCharIssue = Issue.$is("Char");

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface LexerOptions {
  /** `"xml"` is strict (unknown entities / malformed markup are faults); `"html"` recovers. */
  readonly mode: "xml" | "html";
  /** Named entity table. */
  readonly entities: Record<string, string>;
  /**
   * Declared entities, for XML with `dtd: "internal"`. The lexer reads with
   * the grammars without a DTD (and the scanner) until one declares a
   * general entity (see {@link Lexer.afterDoctype}).
   */
  readonly dtd?: Dtd;
  /**
   * With {@link dtd}: read with the DTD-aware grammars from the first token,
   * whatever the DTD declares, as before #99. Only the tests set it, to
   * check that reading without them until a declaration changes nothing.
   */
  readonly eagerDtd?: boolean;
  /**
   * XML: the input is content (an entity's replacement text), not a
   * document, so references and CDATA sections may appear at its top level.
   */
  readonly content: boolean;
  /**
   * HTML: the scripting flag. When set, `<noscript>` content is raw text, as
   * a browser with scripting enabled reads it.
   */
  readonly scripting?: boolean;
  /**
   * Whether events have positions (default `true`); without, every span is
   * the origin. Faults keep theirs (see {@link Lexer.tokenPosition}).
   */
  readonly positions?: boolean;
  /**
   * Reuse the scanner's events (see `Context.reuse`; only without
   * positions): for a caller that is done with each event before it reads
   * the next.
   */
  readonly reuse?: boolean;
  /**
   * XML: recover where the strict grammars fail at a `<` or `&` that starts
   * nothing, an unquoted or valueless attribute, or markup out of place at
   * the top level (see `tokens.ts` and {@link Lexer.placed}). What strict XML
   * reads is read the same; characters XML does not allow still fail.
   */
  readonly recover?: boolean;
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
export const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;
const DATA: LexState = LexState.Data();
const PLAINTEXT: LexState = LexState.Plaintext();
const RCDATA_TO_END: LexState = LexState.RcdataToEnd();

// -----------------------------------------------------------------------------
// Positions
// -----------------------------------------------------------------------------

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

/**
 * Positions of indices into the (CRLF-normalized) input. The `offset` is
 * computed here: it counts raw UTF-16 units, so each collapsed `\r\n` adds
 * one. The line and column are left to the {@link LineIndex}, resolved only
 * when read. Queries are expected to move forward; one behind the last falls
 * back to the anchor (the start of the current token).
 */
class Positions {
  /** Absolute indices of `\n`s that were `\r\n` in the raw input, ascending. */
  readonly crlf: Array<number> = [];
  /** Every line break of the input, for the positions' lines and columns. */
  readonly lines: LineIndex = new LineIndex();
  private anchorIndex = 0;
  private anchorOffset = 0;
  private anchorCrlf = 0;
  private index = 0;
  private offset = 0;
  private crlfNext = 0;

  /** The raw offset of absolute (normalized) index `index`. */
  offsetAt(index: number): number {
    if (index < this.index) {
      this.index = this.anchorIndex;
      this.offset = this.anchorOffset;
      this.crlfNext = this.anchorCrlf;
    }
    if (index === this.index) return this.offset;
    // One per character, plus one per collapsed CRLF.
    const k = crlfBound(this.crlf, this.crlfNext, index);
    this.offset += index - this.index + (k - this.crlfNext);
    this.index = index;
    this.crlfNext = k;
    return this.offset;
  }

  at(index: number): Position {
    return new LazyPosition(this.offsetAt(index), index, this.lines);
  }

  /** The span of absolute indices `[start, end)`. */
  span(start: number, end: number): Span {
    const startOffset = this.offsetAt(start);
    return new LazySpan(this.lines, startOffset, start, this.offsetAt(end), end);
  }

  /** Make `index` (the start of a token) the point to fall back to. */
  anchor(index: number): void {
    this.anchorOffset = this.offsetAt(index);
    this.anchorIndex = index;
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
  /** XML: whether the prolog is over (a start tag or a DOCTYPE has been read), so no DOCTYPE may follow. */
  private prologEnded = false;
  /** XML: why the last token {@link misplaced} looked at is not well-formed. */
  private misplacement: Option.Option<InvalidDocumentStructure> = Option.none();
  private grammars: Grammars;
  /**
   * XML with a DTD: whether the DTD-aware grammars are on. They are off
   * while nothing is declared (see {@link afterDoctype}).
   */
  private dtdOn: boolean;
  /** XML with a DTD, its grammars off: a DOCTYPE has just been read, so look at the DTD before the next token. */
  private doctypeRead = false;
  private readonly positions: Positions = new Positions();

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

  /** Whether {@link scanXml} reads the data state's tokens (XML, the DTD-aware grammars off). */
  private scans: boolean;

  /** XML: whether to recover (see {@link LexerOptions.recover}). */
  private readonly recover: boolean;

  constructor(options: LexerOptions) {
    this.options = options;
    const dtd = options.dtd;
    // An empty DTD reads as none, unless the entity table has a name the
    // grammars without a DTD don't read (see `hasAsciiNames`).
    this.dtdOn =
      dtd !== undefined &&
      (options.eagerDtd === true || dtd.declaresEntities || !hasAsciiNames(options.entities));
    this.scans = options.mode === "xml" && !this.dtdOn;
    this.recover = options.mode === "xml" && options.recover === true;
    this.scanner = {
      entities: options.entities,
      recover: this.recover,
      span: (from, to) => this.positions.span(this.base + from, this.base + to),
      positions: options.positions ?? true,
      reuse: options.reuse === true && options.positions === false,
      end: 0,
      count: 0,
      inside: false,
      names: Arr.allocate<Context["names"][number]>(NAME_SLOTS),
      reused: new Reused(),
      marks: freshMarks(),
    };
    this.grammars = grammars(options.mode, options.entities, this.dtdOn, this.recover);
  }

  /**
   * XML with a DTD, read so far without its grammars: after a DOCTYPE (once
   * the SAX layer has read its internal subset, before the next token),
   * switch them on if it declares a general entity. Until then the DTD
   * changes nothing the grammars read: no name is declared, so no reference
   * resolves through it and none has markup in it, and the entity table's
   * names read the same either way. Nothing but a DOCTYPE declares anything,
   * and there is at most one, before the root element.
   */
  private afterDoctype(): void {
    this.doctypeRead = false;
    const dtd = this.options.dtd;
    if (dtd === undefined || !dtd.declaresEntities) return;
    this.dtdOn = true;
    this.scans = false;
    this.grammars = grammars(this.options.mode, this.options.entities, true, this.recover);
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
    this.positions.lines.record(s, this.base + this.buf.length);
    this.buf += s;
    resetMarks(this.scanner.marks);
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
    const ev = this.scanned();
    if (ev === null) return null;
    return ev === undefined ? this.parse() : [ev];
  }

  /**
   * The next token as the scanner reads it: its event, `null` when no token
   * can be read yet (or ever, after the end), or `undefined` when the
   * grammar reads it (see {@link scan}; always, with the scanner off).
   */
  private scanned(): LexEvent | null | undefined {
    if (this.failed || this.cursor >= this.buf.length) return null;
    if (!this.ended && this.buf.length < this.retryAt) return null;
    if (this.doctypeRead) this.afterDoctype();
    // (A DOCTYPE may have switched the scanner off.)
    return this.scans ? this.scan() : undefined;
  }

  /** Lex the next token with the grammar (see {@link pull}). */
  private parse(): ReadonlyArray<LexOutput> | null {
    const start = this.cursor;
    this.tokenStart = start;
    const state = this.parseState(start);
    // The `dtd: "internal"` grammars are shared: point them at this document's DTD.
    const dtd = this.options.dtd;
    if (dtd !== undefined && this.dtdOn) this.grammars.dtd.current = dtd;
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
    if (this.recover) return this.accept(state.pos, step.filter(this.placed));
    if (this.options.mode === "xml" && step.some(this.misplaced)) {
      this.failed = true;
      // `misplaced` recorded why.
      return Arr.fromOption(
        Option.map(this.misplacement, (error): LexFault => ({ _tag: "Fault", error })),
      );
    }
    return this.accept(state.pos, step);
  }

  /** Take in the tokens of a step that ends at buffer index `end`: their events. */
  private accept(end: number, step: ReadonlyArray<Tok>): ReadonlyArray<LexOutput> {
    this.cursor = end;
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
  pullEach(f: (output: LexOutput) => boolean, full?: () => boolean): boolean {
    if (!this.scans) return drive(() => this.pull(), f, full);
    // The scanned tokens one by one, without a batch each.
    for (;;) {
      const more = this.next(f);
      if (more !== true) return more === null;
      if (full !== undefined && full()) return false;
    }
  }

  /**
   * Hand the next token's outputs to `f`: whether it took them all, or
   * `null` when no token can be read yet.
   */
  private next(f: (output: LexOutput) => boolean): boolean | null {
    const ev = this.scanned();
    if (ev === null) return null;
    if (ev !== undefined) return f(ev);
    // (The scanner has had its turn.)
    const batch = this.parse();
    return batch === null ? null : batch.every(f);
  }

  /**
   * XML without a DTD: read the token at the cursor with {@link scanXml}.
   * Returns its event, `null` when the token is incomplete, or `undefined`
   * when the grammar reads it instead (other markup, every error, and text
   * outside the root element, where a reference is misplaced).
   */
  private scan(): LexEvent | null | undefined {
    const start = this.cursor;
    const inside = this.depth > 0 || this.options.content;
    if (!inside && this.buf.charCodeAt(start) !== 60) return undefined;
    this.scanner.inside = inside;
    // Offsets are computed forwards from the token's start.
    this.tokenStart = start;
    if (this.scanner.positions) this.positions.anchor(this.base + start);
    const ev = scanXml(this.buf, start, !this.ended, this.scanner);
    if (ev === Incomplete) {
      this.retryAt = this.buf.length + 1 + ((this.buf.length - start) >> 1);
      return null;
    }
    if (ev === Fallback) return undefined;
    const end = this.scanner.end;
    // The grammar reports a forbidden character the token takes in.
    if (this.forbidden !== -1 && this.forbidden < this.base + end) return undefined;
    // `misplaced`, for the tokens the scanner reads.
    if (ev._tag === "StartElement") {
      if (!ev.selfClosing) this.depth++;
      this.prologEnded = true;
    } else if (ev._tag === "EndElement" && this.depth > 0) this.depth--;
    this.cursor = end;
    this.retryAt = 0;
    this.compact();
    return ev;
  }

  /** What {@link scanXml} reads with. */
  private readonly scanner: Context;

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
    resetMarks(this.scanner.marks);
    // Without positions in events, nothing has computed the offsets up to
    // here: compute them before the CRLF records that tell them go.
    if (!this.scanner.positions) this.positions.anchor(this.base + index);
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
    if (t._tag === "Doctype") {
      // A DOCTYPE that is kept (one that is out of place is a fault, or
      // dropped when recovering): see `afterDoctype`.
      if (!this.dtdOn && this.options.dtd !== undefined) this.doctypeRead = true;
    } else if (isEndTag(t)) {
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
   * element there may be no references or CDATA sections. A document type
   * declaration belongs to the prolog: at most one, before the root element.
   * Records why in
   * {@link misplacement}, and counts the open elements as it goes.
   */
  // A `switch` and a method built once: this runs once per XML token.
  private readonly misplaced = (t: Tok): boolean => {
    switch (t._tag) {
      case "StartElement":
        if (!t.selfClosing) this.depth++;
        this.prologEnded = true;
        return false;
      case "EndElement":
        if (this.depth > 0) this.depth--;
        return false;
      case "Doctype":
        // Replacement text (`content`) takes no declarations at all; the
        // entity expansion reports that.
        if (!this.options.content && this.prologEnded) {
          return this.misplace(
            t.start,
            "a document type declaration is only allowed once, in the prolog before the root element",
          );
        }
        this.prologEnded = true;
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

  /**
   * XML, recovering: whether to keep `t`, as {@link misplaced} would accept
   * it and further. References and CDATA sections outside the root element
   * are kept, for the tree builder to place (it puts character data before
   * the root in a synthesized one, and after it under the root). An XML
   * declaration anywhere but at the very start, and a document type
   * declaration after the first or after the root element's start, are
   * dropped: XML5 reads a late `<?xml …?>` as a processing instruction, but
   * the `xml` target is reserved (§2.6), and the first declaration is the
   * document's.
   */
  // A `switch` and a method built once, as `misplaced`.
  private readonly placed = (t: Tok): boolean => {
    switch (t._tag) {
      case "StartElement":
      case "EndElement":
        return !this.misplaced(t);
      case "Doctype":
        if (this.prologEnded) return false;
        this.prologEnded = true;
        return true;
      case "XmlDeclaration":
        return this.base + t.start === 0;
      default:
        return true;
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
    return this.scanner.positions
      ? this.positions.span(this.base + t.start, this.base + t.end)
      : NO_SPAN;
  }

  /** Buffer index of the start of the last token read. */
  private tokenStart = 0;

  /**
   * Where the last token read starts: what a failure found in its event
   * (a resource limit) points at when events have no positions.
   */
  tokenPosition(): Position {
    return this.at(this.tokenStart);
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
        // The tag's start offset first: offsets are computed moving forward.
        const start = this.positions.offsetAt(this.base + t.start);
        const attributes = t.attributes.map((a): LexAttribute => ({
          name: unsafeAttrName(a.name),
          value: a.value,
          span: this.span(a),
        }));
        return {
          name: unsafeTagName(t.name),
          attributes,
          selfClosing: t.selfClosing,
          span: this.scanner.positions
            ? new LazySpan(
                this.positions.lines,
                start,
                this.base + t.start,
                this.positions.offsetAt(this.base + t.end),
                this.base + t.end,
              )
            : NO_SPAN,
          _tag: "StartElement",
        };
      }
      case "EndElement":
        return { name: unsafeTagName(t.name), span: this.span(t), _tag: "EndElement" };
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
          forceQuirks: t.forceQuirks,
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
      default:
        // Unreachable (the cases above are exhaustive); it keeps every path
        // returning a value, and a new tag a compile error.
        return absurd(t);
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
    // Every grammar here fails with an `Issue` (its error type `P<A>`); the
    // parse state's failure record stores causes as `unknown`.
    const issue: unknown = failure.hasCause ? failure.cause : undefined;
    if (isEntityIssue(issue) && issue.limit !== undefined) {
      return new LimitExceeded({
        limit: issue.limit.name,
        max: issue.limit.max,
        position: Option.some(this.at(issue.offset)),
      });
    }
    if (isEntityIssue(issue)) {
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
    if (isCharIssue(issue)) {
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
