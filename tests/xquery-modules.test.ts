/**
 * Library modules and `import module`: sources given at compile time
 * (`CompileOptions.modules`) or fetched through the `Resolver`, `%private`,
 * cyclic imports, and the static errors of imports (`XQST0034`, `XQST0048`,
 * `XQST0049`, `XQST0059`, `XQST0088`).
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { XQuery } from "../src/index.ts";
import { some } from "./support/narrow.ts";

const a = "urn:a";
const b = "urn:b";

const libA = `module namespace a = "${a}";
import module namespace b = "${b}";
declare variable $a:greeting := "hello";
declare %private function a:secret() { "secret" };
declare function a:greet($who) { $a:greeting || ", " || $who || b:mark() };
declare function a:reveal() { a:secret() };`;

const libB = `module namespace b = "${b}";
import module namespace a = "${a}";
declare function b:mark() { "!" };
declare function b:twice() { a:greet("b") || a:greet("b") };`;

const sourcesOf = (uri: string): ReadonlyArray<XQuery.ModuleSource> =>
  uri === a ? [{ text: libA }] : uri === b ? [{ text: libB }] : [];

const modules = { [a]: sourcesOf(a), [b]: sourcesOf(b) };

const compileCode = (
  query: string,
  given: XQuery.CompileOptions["modules"] = modules,
): string | undefined =>
  Result.match(XQuery.compile(query, { modules: given }), {
    onFailure: (e) => e.code.local,
    onSuccess: () => undefined,
  });

const evaluate = (query: string, resolver?: XQuery.ResourceResolver) => {
  const run = XQuery.evaluate(query);
  return Effect.runSync(
    Effect.exit(
      resolver === undefined ? run : Effect.provideService(run, XQuery.Resolver, resolver),
    ),
  );
};

const strings = (exit: ReturnType<typeof evaluate>): ReadonlyArray<string> => {
  assert(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "");
  return exit.value.map((i) => (XQuery.isAtomic(i) ? XQuery.atomicString(i) : i._tag));
};

const failure = (exit: ReturnType<typeof evaluate>): string => {
  assert(Exit.isFailure(exit));
  return some(Exit.findErrorOption(exit)).code.local;
};

const fetching: XQuery.ResourceResolver = {
  ...XQuery.staticResolver({}),
  module: (uri) => Effect.succeed(sourcesOf(uri)),
};

describe("import module", () => {
  test("modules given at compile time, importing each other in a cycle", () => {
    const query = XQuery.compile(
      `import module namespace a = "${a}"; import module namespace b = "${b}"; (a:greet("you"), b:twice())`,
      { modules },
    );
    assert(Result.isSuccess(query), Result.isFailure(query) ? query.failure.message : "");
    expect(strings(Effect.runSync(Effect.exit(XQuery.evaluate(query.success))))).toEqual([
      "hello, you!",
      "hello, b!hello, b!",
    ]);
  });

  test("modules fetched through the Resolver, transitively", () => {
    expect(strings(evaluate(`import module namespace a = "${a}"; a:greet("x")`, fetching))).toEqual(
      ["hello, x!"],
    );
    expect(failure(evaluate(`import module namespace a = "${a}"; a:greet("x")`))).toBe("XQST0059");
  });

  test("%private functions are not visible outside their module", () => {
    expect(compileCode(`import module namespace a = "${a}"; a:secret()`)).toBe("XPST0017");
    expect(compileCode(`import module namespace a = "${a}"; a:reveal()`)).toBeUndefined();
    expect(strings(evaluate(`import module namespace a = "${a}"; a:reveal()`, fetching))).toEqual([
      "secret",
    ]);
  });

  test("the static errors of imports", () => {
    expect(compileCode(`import module namespace c = "urn:c"; 1`)).toBe("XQST0059");
    expect(
      compileCode(`import module namespace a = "${a}"; declare function a:greet($x) { 1 }; 1`),
    ).toBe("XQST0034");
    expect(
      compileCode(`import module namespace a = "${a}"; declare variable $a:greeting := 1; 1`),
    ).toBe("XQST0049");
    expect(
      compileCode(`import module namespace c = "urn:c"; 1`, {
        "urn:c": [{ text: `module namespace c = "urn:c"; declare function a:f() { 1 };` }],
      }),
    ).toBe("XPST0081");
    expect(
      compileCode(`import module namespace c = "urn:c"; 1`, {
        "urn:c": [
          {
            text: `module namespace c = "urn:c"; declare namespace d = "urn:d"; declare function d:f() { 1 };`,
          },
        ],
      }),
    ).toBe("XQST0048");
    expect(
      compileCode(`import module namespace c = "urn:c"; 1`, {
        "urn:c": [{ text: `module namespace c = "";` }],
      }),
    ).toBe("XQST0088");
    // Without module sources, an imported namespace is not checked until evaluation.
    expect(Result.isSuccess(XQuery.compile(`import module namespace c = "urn:c"; c:f()`))).toBe(
      true,
    );
  });
});
