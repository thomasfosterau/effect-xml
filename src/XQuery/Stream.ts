/**
 * Streaming XQuery: a query evaluated over a stream of SAX events, one
 * matched subtree at a time, in memory bounded by the largest match.
 *
 * A streamable query is a path that selects elements, decided at each
 * element's start tag, followed by `/` steps and `!` expressions that run on
 * each matched subtree once it has ended (the rules are in
 * {@link compileStream}). Everything outside the matches streams past
 * without being kept.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import { QName } from "../Name.ts";
import type { SaxEvent } from "../Sax.ts";
import type { XmlElement } from "../Xml/Node.ts";
import * as Nodes from "../internal/nodes.ts";
import { selectFrom, Selector, type Match } from "../internal/selector.ts";
import type { MatchStep } from "../internal/streamPath.ts";
import type { Item, Sequence } from "../internal/xquery/item.ts";
import { XdmNode } from "../internal/xquery/node.ts";
import { compileParts } from "../internal/xquery/eval/compile.ts";
import { selects, stepOver } from "../internal/xquery/eval/path.ts";
import { attempt, attemptSync, Suspend } from "../internal/xquery/eval/raise.ts";
import { dynamicContext } from "../internal/xquery/eval/dynamic.ts";
import { fetchFor, resume } from "../internal/xquery/eval/resume.ts";
import { Ctx, type Code, type Dynamic } from "../internal/xquery/eval/runtime.ts";
import { resolveName, scopeOf } from "../internal/xquery/parser/analyze.ts";
import { Decl, Module, type Decl as DeclT, type Expr } from "../internal/xquery/parser/ast.ts";
import {
  analyze,
  checkFunctionBody,
  checkInitializer,
  failed,
  notStreamable,
  type NotStreamable,
  type Operation,
  type Resolve,
} from "../internal/xquery/stream/analyze.ts";
import { compile, type CompileOptions, type Query } from "./Compile.ts";
import { ImplementationNamespace, XQueryError } from "./Error.ts";
import { Resolver, type EvaluateOptions, type ResourceResolver } from "./Evaluate.ts";

/**
 * The code of the error a query that can't be streamed fails with:
 * `NotStreamable`, in {@link ImplementationNamespace}.
 *
 * @since 0.1.0
 * @category streaming
 */
export const NotStreamableCode: QName = /*#__PURE__*/ new QName({
  prefix: /*#__PURE__*/ Option.none(),
  local: "NotStreamable",
  namespace: /*#__PURE__*/ Option.some(ImplementationNamespace),
});

const notStreamableError = (reason: string, offset?: number): XQueryError =>
  new XQueryError({ code: NotStreamableCode, description: reason, offset });

/** A selection predicate, compiled. */
interface CompiledPredicate {
  readonly code: Code;
  readonly offset: number;
}

/** An operation on each match, compiled. */
interface CompiledOperation {
  readonly kind: Operation["kind"];
  readonly code: Code;
  readonly offset: number;
}

/**
 * A query compiled for streaming by {@link compileStream}: the query, ready
 * to be evaluated over any number of streams of SAX events.
 *
 * @since 0.1.0
 * @category streaming
 */
export interface StreamQuery {
  readonly _tag: "StreamQuery";
  /** The query, as {@link compile} (or `XPath.compile`) made it. */
  readonly query: Query;
}

/** The plan to evaluate a streamed query: its selection steps and the operations on each match, compiled. */
interface Plan {
  readonly steps: ReadonlyArray<MatchStep<CompiledPredicate>>;
  readonly operations: ReadonlyArray<CompiledOperation>;
}

/** The plans of the queries {@link compileStream} made. */
const plans = /*#__PURE__*/ new WeakMap<StreamQuery, Plan>();

/** Why a query's prolog can't be streamed, if it can't. */
const prologProblem = (query: Query, resolve: Resolve): Option.Option<NotStreamable> => {
  if (query.language === "XPath") return Option.none();
  if (
    Arr.isReadonlyArrayNonEmpty(query.libraries) ||
    Arr.isReadonlyArrayNonEmpty(query.unresolvedImports)
  )
    return Option.some(notStreamable("a query that imports modules can't be streamed yet", 0));
  if (Module.$is("Library")(query.module))
    return Option.some(notStreamable("a library module can't be evaluated", query.module.offset));
  return Arr.reduce(query.module.prolog, Option.none<NotStreamable>(), (found, d) =>
    Option.orElse(found, () => declarationProblem(d, resolve)),
  );
};

