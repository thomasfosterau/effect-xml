/**
 * XPath 1.0 over the DOM.
 *
 * Expressions are compiled once and run against a document, an element or a
 * {@link Cursor}. They are evaluated by the XQuery engine's XPath 3.1, in
 * XPath 1.0 compatibility mode (XPath 3.1 §2.1.1), so an XPath 1.0
 * expression gives XPath 1.0's result: comparisons between node-sets,
 * strings, numbers and booleans, arithmetic, and function arguments convert
 * their operands as XPath 1.0 did. The whole of XPath 1.0 is there:
 *
 * - location paths over every axis but `namespace`, absolute or relative,
 *   abbreviated or not, with predicates (positions, `last()`, comparisons);
 * - unions (`|`), `or` / `and`, the comparisons, `+`, `-`, `*`, `div`,
 *   `mod` and unary minus;
 * - variables (`$name`), declared when compiling and given when evaluating;
 * - every XPath 1.0 function, from `last()` to `round()`.
 *
 * Expressions may also use the rest of XPath 3.1 (`for`, `if`, sequences,
 * `xs:` types, the F&O 3.1 library). An expression need not be a location
 * path: {@link string}, {@link number} and {@link boolean} read any value,
 * and {@link evaluate} returns every item, failing with the dynamic error if
 * evaluation raises one (which only XPath 3.1's additions can do; the other
 * functions then return nothing).
 *
 * Name tests are namespace-aware: prefixes are bound when compiling, and an
 * unprefixed element name is in no namespace (as in XPath 1.0) unless a
 * `defaultNamespace` is given.
 *
 * Results are the DOM's own nodes. Following the XPath data model, a run of
 * adjacent text and CDATA nodes is one text node: `text()` selects each run
 * (and {@link select} returns the DOM nodes it is made of), and from a
 * document, `/` is the document node, whose children include the comments
 * and processing instructions around the root element.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Result from "effect/Result"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const DC = "http://purl.org/dc/elements/1.1/"
 * const doc = Effect.runSync(
 *   Xml.parse(
 *     `<meta xmlns:dc="${DC}"><dc:title xml:lang="fr">Bonjour</dc:title>` +
 *       `<dc:title xml:lang="en">Hello</dc:title></meta>`
 *   )
 * )
 *
 * const title = Xml.XPath.compile("//dc:title[@xml:lang='en']/text()", {
 *   namespaces: { dc: DC }
 * })
 * if (Result.isSuccess(title)) {
 *   console.log(Xml.XPath.string(title.success, doc)) // Option.some("Hello")
 * }
 *
 * const count = Xml.XPath.compile("count(//dc:title) * 10 + 1", { namespaces: { dc: DC } })
 * if (Result.isSuccess(count)) console.log(Xml.XPath.number(count.success, doc)) // 21
 * ```
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Clock from "effect/Clock";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { document as makeDocument } from "../internal/nodes.ts";
import { quote } from "../internal/quote.ts";
import { AtomicValue, atomicString } from "../internal/xquery/atomic.ts";
import { toNumber } from "../internal/xquery/eval/cast.ts";
import { compileQuery, runCompiled, type Compiled } from "../internal/xquery/eval/compile.ts";
import { numberOf } from "../internal/xquery/eval/compare.ts";
import { attemptSync } from "../internal/xquery/eval/raise.ts";
import { Resources, type Dynamic } from "../internal/xquery/eval/runtime.ts";
import { formatParts, partsAt } from "../internal/xquery/eval/temporal.ts";
import {
  atomize,
  effectiveBooleanValue,
  isAtomic,
  isNode,
  stringValue,
  type Item,
  type Sequence,
} from "../internal/xquery/item.ts";
import { XdmNode } from "../internal/xquery/node.ts";
import {
  Expr as XExprE,
  NodeTest as XNodeTestE,
  type Expr as XExpr,
  type NodeTest as XNodeTest,
} from "../internal/xquery/parser/ast.ts";
import { builtinArities, Namespaces as XNamespaces } from "../internal/xquery/parser/builtins.ts";
import type { StaticContext } from "../internal/xquery/parser/context.ts";
import type { StaticError } from "../internal/xquery/parser/errors.ts";
import { compileXPath } from "../internal/xquery/parser/index.ts";
import { AtomicTypes, isNumericType } from "../internal/xquery/types.ts";
import type { XQueryError } from "../XQuery/Error.ts";
import { Cursor } from "./Cursor.ts";
import {
  XmlAttribute,
  XmlDocument,
  XmlElement,
  type XmlCData,
  type XmlComment,
  type XmlNode,
  type XmlProcessingInstruction,
  type XmlText,
} from "./Node.ts";

// -----------------------------------------------------------------------------
// Syntax
// -----------------------------------------------------------------------------

/**
 * The axes a step can move along: XPath's thirteen.
 *
 * @since 0.1.0
 * @category syntax
 */
