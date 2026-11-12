/**
 * The UCA collation URIs (F&O 3.1 §5.3.3) over `Intl.Collator`: how the URI's
 * parameters map, what falls back or fails, and every function that takes a
 * collation. The expectations are ones every ICU version agrees on; the W3C
 * suite (`tests/qt3.test.ts`) covers the rest.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { XQuery } from "../src/index.ts";
import { some } from "./support/narrow.ts";

const uca = "http://www.w3.org/2013/collation/UCA";

const show = (item: XQuery.Item): string =>
  XQuery.isAtomic(item) ? XQuery.atomicString(item) : item._tag;

const run = (query: string) => Effect.runSync(Effect.exit(XQuery.evaluate(query)));

const values = (query: string): ReadonlyArray<string> => {
  const exit = run(query);
  assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
  return exit.value.map(show);
};

const value = (query: string): string => values(query).join(" ");

const code = (query: string): string => {
  const exit = run(query);
  assert(Exit.isFailure(exit), `${query} should fail`);
  return some(Exit.findErrorOption(exit)).code.local;
};

/** `compare` of two strings under a UCA URI with the given parameters. */
const compare = (a: string, b: string, params: string): string =>
  value(`compare("${a}", "${b}", "${uca}?${params}")`);

describe("UCA collations: parameters", () => {
  test("strength is the Intl sensitivity", () => {
    expect(compare("abc", "ABC", "strength=primary")).toBe("0");
    expect(compare("abc", "ábc", "strength=primary")).toBe("0");
    expect(compare("abc", "ABC", "strength=secondary")).toBe("0");
    expect(compare("abc", "ábc", "strength=secondary")).toBe("-1");
    expect(compare("abc", "ABC", "strength=tertiary")).toBe("-1");
    expect(compare("abc", "ABC", "")).toBe("-1");
    expect(compare("abc", "abd", "strength=primary")).toBe("-1");
  });

  test("caseLevel with primary strength tells case apart", () => {
    expect(compare("abc", "ábc", "strength=primary;caseLevel=yes")).toBe("0");
    expect(compare("abc", "ABC", "strength=primary;caseLevel=yes")).toBe("-1");
  });

  test("identical adds the code points of the NFD forms", () => {
    expect(compare("abc", "abc", "strength=identical")).toBe("0");
    expect(compare("é", "é", "strength=identical")).toBe("0");
    expect(compare("a", "A", "strength=identical")).toBe("-1");
    expect(compare("a\u0000", "a", "strength=identical")).toBe("1");
  });

  test("caseFirst, numeric and alternate", () => {
    expect(compare("abc", "ABC", "caseFirst=upper")).toBe("1");
    expect(compare("abc", "ABC", "caseFirst=lower")).toBe("-1");
    expect(compare("a10", "a9", "numeric=yes")).toBe("1");
    expect(compare("a10", "a9", "numeric=no")).toBe("-1");
    expect(compare("a-b", "ab", "alternate=shifted")).toBe("0");
    expect(compare("a-b", "ab", "alternate=blanked")).toBe("0");
    expect(compare("a-b", "ab", "alternate=non-ignorable")).not.toBe("0");
  });

  test("lang picks the locale's tailoring", () => {
    expect(compare("ä", "z", "lang=de")).toBe("-1");
    expect(compare("ä", "z", "lang=sv")).toBe("1");
  });

  test("parameters are separated by semicolons and may end with one", () => {
    expect(compare("abc", "ABC", "lang=en;strength=primary;")).toBe("0");
    expect(value(`compare("abc", "ABC", "${uca}")`)).toBe("-1");
  });

  test("normalization is accepted either way", () => {
    expect(compare("é", "é", "normalization=yes;fallback=no")).toBe("0");
    expect(compare("é", "é", "normalization=no;fallback=no")).toBe("0");
  });
});

