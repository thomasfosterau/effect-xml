/**
 * Evaluating XQuery 3.1 and XPath 3.1: a compiled {@link Query} (or query
 * text) run against a context item and external variables, to an XDM
 * sequence or the first dynamic error.
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  XmlDocument as XmlDocumentSchema,
  XmlElement as XmlElementSchema,
  type XmlDocument,
  type XmlElement,
} from "../Xml/Node.ts";
import type { Item, Sequence } from "../internal/xquery/item.ts";
import { XdmNode } from "../internal/xquery/node.ts";
import { compileQuery, runCompiled, type Compiled } from "../internal/xquery/eval/compile.ts";
import { attemptSync } from "../internal/xquery/eval/raise.ts";
import { resume } from "../internal/xquery/eval/resume.ts";
import { dynamicContext } from "../internal/xquery/eval/dynamic.ts";
import type { Dynamic } from "../internal/xquery/eval/runtime.ts";
import { compile, type CompileOptions, type ModuleSource, type Query } from "./Compile.ts";
import { importsOf, type UnresolvedImport } from "../internal/xquery/parser/modules.ts";
import { parseXQuery } from "../internal/xquery/parser/parse.ts";
import { type XQueryError, xqueryError } from "./Error.ts";

/**
 * How queries reach documents, collections and text resources: `fn:doc`,
 * `fn:collection` and `fn:unparsed-text` ask this service, with absolute
 * URIs (resolved against the static base URI). Each method may do any work
 * (read a file, fetch over the network); a failure is the error the
 * function raises. Without a `Resolver` in the context, those functions find
 * nothing (`err:FODC0002` for documents and collections, `err:FOUT1170` for texts).
 *
 * @since 0.1.0
 * @category resolving
 */
export interface ResourceResolver {
  /**
   * The library modules with a target namespace, for `import module` (with
   * the import's location hints); optional: without it, a query that imports
   * a module it was not compiled with fails with `err:XQST0059`.
   */
  readonly module?:
    | ((
        uri: string,
        locations: ReadonlyArray<string>,
      ) => Effect.Effect<ReadonlyArray<ModuleSource>, XQueryError>)
    | undefined;
  /** The document node of the document at `uri`. */
  readonly document: (uri: string) => Effect.Effect<XdmNode, XQueryError>;
  /** The collection at `uri`; `""` is the default collection. */
  readonly collection: (uri: string) => Effect.Effect<Sequence, XQueryError>;
  /** The text of the resource at `uri`, decoded with `encoding` if one is given. */
  readonly text: (uri: string, encoding: string | undefined) => Effect.Effect<string, XQueryError>;
}

/**
 * The service queries resolve documents, collections and texts through (see {@link ResourceResolver}).
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xml, XQuery } from "@thomasfosterau/effect-xml"
 *
 * const doc = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse("<n>7</n>")))
 * const program = XQuery.evaluate(`doc("urn:n")/n + 1`).pipe(
 *   Effect.provideService(XQuery.Resolver, XQuery.staticResolver({ documents: { "urn:n": doc } })),
 * )
 * console.log(XQuery.atomicString(Effect.runSync(program)[0] as XQuery.AtomicValue)) // "8"
 * ```
 *
 * @since 0.1.0
 * @category resolving
 */
export class Resolver extends Context.Service<Resolver, ResourceResolver>()(
  "@thomasfosterau/effect-xml/XQuery/Resolver",
) {}

/**
 * The resources a {@link staticResolver} serves, by absolute URI.
 *
 * @since 0.1.0
 * @category resolving
 */
export interface StaticResources {
  readonly documents?: Readonly<Record<string, XdmNode>> | undefined;
  /** Collections by URI; `""` is the default collection. */
  readonly collections?: Readonly<Record<string, Sequence>> | undefined;
  readonly texts?: Readonly<Record<string, string>> | undefined;
}

const find = <A>(table: Readonly<Record<string, A>> | undefined, uri: string, code: string) =>
  Effect.fromOption(Option.fromUndefinedOr(table?.[uri])).pipe(
    Effect.mapError(() =>
      xqueryError(code, `${uri === "" ? "the default collection" : uri} is not available`),
    ),
  );

/**
 * A {@link ResourceResolver} that serves resources from memory, failing for any URI it doesn't have.
 *
 * @since 0.1.0
 * @category resolving
 */
export const staticResolver = (resources: StaticResources): ResourceResolver => ({
  document: (uri) => find(resources.documents, uri, "FODC0002"),
  collection: (uri) => find(resources.collections, uri, "FODC0002"),
  text: (uri) => find(resources.texts, uri, "FOUT1170"),
});

