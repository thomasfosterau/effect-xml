/**
 * The root Vite+ configuration: the repo-wide
 * format / lint / staged passes (read statically by `vp fmt` / `vp lint` /
 * `vp staged`), the task graph (`check`, `build`, `test:unit`,
 * `test:coverage`, `docgen`, `example`), the `vp pack` (tsdown) settings and
 * the vitest / coverage settings for the library at the root. The
 * command-line package in `packages/cli` has its own tasks and build in its
 * `vite.config.ts`, and shares the format and lint passes here.
 *
 * Adapted from the effect-web library's root `vite.config.ts` and
 * `vite.package.ts` (the family's library reference), collapsed into one file
 * because the package lives at the repository root: every comment that
 * explains a load-bearing decision is part of the standard and travels with
 * the config.
 *
 * @copyright Thomas Foster
 */

import { defineConfig } from "vite-plus";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as R from "effect/Record";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";

/**
 * Input fingerprint for the cached tasks: auto tracking minus node_modules
 * bookkeeping churn (pnpm rewrites `.modules.yaml` on every install), with the
 * lockfile back explicitly so a dependency upgrade still invalidates a
 * type-check or a test run.
 */
const cacheInputs = [{ auto: true }, "!node_modules/**", "!docs/**", "pnpm-lock.yaml"];

// The worker count CI pins (`VITEST_MAX_WORKERS`), as a `test` member only
// when it is set: vitest's own default applies otherwise.
const workers = R.getSomes({
  maxWorkers: Effect.runSync(Config.option(Config.Number("VITEST_MAX_WORKERS"))),
});

/**
 * A task of the command-line package (`packages/cli`), which the root's
 * `check`, `build` and `test:unit` run too, so CI's root tasks cover it.
 */
