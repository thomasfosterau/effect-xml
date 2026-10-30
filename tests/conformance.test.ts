/**
 * Conformance gate against the official html5lib `tree-construction` tests
 * (vendored under `tests/fixtures/html5lib/`).
 *
 * Every case runs: documents through `Html.parseDocument`, `#document-fragment`
 * cases through `Html.parseDocumentFragment` in their context element, and
 * `#script-on` cases with the scripting flag set. This asserts a pass-count
 * **baseline**: the count may go up freely, but a regression fails the build.
 * Update `BASELINE` upward whenever a change improves the pass rate (and
 * `RUNNABLE` when fixtures are added). Every `.dat` file in the fixtures
 * directory is picked up automatically.
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
import * as Option from "effect/Option";
import type { SaxError } from "../src/Error.ts";
import {
  type Html5libTest,
  parseDat,
  serializeFragment,
  serializeTree,
  serializeXmlFragment,
  serializeXmlTree,
} from "./support/html5lib.ts";

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
const BASELINE = 1405;
const RUNNABLE = 1405;

/** A file's cases. */
const runnableTests = (content: string): ReadonlyArray<Html5libTest> => parseDat(content);

/**
 * Parse a case as html5lib says: a `#document-fragment` case in its context
 * element, a `#script-on` case with scripting enabled (a case with neither
 * script flag runs with scripting off), and render the result in html5lib
 * notation.
 */
const parseCase = (t: Html5libTest): Effect.Effect<string, SaxError> => {
  const scripting = t.scriptMode === "on";
  return Option.match(t.fragmentContext, {
    onNone: () => Html.parseDocument(t.data, { scripting }).pipe(Effect.map(serializeTree)),
    onSome: (context) =>
      Html.parseDocumentFragment(t.data, { context, scripting }).pipe(
        Effect.map(serializeFragment),
      ),
  });
};

/** A case's tree converted with `Html.toXml`, in html5lib notation: the same as {@link parseCase}'s. */
const parseCaseAsXml = (t: Html5libTest): Effect.Effect<readonly [string, string], SaxError> => {
  const scripting = t.scriptMode === "on";
  return Option.match(t.fragmentContext, {
    onNone: () =>
      Html.parseDocument(t.data, { scripting }).pipe(
        Effect.map((doc) => [serializeTree(doc), serializeXmlTree(Html.toXml(doc))] as const),
      ),
    onSome: (context) =>
      Html.parseDocumentFragment(t.data, { context, scripting }).pipe(
        Effect.map(
          (nodes) => [serializeFragment(nodes), serializeXmlFragment(Html.toXml(nodes))] as const,
        ),
      ),
  });
};

/** Our tree for a case in html5lib notation, or `THREW: <message>` when parsing failed. */
const render = (t: Html5libTest): string =>
  Exit.match(Effect.runSyncExit(parseCase(t)), {
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

  test("Html.toXml keeps every case's tree", () => {
    const differing = Arr.filter(
      Arr.flatMap(FILES, ({ content }) => runnableTests(content)),
      (t) => {
        const [html, xml] = Effect.runSync(parseCaseAsXml(t));
        return html !== xml;
      },
    );
    expect(Arr.map(differing, (t) => t.data)).toEqual([]);
  });

  test("never throws on any supported case", async () => {
    await expect(
      Effect.runPromise(
        Effect.forEach(
          Arr.flatMap(FILES, ({ content }) => runnableTests(content)),
          // Should always produce a tree, even for malformed input.
          (t) => Effect.asVoid(parseCase(t)),
          { concurrency: 1, discard: true },
        ),
      ),
    ).resolves.toBeUndefined();
  });
});
