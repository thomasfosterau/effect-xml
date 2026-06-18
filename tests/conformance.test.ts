/**
 * Conformance gate against the official html5lib `tree-construction` tests
 * (vendored under `tests/fixtures/html5lib/`).
 *
 * `Html.parseDocument` does not yet implement table/select/template/foreign
 * insertion modes, so 100% is not expected. Instead this asserts a pass-count
 * **baseline**: the count may go up freely, but a regression fails the build.
 * Update `BASELINE` upward whenever a change improves the pass rate.
 */
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Html } from "../src/index.ts"
import { isUnsupported, parseDat, serialize } from "./support/html5lib.ts"

const FILES = ["tests1", "adoption01"] as const

// Observed pass count over the runnable (supported-feature) subset.
const BASELINE = 105
const RUNNABLE = 128

describe("html5lib tree-construction conformance", () => {
  test("meets the pass-count baseline", async () => {
    let runnable = 0
    let passed = 0
    const failures: Array<string> = []

    for (const file of FILES) {
      const content = await Bun.file(
        new URL(`./fixtures/html5lib/${file}.dat`, import.meta.url)
      ).text()
      const tests = parseDat(content)
      tests.forEach((t, idx) => {
        if (isUnsupported(t)) return
        runnable++
        let got: string
        try {
          const doc = Effect.runSync(Html.parseDocument(t.data))
          got = serialize(doc)
        } catch (e) {
          got = "THREW: " + (e as Error).message
        }
        if (got === t.document) passed++
        else failures.push(`${file} #${idx}: ${JSON.stringify(t.data).slice(0, 60)}`)
      })
    }

    // eslint-disable-next-line no-console
    console.log(
      `html5lib: ${passed}/${runnable} passed (${((100 * passed) / runnable).toFixed(1)}%)`
    )

    expect(runnable).toBe(RUNNABLE)
    expect(passed).toBeGreaterThanOrEqual(BASELINE)
  })

  test("never throws on any supported case", async () => {
    for (const file of FILES) {
      const content = await Bun.file(
        new URL(`./fixtures/html5lib/${file}.dat`, import.meta.url)
      ).text()
      for (const t of parseDat(content)) {
        if (isUnsupported(t)) continue
        // Should always produce a document, even for malformed input.
        const doc = await Effect.runPromise(Html.parseDocument(t.data))
        expect(doc.root.name.local).toBe("html")
      }
    }
  })
})
