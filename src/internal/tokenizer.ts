/**
 * The tokenizer behind every SAX consumer: a lexer, the resource limits, the
 * DOCTYPE's entities (with `dtd: "internal"`) and the conversion to SAX
 * events, fed input and drained as a consumer pulls. `Sax.tokenize` streams
 * its events; {@link runChunks} hands the events of complete input to a
 * callback, synchronously, for `Sax.forEach` and the tree builders.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Encoding from "../Encoding.ts";
import { LimitExceeded, MalformedDeclaration, type SaxError } from "../Error.ts";
import type { ResolvedOptions, SaxEvent } from "../Sax.ts";
import { convert } from "./convert.ts";
import { Dtd } from "./dtd.ts";
import { applyDefaults, Expander } from "./expansion.ts";
import { Guard } from "./guard.ts";
import {
  isDoctypeEvent,
  isEntityReferenceEvent,
  isFault,
  isStartElementEvent,
  Lexer,
  type LexOutput,
} from "./lexer.ts";
import { readDirectly } from "./direct.ts";
import { quote } from "./quote.ts";

/**
 * One stream's tokenizing: the lexer, the limits, and (with `dtd:
 * "internal"`) the DOCTYPE's entities, turning written input into SAX events.
 * Lexes token by token, so a limit stops the lexer at the offending token
 * rather than after the whole chunk, converting each output as it comes.
 */
export class Tokenizer {
  /** The failure that ended the events, once there is one. */
  fault: SaxError | undefined = undefined;
  private ended = false;
  private readonly lexer: Lexer;
  private readonly guard: Guard;
  private readonly opts: ResolvedOptions;
  private readonly dtd: Dtd | undefined;
  private readonly expander: Expander | undefined;
  /** The callback {@link run} hands events to. */
  private sink: (ev: SaxEvent) => boolean = () => true;

  /** `reuse`: reuse events where the lexer can (see `LexerOptions.reuse`). */
  constructor(opts: ResolvedOptions, reuse = false) {
    this.opts = opts;
    const dtd = opts.mode === "xml" && opts.dtd === "internal" ? new Dtd(opts.limits) : undefined;
    this.dtd = dtd;
    this.lexer = new Lexer({
      mode: opts.mode,
      entities: opts.entities,
      dtd,
      content: false,
      scripting: opts.scripting,
      positions: opts.positions,
      reuse,
    });
    this.expander = dtd === undefined ? undefined : new Expander(dtd, opts.entities);
    this.guard = new Guard(opts.limits, opts.mode === "xml");
  }

  /** Add input; a limit it breaks, if it does. */
  write(chunk: string): LimitExceeded | undefined {
    const over = this.guard.input(chunk.length, this.lexer);
    if (over !== null) return over;
    this.lexer.push(chunk);
    return undefined;
  }

  /** Signal the end of the input. */
  close(): void {
    this.ended = true;
    this.lexer.close();
  }

  /**
   * Hand the events of the input written so far to `f`, stopping when it
   * returns `false`, or after a whole token once `full` returns `true`.
   * Returns whether the lexer ran dry (or failed, setting {@link fault}).
   */
  run(f: (ev: SaxEvent) => boolean, full?: () => boolean): boolean {
    if (this.fault !== undefined) return true;
    this.sink = f;
    const dry = this.lexer.pullEach(this.each, full);
    if (dry && !this.ended && this.fault === undefined) {
      this.fault = this.guard.pending(this.lexer) ?? undefined;
    }
    return dry || this.fault !== undefined;
  }

  /** Keep one output; `false` once it is (or has become) a fault, or the sink is full. */
  private readonly accept = (o: LexOutput): boolean => {
    if (isFault(o)) {
      this.fault = o.error;
      return false;
    }
    const over = this.guard.event(o);
    if (over !== null) {
      // Without positions in events, the limit points at the token's start.
      this.fault = this.opts.positions
        ? over
        : new LimitExceeded({
            limit: over.limit,
            max: over.max,
            position: this.lexer.tokenPosition(),
          });
      return false;
    }
    const ev = convert(o, this.opts);
    return ev === null || this.sink(ev);
  };

