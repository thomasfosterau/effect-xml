/**
 * The keyword-led `ExprSingle` forms: FLWOR expressions (XQuery 3.1 §3.12,
 * with windows, `group by`, `order by` and `count`; XPath's single `for` or
 * `let`), quantified, `if`, `switch`, `typeswitch` and `try` / `catch`.
 *
 * Each starts with a keyword that is only a keyword when the right token
 * follows (`for $`, `if (`, `try {`), so a query can still name an element
 * `for` or `if`; once that pair is seen, the construct is certain.
 */
import * as Option from "effect/Option";
import { Parser, Token } from "@thomasfosterau/effect-parse";
import type {
  CatchClause,
  Clause as ClauseT,
  EQName,
  ForBinding,
  GroupingSpec,
  LetBinding,
  NodeTest,
  OrderSpec,
  SwitchCase,
  TypeswitchCase,
  WindowCondition,
  WindowVars,
} from "./ast.ts";
import { Clause, Expr } from "./ast.ts";
import type { Shared } from "./shared.ts";
import type { P } from "./lexical.ts";

/** The keyword-led expression parsers. */
export interface Clauses {
  readonly flwor: P<Expr>;
  readonly quantified: P<Expr>;
  readonly if: P<Expr>;
  readonly switch: P<Expr>;
  readonly typeswitch: P<Expr>;
  readonly try: P<Expr>;
}

const literal = Token.literal;

/** A `for` binding of XPath: no type, no `allowing empty`, no positional variable. */
const simpleBinding = ([name, e]: readonly [EQName, Expr]): ForBinding => ({
  name,
  type: Option.none(),
  allowingEmpty: false,
  position: Option.none(),
  in: e,
});

/** The window clauses: `for tumbling|sliding window $w in … start … end …`. */
const windowClause = (shared: Shared, positionalVar: P<EQName>): P<ClauseT> => {
  const { lex, exprSingle, varName, optionalType } = shared;
  const { kw, at } = lex;
  const windowVars: P<WindowVars> = Parser.map(
    Parser.seq(
      Parser.opt(varName),
      Parser.opt(positionalVar),
      Parser.opt(Parser.preceded(kw("previous"), Parser.cut(varName))),
      Parser.opt(Parser.preceded(kw("next"), Parser.cut(varName))),
    ),
    ([current, position, previous, next]) => ({ current, position, previous, next }),
  );
  const condition = (keyword: P<unknown>): P<WindowCondition> =>
    Parser.map(
      Parser.preceded(
        keyword,
        Parser.cut(Parser.seq(windowVars, Parser.preceded(kw("when"), exprSingle))),
      ),
      ([vars, when]) => ({ vars, when }),
    );
  return Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        kw("for"),
        Parser.alt(Parser.as(kw("sliding"), true), Parser.as(kw("tumbling"), false)),
      ),
      Parser.preceded(
        Parser.cut(kw("window")),
        Parser.cut(Parser.seq(varName, optionalType, Parser.preceded(kw("in"), exprSingle))),
      ),
      Parser.cut(condition(kw("start"))),
      Parser.opt(Parser.seq(Parser.optional(kw("only")), condition(kw("end")))),
    ),
    ([offset, sliding, [name, type, e], start, end]) =>
      Clause.Window({
        sliding,
        name,
        type,
        in: e,
        start,
        end: Option.map(end, ([, c]) => c),
        onlyEnd: Option.exists(end, ([only]) => only !== undefined),
        offset,
      }),
  );
};

