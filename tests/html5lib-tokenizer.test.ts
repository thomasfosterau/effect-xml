/**
 * Conformance gate against the official html5lib `tokenizer` tests (vendored
 * under `tests/fixtures/html5lib-tokenizer/`), alongside the tree-construction
 * gate in `conformance.test.ts`.
 *
 * Only tests that start in the data state are run: the SAX stream always
 * starts there. Parse errors aren't compared; a DOCTYPE's force-quirks flag
 * is (html5lib's `correctness`, its negation). As with the other
 * gates, this asserts a pass-count baseline: raise it when a change improves
 * the count. Set `HTML5LIB_REPORT=1` to list the failing tests.
 */
/// <reference types="vite-plus/client" />
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { Sax, type SaxError } from "../src/index.ts";
import { reportRequested } from "./support/report.ts";

/** Every `.test` fixture's text, keyed by its path relative to this file. */
const SOURCES = import.meta.glob<string>("./fixtures/html5lib-tokenizer/*.test", {
  query: "?raw",
  import: "default",
  eager: true,
});

const BASELINE = 2349;

type Token = ReadonlyArray<Schema.Json>;

const TokenizerTest = Schema.Struct({
  description: Schema.String,
  input: Schema.String,
  output: Schema.Array(Schema.Array(Schema.Json)),
  initialStates: Schema.optional(Schema.Array(Schema.String)),
  doubleEscaped: Schema.optional(Schema.Boolean),
});
type TokenizerTest = typeof TokenizerTest.Type;

/** A fixture file: its tests are under `tests`, or `xmlViolationTests`. */
const Suite = Schema.fromJsonString(
  Schema.Struct({
    tests: Schema.optional(Schema.Array(TokenizerTest)),
    xmlViolationTests: Schema.optional(Schema.Array(TokenizerTest)),
  }),
);
type Suite = typeof Suite.Type;

const decodeSuite = Schema.decodeUnknownSync(Suite);

/** Tokens as JSON text, for failure reports. */
const TokensJson = Schema.fromJsonString(Schema.Array(Schema.Array(Schema.Json)));
type TokensJson = typeof TokensJson.Type;
const encodeTokens = Schema.encodeSync(TokensJson);

const unescape = (s: string): string =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

const isJsonArray = (v: Schema.Json): v is Schema.JsonArray => Arr.isArray(v);
const isJsonObject = (v: Schema.Json): v is Schema.JsonObject => P.isObject(v);

const unescapeJson = (v: Schema.Json): Schema.Json =>
  P.isString(v)
    ? unescape(v)
    : isJsonArray(v)
      ? v.map(unescapeJson)
      : isJsonObject(v)
        ? R.fromEntries(R.toEntries(v).map(([k, x]) => [unescape(k), unescapeJson(x)]))
        : v;

/** A `doubleEscaped` test with its `\uXXXX` escapes decoded. */
const unescapeTest = (t: TokenizerTest): TokenizerTest => ({
  ...t,
  description: unescape(t.description),
  input: unescape(t.input),
  output: t.output.map((token) => token.map(unescapeJson)),
});

const isCharacter = (t: Token | undefined): t is readonly ["Character", string] =>
  t?.[0] === "Character" && P.isString(t[1]);

/** Merge adjacent character tokens. */
const mergeCharacters = (ts: ReadonlyArray<Token>): Array<Token> =>
  ts.reduce<Array<Token>>((out, t) => {
    const last = out.at(-1);
    if (isCharacter(t) && isCharacter(last)) out[out.length - 1] = ["Character", last[1] + t[1]];
    else out.push(t);
    return out;
  }, []);

/** The first value of each attribute name (html5lib drops repeats). */
const attributesOf = (attributes: ReadonlyArray<Sax.Attribute>): Record<string, string> =>
  R.fromEntries(attributes.toReversed().map((a) => [a.name, a.value] as const));

/** Our events in html5lib's token format, with adjacent character tokens merged. */
const tokens = (input: string): Effect.Effect<Array<Token>, SaxError> =>
  Effect.map(Sax.collect(input, { mode: "html" }), (events) =>
    mergeCharacters(
      events.flatMap(
        Match.valueTags({
          StartElement: (ev): ReadonlyArray<Token> => [
            ev.selfClosing
              ? ["StartTag", ev.name, attributesOf(ev.attributes), true]
              : ["StartTag", ev.name, attributesOf(ev.attributes)],
          ],
          EndElement: (ev): ReadonlyArray<Token> => [["EndTag", ev.name]],
          Text: (ev): ReadonlyArray<Token> => [["Character", ev.data]],
          CData: (ev): ReadonlyArray<Token> => [["Character", ev.data]],
          Comment: (ev): ReadonlyArray<Token> => [["Comment", ev.data]],
          Doctype: (ev): ReadonlyArray<Token> => [
            [
              "DOCTYPE",
              ev.name,
              Option.getOrNull(ev.publicId),
              Option.getOrNull(ev.systemId),
              !ev.forceQuirks,
            ],
          ],
          ProcessingInstruction: (): ReadonlyArray<Token> => [],
          XmlDeclaration: (): ReadonlyArray<Token> => [],
        }),
      ),
    ),
  );

/** html5lib's expected tokens, merged. */
const expected = (output: ReadonlyArray<Token>): Array<Token> => mergeCharacters(output);

/** The tests of each fixture file, in file-name order, that start in the data state. */
const runnable: ReadonlyArray<readonly [file: string, test: TokenizerTest]> = Arr.sort(
  R.toEntries(SOURCES),
  Order.mapInput(Order.String, ([path]: readonly [string, string]) => path),
).flatMap(([path, content]) => {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const suite: Suite = decodeSuite(content);
  return (suite.tests ?? suite.xmlViolationTests ?? [])
    .filter((t) => t.initialStates === undefined || t.initialStates.includes("Data state"))
    .map((t) => [file, t.doubleEscaped === true ? unescapeTest(t) : t] as const);
});

/** Why a test fails, if it does. */
const failure = (file: string, t: TokenizerTest): Effect.Effect<Option.Option<string>> =>
  Effect.map(Effect.exit(tokens(t.input)), (got) => {
    const want = expected(t.output);
    if (Exit.isFailure(got))
      return Option.some(`${file}: ${t.description}: threw ${String(got.cause)}`);
    return Eq.equals(got.value, want)
      ? Option.none()
      : Option.some(
          `${file}: ${t.description}: ${encodeTokens(got.value)} ≠ ${encodeTokens(want)}`,
        );
  });

describe("html5lib tokenizer conformance", () => {
  // The report goes to the real console, which `it.effect` replaces.
  it.live("meets the pass-count baseline", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(runnable, ([file, t]) => failure(file, t), {
        concurrency: 1,
      });
      const failures = Arr.getSomes(results);
      const passed = runnable.length - failures.length;
      if (yield* reportRequested("HTML5LIB_REPORT")) yield* Console.log(failures.join("\n"));
      yield* Console.log(`html5lib tokenizer: ${passed}/${runnable.length}`);
      expect(passed).toBeGreaterThanOrEqual(BASELINE);
    }),
  );
});
