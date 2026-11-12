import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Html, Limits, Sax, Xml, type SaxError } from "../src/index.ts";
import { splitEvery } from "./support/chunks.ts";
import { some } from "./support/narrow.ts";

/** Run an effect that must fail with LimitExceeded, within a time budget, and return the error. */
const limitFailure = (effect: Effect.Effect<unknown, SaxError>, budgetMs = 5000) =>
  Effect.gen(function* () {
    const start = performance.now();
    const r = yield* Effect.result(effect);
    expect(performance.now() - start).toBeLessThan(budgetMs);
    assert(Result.isFailure(r), "expected failure");
    expect(r.failure._tag).toBe("LimitExceeded");
    assert(P.isTagged(r.failure, "LimitExceeded"));
    return r.failure;
  });

const deep = (n: number) => "<a>".repeat(n) + "x" + "</a>".repeat(n);

describe("resource limits", () => {
  it.effect("100,000 levels of nesting: a typed failure, not a stack overflow", () =>
    Effect.gen(function* () {
      const e = yield* limitFailure(Xml.parse(deep(100_000)));
      expect(e.limit).toBe("maxDepth");
      expect(e.max).toBe(Limits.defaultLimits.maxDepth);
      expect(some(e.position)).toEqual({ offset: 3072, line: 1, column: 3073 });
    }),
  );

  it.effect("100,000 levels while streaming", () =>
    Effect.gen(function* () {
      const chunks = splitEvery(deep(100_000), 4096);
      const e = yield* limitFailure(Stream.fromIterable(chunks).pipe(Xml.parseStream()));
      expect(e.limit).toBe("maxDepth");
    }),
  );

  it.effect("100,000 levels of HTML, document and fragment", () =>
    Effect.gen(function* () {
      const html = "<div>".repeat(100_000);
      expect((yield* limitFailure(Html.parseDocument(html))).limit).toBe("maxDepth");
      expect((yield* limitFailure(Html.parseFragment(html))).limit).toBe("maxDepth");
      expect((yield* limitFailure(Stream.make(html).pipe(Html.parseDocumentStream()))).limit).toBe(
        "maxDepth",
      );
    }),
  );

  it.effect("HTML depth is the tree's, not the count of unclosed tags", () =>
    Effect.gen(function* () {
      // Each <p> closes the previous one, so the tree stays shallow.
      const doc = yield* Html.parseDocument("<p>x".repeat(5000));
      expect(doc.documentElement.textContent.length).toBe(5000);
    }),
  );

  it.effect("deep HTML within the limit builds, serializes, converts and reads text", () =>
    Effect.gen(function* () {
      // Deeper than any call stack: tree construction's scope checks skip the
      // walk when no open element bears the name, so this stays linear (#81).
      const input = "<div>".repeat(100_000) + "x";
      const doc = yield* Html.parseDocument(input, { limits: { maxDepth: Infinity } });
      expect(doc.documentElement.textContent).toBe("x");
      expect(doc.documentElement.descendants("div").length).toBe(100_000);
      const serialized = Html.serialize(doc);
      expect(serialized.length).toBeGreaterThan(input.length);
      expect(Html.toXml(doc).root.textContent).toBe("x");
      // The lenient builder, too.
      const deeper = "<div>".repeat(100_000) + "x";
      const nodes = yield* Html.parseFragment(deeper, { limits: { maxDepth: Infinity } });
      expect(Html.serializeFragment(nodes).length).toBeGreaterThan(deeper.length);
      const [root] = Html.toXml(nodes);
      expect(root?._tag === "XmlElement" && root.textContent).toBe("x");
    }),
  );

  it.effect("deep nesting within the limit still parses, serializes and reads text", () =>
    Effect.gen(function* () {
      const doc = yield* Xml.parse(deep(50_000), { limits: { maxDepth: Infinity } });
      expect(doc.root.textContent).toBe("x");
      expect(Xml.serialize(doc.root)).toBe(deep(50_000));
    }),
  );

  it.effect("a huge attribute list", () =>
    Effect.gen(function* () {
      const attrs = Array.from({ length: 100_000 }, (_, i) => ` a${i}="v"`).join("");
      const e = yield* limitFailure(Xml.parse(`<a${attrs}/>`));
      expect(e.limit).toBe("maxAttributes");
    }),
  );

  it.effect("a megabyte-long element name", () =>
    Effect.gen(function* () {
      const name = "n".repeat(1024 * 1024);
      expect((yield* limitFailure(Xml.parse(`<${name}/>`))).limit).toBe("maxNameLength");
    }),
  );

  it.effect("a megabyte-long attribute name", () =>
    Effect.gen(function* () {
      const name = "n".repeat(1024 * 1024);
      expect((yield* limitFailure(Xml.parse(`<a ${name}="1"/>`))).limit).toBe("maxNameLength");
    }),
  );

  it.effect("text longer than maxTextLength", () =>
    Effect.gen(function* () {
      const e = yield* limitFailure(
        Xml.parse(`<a>${"x".repeat(2000)}</a>`, { limits: { maxTextLength: 1000 } }),
      );
      expect(e.limit).toBe("maxTextLength");
    }),
  );

  it.effect("an unfinished token is not buffered past maxTextLength", () =>
    Effect.gen(function* () {
      // A comment that never ends, streamed: fail once it outgrows the limit
      // (give or take the stream's batching), instead of buffering forever.
      let pulled = 0;
      const chunks = Stream.make("<a><!--").pipe(
        Stream.concat(
          Stream.forever(
            Stream.fromEffect(
              Effect.sync(() => {
                pulled++;
                return "x".repeat(1000);
              }),
            ),
          ),
        ),
      );
      const e = yield* limitFailure(
        chunks.pipe(Xml.parseStream({ limits: { maxTextLength: 50_000 } })),
      );
      expect(e.limit).toBe("maxTextLength");
      expect(pulled).toBeLessThan(10_000);
    }),
  );

  it.effect("maxTotalBytes, for strings and bytes", () =>
    Effect.gen(function* () {
      const doc = `<a>${"x".repeat(100)}</a>`;
      expect((yield* limitFailure(Xml.parse(doc, { limits: { maxTotalBytes: 50 } }))).limit).toBe(
        "maxTotalBytes",
      );
      const bytes = new TextEncoder().encode(doc);
      expect(
        (yield* limitFailure(Xml.parseBytes(bytes, { limits: { maxTotalBytes: 50 } }))).limit,
      ).toBe("maxTotalBytes");
    }),
  );

  it.effect("limits apply to the SAX stream", () =>
    Effect.gen(function* () {
      const e = yield* limitFailure(
        Sax.tokenizeString(`<a b="1" c="2"/>`, { limits: { maxAttributes: 1 } }).pipe(
          Stream.runDrain,
        ),
      );
      expect(e.limit).toBe("maxAttributes");
    }),
  );

  it.effect("unlimited switches every limit off", () =>
    Effect.gen(function* () {
      const doc = yield* Xml.parse(`<a b="1" c="2">${"x".repeat(100)}</a>`, {
        limits: Limits.unlimited,
      });
      expect(doc.root.attributes.length).toBe(2);
    }),
  );
});
