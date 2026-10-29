/**
 * The CLI package's tasks and build. Formatting and lint come from the
 * repository's root `vite.config.ts`.
 *
 * @copyright Thomas Foster
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

const maxWorkers = process.env.VITEST_MAX_WORKERS;

/** Tests resolve the library to its sources, as `tsconfig.json` does. */
const library = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

export default defineConfig({
  run: {
    tasks: {
      check: {
        command: "tsc -p tsconfig.json",
        cache: { input: [{ auto: true }, "!node_modules/**"], output: [] },
      },
      // One executable bundle. The library, effect and the Node platform stay
      // external: they are the package's dependencies.
      build: {
        command: "vp pack",
        cache: { input: [{ auto: true }, "!node_modules/**"], output: ["dist/**"] },
      },
      "test:unit": {
        command: "vp test run",
        cache: {
          env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
          input: [{ auto: true }, "!node_modules/**"],
          output: [],
        },
      },
    },
  },
  pack: {
    entry: { main: "src/main.ts" },
    format: "esm",
    platform: "node",
    dts: false,
    outDir: "dist",
    clean: true,
  },
  resolve: {
    alias: { "@thomasfosterau/effect-xml": library },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    ...(maxWorkers === undefined ? {} : { maxWorkers: Number(maxWorkers) }),
  },
});