describe("UCA collations: fallback", () => {
  test("what this runtime cannot do is ignored by default", () => {
    // unknown parameter, unknown value, reorder, version and backwards=yes
    expect(compare("abc", "ABC", "keyword=unknown;strength=primary")).toBe("0");
    expect(compare("abc", "ABC", "strength=unknown")).toBe("-1");
    expect(compare("abc", "ABC", "reorder=Grek;strength=primary")).toBe("0");
    expect(compare("abc", "ABC", "version=5.0;strength=primary")).toBe("0");
    expect(compare("abc", "ABC", "backwards=yes;strength=primary")).toBe("0");
    expect(compare("abc", "ABC", "lang=zz-nonsense-x;strength=primary")).toBe("0");
    // quaternary with variable elements shifted: no fourth level, so tertiary
    expect(compare("a-b", "ab", "alternate=shifted;strength=quaternary")).toBe("0");
    expect(compare("abc", "ABC", "fallback=yes;strength=primary;maxVariable=space")).toBe("0");
  });

  test("fallback=no raises FOCH0002 for them", () => {
    const failing = [
      "keyword=unknown",
      "strength=unknown",
      "alternate=unknown",
      "backwards=unknown",
      "backwards=yes",
      "caseFirst=unknown",
      "caseLevel=unknown",
      "caseLevel=yes;strength=secondary",
      "numeric=unknown",
      "reorder=Grek",
      "version=96.5",
      "lang=zz-nonsense-x",
      "strength=quaternary;alternate=shifted",
      "alternate=shifted;maxVariable=space",
    ];
    failing.forEach((params) => {
      expect(code(`compare("a", "b", "${uca}?${params};fallback=no")`), params).toBe("FOCH0002");
    });
    expect(compare("a", "b", "strength=quaternary;fallback=no")).toBe("-1");
  });

  test("a repeated parameter or a bad fallback is never accepted", () => {
    expect(code(`compare("a", "b", "${uca}?strength=primary;strength=secondary")`)).toBe(
      "FOCH0002",
    );
    expect(code(`compare("a", "b", "${uca}?fallback=maybe")`)).toBe("FOCH0002");
  });

  test("a URI that only starts like the UCA one is another collation", () => {
    expect(code(`compare("a", "b", "${uca}x?strength=primary")`)).toBe("FOCH0002");
  });

  test("a declaration with an unsupported collation is a static error", () => {
    const exit = run(`declare default collation "${uca}?backwards=yes;fallback=no"; 1`);
    assert(Exit.isFailure(exit));
    expect(some(Exit.findErrorOption(exit)).code.local).toBe("XQST0038");
  });
});

describe("UCA collations: functions", () => {
  const primary = `'${uca}?lang=en;strength=primary'`;

  test("deep-equal, index-of, distinct-values, min and max", () => {
    expect(value(`deep-equal(("a", "B"), ("A", "b"), ${primary})`)).toBe("true");
    expect(value(`deep-equal(<a x="é">Tëxt</a>, <a x="e">Text</a>, ${primary})`)).toBe("true");
    expect(value(`index-of(("a", "B", "C", "b"), "B", ${primary})`)).toBe("2 4");
    expect(values(`distinct-values(("a", "A", "b", "á", "B"), ${primary})`)).toEqual(["a", "b"]);
    expect(value(`min(("b", "A", "c"), ${primary})`)).toBe("A");
    expect(value(`max(("b", "A", "c"), ${primary})`)).toBe("c");
    expect(values(`sort(("b", "A", "a", "B"), ${primary})`)).toEqual(["A", "a", "b", "B"]);
  });

  test("order by and group by", () => {
    expect(
      values(
        `for $x in ("b", "A", "a", "B") order by $x collation "${uca}?strength=primary" return $x`,
      ),
    ).toEqual(["A", "a", "b", "B"]);
    expect(
      values(
        `for $x in ("b", "A", "a", "B") order by $x descending collation "${uca}?lang=en;caseFirst=upper" return $x`,
      ),
    ).toEqual(["b", "B", "a", "A"]);
    expect(
      values(
        `for $x in ("a", "A", "b", "á") group by $k := $x collation "${uca}?strength=primary" return string-join($x, "")`,
      ),
    ).toEqual(["aAá", "b"]);
  });

  test("the default collation decides value comparisons, deep-equal, switch and the functions", () => {
    const prolog = `declare default collation "${uca}?strength=primary"; `;
    expect(value(`${prolog}"abc" eq "ABC"`)).toBe("true");
    expect(value(`${prolog}"abc" < "abd"`)).toBe("true");
    expect(value(`${prolog}"abc" = ("x", "ABC")`)).toBe("true");
    expect(value(`${prolog}deep-equal("é", "E")`)).toBe("true");
    expect(value(`${prolog}switch ("a") case "A" return "same" default return "other"`)).toBe(
      "same",
    );
    expect(value(`${prolog}compare("a", "A")`)).toBe("0");
    expect(value(`${prolog}default-collation()`)).toBe(`${uca}?strength=primary`);
    expect(values(`${prolog}for $x in ("b", "A", "a") order by $x return $x`)).toEqual([
      "A",
      "a",
      "b",
    ]);
    expect(value("'abc' eq 'ABC'")).toBe("false");
  });
});

