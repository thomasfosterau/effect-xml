/**
 * Bundle-size budgets for the published `dist/` (#156). Run with `vp run
 * size`, which builds first.
 *
 * Each case is a consumer's program that uses one part of the library,
 * bundled from `dist/` the way the package's `exports` resolve it, with
 * esbuild (whose tree shaking is the least forgiving of the common bundlers:
 * it keeps every member of a namespace that is re-exported, and every
 * top-level statement it can't prove pure). `effect` and
 * `@thomasfosterau/effect-parse` are peers and stay external, so a budget
 * measures this package's code alone. A case fails when its minified size
 * goes over the budget, or when the output contains a marker of code it
 * should never pull in: XQuery's error codes or the XSD datatype table.
 *
 * A budget may come down when a change shrinks a case; raise one only with
 * the reason in the PR.
 */
import * as Arr from "effect/Array";
import { build } from "esbuild";

/** The repository root, where `./dist/…` resolves. */
const root = `${import.meta.dirname}/..`;

/** Code a case's output must not contain, by what it gives away. */
const markers = {
  XQuery: "XPST0003",
  XSD: "gYearMonth",
} as const;

type Marker = keyof typeof markers;

interface Case {
  readonly name: string;
  /** The consumer's program, importing a layer from `dist/` as its entry point resolves. */
  readonly source: string;
  /** Minified bytes, peers excluded. */
  readonly budget: number;
  readonly excludes: ReadonlyArray<Marker>;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "Sax.forEach",
    source: `import * as Sax from "./dist/Sax.js";
export const run = (s) => Sax.forEach(s, () => {});`,
    budget: 117_000,
    excludes: ["XQuery", "XSD"],
  },
  {
    name: "Xml.parse",
    source: `import * as Xml from "./dist/Xml.js";
export const run = (s) => Xml.parse(s);`,
    budget: 123_000,
    excludes: ["XQuery", "XSD"],
  },
];

/** `c`'s program bundled and minified, peers left external. */
const bundle = async (c: Case): Promise<string> => {
  const result = await build({
    stdin: { contents: c.source, resolveDir: root, loader: "js" },
    bundle: true,
    minify: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["effect", "@thomasfosterau/effect-parse"],
    logLevel: "error",
  });
  return Arr.map(result.outputFiles, (file) => file.text).join("");
};

/** What is wrong with `c`'s bundle, if anything. */
const problemsOf = (c: Case, output: string): Array<string> => [
  ...(output.length > c.budget ? [`${output.length} bytes, over its ${c.budget}-byte budget`] : []),
  ...c.excludes
    .filter((marker) => output.includes(markers[marker]))
    .map((marker) => `contains ${marker} code (\`${markers[marker]}\`)`),
];

/** Bundles `c`, prints its size and returns its problems. */
const check = async (c: Case): Promise<Array<string>> => {
  const output = await bundle(c);
  const problems = problemsOf(c, output);
  const status = Arr.isArrayEmpty(problems) ? "ok  " : "FAIL";
  console.log(`${status} ${c.name}: ${output.length} / ${c.budget} bytes`);
  return problems.map((p) => `${c.name}: ${p}`);
};

const failures = (await Promise.all(cases.map(check))).flat();
if (Arr.isArrayNonEmpty(failures)) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
