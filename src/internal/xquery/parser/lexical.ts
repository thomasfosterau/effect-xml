/**
 * The lexical layer of the XQuery 3.1 / XPath 3.1 grammar (Appendix A.2):
 * whitespace and nested comments, names (`NCName`, `QName`,
 * `URIQualifiedName`), keywords, and the literals.
 *
 * Every token parser built with {@link Lexical.tok} or {@link Lexical.kw}
 * consumes the whitespace and comments after it, so the grammar skips
 * leading whitespace once and then never thinks about it again, except
 * inside the `ws: explicit` productions (direct constructors, pragmas,
 * string constructors), which use the raw parsers.
 *
 * The `Lexical` record is built per language: XQuery string literals and
 * braced URI literals decode entity and character references; XPath's take
 * `&` literally.
 */
import * as Option from "effect/Option";
import { Parser, Token } from "@thomasfosterau/effect-parse";
import { ncNameChar, ncNameStartChar } from "../../names.ts";
import type { EQName } from "./ast.ts";
import { Expr } from "./ast.ts";
import type { Issue } from "./errors.ts";

/** A grammar parser: syntax failures, or a static error the grammar recognises. */
export type P<A> = Parser.Parser<A, Issue>;

/** `S ::= (#x20 | #x9 | #xD | #xA)+` */
const whitespaceChars = " \t\r\n";

/** XML 1.0 `Char`: what a character reference may denote. */
const isXmlChar = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

/** End-of-line handling (A.2.3): CRLF and lone CR read as LF. */
export const normalizeNewlines = (s: string): string =>
  s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;

/** Fail unrecoverably with a static error. */
const issue = (code: string, description: string): P<never> =>
  Parser.cut(Parser.fail({ code, description }));

/** A syntax error with a description. */
export const syntax = (description: string): P<never> => issue("XPST0003", description);

/** The character a character reference denotes, or `XQST0090` if it is not an XML character. */
const charRefValue = (digits: string, radix: number): P<string> => {
  const cp = Number.parseInt(digits, radix);
  return isXmlChar(cp)
    ? Parser.succeed(String.fromCodePoint(cp))
    : issue("XQST0090", `&#${radix === 16 ? "x" : ""}${digits}; is not an XML character`);
};

const literal = Token.literal;
const join = (parts: ReadonlyArray<string>): string => parts.join("");

/** `p`, then whitespace and comments. */
const lexemeOf =
  (ws: P<void>) =>
  <A>(p: P<A>): P<A> =>
    Parser.terminated(p, ws);

const qnameOf = ([offset, first, second]: readonly [
  number,
  string,
  Option.Option<string>,
]): EQName =>
  Option.match(second, {
    onNone: () => ({ prefix: Option.none(), local: first, uri: Option.none(), offset }),
    onSome: (local) => ({ prefix: Option.some(first), local, uri: Option.none(), offset }),
  });

const numericOf = ([offset, [[decimal, exponent], value]]: readonly [
  number,
  readonly [readonly [boolean, unknown], string],
  void,
]): Expr =>
  exponent !== undefined
    ? Expr.DoubleLiteral({ value, offset })
    : decimal
      ? Expr.DecimalLiteral({ value, offset })
      : Expr.IntegerLiteral({ value, offset });

