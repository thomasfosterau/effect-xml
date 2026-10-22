/**
 * A small subset of XPath 1.0.
 *
 * Enough for configuration-style lookups in Flat OPC, XMP and the like,
 * compiled once and run against a document, an element or a {@link Cursor}:
 *
 * - location paths, absolute or relative: `/`, `//`, `.`, `..`, `@`, `*`,
 *   `prefix:*`, `text()`, `node()`, and the `child`, `descendant`,
 *   `descendant-or-self`, `self`, `parent`, `ancestor` and `attribute` axes;
 * - predicates: positions (`[1]`, `[last()]`), comparisons (`=`, `!=`, `<`,
 *   `<=`, `>`, `>=`) between paths, strings and numbers, `and`, `or`, and the
 *   functions `not`, `position`, `last`, `count`, `string`, `local-name`,
 *   `contains`, `starts-with` and `normalize-space`.
 *
 * Name tests are namespace-aware: prefixes are bound when compiling, and an
 * unprefixed element name is in no namespace (as in XPath 1.0) unless a
 * `defaultNamespace` is given. Unions, arithmetic and variables are not
 * supported.
 *
 * @example
 * import { Result } from "effect"
 * import { Xml } from "effect-sax"
 *
 * const path = Result.getOrThrow(
 *   Xml.XPath.compile("//dc:title[@xml:lang='en']/text()", { namespaces: { dc: "http://purl.org/dc/elements/1.1/" } })
 * )
 * Xml.XPath.string(path, doc) // Option<string>
 */
import { Ascii, Expression, Parser, ParseError, Token } from "@thomasfosterau/effect-parse";
import { Data, Option, Result } from "effect";
import { Namespaces } from "../Name.ts";
import { NCName } from "../internal/names.ts";
import { Cursor } from "./Cursor.ts";
import {
  XmlDocument,
  XmlElement,
  type XmlAttribute,
  type XmlCData,
  type XmlComment,
  type XmlProcessingInstruction,
  type XmlText,
} from "./Node.ts";

// -----------------------------------------------------------------------------
// Syntax
// -----------------------------------------------------------------------------

export type Axis =
  | "child"
  | "descendant"
  | "descendant-or-self"
  | "self"
  | "parent"
  | "ancestor"
  | "attribute";

export type NodeTest =
  | { readonly _tag: "Name"; readonly namespace: string | null; readonly local: string }
  /** `*` (namespace `undefined`) or `prefix:*`. */
  | { readonly _tag: "Any"; readonly namespace: string | null | undefined }
  | { readonly _tag: "Text" }
  | { readonly _tag: "Node" };

export interface Step {
  readonly axis: Axis;
  readonly test: NodeTest;
  readonly predicates: ReadonlyArray<Expr>;
}

export interface LocationPath {
  readonly absolute: boolean;
  readonly steps: ReadonlyArray<Step>;
}

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

export type Op = "or" | "and" | "=" | "!=" | "<" | "<=" | ">" | ">=";

export type Expr =
  | { readonly _tag: "Path"; readonly path: LocationPath }
  | { readonly _tag: "Number"; readonly value: number }
  | { readonly _tag: "Literal"; readonly value: string }
  | { readonly _tag: "Call"; readonly fn: Fn; readonly args: ReadonlyArray<Expr> }
  | { readonly _tag: "Binary"; readonly op: Op; readonly left: Expr; readonly right: Expr };

