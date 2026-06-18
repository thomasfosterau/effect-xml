/**
 * Conformance gate against the official html5lib `tree-construction` tests
 * (vendored under `tests/fixtures/html5lib/`).
 *
 * `Html.parseDocument` does not yet implement template/foreign insertion modes
 * (and a number of tokenizer edge states), so 100% is not expected. Instead this
 * asserts a pass-count **baseline**: the count may go up freely, but a
 * regression fails the build. Update `BASELINE` upward whenever a change
 * improves the pass rate. Every `.dat` file in the fixtures directory is picked
 * up automatically.
 */
import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { Effect } from "effect"
import { Html } from "../src/index.ts"
import { isUnsupported, parseDat, serialize } from "./support/html5lib.ts"

const FIXTURES_DIR = new URL("./fixtures/html5lib/", import.meta.url)

const FILES = readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".dat"))
  .map((f) => f.replace(/\.dat$/, ""))
  .sort()

// Observed pass count over the runnable (supported-feature) subset.
const BASELINE = 1307
const RUNNABLE = 1368

const loadTests = (file: string) =>
  Bun.file(new URL(`${file}.dat`, FIXTURES_DIR)).text().then(parseDat)

describe("html5lib tree-construction conformance", () => {
  test("meets the pass-count baseline", async () => {
    let runnable = 0
    let passed = 0
    const perFile: Array<string> = []

    for (const file of FILES) {
      const tests = await loadTests(file)
      let fileRunnable = 0
      let filePassed = 0
      for (const t of tests) {
        if (isUnsupported(t)) continue
        runnable++
        fileRunnable++
        let got: string
        try {
          got = serialize(Effect.runSync(Html.parseDocument(t.data)))
        } catch (e) {
          got = "THREW: " + (e as Error).message
        }
        if (got === t.document) {
          passed++
          filePassed++
        }
      }
      perFile.push(`${file}: ${filePassed}/${fileRunnable}`)
    }

    // eslint-disable-next-line no-console
    console.log(
      `html5lib: ${passed}/${runnable} passed (${((100 * passed) / runnable).toFixed(1)}%)\n` +
        perFile.join("\n")
    )

    expect(runnable).toBe(RUNNABLE)
    expect(passed).toBeGreaterThanOrEqual(BASELINE)
  })

  test("never throws on any supported case", async () => {
    for (const file of FILES) {
      const tests = await loadTests(file)
      for (const t of tests) {
        if (isUnsupported(t)) continue
        // Should always produce an <html>-rooted document, even for malformed input.
        const doc = await Effect.runPromise(Html.parseDocument(t.data))
        expect(doc.root.name.local).toBe("html")
      }
    }
  })
})