export type Axis =
  | "child"
  | "descendant"
  | "descendant-or-self"
  | "self"
  | "parent"
  | "ancestor"
  | "attribute"
  | "ancestor-or-self"
  | "following"
  | "following-sibling"
  | "preceding"
  | "preceding-sibling"
  | "namespace";

/**
 * What a step matches in the syntax view: a name, `*` or `prefix:*`,
 * `text()` or `node()`. A step with any other test (`comment()`, `*:local`,
 * `element(…)`, …) shows as `node()` with a `position()` predicate first
 * (see {@link Expr}).
 *
 * @since 0.1.0
 * @category syntax
 */
export type NodeTest =
  | { readonly _tag: "Name"; readonly namespace: string | null; readonly local: string }
  /** `*` (namespace `undefined`) or `prefix:*`. */
  | { readonly _tag: "Any"; readonly namespace: string | null | undefined }
  | { readonly _tag: "Text" }
  | { readonly _tag: "Node" };

/**
 * One step of a location path: an axis, a node test and predicates.
 *
 * @since 0.1.0
 * @category syntax
 */
export interface Step {
  readonly axis: Axis;
  readonly test: NodeTest;
  readonly predicates: ReadonlyArray<Expr>;
}

/**
 * A parsed location path: its steps, and whether it starts at the root.
 *
 * @since 0.1.0
 * @category syntax
 */
export interface LocationPath {
  readonly absolute: boolean;
  readonly steps: ReadonlyArray<Step>;
}

/**
 * The functions of the syntax view ({@link Expr}): those of the subset this
 * module started as. Calls of the other functions appear as `position()`.
 *
 * @since 0.1.0
 * @category syntax
 */
export type Fn =
  | "not"
  | "position"
  | "last"
  | "count"
  | "string"
  | "local-name"
  | "contains"
  | "starts-with"
  | "normalize-space";

/**
 * The binary operators of the syntax view ({@link Expr}).
 *
 * @since 0.1.0
 * @category syntax
 */
export type Op = "or" | "and" | "=" | "!=" | "<" | "<=" | ">" | ">=";

/**
 * A predicate expression, as the syntax view ({@link Path.path}) shows it.
 *
 * The view covers the subset this module started as: location paths,
 * numbers, strings, the comparisons, `and` / `or` and the functions of
 * {@link Fn}. Anything else in a predicate (arithmetic, a union, another
 * function) appears as a call of `position()`, which streaming selection
 * (`Sax.select`) rejects, as it rejects positions.
 *
 * @since 0.1.0
 * @category syntax
 */
export type Expr =
  | { readonly _tag: "Path"; readonly path: LocationPath }
  | { readonly _tag: "Number"; readonly value: number }
  | { readonly _tag: "Literal"; readonly value: string }
  | { readonly _tag: "Call"; readonly fn: Fn; readonly args: ReadonlyArray<Expr> }
  | { readonly _tag: "Binary"; readonly op: Op; readonly left: Expr; readonly right: Expr };

/**
 * An expression that isn't valid, uses a name that isn't in scope, or (from
 * {@link evaluate}) raised an error. `reason` ends with the XPath error
 * code, as in `(err:XPST0003)`.
 *
 * @since 0.1.0
 * @category errors
 */
