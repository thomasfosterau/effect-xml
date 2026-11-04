/**
 * XQuery's constructors: direct element, comment and processing-instruction
 * constructors (`ws: explicit`, A.2.4.2), CDATA sections, computed
 * constructors, and string constructors.
 *
 * Inside a direct constructor nothing is skipped: whitespace is content and
 * `(:` is text, until an enclosed expression `{ … }` switches back to the
 * expression grammar.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Parser, Token } from "@thomasfosterau/effect-parse";
import type { DirAttribute, DirNamespace, EQName } from "./ast.ts";
import { ComputedName, ComputedNCName, Expr } from "./ast.ts";
import type { Lexical, P } from "./lexical.ts";
import { normalizeNewlines, syntax } from "./lexical.ts";
import type { Issue } from "./errors.ts";

/** The constructor parsers. */
export interface Constructors {
  /** A direct element, comment or PI constructor (at `<`), then whitespace. */
  readonly direct: P<Expr>;
  /** A computed constructor (at its keyword), then whitespace. */
  readonly computed: P<Expr>;
  /** A string constructor (at ``` ``[ ```), then whitespace. */
  readonly string: P<Expr>;
}

/** Character content before adjacent pieces are merged: literal text, or text from a reference or CDATA. */
interface Text {
  readonly value: string;
  /** Written as plain characters (no reference, no CDATA): may be boundary whitespace. */
  readonly literal: boolean;
  readonly offset: number;
}

/** A piece of element or attribute content: text, or an enclosed expression or nested constructor. */
type Piece = Text | Expr;

const isText = (p: Piece): p is Text => !("_tag" in p);

const isWhitespace = (s: string): boolean => /^[ \t\r\n]*$/.test(s);

const textNode = (t: Text): Expr =>
  Expr.DirText({ value: t.value, boundary: t.literal && isWhitespace(t.value), offset: t.offset });

const mergeText = (a: Text, b: Text): Text => ({
  value: a.value + b.value,
  literal: a.literal && b.literal,
  offset: a.offset,
});

/** Merge adjacent text pieces into `DirText` nodes, keeping expressions between them. */
const mergeContent = (pieces: ReadonlyArray<Piece>): ReadonlyArray<Expr> => {
  const { done, text } = Arr.reduce(
    pieces,
    { done: Arr.empty<Expr>(), text: Option.none<Text>() },
    (acc, piece) =>
      isText(piece)
        ? {
            done: acc.done,
            text: Option.some(
              Option.match(acc.text, { onNone: () => piece, onSome: (t) => mergeText(t, piece) }),
            ),
          }
        : {
            done: [...acc.done, ...Option.toArray(Option.map(acc.text, textNode)), piece],
            text: Option.none(),
          },
  );
  return [...done, ...Option.toArray(Option.map(text, textNode))];
};

const sameName = (a: EQName, b: EQName): boolean =>
  Option.getOrUndefined(a.prefix) === Option.getOrUndefined(b.prefix) && a.local === b.local;

const show = (n: EQName): string =>
  Option.match(n.prefix, { onNone: () => n.local, onSome: (p) => `${p}:${n.local}` });

/** `xmlns` and `xmlns:p` are namespace declaration attributes. */
const isNamespaceDecl = (a: DirAttribute): boolean =>
  Option.match(a.name.prefix, {
    onNone: () => a.name.local === "xmlns",
    onSome: (p) => p === "xmlns",
  });

const isDirText = Expr.$is("DirText");

/** A namespace declaration attribute's URI: its literal text, or `None` if it encloses an expression. */
const literalValue = (a: DirAttribute): Option.Option<string> =>
  Arr.every(a.value, isDirText)
    ? Option.some(a.value.map((part) => (isDirText(part) ? part.value : "")).join(""))
    : Option.none();

interface Element {
  readonly offset: number;
  readonly name: EQName;
  readonly attributes: ReadonlyArray<DirAttribute>;
  readonly end: Option.Option<readonly [ReadonlyArray<Piece>, EQName]>;
}

const namespaceOf = (a: DirAttribute): DirNamespace => ({
  prefix: Option.map(a.name.prefix, () => a.name.local),
  uri: Option.getOrElse(literalValue(a), () => ""),
  offset: a.offset,
});

/** Check a parsed direct element (end tag, namespace declarations) and build its node. */
const directElement = (e: Element): Result.Result<Expr, Issue> => {
  const mismatch = Option.filter(
    Option.map(e.end, ([, n]) => n),
    (n) => !sameName(e.name, n),
  );
  if (Option.isSome(mismatch))
    return Result.fail({
      code: "XQST0118",
      description: `the end tag </${show(mismatch.value)}> does not match <${show(e.name)}>`,
    });
  const declarations = e.attributes.filter(isNamespaceDecl);
  const computed = declarations.find((a) => Option.isNone(literalValue(a)));
  if (computed !== undefined)
    return Result.fail({
      code: "XQST0022",
      description: `the namespace declaration ${show(computed.name)} encloses an expression`,
    });
  return Result.succeed(
    Expr.DirElement({
      name: e.name,
      attributes: e.attributes.filter((a) => !isNamespaceDecl(a)),
      namespaces: declarations.map(namespaceOf),
      content: mergeContent(Option.match(e.end, { onNone: () => [], onSome: ([c]) => c })),
      offset: e.offset,
    }),
  );
};

