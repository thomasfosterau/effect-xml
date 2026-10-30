/**
 * The XQuery 3.1 / XPath 3.1 expression grammar (Appendix A.1), as
 * effect-parse parsers.
 *
 * The grammar is a PEG: alternatives are tried in order, and keyword-led
 * constructs (`for $`, `if (`, `element name {`, …) are tried before the
 * path expression that would otherwise read their keyword as a name test,
 * since XQuery reserves no keywords. Once a construct is certain, `cut`
 * commits to it so errors point at the real problem.
 *
 * The grammar notes of A.1.2 are handled where they arise:
 *
 * - `leading-lone-slash`: a `/` followed by a token that can start a
 *   relative path starts one (`/ * 5` is an error, `(/) * 5` is not);
 * - `reserved-function-names`: `if(…)`, `node(…)` and the other reserved
 *   names are never function calls;
 * - `occurrence-indicators`: see `types.ts`;
 * - `<` is a comparison after an operand and a direct constructor before
 *   one; `*` likewise multiplication or a wildcard, and `?` a lookup or an
 *   argument placeholder.
 *
 * XPath 3.1 is the same grammar with XQuery's additions left out: no
 * prolog, constructors, `switch` / `typeswitch` / `try`, `validate`,
 * extension expressions, typed or positional bindings, annotations, the
 * namespace axis excepted (XPath has it, XQuery doesn't), or FLWOR clauses
 * beyond one `for` or `let`.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Parser, Token } from "@thomasfosterau/effect-parse";
import type {
  Annotation,
  Axis,
  BinaryOp,
  EQName,
  KeySpecifier as KeySpecifierT,
  Module as ModuleT,
  NodeTest as NodeTestT,
  Param,
  Pragma,
  Wildcard,
} from "./ast.ts";
import { Expr, ItemType, KeySpecifier, NodeTest } from "./ast.ts";
import { clauses } from "./clauses.ts";
import { constructors } from "./constructors.ts";
import type { Lexical, P } from "./lexical.ts";
import { lexical } from "./lexical.ts";
import { prolog } from "./prolog.ts";
import { isReserved, type Shared } from "./shared.ts";
import type { Types } from "./types.ts";
import { types } from "./types.ts";

const forwardAxes: ReadonlyArray<Axis> = [
  "child",
  "descendant-or-self",
  "descendant",
  "attribute",
  "self",
  "following-sibling",
  "following",
];
const reverseAxes: ReadonlyArray<Axis> = [
  "parent",
  "ancestor-or-self",
  "ancestor",
  "preceding-sibling",
  "preceding",
];

const isAttributeTest = ItemType.$is("Attribute");
const isSchemaAttributeTest = ItemType.$is("SchemaAttribute");
const isNamespaceTest = ItemType.$is("NamespaceNode");

/** The default axis of an abbreviated step: attribute and namespace tests select along their own axes. */
const defaultAxis = (test: NodeTestT): Axis =>
  NodeTest.$match(test, {
    Kind: ({ test: t }): Axis =>
      isAttributeTest(t) || isSchemaAttributeTest(t)
        ? "attribute"
        : isNamespaceTest(t)
          ? "namespace"
          : "child",
    Name: (): Axis => "child",
    Wildcard: (): Axis => "child",
  });

const step = (axis: Axis, test: NodeTestT, predicates: ReadonlyArray<Expr>, offset: number): Expr =>
  Expr.AxisStep({ axis, test, predicates, offset });

const anyKind = (): NodeTestT => NodeTest.Kind({ test: ItemType.AnyKind() });

/** `a, b, …` as a `Sequence`, or the expression itself when there is one. */
const sequence = ([offset, items]: readonly [number, ReadonlyArray<Expr>]): Expr => {
  const [first, ...rest] = items;
  return first !== undefined && !Arr.isReadonlyArrayNonEmpty(rest)
    ? first
    : Expr.Sequence({ items, offset });
};

const empty = (offset: number): Expr => Expr.Sequence({ items: [], offset });