const cli = (task: string): string => `@thomasfosterau/effect-xml-cli#${task}`;

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    "*.{js,ts,css,json,md}": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      "**/dist/**",
      "**/docs/**",
      "**/coverage/**",
      // Vendored html5lib conformance fixtures: byte-exact upstream files.
      "tests/fixtures/**",
      // Generated from the WHATWG entity table; never edited by hand.
      "src/internal/htmlEntities.generated.ts",
      // `Xsd.generate`'s output, compared byte for byte by tests/xsd.test.ts.
      "examples/xsd/order.generated.ts",
      "tests/xsd/features.generated.ts",
    ],
    overrides: [
      {
        files: ["**/*.md"],
        options: {
          proseWrap: "never",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/docs/**", "**/coverage/**", "**/node_modules/**"],
    extends: [recommended, effect.configs.recommended],
    // oxlint's own plugins beyond the defaults: `import`, `promise`,
    // `vitest` and `jsdoc` cover what the Effect presets don't (module
    // hygiene, promise misuse in the tests and benchmark, test shape, doc
    // comment tags). `suspicious` and `perf` are on at `error` with the
    // correctness category; the rules below say where one cannot apply.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest", "jsdoc"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      "eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      // The `Buffer` global is typed `any` wherever a consumer loads
      // @cloudflare/workers-types next to @types/node, so every call on it is
      // unchecked there. Use Uint8Array / TextEncoder / DataView instead.
      "eslint/no-restricted-globals": [
        "error",
        {
          name: "Buffer",
          message:
            "The `Buffer` global is typed `any` wherever @cloudflare/workers-types is loaded. Use Uint8Array / TextEncoder / DataView.",
        },
      ],

      // ---- Effect preset: rules this library's public surface cuts across --
      // `prefer-option-over-null`: the public API spells absence as `Option`
      // (AGENTS.md, Conventions), but `src/internal/**` still returns and
      // stores `null` / `undefined` on its per-token paths, where an
      // `Option` per token measurably costs throughput, and the hand-written
      // `*Encoded` wire shapes of the DOM keep `T | null` (their encoded
      // JSON). It stays a warning so those sites stay visible; a new one in
      // a public module is still a finding to read.
      "effect/prefer-option-over-null": "warn",
      // Every `as` is a claim nothing checks. The library has none left
      // (`Xsd.parser` decodes through a `Schema`, #181); `as const` is exempt.
      "effect/casting-awareness": "error",
      "typescript/no-unsafe-type-assertion": "error",
      "vite-plus/prefer-vite-plus-imports": "error",
      // On explicitly: no preset this config extends turns them on.
      "eslint/prefer-const": "error",
      "unicorn/no-empty-file": "error",
      "typescript/ban-ts-comment": "error",
      "typescript/no-empty-object-type": "error",
      "typescript/no-explicit-any": "error",

      // ---- oxlint plugins (`suspicious` / `perf` categories) ---------------
      // `_tag` is the discriminant of every Effect tagged union and error
      // class; reading it is the point, so a leading underscore is not a
      // smell here.
      "eslint/no-underscore-dangle": "off",
      // docgen's tags (`@since`, `@category`) and the module tags every file
      // header carries are part of the doc-comment standard (AGENTS.md).
      "jsdoc/check-tag-names": [
        "error",
        { definedTags: ["since", "category", "copyright", "module", "internal"] },
      ],
      // Tests assert through `expect` and the repo's own assertion helpers
      // (tests/support/narrow.ts, and per-file `expect…` / `rejects` helpers).
      "vitest/expect-expect": [
        "error",
        { assertFunctionNames: ["expect", "expect*", "assert", "assert*", "rejects"] },
      ],
      // `@effect/vitest`'s `it.effect` / `it.live` are test blocks (also on the
      // `it` a `layer(...)` block hands its callback); the rule only knows
      // vitest's own.
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: ["it.effect", "it.live", "it.effect.each", "it.live.each"],
        },
      ],
      // Vitest's `expect(value, message)` takes the failure message second.
      "vitest/valid-expect": ["error", { maxArgs: 2 }],
      // Adoption allowances (#61): sites that predate the `suspicious`
      // category. A new site is a defect; when a count reaches zero, delete
      // the line so the rule is back at `error`.
      // Type-aware (tsgolint) rules. oxlint applies `overrides` to none of
      // them, so each relaxation here is global and counted.
      // 1 site: the CLI bin (`packages/cli/src/main.ts`), the application
      // entry point the rule's own message exempts (it provides the composed
      // platform layer once, to `NodeRuntime.runMain`). The tests provide
      // their layers with `@effect/vitest`'s `layer`, and src/ has none; a
      // site there is a defect (#80).
      "effecttsgo/strict-effect-provide": "warn",
      // Off, the owner's decision: `effect/cli`, `FileSystem` and `Path` are
      // unstable modules the CLI needs, `@effect/vitest` is what the tests
      // run on, and the rule can't be scoped to them (oxlint applies no
      // `overrides` to type-aware rules). The Effect language service's
      // `unstableApiUsage` is off in `tsconfig.base.json` for the same reason.
      "effecttsgo/unstable-api-usage": "off",
    },
    overrides: [
      // Build/test configs are evaluated by Vite and Vitest in bare Node,
      // before any Effect runtime exists: nothing here runs inside one, so
      // the one value read from the environment (the worker count) is read
      // through `Config` and run once, at the top level, which is the entry
      // point `effect-run-in-body` sends execution to. There is no
      // `FileSystem` service to call, so `node:*` is the only thing that
      // works for the rest. The Effect preset's service rules have no
      // satisfiable fix in these files.
      {
        files: ["vite.config.ts", "packages/*/vite.config.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
        },
      },
      // The WHATWG tree constructor keeps three loops that ARE the spec's
      // steps: the adoption agency's outer loop (at most eight passes) and
      // inner loop (a walk down the open-elements stack that splices it as it
      // goes, with the bookmark it moves), and the lockstep drive loop that
      // pulls one token at a time so `suppressRawText` is set before the next
      // token is lexed. Each iteration depends on state the previous one
      // mutated, so no `Arr` combinator expresses them, and recursion would
      // overflow on a long document. The other loops are the per-token walks
      // of the stack of open elements and the formatting list (scope tests,
      // implied end tags, formatting reconstruction) and the conversion of the
      // finished tree, where an `Arr.findLast*` allocated an `Option` and a
      // closure per call; the lenient fragment builder's two stack walks are
      // the same. Together with the next override these made
      // `Html.parseDocument` and `Html.parseFragment` 1.5–1.8 times as fast
      // (`vp run bench`).
      {
        files: ["src/Html/TreeConstruction.ts", "src/Html/TreeBuilder.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // Lookup tables keyed by tag names the parsers slice from their input:
      // a property lookup must intern each fresh string first, a `Map` only
      // hashes it (`flagsOf` as a record lookup was 7% of
      // `Html.parseDocument`'s profile, as a `Map` lookup under 2%). The
      // tables (and `TagCounts`, the tree constructor's per-name count of open
      // elements, updated on every push and pop) are private to the parse and
      // never compared.
      {
        files: ["src/internal/tagSet.ts"],
        rules: {
          "effect/avoid-native-object-helpers": "off",
        },
      },
      // Lookup tables on the XML Schema validator's per-element path (the
      // names an element's children and their attributes resolve to, the
      // counts of same-named siblings): a record keyed by names sliced from
      // the input has to intern each one first, and `MutableHashMap.get`
      // wraps every hit in an `Option`. `Lookup` is a `Map` that returns the
      // value itself.
      {
        files: ["src/internal/lookup.ts"],
        rules: {
          "effect/avoid-native-object-helpers": "off",
        },
      },
      // The XML Schema validator's per-element path: the scans of a start
      // tag's attributes (duplicates, namespace declarations, `xsi:type` /
      // `xsi:nil`, each attribute's check, the defaults) run once per element,
      // and an `Arr` fold or search there allocates a closure and an `Option`
      // or `Result` per call. Written as loops (with the `Option` / `Result`
      // chains flattened), `Xsd.validate` and `Xsd.parse` were about 1.5
      // times as fast on the benchmark's worksheet.
      {
        files: ["src/internal/xsd/validator.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // The HTML tree builders' per-token dispatch, for the reason given for
      // the lexer below: `SaxEvent.$match` was a fifth of
      // `Html.parseDocument`'s profile and an eighth of `Html.parseFragment`'s.
      {
        files: ["src/Html/TreeConstruction.ts", "src/Html/TreeBuilder.ts"],
        rules: {
          "effect/avoid-direct-tag-checks": "off",
          "effect/prefer-match-over-switch": "off",
        },
      },
      // The two primitive loops everything else is built on. The stack-safe
      // tree walk: an explicit stack and a loop are what let documents of any
      // depth be traversed without overflowing the call stack (an `Arr` fold
      // over children would have to recurse per level). The lexer's drive
      // loop: it runs once per token, and an `Arr.unfold` there allocates per
      // token (measured: every parser slowed by a quarter). Every DOM walk
      // and every lexer driver goes through them.
      {
        files: ["src/internal/tree.ts", "src/internal/drive.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // XDM node handles walk up the parent chain (document order, the root,
      // the ancestors whose namespace declarations are in scope). A loop keeps
      // that stack-safe for the same reason as the tree walk above: recursion
      // once per ancestor would overflow on a deep enough document, and an
      // `Arr.unfold` would allocate an `Option` and a tuple per level on the
      // path every step of a path expression sorts by.
      {
        files: ["src/internal/xquery/node.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // The XQuery evaluator's axis walks (descendant, following, preceding)
      // keep an explicit stack in a loop for the reason given for node.ts
      // above, and its node-list primitives (document-order sort and
      // dedup, the merge of per-node step results, intersect / except)
      // and `deep-equal`'s work list are loops over arrays they own, sorted
      // and reversed in place: they run once per path step on every node
      // the step reaches, where an `Arr` copy per call would double the
      // allocation of every path expression.
      {
        files: ["src/internal/xquery/eval/axes.ts", "src/internal/xquery/eval/compare.ts"],
        rules: {
          "effect/imperative-loops": "off",
          "effect/prefer-arr-sort": "off",
          "unicorn/no-array-reverse": "off",
        },
      },
      // The evaluator's exception boundary (see its module comment): dynamic
      // errors are thrown where they are raised, deep inside compiled code
      // with no result to thread them through, and caught here, once per
      // evaluation, as in unwind.ts.
      {
        files: ["src/internal/xquery/eval/raise.ts"],
        rules: {
          "effect/avoid-try-catch": "off",
        },
      },
      // Generic walks over every field of the XQuery syntax tree, whatever
      // its variant (see the modules' comments: the path compiler's test for
      // focus functions, and the streamability analysis): their input is the
      // tree's own nodes, read field by field, so they are `unknown` and
      // walked with `Object.values`.
      {
        files: ["src/internal/xquery/eval/walk.ts", "src/internal/xquery/stream/analyze.ts"],
        rules: {
          "effect/no-unknown-parameters": "off",
          "effect/avoid-native-object-helpers": "off",
        },
      },
      // The line index's scan for line breaks: it runs over every chunk of
      // input once, pushing one number per `\n` (`indexOf` from the last
      // one). Recursion would overflow on a chunk with enough lines, and an
      // `Arr` fold or `Arr.unfold` would allocate per character or per line
      // on the path every parser takes its input in by.
      {
        files: ["src/internal/position.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // The per-token dispatch: the lexer's token → event step and its
      // guards, the limit check, and the SAX conversion run once per token.
      // `$match` and `$is` are each ONE function shared by every table and
      // guard in the program, so their property reads and calls go
      // megamorphic and V8 can't inline the cases; written that way, these
      // three files cost the SAX path a third of its throughput (`vp run
      // bench`, 64 KiB chunks: ~495 ms against ~360 ms). Here a `switch` on
      // `_tag` and direct tag guards are the fix.
      {
        files: [
          "src/internal/lexer.ts",
          "src/internal/guard.ts",
          "src/internal/convert.ts",
          "src/internal/lenient.ts",
          "src/internal/direct.ts",
          "src/internal/xmlBuilder.ts",
          "src/Xml/Plain.ts",
        ],
        rules: {
          "effect/avoid-direct-tag-checks": "off",
          "effect/prefer-match-over-switch": "off",
        },
      },
      // The per-token and per-element loops of the XML path: the hand-written
      // scanner and the lenient reader (`scan.ts`, `lenient.ts`: char-code
      // loops over the buffer, as every fast tokenizer is written), the lexer's drive loop, the limit check of a
      // tag's attributes, and the tree builders' steps (the DOM builder's name cache,
      // namespace scopes and duplicate checks as native `Map`s / `Set`s,
      // looked up per element and attribute, where `HashMap` hashes each
      // string in JavaScript). Each `Arr` fold or search there allocated a
      // closure and an `Option` or `Result` per call. Written as loops, the
      // SAX path went from ~700 ms to ~300 ms and `Xml.parse` from ~2400 ms
      // to ~450 ms on the benchmark's 8 MB worksheet (`vp run bench`).
      {
        files: [
          "src/internal/scan.ts",
          "src/internal/lenient.ts",
          "src/internal/direct.ts",
          "src/internal/lexer.ts",
          "src/internal/guard.ts",
          "src/internal/namespaces.ts",
          "src/internal/qnames.ts",
          "src/internal/xmlBuilder.ts",
          "src/Xml/Plain.ts",
        ],
        rules: {
          "effect/imperative-loops": "off",
          "effect/avoid-native-object-helpers": "off",
        },
      },
      // The lexer's check for the characters XML 1.0 does not allow (§2.2
      // `Char`): those are C0 control characters, so matching them is the
      // regular expression's whole point.
      {
        files: ["src/internal/lexer.ts"],
        rules: {
          "no-control-regex": "off",
        },
      },
      // `Xml.serialize` / `serializeDocument` unwrap a writer run that cannot
      // fail: `invalid: "replace"` patches every unwritable character and a
      // tree's events are always balanced, so a failure would be a defect.
      // They are total string functions; an error channel would only make
      // every caller handle an error that never happens.
      {
        files: ["src/Xml/Xml.ts"],
        rules: {
          "effect/avoid-option-getorthrow": "off",
        },
      },
      // The tree builders' one exception boundary (see its module comment):
      // a resource limit is thrown from deep inside the WHATWG algorithm and
      // caught here, once per event, at no cost on the path that doesn't throw.
      {
        files: ["src/internal/unwind.ts"],
        rules: {
          "effect/avoid-try-catch": "off",
        },
      },
      // The example is a program: its one `Effect.runPromise` IS the entry
      // point the rule sends execution to (no platform runtime is a
      // dependency of this library to run it with instead).
      {
        files: ["examples/**/*.ts"],
        rules: {
          "effect/effect-run-in-body": "off",
        },
      },
    ],
    // Type-aware linting through oxlint-tsgolint (bundled with vite-plus and
    // patched by `effect-tsgo patch --oxlint`), which also enables
    // `@effect/tsgo`'s `effecttsgo/*` preset rules. `typeCheck` reports
    // TypeScript errors in `vp check` too; `vp run check` stays the gate of
    // record (the Effect-patched tsc). tsgolint reads each file's nearest
    // tsconfig.json, so `tests/`, `examples/` and `bench/` each carry one that
    // extends tsconfig.test.json.
    options: {
      typeAware: true,
      typeCheck: true,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  run: {
    tasks: {
      // The CI type gate: `src` under the native, Effect-patched `tsc`, then
      // the tests and the example under tsconfig.test.json.
      check: {
        command: "tsc -p tsconfig.json && tsc -p tsconfig.test.json",
        dependsOn: [cli("check")],
        cache: { input: cacheInputs, output: [] },
      },
      // The published artifact: one ESM module + declaration file per source
      // module (`vp pack` → tsdown, `platform: neutral`, `unbundle`).
      // `sideEffects: false` is a claim about this output: no top-level
      // statements.
      build: {
        command: "vp pack",
        dependsOn: [cli("build")],
        cache: { input: cacheInputs, output: ["dist/**"] },
      },
      "test:unit": {
        command: "vp test run",
        dependsOn: [cli("test:unit")],
        cache: { env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"], input: cacheInputs, output: [] },
      },
      // The unit suite under one Istanbul coverage map
      // (`coverage/coverage-final.json`), which `fallow audit` reads for exact
      // per-function CRAP scores (`health.coverage` in .fallowrc.json).
      // Without it fallow estimates every function as uncovered, and any
      // function with cyclomatic complexity ≥ 5 fails the gate on its own.
      // Run this before `fallow audit`. The Claude Code PreToolUse fallow gate
      // (`.claude/hooks/fallow-gate.sh`) runs it itself when the map is missing
      // or older than the sources.
      "test:coverage": {
        command: "vp test run --coverage",
        cache: false,
      },
      // Compiles AND RUNS every JSDoc `@example` (see docgen.json). Examples
      // import the package by name exactly as a consumer would, which
      // resolves through `exports` to `dist/` — hence the build edge.
      docgen: {
        command: "docgen",
        dependsOn: ["build"],
        cache: { input: cacheInputs, output: ["docs/**"] },
      },
      // The bundle-size budgets (#156): a consumer's `Sax.forEach` and
      // `Xml.parse` bundled from `dist/` with esbuild (bench/size.ts). A CI gate.
      size: {
        command: "vpx bench/size.ts",
        dependsOn: ["build"],
        cache: false,
      },
      // Parsing throughput on a generated SpreadsheetML worksheet (not a gate).
      bench: {
        command: "vpx bench/parse.ts",
        cache: false,
      },
      // The tour in examples/usage.ts.
      example: {
        command: "vpx examples/usage.ts",
        cache: false,
      },
    },
  },
  pack: {
    entry: {
      index: "src/index.ts",
      Sax: "src/Sax.ts",
      Xml: "src/Xml/index.ts",
      Html: "src/Html/index.ts",
      Xsd: "src/Xsd/index.ts",
      XQuery: "src/XQuery/index.ts",
    },
    format: "esm",
    platform: "neutral",
    dts: true,
    outDir: "dist",
    // One output module per source module, so a consumer's bundler drops the
    // modules a program never reaches (`sideEffects: false`): bundled into a
    // chunk per entry, `Sax.forEach` alone carried XQuery and XSD along (#156).
    unbundle: true,
    // Unbundled, an imported constant that rolldown inlines leaves a bare
    // `import "./x.js"` behind, which esbuild warns about in every consumer's
    // build (`ignored-bare-import`); the modules keep their named imports.
    inputOptions: { optimization: { inlineConst: false } },
    clean: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    ...workers,
    coverage: {
      provider: "istanbul",
      // `json` writes coverage-final.json, the Istanbul map `fallow audit`
      // reads for exact per-function CRAP scores (`health.coverage` in
      // .fallowrc.json); without it every function scores as uncovered.
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "src/internal/htmlEntities.generated.ts"],
    },
  },
});
