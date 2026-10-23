/**
 * Grammars for the XML declaration, processing instructions and DOCTYPE, as
 * used by the lexer in XML mode.
 *
 * They follow the productions of XML 1.0 (5th ed.) §2.6 and §2.8 and include
 * their closing delimiters, so the token grammar can embed them directly.
 * Each is labelled with {@link Parser.context}; the lexer turns a failure
 * under one of those labels into a positioned {@link MalformedDeclaration}
 * saying what was expected.
 *
 * HTML has no processing instructions, and its DOCTYPE is WHATWG error
 * recovery rather than a grammar (see `tokens.ts`).
 */
import { Parser, Token } from "@thomasfosterau/effect-parse";
import * as HashSet from "effect/HashSet";
import { QNameGrammar } from "./names.ts";

// -----------------------------------------------------------------------------
// Shared productions
// -----------------------------------------------------------------------------

const whitespace = " \t\r\n";

/** `S ::= (#x20 | #x9 | #xD | #xA)+` */
const S = Token.takeWhile(whitespace, { min: 1 }).pipe(Parser.expected("whitespace"));

/** `S?` */
const S0 = Token.takeWhile(whitespace);

/** `Eq ::= S? '=' S?` */
const Eq = Parser.delimited(S0, Token.literal("="), S0);

/** A name: a `QName` (Namespaces in XML 1.0 §3), so at most one colon. */
const Name = QNameGrammar;

/** `value` between matching single or double quotes; `inner` gets the quote. */
const quoted = <A>(inner: (quote: '"' | "'") => Parser.Parser<A>): Parser.Parser<A> =>
  Parser.alt(
    Parser.delimited(Token.literal('"'), inner('"'), Token.literal('"')),
    Parser.delimited(Token.literal("'"), inner("'"), Token.literal("'")),
  );

/** A keyword, then a cut: once it has matched, the rest of the production must. */
const keyword = <A>(word: string, rest: Parser.Parser<A>): Parser.Parser<A> =>
  Parser.preceded(Token.literal(word), Parser.cut(rest));

// -----------------------------------------------------------------------------
// XML declaration (§2.8)
// -----------------------------------------------------------------------------

/** `VersionNum ::= '1.' [0-9]+` */
const VersionNum = Parser.taken(
  Parser.seq(Token.literal("1."), Token.takeWhile(Token.range("0", "9"), { min: 1 })),
).pipe(Parser.expected("version number"));

/** `EncName ::= [A-Za-z] ([A-Za-z0-9._] | '-')*` */
const EncName = Parser.taken(
  Parser.seq(
    Token.oneOf([Token.range("A", "Z"), Token.range("a", "z")]),
    Token.takeWhile([Token.range("A", "Z"), Token.range("a", "z"), Token.range("0", "9"), "._-"]),
  ),
).pipe(Parser.expected("encoding name"));

const YesNo = Parser.alt(
  Parser.as(Token.literal("yes"), true),
  Parser.as(Token.literal("no"), false),
);

/** `S 'version' Eq ('"' VersionNum '"' | "'" VersionNum "'")` */
const VersionInfo = Parser.preceded(
  S,
  keyword(
    "version",
    Parser.preceded(
      Eq,
      quoted(() => VersionNum),
    ),
  ),
);

/** `S 'encoding' Eq ('"' EncName '"' | "'" EncName "'")` */
const EncodingDecl = Parser.preceded(
  S,
  keyword(
    "encoding",
    Parser.preceded(
      Eq,
      quoted(() => EncName),
    ),
  ),
);

/** `S 'standalone' Eq (("'" ('yes' | 'no') "'") | ('"' ('yes' | 'no') '"'))` */
const SDDecl = Parser.preceded(
  S,
  keyword(
    "standalone",
    Parser.preceded(
      Eq,
      quoted(() => YesNo),
    ),
  ),
);

export interface XmlDeclarationBody {
  readonly _tag: "XmlDeclaration";
  readonly version: string;
  readonly encoding: string | null;
  readonly standalone: boolean | null;
}

/** What follows the `xml` target: `VersionInfo EncodingDecl? SDDecl? S? '?>'` */
const XmlDeclarationRest: Parser.Parser<XmlDeclarationBody> = Parser.gen(function* () {
  const version = yield* Parser.cut(VersionInfo);
  const encoding = yield* Parser.optional(EncodingDecl);
  const standalone = yield* Parser.optional(SDDecl);
  yield* S0;
  yield* Parser.cut(Token.literal("?>"));
  return {
    _tag: "XmlDeclaration" as const,
    version,
    encoding: encoding ?? null,
    standalone: standalone ?? null,
  };
});

// -----------------------------------------------------------------------------
// Processing instructions (§2.6)
// -----------------------------------------------------------------------------

export interface ProcessingInstructionBody {
  readonly _tag: "ProcessingInstruction";
  readonly target: string;
  readonly data: string;
}

/**
 * The context labels of these grammars. A failure under one of them is a
 * malformed declaration, named by the label.
 */
export const declarationContexts = HashSet.make("processing instruction", "DOCTYPE");

/**
 * `PITarget ::= Name - (('X' | 'x') ('M' | 'm') ('L' | 'l'))`. The exact name
 * `xml` is let through here: it starts the XML declaration instead.
 */
const PITarget = Parser.flatMap(Parser.peek(Name), (name) =>
  // A message, so the failure is reported here rather than at a deeper hint.
  name === "xml" || name.toLowerCase() !== "xml"
    ? Name
    : Parser.failMessage("processing instruction target"),
).pipe(Parser.expected("processing instruction target"));

