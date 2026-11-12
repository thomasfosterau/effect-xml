/**
 * `fn:resolve-uri` follows RFC 3986 §5.2 on the text as written, and nodes with
 * no parent have no base URI.
 */
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { XQuery } from "../src/index.ts";

const base = "http://a/b/c/d;p?q";

const run = (query: string) => Effect.exit(XQuery.evaluate(query));

const strings = (query: string) =>
  Effect.gen(function* () {
    const exit = yield* run(query);
    assert(Exit.isSuccess(exit), query);
    return exit.value.map((i) => (XQuery.isAtomic(i) ? XQuery.atomicString(i) : i._tag));
  });

const quote = (s: string): string => `"${s.replaceAll('"', '""')}"`;

// RFC 3986 §5.4.1 normal examples and §5.4.2 abnormal examples.
const examples: ReadonlyArray<readonly [string, string]> = [
  ["g:h", "g:h"],
  ["g", "http://a/b/c/g"],
  ["./g", "http://a/b/c/g"],
  ["g/", "http://a/b/c/g/"],
  ["/g", "http://a/g"],
  ["//g", "http://g"],
  ["?y", "http://a/b/c/d;p?y"],
  ["g?y", "http://a/b/c/g?y"],
  ["#s", "http://a/b/c/d;p?q#s"],
  ["g#s", "http://a/b/c/g#s"],
  ["g?y#s", "http://a/b/c/g?y#s"],
  [";x", "http://a/b/c/;x"],
  ["g;x", "http://a/b/c/g;x"],
  ["g;x?y#s", "http://a/b/c/g;x?y#s"],
  ["", "http://a/b/c/d;p?q"],
  [".", "http://a/b/c/"],
  ["./", "http://a/b/c/"],
  ["..", "http://a/b/"],
  ["../", "http://a/b/"],
  ["../g", "http://a/b/g"],
  ["../..", "http://a/"],
  ["../../", "http://a/"],
  ["../../g", "http://a/g"],
  ["../../../g", "http://a/g"],
  ["../../../../g", "http://a/g"],
  ["/./g", "http://a/g"],
  ["/../g", "http://a/g"],
  ["g.", "http://a/b/c/g."],
  [".g", "http://a/b/c/.g"],
  ["g..", "http://a/b/c/g.."],
  ["..g", "http://a/b/c/..g"],
  ["./../g", "http://a/b/g"],
  ["./g/.", "http://a/b/c/g/"],
  ["g/./h", "http://a/b/c/g/h"],
  ["g/../h", "http://a/b/c/h"],
  ["g;x=1/./y", "http://a/b/c/g;x=1/y"],
  ["g;x=1/../y", "http://a/b/c/y"],
  ["g?y/./x", "http://a/b/c/g?y/./x"],
  ["g?y/../x", "http://a/b/c/g?y/../x"],
  ["g#s/./x", "http://a/b/c/g#s/./x"],
  ["g#s/../x", "http://a/b/c/g#s/../x"],
];

describe("fn:resolve-uri", () => {
  it.effect.each(examples)("%j resolves to %j", ([reference, expected]) =>
    Effect.gen(function* () {
      expect(yield* strings(`resolve-uri(${quote(reference)}, ${quote(base)})`)).toEqual([
        expected,
      ]);
    }),
  );

  it.effect("keeps non-ASCII characters as written", () =>
    Effect.gen(function* () {
      expect(
        yield* strings(
          `resolve-uri(codepoints-to-string(231) || ".html", "http://www.example.com/" || codepoints-to-string(224) || ".html")`,
        ),
      ).toEqual(["http://www.example.com/\u00e7.html"]);
    }),
  );

  it.effect("merges against an authority with an empty path", () =>
    Effect.gen(function* () {
      expect(yield* strings(`resolve-uri("g", "http://a")`)).toEqual(["http://a/g"]);
    }),
  );

  it.effect.each([
    [`resolve-uri(":", "http://a/")`],
    [`resolve-uri("a%%", "http://a/")`],
    [`resolve-uri("examples", "http:%%")`],
    [`resolve-uri("g", "a/b")`],
  ] as const)("%s is an error", ([query]) =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* run(query))).toBe(true);
    }),
  );
});

describe("base-uri", () => {
  it.effect("a parentless comment, processing instruction or attribute has none", () =>
    Effect.gen(function* () {
      expect(
        yield* strings(
          `declare base-uri "http://example.com/"; (base-uri(comment { "c" }), base-uri(<?p d?>), base-uri(attribute a { "v" }))`,
        ),
      ).toEqual([]);
    }),
  );

  it.effect("a child of an element has the element's", () =>
    Effect.gen(function* () {
      expect(
        yield* strings(
          `declare base-uri "http://example.com/"; base-uri(<e><!--c--></e>/comment())`,
        ),
      ).toEqual(["http://example.com/"]);
    }),
  );

  it.effect("a declared base URI is trimmed", () =>
    Effect.gen(function* () {
      expect(yield* strings(`declare base-uri " http://example.com/ "; static-base-uri()`)).toEqual(
        ["http://example.com/"],
      );
    }),
  );

  it.effect("a relative declaration with no base to resolve against is XPST0001", () =>
    Effect.gen(function* () {
      expect(Exit.isFailure(yield* run(`declare base-uri "abc"; 1`))).toBe(true);
    }),
  );
});
