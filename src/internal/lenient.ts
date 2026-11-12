/**
 * Lenient XML reading: one pass over complete input, with the checks the
 * strict path makes left out.
 *
 * This is the engine of `strict: false` (`Sax.forEach`, `Xml.parsePlain`).
 * It reads what a well-formed document has (text, start and end tags,
 * comments, CDATA sections, processing instructions, and through the token
 * grammar the XML declaration and DOCTYPE) and hands each to a
 * {@link Visitor}, the way the strict lexer would: on well-formed input the
 * two agree exactly (`tests/lenient.test.ts`). What it does not do is check:
 * names are whatever runs to the next delimiter, an unknown or malformed
 * reference is left as written, duplicate attributes, characters XML forbids,
 * `<` in attribute values and `]]>` in text pass, and of the resource limits
 * only `maxTotalBytes` and `maxDepth` apply. Markup it cannot read at all (a
 * tag without its `>`, an unquoted attribute value) fails, with a position
 * computed then. There are no positions otherwise.
 */
import { Input, Parser } from "@thomasfosterau/effect-parse";
import * as Option from "effect/Option";
import {
  LimitExceeded,
  type SaxError,
  UnexpectedCharacter,
  UnexpectedEndOfInput,
} from "../Error.ts";
import type { Limits } from "../Limits.ts";
import { origin, type Position } from "../Position.ts";
import { unsafeAttrName, unsafeTagName } from "../Name.ts";
import type { Attribute, ResolvedOptions, SaxEvent } from "../Sax.ts";
import { doctypeEvent, endElement, startElement, xmlDeclarationEvent } from "./convert.ts";
import { LazyPosition, LineIndex } from "./position.ts";
import { namedReference, NO_SPAN, numericReference, type Ref, Reused } from "./scan.ts";
import { grammars, type Tok } from "./tokens.ts";

/** The XML declaration and DOCTYPE tokens, as the grammar reads them. */
export type DeclarationTok = Extract<Tok, { readonly _tag: "XmlDeclaration" | "Doctype" }>;

/**
 * What a lenient pass hands what it reads to. Each step returns its failure
 * or `null`; `at` is the offset of the token, for a failure's position (see
 * {@link positionAt}). A start tag's attributes are the first `count` of
 * {@link Attributes}.
 */
export interface Visitor {
  start(
    name: string,
    attributes: Attributes,
    count: number,
    selfClosing: boolean,
    at: number,
  ): SaxError | null;
  end(name: string, at: number): SaxError | null;
  text(data: string, at: number): SaxError | null;
  cdata(data: string, at: number): SaxError | null;
  comment(data: string, at: number): SaxError | null;
  pi(target: string, data: string, at: number): SaxError | null;
  declaration(tok: DeclarationTok, at: number): SaxError | null;
}

/** The attributes of the start tag being read, by index (rewritten for each tag). */
export interface Attributes {
  readonly names: Array<string>;
  readonly values: Array<string>;
}

/** What a lenient pass reads with. */
export interface LenientOptions {
  readonly entities: Record<string, string>;
  readonly limits: Limits;
}

/** The position of `offset` in `input`, counted when a failure needs it. */
export const positionAt = (input: string, offset: number): Position => {
  let line = 1;
  let lineStart = 0;
  for (let nl = input.indexOf("\n"); nl !== -1 && nl < offset; nl = input.indexOf("\n", nl + 1)) {
    line++;
    lineStart = nl + 1;
  }
  return { offset, line, column: offset - lineStart + 1 };
};

const GT = 62;
const SLASH = 47;
const EQ = 61;
const QUOT = 34;
const APOS = 39;
const BANG = 33;
const QUESTION = 63;

/** Whitespace as the tag grammars skip it (`\r` never reaches a pass). */
const isWs = (c: number): boolean => c === 32 || c === 10 || c === 9 || c === 12;

/** Characters that end a name: whitespace, `/`, `>` and `=`. */
const DELIMITERS = /*#__PURE__*/ (() => {
  const t = new Uint8Array(128);
  for (const c of [32, 10, 9, 12, SLASH, GT, EQ]) t[c] = 1;
  return t;
})();

/** Does `c` end a name (a delimiter, or the end of the input)? */
const endsName = (c: number): boolean => (c < 128 && DELIMITERS[c] === 1) || Number.isNaN(c);