/** `group by` and `order by`. */
const groupAndOrder = (shared: Shared) => {
  const { lex, exprSingle, varName, optionalType } = shared;
  const { kw, tok, at, stringLiteral } = lex;
  const collation = Parser.opt(Parser.preceded(kw("collation"), Parser.cut(stringLiteral)));
  const groupingSpec: P<GroupingSpec> = Parser.map(
    Parser.seq(
      varName,
      Parser.opt(Parser.seq(optionalType, Parser.preceded(tok(":="), Parser.cut(exprSingle)))),
      collation,
    ),
    ([name, value, coll]) => ({
      name,
      type: Option.flatMap(value, ([t]) => t),
      value: Option.map(value, ([, v]) => v),
      collation: coll,
    }),
  );
  const groupBy: P<ClauseT> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        Parser.seq(kw("group"), kw("by")),
        Parser.cut(Parser.separated(groupingSpec, tok(","), { min: 1 })),
      ),
    ),
    ([offset, specs]) => Clause.GroupBy({ specs, offset }),
  );
  const orderSpec: P<OrderSpec> = Parser.map(
    Parser.seq(
      exprSingle,
      Parser.optional(Parser.alt(kw("ascending"), kw("descending"))),
      Parser.opt(Parser.preceded(kw("empty"), Parser.cut(Parser.alt(kw("greatest"), kw("least"))))),
      collation,
    ),
    ([e, direction, emptyOrder, coll]) => ({
      expr: e,
      descending: direction === "descending",
      emptyGreatest: Option.map(emptyOrder, (o) => o === "greatest"),
      collation: coll,
    }),
  );
  const orderBy: P<ClauseT> = Parser.map(
    Parser.seq(
      at,
      Parser.alt(
        Parser.as(Parser.seq(kw("order"), kw("by")), false),
        Parser.as(Parser.seq(kw("stable"), kw("order"), kw("by")), true),
      ),
      Parser.cut(Parser.separated(orderSpec, tok(","), { min: 1 })),
    ),
    ([offset, stable, specs]) => Clause.OrderBy({ stable, specs, offset }),
  );
  return { groupBy, orderBy };
};

/** FLWOR expressions: XQuery's clauses, or XPath's single `for` / `let`. */
const flworParser = (shared: Shared): P<Expr> => {
  const { lex, exprSingle, varName, optionalType } = shared;
  const { kw, tok, at } = lex;
  const dollar = Parser.peek(literal("$"));
  const positionalVar = Parser.preceded(kw("at"), Parser.cut(varName));
  const inExpr = Parser.preceded(Parser.cut(kw("in")), Parser.cut(exprSingle));
  const forBinding: P<ForBinding> = lex.xquery
    ? Parser.map(
        Parser.seq(
          varName,
          optionalType,
          Parser.optional(Parser.seq(kw("allowing"), kw("empty"))),
          Parser.opt(positionalVar),
          inExpr,
        ),
        ([name, type, allowing, position, e]) => ({
          name,
          type,
          allowingEmpty: allowing !== undefined,
          position,
          in: e,
        }),
      )
    : Parser.map(Parser.seq(varName, inExpr), simpleBinding);
  const letBinding: P<LetBinding> = Parser.map(
    Parser.seq(
      varName,
      optionalType,
      Parser.preceded(Parser.cut(tok(":=")), Parser.cut(exprSingle)),
    ),
    ([name, type, value]) => ({ name, type, value }),
  );
  const forClause: P<ClauseT> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        Parser.seq(kw("for"), dollar),
        Parser.cut(Parser.separated(forBinding, tok(","), { min: 1 })),
      ),
    ),
    ([offset, bindings]) => Clause.For({ bindings, offset }),
  );
  const letClause: P<ClauseT> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        Parser.seq(kw("let"), dollar),
        Parser.cut(Parser.separated(letBinding, tok(","), { min: 1 })),
      ),
    ),
    ([offset, bindings]) => Clause.Let({ bindings, offset }),
  );
  const returnClause = Parser.preceded(Parser.cut(kw("return")), Parser.cut(exprSingle));
  if (!lex.xquery)
    return Parser.map(
      Parser.seq(at, Parser.alt(forClause, letClause), returnClause),
      ([offset, clause, ret]) => Expr.Flwor({ clauses: [clause], return: ret, offset }),
    );
  const { groupBy, orderBy } = groupAndOrder(shared);
  const where: P<ClauseT> = Parser.map(
    Parser.seq(at, Parser.preceded(kw("where"), Parser.cut(exprSingle))),
    ([offset, condition]) => Clause.Where({ condition, offset }),
  );
  const count: P<ClauseT> = Parser.map(
    Parser.seq(at, Parser.preceded(Parser.seq(kw("count"), dollar), Parser.cut(varName))),
    ([offset, name]) => Clause.Count({ name, offset }),
  );
  const initial = Parser.alt(windowClause(shared, positionalVar), forClause, letClause);
  const intermediate = Parser.alt(initial, where, groupBy, orderBy, count);
  return Parser.map(
    Parser.seq(at, initial, Parser.repeat(intermediate), returnClause),
    ([offset, first, rest, ret]) => Expr.Flwor({ clauses: [first, ...rest], return: ret, offset }),
  );
};

