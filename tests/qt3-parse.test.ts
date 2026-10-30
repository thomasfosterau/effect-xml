/**
 * The parse-only pass over the W3C QT3 test suite: every runnable test's
 * query is compiled (`XQuery.compile` for XQuery 3.1, `XQuery.XPath.compile`
 * for XPath 3.1) in its environment's static context, without evaluating it,
 * and the result is compared with what the test expects.
 *
 * Two counts per language and test set, recorded in
 * `tests/qt3-parse.baseline.json`, may only go up:
 *
 * - `syntax`: the parser agrees with the test about `XPST0003`. A test that
 *   expects only `XPST0003` must fail with it, and every other test must not
 *   (unless it accepts `XPST0003` as one outcome).
 * - `static`: compiling agrees with the test: a static error is one the test
 *   accepts, and a query that compiles is one that can succeed or fail only
 *   when evaluated.
 *
 * `QT3_REPORT=1` lists the disagreements and prints the counts as a new
 * baseline.
 */
import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { XQuery } from "../src/index.ts";
import * as Fixtures from "./support/fixtures.ts";
import {
  Assertion,
  type Environment,
  notApplicable,
  readCatalog,
  SPECS,
  type Spec,
  type TestCase,
} from "./support/qt3.ts";

const Counts = Schema.Struct({
  runnable: Schema.Number,
  syntax: Schema.Number,
  static: Schema.Number,
});
type Counts = typeof Counts.Type;
const Baseline = Schema.fromJsonString(
  Schema.Struct({
    XQ31: Schema.Record(Schema.String, Counts),
    XP31: Schema.Record(Schema.String, Counts),
  }),
);
const encodeCounts = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Counts))),
);
const readBaseline = Fixtures.readText(
  new URL("./", import.meta.url),
  "qt3-parse.baseline.json",
).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Baseline)));

/** What a test's expected result allows: the error codes it accepts, and whether a value is one of its outcomes. */
interface Expected {
  readonly codes: ReadonlyArray<string>;
  readonly value: boolean;
}

/** The outcomes an assertion tree accepts: `any-of` is a union; anything but an error is a value. */
const expected = (a: Assertion): Expected =>
  Assertion.$match(a, {
    AnyOf: ({ of }) =>
      Arr.reduce(of.map(expected), { codes: [], value: false } as Expected, (x, y) => ({
        codes: [...x.codes, ...y.codes],
        value: x.value || y.value,
      })),
    Error: ({ code }) => ({ codes: [code.replace(/^err:/, "")], value: false }),
    AssertSerializationError: ({ code }) => ({ codes: [code.replace(/^err:/, "")], value: true }),
    AllOf: () => ({ codes: [], value: true }),
    Not: () => ({ codes: [], value: true }),
    Assert: () => ({ codes: [], value: true }),
    AssertEq: () => ({ codes: [], value: true }),
    AssertDeepEq: () => ({ codes: [], value: true }),
    AssertPermutation: () => ({ codes: [], value: true }),
    AssertStringValue: () => ({ codes: [], value: true }),
    AssertType: () => ({ codes: [], value: true }),
    AssertCount: () => ({ codes: [], value: true }),
    AssertBoolean: () => ({ codes: [], value: true }),
    AssertXml: () => ({ codes: [], value: true }),
    AssertSerialization: () => ({ codes: [], value: true }),
    SerializationMatches: () => ({ codes: [], value: true }),
    Unknown: () => ({ codes: [], value: true }),
  });

const isStatic = (code: string): boolean => /^(XPST|XQST)/.test(code);

/** An environment's variable names as Clark names, resolving prefixes against its namespaces. */
const clark = (environment: Environment, name: string): string => {
  const colon = name.indexOf(":");
  if (colon < 0) return name;
  const prefix = name.slice(0, colon);
  const uri = Option.getOrElse(
    Option.map(
      Arr.findFirst(environment.namespaces, (b) => b.prefix === prefix),
      (b) => b.uri,
    ),
    () => "",
  );
  return `{${uri}}${name.slice(colon + 1)}`;
};

/** The static context a test's environment gives its query. */
const optionsOf = (test: TestCase, environment: Environment): XQuery.CompileOptions => ({
  namespaces: Record.fromEntries(environment.namespaces.map((b) => [b.prefix, b.uri] as const)),
  variables: [
    ...environment.params.filter((p) => !p.declared).map((p) => clark(environment, p.name)),
    ...environment.sources.flatMap((s) =>
      Option.toArray(
        Option.map(
          Option.filter(s.role, (r) => r.startsWith("$")),
          (r) => clark(environment, r.slice(1)),
        ),
      ),
    ),
  ],
  baseUri: Option.getOrElse(
    Option.getOrElse(environment.staticBaseUri, () => Option.some(test.base.href)),
    () => undefined,
  ),
  collations: environment.collations.map((c) => c.uri),
  opaqueNamespaces: test.modules.map((m) => m.uri),
});

interface Verdict {
  readonly set: string;
  readonly name: string;
  readonly syntax: Option.Option<string>;
  readonly static: Option.Option<string>;
}

/** The `err:` code compiling a query fails with, if it does. */
const compileCode = (spec: Spec, test: TestCase, query: string): Option.Option<string> => {
  const options = Result.match(test.environment, {
    onFailure: (): XQuery.CompileOptions => ({}),
    onSuccess: (environment) => optionsOf(test, environment),
  });
  const compiled =
    spec === "XQ31" ? XQuery.compile(query, options) : XQuery.XPath.compile(query, options);
  return Result.match(compiled, {
    onFailure: (e) => Option.some(e.code.local),
    onSuccess: () => Option.none(),
  });
};

