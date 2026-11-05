/**
 * A hand-written scanner for the commonest XML tokens: text, start tags and
 * end tags in the data state.
 *
 * The token grammars (`tokens.ts`) are the specification; this is an
 * optimisation of them for well-formed, ASCII-named markup, never a second
 * semantics. Where it returns a token, the grammar would return the same
 * token ending at the same offset; anything else it hands back to the
 * grammar ({@link Fallback}): other markup (`<!`, `<?`), names with other
 * characters than ASCII name characters, references other than the
 * predefined and numeric ones, and every error, so the grammar reports each
 * one as it always has. `tests/scan.test.ts` holds it to that.
 *
 * It runs on the per-token path, so it is plain loops over char codes with a
 * class table, and builds the lexer's events directly (in the shape
 * `Lexer.event` gives them), with positions from the lexer's `at`.
 */
import { origin, type Position, type Span } from "../Position.ts";
import { isXmlChar } from "./entities.ts";
import { invalidNameAt } from "./names.ts";
import type { LexEvent } from "./lexer.ts";

/** The input does not end the token yet (partial mode): try again with more. */
export const Incomplete = 0;
/** Not a token the scanner reads: run the grammar at the same offset. */
export const Fallback = 1;

export type ScanResult = LexEvent | typeof Incomplete | typeof Fallback;

/** What the scanner reads with, and where it reports the end of each token. */
export interface Context {
  /** The named entities (the predefined ones, or a replacement table). */
  readonly entities: Record<string, string>;
  /** The position of a buffer index (the lexer's position table). */
  readonly at: (index: number) => Position;
  /** Whether events have positions (without, every span is {@link NO_SPAN}). */
  readonly positions: boolean;
  /**
   * Whether to reuse the events (only without {@link positions}): each
   * token's is the scanner's own, rewritten by the next. For a caller that
   * is done with each event before it reads the next.
   */
  readonly reuse: boolean;
  /** The events {@link reuse} reuses. */
  readonly reused: Reused;
  /** Where the last token read ends, as a buffer index. */
  end: number;
  /** How many attributes the last start tag read has. */
  count: number;
  /**
   * Whether the cursor is inside the root element (or the input is content):
   * outside it a CDATA section is out of place, which the grammar reports.
   */
  inside: boolean;
  /** Names read recently (see {@link nameAt}). */
  readonly names: Array<string | undefined>;
  /**
   * For each of {@link NEEDLES}, where it next occurs in the buffer from
   * where it was last looked for (the buffer's length when it does not):
   * each is searched for once per occurrence rather than once per token.
   * Reset (see {@link resetMarks}) whenever the buffer changes.
   */
  readonly marks: Array<number>;
}

/** What {@link Context.marks} keeps track of. */
const NEEDLES = ["<", "&", "]]>"];
const M_LT = 0;
const M_AMP = 1;
const M_CDATA_END = 2;

/** Fresh {@link Context.marks}. */
export const freshMarks = (): Array<number> => NEEDLES.map(() => -1);

/** Forget the {@link Context.marks} (the buffer has changed). */
export const resetMarks = (marks: Array<number>): void => {
  marks.fill(-1);
};

/** Where needle `k` next occurs in `buf` at or after `from` (`buf.length` if nowhere). */
const mark = (buf: string, ctx: Context, k: number, from: number): number => {
  const at = ctx.marks[k] ?? -1;
  if (at >= from) return at;
  const found = buf.indexOf(NEEDLES[k] ?? "", from);
  const next = found === -1 ? buf.length : found;
  ctx.marks[k] = next;
  return next;
};

/** The span of every token read without {@link Context.positions}. */
export const NO_SPAN: Span = { start: origin, end: origin };

type Writable<T> = { -readonly [K in keyof T]: T[K] };
type Event<Tag extends LexEvent["_tag"]> = Writable<Extract<LexEvent, { readonly _tag: Tag }>>;
type Attribute = Writable<Event<"StartElement">["attributes"][number]>;

/** The span of `buf[from, to)`, or {@link NO_SPAN} without {@link Context.positions}. */
const spanOf = (ctx: Context, from: number, to: number): Span =>
  ctx.positions ? { start: ctx.at(from), end: ctx.at(to) } : NO_SPAN;