/**
 * Options for {@link evaluate}.
 *
 * @since 0.1.0
 * @category evaluating
 */
export interface EvaluateOptions {
  /** The context item: an item, or a parsed document or element (made a node). */
  readonly context?: Item | XmlDocument | XmlElement | undefined;
  /**
   * External variables' values, by Clark name (`{uri}local`, or a bare
   * `local` for a name in no namespace). A single item stands for a sequence
   * of one. Compiling query text declares these names; a compiled
   * {@link Query} must have been compiled with them in `variables`.
   */
  readonly variables?: Readonly<Record<string, Sequence | Item>> | undefined;
  /** The implicit timezone, in minutes east of UTC (default 0). */
  readonly implicitTimezone?: number | undefined;
  /**
   * The environment variables `fn:environment-variable` and
   * `fn:available-environment-variables` see, by name (default: none; the
   * process environment is never read).
   */
  readonly environment?: Readonly<Record<string, string>> | undefined;
  /** The current dateTime (default: now, from the `Clock`). */
  readonly currentDateTime?: Date | undefined;
  /**
   * The default language of the dynamic context, an `xs:language` value such
   * as `en` or `fr-CA`, which `fn:default-language` returns (default `en`).
   *
   * @since 0.2.0
   * @category evaluating
   */
  readonly defaultLanguage?: string;
  /** How to compile query text: the static context's options. */
  readonly compile?: CompileOptions | undefined;
}

const isDocument = /*#__PURE__*/ Schema.is(XmlDocumentSchema);
const isElement = /*#__PURE__*/ Schema.is(XmlElementSchema);

const contextOf = (c: EvaluateOptions["context"]): Item | undefined => {
  if (c === undefined) return undefined;
  if (isDocument(c)) return XdmNode.fromDocument(c);
  if (isElement(c)) return XdmNode.fromElement(c);
  return c;
};

/** Compiled programs, one per query, so a query evaluated many times compiles once. */
const programs = /*#__PURE__*/ new WeakMap<Query, Result.Result<Compiled, XQueryError>>();

/** The external variables a compiled query reads: every in-scope variable the prolog doesn't declare. */
const externalNames = (query: Query): ReadonlyArray<string> => Array.from(query.context.variables);

const programOf = (query: Query): Result.Result<Compiled, XQueryError> => {
  const known = programs.get(query);
  if (known !== undefined) return known;
  const compiled = attemptSync(() => compileQuery(query, externalNames(query)));
  programs.set(query, compiled);
  return compiled;
};

/** Run a compiled query until it needs nothing more from the resolver. */
const run = (
  compiled: Compiled,
  base: Omit<Dynamic, "globals">,
  resolver: Option.Option<ResourceResolver>,
): Effect.Effect<Sequence, XQueryError> =>
  resume(() => runCompiled(compiled, { ...base, globals: [] }), base.resources, resolver);

/**
 * Evaluate a query: a compiled {@link Query} (from {@link compile} or
 * `XPath.compile`), or XQuery 3.1 text to compile first. The result is the
 * query's value as an XDM sequence, or the first error, an
 * {@link XQueryError} with the specifications' `err:` code and the offset of
 * the expression that raised it.
 *
 * Evaluation itself is synchronous; it is an `Effect` because `fn:doc`,
 * `fn:collection` and `fn:unparsed-text` go through the {@link Resolver}
 * service when one is provided (when a query asks for a resource the
 * resolver hasn't fetched yet, evaluation stops, the resolver fetches it,
 * and the query is evaluated again, deterministically, with it at hand).
 * Constructs the evaluator does not implement yet fail with the code
 * `NotImplemented` in {@link ImplementationNamespace}.
 *
 * Collations are the Unicode codepoint collation (the default), the HTML ASCII
 * case-insensitive collation and the UCA collations
 * `http://www.w3.org/2013/collation/UCA?…` of Functions and Operators 3.1
 * §5.3.3, which run on `Intl.Collator` (so their order follows the runtime's
 * ICU data, which varies a little between Node versions). The URI's
 * parameters, separated by `;`, map as follows:
 *
 * - `lang`: the locale (default `en`); one the runtime has no data for is unsupported.
 * - `strength`: `primary`, `secondary`, `tertiary` (the default) and `identical`
 *   (tertiary, then the code points of the NFD forms); `quaternary` is
 *   tertiary, except with `alternate=shifted`, where it is unsupported.
 * - `caseLevel`: `yes` with `strength=primary`; `no`.
 * - `alternate`: `non-ignorable` (the default), `blanked` and `shifted` (with
 *   `maxVariable=punct`, the only one the runtime has).
 * - `caseFirst` (`upper`, `lower`, `no`), `numeric` (`yes`, `no`) and
 *   `normalization` (`yes`, `no`; the runtime always normalizes).
 * - `backwards`: `no`. `reorder` and `version` are unsupported.
 * - `fallback`: `yes` (the default) ignores a parameter or value that is
 *   unsupported or unknown; `no` fails with `err:FOCH0002` (`err:XQST0038` in
 *   a `default collation` declaration, `err:XQST0076` in a clause).
 *
 * Every function and clause that takes a collation, and value comparisons,
 * `switch` and `fn:deep-equal` under a `default collation`, compare with it.
 * `Intl.Collator` has no sort keys and no collation units, so `fn:collation-key`
 * fails with `err:FOCH0004` for a UCA collation, and `fn:contains`,
 * `fn:starts-with`, `fn:ends-with`, `fn:substring-before` and
 * `fn:substring-after` compare the substrings of the string, cut between
 * grapheme clusters (and between digit runs under `numeric=yes`), with the
 * substring: the first minimal match wins, and characters the collation
 * ignores neither start nor end it.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xml, XQuery } from "@thomasfosterau/effect-xml"
 *
 * const doc = Effect.runSync(Xml.parse(`<items><i n="1">a</i><i n="2">b</i><i n="3">c</i></items>`))
 * const result = Effect.runSync(XQuery.evaluate("//i[@n > $min]/string()", { context: doc, variables: { min: XQuery.AtomicValue.integer(1n) } }))
 * console.log(result.map((item) => XQuery.atomicString(item as XQuery.AtomicValue))) // ["b", "c"]
 *
 * const sum = Effect.runSync(XQuery.evaluate("for $x in 1 to 4 return $x * $x"))
 * console.log(sum.length) // 4
 * ```
 *
 * @since 0.1.0
 * @category evaluating
 */