const orEmpty = ([offset, e]: readonly [number, Option.Option<Expr>]): Expr =>
  Option.getOrElse(e, () => empty(offset));

const binary = ([left, rest]: readonly [Expr, ReadonlyArray<readonly [BinaryOp, Expr]>]): Expr =>
  Arr.reduce(rest, left, (l, [op, r]) => Expr.Binary({ op, left: l, right: r, offset: l.offset }));

/** A suffix of a postfix expression: a predicate, an argument list, a lookup or an arrow. */
type Suffix = (base: Expr) => Expr;

const postfix = ([base, suffixes]: readonly [Expr, ReadonlyArray<Suffix>]): Expr =>
  Arr.reduce(suffixes, base, (b, s) => s(b));

const isPath = Expr.$is("Path");

/** A path from the root (`/…`) or from its descendants (`//…`). */
const rooted =
  (root: "root" | "descendants") =>
  ([offset, e]: readonly [number, Option.Option<Expr>]): Expr =>
    Expr.Path({
      root,
      steps: Option.match(e, {
        onNone: () => [],
        onSome: (x) => (isPath(x) && x.root === "relative" ? x.steps : [x]),
      }),
      offset,
    });

/** `first (/ step | // step)*`; `//` becomes a `descendant-or-self::node()` step. */
const relative = ([offset, first, rest]: readonly [
  number,
  Expr,
  ReadonlyArray<readonly [boolean, number, Expr]>,
]): Expr =>
  Arr.isReadonlyArrayNonEmpty(rest)
    ? Expr.Path({
        root: "relative",
        steps: [
          first,
          ...rest.flatMap(([descendants, o, s]) =>
            descendants ? [step("descendant-or-self", anyKind(), [], o), s] : [s],
          ),
        ],
        offset,
      })
    : first;

const arrowOf =
  ([offset, [target, args]]: readonly [
    number,
    readonly [EQName | Expr, ReadonlyArray<Expr>],
  ]): Suffix =>
  (base) =>
    "_tag" in target
      ? Expr.ArrowDynamic({ base, function: target, args, offset })
      : Expr.ArrowCall({ base, name: target, args, offset });

/** The grammar's entry points. */
export interface Grammar {
  /** A whole XPath expression: leading whitespace, `Expr`, end of input. */
  readonly xpath: P<Expr>;
  /** A whole XQuery module: leading whitespace, `Module`, end of input. */
  readonly module: P<ModuleT>;
}

/** Literals and annotations. */
const leaves = (lex: Lexical) => {
  const { tok, at, lexeme, eqname, stringLiteral, numericLiteral } = lex;
  const name = lexeme(eqname);
  const literalValue: P<Expr> = Parser.alt(
    numericLiteral,
    Parser.map(Parser.seq(at, stringLiteral), ([offset, value]) =>
      Expr.StringLiteral({ value, offset }),
    ),
  );
  const annotation: P<Annotation> = Parser.map(
    Parser.preceded(
      tok("%"),
      Parser.cut(
        Parser.seq(
          name,
          Parser.optional(
            Parser.delimited(
              tok("("),
              Parser.separated(literalValue, tok(","), { min: 1 }),
              Parser.cut(tok(")")),
            ),
          ),
        ),
      ),
    ),
    ([n, values]) => ({ name: n, values: values ?? [] }),
  );
  return { name, literalValue, annotation };
};