/** The events of a {@link Context.reuse} scanner, rewritten for each token. */
export class Reused {
  readonly text: Event<"Text"> = { data: "", span: NO_SPAN, _tag: "Text" };
  readonly end: Event<"EndElement"> = { name: "", span: NO_SPAN, _tag: "EndElement" };
  readonly start: Event<"StartElement"> = {
    name: "",
    attributes: [],
    selfClosing: false,
    span: NO_SPAN,
    _tag: "StartElement",
  };
  /** The attributes of a tag, by index. */
  readonly attributes: Array<Attribute> = [];
  /** Without {@link Context.reuse}: the attributes of the tag being read (copied into its event). */
  readonly pending: Array<Attribute> = [];
  /** For each count `n`, the first `n` of {@link attributes} (as a tag's list of them). */
  readonly lists: Array<ReadonlyArray<Attribute>> = [];
}

/** The size of {@link Context.names}. */
export const NAME_SLOTS = 256;

/**
 * The name `buf[from, to)`, as the same string as the last time it was read
 * where it can be: a document spells the same few names over and over, and
 * a repeated one costs no slice, and hashes (in a `Map` of names) as fast as
 * a string can.
 */
const nameAt = (buf: string, from: number, to: number, ctx: Context): string => {
  const slot =
    ((to - from) * 31 + buf.charCodeAt(from) + buf.charCodeAt(to - 1) * 7) & (NAME_SLOTS - 1);
  const known = ctx.names[slot];
  if (known !== undefined && known.length === to - from && buf.startsWith(known, from))
    return known;
  const name = buf.slice(from, to);
  ctx.names[slot] = name;
  return name;
};

// Character classes of the ASCII range.
const NAME_START = 1;
const NAME = 2;
const WS = 4;

const classes = /*#__PURE__*/ (() => {
  const t = new Uint8Array(128);
  for (let c = 0; c < 128; c++) {
    const ch = String.fromCharCode(c);
    t[c] =
      (/[A-Za-z_:]/.test(ch) ? NAME_START | NAME : 0) |
      (/[0-9.-]/.test(ch) ? NAME : 0) |
      (" \t\n\f\r".includes(ch) ? WS : 0);
  }
  return t;
})();

const LT = 60;
const GT = 62;
const SLASH = 47;
const EQ = 61;
const AMP = 38;
const TAB = 9;
const LF = 10;
const QUOT = 34;
const APOS = 39;
const BANG = 33;
const QUESTION = 63;

/** Is `c` (a char code) in the class? Non-ASCII is in none. */
const is = (c: number, cls: number): boolean => c < 128 && ((classes[c] ?? 0) & cls) !== 0;

/**
 * XML whitespace as the grammars skip it (`" \t\n\f\r"`; `\r` never reaches
 * the buffer).
 */
const isWs = (c: number): boolean => c < 128 && ((classes[c] ?? 0) & WS) !== 0;

/** The value of a (hexadecimal) digit, or -1. */
const digit = (c: number, hex: boolean): number =>
  c >= 48 && c <= 57
    ? c - 48
    : hex && c >= 97 && c <= 102
      ? c - 87
      : hex && c >= 65 && c <= 70
        ? c - 55
        : -1;

/** Is `c` an ASCII letter or digit (what the strict grammar reads as an entity name)? */
const isAlnum = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** Where the last reference {@link reference} decoded ends. */
interface Ref {
  end: number;
}

/** `&#…;` / `&#x…;` at `i`, to an XML `Char` (§4.1). */
const numericReference = (s: string, i: number, ref: Ref): string | undefined => {
  const hex = s.charCodeAt(i + 2) === 120; /* x */
  const digits = hex ? i + 3 : i + 2;
  let cp = 0;
  let j = digits;
  for (; j < s.length; j++) {
    const d = digit(s.charCodeAt(j), hex);
    if (d === -1) break;
    cp = cp * (hex ? 16 : 10) + d;
    // Out of range whatever follows: the grammar reports it.
    if (cp > 0x10ffff) return undefined;
  }
  if (j === digits || s.charCodeAt(j) !== 59 /* ; */ || !isXmlChar(cp)) return undefined;
  ref.end = j + 1;
  return String.fromCodePoint(cp);
};

/** `&name;` at `i`, from `entities`. */
const namedReference = (
  s: string,
  i: number,
  entities: Record<string, string>,
  ref: Ref,
): string | undefined => {
  let j = i + 1;
  while (j < s.length && isAlnum(s.charCodeAt(j))) j++;
  if (j === i + 1 || s.charCodeAt(j) !== 59 /* ; */) return undefined;
  const name = s.slice(i + 1, j);
  if (!Object.prototype.hasOwnProperty.call(entities, name)) return undefined;
  ref.end = j + 1;
  return entities[name];
};

/**
 * Decode the references in `s` the predefined way: `&name;` from `entities`
 * (an ASCII-alphanumeric name, as the strict grammar reads it) and `&#…;` /
 * `&#x…;` to an XML `Char`. `undefined` for anything else (an unknown or
 * malformed reference), which the grammar then reports.
 */
