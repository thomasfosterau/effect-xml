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
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Arr from "effect/Array";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

/** esbuild failed to bundle a case. */
class BundleFailed extends Schema.TaggedError<BundleFailed, { readonly brand: unique symbol }>()(
  "BundleFailed",
  {
    case: Schema.String,
    cause: Schema.Unknown,
  },
) {}

/** Some case is over its budget or pulls in code it should not. */
class OverBudget extends Schema.TaggedError<OverBudget, { readonly brand: unique symbol }>()(
  "OverBudget",
  {
    problems: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return this.problems.join("; ");
  }
}

/** `c`'s program bundled and minified, peers left external. */
const bundle = (c: Case): Effect.Effect<string, BundleFailed> =>
  Effect.tryPromise({
    try: () =>
      build({
        stdin: { contents: c.source, resolveDir: root, loader: "js" },
        bundle: true,
        minify: true,
        write: false,
        format: "esm",
        platform: "neutral",
        external: ["effect", "@thomasfosterau/effect-parse"],
        logLevel: "error",
      }),
    catch: (cause) => new BundleFailed({ case: c.name, cause }),
  }).pipe(Effect.map((result) => Arr.map(result.outputFiles, (file) => file.text).join("")));

/** What is wrong with `c`'s bundle, if anything. */
const problemsOf = (c: Case, output: string): Array<string> => [
  ...(output.length > c.budget ? [`${output.length} bytes, over its ${c.budget}-byte budget`] : []),
  ...c.excludes
    .filter((marker) => output.includes(markers[marker]))
    .map((marker) => `contains ${marker} code (\`${markers[marker]}\`)`),
];

/** Bundles `c`, prints its size and returns its problems. */
const check = (c: Case) =>
  Effect.gen(function* () {
    const output = yield* bundle(c);
    const problems = problemsOf(c, output);
    const status = Arr.isArrayEmpty(problems) ? "ok  " : "FAIL";
    yield* Console.log(`${status} ${c.name}: ${output.length} / ${c.budget} bytes`);
    return problems.map((p) => `${c.name}: ${p}`);
  });

const main = Effect.fn("size")(function* () {
  const failures = (yield* Effect.forEach(cases, check, { concurrency: 1 })).flat();
  return yield* Arr.match(failures, {
    onEmpty: () => Effect.void,
    onNonEmpty: (problems) =>
      Console.error(problems.join("\n")).pipe(
        Effect.andThen(Effect.fail(new OverBudget({ problems }))),
      ),
  });
});

NodeRuntime.runMain(main());