/** `(S (Char* - (Char* '?>' Char*)))? '?>'` */
const PIRest: Parser.Parser<string> = Parser.terminated(
  Parser.alt(Parser.preceded(S, Token.takeUntil("?>")), Parser.succeed("")),
  Parser.cut(Token.literal("?>")),
);

/**
 * What follows `<?`: the XML declaration, or `PITarget (S Char*)? '?>'`.
 */
export const processingInstruction: Parser.Parser<XmlDeclarationBody | ProcessingInstructionBody> =
  Parser.gen(function* () {
    const target = yield* PITarget;
    if (target === "xml") return yield* XmlDeclarationRest;
    const data = yield* PIRest;
    return { _tag: "ProcessingInstruction" as const, target, data };
  }).pipe(Parser.context("processing instruction"));

// -----------------------------------------------------------------------------
// DOCTYPE (§2.8)
// -----------------------------------------------------------------------------

/** `SystemLiteral ::= ('"' [^"]* '"') | ("'" [^']* "'")` */
export const SystemLiteral: Parser.Parser<string> = quoted((q) => Token.takeTill(q)).pipe(
  Parser.expected("system literal"),
);

/** `PubidChar ::= #x20 | #xD | #xA | [a-zA-Z0-9] | [-'()+,./:=?;!*#@$_%]` */
const pubidChars = (quote: '"' | "'") => [
  " \r\n-()+,./:=?;!*#@$_%" + (quote === '"' ? "'" : ""),
  Token.range("a", "z"),
  Token.range("A", "Z"),
  Token.range("0", "9"),
];

/** `PubidLiteral ::= '"' PubidChar* '"' | "'" (PubidChar - "'")* "'"` */
export const PubidLiteral: Parser.Parser<string> = quoted((q) =>
  Token.takeWhile(pubidChars(q)),
).pipe(Parser.expected("public identifier"));

interface ExternalId {
  readonly publicId: string | null;
  readonly systemId: string;
}

/** `ExternalID ::= 'SYSTEM' S SystemLiteral | 'PUBLIC' S PubidLiteral S SystemLiteral` */
export const ExternalID: Parser.Parser<ExternalId> = Parser.alt(
  keyword(
    "SYSTEM",
    Parser.preceded(S, SystemLiteral).pipe(
      Parser.map((systemId) => ({ publicId: null, systemId })),
    ),
  ),
  keyword(
    "PUBLIC",
    Parser.seq(Parser.preceded(S, PubidLiteral), Parser.preceded(S, SystemLiteral)).pipe(
      Parser.map(([publicId, systemId]) => ({ publicId, systemId })),
    ),
  ),
);

/**
 * A processing instruction in the internal subset, after `<?`:
 * `PITarget (S Char*)? '?>'`. An XML declaration is not allowed there, so
 * no target may be `xml` in any case.
 */
export const subsetProcessingInstruction: Parser.Parser<string> = Parser.preceded(
  Parser.flatMap(Parser.peek(Name), (name) =>
    name.toLowerCase() === "xml" ? Parser.failMessage("processing instruction target") : Name,
  ).pipe(Parser.expected("processing instruction target")),
  PIRest,
);

/** `Comment` (§2.5) after `<!--`: no `--` before the closing `-->`. */
export const commentRest: Parser.Parser<string> = Parser.terminated(
  Token.takeUntil("--"),
  Token.literal("-->").pipe(Parser.expected("`-->` (only `-->` may contain `--`)")),
);

/** A string literal, comment or PI inside the internal subset, kept as text. */
const subsetItem = Parser.alt(
  Parser.seq(Token.literal('"'), Token.takeTill('"'), Token.literal('"')),
  Parser.seq(Token.literal("'"), Token.takeTill("'"), Token.literal("'")),
  keyword("<!--", commentRest),
  keyword("<?", subsetProcessingInstruction),
  Token.takeTill("]\"'<", { min: 1 }),
  Token.literal("<"),
);

/**
 * `'[' intSubset ']' S?`. The markup declarations are not interpreted, only
 * skipped over (literals, comments and PIs may contain `]`), and kept as text.
 */
const InternalSubset = Parser.delimited(
  Token.literal("["),
  Parser.taken(Parser.repeat(subsetItem)),
  Parser.cut(Parser.seq(Token.literal("]"), S0)),
);

export interface DoctypeBody {
  readonly name: string;
  readonly publicId: string | null;
  readonly systemId: string | null;
  readonly internalSubset: string | null;
}

/**
 * What follows `<!`:
 * `'DOCTYPE' S Name (S ExternalID)? S? ('[' intSubset ']' S?)? '>'`
 */
export const doctype: Parser.Parser<DoctypeBody> = Parser.gen(function* () {
  yield* Token.literal("DOCTYPE");
  yield* S;
  const name = yield* Parser.cut(Name.pipe(Parser.expected("document type name")));
  const externalId = yield* Parser.optional(Parser.preceded(S, ExternalID));
  yield* S0;
  const subset = yield* Parser.optional(InternalSubset);
  yield* Parser.cut(Token.literal(">"));
  return {
    name,
    publicId: externalId?.publicId ?? null,
    systemId: externalId?.systemId ?? null,
    internalSubset: subset === undefined ? null : subset.trim() || null,
  };
}).pipe(Parser.context("DOCTYPE"));
