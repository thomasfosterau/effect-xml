/**
 * Conformance gate against the W3C QT3 test suite (XPath 3.1 and XQuery 3.1;
 * a vendored selection, see `tests/fixtures/qt3/README.md`). The harness that
 * runs it (`tests/support/qt3.ts`) is tested in `tests/qt3-harness.test.ts`.
 *
 * Each run is one language, as the suite's guide asks: XQuery 3.1 (`XQ31`)
 * and XPath 3.1 (`XP31`), each over the tests whose dependencies it meets.
 * `tests/qt3.baseline.json` records, per language and test set, how many
 * tests are runnable and how many pass; both may only go up. Raise a baseline
 * whenever a change improves it. `QT3_REPORT=1` prints the failures, every
 * test set's counts and the counts as a new baseline.
 *
 * The engine is the library's own evaluator (`xqueryEngine`): each test's
 * query is compiled as XQuery or XPath and evaluated with `XQuery.evaluate`.
 * Constructs it does not implement yet count as failures, never as errors a
 * test may expect.
 */
import { assert, expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Fixtures from "./support/fixtures.ts";
import {
  type Engine,
  notApplicable,
  xqueryEngine,
  readCatalog,
  loadDocuments,
  runTest,
  SPECS,
  type Spec,
  type TestCase,
  type TestSet,
  type Verdict,
} from "./support/qt3.ts";
import { reportRequested } from "./support/report.ts";

/** The engine under test. */
const ENGINE: Engine = xqueryEngine;

const Counts = Schema.Struct({ runnable: Schema.Int, passing: Schema.Int });
const Baseline = Schema.fromJsonString(
  Schema.Struct({
    XQ31: Schema.Record(Schema.String, Counts),
    XP31: Schema.Record(Schema.String, Counts),
  }),
);
type Counts = typeof Counts.Type;

/** The counts as a baseline file's JSON, to paste over `tests/qt3.baseline.json`. */
const encodeCounts = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Counts))),
);

const readBaseline = Fixtures.readText(new URL("./", import.meta.url), "qt3.baseline.json").pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Baseline)),
);

/** The verdicts of every runnable test of one language. */
const runSpec = (
  spec: Spec,
  tests: ReadonlyArray<TestCase>,
  documents: Parameters<typeof runTest>[3],
) =>
  Effect.forEach(
    tests.filter((t) => Option.isNone(notApplicable(spec, t))),
    (t) => runTest(ENGINE, spec, t, documents),
    { concurrency: 1 },
  );

/** Runnable and passing counts for every test set (zero for one with no runnable tests). */
const countsBySet = (
  sets: ReadonlyArray<TestSet>,
  verdicts: ReadonlyArray<Verdict>,
): Record<string, Counts> => {
  const counts = R.fromEntries(
    sets.map((s): readonly [string, Counts] => [s.name, { runnable: 0, passing: 0 }]),
  );
  verdicts.forEach((v) => {
    const c = counts[v.set];
    if (c !== undefined)
      counts[v.set] = {
        runnable: c.runnable + 1,
        passing: c.passing + (Option.isNone(v.failure) ? 1 : 0),
      };
  });
  return counts;
};

/** The catalog, read once for the tests of the block that provides it. */
class Catalog extends Context.Service<Catalog, Effect.Success<ReturnType<typeof readCatalog>>>()(
  "tests/qt3/Catalog",
) {
  static readonly layer = Layer.effect(Catalog, readCatalog()).pipe(
    Layer.provideMerge(Fixtures.layer),
  );
}

const total = (counts: Record<string, Counts>): Counts =>
  Arr.reduce(R.values(counts), { runnable: 0, passing: 0 }, (a, c) => ({
    runnable: a.runnable + c.runnable,
    passing: a.passing + c.passing,
  }));

/** Every way a run falls short of its baseline. */
const shortfalls = (
  spec: Spec,
  baseline: Readonly<Record<string, Counts>>,
  counts: Readonly<Record<string, Counts>>,
): ReadonlyArray<string> =>
  R.toEntries(baseline).flatMap(([set, want]) => {
    const got = counts[set] ?? { runnable: 0, passing: 0 };
    const runnable = `${spec} ${set}: ${got.runnable} runnable, baseline ${want.runnable}`;
    const passing = `${spec} ${set}: ${got.passing} passing, baseline ${want.passing}`;
    return Arr.appendAll(
      Arr.filter([runnable], () => got.runnable < want.runnable),
      Arr.filter([passing], () => got.passing < want.passing),
    );
  });