/** Why a prolog declaration can't be streamed, if it can't. */
const declarationProblem = (d: DeclT, resolve: Resolve): Option.Option<NotStreamable> => {
  if (Decl.$is("ContextItem")(d))
    return Option.some(
      notStreamable(
        "a streamed query has no context item to declare: each match is the focus",
        d.offset,
      ),
    );
  if (Decl.$is("Function")(d))
    return Option.flatMap(d.body, (b) => Option.fromUndefinedOr(checkFunctionBody(b, resolve)));
  if (Decl.$is("Variable")(d))
    return Option.flatMap(d.value, (v) => Option.fromUndefinedOr(checkInitializer(v, resolve)));
  return Option.none();
};

const bodyOf = (query: Query): Option.Option<Expr> =>
  query.language === "XPath"
    ? Option.some(query.expr)
    : Module.$is("Main")(query.module)
      ? Option.some(query.module.body)
      : Option.none();

/** The plan of a compiled query, or why it has none. */
const planOf = (query: Query): Result.Result<StreamQuery, XQueryError> => {
  const scope = scopeOf(query.context);
  const resolve: Resolve = (name, kind) =>
    Result.getOrElse(resolveName(scope, name, kind), () => ({ uri: "", local: name.local }));
  const found = bodyOf(query);
  const problem = prologProblem(query, resolve);
  if (Option.isSome(problem))
    return Result.fail(notStreamableError(problem.value.reason, problem.value.offset));
  if (Option.isNone(found))
    return Result.fail(notStreamableError("a library module can't be evaluated"));
  const plan = analyze(found.value, resolve);
  if (failed(plan)) return Result.fail(notStreamableError(plan.reason, plan.offset));
  const predicates = plan.steps.flatMap((s) => s.predicates.map((p) => p.expr));
  const parts = [...predicates, ...plan.operations.map((o) => o.expr)];
  return Result.map(
    attemptSync(() => compileParts(query, Array.from(query.context.variables), parts)),
    (codes) => {
      const codeAt = (i: number): Code => codes[i] ?? (() => []);
      const starts = Arr.scan(plan.steps, 0, (n, s) => n + s.predicates.length);
      const steps = plan.steps.map((s, i): MatchStep<CompiledPredicate> => ({
        axis: s.axis,
        test: s.test,
        positional: s.positional,
        predicates: s.predicates.map((p, k) => ({
          code: codeAt((starts[i] ?? 0) + k),
          offset: p.expr.offset,
        })),
      }));
      const operations = plan.operations.map((o, k): CompiledOperation => ({
        kind: o.kind,
        code: codeAt(predicates.length + k),
        offset: o.expr.offset,
      }));
      const made: StreamQuery = { _tag: "StreamQuery", query };
      plans.set(made, { steps, operations });
      return made;
    },
  );
};

/**
 * Compile a query for {@link stream}: XQuery 3.1 text (compiled with
 * `options`), or a {@link Query} from {@link compile} or `XPath.compile`,
 * checked against the streamable subset. A query outside it fails with an
 * {@link XQueryError} whose code is {@link NotStreamableCode}
 * (`NotStreamable` in {@link ImplementationNamespace}), saying why, at the
 * offset of the part that can't be streamed.
 *
 * A streamable query is a *selection*, then *operations* on each match:
 *
 * - **The selection** is a path (`/…`, `//…`, or relative to the document
 *   node) of `child`, `descendant`, `self` and `descendant-or-self` steps
 *   with element tests (a name, `*`, `p:*`, `*:local`, `element(…)`), whose
 *   predicates are decided at each element's start tag: they may read its
 *   attributes and its name (`local-name()`, `name()`, `namespace-uri()`,
 *   `node-name()`), variables and literals, and any function of those, but
 *   not fetch resources; on a `child` step (`//x` included) they may also
 *   read its position among its siblings so far (`[1]`, `[position() < 3]`),
 *   but never `last()`.
 * - **The operations** are the rest: the path's later steps, predicates of
 *   the selection's last step that read the element's content (`row[c]`,
 *   which must not depend on positions), and the right-hand sides of `!`.
 *   They run on each match once its end tag has arrived, and may do
 *   anything that stays within it: not the `parent`, `ancestor`, `preceding`,
 *   `following` (or `-sibling`, `-or-self`) axes, paths from the root,
 *   `fn:root`, `fn:path`, `fn:id`, `fn:idref`, `fn:element-with-id`,
 *   `fn:generate-id` or `fn:function-lookup`, and not `position()` or
 *   `last()` of the matches.
 * - **The prolog** may declare namespaces, options, functions (whose bodies
 *   follow the operations' rules) and variables (whose initializers can't
 *   read the context item); not a context item, and no module imports.
 *
 * @example
 * ```ts
 * import * as Result from "effect/Result"
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * console.log(Result.isSuccess(XQuery.compileStream("//row[@r > 1] ! string(c)"))) // true
 *
 * const bad = XQuery.compileStream("//row[last()]")
 * if (Result.isFailure(bad)) console.log(bad.failure.code.local) // "NotStreamable"
 * ```
 *
 * @since 0.1.0
 * @category streaming
 */