/** The parsers of the lexical layer, for one language. */
export interface Lexical {
  readonly xquery: boolean;
  /** Whitespace and comments, skipped between tokens. */
  readonly ws: P<void>;
  /** `S`, explicit whitespace (no comments), as in direct constructors. */
  readonly s: P<string>;
  /** A literal token, then whitespace. */
  readonly tok: <const L extends string>(text: L) => P<L>;
  /** A keyword: a literal that is not followed by a name character, then whitespace. */
  readonly kw: <const L extends string>(word: L) => P<L>;
  /** `p` followed by whitespace. */
  readonly lexeme: <A>(p: P<A>) => P<A>;
  /** A start position: the current offset. */
  readonly at: P<number>;
  readonly ncNameStart: P<string>;
  /** `NCName`, raw (no trailing whitespace). */
  readonly ncname: P<string>;
  /** `QName`, raw. */
  readonly qname: P<EQName>;
  /** `EQName ::= QName | URIQualifiedName`, raw. */
  readonly eqname: P<EQName>;
  /** `BracedURILiteral ::= "Q" "{" … "}"`, raw: the URI. */
  readonly bracedUri: P<string>;
  /** A string literal, decoded, then whitespace. */
  readonly stringLiteral: P<string>;
  /** A numeric literal, then whitespace. */
  readonly numericLiteral: P<Expr>;
  /** `IntegerLiteral ::= Digits`, then whitespace. */
  readonly integerLiteral: P<string>;
  /** `PredefinedEntityRef | CharRef` after its `&`, decoded (XQuery only). */
  readonly reference: P<string>;
}

/** `Comment ::= "(:" (CommentContents | Comment)* ":)"`: comments nest. */
const commentParser = (): P<void> => {
  const text: P<unknown> = Parser.alt(
    Token.takeTill("(:", { min: 1 }),
    Parser.seq(literal("("), Parser.not(literal(":"))),
    Parser.seq(literal(":"), Parser.not(literal(")"))),
  );
  const comment: P<void> = Parser.asVoid(
    Parser.seq(
      literal("(:"),
      Parser.repeat(
        Parser.alt(
          Parser.suspend(() => comment),
          text,
        ),
      ),
      Parser.cut(literal(":)").pipe(Parser.expected('":)" closing the comment'))),
    ),
  );
  return comment;
};

/** `PredefinedEntityRef | CharRef`, after the `&`. */
const referenceParser = (): P<string> => {
  const hex = Parser.delimited(
    literal("#x"),
    Token.takeWhile("0123456789abcdefABCDEF", { min: 1 }),
    literal(";"),
  );
  const dec = Parser.delimited(
    literal("#"),
    Token.takeWhile("0123456789", { min: 1 }),
    literal(";"),
  );
  const entity = Parser.terminated(
    Parser.alt(
      Parser.as(literal("lt"), "<"),
      Parser.as(literal("gt"), ">"),
      Parser.as(literal("amp"), "&"),
      Parser.as(literal("quot"), '"'),
      Parser.as(literal("apos"), "'"),
    ),
    literal(";"),
  );
  return Parser.alt(
    entity,
    hex.pipe(Parser.flatMap((digits) => charRefValue(digits, 16))),
    dec.pipe(Parser.flatMap((digits) => charRefValue(digits, 10))),
    syntax("invalid entity or character reference"),
  );
};

/** A string literal delimited by `q`; in XQuery, `&` starts a reference. */
const quotedParser = (q: '"' | "'", ampersand: P<string> | undefined): P<string> => {
  const escape = Parser.as(literal(`${q}${q}`), q);
  const part =
    ampersand === undefined
      ? Parser.alt(Parser.map(Token.takeTill(q, { min: 1 }), normalizeNewlines), escape)
      : Parser.alt(
          Parser.map(Token.takeTill(`${q}&`, { min: 1 }), normalizeNewlines),
          escape,
          ampersand,
        );
  return Parser.preceded(
    literal(q),
    Parser.cut(
      Parser.terminated(
        Parser.map(Parser.repeat(part), join),
        literal(q).pipe(Parser.expected(`${q} closing the string literal`)),
      ),
    ),
  );
};

/** Whitespace normalization, as for `xs:anyURI` (`fn:normalize-space`). */
const normalizeSpace = (s: string): string => s.replace(/[ \t\r\n]+/g, " ").trim();