/**
 * Decode the predefined and numeric references in `s`, leaving any other
 * `&` as it is.
 */
const decodeLeniently = (s: string, entities: Record<string, string>): string => {
  let i = s.indexOf("&");
  if (i === -1) return s;
  const ref: Ref = { end: 0 };
  let out = "";
  let last = 0;
  for (; i !== -1; i = s.indexOf("&", i + 1)) {
    const decoded =
      s.charCodeAt(i + 1) === 35 /* # */
        ? numericReference(s, i, ref)
        : namedReference(s, i, entities, ref);
    if (decoded === undefined) continue;
    out += s.slice(last, i) + decoded;
    last = ref.end;
    i = ref.end - 1;
  }
  return out + s.slice(last);
};

/** A lenient pass's failure to read markup at `at`. */
const unreadable = (input: string, at: number, context: string): SaxError =>
  at >= input.length
    ? new UnexpectedEndOfInput({ position: positionAt(input, input.length), context })
    : new UnexpectedCharacter({
        char: input.charAt(at),
        position: positionAt(input, at),
        context,
      });

/** One lenient pass's state over its input. */
class Pass {
  private readonly attributes: Attributes = { names: [], values: [] };
  private depth = 0;
  private readonly data: ReturnType<typeof grammars>["data"];
  private readonly input: string;
  private readonly visitor: Visitor;
  private readonly options: LenientOptions;

  constructor(input: string, visitor: Visitor, options: LenientOptions) {
    this.input = input;
    this.visitor = visitor;
    this.options = options;
    this.data = grammars("xml", options.entities, false).data;
  }

  run(): SaxError | null {
    const { input } = this;
    const n = input.length;
    let i = 0;
    while (i < n) {
      const lt = input.indexOf("<", i);
      const to = lt === -1 ? n : lt;
      if (to > i) {
        const failure = this.text(i, to);
        if (failure !== null) return failure;
      }
      if (lt === -1) return null;
      const next = this.markup(lt);
      if (next < 0) return this.failure;
      i = next;
    }
    return null;
  }

  /** The text `input[i, to)`, its references decoded, to the visitor. */
  private text(i: number, to: number): SaxError | null {
    const { input } = this;
    // The next `&`, searched for once per occurrence rather than per run.
    if (this.amp < i) {
      const amp = input.indexOf("&", i);
      this.amp = amp === -1 ? input.length : amp;
    }
    const raw = input.slice(i, to);
    return this.visitor.text(this.amp < to ? decodeLeniently(raw, this.options.entities) : raw, i);
  }

  /** Where the next `&` is (from where it was last looked for), or the input's length. */
  private amp = -1;

  /** Why {@link markup} returned -1. */
  private failure: SaxError | null = null;

  private fail(failure: SaxError): number {
    this.failure = failure;
    return -1;
  }

  /** The markup at `lt` (a `<`): where it ends, or -1 with {@link failure} set. */
  private markup(lt: number): number {
    const c = this.input.charCodeAt(lt + 1);
    if (c === SLASH) return this.endTag(lt);
    if (c === BANG) return this.bang(lt);
    if (c === QUESTION) return this.question(lt);
    return this.startTag(lt);
  }

  private step(failure: SaxError | null, end: number): number {
    return failure === null ? end : this.fail(failure);
  }

  private endTag(lt: number): number {
    const { input } = this;
    let i = lt + 2;
    while (!endsName(input.charCodeAt(i))) i++;
    const name = input.slice(lt + 2, i);
    while (isWs(input.charCodeAt(i))) i++;
    if (name === "" || input.charCodeAt(i) !== GT) {
      return this.fail(unreadable(input, i, "reading an end tag"));
    }
    if (this.depth > 0) this.depth--;
    return this.step(this.visitor.end(name, lt), i + 1);
  }

  private startTag(lt: number): number {
    const { input } = this;
    let i = lt + 1;
    while (!endsName(input.charCodeAt(i))) i++;
    const name = input.slice(lt + 1, i);
    if (name === "") return this.fail(unreadable(input, i, "reading a start tag"));
    let count = 0;
    for (;;) {
      while (isWs(input.charCodeAt(i))) i++;
      const c = input.charCodeAt(i);
      if (c === GT || (c === SLASH && input.charCodeAt(i + 1) === GT)) {
        return this.opened(name, count, c === SLASH, lt, i);
      }
      const after = this.attribute(i, count);
      if (after < 0) return -1;
      count++;
      i = after;
    }
  }