const decodeRefs = (s: string, entities: Record<string, string>): string | undefined => {
  const ref: Ref = { end: 0 };
  let out = "";
  let last = 0;
  for (let i = s.indexOf("&"); i !== -1; i = s.indexOf("&", last)) {
    const decoded =
      s.charCodeAt(i + 1) === 35 /* # */
        ? numericReference(s, i, ref)
        : namedReference(s, i, entities, ref);
    if (decoded === undefined) return undefined;
    out += s.slice(last, i) + decoded;
    last = ref.end;
  }
  return out + s.slice(last);
};

/** The end of the name characters from `i`. */
const skipName = (buf: string, i: number, end: number): number => {
  let j = i;
  while (j < end && is(buf.charCodeAt(j), NAME)) j++;
  return j;
};

/** Can `c` start a name as the tag grammars read one (any non-ASCII character can)? */
const startsName = (c: number): boolean => c >= 128 || is(c, NAME_START);

/**
 * The end of a name whose first character is at `i`, taking non-ASCII
 * characters in too. With `check`, -1 when one of those makes it no XML
 * `Name` (§2.3), as the grammar would find (a start tag's and attribute's
 * names are checked; an end tag's is matched against its start tag's).
 */
const wideName = (buf: string, i: number, end: number, check: boolean): number => {
  let j = i + 1;
  let wide = buf.charCodeAt(i) >= 128;
  for (; j < end; j++) {
    const c = buf.charCodeAt(j);
    if (c >= 128) wide = true;
    else if (!is(c, NAME)) break;
  }
  return wide && check && j < end && invalidNameAt(buf.slice(i, j)) !== -1 ? -1 : j;
};

/** The end of the whitespace from `i`. */
const skipWs = (buf: string, i: number, end: number): number => {
  let j = i;
  while (j < end && isWs(buf.charCodeAt(j))) j++;
  return j;
};

/**
 * Read one XML token at `pos` in the data state, with no DTD in play: text
 * up to the next `<`, a start tag or an end tag. `partial` is whether more
 * input may follow `buf`.
 */
export const scanXml = (buf: string, pos: number, partial: boolean, ctx: Context): ScanResult => {
  const end = buf.length;
  const c0 = buf.charCodeAt(pos);
  if (c0 !== LT) return text(buf, pos, partial, ctx);
  if (pos + 1 >= end) return partial ? Incomplete : Fallback;
  const c1 = buf.charCodeAt(pos + 1);
  if (c1 === SLASH) return endTag(buf, pos, partial, ctx);
  if (c1 === BANG) return declaration(buf, pos, ctx);
  if (c1 === QUESTION) return processingInstruction(buf, pos, ctx);
  return startTag(buf, pos, partial, ctx);
};

/** Text up to the next `<` (or the end of a complete input). */
const text = (buf: string, pos: number, partial: boolean, ctx: Context): ScanResult => {
  const to = mark(buf, ctx, M_LT, pos);
  if (to === buf.length && partial) return Incomplete;
  // A `]]>` in text is an error (§2.4); the grammar reports it.
  if (mark(buf, ctx, M_CDATA_END, pos) + 3 <= to) return Fallback;
  let data = buf.slice(pos, to);
  if (mark(buf, ctx, M_AMP, pos) < to) {
    const decoded = decodeRefs(data, ctx.entities);
    if (decoded === undefined) return Fallback;
    data = decoded;
  }
  ctx.end = to;
  if (ctx.reuse) {
    const ev = ctx.reused.text;
    ev.data = data;
    return ev;
  }
  return { data, span: spanOf(ctx, pos, to), _tag: "Text" };
};

/** `</name>` or `</name   >`. */
const endTag = (buf: string, pos: number, partial: boolean, ctx: Context): ScanResult => {
  const end = buf.length;
  if (pos + 2 >= end) return partial ? Incomplete : Fallback;
  if (!startsName(buf.charCodeAt(pos + 2))) return Fallback;
  const nameEnd = wideName(buf, pos + 2, end, false);
  const i = skipWs(buf, nameEnd, end);
  if (i >= end) return partial ? Incomplete : Fallback;
  if (buf.charCodeAt(i) !== GT) return Fallback;
  ctx.end = i + 1;
  const name = nameAt(buf, pos + 2, nameEnd, ctx);
  if (ctx.reuse) {
    const ev = ctx.reused.end;
    ev.name = name;
    return ev;
  }
  return { name, span: spanOf(ctx, pos, i + 1), _tag: "EndElement" };
};

