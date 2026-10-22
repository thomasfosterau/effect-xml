/**
 * Conformance gate against the official html5lib `tokenizer` tests (vendored
 * under `tests/fixtures/html5lib-tokenizer/`), alongside the tree-construction
 * gate in `conformance.test.ts`.
 *
 * Only tests that start in the data state are run: the SAX stream always
 * starts there. Parse errors aren't compared, and a DOCTYPE's force-quirks
 * flag isn't either (the SAX event has no such field). As with the other
 * gates, this asserts a pass-count baseline: raise it when a change improves
 * the count. Set `HTML5LIB_REPORT=1` to list the failing tests.
 */
import { describe, expect, test } from "vite-plus/test";
import { readdirSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import { Sax } from "../src/index.ts";

const FIXTURES = new URL("./fixtures/html5lib-tokenizer/", import.meta.url);

const BASELINE = 2349;

type Token = ReadonlyArray<unknown>;

interface TokenizerTest {
  readonly description: string;
  readonly input: string;
  readonly output: ReadonlyArray<Token>;
  readonly initialStates?: ReadonlyArray<string>;
  readonly doubleEscaped?: boolean;
}

const unescape = (s: string): string =>
  s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

const unescapeDeep = (v: unknown): unknown =>
  typeof v === "string"
    ? unescape(v)
    : Array.isArray(v)
      ? v.map(unescapeDeep)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [unescape(k), unescapeDeep(x)]))
        : v;

/** Our events in html5lib's token format, with adjacent character tokens merged. */
const tokens = (input: string): Array<Token> => {
  const out: Array<Token> = [];
  const push = (t: Token) => {
    const last = out[out.length - 1];
    if (t[0] === "Character" && last?.[0] === "Character")
      out[out.length - 1] = ["Character", (last[1] as string) + (t[1] as string)];
    else out.push(t);
  };
  for (const ev of Effect.runSync(Sax.collect(input, { mode: "html" }))) {
    switch (ev._tag) {
      case "StartElement": {
        const attrs: Record<string, string> = {};
        for (const a of ev.attributes) if (!(a.name in attrs)) attrs[a.name] = a.value;
        push(ev.selfClosing ? ["StartTag", ev.name, attrs, true] : ["StartTag", ev.name, attrs]);
        break;
      }
      case "EndElement":
        push(["EndTag", ev.name]);
        break;
      case "Text":
      case "CData":
        push(["Character", ev.data]);
        break;
      case "Comment":
        push(["Comment", ev.data]);
        break;
      case "Doctype":
        push(["DOCTYPE", ev.name, ev.publicId, ev.systemId]);
        break;
      default:
        break;
    }
  }
  return out;
};

/** html5lib's expected tokens, merged and without the force-quirks flag. */
const expected = (output: ReadonlyArray<Token>): Array<Token> => {
  const out: Array<Token> = [];
  for (const t of output) {
    const token = t[0] === "DOCTYPE" ? t.slice(0, 4) : t;
    const last = out[out.length - 1];
    if (token[0] === "Character" && last?.[0] === "Character")
      out[out.length - 1] = ["Character", (last[1] as string) + (token[1] as string)];
    else out.push(token);
  }
  return out;
};

describe("html5lib tokenizer conformance", () => {
  test("meets the pass-count baseline", async () => {
    let runnable = 0;
    let passed = 0;
    const failures: Array<string> = [];
    for (const file of readdirSync(FIXTURES)
      .filter((f) => f.endsWith(".test"))
      .sort()) {
      const json = JSON.parse(readFileSync(new URL(file, FIXTURES), "utf8"));
      const suite: ReadonlyArray<TokenizerTest> = json.tests ?? json.xmlViolationTests ?? [];
      for (const raw of suite) {
        if (raw.initialStates !== undefined && !raw.initialStates.includes("Data state")) continue;
        const t = raw.doubleEscaped ? (unescapeDeep(raw) as TokenizerTest) : raw;
        runnable++;
        let got: Array<Token>;
        try {
          got = tokens(t.input);
        } catch (e) {
          failures.push(`${file}: ${t.description}: threw ${String(e)}`);
          continue;
        }
        if (isDeepStrictEqual(got, expected(t.output))) passed++;
        else
          failures.push(
            `${file}: ${t.description}: ${JSON.stringify(got)} ≠ ${JSON.stringify(expected(t.output))}`,
          );
      }
    }
    if (process.env.HTML5LIB_REPORT) console.log(failures.join("\n"));
    console.log(`html5lib tokenizer: ${passed}/${runnable}`);
    expect(passed).toBeGreaterThanOrEqual(BASELINE);
  });
});
