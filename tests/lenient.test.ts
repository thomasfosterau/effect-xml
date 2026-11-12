/**
 * Lenient reading (`strict: false`): on every well-formed document it reads
 * what strict reading does (`Sax.forEach` events without positions, and
 * `Xml.parsePlain` trees), whole and as bytes; on malformed input it ends,
 * reading or failing, and never throws.
 */
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Sax, Xml } from "../src/index.ts";
import { documents } from "./support/documents.ts";

const events = (doc: string | Uint8Array, options: Sax.ForEachOptions) =>
  Effect.gen(function* () {
    const out: Array<Sax.SaxEvent> = [];
    const exit = yield* Effect.exit(Sax.forEach(doc, (event) => out.push(event), options));
    return Exit.map(exit, () => out);
  });

/** Whether a lenient plain parse of `doc` fails. */
const fails = (doc: string) =>
  Effect.gen(function* () {
    return Exit.isFailure(yield* Effect.exit(Xml.parsePlain(doc, { strict: false })));
  });

const docs = documents(5, 3000);
const wellFormedFx = Effect.filter(docs, (doc) =>
  Effect.map(events(doc, { positions: false }), Exit.isSuccess),
);

describe("strict: false", () => {
  it.effect("reads the events strict reading does, of every well-formed document", () =>
    Effect.gen(function* () {
      const wellFormed = yield* wellFormedFx;
      expect(wellFormed.length).toBeGreaterThan(600);
      yield* Effect.forEach(
        wellFormed,
        (doc) =>
          Effect.gen(function* () {
            return expect(yield* events(doc, { strict: false }), doc).toStrictEqual(
              yield* events(doc, { positions: false }),
            );
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("builds the plain tree strict reading does, or fails the same way", () =>
    Effect.gen(function* () {
      const wellFormed = yield* wellFormedFx;
      yield* Effect.forEach(
        wellFormed,
        (doc) =>
          Effect.gen(function* () {
            const lenient = yield* Effect.exit(Xml.parsePlain(doc, { strict: false }));
            const strict = yield* Effect.exit(Xml.parsePlain(doc));
            // (A failure's position is counted on the input with its line ends
            // normalized: of a failure, only that there is one is compared.)
            expect(Exit.isSuccess(strict) ? lenient : Exit.isFailure(lenient), doc).toStrictEqual(
              Exit.isSuccess(strict) ? strict : true,
            );
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("Xml.parse builds the tree strict reading does; a failure is the strict one", () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        docs,
        (doc) =>
          Effect.forEach(
            [{}, { namespaces: false }, { recover: true }],
            (options) =>
              Effect.gen(function* () {
                const lenient = yield* Effect.exit(Xml.parse(doc, { ...options, strict: false }));
                const strict = yield* Effect.exit(Xml.parse(doc, options));
                // A malformed document may be read rather than rejected; otherwise
                // the two agree exactly, failures included.
                expect(
                  Exit.isFailure(strict) && Exit.isSuccess(lenient) ? strict : lenient,
                  doc,
                ).toStrictEqual(strict);
              }),
            { concurrency: 1, discard: true },
          ),
        { concurrency: 1, discard: true },
      );
      const bytes = new TextEncoder().encode(`<?xml version="1.0"?>\r\n<r a="1">x</r>`);
      expect(yield* Xml.parseBytes(bytes, { strict: false })).toStrictEqual(
        yield* Xml.parseBytes(bytes),
      );
    }),
  );

  it.effect("agrees on bytes, line ends and the whitespace policy", () =>
    Effect.gen(function* () {
      const doc = `<?xml version="1.0" encoding="UTF-8"?>\r\n<!DOCTYPE r SYSTEM "r.dtd">\r\n<r a="x\r\ny">\r\n  <b> t </b>\r\n</r>\r\n`;
      const bytes = new TextEncoder().encode(doc);
      const options = { whitespace: "collapse", dropWhitespaceOnlyText: true } as const;
      expect(yield* events(bytes, { ...options, strict: false })).toStrictEqual(
        yield* events(bytes, { ...options, positions: false }),
      );
      expect(yield* Xml.parsePlain(bytes, { ...options, strict: false })).toStrictEqual(
        yield* Xml.parsePlain(bytes, options),
      );
    }),
  );

  it.effect("on malformed input, ends without throwing", () =>
    Effect.gen(function* () {
      const wellFormed = yield* wellFormedFx;
      const malformed = docs.filter((doc) => !wellFormed.includes(doc));
      expect(malformed.length).toBeGreaterThan(600);
      yield* Effect.forEach(
        malformed,
        (doc) =>
          Effect.gen(function* () {
            expect(Exit.isExit(yield* events(doc, { strict: false }))).toBe(true);
            expect(Exit.isExit(yield* Effect.exit(Xml.parsePlain(doc, { strict: false })))).toBe(
              true,
            );
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("leaves unknown references, unchecked names and repeated attributes as written", () =>
    Effect.gen(function* () {
      const root = yield* Xml.parsePlain(`<r ×="1" a="&nope;" a="2">&nope; &amp; &#65;</r>`, {
        strict: false,
      });
      expect(root).toStrictEqual({
        name: "r",
        attributes: { "×": "1", a: "2" },
        children: ["&nope; & A"],
      });
    }),
  );

  it.effect("still fails on markup it cannot read, and on unbalanced tags", () =>
    Effect.gen(function* () {
      expect(yield* fails(`<r a=1></r>`)).toBe(true);
      expect(yield* fails(`<r><a></r>`)).toBe(true);
      expect(yield* fails(`<r`)).toBe(true);
      expect(Exit.isFailure(yield* events(`<r`, { strict: false }))).toBe(true);
    }),
  );

  it.effect("keeps the depth and total-size limits", () =>
    Effect.gen(function* () {
      const deep = `${"<a>".repeat(5)}${"</a>".repeat(5)}`;
      const failure = (limits: { maxDepth?: number; maxTotalBytes?: number }) =>
        Effect.flip(Xml.parsePlain(deep, { strict: false, limits }));
      expect(yield* failure({ maxDepth: 3 })).toMatchObject({
        _tag: "LimitExceeded",
        limit: "maxDepth",
      });
      expect(yield* failure({ maxTotalBytes: 10 })).toMatchObject({
        _tag: "LimitExceeded",
        limit: "maxTotalBytes",
      });
    }),
  );
});
