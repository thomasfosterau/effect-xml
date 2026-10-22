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
import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { Xml } from "../src/index.ts"
import { canonical, type XmlconfTest } from "./support/xmlconf.ts"

const FIXTURES = new URL("./fixtures/xmlconf/", import.meta.url)

// Observed pass counts. The not-wf gap is the strict lexer accepting some
// malformed input (characters XML forbids, `--` in comments, `]]>` in text,
// valueless attributes, DTD syntax it only skims); see the gate's report.
const BASELINE = {
  notWf: 618, // of 951
  valid: 599, // of 601
  invalid: 173, // of 175
  output: 248, // of 261
}

const parse = (bytes: Uint8Array, t: XmlconfTest) =>
  Effect.runSync(
    Effect.result(Xml.parseBytes(bytes, { dtd: "internal", ...(t.namespaces === false ? { namespaces: false } : {}) }))
  )

describe("W3C XML conformance", () => {
  test(
    "meets the pass-count baselines",
    async () => {
      const tests: ReadonlyArray<XmlconfTest> = await Bun.file(new URL("manifest.json", FIXTURES)).json()
      const passed = { notWf: 0, valid: 0, invalid: 0, output: 0 }
      const totals = { notWf: 0, valid: 0, invalid: 0, output: 0 }
      const failures: Array<string> = []
      for (const t of tests) {
        const bytes = new Uint8Array(await Bun.file(new URL(t.uri, FIXTURES)).arrayBuffer())
        let result: Result.Result<Xml.XmlDocument, unknown>
        try {
          result = parse(bytes, t)
        } catch (e) {
          // A defect (thrown, not a typed failure) never counts as a pass.
          failures.push(`${t.id} (${t.type}): threw ${String(e)}`)
          continue
        }
        if (t.type === "not-wf") {
          totals.notWf++
          if (Result.isFailure(result)) passed.notWf++
          else failures.push(`${t.id} (not-wf): parsed — ${t.description}`)
          continue
        }
        const key = t.type === "valid" ? "valid" : "invalid"
        totals[key]++
        if (Result.isFailure(result)) {
          failures.push(`${t.id} (${t.type}): ${String((result.failure as Error).message ?? result.failure)}`)
          continue
        }
        passed[key]++
        if (t.output !== undefined) {
          totals.output++
          const expected = await Bun.file(new URL(t.output, FIXTURES)).text()
          if (canonical(result.success) === expected) passed.output++
          else failures.push(`${t.id} (output): ${JSON.stringify(canonical(result.success))} ≠ ${JSON.stringify(expected)}`)
        }
      }
      if (process.env.XMLCONF_REPORT) console.log(failures.join("\n"))
      console.log(
        `xmlconf: not-wf ${passed.notWf}/${totals.notWf}, valid ${passed.valid}/${totals.valid}, ` +
          `invalid ${passed.invalid}/${totals.invalid}, output ${passed.output}/${totals.output}`
      )
      expect(passed.notWf).toBeGreaterThanOrEqual(BASELINE.notWf)
      expect(passed.valid).toBeGreaterThanOrEqual(BASELINE.valid)
      expect(passed.invalid).toBeGreaterThanOrEqual(BASELINE.invalid)
      expect(passed.output).toBeGreaterThanOrEqual(BASELINE.output)
    },
    120_000
  )
})
