/**
 * Reading vendored fixtures through the `FileSystem` service: the conformance
 * gates need a fixture's exact bytes (encoding detection is under test), which
 * Vite's `import.meta.glob` can only give as text.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

/** Node's file system and path services. */
export const layer = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

/** The file system path of `file`, relative to the directory URL `dir`. */
const pathOf = Effect.fnUntraced(function* (dir: URL, file: string) {
  const path = yield* Path.Path;
  return yield* path.fromFileUrl(new URL(file, dir));
});

/** A fixture's bytes. */
export const readBytes = Effect.fnUntraced(function* (dir: URL, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFile(yield* pathOf(dir, file));
});

/** A fixture's text, as UTF-8. */
export const readText = Effect.fnUntraced(function* (dir: URL, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* pathOf(dir, file));
});
