/**
 * XML name productions (XML 1.0 §2.3, Namespaces in XML 1.0 §3), shared by
 * `Name.ts` (validation) and the declaration grammars.
 */
import { Parser, Token } from "@thomasfosterau/effect-parse"

/** `NameStartChar` without `:`. */
const ncNameStartChar = [
  Token.range("A", "Z"),
  "_",
  Token.range("a", "z"),
  Token.range("À", "Ö"),
  Token.range("Ø", "ö"),
  Token.range("ø", "˿"),
  Token.range("Ͱ", "ͽ"),
  Token.range("Ϳ", "῿"),
  Token.range("‌", "‍"),
  Token.range("⁰", "↏"),
  Token.range("Ⰰ", "⿯"),
  Token.range("、", "퟿"),
  Token.range("豈", "﷏"),
  Token.range("ﷰ", "�"),
  Token.range("\u{10000}", "\u{EFFFF}"),
]

/** `NameChar` without `:`. */
const ncNameChar = [
  ...ncNameStartChar,
  "-.·",
  Token.range("0", "9"),
  Token.range("̀", "ͯ"),
  Token.range("‿", "⁀"),
]

/** `NCName ::= Name - (Char* ':' Char*)` */
export const NCName: Parser.Parser<string> = Parser.compile(
  Parser.taken(Parser.seq(Token.oneOf(ncNameStartChar), Token.takeWhile(ncNameChar)))
)

/** `QName ::= PrefixedName | UnprefixedName`, i.e. `NCName (':' NCName)?` */
export const QName: Parser.Parser<string> = Parser.compile(
  Parser.taken(Parser.seq(NCName, Parser.optional(Parser.seq(Token.literal(":"), NCName))))
)

/** `Name ::= NameStartChar (NameChar)*` (XML 1.0 §2.3): colons anywhere, as in DTDs. */
export const Name: Parser.Parser<string> = Parser.compile(
  Parser.taken(Parser.seq(Token.oneOf([...ncNameStartChar, ":"]), Token.takeWhile([...ncNameChar, ":"])))
)