/** The arity of each function: `[min, max]`. */
const arity: Record<Fn, readonly [number, number]> = {
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

/** An expression that isn't valid, or uses a prefix that isn't bound. */
export class XPathError extends Data.TaggedError("XPathError")<{
  readonly expression: string;
  readonly offset: number;
  readonly reason: string;
}> {
  override get message(): string {
    return `Invalid XPath ${JSON.stringify(this.expression)} at offset ${this.offset}: ${this.reason}`;
  }
}

export interface CompileOptions {
  /** Prefix → namespace URI bindings for the name tests. `xml` is always bound. */
  readonly namespaces?: Readonly<Record<string, string>>;
  /** The namespace of unprefixed element names (default: none, as in XPath 1.0). */
  readonly defaultNamespace?: string;
}

/** A compiled path. */
export interface Path {
  readonly expression: string;
  readonly path: LocationPath;
}

/** A prefix that isn't bound: reported as a user error from the grammar. */
interface Unbound {
  readonly prefix: string;
}

type P<A> = Parser.Parser<A, Unbound>;

const grammar = (options: CompileOptions | undefined): P<LocationPath> => {
  const namespaces: Record<string, string> = { xml: Namespaces.xml, ...options?.namespaces };
  const ws = Ascii.multispace0;
  const lex = <A>(p: P<A>): P<A> => Parser.terminated(p, ws);
  const sym = (s: string) => lex(Token.literal(s));

  const bind = (prefix: string): P<string> =>
    Object.hasOwn(namespaces, prefix)
      ? Parser.succeed(namespaces[prefix]!)
      : Parser.cut(Parser.fail({ prefix }));

  // `text()` and `node()` are node tests; any other `name(` is a function call.
  const kindTest: P<NodeTest> = Parser.alt(
    Parser.as(Parser.seq(Token.literal("text"), ws, Token.literal("("), ws, Token.literal(")")), {
      _tag: "Text",
    } as const),
    Parser.as(Parser.seq(Token.literal("node"), ws, Token.literal("("), ws, Token.literal(")")), {
      _tag: "Node",
    } as const),
  );

  const nameTest = (principal: "element" | "attribute"): P<NodeTest> =>
    Parser.alt(
      Parser.as(Token.literal("*"), { _tag: "Any", namespace: undefined } as const),
      Parser.gen(function* () {
        const first = yield* NCName;
        const colon = yield* Parser.optional(Token.literal(":"));
        if (colon === undefined) {
          const namespace = principal === "element" ? (options?.defaultNamespace ?? null) : null;
          return { _tag: "Name", namespace, local: first } as const;
        }
        const namespace = yield* bind(first);
        const local = yield* Parser.alt(Parser.as(Token.literal("*"), null), NCName);
        return local === null
          ? ({ _tag: "Any", namespace } as const)
          : ({ _tag: "Name", namespace, local } as const);
      }),
    );

  const axisName = Parser.alt(
    ...(
      [
        "descendant-or-self",
        "descendant",
        "child",
        "self",
        "parent",
        "ancestor",
        "attribute",
      ] as const
    ).map((a) => Parser.as(Parser.seq(Token.literal(a), ws, Token.literal("::")), a)),
  );

  const predicate: P<Expr> = Parser.delimited(
    sym("["),
    Parser.cut(Parser.suspend(() => expr)),
    Parser.cut(sym("]")),
  );

  const step: P<Step> = lex(
    Parser.alt(
      Parser.as(Token.literal(".."), {
        axis: "parent",
        test: { _tag: "Node" },
        predicates: [],
      } as Step),
      Parser.as(Parser.seq(Token.literal("."), Parser.not(Token.oneOf("0123456789"))), {
        axis: "self",
        test: { _tag: "Node" },
        predicates: [],
      } as Step),
      Parser.gen(function* () {
        const axis: Axis =
          (yield* Parser.optional(
            Parser.alt(Parser.as(Token.literal("@"), "attribute" as const), axisName),
          )) ?? "child";
        yield* ws;
        const test = yield* Parser.alt(
          kindTest,
          nameTest(axis === "attribute" ? "attribute" : "element"),
        ).pipe(Parser.expected("a name test"));
        yield* ws;
        const predicates = yield* Parser.repeat(predicate);
        return { axis, test, predicates };
      }),
    ),
  );

  const anyNode: Step = { axis: "descendant-or-self", test: { _tag: "Node" }, predicates: [] };

  /** Steps after the first: `/step` or `//step`. */
  const more: P<ReadonlyArray<Step>> = Parser.repeat(
    Parser.alt(
      Parser.map(Parser.preceded(sym("//"), Parser.cut(step)), (s) => [anyNode, s]),
      Parser.map(Parser.preceded(sym("/"), Parser.cut(step)), (s) => [s]),
    ),
  ).pipe(Parser.map((groups) => groups.flat()));

  const relative: P<ReadonlyArray<Step>> = Parser.map(Parser.seq(step, more), ([first, rest]) => [
    first,
    ...rest,
  ]);

  const path: P<LocationPath> = Parser.alt(
    Parser.map(Parser.preceded(sym("//"), Parser.cut(relative)), (steps) => ({
      absolute: true,
      steps: [anyNode, ...steps],
    })),
    Parser.map(Parser.preceded(sym("/"), Parser.optional(relative)), (steps) => ({
      absolute: true,
      steps: steps ?? [],
    })),
    Parser.map(relative, (steps) => ({ absolute: false, steps })),
  );

  const number: P<Expr> = lex(
    Parser.map(
      Parser.taken(
        Parser.alt(
          Parser.seq(Ascii.digit1, Parser.optional(Parser.seq(Token.literal("."), Ascii.digit0))),
          Parser.seq(Token.literal("."), Ascii.digit1),
        ),
      ),
      (s) => ({ _tag: "Number", value: Number(s) }) as const,
    ),
  );

  const literal: P<Expr> = lex(
    Parser.map(
      Parser.alt(
        Parser.delimited(Token.literal('"'), Token.takeTill('"'), Token.literal('"')),
        Parser.delimited(Token.literal("'"), Token.takeTill("'"), Token.literal("'")),
      ),
      (value) => ({ _tag: "Literal", value }) as const,
    ),
  );

  const call: P<Expr> = Parser.gen(function* () {
    const fn = yield* lex(
      Parser.alt(
        ...(Object.keys(arity) as Array<Fn>)
          .sort((a, b) => b.length - a.length)
          .map((f) =>
            Parser.as(
              Parser.terminated(Token.literal(f), Parser.peek(Parser.seq(ws, Token.literal("(")))),
              f,
            ),
          ),
      ),
    );
    yield* sym("(");
    const args = yield* Parser.cut(
      Parser.separated(
        Parser.suspend(() => expr),
        sym(","),
      ),
    );
    yield* Parser.cut(sym(")"));
    const [min, max] = arity[fn];
    if (args.length < min || args.length > max) {
      return yield* Parser.cut(
        Parser.failMessage(`${fn}() takes ${min === max ? min : `${min} to ${max}`} argument(s)`),
      );
    }
    return { _tag: "Call", fn, args } as const;
  });

  const primary: P<Expr> = Parser.alt(
    number,
    literal,
    call,
    Parser.delimited(sym("("), Parser.cut(Parser.suspend(() => expr)), Parser.cut(sym(")"))),
    Parser.map(path, (p) => ({ _tag: "Path", path: p }) as const),
  ).pipe(Parser.expected("an expression"));

  const binary =
    (op: Op) =>
    (left: Expr, _: unknown, right: Expr): Expr => ({ _tag: "Binary", op, left, right });
  // `or`/`and` are operators only as whole words.
  const word = (w: string) =>
    lex(
      Parser.terminated(
        Token.literal(w),
        Parser.not(
          Token.oneOf("-_.0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"),
        ),
      ),
    );
  const expr: P<Expr> = Expression.make({
    operand: primary,
    operators: [
      Expression.infixLeft(word("or"), 1, binary("or")),
      Expression.infixLeft(word("and"), 2, binary("and")),
      Expression.infixLeft(sym("!="), 3, binary("!=")),
      Expression.infixLeft(sym("="), 3, binary("=")),
      Expression.infixLeft(sym("<="), 4, binary("<=")),
      Expression.infixLeft(sym(">="), 4, binary(">=")),
      Expression.infixLeft(sym("<"), 4, binary("<")),
      Expression.infixLeft(sym(">"), 4, binary(">")),
    ],
  });

  return Parser.preceded(ws, path);
};

/** Compile an expression. It must be a location path; predicates may use the rest of the subset. */
export const compile = (
  expression: string,
  options?: CompileOptions,
): Result.Result<Path, XPathError> => {
  const parsed = Parser.parse(grammar(options), expression);
  if (Result.isSuccess(parsed)) return Result.succeed({ expression, path: parsed.success });
  const e = parsed.failure;
  const reason =
    e.cause !== undefined
      ? `namespace prefix "${e.cause.prefix}" is not bound`
      : (e.description ??
        (e.expected.length > 0
          ? `expected ${ParseError.formatExpected(e.expected)}`
          : "invalid syntax"));
  return Result.fail(new XPathError({ expression, offset: e.offset, reason }));
};

// -----------------------------------------------------------------------------
// Evaluation
// -----------------------------------------------------------------------------

/**
 * What a path selects: elements, attributes, and text, comment and PI nodes.
 * Attributes have no `_tag`; tell them apart with `instanceof XmlAttribute`.
 */
export type XPathNode =
  | XmlElement
  | XmlAttribute
  | XmlText
  | XmlCData
  | XmlComment
  | XmlProcessingInstruction;

/** Where a path is evaluated from. */
export type Context = XmlDocument | XmlElement | Cursor;

/** A node during evaluation, with what it takes to move from it and order it. */
type XNode =
  | { readonly kind: "root"; readonly top: Cursor }
  | { readonly kind: "element"; readonly cursor: Cursor }
  | {
      readonly kind: "attribute";
      readonly owner: Cursor;
      readonly attr: XmlAttribute;
      readonly index: number;
    }
  | {
      readonly kind: "leaf";
      readonly owner: Cursor;
      readonly node: XmlText | XmlCData | XmlComment | XmlProcessingInstruction;
      readonly index: number;
    };

type Value = ReadonlyArray<XNode> | string | number | boolean;

const isNodeSet = (v: Value): v is ReadonlyArray<XNode> => Array.isArray(v);

/** Document-order key: child indices from the top, attributes before children. */
const orderKey = (n: XNode): ReadonlyArray<number> => {
  const path = (c: Cursor): Array<number> => {
    const out: Array<number> = [];
    for (let x: Cursor | null = c; x !== null; x = x.parent) out.push(x.index);
    return out.reverse();
  };
  switch (n.kind) {
    case "root":
      return [];
    case "element":
      return [0, ...path(n.cursor)];
    case "attribute":
      return [0, ...path(n.owner), -1 - (n.owner.element.attributes.length - n.index)];
    case "leaf":
      return [0, ...path(n.owner), n.index];
  }
};

const compareKeys = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
};

