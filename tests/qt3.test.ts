/**
 * Conformance gate against the W3C QT3 test suite (XPath 3.1 and XQuery 3.1;
 * a vendored selection, see `tests/fixtures/qt3/README.md`), and tests of the
 * harness that runs it (`tests/support/qt3.ts`).
 *
 * Each run is one language, as the suite's guide asks: XQuery 3.1 (`XQ31`)
 * and XPath 3.1 (`XP31`), each over the tests whose dependencies it meets.
 * `tests/qt3.baseline.json` records, per language and test set, how many
 * tests are runnable and how many pass; both may only go up. Raise a baseline
 * whenever a change improves it. `QT3_REPORT=1` prints the failures, every
 * test set's counts and the counts as a new baseline.
 *
 * The evaluator lands in a later phase; until then the engine is
 * `notImplemented`, every runnable test fails and the passing baselines are 0.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Xml, XQuery } from "../src/index.ts";
import * as Fixtures from "./support/fixtures.ts";
import {
  Assertion,
  check,
  codeMatches,
  type Engine,
  notApplicable,
  notImplemented,
  Outcome,
  readCatalog,
  loadDocuments,
  type Request,
  runTest,
  SPECS,
  specApplies,
  type Spec,
  type TestCase,
  type TestSet,
  type Verdict,
} from "./support/qt3.ts";

/** The engine under test. */
const ENGINE: Engine = notImplemented;

