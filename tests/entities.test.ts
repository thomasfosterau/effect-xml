import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import { Sax } from "../src/index.ts";
import { isSaxError } from "../src/Error.ts";
import { at, narrowAt } from "./support/narrow.ts";

const text = (input: string, options?: Sax.SaxOptions) =>
  Effect.gen(function* () {
    const evs = yield* Sax.collect(input, options);
    return evs.find(Sax.isText)?.data;
  });

describe("entities", () => {
  it.effect("predefined XML entities", () =>
    Effect.gen(function* () {
      expect(yield* text("<a>&lt;&gt;&amp;&quot;&apos;</a>")).toBe(`<>&"'`);
    }),
  );

  it.effect("numeric decimal and hex", () =>
    Effect.gen(function* () {
      expect(yield* text("<a>&#65;&#x42;&#x1F600;</a>")).toBe("AB😀");
    }),
  );

  it.effect("entities inside attribute values", () =>
    Effect.gen(function* () {
      const events = yield* Sax.collect(`<a x="a&amp;b&#33;"/>`);
      const start = narrowAt(events, 0, Sax.isStartElement);
      expect(at(start.attributes, 0).value).toBe("a&b!");
    }),
  );

  it.effect("unknown entity is a typed error in strict (xml) mode", () =>
    Effect.gen(function* () {
      const result = yield* Sax.collect("<a>&nope;</a>").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      assert(Result.isFailure(result));
      expect(isSaxError(result.failure)).toBe(true);
      expect(result.failure._tag).toBe("InvalidEntity");
    }),
  );

  it.effect("unknown entity passes through in html mode", () =>
    Effect.gen(function* () {
      expect(yield* text("<a>&nope; &copy;</a>", { mode: "html" })).toBe("&nope; ©");
    }),
  );

  it.effect("the full WHATWG named entity set is available in html mode", () =>
    Effect.gen(function* () {
      // A spread of names beyond any hand-written subset.
      expect(yield* text("<a>&hearts;&spades;&Hat;&af;</a>", { mode: "html" })).toBe(
        "\u2665\u2660\u005E\u2061",
      );
      // Multi-code-point reference (U+2242 U+0338).
      expect(yield* text("<a>&NotEqualTilde;</a>", { mode: "html" })).toBe("\u2242\u0338");
      // Non-breaking space is a real NBSP (U+00A0), not a plain space.
      expect(yield* text("<a>&nbsp;</a>", { mode: "html" })).toBe("\u00A0");
    }),
  );

  it.effect("entity error reports a sensible position", () =>
    Effect.gen(function* () {
      const result = yield* Sax.collect("<a>\n  &bad;</a>").pipe(Effect.result);
      assert(
        Result.isFailure(result) && P.isTagged(result.failure, "InvalidEntity"),
        "expected InvalidEntity",
      );
      expect(result.failure.position).toEqual({ offset: 6, line: 2, column: 3 });
    }),
  );
});

const attrValue = (input: string) =>
  Effect.gen(function* () {
    const evs = yield* Sax.collect(input, { mode: "html" });
    const start = evs.find(Sax.isStartElement);
    assert.isDefined(start);
    return start.attributes[0]?.value;
  });

describe("entities — WHATWG lenient (html mode)", () => {
  it.effect("legacy references decode without a trailing semicolon", () =>
    Effect.gen(function* () {
      expect(yield* text("<a>x&copy y</a>", { mode: "html" })).toBe("x© y");
      expect(yield* text("<a>&AMP&LT&GT</a>", { mode: "html" })).toBe("&<>");
    }),
  );

  it.effect("maximal munch leaves the unmatched remainder (&notit; => ¬it;)", () =>
    Effect.gen(function* () {
      expect(yield* text("<a>&notit;</a>", { mode: "html" })).toBe("¬it;");
    }),
  );

  it.effect("numeric references decode without a trailing semicolon", () =>
    Effect.gen(function* () {
      expect(yield* text("<a>&#65 &#x42</a>", { mode: "html" })).toBe("A B");
    }),
  );

  it.effect("numeric references apply the Windows-1252 remap", () =>
    Effect.gen(function* () {
      // 0x80 -> EURO SIGN, 0x99 -> TRADE MARK
      expect(yield* text("<a>&#x80;&#x99;</a>", { mode: "html" })).toBe("€™");
    }),
  );

  it.effect("ambiguous ampersand: legacy ref is literal in attributes before '=' or alnum", () =>
    Effect.gen(function* () {
      expect(yield* attrValue(`<a t="q&copy=x"/>`)).toBe("q&copy=x");
      // but the semicolon form always expands, even in attributes
      expect(yield* attrValue(`<a t="q&copy;x"/>`)).toBe("q©x");
      // and in text content the legacy ref expands regardless
      expect(yield* text("<a>&copy=x</a>", { mode: "html" })).toBe("©=x");
    }),
  );
});