// The other markup the scanner reads: comments, CDATA sections and
// processing instructions. Where one runs past the end of the buffer, the
// grammar reads it (and waits for more input, or reports the error).

/** A comment's (or with `cdata`, a CDATA section's) `data`, as an event from `pos` to `end`. */
const markupEvent = (
  ctx: Context,
  pos: number,
  end: number,
  data: string,
  cdata: boolean,
): ScanResult => {
  ctx.end = end;
  const span = spanOf(ctx, pos, end);
  return cdata ? { data, span, _tag: "CData" } : { data, span, _tag: "Comment" };
};

/**
 * `<!--…-->` (§2.5: no `--` before the end) or `<![CDATA[…]]>` (§2.7, inside
 * the root element). Anything else after `<!` is the grammar's.
 */
const declaration = (buf: string, pos: number, ctx: Context): ScanResult => {
  if (buf.startsWith("<!--", pos)) {
    const dashes = buf.indexOf("--", pos + 4);
    if (dashes === -1 || buf.charCodeAt(dashes + 2) !== GT) return Fallback;
    return markupEvent(ctx, pos, dashes + 3, buf.slice(pos + 4, dashes), false);
  }
  if (ctx.inside && buf.startsWith("<![CDATA[", pos)) {
    const close = buf.indexOf("]]>", pos + 9);
    if (close === -1) return Fallback;
    return markupEvent(ctx, pos, close + 3, buf.slice(pos + 9, close), true);
  }
  return Fallback;
};

/** XML's `S` (§2.3): unlike the tag grammars' whitespace, no form feed. */
const isS = (c: number): boolean => c === 32 || c === TAB || c === LF || c === 13;

/**
 * `<?target data?>` (§2.6), with an ASCII `Name` for a target other than
 * `xml` in any case (`xml` itself starts the XML declaration, the grammar's).
 */
const processingInstruction = (buf: string, pos: number, ctx: Context): ScanResult => {
  const end = buf.length;
  if (!is(buf.charCodeAt(pos + 2), NAME_START)) return Fallback;
  const targetEnd = skipName(buf, pos + 3, end);
  if (targetEnd >= end) return Fallback;
  const target = buf.slice(pos + 2, targetEnd);
  if (target.length === 3 && target.toLowerCase() === "xml") return Fallback;
  let from = targetEnd;
  while (from < end && isS(buf.charCodeAt(from))) from++;
  // Data only after whitespace; `?>` straight after the target ends it empty.
  if (from === targetEnd && !buf.startsWith("?>", from)) return Fallback;
  const close = buf.indexOf("?>", from);
  if (close === -1) return Fallback;
  ctx.end = close + 2;
  const data = buf.slice(from, close);
  const span = spanOf(ctx, pos, close + 2);
  return { target, data, span, _tag: "ProcessingInstruction" };
};

/** The attributes of a tag without any (never written to: events are read-only). */
const none: Array<Attribute> = [];

/** Not a number of {@link readAttributes} and {@link attributeAt}: incomplete input. */
const MORE = -1;
/** Not a number of {@link readAttributes} and {@link attributeAt}: the grammar's to read. */
const GRAMMAR = -2;

/** `<name attr="value" …>` or `/>`. */
const startTag = (buf: string, pos: number, partial: boolean, ctx: Context): ScanResult => {
  const end = buf.length;
  if (!startsName(buf.charCodeAt(pos + 1))) return Fallback;
  const nameEnd = wideName(buf, pos + 1, end, true);
  if (nameEnd === -1) return Fallback;
  if (nameEnd >= end) return partial ? Incomplete : Fallback;
  const start = ctx.positions ? ctx.at(pos) : origin;
  const name = nameAt(buf, pos + 1, nameEnd, ctx);
  const i = readAttributes(buf, nameEnd, ctx);
  if (i === GRAMMAR) return Fallback;
  if (i === MORE) return partial ? Incomplete : Fallback;
  return closeStart(buf, i, ctx, name, start, partial);
};

/** The end of a start tag at `i`: `>` or `/>`. */
const closeStart = (
  buf: string,
  i: number,
  ctx: Context,
  name: string,
  start: Position,
  partial: boolean,
): ScanResult => {
  const c = buf.charCodeAt(i);
  const selfClosing = c === SLASH;
  if (selfClosing && i + 1 >= buf.length) return partial ? Incomplete : Fallback;
  // A name character the table does not cover, or attributes run together.
  if (selfClosing ? buf.charCodeAt(i + 1) !== GT : c !== GT) return Fallback;
  const after = selfClosing ? i + 2 : i + 1;
  ctx.end = after;
  const count = ctx.count;
  const { reused } = ctx;
  if (ctx.reuse) {
    const ev = reused.start;
    ev.name = name;
    ev.attributes =
      count === 0 ? none : (reused.lists[count] ??= reused.attributes.slice(0, count));
    ev.selfClosing = selfClosing;
    return ev;
  }
  return {
    name,
    attributes: count === 0 ? none : reused.pending.slice(0, count),
    selfClosing,
    span: ctx.positions ? { start, end: ctx.at(after) } : NO_SPAN,
    _tag: "StartElement",
  };
};

