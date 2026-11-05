/**
 * Evaluating XQuery 3.1 and XPath 3.1: a compiled {@link Query} (or query
 * text) run against a context item and external variables, to an XDM
 * sequence or the first dynamic error.
 */
import * as BigDecimal from "effect/BigDecimal";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
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
import { AtomicTypes } from "../internal/xquery/types.ts";
import { compileQuery, runCompiled, type Compiled } from "../internal/xquery/eval/compile.ts";
import {
  attempt,
  attemptSync,
  Suspend,
  type ResourceRequest,
} from "../internal/xquery/eval/raise.ts";
import { Resources, resourceKey, type Dynamic } from "../internal/xquery/eval/runtime.ts";
import { formatParts, partsAt } from "../internal/xquery/eval/temporal.ts";
import { compile, type CompileOptions, type Query } from "./Compile.ts";
import { type XQueryError, xqueryError } from "./Error.ts";

/**
 * How queries reach documents, collections and text resources: `fn:doc`,
 * `fn:collection` and `fn:unparsed-text` ask this service, with absolute
 * URIs (resolved against the static base URI). Each method may do any work
 * (read a file, fetch over the network); a failure is the error the
 * function raises. Without a `Resolver` in the context, those functions find
 * nothing (`err:FODC0002`, `err:FODC0004`, `err:FOUT1170`).
 *
 * @since 0.3.0
 * @category resolving
 */
export interface ResourceResolver {
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
 * @since 0.3.0
 * @category resolving
 */
export class Resolver extends Context.Service<Resolver, ResourceResolver>()(
  "@thomasfosterau/effect-xml/XQuery/Resolver",
) {}

/**
 * The resources a {@link staticResolver} serves, by absolute URI.
 *
 * @since 0.3.0
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
 * @since 0.3.0
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
 * @since 0.3.0
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
  /** The current dateTime (default: now, from the `Clock`). */
  readonly currentDateTime?: Date | undefined;
  /** How to compile query text: the static context's options. */
  readonly compile?: CompileOptions | undefined;
}

const clarkKey = (name: string): string => (name.startsWith("{") ? name : `{}${name}`);

const isSequence = (v: Sequence | Item): v is Sequence => Array.isArray(v);

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

/** The current dateTime in the implicit timezone, as a lexical `xs:dateTimeStamp`. */
const nowIn = (millis: number, tz: number): string =>
  formatParts(
    AtomicTypes.dateTimeStamp,
    partsAt(BigDecimal.make(BigInt(Math.round(millis)), 3), tz),
  );

const fetchWith = (
  resolver: ResourceResolver,
  request: ResourceRequest,
): Effect.Effect<Sequence | string, XQueryError> =>
  request.kind === "document"
    ? Effect.map(resolver.document(request.uri), (node): Sequence => [node])
    : request.kind === "collection"
      ? resolver.collection(request.uri)
      : resolver.text(request.uri, request.encoding);

/** Run a compiled query until it needs nothing more from the resolver. */
const run = (
  compiled: Compiled,
  base: Omit<Dynamic, "globals">,
  resolver: Option.Option<ResourceResolver>,
): Effect.Effect<Sequence, XQueryError> =>
  Effect.suspend(() => {
    const outcome = attempt(() => runCompiled(compiled, { ...base, globals: [] }));
    if (Result.isSuccess(outcome)) return Effect.succeed(outcome.success);
    const failure = outcome.failure;
    if (!(failure instanceof Suspend)) return Effect.fail(failure);
    return Option.match(resolver, {
      onNone: () => Effect.fail(xqueryError("FODC0002", `${failure.request.uri} is not available`)),
      onSome: (r) =>
        fetchWith(r, failure.request).pipe(
          Effect.result,
          Effect.flatMap((fetched) => {
            base.resources.set(resourceKey(failure.request), fetched);
            return run(compiled, base, resolver);
          }),
        ),
    });
  });

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
 * @since 0.3.0
 * @category evaluating
 */
export const evaluate = (
  query: Query | string,
  options: EvaluateOptions = {},
): Effect.Effect<Sequence, XQueryError> =>
  Effect.gen(function* () {
    const variables = options.variables ?? {};
    const compiled: Query = Predicate.isString(query)
      ? yield* compileText(query, options.compile, Record.keys(variables))
      : query;
    const program = yield* Effect.fromResult(programOf(compiled));
    const resolver = yield* Effect.serviceOption(Resolver);
    const millis = options.currentDateTime?.getTime() ?? (yield* Clock.currentTimeMillis);
    const tz = options.implicitTimezone ?? 0;
    const externals = HashMap.fromIterable(
      Record.toEntries(variables).map(([k, v]): readonly [string, Sequence] => [
        clarkKey(k),
        isSequence(v) ? v : [v],
      ]),
    );
    return yield* run(
      program,
      {
        externals,
        initialContext: contextOf(options.context),
        resources: new Resources(Option.isSome(resolver)),
        currentDateTime: nowIn(millis, tz),
        implicitTimezone: tz,
      },
      resolver,
    );
  });

const compileText = (
  text: string,
  options: CompileOptions | undefined,
  names: ReadonlyArray<string>,
) =>
  Effect.fromResult(
    compile(text, { ...options, variables: [...(options?.variables ?? []), ...names] }),
  );