export const evaluate = (
  query: Query | string,
  options: EvaluateOptions = {},
): Effect.Effect<Sequence, XQueryError> =>
  Effect.gen(function* () {
    const variables = options.variables ?? {};
    const compiled: Query = P.isString(query)
      ? yield* compileText(query, options.compile, R.keys(variables))
      : query;
    const resolver = yield* Effect.serviceOption(Resolver);
    const withModules = yield* loadModules(compiled, resolver);
    const program = yield* Effect.fromResult(programOf(withModules));
    const dynamic = yield* dynamicContext(
      options,
      contextOf(options.context),
      Option.isSome(resolver),
    );
    return yield* run(program, dynamic, resolver);
  });

/** The sources of the modules `imports` name and the modules they import, fetched through the resolver. */
const fetchModules = (
  load: NonNullable<ResourceResolver["module"]>,
  pending: ReadonlyArray<UnresolvedImport>,
  fetched: Readonly<Record<string, ReadonlyArray<ModuleSource>>>,
): Effect.Effect<Readonly<Record<string, ReadonlyArray<ModuleSource>>>, XQueryError> => {
  const [next, ...rest] = pending;
  if (next === undefined) return Effect.succeed(fetched);
  if (next.uri in fetched) return fetchModules(load, rest, fetched);
  return load(next.uri, next.at).pipe(
    // A module the resolver can't find is left out: compiling reports `err:XQST0059`.
    Effect.orElseSucceed((): ReadonlyArray<ModuleSource> => []),
    Effect.flatMap((sources) =>
      fetchModules(
        load,
        [
          ...rest,
          ...sources.flatMap((m) =>
            Result.match(parseXQuery(m.text), {
              onFailure: () => [],
              onSuccess: (parsed) => importsOf(parsed),
            }),
          ),
        ],
        Arr.isReadonlyArrayEmpty(sources) ? fetched : { ...fetched, [next.uri]: sources },
      ),
    ),
  );
};

/** A query whose module imports were not given at compile time, recompiled with them fetched through the resolver. */
const loadModules = (
  query: Query,
  resolver: Option.Option<ResourceResolver>,
): Effect.Effect<Query, XQueryError> => {
  if (query.language === "XPath" || Arr.isReadonlyArrayEmpty(query.unresolvedImports))
    return Effect.succeed(query);
  const load = Option.getOrUndefined(Option.flatMapNullishOr(resolver, (r) => r.module));
  return (
    load === undefined ? Effect.succeed({}) : fetchModules(load, query.unresolvedImports, {})
  ).pipe(
    Effect.flatMap((modules) =>
      Effect.fromResult(compile(query.source, { ...query.options, modules })),
    ),
  );
};

const compileText = (
  text: string,
  options: CompileOptions | undefined,
  names: ReadonlyArray<string>,
) =>
  Effect.fromResult(
    compile(text, { ...options, variables: [...(options?.variables ?? []), ...names] }),
  );