const literal = Token.literal;
const empty = (offset: number): Expr => Expr.Sequence({ items: [], offset });

const textOf = (literalText: boolean) =>
  Parser.map(([offset, value]: readonly [number, string]): Text => ({
    value,
    literal: literalText,
    offset,
  }));

const qnameOrExpr = (n: Option.Option<EQName>, e: Expr): ComputedName =>
  Option.match(n, {
    onNone: () => ComputedName.Dynamic({ expr: e }),
    onSome: (name) => ComputedName.Static({ name }),
  });
const ncnameOrExpr = (n: Option.Option<string>, e: Expr): ComputedNCName =>
  Option.match(n, {
    onNone: () => ComputedNCName.Dynamic({ expr: e }),
    onSome: (name) => ComputedNCName.Static({ name }),
  });

/** The computed constructors, over `kw`, the enclosed expression `block` and the names. */
const computedParser = (lex: Lexical, block: P<Expr>): P<Expr> => {
  const { kw, lexeme, at, eqname, ncname } = lex;
  const named = <A>(
    keyword: string,
    nameP: P<A>,
    build: (offset: number, n: Option.Option<A>, nameExpr: Expr, body: Expr) => Expr,
  ): P<Expr> =>
    Parser.alt(
      Parser.map(
        Parser.seq(
          at,
          Parser.preceded(kw(keyword), Parser.terminated(lexeme(nameP), Parser.peek(literal("{")))),
          Parser.cut(block),
        ),
        ([offset, n, body]) => build(offset, Option.some(n), body, body),
      ),
      Parser.map(
        Parser.seq(
          at,
          Parser.preceded(
            Parser.seq(kw(keyword), Parser.peek(literal("{"))),
            Parser.cut(Parser.seq(block, block)),
          ),
        ),
        ([offset, [nameExpr, body]]) => build(offset, Option.none(), nameExpr, body),
      ),
    );
  const simple = (keyword: string, build: (offset: number, body: Expr) => Expr): P<Expr> =>
    Parser.map(
      Parser.seq(
        at,
        Parser.preceded(Parser.seq(kw(keyword), Parser.peek(literal("{"))), Parser.cut(block)),
      ),
      ([offset, body]) => build(offset, body),
    );
  return Parser.alt(
    named("element", eqname, (offset, n, nameExpr, body) =>
      Expr.CompElement({ name: qnameOrExpr(n, nameExpr), body, offset }),
    ),
    named("attribute", eqname, (offset, n, nameExpr, body) =>
      Expr.CompAttribute({ name: qnameOrExpr(n, nameExpr), body, offset }),
    ),
    named("namespace", ncname, (offset, prefix, prefixExpr, uri) =>
      Expr.CompNamespace({ prefix: ncnameOrExpr(prefix, prefixExpr), uri, offset }),
    ),
    named("processing-instruction", ncname, (offset, target, targetExpr, body) =>
      Expr.CompPI({ target: ncnameOrExpr(target, targetExpr), body, offset }),
    ),
    simple("document", (offset, body) => Expr.CompDocument({ body, offset })),
    simple("text", (offset, body) => Expr.CompText({ body, offset })),
    simple("comment", (offset, body) => Expr.CompComment({ body, offset })),
    simple("ordered", (offset, body) => Expr.Ordering({ ordered: true, body, offset })),
    simple("unordered", (offset, body) => Expr.Ordering({ ordered: false, body, offset })),
  );
};

/** String constructors: ``` ``[ chars `{ Expr? }` chars ]`` ```. */
const stringParser = (lex: Lexical, expr: P<Expr>): P<Expr> => {
  const { at, ws, lexeme } = lex;
  const interpolation: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        Parser.seq(literal("`{"), ws),
        Parser.cut(Parser.terminated(Parser.optional(expr), literal("}`"))),
      ),
    ),
    ([offset, e]) => e ?? empty(offset),
  );
  const chars: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.taken(
        Parser.repeat(
          Parser.alt(
            Token.takeTill("`]", { min: 1 }),
            Parser.seq(literal("`"), Parser.not(literal("{"))),
            Parser.seq(literal("]"), Parser.not(literal("``"))),
          ),
          { min: 1 },
        ),
      ),
    ),
    ([offset, value]) => Expr.StringLiteral({ value: normalizeNewlines(value), offset }),
  );
  return lexeme(
    Parser.map(
      Parser.seq(
        at,
        Parser.preceded(
          literal("``["),
          Parser.cut(
            Parser.terminated(Parser.repeat(Parser.alt(chars, interpolation)), literal("]``")),
          ),
        ),
      ),
      ([offset, parts]) => Expr.StringConstructor({ parts, offset }),
    ),
  );
};

