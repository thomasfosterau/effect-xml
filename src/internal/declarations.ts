/**
 * Grammars for the XML declaration, processing instructions and DOCTYPE.
 *
 * The lexer's state machine finds where these constructs start and end (it has
 * to, to stay chunk-boundary safe); once it has a complete body it hands the
 * text to one of these parsers. They follow the productions of XML 1.0 (5th
 * ed.) §2.6 and §2.8, and on failure report what was expected and where, which
 * the lexer turns into a positioned {@link MalformedDeclaration}.
 *
 * Only XML mode uses these. HTML has no processing instructions, and its
 * DOCTYPE handling is WHATWG error recovery rather than a grammar.
 */
import { Parser, ParseError, Token } from "@thomasfosterau/effect-parse"
import { Result } from "effect"
import { isNameChar, isValidName } from "../Name.ts"

// -----------------------------------------------------------------------------
// Shared productions
// -----------------------------------------------------------------------------

const whitespace = " \t\r\n"

/** `S ::= (#x20 | #x9 | #xD | #xA)+` */
const S = Token.takeWhile(whitespace, { min: 1 }).pipe(Parser.expected("whitespace"))

/** `S?` */
const S0 = Token.takeWhile(whitespace)

/** `Eq ::= S? '=' S?` */
const Eq = Parser.delimited(S0, Token.literal("="), S0)

/** `Name ::= NameStartChar (NameChar)*` */
const Name = Token.takeWhile(isNameChar, { min: 1 }).pipe(Parser.filter(isValidName))

/** `value` between matching single or double quotes; `inner` gets the quote. */
const quoted = <A>(inner: (quote: "\"" | "'") => Parser.Parser<A>): Parser.Parser<A> =>
  Parser.alt(
    Parser.delimited(Token.literal("\""), inner("\""), Token.literal("\"")),
    Parser.delimited(Token.literal("'"), inner("'"), Token.literal("'"))
  )

/** A keyword, then a cut: once it has matched, the rest of the production must. */
const keyword = <A>(word: string, rest: Parser.Parser<A>): Parser.Parser<A> =>
  Parser.preceded(Token.literal(word), Parser.cut(rest))

// -----------------------------------------------------------------------------
// XML declaration (§2.8)
// -----------------------------------------------------------------------------

/** `VersionNum ::= '1.' [0-9]+` */
const VersionNum = Parser.taken(
  Parser.seq(Token.literal("1."), Token.takeWhile(Token.range("0", "9"), { min: 1 }))
).pipe(Parser.expected("version number"))

/** `EncName ::= [A-Za-z] ([A-Za-z0-9._] | '-')*` */
const EncName = Parser.taken(
  Parser.seq(
    Token.oneOf([Token.range("A", "Z"), Token.range("a", "z")]),
    Token.takeWhile([Token.range("A", "Z"), Token.range("a", "z"), Token.range("0", "9"), "._-"])
  )
).pipe(Parser.expected("encoding name"))

const YesNo = Parser.alt(Parser.as(Token.literal("yes"), true), Parser.as(Token.literal("no"), false))

/** `S 'version' Eq ('"' VersionNum '"' | "'" VersionNum "'")` */
const VersionInfo = Parser.preceded(S, keyword("version", Parser.preceded(Eq, quoted(() => VersionNum))))

/** `S 'encoding' Eq ('"' EncName '"' | "'" EncName "'")` */
const EncodingDecl = Parser.preceded(S, keyword("encoding", Parser.preceded(Eq, quoted(() => EncName))))

/** `S 'standalone' Eq (("'" ('yes' | 'no') "'") | ('"' ('yes' | 'no') '"'))` */
const SDDecl = Parser.preceded(S, keyword("standalone", Parser.preceded(Eq, quoted(() => YesNo))))

export interface XmlDeclarationBody {
  readonly _tag: "XmlDeclaration"
  readonly version: string
  readonly encoding: string | null
  readonly standalone: boolean | null
}

/** What follows the `xml` target: `VersionInfo EncodingDecl? SDDecl? S?` */
const XmlDeclarationRest: Parser.Parser<XmlDeclarationBody> = Parser.gen(function* () {
  const version = yield* Parser.cut(VersionInfo)
  const encoding = yield* Parser.optional(EncodingDecl)
  const standalone = yield* Parser.optional(SDDecl)
  yield* S0
  return { _tag: "XmlDeclaration" as const, version, encoding: encoding ?? null, standalone: standalone ?? null }
})

// -----------------------------------------------------------------------------
// Processing instructions (§2.6)
// -----------------------------------------------------------------------------

export interface ProcessingInstructionBody {
  readonly _tag: "ProcessingInstruction"
  readonly target: string
  readonly data: string
}

/**
 * `PITarget ::= Name - (('X' | 'x') ('M' | 'm') ('L' | 'l'))`. The exact name
 * `xml` is let through here: it starts the XML declaration instead.
 */
