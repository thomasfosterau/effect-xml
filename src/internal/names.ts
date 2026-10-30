/**
 * XML name productions (XML 1.0 §2.3, Namespaces in XML 1.0 §3), shared by
 * `Name.ts` (validation) and the declaration grammars.
 */
import { Compiler, Parser, Token } from "@thomasfosterau/effect-parse";

/** `NameStartChar` without `:`. */
export const ncNameStartChar = [
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
];

/** `NameChar` without `:`. */
export const ncNameChar = [
  ...ncNameStartChar,
  "-.·",
  Token.range("0", "9"),
  Token.range("̀", "ͯ"),
  Token.range("‿", "⁀"),
];

/** `NCName ::= Name - (Char* ':' Char*)` */
export const NCName: Parser.Parser<string> = Compiler.jit(
  Parser.taken(Parser.seq(Token.oneOf(ncNameStartChar), Token.takeWhile(ncNameChar))),
);

/** `QName ::= PrefixedName | UnprefixedName`, i.e. `NCName (':' NCName)?` */
export const QNameGrammar: Parser.Parser<string> = Compiler.jit(
  Parser.taken(Parser.seq(NCName, Parser.optional(Parser.seq(Token.literal(":"), NCName)))),
);

/** `Name ::= NameStartChar (NameChar)*` (XML 1.0 §2.3): colons anywhere, as in DTDs. */
export const Name: Parser.Parser<string> = Compiler.jit(
  Parser.taken(
    Parser.seq(Token.oneOf([...ncNameStartChar, ":"]), Token.takeWhile([...ncNameChar, ":"])),
  ),
);

/** `Nmtoken ::= (NameChar)+` (XML 1.0 §2.3). */
export const Nmtoken: Parser.Parser<string> = Compiler.jit(
  Token.takeWhile([...ncNameChar, ":"], { min: 1 }),
);

// The same productions as regular expressions, for checking a name the lexer
// has already delimited: one `test` per name on the hot path.

/** `NameStartChar` (XML 1.0 §2.3), as a character class body. */
const nameStartClass =
  "A-Z_a-z:\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C\u200D" +
  "\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\u{10000}-\u{EFFFF}";

/** `NameChar` (XML 1.0 §2.3), as a character class body. */
const nameCharClass = `${nameStartClass}\\-.0-9\u00B7\u0300-\u036F\u203F\u2040`;

const nameRegExp = new RegExp(`^[${nameStartClass}][${nameCharClass}]*$`, "u");
/** An ASCII `Name`: the ASCII part of the productions above. */
const asciiNameRegExp = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;
const nameStartRegExp = new RegExp(`^[${nameStartClass}]`, "u");
const notNameCharRegExp = new RegExp(`[^${nameCharClass}]`, "u");

const ncNameStartRegExp = new RegExp(`^[${nameStartClass.replace(":", "")}]`, "u");

/**
 * Whether an XML `Name` is also a `QName` (Namespaces in XML 1.0 §3): no
 * colon, or one colon between two `NCName`s. `name` must already be a Name,
 * so only the colon's place and the character after it are checked.
 */
export const isQName = (name: string): boolean => {
  const colon = name.indexOf(":");
  return (
    colon === -1 ||
    (colon > 0 &&
      name.indexOf(":", colon + 1) === -1 &&
      ncNameStartRegExp.test(name.slice(colon + 1)))
  );
};

/**
 * Where `s` stops being an XML `Name` (colons allowed anywhere): the index of
 * the first character not allowed where it is, or -1 when `s` is a Name.
 */
export const invalidNameAt = (s: string): number => {
  // Nearly every name is ASCII, which a plain class checks faster than the
  // full productions with the `u` flag.
  if (asciiNameRegExp.test(s) || nameRegExp.test(s)) return -1;
  if (!nameStartRegExp.test(s)) return 0;
  // The first character is a name start; one beyond the BMP takes two units.
  const first = s.codePointAt(0) ?? 0;
  const rest = first > 0xffff ? 2 : 1;
  const at = s.slice(rest).search(notNameCharRegExp);
  return at === -1 ? -1 : rest + at;
};