/**
 * The report prints to the real console, so the test services are left out.
 * Reading the catalog is the block's setup, which can take a while on a loaded
 * machine or under coverage.
 */
layer(Catalog.layer, { excludeTestServices: true, timeout: Duration.minutes(5) })(
  "W3C QT3 conformance",
  (it) => {
    it.effect(
      "meets the per-test-set baselines",
      () =>
        Effect.gen(function* () {
          const started = performance.now();
          const baseline = yield* readBaseline;
          const sets = yield* Catalog;
          const tests = sets.flatMap((s) => s.cases);
          const documents = yield* loadDocuments(tests);
          const results = yield* Effect.forEach(
            SPECS,
            (spec) => runSpec(spec, tests, documents).pipe(Effect.map((vs) => [spec, vs] as const)),
            { concurrency: 1 },
          );
          const seconds = ((performance.now() - started) / 1000).toFixed(1);
          const counts = R.fromEntries(
            results.map(([spec, verdicts]) => [spec, countsBySet(sets, verdicts)] as const),
          );
          const report = yield* reportRequested("QT3_REPORT");
          const cases = sets.reduce((n, s) => n + s.cases.length, 0);
          yield* Effect.all(
            [
              report
                ? Console.log(
                    results
                      .flatMap(([, verdicts]) =>
                        verdicts.flatMap((v) =>
                          Option.toArray(
                            Option.map(v.failure, (f) => `${v.spec} ${v.set}/${v.name}: ${f}`),
                          ),
                        ),
                      )
                      .join("\n"),
                  )
                : Effect.void,
              report
                ? Console.log(
                    sets
                      .map(
                        (s) =>
                          `${s.name}: ${SPECS.map((spec) => {
                            const c = counts[spec]?.[s.name] ?? { runnable: 0, passing: 0 };
                            return `${spec} ${c.passing}/${c.runnable}`;
                          }).join(", ")} of ${s.cases.length}`,
                      )
                      .join("\n"),
                  )
                : Effect.void,
              report ? Console.log(encodeCounts(counts)) : Effect.void,
              Console.log(
                `qt3: ${sets.length} test sets, ${cases} test cases, ${seconds}s; ` +
                  SPECS.map((spec) => {
                    const t = total(counts[spec] ?? {});
                    return `${spec} ${t.passing} passing of ${t.runnable} runnable`;
                  }).join(", "),
              ),
            ],
            { concurrency: 1 },
          );
          // Every set of the catalog is in the baseline, so a set that stops being read is noticed.
          expect(
            sets.map((s) => s.name).filter((name) => baseline.XQ31[name] === undefined),
          ).toEqual([]);
          expect([
            ...shortfalls("XQ31", baseline.XQ31, counts["XQ31"] ?? {}),
            ...shortfalls("XP31", baseline.XP31, counts["XP31"] ?? {}),
          ]).toEqual([]);
        }),
      300_000,
    );

    it.effect(
      "reads the catalog: every vendored test set, with dependencies and environments",
      () =>
        Effect.gen(function* () {
          const sets = yield* Catalog;
          expect(sets.length).toBeGreaterThan(400);
          const abs = Arr.findFirst(sets, (s) => s.name === "fn-abs");
          assert(Option.isSome(abs));
          const first = abs.value.cases[0];
          assert.isDefined(first);
          expect(first.name).toBe("fn-absint1args-1");
          assert(first.query._tag === "Inline");
          expect(first.query.text).toBe(`fn:abs(xs:int("-2147483648"))`);
          assert(Result.isSuccess(first.environment));
          expect(Option.getOrNull(first.environment.success.name)).toBe("empty");
          // A test that needs schema import doesn't apply.
          const schemaTest = Arr.findFirst(
            sets.flatMap((s) => s.cases),
            (t) => t.dependencies.some((d) => d.type === "feature" && d.value === "schemaImport"),
          );
          assert(Option.isSome(schemaTest));
          expect(Option.isSome(notApplicable("XQ31", schemaTest.value))).toBe(true);
        }),
    );
  },
);
