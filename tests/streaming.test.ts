import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Sax } from "../src/index.ts";
import { narrowAt } from "./support/narrow.ts";

const splitEvery = (s: string, n: number): ReadonlyArray<string> =>
  Arr.makeBy(Math.ceil(s.length / n), (i) => s.slice(i * n, i * n + n));

const tokenizeChunks = (chunks: ReadonlyArray<string>, options?: Sax.SaxOptions) =>
  Stream.fromIterable(chunks).pipe(Sax.tokenize(options), Stream.runCollect);

const collectChunks = (chunks: ReadonlyArray<string>, options?: Sax.SaxOptions) =>
  Effect.runPromise(tokenizeChunks(chunks, options));

describe("Sax — true incremental streaming", () => {
  const document =
    `<?xml version="1.0"?>` +
    `<catalog xmlns:p="urn:p">` +
    `<p:product sku="123" tag='a&amp;b'>` +
    `<name>Laptop &lt;Pro&gt;</name>` +
    `<!-- a comment --><![CDATA[raw <data>]]>` +
    `</p:product>` +
    `</catalog>`;

  test("result is identical regardless of chunk boundaries", async () => {
    const whole = await collectChunks([document]);

    // Every chunk size from 1 to the full length must produce the same events,
    // including the same spans — this is the core promise the old parser broke.
    await Effect.runPromise(
      Effect.forEach(
        Arr.range(1, document.length),
        (size) =>
          tokenizeChunks(splitEvery(document, size)).pipe(
            Effect.map((chunked) => expect(chunked).toStrictEqual(whole)),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });

  test("splits in the middle of a multi-char delimiter are safe", async () => {
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
    await Effect.runPromise(
      Effect.forEach(
        cases,
        (chunks) =>
          Effect.zip(tokenizeChunks([chunks.join("")]), tokenizeChunks(chunks)).pipe(
            Effect.map(([joined, split]) => expect(split).toStrictEqual(joined)),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });

  test("a character XML does not allow fails the same way for every chunk size", async () => {
    const input = "<a><b>x</b>y\u000Cz</a>";
    const whole = await Effect.runPromise(Effect.flip(tokenizeChunks([input])));
    expect(whole.message).toContain("at 1:13");
    await Effect.runPromise(
      Effect.forEach(
        Arr.range(1, input.length),
        (size) =>
          Effect.flip(tokenizeChunks(splitEvery(input, size))).pipe(
            Effect.map((error) => expect(error).toStrictEqual(whole)),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });

  test("entity split across chunk boundary still decodes", async () => {
    const evs = await collectChunks(["<a>x &a", "mp; y</a>"]);
    expect(narrowAt(evs, 1, Sax.isText).data).toBe("x & y");
  });
});
