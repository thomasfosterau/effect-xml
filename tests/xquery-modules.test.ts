/**
 * Library modules and `import module`: sources given at compile time
 * (`CompileOptions.modules`) or fetched through the `Resolver`, `%private`,
 * cyclic imports, and the static errors of imports (`XQST0034`, `XQST0048`,
 * `XQST0049`, `XQST0059`, `XQST0088`).
 */
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
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

const contextLibrary = (declaration: string): XQuery.CompileOptions["modules"] => ({
  "urn:ctx": [{ text: `module namespace c = "urn:ctx"; ${declaration}` }],
});

const contextCode = (declaration: string): string | undefined =>
  compileCode(`import module namespace c = "urn:ctx"; 1`, contextLibrary(declaration));

const compileCode = (
  query: string,
  given: XQuery.CompileOptions["modules"] = modules,
): string | undefined =>
  Result.match(XQuery.compile(query, { modules: given }), {
    onFailure: (e) => e.code.local,
    onSuccess: () => undefined,
  });

const evaluate = (query: string, resolver?: XQuery.ResourceResolver) =>
  Effect.gen(function* () {
    const run = XQuery.evaluate(query);
    return yield* Effect.exit(
      resolver === undefined ? run : Effect.provideService(run, XQuery.Resolver, resolver),
    );
  });

const strings = (exit: Exit.Exit<XQuery.Sequence, XQuery.XQueryError>): ReadonlyArray<string> => {
  assert(Exit.isSuccess(exit), Exit.isFailure(exit) ? String(exit.cause) : "");
  return exit.value.map((i) => (XQuery.isAtomic(i) ? XQuery.atomicString(i) : i._tag));
};

const failure = (exit: Exit.Exit<XQuery.Sequence, XQuery.XQueryError>): string => {
  assert(Exit.isFailure(exit));
  return some(Exit.findErrorOption(exit)).code.local;
};

const fetching: XQuery.ResourceResolver = {
  ...XQuery.staticResolver({}),
  module: (uri) => Effect.succeed(sourcesOf(uri)),
};

describe("import module", () => {
  it.effect("modules given at compile time, importing each other in a cycle", () =>
    Effect.gen(function* () {
      const query = XQuery.compile(
        `import module namespace a = "${a}"; import module namespace b = "${b}"; (a:greet("you"), b:twice())`,
        { modules },
      );
      assert(Result.isSuccess(query), Result.isFailure(query) ? query.failure.message : "");
      expect(strings(yield* Effect.exit(XQuery.evaluate(query.success)))).toEqual([
        "hello, you!",
        "hello, b!hello, b!",
      ]);
    }),
  );

  it.effect("modules fetched through the Resolver, transitively", () =>
    Effect.gen(function* () {
      expect(
        strings(yield* evaluate(`import module namespace a = "${a}"; a:greet("x")`, fetching)),
      ).toEqual(["hello, x!"]);
      expect(failure(yield* evaluate(`import module namespace a = "${a}"; a:greet("x")`))).toBe(
        "XQST0059",
      );
    }),
  );

  it.effect("%private functions are not visible outside their module", () =>
    Effect.gen(function* () {
      expect(compileCode(`import module namespace a = "${a}"; a:secret()`)).toBe("XPST0017");
      expect(compileCode(`import module namespace a = "${a}"; a:reveal()`)).toBeUndefined();
      expect(
        strings(yield* evaluate(`import module namespace a = "${a}"; a:reveal()`, fetching)),
      ).toEqual(["secret"]);
    }),
  );

  it("a library module can't give the context item a value", () => {
    expect(contextCode("declare context item as xs:integer := 17;")).toBe("XQST0113");
    expect(contextCode("declare context item external := 17;")).toBe("XQST0113");
    expect(contextCode("declare context item as xs:integer external;")).toBeUndefined();
  });

  it("whitespace in a namespace URI literal is normalized", () => {
    const lib = `module namespace t = "  urn:a  b "; declare function t:ok() { "ok" };`;
    const given = { "urn:a b": [{ text: lib }] };
    expect(compileCode(`import module namespace t = "urn:a   b"; t:ok()`, given)).toBeUndefined();
  });

  it("the static errors of imports", () => {
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