/** Node tests, name tests and axis steps. */
const steps = (lex: Lexical, kindTest: P<ItemType>, predicate: P<Expr>) => {
  const { tok, kw, at, lexeme, ncname, ncNameStart, bracedUri, eqname } = lex;
  const literal = Token.literal;
  const none = Option.none<string>();
  type Parts = Omit<Wildcard, "offset">;
  const parts: P<Parts> = Parser.alt(
    Parser.map(Parser.preceded(literal("*:"), ncname), (local): Parts => ({
      prefix: none,
      uri: none,
      local: Option.some(local),
    })),
    Parser.as(Parser.seq(literal("*"), Parser.not(Parser.seq(literal(":"), ncNameStart))), {
      prefix: none,
      uri: none,
      local: none,
    } satisfies Parts),
    Parser.map(Parser.terminated(ncname, literal(":*")), (prefix): Parts => ({
      prefix: Option.some(prefix),
      uri: none,
      local: none,
    })),
    Parser.map(Parser.terminated(bracedUri, literal("*")), (uri): Parts => ({
      prefix: none,
      uri: Option.some(uri),
      local: none,
    })),
  );
  const wildcard: P<Wildcard> = Parser.map(Parser.seq(at, parts), ([offset, w]) => ({
    ...w,
    offset,
  }));
  const nameTest: P<NodeTestT> = Parser.alt(
    Parser.map(lexeme(wildcard), (w) => NodeTest.Wildcard({ wildcard: w })),
    Parser.map(lexeme(eqname), (n) => NodeTest.Name({ name: n })),
  );
  const nodeTest: P<NodeTestT> = Parser.alt(
    Parser.map(kindTest, (t) => NodeTest.Kind({ test: t })),
    nameTest,
  );
  const predicates: P<ReadonlyArray<Expr>> = Parser.repeat(predicate);
  const axes = [...forwardAxes, ...(lex.xquery ? [] : ["namespace" as const]), ...reverseAxes];
  const axisName: P<Axis> = Parser.terminated(Parser.alt(...axes.map((a) => kw(a))), tok("::"));
  const axisStep: P<Expr> = Parser.alt(
    Parser.map(Parser.seq(at, tok(".."), predicates), ([offset, , preds]) =>
      step("parent", anyKind(), preds, offset),
    ),
    Parser.map(
      Parser.seq(at, Parser.preceded(tok("@"), Parser.cut(nodeTest)), predicates),
      ([offset, test, preds]) => step("attribute", test, preds, offset),
    ),
    Parser.map(
      Parser.seq(at, axisName, Parser.cut(nodeTest), predicates),
      ([offset, axis, test, preds]) => step(axis, test, preds, offset),
    ),
    // A plain name test is the name-led step of `primaries`, which reads the name once.
    Parser.map(
      Parser.seq(
        at,
        Parser.alt(
          Parser.map(kindTest, (t) => NodeTest.Kind({ test: t })),
          Parser.map(lexeme(wildcard), (w) => NodeTest.Wildcard({ wildcard: w })),
        ),
        predicates,
      ),
      ([offset, test, preds]) => step(defaultAxis(test), test, preds, offset),
    ),
  );
  return { nameTest, axisStep };
};