/**
 * The attributes of a start tag from `i` (just after its name), into the
 * context ({@link Context.count} of them). Returns where the tag's `>` or
 * `/` should be, or {@link MORE} or {@link GRAMMAR}.
 */
const readAttributes = (buf: string, from: number, ctx: Context): number => {
  const end = buf.length;
  let i = from;
  let k = 0;
  ctx.count = 0;
  // Whitespace, then an attribute or the end of the tag.
  while (i < end && isWs(buf.charCodeAt(i))) {
    i = skipWs(buf, i + 1, end);
    if (i >= end) return MORE;
    const c = buf.charCodeAt(i);
    if (c === GT || c === SLASH) break;
    i = attributeAt(buf, i, ctx, k++);
    if (i < 0) return i;
  }
  ctx.count = k;
  return i >= end ? MORE : i;
};

/**
 * `name = "value"` at `start` (the first character of the name), as the
 * tag's attribute `k`. Returns the index after it, or {@link MORE} or
 * {@link GRAMMAR}.
 */
const attributeAt = (buf: string, start: number, ctx: Context, k: number): number => {
  const end = buf.length;
  if (!startsName(buf.charCodeAt(start))) return GRAMMAR;
  const nameEnd = wideName(buf, start, end, true);
  if (nameEnd === -1) return GRAMMAR;
  let i = skipWs(buf, nameEnd, end);
  if (i >= end) return MORE;
  if (buf.charCodeAt(i) !== EQ) return GRAMMAR;
  i = skipWs(buf, i + 1, end);
  if (i >= end) return MORE;
  const quote = buf.charCodeAt(i);
  if (quote !== QUOT && quote !== APOS) return GRAMMAR;
  const from = i + 1;
  const scanned = valueEnd(buf, from, quote);
  if (scanned < 0) return MORE;
  const close = Math.floor(scanned / 8);
  const flags = scanned % 8;
  const value = attributeValue(buf.slice(from, close), flags, ctx);
  if (value === undefined) return GRAMMAR;
  const name = nameAt(buf, start, nameEnd, ctx);
  if (ctx.reuse) {
    const reused = ctx.reused.attributes;
    const a = reused[k];
    if (a === undefined) reused[k] = { name, value, span: NO_SPAN };
    else {
      a.name = name;
      a.value = value;
    }
  } else {
    ctx.reused.pending[k] = { name, value, span: spanOf(ctx, start, close + 1) };
  }
  return close + 1;
};

/**
 * An attribute value from `from` to its closing `quote`: one pass, noting
 * what the value needs. Returns the index of the quote times 8 plus the
 * value's flags ({@link HAS_LT} and the rest), or -1 when the buffer ends
 * first.
 */
const valueEnd = (buf: string, from: number, quote: number): number => {
  const end = buf.length;
  let flags = 0;
  for (let i = from; i < end; i++) {
    const c = buf.charCodeAt(i);
    if (c === quote) return i * 8 + flags;
    if (c < EQ) flags |= valueFlag(c);
  }
  return -1;
};

/** The flag a character below `=` sets in an attribute value, if any. */
const valueFlag = (c: number): number =>
  c === LT ? HAS_LT : c === AMP ? HAS_REF : c === TAB || c === LF ? HAS_SPACE : 0;

/** What an attribute value has in it (see {@link attributeAt}). */
const HAS_LT = 1;
const HAS_REF = 2;
const HAS_SPACE = 4;

/**
 * The value of an attribute (`raw`, which has `flags` in it), normalized
 * (§3.3.3: literal whitespace is a space) and with its references decoded;
 * `undefined` for the grammar to read (a `<`, or a reference it does not
 * decode).
 */
const attributeValue = (raw: string, flags: number, ctx: Context): string | undefined => {
  if ((flags & HAS_LT) !== 0) return undefined;
  const spaced = (flags & HAS_SPACE) !== 0 ? raw.replace(/[\t\n]/g, " ") : raw;
  return (flags & HAS_REF) !== 0 ? decodeRefs(spaced, ctx.entities) : spaced;
};