const PITarget = Name.pipe(
  Parser.filter((name) => name === "xml" || name.toLowerCase() !== "xml"),
  Parser.expected("processing instruction target")
)

/**
 * The body of `<?…?>` (without the delimiters): either the XML declaration or
 * `PITarget (S Char*)?`.
 */
export const processingInstruction: Parser.Parser<XmlDeclarationBody | ProcessingInstructionBody> =
  Parser.gen(function* () {
    const target = yield* PITarget
    if (target === "xml") return yield* XmlDeclarationRest
    const data = yield* Parser.alt(Parser.preceded(S, Token.rest), Parser.as(Parser.eof, ""))
    return { _tag: "ProcessingInstruction" as const, target, data }
  })

// -----------------------------------------------------------------------------
// DOCTYPE (§2.8)
// -----------------------------------------------------------------------------

/** `SystemLiteral ::= ('"' [^"]* '"') | ("'" [^']* "'")` */
const SystemLiteral = quoted((q) => Token.takeTill(q)).pipe(Parser.expected("system literal"))

/** `PubidChar ::= #x20 | #xD | #xA | [a-zA-Z0-9] | [-'()+,./:=?;!*#@$_%]` */
const pubidChars = (quote: "\"" | "'") => [
  " \r\n-()+,./:=?;!*#@$_%" + (quote === "\"" ? "'" : ""),
  Token.range("a", "z"),
  Token.range("A", "Z"),
  Token.range("0", "9"),
]

/** `PubidLiteral ::= '"' PubidChar* '"' | "'" (PubidChar - "'")* "'"` */
const PubidLiteral = quoted((q) => Token.takeWhile(pubidChars(q))).pipe(Parser.expected("public identifier"))

interface ExternalId {
  readonly publicId: string | null
  readonly systemId: string
}

/** `ExternalID ::= 'SYSTEM' S SystemLiteral | 'PUBLIC' S PubidLiteral S SystemLiteral` */
const ExternalID: Parser.Parser<ExternalId> = Parser.alt(
  keyword(
    "SYSTEM",
    Parser.preceded(S, SystemLiteral).pipe(Parser.map((systemId) => ({ publicId: null, systemId })))
  ),
  keyword(
    "PUBLIC",
    Parser.seq(Parser.preceded(S, PubidLiteral), Parser.preceded(S, SystemLiteral)).pipe(
      Parser.map(([publicId, systemId]) => ({ publicId, systemId }))
    )
  )
)

/**
 * `'[' intSubset ']' S?`. The lexer has already balanced the brackets, so the
 * subset is everything up to the final `]`; its markup declarations are kept
 * as text.
 */
const subsetEnd = Parser.seq(Token.literal("]"), S0, Parser.eof)
const InternalSubset = Parser.preceded(
  Token.literal("["),
  Parser.terminated(
    Parser.taken(Parser.repeat(Parser.preceded(Parser.not(subsetEnd), Token.any).pipe(Parser.expected("\"]\"")))),
    Parser.cut(subsetEnd)
  )
)

export interface DoctypeBody {
  readonly name: string
  readonly publicId: string | null
  readonly systemId: string | null
  readonly internalSubset: string | null
}

/**
 * The body of `<!…>`, from the keyword on:
 * `'DOCTYPE' S Name (S ExternalID)? S? ('[' intSubset ']' S?)?`
 */
export const doctype: Parser.Parser<DoctypeBody> = Parser.gen(function* () {
  yield* Token.literal("DOCTYPE")
  yield* S
  const name = yield* Parser.cut(Name.pipe(Parser.expected("document type name")))
  const externalId = yield* Parser.optional(Parser.preceded(S, ExternalID))
  yield* S0
  const subset = yield* Parser.optional(InternalSubset)
  return {
    name,
    publicId: externalId?.publicId ?? null,
    systemId: externalId?.systemId ?? null,
    internalSubset: subset === undefined ? null : subset.trim() || null,
  }
})

// -----------------------------------------------------------------------------
// Running
// -----------------------------------------------------------------------------

/** Why a body did not parse, relative to the start of the body. */
export interface DeclarationFailure {
  readonly offset: number
  readonly expected: string
  readonly found: string
}

/**
 * Parse a complete body, consuming all of it. The body's end is reported as
 * `closer` (the delimiter the lexer stripped, e.g. `?>`).
 */
export const run = <A>(
  grammar: Parser.Parser<A>,
  body: string,
  closer: string
): Result.Result<A, DeclarationFailure> =>
  Parser.parse(grammar, body).pipe(
    Result.mapError((error) => {
      const cp = body.codePointAt(error.offset)
      const end = JSON.stringify(closer)
      return {
        offset: error.offset,
        expected: error.expected.length > 0
          ? ParseError.formatExpected(error.expected.map((e) => (e === "end of input" ? end : e)))
          : (error.description ?? "valid syntax"),
        found: cp === undefined ? end : JSON.stringify(String.fromCodePoint(cp)),
      }
    })
  )