/** Builds the constructor parsers; `expr` is the expression grammar's `Expr`. */
export const constructors = (lex: Lexical, expr: P<Expr>): Constructors => {
  const { lexeme, at, ws, s, qname, ncname, reference } = lex;
  const optionalS = Parser.optional(s);
  const ref = Parser.preceded(literal("&"), reference);
  const closeBrace = syntax('a "}" in content must be written "}}"');
  const escapes = Parser.alt(Parser.as(literal("{{"), "{"), Parser.as(literal("}}"), "}"));

  /** `{ Expr? }` with the expression grammar inside. */
  const enclosed: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(Parser.seq(literal("{"), ws), Parser.optional(expr)),
      Parser.cut(literal("}")),
    ),
    ([offset, e]) => e ?? empty(offset),
  );

  const attributeValue = (q: '"' | "'"): P<ReadonlyArray<Expr>> => {
    const text: P<Text> = Parser.alt(
      Parser.seq(
        at,
        Parser.map(Token.takeTill(`${q}{}<&`, { min: 1 }), (t) =>
          normalizeNewlines(t).replace(/[\t\n]/g, " "),
        ),
      ).pipe(textOf(true)),
      Parser.seq(at, Parser.alt(Parser.as(literal(`${q}${q}`), q), escapes, ref)).pipe(
        textOf(false),
      ),
    );
    return Parser.delimited(
      literal(q),
      Parser.map(
        Parser.repeat(
          Parser.alt(
            text,
            enclosed,
            Parser.preceded(Parser.peek(literal("}")), closeBrace),
            Parser.preceded(Parser.peek(literal("<")), syntax('"<" in an attribute value')),
          ),
        ),
        mergeContent,
      ),
      Parser.cut(literal(q)),
    );
  };
  const attribute: P<DirAttribute> = Parser.map(
    Parser.seq(
      at,
      qname,
      Parser.preceded(
        Parser.seq(optionalS, literal("="), optionalS),
        Parser.cut(Parser.alt(attributeValue('"'), attributeValue("'"))),
      ),
    ),
    ([offset, n, value]) => ({ name: n, value, offset }),
  );

  const dirComment: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        literal("<!--"),
        Parser.cut(
          Parser.terminated(
            Parser.taken(
              Parser.repeat(
                Parser.alt(Token.noneOf("-"), Parser.seq(literal("-"), Token.noneOf("-"))),
              ),
            ),
            literal("-->"),
          ),
        ),
      ),
    ),
    ([offset, value]) => Expr.DirComment({ value: normalizeNewlines(value), offset }),
  );
  const dirPI: P<Expr> = Parser.map(
    Parser.seq(
      at,
      Parser.preceded(
        literal("<?"),
        Parser.cut(
          Parser.seq(
            Parser.filter(ncname, (t) => t.toLowerCase() !== "xml"),
            Parser.alt(
              Parser.as(literal("?>"), ""),
              Parser.delimited(s, Token.takeUntil("?>"), literal("?>")),
            ),
          ),
        ),
      ),
    ),
    ([offset, [target, value]]) => Expr.DirPI({ target, value: normalizeNewlines(value), offset }),
  );
  const cdata: P<Text> = Parser.seq(
    at,
    Parser.map(
      Parser.delimited(literal("<![CDATA["), Parser.cut(Token.takeUntil("]]>")), literal("]]>")),
      normalizeNewlines,
    ),
  ).pipe(textOf(false));

  const elementText: P<Text> = Parser.alt(
    Parser.seq(at, Parser.map(Token.takeTill("{}<&", { min: 1 }), normalizeNewlines)).pipe(
      textOf(true),
    ),
    Parser.seq(at, Parser.alt(escapes, ref)).pipe(textOf(false)),
  );
  const piece: P<Piece> = Parser.suspend(() =>
    Parser.alt(
      elementText,
      cdata,
      nested,
      enclosed,
      Parser.preceded(Parser.peek(literal("}")), closeBrace),
    ).pipe(Parser.expected("element content")),
  );
  const endTag = Parser.delimited(literal("</"), qname, Parser.seq(optionalS, literal(">")));
  const dirElement: P<Expr> = Parser.tryMap(
    Parser.seq(
      at,
      Parser.preceded(literal("<"), qname),
      Parser.repeat(Parser.preceded(s, attribute)),
      Parser.preceded(
        optionalS,
        Parser.cut(
          Parser.alt(
            Parser.as(literal("/>"), Option.none()),
            Parser.map(
              Parser.preceded(literal(">"), Parser.seq(Parser.repeat(piece), endTag)),
              Option.some,
            ),
          ),
        ),
      ),
    ),
    ([offset, n, attributes, end]) => directElement({ offset, name: n, attributes, end }),
  );
  const nested: P<Expr> = Parser.alt(
    Parser.preceded(Parser.peek(Parser.seq(literal("<"), lex.ncNameStart)), Parser.cut(dirElement)),
    dirComment,
    dirPI,
  );

  return {
    direct: lexeme(nested),
    computed: computedParser(lex, lexeme(enclosed)),
    string: stringParser(lex, expr),
  };
};