describe("UCA collations: substring matching", () => {
  const c = `'${uca}?lang=en;strength=primary'`;

  test("contains, starts-with and ends-with compare substrings with the collator", () => {
    expect(value(`contains("Chapter", "APT", ${c})`)).toBe("true");
    expect(value(`contains("Chapter", "xyz", ${c})`)).toBe("false");
    expect(value(`contains("Chapter", "", ${c})`)).toBe("true");
    expect(value(`contains("", "a", ${c})`)).toBe("false");
    expect(value(`starts-with("Éclair", "ec", ${c})`)).toBe("true");
    expect(value(`starts-with("Éclair", "clair", ${c})`)).toBe("false");
    expect(value(`ends-with("Éclair", "AIR", ${c})`)).toBe("true");
    expect(value(`ends-with("Éclair", "ecl", ${c})`)).toBe("false");
  });

  test("substring-before and substring-after cut at the first match", () => {
    expect(value(`substring-before("Fooo bAr bar", "BAR", ${c})`)).toBe("Fooo ");
    expect(value(`substring-after("Fooo bAr bar", "BAR", ${c})`)).toBe(" bar");
    expect(value(`substring-before("abc", "x", ${c})`)).toBe("");
    expect(value(`substring-after("abc", "x", ${c})`)).toBe("");
    expect(value(`substring-after("abc", "", ${c})`)).toBe("abc");
    expect(value(`substring-before("abc", "", ${c})`)).toBe("");
  });

  test("matches fall on grapheme boundaries, so a base letter does not match half a cluster", () => {
    const exact = `'${uca}?lang=en;strength=tertiary'`;
    expect(value(`contains("été", "e", ${exact})`)).toBe("false");
    expect(value(`contains("été", "ét", ${exact})`)).toBe("true");
    expect(value(`contains("a😀b", "😀", ${exact})`)).toBe("true");
  });

  test("ignorable characters neither start nor end the match", () => {
    const shifted = `'${uca}?alternate=shifted;strength=primary'`;
    expect(value(`contains("a-b c", "bc", ${shifted})`)).toBe("true");
    expect(value(`substring-before("x -ab", "ab", ${shifted})`)).toBe("x -");
    expect(value(`substring-after("ab- x", "ab", ${shifted})`)).toBe("- x");
    expect(value(`contains("abc", "-", ${shifted})`)).toBe("true");
  });

  test("a numeric match does not cut a run of digits", () => {
    const numeric = `'${uca}?numeric=yes'`;
    expect(value(`contains("Chapter-100", "Chapter-10", ${numeric})`)).toBe("false");
    expect(value(`contains("Chapter-100", "Chapter-100", ${numeric})`)).toBe("true");
    expect(value(`contains("a 007 b", "7", ${numeric})`)).toBe("true");
  });

  test("the folding collations still match on the folded strings", () => {
    const html = "'http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive'";
    expect(value(`substring-before("xABCy", "bc", ${html})`)).toBe("xA");
    expect(value(`ends-with("xABC", "bc", ${html})`)).toBe("true");
  });
});

describe("UCA collations: collation keys", () => {
  test("Intl.Collator has no sort keys, so collation-key raises FOCH0004", () => {
    expect(code(`collation-key("a", "${uca}?strength=primary")`)).toBe("FOCH0004");
    expect(code(`declare default collation "${uca}"; collation-key("a")`)).toBe("FOCH0004");
  });

  test("the keys of the folding collations are unchanged", () => {
    expect(
      value(
        `collation-key("A", "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive") eq collation-key("a", "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive")`,
      ),
    ).toBe("true");
  });
});