/** Sort into document order and drop duplicates. */
const normalize = (nodes: ReadonlyArray<XNode>): ReadonlyArray<XNode> => {
  const keyed = nodes.map((n) => ({ n, k: orderKey(n) }));
  keyed.sort((a, b) => compareKeys(a.k, b.k));
  return keyed.filter((x, i) => i === 0 || compareKeys(keyed[i - 1]!.k, x.k) !== 0).map((x) => x.n);
};

const elementChildren = (c: Cursor): ReadonlyArray<XNode> =>
  c.element.children.map((child, i): XNode =>
    child._tag === "XmlElement"
      ? { kind: "element", cursor: c.at(i) }
      : { kind: "leaf", owner: c, node: child, index: i },
  );

const children = (n: XNode): ReadonlyArray<XNode> =>
  n.kind === "root"
    ? [{ kind: "element", cursor: n.top }]
    : n.kind === "element"
      ? elementChildren(n.cursor)
      : [];

const parentOf = (n: XNode): XNode | null => {
  switch (n.kind) {
    case "root":
      return null;
    case "element":
      return n.cursor.parent === null
        ? { kind: "root", top: n.cursor }
        : { kind: "element", cursor: n.cursor.parent };
    case "attribute":
    case "leaf":
      return { kind: "element", cursor: n.owner };
  }
};

