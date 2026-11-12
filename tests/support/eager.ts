/**
 * Tokenizing with `dtd: "internal"` the way it was before #99: the DTD-aware
 * grammars from the first token, the scanner off, whatever the DTD declares
 * (`Sax.tokenizeEagerly`, internal). `Sax.tokenize` now reads with the
 * grammars without a DTD (and the scanner) until a DOCTYPE declares an
 * entity; this is the reference the differential tests hold it to.
 */
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import type { Sax, SaxError } from "../../src/index.ts";
import { tokenizeEagerly as eagerly } from "../../src/Sax.ts";

/** The events of `chunks` (or the failure), as `Sax.tokenize(options)` streams them, read eagerly. */
export const tokenizeEagerly = (
  chunks: ReadonlyArray<string>,
  options: Sax.SaxOptions,
): Exit.Exit<ReadonlyArray<Sax.SaxEvent>, SaxError> =>
  Result.match(eagerly(chunks, options), { onSuccess: Exit.succeed, onFailure: Exit.fail });