/** The primary expressions, argument lists and postfix suffixes. */
const primaries = (shared: Shared, literalValue: P<Expr>, name: P<EQName>) => {
  const { lex, expr, exprSingle, varName, enclosedExpr, annotations, paramList, types: T } = shared;
  const { tok, kw, lexeme, at, ws, ncname, integerLiteral } = lex;
  const literal = Token.literal;
  const varRef: P<Expr> = Parser.map(Parser.seq(at, varName), ([offset, n]) =>
    Expr.VarRef({ name: n, offset }),
  );
  const parenthesized: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        Parser.seq(literal("("), Parser.not(literal("#")), ws),
        Parser.cut(Parser.terminated(Parser.opt(expr), tok(")"))),
      ),
    ),
    orEmpty,
  );
  const placeholder: P<Expr> = Parser.map(
    Parser.terminated(
      at,
      Parser.seq(tok("?"), Parser.peek(Parser.alt(literal(","), literal(")")))),
    ),
    (offset) => Expr.Placeholder({ offset }),
  );
  const argumentList: P<ReadonlyArray<Expr>> = Parser.preceded(
    tok("("),
    Parser.cut(
      Parser.terminated(Parser.separated(Parser.alt(placeholder, exprSingle), tok(",")), tok(")")),
    ),
  );
  const keySpecifier: P<KeySpecifierT> = Parser.alt(
    Parser.map(lexeme(ncname), (n) => KeySpecifier.Name({ name: n })),
    Parser.map(integerLiteral, (value) => KeySpecifier.Integer({ value })),
    Parser.as(tok("*"), KeySpecifier.Wildcard()),
    Parser.map(parenthesized, (e) => KeySpecifier.Expr({ expr: e })),
  );
  const lookupKey: P<KeySpecifierT> = Parser.preceded(tok("?"), Parser.cut(keySpecifier));
  const predicate: P<Expr> = Parser.preceded(
    tok("["),
    Parser.cut(Parser.terminated(expr, tok("]"))),
  );
  const suffix: P<Suffix> = Parser.alt(
    Parser.map(
      Parser.seq(at, predicate),
      ([offset, e]): Suffix =>
        (base) =>
          Expr.Filter({ base, predicate: e, offset }),
    ),
    Parser.map(
      Parser.seq(at, argumentList),
      ([offset, args]): Suffix =>
        (base) =>
          Expr.DynamicCall({ function: base, args, offset }),
    ),
    Parser.map(
      Parser.seq(at, lookupKey),
      ([offset, key]): Suffix =>
        (base) =>
          Expr.Lookup({ base, key, offset }),
    ),
  );

  const inlineFunction: P<Expr> = Parser.map(
    Parser.seq(
      at,
      annotations,
      Parser.preceded(
        Parser.seq(kw("function"), Parser.peek(literal("("))),
        Parser.cut(
          Parser.seq(
            paramList,
            Parser.opt(Parser.preceded(kw("as"), T.sequenceType)),
            enclosedExpr,
          ),
        ),
      ),
    ),
    ([offset, annots, [params, returnType, body]]) =>
      Expr.InlineFunction({ annotations: annots, params, returnType, body, offset }),
  );
  const mapEntry = Parser.map(
    Parser.separatedPair(exprSingle, tok(":"), exprSingle),
    ([key, value]) => ({ key, value }),
  );
  const mapConstructor: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        Parser.seq(kw("map"), tok("{")),
        Parser.cut(Parser.terminated(Parser.separated(mapEntry, tok(",")), tok("}"))),
      ),
    ),
    ([offset, entries]) => Expr.Map({ entries, offset }),
  );
  const squareArray: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        tok("["),
        Parser.cut(Parser.terminated(Parser.separated(exprSingle, tok(",")), tok("]"))),
      ),
    ),
    ([offset, members]) => Expr.SquareArray({ members, offset }),
  );
  const curlyArray: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(Parser.seq(kw("array"), Parser.peek(literal("{"))), Parser.cut(enclosedExpr)),
    ),
    ([offset, body]) => Expr.CurlyArray({ body, offset }),
  );
  const contextItem: P<Expr> = Parser.map(
    Parser.terminated(at, lexeme(Parser.seq(literal("."), Parser.not(Token.oneOf(".0123456789"))))),
    (offset) => Expr.ContextItem({ offset }),
  );
  const unaryLookup: P<Expr> = Parser.map(Parser.seq(at, lookupKey), ([offset, key]) =>
    Expr.UnaryLookup({ key, offset }),
  );
  const C = constructors(lex, expr);
  /** Primary expressions that start with punctuation or a literal. */
  const punctuation: P<Expr> = Parser.alt(
    literalValue,
    varRef,
    parenthesized,
    contextItem,
    squareArray,
    unaryLookup,
    ...(lex.xquery ? [C.direct, C.string, inlineFunction] : []),
  );
  /** Primary expressions that start with a keyword or a name. */
  const named: P<Expr> = Parser.alt(
    ...(lex.xquery ? [C.computed] : []),
    mapConstructor,
    curlyArray,
    inlineFunction,
  );
  const suffixes = Parser.repeat(suffix);
  const withPostfix = (primary: P<Expr>): P<Expr> =>
    Parser.map(Parser.seq(primary, suffixes), postfix);
  // A name is read once, then what follows decides: `name#n` is a function
  // reference, `name(…)` a call, and anything else a name test.
  type Tail = (offset: number, n: EQName) => Option.Option<Expr>;
  const callable =
    (build: (offset: number, n: EQName) => Expr, s: ReadonlyArray<Suffix>): Tail =>
    (offset, n) =>
      isReserved(n) ? Option.none() : Option.some(postfix([build(offset, n), s]));
  const tail: P<Tail> = Parser.alt(
    Parser.map(
      Parser.seq(Parser.preceded(tok("#"), Parser.cut(integerLiteral)), suffixes),
      ([arity, s]) =>
        callable(
          (offset, n) => Expr.NamedFunctionRef({ name: n, arity: Number(arity), offset }),
          s,
        ),
    ),
    Parser.map(
      Parser.seq(Parser.preceded(Parser.peek(literal("(")), argumentList), suffixes),
      ([args, s]) => callable((offset, n) => Expr.FunctionCall({ name: n, args, offset }), s),
    ),
    Parser.map(
      Parser.repeat(predicate),
      (preds): Tail =>
        (offset, n) =>
          Option.some(
            Expr.AxisStep({
              axis: "child",
              test: NodeTest.Name({ name: n }),
              predicates: preds,
              offset,
            }),
          ),
    ),
  );
  const nameLed: P<Expr> = Parser.filterMap(Parser.seq(at, name, tail), ([offset, n, t]) =>
    t(offset, n),
  );
  return {
    punctuation: withPostfix(punctuation),
    named: withPostfix(named),
    nameLed,
    predicate,
    argumentList,
    varRef,
    parenthesized,
  };
};

