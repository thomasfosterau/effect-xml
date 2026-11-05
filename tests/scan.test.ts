/**
 * The hand-written XML scanner (`src/internal/scan.ts`) against the token
 * grammars it stands in for. With `dtd: "internal"` the lexer reads every
 * token with the grammars, so on a document without a DOCTYPE the two must
 * agree exactly: the same events with the same spans, and the same failure.
 * `Xml.parse` builds without positions first (rerunning with them to report
 * a failure); it must agree with `Xml.parseStream`, which never does.
 */
import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { origin, Sax, Xml } from "../src/index.ts";
import { documents } from "./support/documents.ts";
import { plain } from "./support/plain.ts";

/** The events of `doc` (or its failure), whole or in chunks of `size`. */
const tokenize = (doc: string, options: Sax.SaxOptions, size: number) =>
  Effect.runSync(
    Effect.exit(
      Stream.fromIterable(
        Arr.makeBy(Math.ceil(doc.length / size), (i) => doc.slice(i * size, i * size + size)),
      ).pipe(Sax.tokenize(options), Stream.runCollect),
    ),
  );

/** An exit's events as plain data: lazy spans resolved, so a comparison sees every position. */
const located = <E>(exit: Exit.Exit<Iterable<Sax.SaxEvent>, E>) =>
  Exit.map(exit, (events) => plain(Arr.fromIterable(events)));

/** The events `Sax.forEach` hands over (or its failure). */
const each = (doc: string | Uint8Array, options: Sax.SaxBytesOptions) => {
  const events: Array<Sax.SaxEvent> = [];
  const exit = Effect.runSync(
    Effect.exit(Sax.forEach(doc, (event) => events.push(event), options)),
  );
  return Exit.map(exit, () => events);
};

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
  test("agrees with the token grammars: events, spans and failures", () => {
    Arr.forEach(docs, (doc) =>
      expect(located(tokenize(doc, {}, doc.length)), doc).toStrictEqual(
        located(tokenize(doc, { dtd: "internal" }, doc.length)),
      ),
    );
  });

  test("agrees with the token grammars across chunk boundaries", () => {
    Arr.forEach(docs.slice(0, 300), (doc) =>
      Arr.forEach([1, 2, 3, 7], (size) =>
        expect(located(tokenize(doc, {}, size)), `${doc} in chunks of ${size}`).toStrictEqual(
          located(tokenize(doc, { dtd: "internal" }, size)),
        ),
      ),
    );
  });

  test("covers documents that parse, and ones that fail", () => {
    const exits = docs.map((doc) => tokenize(doc, {}, doc.length));
    expect(exits.filter(Exit.isSuccess).length).toBeGreaterThan(600);
    expect(exits.filter(Exit.isFailure).length).toBeGreaterThan(750);
  });

  test("without positions: the same events at the origin, and the same failures", () => {
    Arr.forEach(docs, (doc) =>
      Arr.forEach([doc.length, 3], (size) =>
        expect(tokenize(doc, { positions: false }, size), doc).toStrictEqual(
          Exit.map(tokenize(doc, {}, size), (events) => Arr.map(events, unplaced)),
        ),
      ),
    );
  });

  test("without positions, a limit points at the start of the token that broke it", () => {
    const doc = `<root>\n  <a x="1" y="${"z".repeat(40)}"/></root>`;
    const failure = (positions: boolean) =>
      Effect.runSync(Effect.flip(Sax.collect(doc, { positions, limits: { maxTextLength: 10 } })));
    expect(failure(true)).toMatchObject({
      _tag: "LimitExceeded",
      position: { line: 2, column: 12 },
    });
    expect(failure(false)).toMatchObject({
      _tag: "LimitExceeded",
      position: { line: 2, column: 3 },
    });
  });

  test("Sax.forEach hands over the events Sax.tokenize streams, and its failure", () => {
    Arr.forEach(docs, (doc) => {
      expect(located(each(doc, {})), doc).toStrictEqual(located(tokenize(doc, {}, doc.length)));
      // (Encoding replaces a lone surrogate: compare with the text the bytes are.)
      const bytes = new TextEncoder().encode(doc);
      const text = new TextDecoder().decode(bytes);
      expect(each(bytes, { positions: false }), doc).toStrictEqual(
        tokenize(text, { positions: false }, text.length),
      );
    });
  });

  test("Sax.forEach, read directly, stops at a broken limit exactly where the lexer does", () => {
    const limits = [
      { maxDepth: 2 },
      { maxAttributes: 1 },
      { maxNameLength: 2 },
      { maxTextLength: 3 },
    ];
    Arr.forEach(docs.slice(0, 500), (doc) =>
      Arr.forEach(limits, (limit) =>
        expect(located(each(doc, { limits: limit })), doc).toStrictEqual(
          located(tokenize(doc, { limits: limit }, doc.length)),
        ),
      ),
    );
  });

  test("Xml.parse, built without positions, agrees with Xml.parseStream", () => {
    Arr.forEach(docs, (doc) =>
      expect(Effect.runSync(Effect.exit(Xml.parse(doc))), doc).toStrictEqual(
        Effect.runSync(Effect.exit(Stream.make(doc).pipe(Xml.parseStream()))),
      ),
    );
  });
});