const accepts = (want: Expected, code: string): boolean =>
  Arr.contains(want.codes, code) || Arr.contains(want.codes, "*");

/** Whether the parser agrees about `XPST0003`. */
const syntaxAgrees = (want: Expected, code: Option.Option<string>): boolean => {
  const syntaxOnly =
    !want.value &&
    Arr.isReadonlyArrayNonEmpty(want.codes) &&
    want.codes.every((c) => c === "XPST0003");
  return syntaxOnly
    ? Option.contains(code, "XPST0003")
    : !Option.contains(code, "XPST0003") || accepts(want, "XPST0003");
};

/** Whether compiling agrees: an accepted static error, or a query whose outcome is decided by evaluating it. */
const staticAgrees = (want: Expected, code: Option.Option<string>): boolean =>
  Option.match(code, {
    onSome: (c) => accepts(want, c),
    onNone: () => want.value || want.codes.some((c) => c === "*" || !isStatic(c)),
  });

/** Compile one test's query and compare the result with what it expects. */
const judge = (spec: Spec, test: TestCase, query: string): Verdict => {
  const code = compileCode(spec, test, query);
  const want = expected(test.result);
  const why = `expected ${want.value ? "a value or " : ""}${want.codes.join(" | ") || "no error"}, got ${Option.getOrElse(code, () => "a query that compiles")}`;
  return {
    set: test.set,
    name: test.name,
    syntax: syntaxAgrees(want, code) ? Option.none() : Option.some(why),
    static: staticAgrees(want, code) ? Option.none() : Option.some(why),
  };
};

const runSpec = (spec: Spec, tests: ReadonlyArray<TestCase>) =>
  Effect.forEach(
    tests.filter((t) => Option.isNone(notApplicable(spec, t))),
    (t) =>
      Effect.map(
        t.query._tag === "Inline"
          ? Effect.succeed(t.query.text)
          : Fixtures.readText(t.query.file, ""),
        (query) => judge(spec, t, query),
      ),
    { concurrency: 1 },
  );

const countsBySet = (verdicts: ReadonlyArray<Verdict>): Record<string, Counts> =>
  Arr.reduce(verdicts, {} as Record<string, Counts>, (counts, v) => {
    const c = counts[v.set] ?? { runnable: 0, syntax: 0, static: 0 };
    return {
      ...counts,
      [v.set]: {
        runnable: c.runnable + 1,
        syntax: c.syntax + (Option.isNone(v.syntax) ? 1 : 0),
        static: c.static + (Option.isNone(v.static) ? 1 : 0),
      },
    };
  });

/** Every way a run falls short of its baseline. */
const shortfalls = (
  spec: Spec,
  baseline: Readonly<Record<string, Counts>>,
  counts: Readonly<Record<string, Counts>>,
): ReadonlyArray<string> =>
  Record.toEntries(baseline).flatMap(([set, want]) => {
    const got = counts[set] ?? { runnable: 0, syntax: 0, static: 0 };
    return (["runnable", "syntax", "static"] as const).flatMap((k) =>
      got[k] < want[k] ? [`${spec} ${set}: ${k} ${got[k]}, baseline ${want[k]}`] : [],
    );
  });

const sum = (counts: Record<string, Counts>): Counts =>
  Arr.reduce(Record.values(counts), { runnable: 0, syntax: 0, static: 0 }, (a, c) => ({
    runnable: a.runnable + c.runnable,
    syntax: a.syntax + c.syntax,
    static: a.static + c.static,
  }));

describe("W3C QT3 parse-only pass", () => {
  test("meets the per-test-set parse baselines", async () => {
    const started = performance.now();
    const { baseline, results } = await Effect.runPromise(
      Effect.gen(function* () {
        const want = yield* readBaseline;
        const sets = yield* readCatalog();
        const tests = sets.flatMap((s) => s.cases);
        const verdicts = yield* Effect.forEach(
          SPECS,
          (spec) => Effect.map(runSpec(spec, tests), (vs) => [spec, vs] as const),
          { concurrency: 1 },
        );
        return { baseline: want, results: verdicts };
      }).pipe(Effect.provide(Fixtures.layer)),
    );
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const counts = Record.fromEntries(
      results.map(([spec, verdicts]) => [spec, countsBySet(verdicts)] as const),
    );
    const report = process.env.QT3_REPORT !== undefined && process.env.QT3_REPORT !== "";
    await Effect.runPromise(
      Effect.all(
        [
          report
            ? Console.log(
                results
                  .flatMap(([spec, verdicts]) =>
                    verdicts.flatMap((v) =>
                      Option.toArray(
                        Option.map(
                          Option.orElse(v.syntax, () => v.static),
                          (why) => `${spec} ${v.set}/${v.name}: ${why}`,
                        ),
                      ),
                    ),
                  )
                  .join("\n"),
              )
            : Effect.void,
          report ? Console.log(encodeCounts(counts)) : Effect.void,
          Console.log(
            `qt3 parse: ${seconds}s; ` +
              SPECS.map((spec) => {
                const t = sum(counts[spec] ?? {});
                return `${spec} syntax ${t.syntax}/${t.runnable}, static ${t.static}/${t.runnable}`;
              }).join("; "),
          ),
        ],
        { concurrency: 1 },
      ),
    );
    expect([
      ...shortfalls("XQ31", baseline.XQ31, counts["XQ31"] ?? {}),
      ...shortfalls("XP31", baseline.XP31, counts["XP31"] ?? {}),
    ]).toEqual([]);
  }, 300_000);
});