/** `validate` and extension expressions (XQuery only). */
const valueExprs = (lex: Lexical, expr: P<Expr>, name: P<EQName>) => {
  const { tok, kw, lexeme, at } = lex;
  const literal = Token.literal;
  const pragma: P<Pragma> = Parser.map(
    Parser.preceded(
      literal("(#"),
      Parser.cut(
        Parser.seq(
          Parser.preceded(Parser.optional(lex.s), lex.eqname),
          Parser.alt(
            Parser.as(literal("#)"), ""),
            Parser.delimited(lex.s, Token.takeUntil("#)"), literal("#)")),
          ),
        ),
      ),
    ),
    ([n, contents]) => ({ name: n, contents }),
  );
  const extension: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.repeat(lexeme(pragma), { min: 1 }),
      Parser.preceded(tok("{"), Parser.cut(Parser.terminated(Parser.opt(expr), tok("}")))),
    ),
    ([offset, pragmas, body]) => Expr.Extension({ pragmas, body, offset }),
  );
  const none = { mode: Option.none<"lax" | "strict">(), type: Option.none<EQName>() };
  const validationMode = Parser.alt(
    Parser.map(Parser.alt(kw("lax"), kw("strict")), (m) => ({ ...none, mode: Option.some(m) })),
    Parser.map(Parser.preceded(kw("type"), name), (t) => ({ ...none, type: Option.some(t) })),
    Parser.succeed(none),
  );
  const validate: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(kw("validate"), validationMode),
      Parser.preceded(tok("{"), Parser.cut(Parser.terminated(expr, tok("}")))),
    ),
    ([offset, { mode, type }, body]) => Expr.Validate({ mode, type, body, offset }),
  );
  return { validate, extension };
};

const op = <const O extends BinaryOp>(o: O, p: P<unknown>): P<O> => Parser.as(p, o);

/** The operand after an operator: certain, and reported as "an expression" when missing. */
const operandAfter = (operand: P<Expr>): P<Expr> =>
  Parser.cut(Parser.expected(operand, "an expression"));

/** `operand (operator operand)*`, folded to the left. */
const leftAssoc = (operand: P<Expr>, operator: P<BinaryOp>): P<Expr> =>
  Parser.map(
    Parser.seq(
      operand,
      Parser.repeat(Parser.seq(Parser.expected(operator, "an operator"), operandAfter(operand))),
    ),
    binary,
  );

/** `operand (operator operand)?`: `1 = 2 = 3` and `1 to 2 to 3` are syntax errors. */
const nonAssoc = (operand: P<Expr>, operator: P<BinaryOp>): P<Expr> =>
  Parser.map(
    Parser.seq(
      operand,
      Parser.opt(Parser.seq(Parser.expected(operator, "an operator"), operandAfter(operand))),
    ),
    ([l, r]) => binary([l, Option.toArray(r)]),
  );