  /** Interpret a DOCTYPE or an entity reference (with `dtd: "internal"`). */
  private interpret(o: LexOutput): ReadonlyArray<LexOutput> {
    const { dtd, expander } = this;
    if (dtd === undefined || expander === undefined) return [o];
    if (isDoctypeEvent(o)) {
      const subset = o.internalSubset;
      const error = subset === null ? null : dtd.declare(subset);
      if (subset === null || error === null) return [o];
      const found = subset.slice(error.offset, error.offset + 1);
      const fault = new MalformedDeclaration({
        construct: "DOCTYPE internal subset",
        expected: error.expected,
        found: found === "" ? "end of input" : quote(found),
        position: o.span.start,
      });
      return [{ _tag: "Fault", error: fault }];
    }
    if (isEntityReferenceEvent(o)) return expander.expand(o);
    return [o];
  }

  // Only a DOCTYPE or an entity reference can stand for other outputs; the
  // rest are kept one for one, without an array per output.
  private readonly each = (raw: LexOutput): boolean => {
    const dtd = this.dtd;
    if (dtd === undefined) return this.accept(raw);
    return isDoctypeEvent(raw) || isEntityReferenceEvent(raw)
      ? this.interpret(raw).every(this.accept)
      : this.accept(isStartElementEvent(raw) ? applyDefaults(dtd, raw) : raw);
  };
}

/**
 * Tokenize complete input synchronously, handing each event to `f` (as
 * `Sax.tokenize` would emit them for these chunks) until it returns a
 * failure. Returns the first failure, the tokenizer's or `f`'s. With
 * `reuse`, `f` must be done with each event before it returns (see
 * `LexerOptions.reuse`).
 */
export const runChunks = (
  { chunks, failure: last }: Chunks,
  opts: ResolvedOptions,
  f: (ev: SaxEvent) => SaxError | null,
  reuse = false,
): SaxError | null => {
  // XML without a DTD, all of it here: read it directly, and with the lexer
  // only from where that stops (the events up to there are the same).
  let skip = 0;
  if (last === undefined && opts.mode === "xml" && opts.dtd === "ignore") {
    const direct = readDirectly(chunks.join(""), opts, f, reuse);
    if (direct === null || !Predicate.hasProperty(direct, "stoppedAfter")) return direct;
    skip = direct.stoppedAfter;
  }
  const tokenizer = new Tokenizer(opts, reuse);
  let failure: SaxError | null = null;
  const sink = (ev: SaxEvent): boolean => {
    if (skip > 0) {
      skip--;
      return true;
    }
    return (failure = f(ev)) === null;
  };
  const early = Arr.findFirst(chunks, (chunk): Option.Option<SaxError> => {
    if (chunk === "") return Option.none();
    const over = tokenizer.write(chunk);
    if (over !== undefined) return Option.some(over);
    tokenizer.run(sink);
    return Option.fromNullishOr(failure ?? tokenizer.fault);
  });
  if (Option.isSome(early)) return early.value;
  if (last !== undefined) return last;
  tokenizer.close();
  tokenizer.run(sink);
  return failure ?? tokenizer.fault ?? null;
};

/**
 * Complete input as chunks of text, and the failure that follows
 * them (a decoding failure at the end of the bytes), if any.
 */
export interface Chunks {
  readonly chunks: ReadonlyArray<string>;
  readonly failure?: SaxError | undefined;
}

/**
 * The text of a complete byte array, in the chunks `Sax.tokenizeByteArray`
 * tokenizes.
 */
export const decodeChunks = (input: Uint8Array, options: Encoding.DecodeOptions): Chunks => {
  const decoder = new Encoding.ByteDecoder(options);
  const first = decoder.write(input);
  if (!Predicate.isString(first)) return { chunks: [], failure: first };
  const rest = decoder.end();
  return Predicate.isString(rest) ? { chunks: [first, rest] } : { chunks: [first], failure: rest };
};