export const compileStream = (
  query: Query | string,
  options?: CompileOptions,
): Result.Result<StreamQuery, XQueryError> =>
  Result.flatMap(P.isString(query) ? compile(query, options) : Result.succeed(query), planOf);

/**
 * Options for {@link stream}: those of `evaluate` but the context item, which
 * is each match in turn.
 *
 * @since 0.1.0
 * @category streaming
 */
export type StreamOptions = Omit<EvaluateOptions, "context">;

/** A match as an XDM node, under copies of its ancestors that keep only their names and attributes. */
const nodeOf = (match: Match): XdmNode => {
  const top = match.ancestors.reduceRight<XmlElement>(
    (inner, a) => Nodes.element(a.name, a.attributes, [inner]),
    match.element,
  );
  return match.ancestors.reduce(
    (node: XdmNode) => node.children[0] ?? node,
    XdmNode.fromElement(top),
  );
};

/** The node a nested match is, from the DOM child indices that lead to it. */
const locate = (from: XdmNode, path: ReadonlyArray<number>): XdmNode =>
  path.reduce((node, index) => {
    const target = Option.getOrUndefined(node.element)?.children[index];
    return node.children.find((c) => Option.getOrUndefined(c.element) === target) ?? node;
  }, from);

const apply = (op: CompiledOperation, items: Sequence, ctx: Ctx): Sequence => {
  if (op.kind === "step") return stepOver(op.code, items, ctx, op.offset);
  const size = items.length;
  if (op.kind === "map") return items.flatMap((item, i) => op.code(ctx.focus(item, i + 1, size)));
  return items.filter((item, i) =>
    selects(op.code(ctx.focus(item, i + 1, size)), i + 1, op.offset),
  );
};

/**
 * Evaluate a query over a stream of SAX events: each subtree its selection
 * matches is built when its end tag arrives, the operations run on it (and
 * on the matches nested in it, after it), and the resulting XDM items are
 * emitted in document order, as `evaluate` would give them for the parsed
 * document. Nothing outside the matches is kept, so memory is bounded by
 * the largest match, not the document.
 *
 * The query is text (compiled as XQuery 3.1 with `options.compile`), a
 * {@link Query}, or a {@link StreamQuery} from {@link compileStream}; one
 * that can't be streamed fails the stream at once with the error
 * {@link compileStream} gives. Nodes in the results belong to their match:
 * its ancestors are copies with their names, attributes and namespaces but
 * no other content, so `fn:lang`, `fn:base-uri` and in-scope namespaces are
 * the document's, and the path's own rules keep queries from reaching
 * beyond the match. Dynamic errors fail the stream after the items before
 * them; SAX well-formedness errors fail it as `Sax.select`'s do.
 * `fn:doc` and the other resource functions go through the `Resolver`
 * service when one is provided, as in `evaluate`.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 * import { Sax, XQuery } from "@thomasfosterau/effect-xml"
 *
 * const sheet = Stream.make(
 *   `<sheet><row r="1"><c>a</c><c>b</c></row><row r="2"><c>c</c></row></sheet>`
 * )
 * const rows = sheet.pipe(
 *   Sax.tokenize(),
 *   XQuery.stream("//row[@r] ! string-join((@r, c), ':')"),
 *   Stream.map((item) => XQuery.atomicString(item as XQuery.AtomicValue)),
 *   Stream.runCollect
 * )
 * console.log(Effect.runSync(rows)) // ["1:a:b", "2:c"]
 * ```
 *
 * @since 0.1.0
 * @category streaming
 */
