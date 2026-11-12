/**
 * The hand-written XML scanner (`src/internal/scan.ts`) against the token
 * grammars it stands in for. Read with the DTD-aware grammars from the first
 * token (`tokenizeEagerly`, `dtd: "internal"` as before #99), the lexer reads
 * every token with the grammars, so on a document without a DOCTYPE the two
 * must agree exactly: the same events with the same spans, and the same
 * failure.
 * `Xml.parse` builds without positions first (rerunning with them to report
 * a failure); it must agree with `Xml.parseStream`, which never does.
 */
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as P from "effect/Predicate";
import * as Stream from "effect/Stream";
import { origin, Sax, Xml } from "../src/index.ts";
import { splitEvery } from "./support/chunks.ts";
import { documents } from "./support/documents.ts";
import { tokenizeEagerly } from "./support/eager.ts";
import { some } from "./support/narrow.ts";
import { plain } from "./support/plain.ts";

/** The events of `doc` (or its failure), whole or in chunks of `size`. */
const tokenize = (doc: string, options: Sax.SaxOptions, size: number) =>
  Effect.exit(
    Stream.fromIterable(
      Arr.makeBy(Math.ceil(doc.length / size), (i) => doc.slice(i * size, i * size + size)),
    ).pipe(Sax.tokenize(options), Stream.runCollect),
  );

/** The events of `doc` (or its failure) read with the grammars alone, whole or in chunks of `size`. */
const grammars = (doc: string, options: Sax.SaxOptions, size: number) =>
  tokenizeEagerly(splitEvery(doc, size), { ...options, dtd: "internal" });

/** An exit's events as plain data: lazy spans resolved, so a comparison sees every position. */
const located = <E>(exit: Exit.Exit<Iterable<Sax.SaxEvent>, E>) =>
  Exit.map(exit, (events) => plain(Arr.fromIterable(events)));

/** The events `Sax.forEach` hands over (or its failure). */
const each = (doc: string | Uint8Array, options: Sax.SaxBytesOptions) =>
  Effect.gen(function* () {
    const events: Array<Sax.SaxEvent> = [];
    const exit = yield* Effect.exit(Sax.forEach(doc, (event) => events.push(event), options));
    return Exit.map(exit, () => events);
  });

/** Each event's `position()` as `Sax.forEach` reports it (up to any failure). */
const reported = (doc: string, options: Sax.ForEachOptions) =>
  Effect.gen(function* () {
    const out: Array<unknown> = [];
    yield* Effect.exit(Sax.forEach(doc, (_, position) => out.push(plain(position())), options));
    return out;
  });

/** Each event's `span.start` (up to any failure). */
const starts = (doc: string) =>
  Effect.gen(function* () {
    const out: Array<unknown> = [];
    yield* Effect.exit(Sax.forEach(doc, (ev) => out.push(plain(ev.span.start))));
    return out;
  });

const docs = documents(1, 3000);

const nowhere = { start: origin, end: origin };

/** An event as `positions: false` gives it: every span the origin. */
const unplaced = (ev: Sax.SaxEvent): Sax.SaxEvent =>
  Sax.isStartElement(ev)
    ? Sax.SaxEvent.StartElement({
        ...ev,
        attributes: ev.attributes.map((a) => ({ ...a, span: nowhere })),
        span: nowhere,
      })
    : { ...ev, span: nowhere };