  /** A start tag read to its `>` (at `close`, or its `/>`): where it ends, or -1. */
  private opened(
    name: string,
    count: number,
    selfClosing: boolean,
    lt: number,
    close: number,
  ): number {
    const { maxDepth } = this.options.limits;
    if (!selfClosing && ++this.depth > maxDepth) {
      const position = positionAt(this.input, lt);
      return this.fail(
        new LimitExceeded({ limit: "maxDepth", max: maxDepth, position: Option.some(position) }),
      );
    }
    const failure = this.visitor.start(name, this.attributes, count, selfClosing, lt);
    return this.step(failure, selfClosing ? close + 2 : close + 1);
  }

  /** The attribute at `i`, as attribute `k` of the tag: where it ends, or -1. */
  private attribute(start: number, k: number): number {
    const { input, attributes } = this;
    let i = start;
    while (!endsName(input.charCodeAt(i))) i++;
    const name = input.slice(start, i);
    while (isWs(input.charCodeAt(i))) i++;
    if (name === "" || input.charCodeAt(i) !== EQ) {
      return this.fail(unreadable(input, i, "reading an attribute"));
    }
    i++;
    while (isWs(input.charCodeAt(i))) i++;
    const quote = input.charCodeAt(i);
    if (quote !== QUOT && quote !== APOS) {
      return this.fail(unreadable(input, i, "reading an attribute value"));
    }
    const close = this.valueEnd(i + 1, quote);
    if (close >= input.length) {
      return this.fail(unreadable(input, close, "reading an attribute value"));
    }
    attributes.names[k] = name;
    const raw = input.slice(i + 1, close);
    // Literal whitespace is a space (§3.3.3), then references are decoded.
    const value = this.spaced ? raw.replace(/[\t\n]/g, " ") : raw;
    attributes.values[k] = this.refs ? decodeLeniently(value, this.options.entities) : value;
    return close + 1;
  }

  /** Whether the last value {@link valueEnd} read has literal whitespace, or references. */
  private spaced = false;
  private refs = false;

  /** The closing `quote` of a value from `from` (one pass, noting what the value has in it). */
  private valueEnd(from: number, quote: number): number {
    const { input } = this;
    this.spaced = false;
    this.refs = false;
    let i = from;
    for (; i < input.length; i++) {
      const c = input.charCodeAt(i);
      if (c === quote) return i;
      if (c === 9 || c === 10) this.spaced = true;
      else if (c === 38 /* & */) this.refs = true;
    }
    return i;
  }

  /** `<!--…-->`, `<![CDATA[…]]>` or the DOCTYPE. */
  private bang(lt: number): number {
    const { input } = this;
    if (input.startsWith("<!--", lt)) {
      const close = input.indexOf("-->", lt + 4);
      if (close === -1) return this.fail(unreadable(input, input.length, "reading a comment"));
      return this.step(this.visitor.comment(input.slice(lt + 4, close), lt), close + 3);
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const close = input.indexOf("]]>", lt + 9);
      if (close === -1) {
        return this.fail(unreadable(input, input.length, "reading a CDATA section"));
      }
      return this.step(this.visitor.cdata(input.slice(lt + 9, close), lt), close + 3);
    }
    return this.declaration(lt);
  }

  /** The XML declaration, or a processing instruction. */
  private question(lt: number): number {
    const { input } = this;
    if (input.startsWith("<?xml", lt)) {
      const c = input.charCodeAt(lt + 5);
      if (isWs(c) || c === QUESTION) return this.declaration(lt);
    }
    let i = lt + 2;
    while (!endsName(input.charCodeAt(i)) && input.charCodeAt(i) !== QUESTION) i++;
    const target = input.slice(lt + 2, i);
    let from = i;
    while (isWs(input.charCodeAt(from))) from++;
    const close = input.indexOf("?>", from);
    if (target === "" || close === -1) {
      return this.fail(unreadable(input, i, "reading a processing instruction"));
    }
    return this.step(this.visitor.pi(target, input.slice(from, close), lt), close + 2);
  }

