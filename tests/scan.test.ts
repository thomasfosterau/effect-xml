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
import { Sax, Xml } from "../src/index.ts";
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

const docs = documents(1, 3000);

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

  test("Xml.parse, built without positions, agrees with Xml.parseStream", () => {
    Arr.forEach(docs, (doc) =>
      expect(Effect.runSync(Effect.exit(Xml.parse(doc))), doc).toStrictEqual(
        Effect.runSync(Effect.exit(Stream.make(doc).pipe(Xml.parseStream()))),
      ),
    );
  });
});