const Counts = Schema.Struct({ runnable: Schema.Number, passing: Schema.Number });
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
  const counts = Record.fromEntries(
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

/** The catalog, read once for every test in this file. */
const catalog = Effect.runPromise(readCatalog().pipe(Effect.provide(Fixtures.layer)));

const total = (counts: Record<string, Counts>): Counts =>
  Arr.reduce(Record.values(counts), { runnable: 0, passing: 0 }, (a, c) => ({
    runnable: a.runnable + c.runnable,
    passing: a.passing + c.passing,
  }));

/** Every way a run falls short of its baseline. */
const shortfalls = (
  spec: Spec,
  baseline: Readonly<Record<string, Counts>>,
  counts: Readonly<Record<string, Counts>>,
): ReadonlyArray<string> =>
  Record.toEntries(baseline).flatMap(([set, want]) => {
    const got = counts[set] ?? { runnable: 0, passing: 0 };
    const runnable = `${spec} ${set}: ${got.runnable} runnable, baseline ${want.runnable}`;
    const passing = `${spec} ${set}: ${got.passing} passing, baseline ${want.passing}`;
    return Arr.appendAll(
      Arr.filter([runnable], () => got.runnable < want.runnable),
      Arr.filter([passing], () => got.passing < want.passing),
    );
  });

describe("W3C QT3 conformance", () => {
  test("meets the per-test-set baselines", async () => {
    const started = performance.now();
    const { baseline, sets, results } = await Effect.runPromise(
      Effect.gen(function* () {
        const expected = yield* readBaseline;
        const read = yield* Effect.tryPromise(() => catalog);
        const tests = read.flatMap((s) => s.cases);
        const documents = yield* loadDocuments(tests);
        const verdicts = yield* Effect.forEach(
          SPECS,
          (spec) => runSpec(spec, tests, documents).pipe(Effect.map((vs) => [spec, vs] as const)),
          { concurrency: 1 },
        );
        return { baseline: expected, sets: read, results: verdicts };
      }).pipe(Effect.provide(Fixtures.layer)),
    );
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    const counts = Record.fromEntries(
      results.map(([spec, verdicts]) => [spec, countsBySet(sets, verdicts)] as const),
    );
    const report = process.env.QT3_REPORT !== undefined && process.env.QT3_REPORT !== "";
    const cases = sets.reduce((n, s) => n + s.cases.length, 0);
    await Effect.runPromise(
      Effect.all(
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
      ),
    );
    // Every set of the catalog is in the baseline, so a set that stops being read is noticed.
    expect(sets.map((s) => s.name).filter((name) => baseline.XQ31[name] === undefined)).toEqual([]);
    expect([
      ...shortfalls("XQ31", baseline.XQ31, counts["XQ31"] ?? {}),
      ...shortfalls("XP31", baseline.XP31, counts["XP31"] ?? {}),
    ]).toEqual([]);
  }, 300_000);
});

// -----------------------------------------------------------------------------
// The harness itself
// -----------------------------------------------------------------------------

const requestFor = (query: string): Request => ({
  spec: "XQ31",
  query,
  baseUri: Option.none(),
  namespaces: [],
  contextItem: Option.none(),
  variables: [],
  documents: HashMap.empty(),
  collections: HashMap.empty(),
  resources: HashMap.empty(),
  modules: [],
  decimalFormats: [],
  defaultCollation: Option.none(),
});

/** An engine that answers from a table of queries, and records what it was asked. */
const tableEngine = (
  table: Readonly<Record<string, XQuery.Sequence>>,
  asked: Array<Request> = [],
): Engine => ({
  evaluate: (request) => {
    asked.push(request);
    return Option.match(Option.fromUndefinedOr(table[request.query]), {
      onNone: () => Effect.fail(XQuery.xqueryError("XPST0003", `unknown query ${request.query}`)),
      onSome: Effect.succeed,
    });
  },
  serialize: (_, result) =>
    Effect.succeed(
      result.map((item) => (XQuery.isAtomic(item) ? XQuery.atomicString(item) : "")).join(" "),
    ),
});

const verdict = (assertion: Assertion, outcome: Outcome, engine: Engine = tableEngine({})) =>
  Effect.runSync(check(assertion, outcome, { engine, request: requestFor("") }));

const value = (...items: ReadonlyArray<XQuery.Item>) => Outcome.Value({ sequence: items });
const raised = (code: string) => Outcome.Raised({ error: XQuery.xqueryError(code, "boom") });
const passes = (v: Option.Option<string>) =>
  assert.isTrue(
    Option.isNone(v),
    Option.getOrElse(v, () => ""),
  );
const fails = (v: Option.Option<string>) =>
  assert.isTrue(Option.isSome(v), "expected the assertion to fail");

const str = (s: string) => XQuery.AtomicValue.string(s);
const int = (n: number) => XQuery.AtomicValue.integer(BigInt(n));

describe("QT3 harness", () => {
  test("spec dependencies: exact versions and `+` ranges", () => {
    expect(specApplies("XQ31", "XQ10+")).toBe(true);
    expect(specApplies("XQ31", "XQ30")).toBe(false);
    expect(specApplies("XQ31", "XP31+")).toBe(false);
    expect(specApplies("XP31", "XP20+ XQ10+")).toBe(true);
    expect(specApplies("XP31", "XP31 XQ31")).toBe(true);
    expect(specApplies("XP31", "XP20 XP30")).toBe(false);
    expect(specApplies("XQ31", "XT30+")).toBe(false);
  });

  test("structural assertions are checked against the XDM result", () => {
    passes(verdict(Assertion.AssertCount({ count: 0 }), value()));
    fails(verdict(Assertion.AssertCount({ count: 0 }), value(int(1))));
    passes(verdict(Assertion.AssertCount({ count: 2 }), value(int(1), int(2))));
    passes(
      verdict(Assertion.AssertBoolean({ expected: true }), value(XQuery.AtomicValue.boolean(true))),
    );
    fails(verdict(Assertion.AssertBoolean({ expected: true }), value(str("true"))));
    passes(
      verdict(
        Assertion.AssertBoolean({ expected: false }),
        value(XQuery.AtomicValue.boolean(false)),
      ),
    );
    passes(
      verdict(
        Assertion.AssertStringValue({ expected: "1 a", normalizeSpace: false }),
        value(int(1), str("a")),
      ),
    );
    passes(
      verdict(
        Assertion.AssertStringValue({ expected: " x  y ", normalizeSpace: true }),
        value(str("x y")),
      ),
    );
    fails(verdict(Assertion.AssertCount({ count: 1 }), raised("FOER0000")));
  });

  test("error codes: err: local names, EQNames and `*`", () => {
    passes(verdict(Assertion.Error({ code: "XPTY0004" }), raised("XPTY0004")));
    fails(verdict(Assertion.Error({ code: "XPTY0004" }), raised("FORG0001")));
    passes(verdict(Assertion.Error({ code: "*" }), raised("FORG0001")));
    fails(verdict(Assertion.Error({ code: "*" }), value()));
    expect(
      codeMatches("Q{http://www.example.com/}EXER3141", {
        namespace: "http://www.example.com/",
        local: "EXER3141",
      }),
    ).toBe(true);
    expect(codeMatches("Q{}USER9999", { namespace: null, local: "USER9999" })).toBe(true);
  });

  test("combinators", () => {
    const empty = Assertion.AssertCount({ count: 0 });
    const one = Assertion.AssertCount({ count: 1 });
    passes(verdict(Assertion.AnyOf({ of: [one, empty] }), value()));
    fails(verdict(Assertion.AllOf({ of: [one, empty] }), value()));
    passes(
      verdict(
        Assertion.AnyOf({ of: [Assertion.Error({ code: "FOAR0001" }), empty] }),
        raised("FOAR0001"),
      ),
    );
    passes(verdict(Assertion.Not({ of: one }), value()));
    fails(verdict(Assertion.Not({ of: empty }), value()));
  });

  test("a test the engine can't run never passes, whatever it expects", () => {
    const broken = Outcome.Broken({ reason: "not implemented" });
    fails(verdict(Assertion.Error({ code: "*" }), broken));
    fails(verdict(Assertion.Not({ of: Assertion.AssertCount({ count: 0 }) }), broken));
  });

  test("assert-xml compares nodes by expanded name, merging text and sorting attributes", () => {
    const doc = Effect.runSync(Xml.parse(`<a xmlns="u" y="2" x="1">t<![CDATA[u]]><b/></a>`));
    const node = XQuery.XdmNode.fromDocument(doc);
    passes(
      verdict(
        Assertion.AssertXml({
          expected: `<a xmlns="u" x="1" y="2">tu<b/></a>`,
          ignorePrefixes: false,
        }),
        value(node),
      ),
    );
    passes(
      verdict(
        Assertion.AssertXml({
          expected: `<p:a xmlns:p="u" x="1" y="2">tu<p:b/></p:a>`,
          ignorePrefixes: true,
        }),
        value(node),
      ),
    );
    fails(
      verdict(
        Assertion.AssertXml({ expected: `<a x="1" y="2">tu<b/></a>`, ignorePrefixes: true }),
        value(node),
      ),
    );
    passes(
      verdict(
        Assertion.AssertXml({ expected: "1 2", ignorePrefixes: false }),
        value(int(1), int(2)),
      ),
    );
  });

  test("XPath assertions are evaluated by the engine with $result bound", () => {
    const asked: Array<Request> = [];
    const engine = tableEngine(
      {
        "$result instance of xs:integer": [XQuery.AtomicValue.boolean(true)],
        "deep-equal($result, (1))": [XQuery.AtomicValue.boolean(false)],
        "(1, 2)": [int(2), int(1)],
        "deep-equal($a, $b)": [XQuery.AtomicValue.boolean(true)],
      },
      asked,
    );
    passes(verdict(Assertion.AssertType({ type: "xs:integer" }), value(int(1)), engine));
    const [first] = asked;
    assert.isDefined(first);
    const bound = Arr.findFirst(first.variables, (v) => v.name === "result");
    assert(Option.isSome(bound));
    expect(bound.value.value).toEqual([int(1)]);
    fails(verdict(Assertion.AssertDeepEq({ expr: "1" }), value(int(1)), engine));
    passes(verdict(Assertion.AssertPermutation({ expr: "(1, 2)" }), value(int(1), int(2)), engine));
    fails(verdict(Assertion.Assert({ expr: "unknown()" }), value(int(1)), engine));
  });

  test("reads the catalog: every vendored test set, with dependencies and environments", async () => {
    const sets = await catalog;
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
  });
});
