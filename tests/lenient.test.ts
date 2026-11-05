/**
 * Lenient reading (`strict: false`): on every well-formed document it reads
 * what strict reading does (`Sax.forEach` events without positions, and
 * `Xml.parsePlain` trees), whole and as bytes; on malformed input it ends,
 * reading or failing, and never throws.
 */
import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Sax, Xml } from "../src/index.ts";
import { documents } from "./support/documents.ts";

const events = (doc: string | Uint8Array, options: Sax.ForEachOptions) => {
  const out: Array<Sax.SaxEvent> = [];
  const exit = Effect.runSync(Effect.exit(Sax.forEach(doc, (event) => out.push(event), options)));
  return Exit.map(exit, () => out);
};

/** Whether a lenient plain parse of `doc` fails. */
const fails = (doc: string) =>
  Exit.isFailure(Effect.runSync(Effect.exit(Xml.parsePlain(doc, { strict: false }))));

const docs = documents(5, 3000);
const wellFormed = docs.filter((doc) => Exit.isSuccess(events(doc, { positions: false })));

describe("strict: false", () => {
  test("reads the events strict reading does, of every well-formed document", () => {
    expect(wellFormed.length).toBeGreaterThan(600);
    Arr.forEach(wellFormed, (doc) =>
      expect(events(doc, { strict: false }), doc).toStrictEqual(events(doc, { positions: false })),
    );
  });

  test("builds the plain tree strict reading does, or fails the same way", () => {
    Arr.forEach(wellFormed, (doc) => {
      const lenient = Effect.runSync(Effect.exit(Xml.parsePlain(doc, { strict: false })));
      const strict = Effect.runSync(Effect.exit(Xml.parsePlain(doc)));
      // (A failure's position is counted on the input with its line ends
      // normalized: of a failure, only that there is one is compared.)
      expect(Exit.isSuccess(strict) ? lenient : Exit.isFailure(lenient), doc).toStrictEqual(
        Exit.isSuccess(strict) ? strict : true,
      );
    });
  });

  test("Xml.parse builds the tree strict reading does; a failure is the strict one", () => {
    Arr.forEach(docs, (doc) =>
      Arr.forEach([{}, { namespaces: false }, { recover: true }], (options) => {
        const lenient = Effect.runSync(Effect.exit(Xml.parse(doc, { ...options, strict: false })));
        const strict = Effect.runSync(Effect.exit(Xml.parse(doc, options)));
        // A malformed document may be read rather than rejected; otherwise
        // the two agree exactly, failures included.
        expect(
          Exit.isFailure(strict) && Exit.isSuccess(lenient) ? strict : lenient,
          doc,
        ).toStrictEqual(strict);
      }),
    );
    const bytes = new TextEncoder().encode(`<?xml version="1.0"?>\r\n<r a="1">x</r>`);
    expect(Effect.runSync(Xml.parseBytes(bytes, { strict: false }))).toStrictEqual(
      Effect.runSync(Xml.parseBytes(bytes)),
    );
  });

  test("agrees on bytes, line ends and the whitespace policy", () => {
    const doc = `<?xml version="1.0" encoding="UTF-8"?>\r\n<!DOCTYPE r SYSTEM "r.dtd">\r\n<r a="x\r\ny">\r\n  <b> t </b>\r\n</r>\r\n`;
    const bytes = new TextEncoder().encode(doc);
    const options = { whitespace: "collapse", dropWhitespaceOnlyText: true } as const;
    expect(events(bytes, { ...options, strict: false })).toStrictEqual(
      events(bytes, { ...options, positions: false }),
    );
    expect(Effect.runSync(Xml.parsePlain(bytes, { ...options, strict: false }))).toStrictEqual(
      Effect.runSync(Xml.parsePlain(bytes, options)),
    );
  });

  test("on malformed input, ends without throwing", () => {
    const malformed = docs.filter((doc) => !wellFormed.includes(doc));
    expect(malformed.length).toBeGreaterThan(600);
    Arr.forEach(malformed, (doc) => {
      expect(Exit.isExit(events(doc, { strict: false }))).toBe(true);
      expect(Exit.isExit(Effect.runSync(Effect.exit(Xml.parsePlain(doc, { strict: false }))))).toBe(
        true,
      );
    });
  });

  test("leaves unknown references, unchecked names and repeated attributes as written", () => {
    const root = Effect.runSync(
      Xml.parsePlain(`<r ×="1" a="&nope;" a="2">&nope; &amp; &#65;</r>`, { strict: false }),
    );
    expect(root).toStrictEqual({
      name: "r",
      attributes: { "×": "1", a: "2" },
      children: ["&nope; & A"],
    });
  });

  test("still fails on markup it cannot read, and on unbalanced tags", () => {
    expect(fails(`<r a=1></r>`)).toBe(true);
    expect(fails(`<r><a></r>`)).toBe(true);
    expect(fails(`<r`)).toBe(true);
    expect(Exit.isFailure(events(`<r`, { strict: false }))).toBe(true);
  });

  test("keeps the depth and total-size limits", () => {
    const deep = `${"<a>".repeat(5)}${"</a>".repeat(5)}`;
    const failure = (limits: { maxDepth?: number; maxTotalBytes?: number }) =>
      Effect.runSync(Effect.flip(Xml.parsePlain(deep, { strict: false, limits })));
    expect(failure({ maxDepth: 3 })).toMatchObject({ _tag: "LimitExceeded", limit: "maxDepth" });
    expect(failure({ maxTotalBytes: 10 })).toMatchObject({
      _tag: "LimitExceeded",
      limit: "maxTotalBytes",
    });
  });
});