/** `BracedURILiteral`, whitespace-normalized; in XQuery, `&` starts a reference. */
const bracedUriParser = (ampersand: P<string> | undefined): P<string> =>
  Parser.delimited(
    literal("Q{"),
    ampersand === undefined
      ? Parser.map(Token.takeTill("{}"), normalizeSpace)
      : Parser.map(
          Parser.repeat(Parser.alt(Token.takeTill("{}&", { min: 1 }), ampersand)),
          (parts) => normalizeSpace(join(parts)),
        ),
    Parser.cut(literal("}")),
  );

/** Numeric literals: `IntegerLiteral`, `DecimalLiteral`, `DoubleLiteral`; a name may not follow directly. */
const numericParser = (at: P<number>, ncNameStart: P<string>): P<Expr> => {
  const digits = Token.takeWhile("0123456789", { min: 1 });
  const mantissa = Parser.alt(
    Parser.as(Parser.seq(literal("."), digits), true),
    Parser.map(
      Parser.seq(digits, Parser.optional(Parser.seq(literal("."), Token.takeWhile("0123456789")))),
      ([, dot]) => dot !== undefined,
    ),
  );
  const exponent = Parser.seq(Token.oneOf("eE"), Parser.optional(Token.oneOf("+-")), digits);
  return Parser.map(
    Parser.seq(
      at,
      Parser.withTaken(Parser.seq(mantissa, Parser.optional(exponent))),
      Parser.not(ncNameStart),
    ),
    numericOf,
  );
};

/** Builds the lexical parsers for XQuery (`xquery`) or XPath. */
export const lexical = (xquery: boolean): Lexical => {
  const ws: P<void> = Parser.asVoid(
    Parser.repeat(Parser.alt(Token.takeWhile(whitespaceChars, { min: 1 }), commentParser())),
  ).pipe(Parser.expected("whitespace"));
  const lexeme = lexemeOf(ws);
  const tok = <const L extends string>(text: L): P<L> => lexeme(literal(text));

  const ncNameStart: P<string> = Token.oneOf(ncNameStartChar).pipe(Parser.expected("a name"));
  const ncname: P<string> = Parser.taken(Parser.seq(ncNameStart, Token.takeWhile(ncNameChar)));

  // A keyword ends where a name could not continue: `for-each` and `for:x`
  // are names, not the keyword `for`.
  const notName = Parser.seq(
    Parser.not(Token.oneOf(ncNameChar)),
    Parser.not(Parser.seq(literal(":"), Parser.alt(ncNameStart, literal("*")))),
  );
  const kw = <const L extends string>(word: L): P<L> =>
    lexeme(Parser.terminated(literal(word), notName));

  const at: P<number> = Parser.location;
  const reference = referenceParser();
  const ampersand = xquery ? Parser.preceded(literal("&"), reference) : undefined;
  const bracedUri = bracedUriParser(ampersand);

  const qname: P<EQName> = Parser.map(
    Parser.seq(
      at,
      ncname,
      Parser.opt(Parser.preceded(Parser.seq(literal(":"), Parser.peek(ncNameStart)), ncname)),
    ),
    qnameOf,
  );
  const uriQualified: P<EQName> = Parser.map(
    Parser.seq(at, bracedUri, ncname),
    ([offset, uri, local]): EQName => ({
      prefix: Option.none(),
      local,
      uri: Option.some(uri),
      offset,
    }),
  );

  return {
    xquery,
    ws,
    s: Token.takeWhile(whitespaceChars, { min: 1 }),
    tok,
    kw,
    lexeme,
    at,
    ncNameStart,
    ncname,
    qname,
    eqname: Parser.alt(uriQualified, qname),
    bracedUri,
    stringLiteral: lexeme(Parser.alt(quotedParser('"', ampersand), quotedParser("'", ampersand))),
    numericLiteral: lexeme(numericParser(at, ncNameStart)),
    integerLiteral: lexeme(
      Parser.terminated(Token.takeWhile("0123456789", { min: 1 }), Parser.not(ncNameStart)),
    ),
    reference,
  };
};