/** `operand (keywords type)?`: `instance of`, `treat as`, `castable as`, `cast as`. */
const typed = <A>(
  operand: P<Expr>,
  keywords: P<unknown>,
  type: P<A>,
  build: (e: Expr, t: A) => Expr,
): P<Expr> =>
  Parser.map(
    Parser.seq(
      operand,
      Parser.opt(Parser.preceded(Parser.expected(keywords, "an operator"), Parser.cut(type))),
    ),
    ([e, t]) => Option.match(t, { onNone: () => e, onSome: (x) => build(e, x) }),
  );

/** The operator precedence levels from `UnaryExpr` up to `OrExpr`. */
const operators = (lex: Lexical, T: Types, valueExpr: P<Expr>, arrowSuffix: P<Suffix>): P<Expr> => {
  const { tok, kw, lexeme, at } = lex;
  const literal = Token.literal;
  const unary: P<Expr> = Parser.map(
    Parser.seq(Parser.repeat(Parser.seq(at, Parser.alt(tok("-"), tok("+")))), valueExpr),
    ([ops, operand]) =>
      Arr.reduceRight(ops, operand, (e, [offset, o]) => Expr.Unary({ op: o, operand: e, offset })),
  );
  const arrow = Parser.map(Parser.seq(unary, Parser.repeat(arrowSuffix)), postfix);
  const cast = typed(arrow, Parser.seq(kw("cast"), kw("as")), T.singleType, (e, t) =>
    Expr.CastAs({ expr: e, type: t, offset: e.offset }),
  );
  const castable = typed(cast, Parser.seq(kw("castable"), kw("as")), T.singleType, (e, t) =>
    Expr.CastableAs({ expr: e, type: t, offset: e.offset }),
  );
  const treat = typed(castable, Parser.seq(kw("treat"), kw("as")), T.sequenceType, (e, t) =>
    Expr.TreatAs({ expr: e, type: t, offset: e.offset }),
  );
  const instanceOf = typed(treat, Parser.seq(kw("instance"), kw("of")), T.sequenceType, (e, t) =>
    Expr.InstanceOf({ expr: e, type: t, offset: e.offset }),
  );
  const intersectExcept = leftAssoc(instanceOf, Parser.alt(kw("intersect"), kw("except")));
  const union = leftAssoc(
    intersectExcept,
    Parser.alt(
      kw("union"),
      op("union", lexeme(Parser.seq(literal("|"), Parser.not(literal("|"))))),
    ),
  );
  const multiplicative = leftAssoc(union, Parser.alt(tok("*"), kw("div"), kw("idiv"), kw("mod")));
  const additive = leftAssoc(multiplicative, Parser.alt(tok("+"), tok("-")));
  const range = nonAssoc(additive, kw("to"));
  const stringConcat = leftAssoc(range, tok("||"));
  const comparisonOp: P<BinaryOp> = Parser.alt(
    op("=", lexeme(Parser.seq(literal("="), Parser.not(literal(">"))))),
    tok("!="),
    tok("<="),
    tok("<<"),
    tok("<"),
    tok(">="),
    tok(">>"),
    tok(">"),
    kw("eq"),
    kw("ne"),
    kw("lt"),
    kw("le"),
    kw("gt"),
    kw("ge"),
    kw("is"),
  );
  const comparison = nonAssoc(stringConcat, comparisonOp);
  return leftAssoc(leftAssoc(comparison, kw("and")), kw("or"));
};

