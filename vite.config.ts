/**
 * The one Vite+ configuration for this single-package repo: the repo-wide
 * format / lint / staged passes (read statically by `vp fmt` / `vp lint` /
 * `vp staged`), the task graph (`check`, `build`, `test:unit`,
 * `test:coverage`, `docgen`, `example`), the `vp pack` (tsdown) settings and
 * the vitest / coverage settings.
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
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@mpsuesser/oxlint-plugin-effect";

/**
 * Input fingerprint for the cached tasks: auto tracking minus node_modules
 * bookkeeping churn (pnpm rewrites `.modules.yaml` on every install), with the
 * lockfile back explicitly so a dependency upgrade still invalidates a
 * type-check or a test run.
 */
const cacheInputs = [{ auto: true }, "!node_modules/**", "!docs/**", "pnpm-lock.yaml"];

const maxWorkers = process.env.VITEST_MAX_WORKERS;

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
    categories: {
      correctness: "error",
    },
    rules: {
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "warn",
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
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`, including the branded-name casts the parser's
      // hot path makes after validating once. Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import { Option } from
      // "effect"`) this family shares with its consumers.
      "effect/prefer-namespace-imports": "off",

      // ---- Effect preset: rules this library's public surface cuts across --
      // `prefer-option-over-null` fires on the `string | null` members of the
      // published data types (`SaxEvent.Doctype` / `XmlDeclaration`,
      // `XmlDoctype`, `QName.prefix` / `.namespace`). They are the XML
      // infoset's "no value", encoded through `Schema.NullOr` as JSON-safe
      // `null`, so turning them into `Option` would break every consumer and
      // every encoded document. It also fires on `?: T | undefined`, the only
      // spelling of an optional member `exactOptionalPropertyTypes` lets a
      // caller forward an optional of its own into. A bare `null` in an
      // internal return type is still a finding to read.
      "effect/prefer-option-over-null": "warn",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
    },
    overrides: [
      // Build/test configs are evaluated by Vite and Vitest in bare Node,
      // before any Effect runtime exists — there is no `Config` provider to
      // read from and no `FileSystem` service to call, so `process.env` and
      // `node:*` are the only things that work there. The Effect preset's
      // service rules have no satisfiable fix in these files.
      {
        files: ["vite.config.ts"],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          // `...(process.env.X ? { x } : {})` is how a vitest option is left
          // unset under `exactOptionalPropertyTypes`.
          "effect/no-conditional-empty-object-spread": "off",
        },
      },
      // The WHATWG tree constructor keeps three loops that ARE the spec's
      // steps: the adoption agency's outer loop (at most eight passes) and
      // inner loop (a walk down the open-elements stack that splices it as it
      // goes, with the bookmark it moves), and the lockstep drive loop that
      // pulls one token at a time so `suppressRawText` is set before the next
      // token is lexed. Each iteration depends on state the previous one
      // mutated, so no `Arr` combinator expresses them, and recursion would
      // overflow on a long document. Every other loop in the file is gone.
      {
        files: ["src/Html/TreeConstruction.ts"],
        rules: {
          "effect/imperative-loops": "off",
        },
      },
      // The two primitive loops everything else is built on. The stack-safe
      // tree walk: an explicit stack and a loop are what let documents of any
      // depth be traversed without overflowing the call stack (an `Arr` fold
      // over children would have to recurse per level). The lexer's drive
      // loop: it runs once per token, and an `Arr.unfold` there allocates per
      // token (measured: every parser slowed by a quarter). Every DOM walk
      // and every lexer driver goes through them. The SAX conversion of a
      // batch is the same per-token loop (see the next override).
      {
        files: ["src/internal/tree.ts", "src/internal/drive.ts", "src/internal/convert.ts"],
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
      // `_tag`, direct tag guards and one plain batch loop are the fix.
      {
        files: ["src/internal/lexer.ts", "src/internal/guard.ts", "src/internal/convert.ts"],
        rules: {
          "effect/avoid-direct-tag-checks": "off",
          "effect/prefer-match-over-switch": "off",
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
      // The benchmark is a standalone program, like a build script: it times
      // runs in loops, prints a table, runs its effects at the top level
      // (it is the entry point), and imports optional third-party parsers
      // that may not be installed (a failed dynamic import means "skip").
      {
        files: ["bench/**/*.ts"],
        rules: {
          "effect/imperative-loops": "off",
          "effect/effect-run-in-body": "off",
          "effect/use-console-service": "off",
          "effect/avoid-try-catch": "off",
          "effect/avoid-any": "off",
          "effect/no-unknown-returns": "off",
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
      // Test fixtures are the seams under test, not domain code.
      {
        files: ["tests/**/*.ts"],
        rules: {
          // A test IS the boundary the rule sends execution to: each case
          // runs its program with `Effect.runPromise` / `runSync`.
          "effect/effect-run-in-body": "off",
          "effect/require-safety-comment-for-type-assertion": "warn",
          "effect/use-clock-service": "warn",
          "effect/avoid-process-env": "warn",
          "effect/require-effect-concurrency": "warn",
        },
      },
    ],
    // Type-aware linting is intentionally disabled: type checking stays the
    // `check` task's job (native tsc, Effect-patched).
    options: {
      typeAware: false,
      typeCheck: false,
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
        cache: { input: cacheInputs, output: [] },
      },
      // The published artifact: one ESM bundle + declaration file per entry
      // point (`vp pack` → tsdown, `platform: neutral`). `sideEffects:
      // false` is a claim about this output: no top-level statements.
      build: {
        command: "vp pack",
        cache: { input: cacheInputs, output: ["dist/**"] },
      },
      "test:unit": {
        command: "vp test run",
        cache: { env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"], input: cacheInputs, output: [] },
      },
      // The unit suite under one Istanbul coverage map
      // (`coverage/coverage-final.json`), which `fallow audit` reads for exact
      // per-function CRAP scores (`health.coverage` in .fallowrc.json).
      // Without it fallow estimates every function as uncovered, and any
      // function with cyclomatic complexity ≥ 5 fails the gate on its own.
      // Run this before `fallow audit` (the Claude Code PreToolUse fallow gate
      // runs the audit on `git commit` / `git push` but never refreshes this map).
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
      // Parsing throughput on a generated SpreadsheetML worksheet (not a gate).
      bench: {
        command: "tsx bench/parse.ts",
        cache: false,
      },
      // The tour in examples/usage.ts.
      example: {
        command: "tsx examples/usage.ts",
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
    },
    format: "esm",
    platform: "neutral",
    dts: true,
    outDir: "dist",
    clean: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
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
