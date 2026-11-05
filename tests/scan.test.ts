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

/** A deterministic generator (mulberry32), so a failure reproduces. */
const random = (seed: number) => {
  let a = seed;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Pieces that make up tags, text and their near misses. */
const pieces = [
  "<",
  ">",
  "/",
  "</",
  "/>",
  "a",
  "b:c",
  "x1",
  "_",
  "-",
  ".",
  "9",
  "é",
  "\u{1F600}",
  " ",
  "\t",
  "\n",
  "\r\n",
  "\f",
  "=",
  '"',
  "'",
  "&",
  "amp;",
  "&lt;",
  "&gt;",
  "&quot;",
  "&apos;",
  "&#65;",
  "&#x41;",
  "&#X41;",
  "&#0;",
  "&#x110000;",
  "&#99999999999;",
  "&nope;",
  "&a-b;",
  "]]>",
  "]]",
  "<!--c-->",
  "<?pi x?>",
  "<![CDATA[x]]>",
  "text",
  "\u0001",
];

const pick = <A>(next: () => number, items: ReadonlyArray<A>): A =>
  Arr.getUnsafe(items, Math.floor(next() * items.length));

/** A well-formed element, with attributes, text and references. */
const element = (next: () => number): string => {
  const name = (): string => pick(next, ["a", "row", "x:c", "v_1", "a.b-c"]);
  const value = (): string => pick(next, ["", "1", "a&amp;b", "x\ty", "&#x41;", "q'q", "\n", "é"]);
  const attrs = Arr.makeBy(Math.floor(next() * 3), (i) => {
    const q = next() < 0.5 ? '"' : "'";
    const v = value().replaceAll(q, "");
    return `${next() < 0.2 ? "\n" : " "}${name()}${i}${next() < 0.2 ? " = " : "="}${q}${v}${q}`;
  }).join("");
  const n = name();
  return next() < 0.3
    ? `<${n}${attrs}${next() < 0.5 ? " " : ""}/>`
    : `<${n}${attrs}>${next() < 0.5 ? "t &lt; u\r\n" : ""}</${n}${next() < 0.2 ? "  " : ""}>`;
};

/** Documents: well-formed elements with near misses spliced in now and then. */
const documents = (seed: number, count: number): ReadonlyArray<string> => {
  const next = random(seed);
  return Arr.makeBy(count, (i) => {
    const body = Arr.makeBy(1 + Math.floor(next() * 6), () =>
      next() < 0.6 ? element(next) : pick(next, pieces),
    ).join("");
    // Every fourth one is well-formed, so the failures don't hide the rest.
    return i % 4 === 0
      ? `<root>${Arr.makeBy(4, () => element(next)).join("")}</root>`
      : `<root>${body}</root>`;
  });
};

/** The events of `doc` (or its failure), whole or in chunks of `size`. */
const tokenize = (doc: string, options: Sax.SaxOptions, size: number) =>
  Effect.runSync(
    Effect.exit(
      Stream.fromIterable(
        Arr.makeBy(Math.ceil(doc.length / size), (i) => doc.slice(i * size, i * size + size)),
      ).pipe(Sax.tokenize(options), Stream.runCollect),
    ),
  );

const docs = documents(1, 3000);

describe("the XML scanner", () => {
  test("agrees with the token grammars: events, spans and failures", () => {
    Arr.forEach(docs, (doc) =>
      expect(tokenize(doc, {}, doc.length), doc).toStrictEqual(
        tokenize(doc, { dtd: "internal" }, doc.length),
      ),
    );
  });

  test("agrees with the token grammars across chunk boundaries", () => {
    Arr.forEach(docs.slice(0, 300), (doc) =>
      Arr.forEach([1, 2, 3, 7], (size) =>
        expect(tokenize(doc, {}, size), `${doc} in chunks of ${size}`).toStrictEqual(
          tokenize(doc, { dtd: "internal" }, size),
        ),
      ),
    );
  });

  test("covers documents that parse, and ones that fail", () => {
    const exits = docs.map((doc) => tokenize(doc, {}, doc.length));
    expect(exits.filter(Exit.isSuccess).length).toBeGreaterThan(750);
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
