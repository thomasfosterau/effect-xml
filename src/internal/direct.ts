/**
 * Strict reading of complete input, driving the scanner directly.
 *
 * {@link Tokenizer} reads any input, chunk by chunk, through the lexer: a
 * buffer, partial-mode retries, a position table, a fault channel. For a
 * whole document in memory most of that has nothing to do, so
 * {@link readDirectly} runs the lexer's own scanner (`scan.ts`) over the
 * input in one loop, with the checks the lexer makes around it (the
 * characters XML forbids, the placement of the declaration, DOCTYPE, CDATA
 * and references, the resource limits through the same {@link Guard}) and the
 * same conversion to SAX events. Anything it does not read that way (markup
 * the scanner leaves to the grammars, text outside the root that the grammars
 * would read differently, any check that does not pass) stops it; the caller
 * then reads the input with the lexer, from the start, skipping the events
 * already handed over, which are the same events (the scanner is the lexer's).
 * So the events, and every failure, are the lexer's. `tests/scan.test.ts`
 * holds it to that (`Sax.forEach` against `Sax.tokenize`, which always lexes).
 */
import { Input, Parser } from "@thomasfosterau/effect-parse";
import type { SaxError } from "../Error.ts";
import type { Span } from "../Position.ts";
import type { ResolvedOptions, SaxEvent } from "../Sax.ts";
import { convert } from "./convert.ts";
import { Guard } from "./guard.ts";
import { FORBIDDEN, type LexEvent } from "./lexer.ts";
import { LazySpan, LineIndex } from "./position.ts";
import {
  type Context,
  Fallback,
  freshMarks,
  Incomplete,
  NAME_SLOTS,
  NO_SPAN,
  Reused,
  scanXml,
} from "./scan.ts";
import { grammars, type Tok } from "./tokens.ts";

/** What a direct read ended with: done, `f`'s failure, or stopped after so many events. */
export type Direct = null | SaxError | { readonly stoppedAfter: number };

/** The XML declaration or DOCTYPE token as the lexer's event (`Lexer.event`), at `span`. */
const declarationEvent = (tok: Tok, span: Span): LexEvent | undefined => {
  switch (tok._tag) {
    case "XmlDeclaration":
      return {
        version: tok.version,
        encoding: tok.encoding,
        standalone: tok.standalone,
        span,
        _tag: tok._tag,
      };
    case "Doctype":
      return {
        name: tok.name,
        publicId: tok.publicId,
        systemId: tok.systemId,
        internalSubset: tok.internalSubset,
        forceQuirks: tok.forceQuirks,
        span,
        _tag: tok._tag,
      };
    default:
      return undefined;
  }
};

/** One direct read's state. */
class Pass {
  private readonly input: string;
  private readonly opts: ResolvedOptions;
  private readonly f: (ev: SaxEvent) => SaxError | null;
  private readonly guard: Guard;
  private readonly ctx: Context;
  private readonly forbidden: number;
  private readonly data: ReturnType<typeof grammars>["data"];
  private depth = 0;
  private prologEnded = false;
  /** How many events have been handed over. */
  count = 0;

  constructor(
    input: string,
    opts: ResolvedOptions,
    f: (ev: SaxEvent) => SaxError | null,
    reuse: boolean,
  ) {
    this.input = input;
    this.opts = opts;
    this.f = f;
    this.guard = new Guard(opts.limits, true);
    this.forbidden = input.search(FORBIDDEN);
    this.data = grammars("xml", opts.entities, false).data;
    const lines = new LineIndex();
    if (opts.positions) lines.record(input, 0);
    this.ctx = {
      entities: opts.entities,
      // No CR in the input (see `readDirectly`): offsets are indices.
      span: (from, to) => new LazySpan(lines, from, from, to, to),
      positions: opts.positions,
      reuse: reuse && !opts.positions,
      end: 0,
      count: 0,
      inside: false,
      names: Array.from<string | undefined>({ length: NAME_SLOTS }),
      reused: new Reused(),
      marks: freshMarks(),
    };
  }