describe("the XML scanner", () => {
  it.effect("agrees with the token grammars: events, spans and failures", () =>
    Effect.forEach(
      docs,
      (doc) =>
        Effect.map(tokenize(doc, {}, doc.length), (events) =>
          expect(located(events), doc).toStrictEqual(located(grammars(doc, {}, doc.length))),
        ),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("agrees with the token grammars across chunk boundaries", () =>
    Effect.forEach(
      docs.slice(0, 300),
      (doc) =>
        Effect.forEach(
          [1, 2, 3, 7],
          (size) =>
            Effect.map(tokenize(doc, {}, size), (events) =>
              expect(located(events), `${doc} in chunks of ${size}`).toStrictEqual(
                located(grammars(doc, {}, size)),
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("agrees with the recovering grammars (`recover: true`), whole and chunked", () =>
    Effect.forEach(
      docs.slice(0, 1500),
      (doc) =>
        Effect.forEach(
          [doc.length, 1, 3],
          (size) =>
            Effect.map(tokenize(doc, { recover: true }, size), (events) =>
              expect(located(events), `${doc} in chunks of ${size}`).toStrictEqual(
                located(grammars(doc, { recover: true }, size)),
              ),
            ),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("covers documents that parse, and ones that fail", () =>
    Effect.gen(function* () {
      const exits = yield* Effect.forEach(docs, (doc) => tokenize(doc, {}, doc.length), {
        concurrency: 1,
      });
      expect(exits.filter(Exit.isSuccess).length).toBeGreaterThan(600);
      expect(exits.filter(Exit.isFailure).length).toBeGreaterThan(750);
      // Recovery reads most of the ones strict reading fails on.
      const recovering = yield* Effect.forEach(
        docs,
        (doc) => tokenize(doc, { recover: true }, doc.length),
        { concurrency: 1 },
      );
      expect(recovering.filter(Exit.isSuccess).length).toBeGreaterThan(1800);
    }),
  );

  it.effect("without positions: the same events at the origin, and the same failures", () =>
    Effect.forEach(
      docs,
      (doc) =>
        Effect.forEach(
          [doc.length, 3],
          (size) =>
            Effect.gen(function* () {
              return expect(yield* tokenize(doc, { positions: false }, size), doc).toStrictEqual(
                Exit.map(yield* tokenize(doc, {}, size), (events) => Arr.map(events, unplaced)),
              );
            }),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("without positions, a limit points at the start of the token that broke it", () =>
    Effect.gen(function* () {
      const doc = `<root>\n  <a x="1" y="${"z".repeat(40)}"/></root>`;
      const failure = (positions: boolean) =>
        Effect.flip(Sax.collect(doc, { positions, limits: { maxTextLength: 10 } }));
      const at = (positions: boolean) =>
        Effect.gen(function* () {
          const e = yield* failure(positions);
          assert(P.isTagged(e, "LimitExceeded"), "expected a limit failure");
          return some(e.position);
        });
      expect(yield* at(true)).toMatchObject({ line: 2, column: 12 });
      expect(yield* at(false)).toMatchObject({ line: 2, column: 3 });
    }),
  );

  it.effect("Sax.forEach hands over the events Sax.tokenize streams, and its failure", () =>
    Effect.forEach(
      docs,
      (doc) =>
        Effect.gen(function* () {
          expect(located(yield* each(doc, {})), doc).toStrictEqual(
            located(yield* tokenize(doc, {}, doc.length)),
          );
          // (Encoding replaces a lone surrogate: compare with the text the bytes are.)
          const bytes = new TextEncoder().encode(doc);
          const text = new TextDecoder().decode(bytes);
          expect(yield* each(bytes, { positions: false }), doc).toStrictEqual(
            yield* tokenize(text, { positions: false }, text.length),
          );
        }),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("Sax.forEach's position is each event's span.start", () =>
    Effect.gen(function* () {
      // Read directly, and (with CRLF line ends) with the lexer.
      const variants = docs.flatMap((doc) => [doc, doc.replaceAll("\n", "\r\n")]);
      yield* Effect.forEach(
        variants,
        (doc) =>
          Effect.gen(function* () {
            return expect(yield* reported(doc, { positions: false }), doc).toStrictEqual(
              yield* starts(doc),
            );
          }),
        { concurrency: 1, discard: true },
      );
      // Lenient reading of a well-formed document: the same positions.
      const wellFormed = yield* Effect.filter(
        variants,
        (doc) => Effect.map(Effect.exit(Sax.forEach(doc, () => {})), Exit.isSuccess),
        { concurrency: 1 },
      );
      expect(wellFormed.length).toBeGreaterThan(100);
      yield* Effect.forEach(
        wellFormed,
        (doc) =>
          Effect.gen(function* () {
            return expect(yield* reported(doc, { strict: false }), doc).toStrictEqual(
              yield* starts(doc),
            );
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect(
    "Sax.forEach, read directly, stops at a broken limit exactly where the lexer does",
    () =>
      Effect.gen(function* () {
        const limits = [
          { maxDepth: 2 },
          { maxAttributes: 1 },
          { maxNameLength: 2 },
          { maxTextLength: 3 },
        ];
        yield* Effect.forEach(
          docs.slice(0, 500),
          (doc) =>
            Effect.forEach(
              limits,
              (limit) =>
                Effect.gen(function* () {
                  return expect(located(yield* each(doc, { limits: limit })), doc).toStrictEqual(
                    located(yield* tokenize(doc, { limits: limit }, doc.length)),
                  );
                }),
              { concurrency: 1, discard: true },
            ),
          { concurrency: 1, discard: true },
        );
      }),
  );

  it.effect("Xml.parse, built without positions, agrees with Xml.parseStream", () =>
    Effect.forEach(
      docs,
      (doc) =>
        Effect.gen(function* () {
          return expect(yield* Effect.exit(Xml.parse(doc)), doc).toStrictEqual(
            yield* Effect.exit(Stream.make(doc).pipe(Xml.parseStream())),
          );
        }),
      { concurrency: 1, discard: true },
    ),
  );
});