export const stream =
  (query: StreamQuery | Query | string, options: StreamOptions = {}) =>
  <E, R>(
    events: Stream.Stream<SaxEvent, E, R>,
  ): Stream.Stream<Item, E | SaxError | XQueryError, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const compiled = Result.flatMap(
          P.isString(query)
            ? compileStream(query, {
                ...options.compile,
                variables: [
                  ...(options.compile?.variables ?? []),
                  ...R.keys(options.variables ?? {}),
                ],
              })
            : P.isTagged(query, "StreamQuery")
              ? Result.succeed(query)
              : compileStream(query),
          planFor,
        );
        if (Result.isFailure(compiled)) return Stream.fail(compiled.failure);
        const resolver = yield* Effect.serviceOption(Resolver);
        const dynamic = yield* dynamicContext(options, undefined, Option.isSome(resolver));
        return over(compiled.success, { ...dynamic, globals: [] }, resolver, events);
      }),
    );

/** A streamed query's plan (compiled again for a `StreamQuery` that {@link compileStream} did not make). */
const planFor = (query: StreamQuery): Result.Result<Plan, XQueryError> => {
  const known = plans.get(query);
  if (known !== undefined) return Result.succeed(known);
  return Result.flatMap(planOf(query.query), planFor);
};

/** The items of each match, in order: synchronously while no resource is needed. */
const evaluateMatches = (
  plan: Plan,
  matches: ReadonlyArray<Match>,
  dyn: Dynamic,
  resolver: Option.Option<ResourceResolver>,
): Stream.Stream<Item, XQueryError> => {
  const evaluate = (match: Match): Sequence => {
    const root = nodeOf(match);
    const ctx = new Ctx(undefined, 0, 0, [], dyn);
    return plan.operations.reduce<Sequence>(
      (items, op) => apply(op, items, ctx),
      [root, ...match.nested.map((path) => locate(root, path))],
    );
  };
  const items: Array<Item> = [];
  // Synchronously, up to the first error or request for a resource.
  const stopped = Arr.findFirst(matches, (match, i) => {
    const outcome = attempt(() => evaluate(match));
    if (Result.isFailure(outcome)) return Option.some({ failure: outcome.failure, at: i });
    items.push(...outcome.success);
    return Option.none();
  });
  const done = Stream.fromArray(items);
  return Option.match(stopped, {
    onNone: () => done,
    onSome: ({ failure, at }) => {
      if (!(failure instanceof Suspend)) return Stream.concat(done, Stream.fail(failure));
      // A resource is needed: fetch it, and evaluate the rest as effects.
      const rest = Stream.fromEffect(
        Effect.flatMap(fetchFor(failure, dyn.resources, resolver), () =>
          Effect.forEach(
            matches.slice(at),
            (m) => resume(() => evaluate(m), dyn.resources, resolver),
            { concurrency: 1 },
          ),
        ),
      ).pipe(Stream.flatMap((results) => Stream.fromArray(results.flat())));
      return Stream.concat(done, rest);
    },
  });
};

const over = <E, R>(
  plan: Plan,
  dyn: Dynamic,
  resolver: Option.Option<ResourceResolver>,
  events: Stream.Stream<SaxEvent, E, R>,
): Stream.Stream<Item, E | SaxError | XQueryError, R> =>
  Stream.suspend(() => {
    const selector = new Selector({
      steps: plan.steps,
      view: (element) => XdmNode.fromElement(element),
      passes: (predicate: CompiledPredicate, node: XdmNode, position: number) =>
        selects(
          predicate.code(new Ctx(node, position, position, [], dyn)),
          position,
          predicate.offset,
        ),
      nested: true,
      ancestors: true,
    });
    return selectFrom(
      events,
      selector,
      (matches) => evaluateMatches(plan, matches, dyn, resolver),
      (fold): SaxError | XQueryError | undefined => {
        const fed = attempt(fold);
        if (Result.isSuccess(fed)) return fed.success;
        return fed.failure instanceof Suspend
          ? notStreamableError(
              "a selection predicate needed a resource, which can't be fetched while streaming",
            )
          : fed.failure;
      },
    );
  });