/** Descendants in document order, iteratively. */
const descendants = (n: XNode): Array<XNode> => {
  const out: Array<XNode> = [];
  const stack = [...children(n)].reverse();
  for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
    out.push(c);
    const cs = children(c);
    for (let i = cs.length - 1; i >= 0; i--) stack.push(cs[i]!);
  }
  return out;
};

const isXmlns = (a: XmlAttribute): boolean =>
  a.name.namespace === Namespaces.xmlns ||
  a.name.qualified === "xmlns" ||
  a.name.prefix === "xmlns";

const axisNodes = (n: XNode, axis: Axis): ReadonlyArray<XNode> => {
  switch (axis) {
    case "child":
      return children(n);
    case "descendant":
      return descendants(n);
    case "descendant-or-self":
      return [n, ...descendants(n)];
    case "self":
      return [n];
    case "parent": {
      const p = parentOf(n);
      return p === null ? [] : [p];
    }
    case "ancestor": {
      // Reverse axis: nearest first, so positions in predicates count outward.
      const out: Array<XNode> = [];
      for (let p = parentOf(n); p !== null; p = parentOf(p)) out.push(p);
      return out;
    }
    case "attribute":
      if (n.kind !== "element") return [];
      return n.cursor.element.attributes.flatMap((attr, index): Array<XNode> =>
        isXmlns(attr) ? [] : [{ kind: "attribute", owner: n.cursor, attr, index }],
      );
  }
};