/** Builds the grammar for XQuery (`xquery`) or XPath. */
export const grammar = (xquery: boolean): Grammar => {
  const lex = lexical(xquery);
  const { tok, lexeme, at, ws } = lex;
  const literal = Token.literal;
  const { name, literalValue, annotation } = leaves(lex);

  const expr: P<Expr> = Parser.suspend(() =>
    Parser.map(Parser.seq(at, Parser.separated(exprSingle, tok(","), { min: 1 })), sequence),
  );
  const exprSingle: P<Expr> = Parser.suspend(() =>
    Parser.expected(exprSingleImpl, "an expression"),
  );

  const annotations: P<ReadonlyArray<Annotation>> = xquery
    ? Parser.repeat(annotation)
    : Parser.succeed([]);
  const T = types(lex, annotations);
  const varName: P<EQName> = Parser.preceded(tok("$"), Parser.cut(name));
  const param: P<Param> = Parser.map(
    Parser.seq(varName, Parser.opt(T.typeDeclaration)),
    ([n, type]) => ({ name: n, type }),
  );
  const shared: Shared = {
    lex,
    expr,
    exprSingle,
    varName,
    enclosedExpr: Parser.map(
      Parser.seq(
        at,
        Parser.preceded(tok("{"), Parser.cut(Parser.terminated(Parser.opt(expr), tok("}")))),
      ),
      orEmpty,
    ),
    annotations,
    paramList: Parser.delimited(tok("("), Parser.separated(param, tok(",")), Parser.cut(tok(")"))),
    types: T,
    optionalType: xquery ? Parser.opt(T.typeDeclaration) : Parser.succeed(Option.none()),
  };

  const primary = primaries(shared, literalValue, name);
  const { nameTest, axisStep } = steps(lex, T.kindTest, primary.predicate);
  const stepExpr: P<Expr> = Parser.alt(
    primary.punctuation,
    primary.named,
    axisStep,
    primary.nameLed,
  );
  const separator = Parser.alt(Parser.as(tok("//"), true), Parser.as(tok("/"), false));
  const relativePath: P<Expr> = Parser.map(
    Parser.seq(at, stepExpr, Parser.repeat(Parser.seq(separator, at, Parser.cut(stepExpr)))),
    relative,
  );
  // `leading-lone-slash`: the tokens that can start a relative path after `/`.
  const startsRelative = Parser.peek(
    Parser.alt(
      lex.ncNameStart,
      Token.oneOf("*@.$(\"'0123456789[?"),
      ...(xquery
        ? [Token.oneOf("%`"), Parser.seq(literal("<"), Parser.not(Token.oneOf("<=")))]
        : []),
    ),
  );
  const pathExpr: P<Expr> = Parser.alt(
    Parser.map(
      Parser.seq(at, Parser.preceded(tok("//"), Parser.map(Parser.cut(relativePath), Option.some))),
      rooted("descendants"),
    ),
    Parser.map(
      Parser.seq(
        at,
        Parser.preceded(
          tok("/"),
          Parser.opt(Parser.preceded(startsRelative, Parser.cut(relativePath))),
        ),
      ),
      rooted("root"),
    ),
    relativePath,
  );
  const simpleMap = Parser.map(
    Parser.seq(
      pathExpr,
      Parser.repeat(
        Parser.seq(
          Parser.as(lexeme(Parser.seq(literal("!"), Parser.not(literal("=")))), "!" as const),
          Parser.cut(pathExpr),
        ),
      ),
    ),
    binary,
  );
  const { validate, extension } = valueExprs(lex, expr, name);
  const arrowSuffix: P<Suffix> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        tok("=>"),
        Parser.cut(
          Parser.seq(Parser.alt(name, primary.varRef, primary.parenthesized), primary.argumentList),
        ),
      ),
    ),
    arrowOf,
  );
  const orExpr = operators(
    lex,
    T,
    xquery ? Parser.alt(validate, extension, simpleMap) : simpleMap,
    arrowSuffix,
  );

  const K = clauses(shared, nameTest);
  const exprSingleImpl: P<Expr> = xquery
    ? Parser.alt(K.flwor, K.quantified, K.switch, K.typeswitch, K.if, K.try, orExpr)
    : Parser.alt(K.flwor, K.quantified, K.if, orExpr);

  return {
    xpath: Parser.preceded(ws, Parser.terminated(expr, Parser.eof)),
    module: prolog(shared),
  };
};