export class XPathError extends Schema.TaggedError<XPathError>()("XPathError", {
  expression: Schema.String,
  offset: Schema.Number,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Invalid XPath ${quote(this.expression)} at offset ${this.offset}: ${this.reason}`;
  }
}

/**
 * Options for {@link compile}: namespace bindings for prefixes, the namespace of unprefixed element names, and the variables in scope.
 *
 * @since 0.1.0
 * @category options
 */
export interface CompileOptions {
  /** Prefix → namespace URI bindings for the name tests. `xml` is always bound. */
  readonly namespaces?: Readonly<Record<string, string>> | undefined;
  /** The namespace of unprefixed element names (default: none, as in XPath 1.0). */
  readonly defaultNamespace?: string | undefined;
  /**
   * The variables the expression may read (`$name`), whose values
   * evaluation is given: names in no namespace, or Clark names (`{uri}local`).
   */
  readonly variables?: ReadonlyArray<string> | undefined;
}

/**
 * A compiled expression: its text, and its syntax view.
 *
 * @since 0.1.0
 * @category models
 */
export interface Path {
  readonly expression: string;
  /**
   * The expression as a location path, in the terms of the subset this
   * module started as (see {@link Expr}); streaming selection reads it. An
   * expression that is not a location path is `child::node()[position()]`.
   */
  readonly path: LocationPath;
}

/** A compiled program, and the static context its view was built in. */
interface Program {
  readonly compiled: Compiled;
}

/** Each compiled path's program (by identity: a weak map, as paths are plain values). */
const programs = /*#__PURE__*/ new WeakMap<Path, Result.Result<Program, XPathError>>();

/** The reason a static error gives. */
const staticReason = (e: StaticError): string => {
  const code = ` (err:${e.code})`;
  const call = e.code === "XPST0017" ? /no function ([^#\s]+)#\d+/.exec(e.description) : null;
  const name = call?.[1];
  if (name === undefined) return e.description + code;
  const local = name.slice(Math.max(name.lastIndexOf(":"), name.lastIndexOf("}")) + 1);
  return Option.match(builtinArities(`{${XNamespaces.fn}}${local}`), {
    onNone: () => e.description + code,
    onSome: (arities) =>
      `${local}() takes ${arities
        .map((a) =>
          a.min === a.max
            ? `${a.min}`
            : a.max === Infinity
              ? `${a.min} or more`
              : `${a.min} to ${a.max}`,
        )
        .join(" or ")} argument(s)${code}`,
  });
};

/** An error evaluation raised, as an {@link XPathError}. */
const dynamicError = (expression: string, e: XQueryError): XPathError =>
  new XPathError({
    expression,
    offset: e.offset ?? 0,
    reason: `${e.description} (${e.code.qualified})`,
  });

const staticOptions = (options: CompileOptions | undefined) => ({
  namespaces: options?.namespaces,
  defaultElementNamespace: options?.defaultNamespace,
  variables: options?.variables,
  xpath1Compatibility: true,
});

/** Compile an expression's text to a program and its tree. */
const build = (
  expression: string,
  options: CompileOptions | undefined,
): Result.Result<
  { readonly program: Program; readonly expr: XExpr; readonly context: StaticContext },
  XPathError
> =>
  Result.mapError(
    Result.flatMap(
      Result.mapError(compileXPath(expression, staticOptions(options)), (e) => ({
        offset: e.offset,
        reason: staticReason(e),
      })),
      ({ expr, context }) =>
        Result.mapBoth(
          attemptSync(() =>
            compileQuery(
              { language: "XPath", source: expression, expr, context },
              Array.from(context.variables),
            ),
          ),
          {
            onFailure: (e) => ({
              offset: e.offset ?? 0,
              reason: `${e.description} (${e.code.qualified})`,
            }),
            onSuccess: (compiled) => ({ program: { compiled }, expr, context }),
          },
        ),
    ),
    ({ offset, reason }) => new XPathError({ expression, offset, reason }),
  );

/**
 * Compile an expression: XPath 1.0 (or XPath 3.1), in XPath 1.0 compatibility
 * mode. It fails with an {@link XPathError} at the offset of the problem: a
 * syntax error, or a prefix, function or variable that is not in scope.
 *
 * @since 0.1.0
 * @category compiling
 */
export const compile = (
  expression: string,
  options?: CompileOptions,
): Result.Result<Path, XPathError> =>
  Result.map(build(expression, options), ({ program, expr, context }) => {
    const path: Path = { expression, path: viewOf(expr, context, expression) };
    programs.set(path, Result.succeed(program));
    return path;
  });

/** The program of a path; a path built by hand is compiled from its syntax view. */
const programOf = (path: Path): Result.Result<Program, XPathError> => {
  const known = programs.get(path);
  if (known !== undefined) return known;
  const built = Result.map(build(printPath(path.path), undefined), (b) => b.program);
  programs.set(path, built);
  return built;
};

// -----------------------------------------------------------------------------
// The syntax view
// -----------------------------------------------------------------------------

/** `..` and `.`: the parent and the context node itself. */
const parentStep: Step = { axis: "parent", test: { _tag: "Node" }, predicates: [] };
const selfStep: Step = { axis: "self", test: { _tag: "Node" }, predicates: [] };
const anyNode: Step = { axis: "descendant-or-self", test: { _tag: "Node" }, predicates: [] };

/** What a predicate outside the view's subset shows as. */
const outside: Expr = { _tag: "Call", fn: "position", args: [] };

/** The arity range of each function the view supports, by name. */
interface ViewFunctions extends R.ReadonlyRecord<string, readonly [min: number, max: number]> {}

const viewFunctions: ViewFunctions = {
  not: [1, 1],
  position: [0, 0],
  last: [0, 0],
  count: [1, 1],
  string: [0, 1],
  "local-name": [0, 1],
  contains: [2, 2],
  "starts-with": [2, 2],
  "normalize-space": [0, 1],
};

const isViewFunction = (local: string): local is Fn =>
  R.has<string, readonly [min: number, max: number]>(viewFunctions, local);

/** The operators the view supports. */
interface ViewOps extends R.ReadonlyRecord<string, true> {}

const viewOps: ViewOps = {
  or: true,
  and: true,
  "=": true,
  "!=": true,
  "<": true,
  "<=": true,
  ">": true,
  ">=": true,
};

const isViewOp = (op: string): op is Op => R.has<string, true>(viewOps, op);

/** The namespace a prefix is bound to; the analysis checked it is bound. */
const prefixUri = (context: StaticContext, prefix: string): string =>
  Option.getOrElse(HashMap.get(context.namespaces, prefix), () => "");

const nullable = (namespace: string): string | null => (namespace === "" ? null : namespace);

/** A node test in the view's terms; `undefined` for one outside them. */
const viewTest = (test: XNodeTest, axis: Axis, context: StaticContext): NodeTest | undefined =>
  XNodeTestE.$match(test, {
    Name: ({ name: { prefix, uri, local } }): NodeTest => ({
      _tag: "Name",
      namespace: nullable(
        Option.isSome(uri)
          ? uri.value
          : Option.isSome(prefix)
            ? prefixUri(context, prefix.value)
            : axis === "attribute"
              ? ""
              : context.defaultElementNamespace,
      ),
      local,
    }),
    Wildcard: ({ wildcard: { prefix, uri, local } }): NodeTest | undefined =>
      Option.isSome(local)
        ? undefined
        : {
            _tag: "Any",
            namespace: Option.isSome(uri)
              ? nullable(uri.value)
              : Option.isSome(prefix)
                ? nullable(prefixUri(context, prefix.value))
                : undefined,
          },
    Kind: ({ test: kind }): NodeTest | undefined =>
      P.isTagged(kind, "Text")
        ? { _tag: "Text" }
        : P.isTagged(kind, "AnyKind")
          ? { _tag: "Node" }
          : undefined,
  });

const isAnyKind = (test: XNodeTest): boolean =>
  XNodeTestE.$is("Kind")(test) && P.isTagged(test.test, "AnyKind");

const viewStep = (e: XExpr, context: StaticContext, source: string): Step | undefined => {
  if (XExprE.$is("ContextItem")(e)) return selfStep;
  if (!XExprE.$is("AxisStep")(e)) return undefined;
  if (e.axis === "parent" && isAnyKind(e.test) && Arr.isReadonlyArrayEmpty(e.predicates))
    return parentStep;
  const test = viewTest(e.test, e.axis, context);
  const predicates = e.predicates.map((p) => viewExpr(p, context, source));
  return test === undefined
    ? { axis: e.axis, test: { _tag: "Node" }, predicates: [outside, ...predicates] }
    : { axis: e.axis, test, predicates };
};

const viewLocationPath = (
  e: XExpr,
  context: StaticContext,
  source: string,
): LocationPath | undefined => {
  if (!XExprE.$is("Path")(e)) {
    const only = viewStep(e, context, source);
    return only === undefined ? undefined : { absolute: false, steps: [only] };
  }
  const steps = e.steps.map((s) => viewStep(s, context, source));
  if (!steps.every(P.isNotUndefined)) return undefined;
  return {
    absolute: e.root !== "relative",
    steps: e.root === "descendants" ? [anyNode, ...steps] : steps,
  };
};

/** A call in the view's terms: one of its functions, in `fn:`, at an arity it has; `outside` for any other. */
const viewCall = (
  e: Extract<XExpr, { readonly _tag: "FunctionCall" }>,
  context: StaticContext,
  source: string,
): Expr => {
  const { prefix, uri, local } = e.name;
  const namespace = Option.isSome(uri)
    ? uri.value
    : Option.isSome(prefix)
      ? prefixUri(context, prefix.value)
      : context.defaultFunctionNamespace;
  if (namespace !== XNamespaces.fn || !isViewFunction(local)) return outside;
  const [min, max] = viewFunctions[local] ?? [0, 0];
  return e.args.length >= min && e.args.length <= max
    ? { _tag: "Call", fn: local, args: e.args.map((a) => viewExpr(a, context, source)) }
    : outside;
};

const viewExpr = (e: XExpr, context: StaticContext, source: string): Expr => {
  if (
    XExprE.$is("IntegerLiteral")(e) ||
    XExprE.$is("DecimalLiteral")(e) ||
    XExprE.$is("DoubleLiteral")(e)
  )
    return { _tag: "Number", value: Number(e.value) };
  if (XExprE.$is("StringLiteral")(e)) return { _tag: "Literal", value: e.value };
  if (XExprE.$is("Binary")(e) && isViewOp(e.op))
    return {
      _tag: "Binary",
      op: e.op,
      left: viewExpr(e.left, context, source),
      right: viewExpr(e.right, context, source),
    };
  if (XExprE.$is("FunctionCall")(e)) return viewCall(e, context, source);
  const path = viewLocationPath(e, context, source);
  return path === undefined ? outside : { _tag: "Path", path };
};

/** The syntax view of an expression: its location path, or `child::node()[position()]` when it is not one. */
const viewOf = (e: XExpr, context: StaticContext, source: string): LocationPath =>
  viewLocationPath(e, context, source) ?? {
    absolute: false,
    steps: [{ axis: "child", test: { _tag: "Node" }, predicates: [outside] }],
  };

// -----------------------------------------------------------------------------
// Printing the syntax view, for paths and predicates built by hand
// -----------------------------------------------------------------------------

const braced = (namespace: string | null): string => `Q{${namespace ?? ""}}`;

const printTest = (t: NodeTest): string =>
  Match.valueTags(t, {
    Name: (n) => `${braced(n.namespace)}${n.local}`,
    Any: (n) => (n.namespace === undefined ? "*" : `${braced(n.namespace)}*`),
    Text: () => "text()",
    Node: () => "node()",
  });

const printString = (s: string): string => `"${s.replaceAll('"', '""')}"`;

const printNumber = (n: number): string =>
  Number.isNaN(n)
    ? "(0e0 div 0e0)"
    : n === Infinity
      ? "(1e0 div 0e0)"
      : n === -Infinity
        ? "(-1e0 div 0e0)"
        : n < 0
          ? `(${String(n)})`
          : String(n);

const printStep = (s: Step): string =>
  `${s.axis}::${printTest(s.test)}${s.predicates.map((p) => `[${printExpr(p)}]`).join("")}`;

const printPath = (p: LocationPath): string => {
  const steps = p.steps.map(printStep).join("/");
  return p.absolute ? `/${steps}` : steps === "" ? "." : steps;
};

const printExpr = (e: Expr): string =>
  Match.valueTags(e, {
    Path: (x) => printPath(x.path),
    Number: (x) => printNumber(x.value),
    Literal: (x) => printString(x.value),
    Call: (x) => `${x.fn}(${x.args.map(printExpr).join(", ")})`,
    Binary: (x) => `(${printExpr(x.left)}) ${x.op} (${printExpr(x.right)})`,
  });

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

/**
 * What a path selects: elements, attributes, and text, comment and PI nodes.
 * Attributes have no `_tag`; tell them apart with `instanceof XmlAttribute`.
 *
 * @since 0.1.0
 * @category models
 */
export type XPathNode =
  | XmlElement
  | XmlAttribute
  | XmlText
  | XmlCData
  | XmlComment
  | XmlProcessingInstruction;

/**
 * Where a path is evaluated from.
 *
 * @since 0.1.0
 * @category models
 */
export type Context = XmlDocument | XmlElement | Cursor;

/**
 * A value of XPath 1.0: a string, a number, a boolean, or nodes (a
 * document, an element or a cursor stands for the node it is). A value of a
 * variable, and an item of what {@link evaluate} returns.
 *
 * @since 0.1.0
 * @category models
 */
export type Value = string | number | boolean | Context | XPathNode;

/**
 * Options for evaluating a compiled expression: the values of its variables.
 *
 * @since 0.1.0
 * @category options
 */
export interface EvaluateOptions {
  /**
   * The variables' values, by the names {@link CompileOptions.variables}
   * declared: a value or a sequence of values (a node-set). A number is an
   * `xs:double`, as XPath 1.0's numbers are.
   */
  readonly variables?: Readonly<Record<string, Value | ReadonlyArray<Value>>> | undefined;
}

/** The XDM trees of one evaluation, by the DOM element at their top: one tree per DOM tree. */
class Trees {
  // Keyed by identity (DOM nodes are equal by value), so weak maps.
  private readonly tops = new WeakMap<XmlElement, XdmNode>();
  private readonly documents = new WeakMap<XmlDocument, XdmNode>();

  /** The document node over a parsed document. */
  document(doc: XmlDocument): XdmNode {
    const known = this.documents.get(doc);
    if (known !== undefined) return known;
    const node = XdmNode.fromDocument(doc);
    this.documents.set(doc, node);
    return node;
  }

  /** The element node at the top of a tree, under a document node of its own (as XPath 1.0's root node). */
  top(element: XmlElement): XdmNode {
    const known = this.tops.get(element);
    if (known !== undefined) return known;
    const [node] = XdmNode.fromDocument(makeDocument(null, null, [element])).children;
    // The document's one child is the element.
    const top = node ?? XdmNode.fromElement(element);
    this.tops.set(element, top);
    return top;
  }

  /** The node a context stands for. */
  node(context: Context): XdmNode {
    if (context instanceof Cursor) {
      const chain = [...context.ancestors.toReversed(), context];
      const [top, ...below] = chain;
      return Arr.reduce(below, this.top((top ?? context).element), (at, c) => childAt(at, c.index));
    }
    if (context instanceof XmlElement) return this.top(context);
    return this.document(context);
  }
}

/** The child of an XDM node that stands for the DOM child at `index`; a cursor only stands on elements, which are always children. */
const childAt = (node: XdmNode, index: number): XdmNode =>
  Option.getOrElse(
    Arr.findFirst(node.children, (c) => c.domStart <= index && index < c.domEnd),
    () => node,
  );

/** An item for a variable's value; an attribute, text, comment or PI on its own is a parentless node. */
const itemOf = (trees: Trees, v: Value): Item => {
  if (P.isString(v)) return AtomicValue.string(v);
  if (P.isNumber(v)) return AtomicValue.double(v);
  if (P.isBoolean(v)) return AtomicValue.boolean(v);
  if (v instanceof Cursor || v instanceof XmlElement || v instanceof XmlDocument)
    return trees.node(v);
  if (v instanceof XmlAttribute) return XdmNode.fromAttribute(v);
  if (P.isTagged(v, "XmlComment")) return XdmNode.fromComment(v);
  if (P.isTagged(v, "XmlProcessingInstruction")) return XdmNode.fromProcessingInstruction(v);
  return XdmNode.fromText(v.data);
};

const noExternals: HashMap.HashMap<string, Sequence> = /*#__PURE__*/ HashMap.empty();

const clarkKey = (name: string): string => (name.startsWith("{") ? name : `{}${name}`);

/** The dynamic context of one evaluation; the current dateTime is read only if the expression asks for it. */
class XPathDynamic implements Dynamic {
  readonly globals: Array<Sequence | undefined> = [];
  readonly resources = new Resources(false);
  readonly implicitTimezone = 0;
  readonly environment: Readonly<Record<string, string>> = {};
  readonly initialContext: Item;
  readonly externals: HashMap.HashMap<string, Sequence>;
  private now: string | undefined;

  constructor(initialContext: Item, externals: HashMap.HashMap<string, Sequence>) {
    this.initialContext = initialContext;
    this.externals = externals;
  }

  get currentDateTime(): string {
    this.now ??= formatParts(
      AtomicTypes.dateTimeStamp,
      partsAt(BigDecimal.make(BigInt(Clock.Clock.defaultValue().currentTimeMillisUnsafe()), 3), 0),
    );
    return this.now;
  }
}

const isValues = (v: Value | ReadonlyArray<Value>): v is ReadonlyArray<Value> => Array.isArray(v);

/** Evaluate a compiled expression: its items, or the error it raised. */
const run = (
  path: Path,
  context: Context,
  options: EvaluateOptions | undefined,
): Result.Result<Sequence, XPathError> =>
  Result.flatMap(programOf(path), ({ compiled }) => {
    const trees = new Trees();
    const variables = options?.variables;
    const externals =
      variables === undefined
        ? noExternals
        : HashMap.fromIterable(
            R.toEntries(variables).map(([k, v]): readonly [string, Sequence] => [
              clarkKey(k),
              isValues(v) ? v.map((x) => itemOf(trees, x)) : [itemOf(trees, v)],
            ]),
          );
    return Result.mapError(
      attemptSync(() => runCompiled(compiled, new XPathDynamic(trees.node(context), externals))),
      (e) => dynamicError(path.expression, e),
    );
  });

/** The items an expression gives, or none if evaluating it raises an error. */
const itemsOf = (path: Path, context: Context, options?: EvaluateOptions): Sequence =>
  Result.getOrElse(run(path, context, options), () => []);

const isTextLike = (n: XmlNode): n is XmlText | XmlCData =>
  P.isTagged(n, "XmlText") || P.isTagged(n, "XmlCData");

const isXPathNode = (dom: XdmNode["dom"]): dom is Extract<XdmNode["dom"], XPathNode> =>
  dom instanceof XmlAttribute ||
  P.isTagged(dom, "XmlElement") ||
  P.isTagged(dom, "XmlComment") ||
  P.isTagged(dom, "XmlProcessingInstruction");

/** The DOM nodes an XDM node stands for (a text node's are the text and CDATA nodes it merges); none for a document or namespace node. */
const domNodes = (n: XdmNode): ReadonlyArray<XPathNode> => {
  if (n.kind === "document" || n.kind === "namespace") return [];
  if (n.kind !== "text") {
    const dom = n.dom;
    return isXPathNode(dom) ? [dom] : [];
  }
  const parent = Option.getOrUndefined(n.parent);
  const dom = parent?.dom;
  if (dom === undefined || !(dom instanceof XmlElement || dom instanceof XmlDocument)) return [];
  return dom.children.slice(n.domStart, n.domEnd).filter(isTextLike);
};

const nodesOf = (items: Sequence): ReadonlyArray<XPathNode> =>
  items.flatMap((item) => (isNode(item) ? domNodes(item) : []));

/** The string value of an item, as `fn:string` gives it. */
const stringOf = (item: Item): Option.Option<string> => Result.getSuccess(stringValue(item));

/**
 * The nodes `path` selects from `context`, in document order (items that are
 * not nodes are left out). From a document, `/` and relative paths start at
 * the document node; the document node itself is never returned.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const select = (
  path: Path,
  context: Context,
  options?: EvaluateOptions,
): ReadonlyArray<XPathNode> => nodesOf(itemsOf(path, context, options));

/** The cursor at an element node: the context's own tree's cursors where it is in that tree. */
const cursorAt = (node: XdmNode, element: XmlElement, context: Context): Cursor => {
  // The node and its element ancestors, nearest first.
  const chain = [
    { node, element },
    ...Arr.unfold(node, (at) =>
      Option.flatMap(at.parent, (parent) =>
        Option.map(parent.element, (e) => [{ node: parent, element: e }, parent] as const),
      ),
    ),
  ];
  const top = chain.at(-1) ?? { node, element };
  const base =
    context instanceof Cursor && context.top.element === top.element
      ? context.top
      : Cursor.root(top.element);
  return chain
    .slice(0, -1)
    .toReversed()
    .reduce((c, below) => c.at(below.node.domStart), base);
};

/**
 * The elements `path` selects, as cursors (with inherited `xml:lang`, `xml:base` and `xml:space`).
 *
 * @since 0.1.0
 * @category evaluation
 */
export const cursors = (
  path: Path,
  context: Context,
  options?: EvaluateOptions,
): ReadonlyArray<Cursor> =>
  itemsOf(path, context, options).flatMap((item) =>
    isNode(item)
      ? Option.toArray(Option.map(item.element, (element) => cursorAt(item, element, context)))
      : [],
  );

/**
 * The elements `path` selects.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const elements = (
  path: Path,
  context: Context,
  options?: EvaluateOptions,
): ReadonlyArray<XmlElement> =>
  itemsOf(path, context, options).flatMap((item) =>
    isNode(item) ? Option.toArray(item.element) : [],
  );

/**
 * The first node `path` selects.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const first = (
  path: Path,
  context: Context,
  options?: EvaluateOptions,
): Option.Option<XPathNode> => Arr.head(select(path, context, options));

/**
 * The string value of the first item `path` gives (an element's text
 * content, an attribute's value, a string, a number as `fn:string` writes
 * it); `None` when it gives none.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const string = (
  path: Path,
  context: Context,
  options?: EvaluateOptions,
): Option.Option<string> => Option.flatMap(Arr.head(itemsOf(path, context, options)), stringOf);

/**
 * The value `path` gives as a number, as XPath 1.0's `number()` takes it:
 * the first item's (NaN when there is none, or it is not a number).
 *
 * @since 0.1.0
 * @category evaluation
 */
export const number = (path: Path, context: Context, options?: EvaluateOptions): number => {
  const [head] = itemsOf(path, context, options);
  if (head === undefined) return Number.NaN;
  const [atom] = Result.getOrElse(atomize([head]), () => []);
  return atom === undefined ? Number.NaN : toNumber(numberOf(atom));
};

/**
 * The value `path` gives as a boolean, as XPath 1.0's `boolean()` takes it
 * (its effective boolean value): nodes are true, an empty node-set, `""`, 0
 * and NaN false.
 *
 * @since 0.1.0
 * @category evaluation
 */
export const boolean = (path: Path, context: Context, options?: EvaluateOptions): boolean =>
  Result.getOrElse(effectiveBooleanValue(itemsOf(path, context, options)), () => false);

/** An item as a {@link Value}: a node's DOM nodes, an atomic value as a number, boolean or string. */
const valuesOf = (item: Item): Result.Result<ReadonlyArray<Value>, string> => {
  if (isNode(item)) return Result.succeed(domNodes(item));
  if (!isAtomic(item)) return Result.fail("a function, map or array, which has no XPath 1.0 value");
  if (isNumericType(item.type)) return Result.succeed([toNumber(item)]);
  if (P.isBoolean(item.value)) return Result.succeed([item.value]);
  return Result.succeed([atomicString(item)]);
};

/**
 * Every item `path` gives: nodes as the DOM's nodes, numbers, booleans, and
 * any other atomic value as its string. Unlike the other functions, it fails
 * with the error evaluation raises, an {@link XPathError} with its code (or
 * one for a function item in the result).
 *
 * @since 0.1.0
 * @category evaluation
 */
export const evaluate = (
  path: Path,
  context: Context,
  options?: EvaluateOptions,
): Result.Result<ReadonlyArray<Value>, XPathError> =>
  Result.flatMap(run(path, context, options), (items) =>
    Result.mapError(
      Result.map(Result.all(items.map(valuesOf)), (vs) => vs.flat()),
      (reason) => new XPathError({ expression: path.expression, offset: 0, reason }),
    ),
  );

/** Compiled predicates of the syntax view, by expression. */
const predicates = /*#__PURE__*/ new WeakMap<Expr, Result.Result<Program, XPathError>>();

/** @internal Evaluate a predicate expression with `cursor` as the context node (used by streaming selection). */
export const test = (e: Expr, cursor: Cursor): boolean => {
  const known = predicates.get(e);
  const program = known ?? Result.map(build(printExpr(e), undefined), (b) => b.program);
  if (known === undefined) predicates.set(e, program);
  return Result.match(program, {
    onFailure: () => false,
    onSuccess: ({ compiled }) =>
      Result.getOrElse(
        Result.flatMap(
          attemptSync(() =>
            runCompiled(compiled, new XPathDynamic(new Trees().node(cursor), noExternals)),
          ),
          effectiveBooleanValue,
        ),
        () => false,
      ),
  });
};
