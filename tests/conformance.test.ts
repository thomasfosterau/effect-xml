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
/// <reference types="vite-plus/client" />
import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import { Html } from "../src/index.ts";
import { type Html5libTest, isUnsupported, parseDat, serializeTree } from "./support/html5lib.ts";

/** Every `.dat` fixture's text, keyed by its path relative to this file. */
const SOURCES = import.meta.glob<string>("./fixtures/html5lib/*.dat", {
  query: "?raw",
  import: "default",
  eager: true,
});

interface Fixture {
  /** The file name without `.dat`. */
  readonly file: string;
  readonly content: string;
}

/** The fixture files in name order. */
const FILES: ReadonlyArray<Fixture> = Arr.sort(
  Arr.map(Record.toEntries(SOURCES), ([path, content]): Fixture => ({
    file: path.replace(/^.*\//, "").replace(/\.dat$/, ""),
    content,
  })),
  Order.mapInput(Order.String, (f: Fixture) => f.file),
);

// Observed pass count over the runnable (supported-feature) subset.
const BASELINE = 1368;
const RUNNABLE = 1368;

/** A file's cases that exercise only supported features. */
const runnableTests = (content: string): ReadonlyArray<Html5libTest> =>
  Arr.filter(parseDat(content), (t) => !isUnsupported(t));

/** Our tree for a case in html5lib notation, or `THREW: <message>` when parsing failed. */
const render = (t: Html5libTest): string =>
  Exit.match(Effect.runSyncExit(Html.parseDocument(t.data).pipe(Effect.map(serializeTree))), {
    onSuccess: (tree) => tree,
    onFailure: (cause) => {
      const error = Cause.squash(cause);
      return "THREW: " + (Predicate.isError(error) ? error.message : String(error));
    },
  });

describe("html5lib tree-construction conformance", () => {
  test("meets the pass-count baseline", () => {
    const perFile = Arr.map(FILES, ({ file, content }) => {
      const tests = runnableTests(content);
      return {
        file,
        runnable: tests.length,
        passed: Arr.filter(tests, (t) => render(t) === t.document).length,
      };
    });
    const runnable = Arr.reduce(perFile, 0, (n, f) => n + f.runnable);
    const passed = Arr.reduce(perFile, 0, (n, f) => n + f.passed);

    Effect.runSync(
      Console.log(
        `html5lib: ${passed}/${runnable} passed (${((100 * passed) / runnable).toFixed(1)}%)\n` +
          Arr.map(perFile, (f) => `${f.file}: ${f.passed}/${f.runnable}`).join("\n"),
      ),
    );

    expect(runnable).toBe(RUNNABLE);
    expect(passed).toBeGreaterThanOrEqual(BASELINE);
  });

  test("never throws on any supported case", async () => {
    await Effect.runPromise(
      Effect.forEach(
        Arr.flatMap(FILES, ({ content }) => runnableTests(content)),
        // Should always produce an <html>-rooted document, even for malformed input.
        (t) =>
          Html.parseDocument(t.data).pipe(
            Effect.map((doc) => expect(doc.root.name.local).toBe("html")),
          ),
        { concurrency: 1, discard: true },
      ),
    );
  });
});
