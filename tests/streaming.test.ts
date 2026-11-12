import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Sax } from "../src/index.ts";
import { narrowAt } from "./support/narrow.ts";
import { plain } from "./support/plain.ts";

const splitEvery = (s: string, n: number): ReadonlyArray<string> =>
  Arr.makeBy(Math.ceil(s.length / n), (i) => s.slice(i * n, i * n + n));

const tokenizeChunks = (chunks: ReadonlyArray<string>, options?: Sax.SaxOptions) =>
  Stream.fromIterable(chunks).pipe(Sax.tokenize(options), Stream.runCollect);

const collectChunks = (chunks: ReadonlyArray<string>, options?: Sax.SaxOptions) =>
  tokenizeChunks(chunks, options);

/** Each event of `chunks` as {@link plain} data, materialized as it is emitted. */
const plainAsEmitted = (chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks).pipe(Sax.tokenize(), Stream.map(plain), Stream.runCollect);

describe("Sax — true incremental streaming", () => {
  const document =
    `<?xml version="1.0"?>` +
    `<catalog xmlns:p="urn:p">` +
    `<p:product sku="123" tag='a&amp;b'>` +
    `<name>Laptop &lt;Pro&gt;</name>` +
    `<!-- a comment --><![CDATA[raw <data>]]>` +
    `</p:product>` +
    `</catalog>`;

  it.effect("result is identical regardless of chunk boundaries", () =>
    Effect.gen(function* () {
      const whole = yield* collectChunks([document]);

      // Every chunk size from 1 to the full length must produce the same events,
      // including the same spans — this is the core promise the old parser broke.
      yield* Effect.forEach(
        Arr.range(1, document.length),
        (size) =>
          tokenizeChunks(splitEvery(document, size)).pipe(
            Effect.map((chunked) => {
              expect(chunked).toStrictEqual(whole);
              expect(plain(chunked)).toStrictEqual(plain(whole));
            }),
          ),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("lines and columns are identical regardless of chunk boundaries", () =>
    Effect.gen(function* () {
      // LF, CRLF and lone CR line ends, inside text, markup and attribute values,
      // so chunks split CRLFs and the lexer compacts its buffer.
      const lined =
        `<?xml version="1.0"?>\r\n<root>\r\n` +
        Arr.makeBy(200, (i) => `  <item n="${i}"\r\n    k='v'>x\ry\r\n</item>\n`).join("") +
        `<!-- a\r\ncomment -->\r</root>\r\n`;
      const whole = plain(yield* collectChunks([lined]));
      // Resolved on read, after all the input is in: the same as on the fly.
      expect(yield* plainAsEmitted([lined])).toStrictEqual(whole);
      expect(whole).toContainEqual(
        expect.objectContaining({
          _tag: "Comment",
          span: {
            start: { offset: lined.indexOf("<!--"), line: 803, column: 1 },
            end: { offset: lined.indexOf("\r</root>"), line: 804, column: 12 },
          },
        }),
      );
      yield* Effect.forEach(
        Arr.range(1, 64),
        (size) =>
          Effect.zip(
            tokenizeChunks(splitEvery(lined, size)),
            plainAsEmitted(splitEvery(lined, size)),
          ).pipe(
            Effect.map(([chunked, onTheFly]) => {
              expect(plain(chunked)).toStrictEqual(whole);
              expect(onTheFly).toStrictEqual(whole);
            }),
          ),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("splits in the middle of a multi-char delimiter are safe", () =>
    Effect.gen(function* () {
      // Force boundaries inside <!--, <![CDATA[, -->, ]]>, ?>, />
      const cases = [
        ["<a><!", "-- c --></a>"],
        ["<a><!-", "- c --></a>"],
        ["<a><![CDA", "TA[x]]></a>"],
        ["<a>x]", "]y</a>"], // not a CDATA close, just text "x]]y"
        ["<a><?pi da", "ta?></a>"],
        ["<a/", ">"],
        ["<a></a", ">"],
      ] as const;
      yield* Effect.forEach(
        cases,
        (chunks) =>
          Effect.zip(tokenizeChunks([chunks.join("")]), tokenizeChunks(chunks)).pipe(
            Effect.map(([joined, split]) => expect(split).toStrictEqual(joined)),
          ),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("a character XML does not allow fails the same way for every chunk size", () =>
    Effect.gen(function* () {
      const input = "<a><b>x</b>y\u000Cz</a>";
      const whole = yield* Effect.flip(tokenizeChunks([input]));
      expect(whole.message).toContain("at 1:13");
      yield* Effect.forEach(
        Arr.range(1, input.length),
        (size) =>
          Effect.flip(tokenizeChunks(splitEvery(input, size))).pipe(
            Effect.map((error) => expect(error).toStrictEqual(whole)),
          ),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("entity split across chunk boundary still decodes", () =>
    Effect.gen(function* () {
      const evs = yield* collectChunks(["<a>x &a", "mp; y</a>"]);
      expect(narrowAt(evs, 1, Sax.isText).data).toBe("x & y");
    }),
  );
});
