/**
 * FLWOR expressions (`XQuery.evaluate`): `order by` (stable, descending,
 * empty least / greatest, NaN, collations), `group by`, tumbling and sliding
 * windows, `count` after reordering, `allowing empty` and positional
 * variables, and re-entrancy through recursion. The W3C suite
 * (`tests/qt3.test.ts`) covers the semantics at large.
 */
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { XQuery } from "../src/index.ts";
import { some } from "./support/narrow.ts";

const run = (query: string) => Effect.exit(XQuery.evaluate(query));

const values = (query: string) =>
  Effect.gen(function* () {
    const exit = yield* run(query);
    assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
    return exit.value.map((item) =>
      XQuery.isAtomic(item)
        ? XQuery.atomicString(item)
        : XQuery.isNode(item)
          ? item.stringValue
          : item._tag,
    );
  });

const code = (query: string) =>
  Effect.gen(function* () {
    const exit = yield* run(query);
    assert(Exit.isFailure(exit), `${query} should fail`);
    return some(Exit.findErrorOption(exit)).code.local;
  });

const joined = (query: string) =>
  Effect.gen(function* () {
    return (yield* values(query)).join(" ");
  });

describe("order by", () => {
  it.effect("ascending, descending and several keys, stably", () =>
    Effect.gen(function* () {
      expect(yield* joined(`for $x in (3, 1, 2) order by $x return $x`)).toBe("1 2 3");
      expect(yield* joined(`for $x in (3, 1, 2) order by $x descending return $x`)).toBe("3 2 1");
      expect(
        yield* joined(
          `for $p in (["b", 1], ["a", 2], ["b", 0], ["a", 1]) stable order by $p(1), $p(2) descending return $p(1) || $p(2)`,
        ),
      ).toBe("a2 a1 b1 b0");
      expect(yield* joined(`for $x in ("b", "a", "b") order by 1 return $x`)).toBe("b a b");
    }),
  );

  it.effect("empty least or greatest, NaN beside the empty sequence", () =>
    Effect.gen(function* () {
      const keys = `(3, 0, xs:double("NaN"), 1) order by (if ($x eq 0) then () else $x)`;
      expect(yield* joined(`for $x in ${keys} return string($x)`)).toBe("0 NaN 1 3");
      expect(yield* joined(`for $x in ${keys} empty greatest return string($x)`)).toBe("1 3 NaN 0");
      expect(
        yield* joined(
          `declare default order empty greatest; for $x in (2, (), 1) order by $x return $x`,
        ),
      ).toBe("1 2");
    }),
  );

  it.effect("keys: untypedAtomic as string, incomparable keys and sequences are errors", () =>
    Effect.gen(function* () {
      expect(yield* joined(`for $x in (<a>10</a>, <a>9</a>) order by $x return $x`)).toBe("10 9");
      expect(yield* code(`for $x in (1, "a") order by $x return $x`)).toBe("XPTY0004");
      expect(yield* code(`for $x in (1, 2) order by ($x, $x) return $x`)).toBe("XPTY0004");
    }),
  );

  it.effect("collations: codepoint and HTML ASCII case-insensitive", () =>
    Effect.gen(function* () {
      const html = "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive";
      expect(yield* joined(`for $x in ("b", "B", "a") order by $x return $x`)).toBe("B a b");
      expect(
        yield* joined(`for $x in ("b", "B", "a") order by $x collation "${html}" return $x`),
      ).toBe("a b B");
    }),
  );

  it.effect("count numbers the reordered tuples, positions keep their binding", () =>
    Effect.gen(function* () {
      expect(
        yield* joined(`for $x at $i in ("b", "a") order by $x count $c return $c || $x || $i`),
      ).toBe("1a2 2b1");
    }),
  );
});

describe("group by", () => {
  it.effect("grouping keys and the other variables, concatenated per group", () =>
    Effect.gen(function* () {
      expect(
        yield* joined(
          `for $x in 1 to 6 let $y := $x * 10 group by $k := $x mod 2 order by $k return $k || ":" || string-join($y, ",")`,
        ),
      ).toBe("0:20,40,60 1:10,30,50");
      expect(
        yield* joined(
          `for $x in (1, 2, 1.0, xs:double("NaN"), xs:float("NaN")) let $y := $x group by $x return count($y)`,
        ),
      ).toBe("2 1 2");
      // `group by $k := e` binds before grouping: both specs name the new $y.
      expect(
        yield* joined(`count(for $y in 1 to 10 group by $y := $y, $y := $y mod 2 return $y)`),
      ).toBe("2");
    }),
  );

  it.effect("a grouping variable's type is checked against the atomized key", () =>
    Effect.gen(function* () {
      expect(yield* code(`for $x in (<a>1</a>) group by $k as xs:string := $x return $k`)).toBe(
        "XPTY0004",
      );
      expect(
        yield* joined(`for $x in (<a>1</a>) group by $k as xs:untypedAtomic := $x return $k`),
      ).toBe("1");
      expect(yield* code(`for $x in 1 to 2 group by $k := ($x, $x) return $k`)).toBe("XPTY0004");
    }),
  );
});

/** The windows `query` binds to `$w`, each joined with commas. */
const w = (query: string) => joined(`for ${query} return string-join($w, ",")`);

describe("windows", () => {
  it.effect("tumbling windows, with and without an end condition", () =>
    Effect.gen(function* () {
      expect(
        yield* w(
          `tumbling window $w in 1 to 7 start at $s when true() end at $e when $e - $s eq 2`,
        ),
      ).toBe("1,2,3 4,5,6 7");
      expect(
        yield* w(
          `tumbling window $w in 1 to 7 start at $s when true() only end at $e when $e - $s eq 2`,
        ),
      ).toBe("1,2,3 4,5,6");
      expect(yield* w(`tumbling window $w in (1, 2, 10, 3, 11) start $x when $x ge 10`)).toBe(
        "10,3 11",
      );
      expect(
        yield* w(
          `tumbling window $w in (1, 2, 10, 3, 11) start $x when true() end next $n when $n ge 10`,
        ),
      ).toBe("1,2 10,3 11");
    }),
  );

  it.effect("sliding windows overlap", () =>
    Effect.gen(function* () {
      expect(
        yield* w(
          `sliding window $w in 1 to 4 start at $s when true() only end at $e when $e - $s eq 1`,
        ),
      ).toBe("1,2 2,3 3,4");
      expect(
        yield* w(
          `sliding window $w in 1 to 3 start $a previous $p when empty($p) or $a gt $p end $b when $b eq 3`,
        ),
      ).toBe("1,2,3 2,3 3");
    }),
  );
});

describe("FLWOR evaluation", () => {
  it.effect("allowing empty checks the declared type of the empty binding", () =>
    Effect.gen(function* () {
      expect(yield* joined(`for $x allowing empty at $i in () return ($i, count($x))`)).toBe("0 0");
      expect(yield* code(`for $x as xs:integer allowing empty in () return 1`)).toBe("XPTY0004");
    }),
  );

  it.effect("a recursive call re-entering an order by keeps its tuples apart", () =>
    Effect.gen(function* () {
      expect(
        yield* joined(
          `declare function local:f($n) { for $x in (1, 2) order by $x descending return if ($n gt 0) then local:f($n - 1) else $x }; local:f(1)`,
        ),
      ).toBe("2 1 2 1");
    }),
  );
});
