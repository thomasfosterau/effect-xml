/**
 * Conformance gate against the W3C XML Conformance Test Suite (a vendored
 * selection: XML 1.0 5th edition and Namespaces in XML 1.0, no external
 * entities; see `tests/fixtures/xmlconf/README.md`).
 *
 * Each document is parsed from its bytes, with `dtd: "internal"`:
 * - `not-wf` documents must fail;
 * - `valid` and `invalid` ones must parse (the parser doesn't validate), and
 *   where the suite gives an expected output, the document's canonical form
 *   must match it.
 *
 * Like the html5lib gate, this asserts pass-count baselines: counts may go up
 * freely, but a regression fails the build. Raise a baseline whenever a change
 * improves it. Set `XMLCONF_REPORT=1` to list the failing tests.
 */
import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Xml } from "../src/index.ts";
import * as Fixtures from "./support/fixtures.ts";
import { canonical, readManifest, type XmlconfTest } from "./support/xmlconf.ts";

const FIXTURES = new URL("./fixtures/xmlconf/", import.meta.url);

// Observed pass counts; see the gate's report for what still fails.
const BASELINE = {
  notWf: 951, // of 951
  valid: 600, // of 601
  invalid: 173, // of 175
  output: 248, // of 261
};

type Count = keyof typeof BASELINE;

/** One counted outcome of a test (none when it died), and why it failed if it did. */
interface Check {
  readonly count: Option.Option<Count>;
  readonly passed: boolean;
  readonly failure: string;
}

/** A string as a JSON literal, for failure reports. */
const quote = Schema.encodeSync(Schema.fromJsonString(Schema.String));

const check = (count: Count | null, passed: boolean, failure: string): Check => ({
  count: Option.fromNullishOr(count),
  passed,
  failure,
});

/** Parse one test's document and check the outcome against its type. */
const run = Effect.fnUntraced(function* (t: XmlconfTest) {
  const bytes = yield* Fixtures.readBytes(FIXTURES, t.uri);
  const exit = yield* Effect.exit(
    Xml.parseBytes(bytes, { dtd: "internal", namespaces: t.namespaces }),
  );
  // A defect (thrown, not a typed failure) never counts as a pass.
  if (Exit.isFailure(exit) && !Cause.hasFails(exit.cause))
    return [check(null, false, `${t.id} (${t.type}): threw ${String(Cause.squash(exit.cause))}`)];
  if (t.type === "not-wf")
    return [check("notWf", Exit.isFailure(exit), `${t.id} (not-wf): parsed — ${t.description}`)];
  const key = t.type === "valid" ? "valid" : "invalid";
  if (Exit.isFailure(exit)) {
    const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
    return [check(key, false, `${t.id} (${t.type}): ${error?.message ?? String(error)}`)];
  }
  if (t.output === undefined) return [check(key, true, "")];
  const expected = yield* Fixtures.readText(FIXTURES, t.output);
  const got = canonical(exit.value);
  return [
    check(key, true, ""),
    check("output", got === expected, `${t.id} (output): ${quote(got)} ≠ ${quote(expected)}`),
  ];
});

const tally = (checks: ReadonlyArray<Check>, passing: boolean): Record<Count, number> => {
  const counted = (key: Count) =>
    checks.filter((c) => Option.contains(c.count, key) && (!passing || c.passed)).length;
  return {
    notWf: counted("notWf"),
    valid: counted("valid"),
    invalid: counted("invalid"),
    output: counted("output"),
  };
};

describe("W3C XML conformance", () => {
  test("meets the pass-count baselines", async () => {
    const checks = await Effect.runPromise(
      readManifest(FIXTURES).pipe(
        Effect.flatMap((tests) => Effect.forEach(tests, run, { concurrency: 8 })),
        Effect.map(Arr.flatten),
        Effect.provide(Fixtures.layer),
      ),
    );
    const passed = tally(checks, true);
    const totals = tally(checks, false);
    const failures = checks.filter((c) => !c.passed).map((c) => c.failure);
    await Effect.runPromise(
      Effect.all([
        process.env.XMLCONF_REPORT ? Console.log(failures.join("\n")) : Effect.void,
        Console.log(
          `xmlconf: not-wf ${passed.notWf}/${totals.notWf}, valid ${passed.valid}/${totals.valid}, ` +
            `invalid ${passed.invalid}/${totals.invalid}, output ${passed.output}/${totals.output}`,
        ),
      ]),
    );
    expect(passed.notWf).toBeGreaterThanOrEqual(BASELINE.notWf);
    expect(passed.valid).toBeGreaterThanOrEqual(BASELINE.valid);
    expect(passed.invalid).toBeGreaterThanOrEqual(BASELINE.invalid);
    expect(passed.output).toBeGreaterThanOrEqual(BASELINE.output);
  }, 120_000);
});