const matchesTest = (n: XNode, test: NodeTest, axis: Axis): boolean => {
  switch (test._tag) {
    case "Node":
      return true;
    case "Text":
      return n.kind === "leaf" && (n.node._tag === "XmlText" || n.node._tag === "XmlCData");
    case "Any":
    case "Name": {
      // The principal node type: attributes on the attribute axis, elements elsewhere.
      const name =
        axis === "attribute"
          ? n.kind === "attribute"
            ? n.attr.name
            : null
          : n.kind === "element"
            ? n.cursor.element.name
            : null;
      if (name === null) return false;
      if (test._tag === "Any")
        return test.namespace === undefined || name.namespace === test.namespace;
      return name.local === test.local && name.namespace === test.namespace;
    }
  }
};

const stringValue = (n: XNode): string => {
  switch (n.kind) {
    case "root":
      return n.top.element.textContent;
    case "element":
      return n.cursor.element.textContent;
    case "attribute":
      return n.attr.value;
    case "leaf":
      return n.node.data;
  }
};

const localName = (n: XNode): string =>
  n.kind === "element"
    ? n.cursor.element.name.local
    : n.kind === "attribute"
      ? n.attr.name.local
      : n.kind === "leaf" && n.node._tag === "XmlProcessingInstruction"
        ? n.node.target
        : "";

const toStr = (v: Value): string =>
  isNodeSet(v) ? (v.length === 0 ? "" : stringValue(v[0]!)) : String(v);

const toNum = (v: Value): number => {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const s = toStr(v).trim();
  return s === "" ? NaN : Number(s);
};

const toBool = (v: Value): boolean =>
  isNodeSet(v)
    ? v.length > 0
    : typeof v === "number"
      ? v !== 0 && !Number.isNaN(v)
      : typeof v === "string"
        ? v.length > 0
        : v;

const compareAtoms = (
  op: Op,
  a: string | number | boolean,
  b: string | number | boolean,
): boolean => {
  if (op === "=" || op === "!=") {
    const eq =
      typeof a === "boolean" || typeof b === "boolean"
        ? toBool(a) === toBool(b)
        : typeof a === "number" || typeof b === "number"
          ? toNum(a) === toNum(b)
          : a === b;
    return op === "=" ? eq : !eq;
  }
  const x = toNum(a);
  const y = toNum(b);
  return op === "<" ? x < y : op === "<=" ? x <= y : op === ">" ? x > y : x >= y;
};

/** XPath 1.0 comparison: a node-set compares true if any of its nodes' string-values does. */
const compare = (op: Op, a: Value, b: Value): boolean => {
  if (isNodeSet(a)) {
    if (isNodeSet(b))
      return a.some((x) => b.some((y) => compareAtoms(op, stringValue(x), stringValue(y))));
    if (typeof b === "boolean") return compareAtoms(op, toBool(a), b);
    return a.some((x) =>
      compareAtoms(op, typeof b === "number" ? toNum(stringValue(x)) : stringValue(x), b),
    );
  }
  if (isNodeSet(b)) {
    if (typeof a === "boolean") return compareAtoms(op, a, toBool(b));
    return b.some((y) =>
      compareAtoms(op, a, typeof a === "number" ? toNum(stringValue(y)) : stringValue(y)),
    );
  }
  return compareAtoms(op, a, b);
};

interface Focus {
  readonly node: XNode;
  readonly position: number;
  readonly size: number;
}