  /** The XML declaration or DOCTYPE, read by the token grammar. */
  private declaration(lt: number): number {
    const state = new Input.State(this.input, { partial: false, offset: lt });
    const step = Parser.run(this.data, state);
    const tok = step === Input.Fail ? undefined : step[0];
    if (tok === undefined || (tok._tag !== "XmlDeclaration" && tok._tag !== "Doctype")) {
      return this.fail(unreadable(this.input, lt, "reading a markup declaration"));
    }
    return this.step(this.visitor.declaration(tok, lt), state.pos);
  }
}

/**
 * Read complete `input` leniently, handing what it holds to `visitor`.
 * Returns the first failure, the pass's or the visitor's.
 */
export const readLeniently = (
  input: string,
  visitor: Visitor,
  options: LenientOptions,
): SaxError | null => {
  if (input.length > options.limits.maxTotalBytes) {
    const max = options.limits.maxTotalBytes;
    return new LimitExceeded({ limit: "maxTotalBytes", max, position: Option.some(origin) });
  }
  // Line ends as the strict lexer has them.
  const text = input.indexOf("\r") === -1 ? input : input.replace(/\r\n?/g, "\n");
  return new Pass(text, visitor, options).run();
};

/** Text under a whitespace policy (as `Sax`'s conversion has it); `null` drops it. */
export const policy = (
  data: string,
  whitespace: "preserve" | "collapse",
  dropWhitespaceOnlyText: boolean,
): string | null => {
  if (whitespace === "preserve" && !dropWhitespaceOnlyText) return data;
  const out = whitespace === "collapse" ? data.replace(/\s+/g, " ").trim() : data;
  return dropWhitespaceOnlyText && /^\s*$/.test(out) ? null : out;
};

/** The attributes of the tags with none (never written to: events are read-only). */
const NO_ATTRIBUTES: ReadonlyArray<Attribute> = [];

/** One lenient attribute as a SAX attribute, without positions. */
const attribute = (attributes: Attributes, k: number): Attribute => ({
  // SAFETY: lenient reading (`strict: false`) does not check names: the
  // caller has asked for whatever the document spells.
  name: unsafeAttrName(attributes.names[k] ?? ""),
  value: attributes.values[k] ?? "",
  span: NO_SPAN,
});

/** A start tag's first `count` attributes, as an array of exactly that length. */
const attributeList = (attributes: Attributes, count: number): ReadonlyArray<Attribute> =>
  count === 1
    ? [attribute(attributes, 0)]
    : count === 2
      ? [attribute(attributes, 0), attribute(attributes, 1)]
      : Array.from({ length: count }, (_, k) => attribute(attributes, k));

/** Hands what a lenient pass reads to `f` as SAX events, without positions, until it fails. */
class SaxVisitor implements Visitor {
  private readonly f: (event: SaxEvent, position: () => Position) => SaxError | null;
  private readonly opts: ResolvedOptions;
  private readonly input: string;
  /** Where the token being handed over starts, in the CRLF-normalized text. */
  private offset = 0;
  /** The normalized text's line breaks, recorded on first use. */
  private lines: LineIndex | undefined = undefined;
  /** Where each CRLF collapsed, in the normalized text (its `\n`), ascending. */
  private crlf: Array<number> = [];

