/**
 * Generating a typed parser module from an XML Schema file: what the
 * `effect-xml-xsd generate` command does, as an Effect over the
 * `FileSystem`, `Path` and (for remote schema documents) `HttpClient`
 * services.
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import type { HttpClientError } from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { Xsd } from "@thomasfosterau/effect-xml";

/**
 * What to generate: the schema to read, the module to write, and the
 * `Xsd.GenerateOptions` that shape it.
 *
 * @since 0.1.0
 * @category options
 */
export interface GenerateOptions {
  /** The path of the schema to compile. */
  readonly schema: string;
  /** The path of the TypeScript module to write (or, with `check`, to compare against). */
  readonly out: string;
  /** The module the generated code imports the library from (default `"@thomasfosterau/effect-xml"`). */
  readonly importFrom?: string | undefined;
  /** The global elements (expanded names, `{namespace}local`) to write parsers for; all of them when empty. */
  readonly roots?: ReadonlyArray<string> | undefined;
  /** Fetch `include` / `import` locations that are `http:` or `https:` URLs; refused by default. */
  readonly remote?: boolean | undefined;
  /** Compare the module with the file at `out` instead of writing it, failing when they differ. */
  readonly check?: boolean | undefined;
}

/**
 * A schema document at an `http:` or `https:` location was needed, but
 * fetching remote documents was not allowed (see {@link GenerateOptions.remote}).
 *
 * @since 0.1.0
 * @category errors
 */
export class RemoteLocationRefused extends Schema.TaggedError<RemoteLocationRefused>()(
  "RemoteLocationRefused",
  { location: Schema.String },
) {
  override get message(): string {
    return `the schema document ${this.location} is remote; pass --remote to fetch it`;
  }
}

/**
 * In check mode, the file on disk is not what the generator writes today
 * (or there is no file).
 *
 * @since 0.1.0
 * @category errors
 */
export class StaleOutput extends Schema.TaggedError<StaleOutput>()("StaleOutput", {
  path: Schema.String,
}) {
  override get message(): string {
    return `${this.path} is out of date; regenerate it`;
  }
}

/**
 * What {@link generate} did: wrote the module, or (in check mode) found it up to date.
 *
 * @since 0.1.0
 * @category models
 */
export type Outcome = "written" | "unchanged";

const remote = /^https?:/i;

/** Read a schema document: a file, or a remote URL when that is allowed. */
const reader =
  (fs: FileSystem.FileSystem, allowRemote: boolean) =>
  (
    location: string,
  ): Effect.Effect<
    string,
    PlatformError | RemoteLocationRefused | HttpClientError,
    HttpClient.HttpClient
  > => {
    if (!remote.test(location)) return fs.readFileString(location);
    if (!allowRemote) return Effect.fail(new RemoteLocationRefused({ location }));
    return HttpClient.get(location).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.text),
    );
  };

/**
 * Compile the schema at `options.schema` (its includes and imports resolved
 * relative to it) and write the module `Xsd.generate` makes from it to
 * `options.out`, or, with `options.check`, fail with {@link StaleOutput}
 * unless the file there is already that module.
 *
 * The generated header names the schema relative to the output's directory,
 * so the module is the same whatever directory the command runs in.
 *
 * @since 0.1.0
 * @category generating
 */
export const generate = Effect.fn("generate")(function* (options: GenerateOptions) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = reader(fs, options.remote === true);
  const location = path.resolve(options.schema);
  const out = path.resolve(options.out);
  const model = yield* Xsd.compile(yield* read(location), { location, resolve: read });
  const source = yield* Xsd.generate(model, {
    importFrom: options.importFrom,
    // No `--root` means every global element, as `Xsd.generate` does without `roots`.
    roots: Arr.match(options.roots ?? [], { onEmpty: () => undefined, onNonEmpty: (r) => r }),
    source: path.relative(path.dirname(out), location),
  });
  if (options.check !== true) {
    yield* fs.writeFileString(out, source);
    return "written" satisfies Outcome;
  }
  const exists = yield* fs.exists(out);
  const current = exists ? yield* fs.readFileString(out) : undefined;
  if (current !== source) return yield* new StaleOutput({ path: options.out });
  return "unchanged" satisfies Outcome;
});
