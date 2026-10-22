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
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Result from "effect/Result"
 * import { Xml } from "effect-sax"
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
 * ```
 */
import { Ascii, Expression, Parser, ParseError, Token } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { quote } from "../internal/quote.ts";
import { isEnter, preorder } from "../internal/tree.ts";
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

/**
 * The axes a step can move along.
 *
 * @since 0.3.0
 * @category syntax
 */
export type Axis =
  | "child"
  | "descendant"
  | "descendant-or-self"
  | "self"
  | "parent"
  | "ancestor"
  | "attribute";

/**
 * What a step matches: a name, `*` or `prefix:*`, `text()` or `node()`.
 *
 * @since 0.3.0
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
 * @since 0.3.0
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
 * @since 0.3.0
 * @category syntax
 */
export interface LocationPath {
  readonly absolute: boolean;
  readonly steps: ReadonlyArray<Step>;
}

/**
 * The functions the subset supports.
 *
 * @since 0.3.0
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
 * The binary operators the subset supports.
 *
 * @since 0.3.0
 * @category syntax
 */
export type Op = "or" | "and" | "=" | "!=" | "<" | "<=" | ">" | ">=";

/**
 * A parsed predicate expression.
 *
 * @since 0.3.0
 * @category syntax
 */
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

/**
 * An expression that isn't valid, or uses a prefix that isn't bound.
 *
 * @since 0.3.0
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
 * Options for {@link compile}: namespace bindings for prefixes, and the namespace of unprefixed element names.
 *
 * @since 0.3.0
 * @category options
 */
export interface CompileOptions {
  /** Prefix → namespace URI bindings for the name tests. `xml` is always bound. */
  readonly namespaces?: Readonly<Record<string, string>> | undefined;
  /** The namespace of unprefixed element names (default: none, as in XPath 1.0). */
  readonly defaultNamespace?: string | undefined;
}

/**
 * A compiled path.
 *
 * @since 0.3.0
 * @category models
 */
export interface Path {
  readonly expression: string;
  readonly path: LocationPath;
}

/** A prefix that isn't bound: reported as a user error from the grammar. */
interface Unbound {
  readonly prefix: string;
}

type P<A> = Parser.Parser<A, Unbound>;

/** Prefix → namespace URI bindings. */
type Prefixes = Record.ReadonlyRecord<string, string>;

/** `..` and `.`: the parent and the context node itself. */
const parentStep: Step = { axis: "parent", test: { _tag: "Node" }, predicates: [] };
const selfStep: Step = { axis: "self", test: { _tag: "Node" }, predicates: [] };

/** The function names, longest first, so `string` is not read as a prefix of something longer. */
const functionNames = Arr.sort(
  Record.keys(arity),
  Order.flip(Order.mapInput(Order.Number, (f: Fn) => f.length)),
);

const grammar = (options: CompileOptions | undefined): P<LocationPath> => {
  const namespaces: Prefixes = { xml: Namespaces.xml, ...options?.namespaces };
  const ws = Ascii.multispace0;
  const lex = <A>(p: P<A>): P<A> => Parser.terminated(p, ws);
  const sym = (s: string) => lex(Token.literal(s));

  const bind = (prefix: string): P<string> =>
    Option.match(Record.get(namespaces, prefix), {
      onNone: () => Parser.cut(Parser.fail({ prefix })),
      onSome: (uri) => Parser.succeed(uri),
    });

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
      Parser.as(Token.literal(".."), parentStep),
      Parser.as(Parser.seq(Token.literal("."), Parser.not(Token.oneOf("0123456789"))), selfStep),
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
        ...functionNames.map((f) =>
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
    (left: Expr, _token: string, right: Expr): Expr => ({ _tag: "Binary", op, left, right });
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

/**
 * Compile an expression. It must be a location path; predicates may use the rest of the subset.
 *
 * @since 0.3.0
 * @category compiling
 */
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
        (Arr.isReadonlyArrayNonEmpty(e.expected)
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
 *
 * @since 0.3.0
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
 * @since 0.3.0
 * @category models
 */
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

/** The cursors from the top of the tree down to `c`. */
const pathTo = (c: Cursor): ReadonlyArray<Cursor> => [...c.ancestors.toReversed(), c];

/** Document-order key: child indices from the top, attributes before children. */
const orderKey = (n: XNode): ReadonlyArray<number> => {
  if (n.kind === "root") return [];
  if (n.kind === "element") return [0, ...pathTo(n.cursor).map((x) => x.index)];
  const above = [0, ...pathTo(n.owner).map((x) => x.index)];
  if (n.kind === "attribute") return [...above, -1 - (n.owner.element.attributes.length - n.index)];
  return [...above, n.index];
};

/** Keys compare element by element; a key that is a prefix of another comes first. */
const byKey: Order.Order<ReadonlyArray<number>> = Order.make((a, b) =>
  Option.getOrElse(
    Arr.findFirst(Arr.zip(a, b), ([x, y]) =>
      x === y ? Option.none() : Option.some(x < y ? (-1 as const) : (1 as const)),
    ),
    () => Order.Number(a.length, b.length),
  ),
);

/** Sort into document order and drop duplicates. */
const normalize = (nodes: ReadonlyArray<XNode>): ReadonlyArray<XNode> => {
  const keyed = Arr.sort(
    nodes.map((n) => ({ n, k: orderKey(n) })),
    Order.mapInput(byKey, (x: { readonly k: ReadonlyArray<number> }) => x.k),
  );
  return Arr.dedupeAdjacentWith(keyed, (x, y) => byKey(x.k, y.k) === 0).map((x) => x.n);
};

const elementChildren = (c: Cursor): ReadonlyArray<XNode> =>
  c.element.children.map((child, i): XNode =>
    Predicate.isTagged(child, "XmlElement")
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
  if (n.kind === "root") return null;
  if (n.kind === "element")
    return n.cursor.parent === null
      ? { kind: "root", top: n.cursor }
      : { kind: "element", cursor: n.cursor.parent };
  return { kind: "element", cursor: n.owner };
};

/** The ancestors of a node, nearest first. */
const ancestorsOf = (n: XNode): ReadonlyArray<XNode> =>
  Arr.unfold(parentOf(n), (p) =>
    p === null ? Option.none() : Option.some([p, parentOf(p)] as const),
  );

/** Descendants in document order, without recursion. */
const descendants = (n: XNode): Array<XNode> =>
  Iterable.reduce(preorder(children(n), children), Arr.empty<XNode>(), (out, step) => {
    if (isEnter(step)) out.push(step.node);
    return out;
  });

const isXmlns = (a: XmlAttribute): boolean =>
  a.name.namespace === Namespaces.xmlns ||
  a.name.qualified === "xmlns" ||
  a.name.prefix === "xmlns";

/** The nodes along each axis from a node. */
type Axes = { readonly [A in Axis]: (n: XNode) => ReadonlyArray<XNode> };
const axes: Axes = {
  child: children,
  descendant: descendants,
  "descendant-or-self": (n) => [n, ...descendants(n)],
  self: (n) => [n],
  parent: (n) => {
    const p = parentOf(n);
    return p === null ? [] : [p];
  },
  // Reverse axis: nearest first, so positions in predicates count outward.
  ancestor: ancestorsOf,
  attribute: (n) =>
    n.kind !== "element"
      ? []
      : n.cursor.element.attributes.flatMap((attr, index): Array<XNode> =>
          isXmlns(attr) ? [] : [{ kind: "attribute", owner: n.cursor, attr, index }],
        ),
};

const axisNodes = (n: XNode, axis: Axis): ReadonlyArray<XNode> => axes[axis](n);

/** The principal node type's name: attributes on the attribute axis, elements elsewhere. */
const principalName = (n: XNode, axis: Axis) =>
  axis === "attribute"
    ? n.kind === "attribute"
      ? n.attr.name
      : null
    : n.kind === "element"
      ? n.cursor.element.name
      : null;

const matchesTest = (n: XNode, test: NodeTest, axis: Axis): boolean =>
  Match.valueTags(test, {
    Node: () => true,
    Text: () =>
      n.kind === "leaf" &&
      (Predicate.isTagged(n.node, "XmlText") || Predicate.isTagged(n.node, "XmlCData")),
    Any: (t) => {
      const name = principalName(n, axis);
      return name !== null && (t.namespace === undefined || name.namespace === t.namespace);
    },
    Name: (t) => {
      const name = principalName(n, axis);
      return name !== null && name.local === t.local && name.namespace === t.namespace;
    },
  });

const stringValue = (n: XNode): string => {
  if (n.kind === "root") return n.top.element.textContent;
  if (n.kind === "element") return n.cursor.element.textContent;
  if (n.kind === "attribute") return n.attr.value;
  return n.node.data;
};

const localName = (n: XNode): string =>
  n.kind === "element"
    ? n.cursor.element.name.local
    : n.kind === "attribute"
      ? n.attr.name.local
      : n.kind === "leaf" && Predicate.isTagged(n.node, "XmlProcessingInstruction")
        ? n.node.target
        : "";

const toStr = (v: Value): string =>
  isNodeSet(v) ? Option.match(Arr.head(v), { onNone: () => "", onSome: stringValue }) : String(v);

const toNum = (v: Value): number => {
  if (Predicate.isNumber(v)) return v;
  if (Predicate.isBoolean(v)) return v ? 1 : 0;
  const s = toStr(v).trim();
  return s === "" ? NaN : Number(s);
};

const toBool = (v: Value): boolean =>
  isNodeSet(v)
    ? Arr.isReadonlyArrayNonEmpty(v)
    : Predicate.isNumber(v)
      ? v !== 0 && !Number.isNaN(v)
      : Predicate.isString(v)
        ? v !== ""
        : v;

const compareAtoms = (
  op: Op,
  a: string | number | boolean,
  b: string | number | boolean,
): boolean => {
  if (op === "=" || op === "!=") {
    const eq =
      Predicate.isBoolean(a) || Predicate.isBoolean(b)
        ? toBool(a) === toBool(b)
        : Predicate.isNumber(a) || Predicate.isNumber(b)
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
    if (Predicate.isBoolean(b)) return compareAtoms(op, toBool(a), b);
    return a.some((x) =>
      compareAtoms(op, Predicate.isNumber(b) ? toNum(stringValue(x)) : stringValue(x), b),
    );
  }
  if (isNodeSet(b)) {
    if (Predicate.isBoolean(a)) return compareAtoms(op, a, toBool(b));
    return b.some((y) =>
      compareAtoms(op, a, Predicate.isNumber(a) ? toNum(stringValue(y)) : stringValue(y)),
    );
  }
  return compareAtoms(op, a, b);
};

interface Focus {
  readonly node: XNode;
  readonly position: number;
  readonly size: number;
}

const evaluate = (e: Expr, focus: Focus): Value =>
  Match.valueTags(e, {
    Number: (n): Value => n.value,
    Literal: (l): Value => l.value,
    Path: (p): Value => evalPath(p.path, focus.node),
    Binary: (b): Value => {
      if (b.op === "or") return toBool(evaluate(b.left, focus)) || toBool(evaluate(b.right, focus));
      if (b.op === "and")
        return toBool(evaluate(b.left, focus)) && toBool(evaluate(b.right, focus));
      return compare(b.op, evaluate(b.left, focus), evaluate(b.right, focus));
    },
    Call: (c): Value => functions[c.fn](c.args, focus),
  });

/** A function's arguments as values; compilation checked the arity, so they are all there. */
const argument = (args: ReadonlyArray<Expr>, i: number, focus: Focus): Value =>
  Option.match(Arr.get(args, i), { onNone: (): Value => "", onSome: (a) => evaluate(a, focus) });

/** An optional node-set argument: the context node when it is left out. */
const nodesOr = (args: ReadonlyArray<Expr>, focus: Focus): Value =>
  Arr.isReadonlyArrayNonEmpty(args) ? argument(args, 0, focus) : [focus.node];

/** The functions of the subset, by name. */
type Functions = { readonly [F in Fn]: (args: ReadonlyArray<Expr>, focus: Focus) => Value };
const functions: Functions = {
  not: (args, focus) => !toBool(argument(args, 0, focus)),
  position: (_, focus) => focus.position,
  last: (_, focus) => focus.size,
  count: (args, focus) => {
    const v = argument(args, 0, focus);
    return isNodeSet(v) ? v.length : NaN;
  },
  string: (args, focus) => toStr(nodesOr(args, focus)),
  "local-name": (args, focus) => {
    const v = nodesOr(args, focus);
    return isNodeSet(v) ? Option.match(Arr.head(v), { onNone: () => "", onSome: localName }) : "";
  },
  contains: (args, focus) =>
    toStr(argument(args, 0, focus)).includes(toStr(argument(args, 1, focus))),
  "starts-with": (args, focus) =>
    toStr(argument(args, 0, focus)).startsWith(toStr(argument(args, 1, focus))),
  "normalize-space": (args, focus) =>
    toStr(nodesOr(args, focus))
      .replace(/[ \t\r\n]+/g, " ")
      .trim(),
};

const applyPredicates = (
  nodes: ReadonlyArray<XNode>,
  predicates: ReadonlyArray<Expr>,
): ReadonlyArray<XNode> =>
  Arr.reduce(predicates, nodes, (current, p) =>
    current.filter((node, i) => {
      const v = evaluate(p, { node, position: i + 1, size: current.length });
      return Predicate.isNumber(v) ? v === i + 1 : toBool(v);
    }),
  );

const rootOf = (n: XNode): XNode => ancestorsOf(n).at(-1) ?? n;

const evalPath = (path: LocationPath, context: XNode): ReadonlyArray<XNode> => {
  const start: ReadonlyArray<XNode> = [path.absolute ? rootOf(context) : context];
  const nodes = Arr.reduce(path.steps, start, (from, step) => {
    const next = from.flatMap((n) =>
      applyPredicates(
        axisNodes(n, step.axis).filter((c) => matchesTest(c, step.test, step.axis)),
        step.predicates,
      ),
    );
    return from.length > 1 ? normalize(next) : next;
  });
  // A reverse axis last leaves nearest-first order; results are always in document order.
  return normalize(nodes);
};

const contextNode = (context: Context): XNode => {
  if (context instanceof Cursor) return { kind: "element", cursor: context };
  if (context instanceof XmlElement) return { kind: "element", cursor: Cursor.root(context) };
  // SAFETY: the other two members of `Context` were handled above.
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
 *
 * @since 0.3.0
 * @category evaluation
 */
export const select = (path: Path, context: Context): ReadonlyArray<XPathNode> =>
  evalPath(path.path, contextNode(context)).flatMap((n) => {
    const dom = toDom(n);
    return dom === null ? [] : [dom];
  });

/**
 * The elements `path` selects, as cursors (with inherited `xml:lang`, `xml:base` and `xml:space`).
 *
 * @since 0.3.0
 * @category evaluation
 */
export const cursors = (path: Path, context: Context): ReadonlyArray<Cursor> =>
  evalPath(path.path, contextNode(context)).flatMap((n) =>
    n.kind === "element" ? [n.cursor] : [],
  );

/**
 * The elements `path` selects.
 *
 * @since 0.3.0
 * @category evaluation
 */
export const elements = (path: Path, context: Context): ReadonlyArray<XmlElement> =>
  cursors(path, context).map((c) => c.element);

/**
 * The first node `path` selects.
 *
 * @since 0.3.0
 * @category evaluation
 */
export const first = (path: Path, context: Context): Option.Option<XPathNode> =>
  Option.fromNullishOr(select(path, context)[0]);

/**
 * The string-value of the first node `path` selects (an element's text content, an attribute's value).
 *
 * @since 0.3.0
 * @category evaluation
 */
export const string = (path: Path, context: Context): Option.Option<string> =>
  Option.map(Arr.head(evalPath(path.path, contextNode(context))), stringValue);