  /** Where the event being handed over starts (see `Sax.forEach`). */
  private readonly position = (): Position => {
    if (this.lines === undefined) this.lines = this.index();
    const index = this.offset;
    // The raw offset: one more for each CRLF collapsed before `index`.
    let lo = 0;
    let hi = this.crlf.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if ((this.crlf[mid] ?? index) < index) lo = mid + 1;
      else hi = mid;
    }
    return new LazyPosition(index + lo, index, this.lines);
  };

  /** The line breaks of the text as read (CR and CRLF normalized), and where CRLFs collapsed. */
  private index(): LineIndex {
    const raw = this.input;
    const lines = new LineIndex();
    if (raw.indexOf("\r") === -1) {
      lines.record(raw, 0);
      return lines;
    }
    for (let r = raw.indexOf("\r\n"); r !== -1; r = raw.indexOf("\r\n", r + 2)) {
      this.crlf.push(r - this.crlf.length);
    }
    lines.record(raw.replace(/\r\n?/g, "\n"), 0);
    return lines;
  }

  /** Hand `ev` (read at `at`) to `f`. */
  private emit(ev: SaxEvent, at: number): SaxError | null {
    this.offset = at;
    return this.f(ev, this.position);
  }

  /** With `reuse`: the events, rewritten for each tag (for an `f` done with each before it returns). */
  private readonly reused: Reused | undefined;

  constructor(
    input: string,
    f: (event: SaxEvent, position: () => Position) => SaxError | null,
    opts: ResolvedOptions,
    reuse: boolean,
  ) {
    this.input = input;
    this.f = f;
    this.opts = opts;
    this.reused = reuse ? new Reused() : undefined;
  }

  private reusedStart(
    reused: Reused,
    name: string,
    attributes: Attributes,
    count: number,
    selfClosing: boolean,
    at: number,
  ): SaxError | null {
    for (let k = 0; k < count; k++) {
      const a = reused.attributes[k];
      const n = attributes.names[k] ?? "";
      const v = attributes.values[k] ?? "";
      if (a === undefined) reused.attributes[k] = { name: n, value: v, span: NO_SPAN };
      else {
        a.name = n;
        a.value = v;
      }
    }
    const ev = reused.start;
    ev.name = name;
    ev.attributes =
      count === 0 ? NO_ATTRIBUTES : (reused.lists[count] ??= reused.attributes.slice(0, count));
    ev.selfClosing = selfClosing;
    return this.emit(startElement(ev), at);
  }

  start(
    name: string,
    attributes: Attributes,
    count: number,
    selfClosing: boolean,
    at: number,
  ): SaxError | null {
    const reused = this.reused;
    if (reused !== undefined) {
      return this.reusedStart(reused, name, attributes, count, selfClosing, at);
    }
    const list = count === 0 ? NO_ATTRIBUTES : attributeList(attributes, count);
    // SAFETY: as above, for the element's name.
    return this.emit(
      {
        name: unsafeTagName(name),
        attributes: list,
        selfClosing,
        span: NO_SPAN,
        _tag: "StartElement",
      },
      at,
    );
  }

  end(name: string, at: number): SaxError | null {
    const reused = this.reused;
    if (reused !== undefined) {
      reused.end.name = name;
      return this.emit(endElement(reused.end), at);
    }
    // SAFETY: as above.
    return this.emit({ name: unsafeTagName(name), span: NO_SPAN, _tag: "EndElement" }, at);
  }

  text(data: string, at: number): SaxError | null {
    const kept = policy(data, this.opts.whitespace, this.opts.dropWhitespaceOnlyText);
    return kept === null ? null : this.emit({ data: kept, span: NO_SPAN, _tag: "Text" }, at);
  }

  cdata(data: string, at: number): SaxError | null {
    return this.emit({ data, span: NO_SPAN, _tag: "CData" }, at);
  }

  comment(data: string, at: number): SaxError | null {
    return this.emit({ data, span: NO_SPAN, _tag: "Comment" }, at);
  }

  pi(target: string, data: string, at: number): SaxError | null {
    return this.emit({ target, data, span: NO_SPAN, _tag: "ProcessingInstruction" }, at);
  }

  declaration(tok: DeclarationTok, at: number): SaxError | null {
    return this.emit(
      tok._tag === "XmlDeclaration"
        ? xmlDeclarationEvent({ ...tok, span: NO_SPAN })
        : doctypeEvent({ ...tok, span: NO_SPAN }),
      at,
    );
  }
}

/** `Sax.forEach` with `strict: false`, over complete text. */
export const forEachLeniently = (
  input: string,
  f: (event: SaxEvent, position: () => Position) => void,
  opts: ResolvedOptions,
): SaxError | null =>
  readEventsLeniently(
    input,
    (event, position) => {
      f(event, position);
      return null;
    },
    opts,
  );

/**
 * The SAX events of complete text, read leniently, to `f` until it returns a
 * failure. With `reuse`, `f` must be done with each start and end tag's event
 * before it returns (see `LexerOptions.reuse`).
 */
export const readEventsLeniently = (
  input: string,
  f: (event: SaxEvent, position: () => Position) => SaxError | null,
  opts: ResolvedOptions,
  reuse = false,
): SaxError | null => readLeniently(input, new SaxVisitor(input, f, opts, reuse), opts);