/** `switch`, `typeswitch` and `try` / `catch` (XQuery only). */
const conditionals = (shared: Shared, nameTest: P<NodeTest>, condition: P<Expr>) => {
  const { lex, exprSingle, varName, enclosedExpr, types } = shared;
  const { kw, tok, at } = lex;
  const keyword = (word: string, next: string) => Parser.seq(kw(word), Parser.peek(literal(next)));
  const switchCase: P<SwitchCase> = Parser.map(
    Parser.seq(
      Parser.repeat(Parser.preceded(kw("case"), Parser.cut(exprSingle)), { min: 1 }),
      Parser.preceded(Parser.cut(kw("return")), Parser.cut(exprSingle)),
    ),
    ([operands, result]) => ({ operands, result }),
  );
  const switchExpr: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(keyword("switch", "("), Parser.cut(condition)),
      Parser.cut(Parser.repeat(switchCase, { min: 1 })),
      Parser.preceded(Parser.cut(Parser.seq(kw("default"), kw("return"))), Parser.cut(exprSingle)),
    ),
    ([offset, operand, cases, d]) => Expr.Switch({ operand, cases, default: d, offset }),
  );
  const typeswitchCase: P<TypeswitchCase> = Parser.map(
    Parser.preceded(
      kw("case"),
      Parser.cut(
        Parser.seq(
          Parser.opt(Parser.terminated(varName, kw("as"))),
          Parser.separated(types.sequenceType, tok("|"), { min: 1 }),
          Parser.preceded(kw("return"), exprSingle),
        ),
      ),
    ),
    ([variable, ts, result]) => ({ variable, types: ts, result }),
  );
  const typeswitch: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(keyword("typeswitch", "("), Parser.cut(condition)),
      Parser.cut(Parser.repeat(typeswitchCase, { min: 1 })),
      Parser.preceded(
        Parser.cut(kw("default")),
        Parser.cut(Parser.seq(Parser.opt(varName), Parser.preceded(kw("return"), exprSingle))),
      ),
    ),
    ([offset, operand, cases, [defaultVariable, d]]) =>
      Expr.Typeswitch({ operand, cases, defaultVariable, default: d, offset }),
  );
  const catchClause: P<CatchClause> = Parser.map(
    Parser.preceded(
      kw("catch"),
      Parser.cut(Parser.seq(Parser.separated(nameTest, tok("|"), { min: 1 }), enclosedExpr)),
    ),
    ([tests, body]) => ({ tests, body }),
  );
  const tryCatch: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        keyword("try", "{"),
        Parser.cut(Parser.seq(enclosedExpr, Parser.repeat(catchClause, { min: 1 }))),
      ),
    ),
    ([offset, [body, catches]]) => Expr.TryCatch({ body, catches, offset }),
  );
  return { switchExpr, typeswitch, tryCatch };
};

/** Builds the keyword-led expression parsers; `nameTest` is the step grammar's `NameTest`. */
export const clauses = (shared: Shared, nameTest: P<NodeTest>): Clauses => {
  const { lex, expr, exprSingle, varName, optionalType } = shared;
  const { kw, tok, at } = lex;
  const condition = Parser.delimited(tok("("), Parser.cut(expr), Parser.cut(tok(")")));
  const quantified: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.terminated(
        Parser.alt(Parser.as(kw("some"), false), Parser.as(kw("every"), true)),
        Parser.peek(literal("$")),
      ),
      Parser.cut(
        Parser.separated(
          Parser.map(
            Parser.seq(
              varName,
              optionalType,
              Parser.preceded(Parser.cut(kw("in")), Parser.cut(exprSingle)),
            ),
            ([name, type, e]): ForBinding => ({ ...simpleBinding([name, e]), type }),
          ),
          tok(","),
          { min: 1 },
        ),
      ),
      Parser.preceded(Parser.cut(kw("satisfies")), Parser.cut(exprSingle)),
    ),
    ([offset, every, bindings, satisfies]) =>
      Expr.Quantified({ every, bindings, satisfies, offset }),
  );
  const ifExpr: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(Parser.seq(kw("if"), Parser.peek(literal("("))), Parser.cut(condition)),
      Parser.preceded(Parser.cut(kw("then")), Parser.cut(exprSingle)),
      Parser.preceded(Parser.cut(kw("else")), Parser.cut(exprSingle)),
    ),
    ([offset, c, t, e]) => Expr.If({ condition: c, thenBranch: t, elseBranch: e, offset }),
  );
  const { switchExpr, typeswitch, tryCatch } = conditionals(shared, nameTest, condition);
  return {
    flwor: flworParser(shared),
    quantified,
    if: ifExpr,
    switch: switchExpr,
    typeswitch,
    try: tryCatch,
  };
};