  /** Read to the end: `null`, `f`'s failure, or `undefined` to stop (see {@link Direct}). */
  run(): SaxError | null | undefined {
    const { input } = this;
    let pos = 0;
    while (pos < input.length) {
      const ev = this.token(pos);
      if (ev === undefined) return undefined;
      const end = this.ctx.end;
      if (this.forbidden !== -1 && this.forbidden < end) return undefined;
      if (this.guard.event(ev) !== null) return undefined;
      const out = convert(ev, this.opts);
      if (out !== null) {
        const failure = this.f(out);
        if (failure !== null) return failure;
        this.count++;
      }
      pos = end;
    }
    return null;
  }

  /** The token at `pos` as the lexer would read it, or `undefined` to stop. */
  private token(pos: number): LexEvent | undefined {
    const { input, ctx } = this;
    const inside = this.depth > 0;
    if (!inside && input.charCodeAt(pos) !== 60) return this.outsideText(pos);
    ctx.inside = inside;
    const ev = scanXml(input, pos, false, ctx);
    if (ev === Incomplete) return undefined;
    if (ev === Fallback) return this.declaration(pos);
    // The lexer's placement checks (`Lexer.misplaced`), for what the scanner reads.
    if (ev._tag === "StartElement") {
      if (!ev.selfClosing) this.depth++;
      this.prologEnded = true;
    } else if (ev._tag === "EndElement" && this.depth > 0) this.depth--;
    return ev;
  }

  /**
   * Text outside the root element (the lexer reads it with the grammar): as
   * the grammar reads it when it has no reference (misplaced there) and no
   * `]]>`; otherwise stop.
   */
  private outsideText(pos: number): LexEvent | undefined {
    const { input, ctx } = this;
    const lt = input.indexOf("<", pos);
    const to = lt === -1 ? input.length : lt;
    const data = input.slice(pos, to);
    if (data.indexOf("&") !== -1 || data.indexOf("]]>") !== -1) return undefined;
    ctx.end = to;
    return { data, span: ctx.positions ? ctx.span(pos, to) : NO_SPAN, _tag: "Text" };
  }

  /** The XML declaration (only at the very start) or the DOCTYPE (only in the prolog). */
  private declaration(pos: number): LexEvent | undefined {
    const { input, ctx } = this;
    const c = input.charCodeAt(pos + 1);
    const xmlDecl = c === 63; /* ? */
    if (xmlDecl ? pos !== 0 : c !== 33 /* ! */ || this.prologEnded) return undefined;
    const state = new Input.State(input, { partial: false, offset: pos });
    const step = Parser.run(this.data, state);
    const tok = step === Input.Fail ? undefined : step[0];
    if (tok === undefined || tok._tag !== (xmlDecl ? "XmlDeclaration" : "Doctype")) {
      return undefined;
    }
    if (!xmlDecl) this.prologEnded = true;
    ctx.end = state.pos;
    return declarationEvent(tok, ctx.positions ? ctx.span(pos, state.pos) : NO_SPAN);
  }
}

/**
 * Read complete `input` strictly, handing each event to `f`, without the
 * lexer (see the module's description). XML without a DTD only; input with a
 * CR (whose offsets would need the lexer's CRLF records) or over the size
 * limit is not read at all.
 */
export const readDirectly = (
  input: string,
  opts: ResolvedOptions,
  f: (ev: SaxEvent) => SaxError | null,
  reuse = false,
): Direct => {
  if (input.indexOf("\r") !== -1 || input.length > opts.limits.maxTotalBytes) {
    return { stoppedAfter: 0 };
  }
  const pass = new Pass(input, opts, f, reuse);
  const result = pass.run();
  return result === undefined ? { stoppedAfter: pass.count } : result;
};