const evaluate = (e: Expr, focus: Focus): Value => {
  switch (e._tag) {
    case "Number":
      return e.value;
    case "Literal":
      return e.value;
    case "Path":
      return evalPath(e.path, focus.node);
    case "Binary":
      if (e.op === "or") return toBool(evaluate(e.left, focus)) || toBool(evaluate(e.right, focus));
      if (e.op === "and")
        return toBool(evaluate(e.left, focus)) && toBool(evaluate(e.right, focus));
      return compare(e.op, evaluate(e.left, focus), evaluate(e.right, focus));
    case "Call": {
      const arg = (i: number): Value => evaluate(e.args[i]!, focus);
      const self: ReadonlyArray<XNode> = [focus.node];
      switch (e.fn) {
        case "not":
          return !toBool(arg(0));
        case "position":
          return focus.position;
        case "last":
          return focus.size;
        case "count": {
          const v = arg(0);
          return isNodeSet(v) ? v.length : NaN;
        }
        case "string":
          return toStr(e.args.length === 0 ? self : arg(0));
        case "local-name": {
          const v = e.args.length === 0 ? self : arg(0);
          return isNodeSet(v) && v.length > 0 ? localName(v[0]!) : "";
        }
        case "contains":
          return toStr(arg(0)).includes(toStr(arg(1)));
        case "starts-with":
          return toStr(arg(0)).startsWith(toStr(arg(1)));
        case "normalize-space":
          return toStr(e.args.length === 0 ? self : arg(0))
            .replace(/[ \t\r\n]+/g, " ")
            .trim();
      }
    }
  }
};

const applyPredicates = (
  nodes: ReadonlyArray<XNode>,
  predicates: ReadonlyArray<Expr>,
): ReadonlyArray<XNode> => {
  let current = nodes;
  for (const p of predicates) {
    const size = current.length;
    current = current.filter((node, i) => {
      const v = evaluate(p, { node, position: i + 1, size });
      return typeof v === "number" ? v === i + 1 : toBool(v);
    });
  }
  return current;
};

const rootOf = (n: XNode): XNode => {
  for (let p = parentOf(n); p !== null; p = parentOf(p)) n = p;
  return n;
};

const evalPath = (path: LocationPath, context: XNode): ReadonlyArray<XNode> => {
  let nodes: ReadonlyArray<XNode> = [path.absolute ? rootOf(context) : context];
  for (const step of path.steps) {
    const next: Array<XNode> = [];
    for (const n of nodes) {
      const candidates = axisNodes(n, step.axis).filter((c) =>
        matchesTest(c, step.test, step.axis),
      );
      for (const c of applyPredicates(candidates, step.predicates)) next.push(c);
    }
    nodes = nodes.length > 1 ? normalize(next) : next;
  }
  // A reverse axis last leaves nearest-first order; results are always in document order.
  return normalize(nodes);
};

const contextNode = (context: Context): XNode => {
  if (context instanceof Cursor) return { kind: "element", cursor: context };
  if (context instanceof XmlElement) return { kind: "element", cursor: Cursor.root(context) };
  return { kind: "root", top: Cursor.root((context as XmlDocument).root) };
};

const toDom = (n: XNode): XPathNode | null =>
  n.kind === "root"
    ? null
    : n.kind === "element"
      ? n.cursor.element
      : n.kind === "attribute"
        ? n.attr
        : n.node;

/** @internal Evaluate a predicate expression with `cursor` as the context node (used by streaming selection). */
export const test = (e: Expr, cursor: Cursor): boolean =>
  toBool(evaluate(e, { node: { kind: "element", cursor }, position: 1, size: 1 }));

/**
 * The nodes `path` selects from `context`, in document order. From a
 * document, `/` and relative paths start at the document node, whose only
 * child is the root element; the document node itself is never returned.
 */
export const select = (path: Path, context: Context): ReadonlyArray<XPathNode> =>
  evalPath(path.path, contextNode(context)).flatMap((n) => {
    const dom = toDom(n);
    return dom === null ? [] : [dom];
  });

/** The elements `path` selects, as cursors (with inherited `xml:lang`, `xml:base` and `xml:space`). */
export const cursors = (path: Path, context: Context): ReadonlyArray<Cursor> =>
  evalPath(path.path, contextNode(context)).flatMap((n) =>
    n.kind === "element" ? [n.cursor] : [],
  );

/** The elements `path` selects. */
export const elements = (path: Path, context: Context): ReadonlyArray<XmlElement> =>
  cursors(path, context).map((c) => c.element);

/** The first node `path` selects. */
export const first = (path: Path, context: Context): Option.Option<XPathNode> =>
  Option.fromNullishOr(select(path, context)[0]);

/** The string-value of the first node `path` selects (an element's text content, an attribute's value). */
export const string = (path: Path, context: Context): Option.Option<string> => {
  const nodes = evalPath(path.path, contextNode(context));
  return nodes.length === 0 ? Option.none() : Option.some(stringValue(nodes[0]!));
};
