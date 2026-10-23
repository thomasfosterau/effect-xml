/**
 * Generate a typed parser module from an XML Schema:
 *
 *   vp exec tsx examples/xsd/generate.ts <schema.xsd> <out.ts> [import-from]
 *
 * `examples/xsd/order.generated.ts` is this script's output for
 * `examples/xsd/order.xsd` (importing the library from `../../src/index.ts`).
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { Xsd } from "../../src/index.ts";

const program = Effect.fn("generate")(function* (
  input: string,
  output: string,
  importFrom: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const location = path.resolve(input);
  const model = yield* Xsd.compile(yield* fs.readFileString(location), {
    location,
    // Included and imported documents are read relative to the schema.
    resolve: (included) => fs.readFileString(included),
  });
  const source = yield* Xsd.generate(model, {
    importFrom,
    source: path.relative(path.dirname(path.resolve(output)), location),
  });
  yield* fs.writeFileString(output, source);
});

const [input, output, importFrom] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  process.exitCode = 1;
  process.stderr.write("usage: generate.ts <schema.xsd> <out.ts> [import-from]\n");
} else {
  void Effect.runPromise(
    program(input, output, importFrom).pipe(
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    ),
  );
}
