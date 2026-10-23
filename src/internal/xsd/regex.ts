/**
 * XML Schema regular expressions (XSD 1.0 Part 2, Appendix F), translated to
 * JavaScript `RegExp`s.
 *
 * The dialects differ in ways that matter: an XSD pattern is implicitly
 * anchored, `^` and `$` are ordinary characters, character classes can be
 * subtracted (`[a-z-[aeiou]]`), and there are escapes for XML name characters
 * (`\i`, `\c`) and Unicode blocks (`\p{IsGreek}`). The translation targets the
 * `v` flag, whose nested classes and `--` subtraction say all of that
 * directly; every literal character is written as a `\u{…}` escape so no
 * character can be read as syntax.
 */
import { Parser, Token } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { quote } from "../quote.ts";

/** A code point as a `v`-mode escape. */
const escape = (c: string): string => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`;

/** A class of code point ranges, `[from, to]` inclusive. */
const ranges = (rs: ReadonlyArray<readonly [number, number]>): string =>
  Arr.map(rs, ([from, to]) =>
    from === to ? `\\u{${from.toString(16)}}` : `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`,
  ).join("");

/** XML 1.0 `NameStartChar` (with `:`), as the body of a class. */
const nameStartChars = ranges([
  [0x3a, 0x3a],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
  [0xc0, 0xd6],
  [0xd8, 0xf6],
  [0xf8, 0x2ff],
  [0x370, 0x37d],
  [0x37f, 0x1fff],
  [0x200c, 0x200d],
  [0x2070, 0x218f],
  [0x2c00, 0x2fef],
  [0x3001, 0xd7ff],
  [0xf900, 0xfdcf],
  [0xfdf0, 0xfffd],
  [0x10000, 0xeffff],
]);

/** XML 1.0 `NameChar`, as the body of a class. */
const nameChars =
  nameStartChars +
  ranges([
    [0x2d, 0x2e],
    [0x30, 0x39],
    [0xb7, 0xb7],
    [0x300, 0x36f],
    [0x203f, 0x2040],
  ]);

const multiCharEscapes: Readonly<Record<string, string>> = {
  s: "[\\u{20}\\u{9}\\u{a}\\u{d}]",
  S: "[^\\u{20}\\u{9}\\u{a}\\u{d}]",
  i: `[${nameStartChars}]`,
  I: `[^${nameStartChars}]`,
  c: `[${nameChars}]`,
  C: `[^${nameChars}]`,
  d: "\\p{Nd}",
  D: "\\P{Nd}",
  w: "[^\\p{P}\\p{Z}\\p{C}]",
  W: "[\\p{P}\\p{Z}\\p{C}]",
};

const singleCharEscapes: Readonly<Record<string, string>> = { n: "\n", r: "\r", t: "\t" };

const categories: ReadonlyArray<string> = [
  "L",
  "Lu",
  "Ll",
  "Lt",
  "Lm",
  "Lo",
  "M",
  "Mn",
  "Mc",
  "Me",
  "N",
  "Nd",
  "Nl",
  "No",
  "P",
  "Pc",
  "Pd",
  "Ps",
  "Pe",
  "Pi",
  "Pf",
  "Po",
  "Z",
  "Zs",
  "Zl",
  "Zp",
  "S",
  "Sm",
  "Sc",
  "Sk",
  "So",
  "C",
  "Cc",
  "Cf",
  "Co",
  "Cn",
];

/** The block escapes of XSD 1.0 (`\p{IsBasicLatin}`), as code point ranges. */
const blockList: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]>]> = [
  ["BasicLatin", [[0x0, 0x7f]]],
  ["Latin-1Supplement", [[0x80, 0xff]]],
  ["LatinExtended-A", [[0x100, 0x17f]]],
  ["LatinExtended-B", [[0x180, 0x24f]]],
  ["IPAExtensions", [[0x250, 0x2af]]],
  ["SpacingModifierLetters", [[0x2b0, 0x2ff]]],
  ["CombiningDiacriticalMarks", [[0x300, 0x36f]]],
  ["Greek", [[0x370, 0x3ff]]],
  ["Cyrillic", [[0x400, 0x4ff]]],
  ["Armenian", [[0x530, 0x58f]]],
  ["Hebrew", [[0x590, 0x5ff]]],
  ["Arabic", [[0x600, 0x6ff]]],
  ["Syriac", [[0x700, 0x74f]]],
  ["Thaana", [[0x780, 0x7bf]]],
  ["Devanagari", [[0x900, 0x97f]]],
  ["Bengali", [[0x980, 0x9ff]]],
  ["Gurmukhi", [[0xa00, 0xa7f]]],
  ["Gujarati", [[0xa80, 0xaff]]],
  ["Oriya", [[0xb00, 0xb7f]]],
  ["Tamil", [[0xb80, 0xbff]]],
  ["Telugu", [[0xc00, 0xc7f]]],
  ["Kannada", [[0xc80, 0xcff]]],
  ["Malayalam", [[0xd00, 0xd7f]]],
  ["Sinhala", [[0xd80, 0xdff]]],
  ["Thai", [[0xe00, 0xe7f]]],
  ["Lao", [[0xe80, 0xeff]]],
  ["Tibetan", [[0xf00, 0xfff]]],
  ["Myanmar", [[0x1000, 0x109f]]],
  ["Georgian", [[0x10a0, 0x10ff]]],
  ["HangulJamo", [[0x1100, 0x11ff]]],
  ["Ethiopic", [[0x1200, 0x137f]]],
  ["Cherokee", [[0x13a0, 0x13ff]]],
  ["UnifiedCanadianAboriginalSyllabics", [[0x1400, 0x167f]]],
  ["Ogham", [[0x1680, 0x169f]]],
  ["Runic", [[0x16a0, 0x16ff]]],
  ["Khmer", [[0x1780, 0x17ff]]],
  ["Mongolian", [[0x1800, 0x18af]]],
  ["LatinExtendedAdditional", [[0x1e00, 0x1eff]]],
  ["GreekExtended", [[0x1f00, 0x1fff]]],
  ["GeneralPunctuation", [[0x2000, 0x206f]]],
  ["SuperscriptsandSubscripts", [[0x2070, 0x209f]]],
  ["CurrencySymbols", [[0x20a0, 0x20cf]]],
  ["CombiningMarksforSymbols", [[0x20d0, 0x20ff]]],
  ["LetterlikeSymbols", [[0x2100, 0x214f]]],
  ["NumberForms", [[0x2150, 0x218f]]],
  ["Arrows", [[0x2190, 0x21ff]]],
  ["MathematicalOperators", [[0x2200, 0x22ff]]],
  ["MiscellaneousTechnical", [[0x2300, 0x23ff]]],
  ["ControlPictures", [[0x2400, 0x243f]]],
  ["OpticalCharacterRecognition", [[0x2440, 0x245f]]],
  ["EnclosedAlphanumerics", [[0x2460, 0x24ff]]],
  ["BoxDrawing", [[0x2500, 0x257f]]],
  ["BlockElements", [[0x2580, 0x259f]]],
  ["GeometricShapes", [[0x25a0, 0x25ff]]],
  ["MiscellaneousSymbols", [[0x2600, 0x26ff]]],
  ["Dingbats", [[0x2700, 0x27bf]]],
  ["BraillePatterns", [[0x2800, 0x28ff]]],
  ["CJKRadicalsSupplement", [[0x2e80, 0x2eff]]],
  ["KangxiRadicals", [[0x2f00, 0x2fdf]]],
  ["IdeographicDescriptionCharacters", [[0x2ff0, 0x2fff]]],
  ["CJKSymbolsandPunctuation", [[0x3000, 0x303f]]],
  ["Hiragana", [[0x3040, 0x309f]]],
  ["Katakana", [[0x30a0, 0x30ff]]],
  ["Bopomofo", [[0x3100, 0x312f]]],
  ["HangulCompatibilityJamo", [[0x3130, 0x318f]]],
  ["Kanbun", [[0x3190, 0x319f]]],
  ["BopomofoExtended", [[0x31a0, 0x31bf]]],
  ["EnclosedCJKLettersandMonths", [[0x3200, 0x32ff]]],
  ["CJKCompatibility", [[0x3300, 0x33ff]]],
  ["CJKUnifiedIdeographsExtensionA", [[0x3400, 0x4db5]]],
  ["CJKUnifiedIdeographs", [[0x4e00, 0x9fff]]],
  ["YiSyllables", [[0xa000, 0xa48f]]],
  ["YiRadicals", [[0xa490, 0xa4cf]]],
  ["HangulSyllables", [[0xac00, 0xd7a3]]],
  ["CJKCompatibilityIdeographs", [[0xf900, 0xfaff]]],
  ["AlphabeticPresentationForms", [[0xfb00, 0xfb4f]]],
  ["ArabicPresentationForms-A", [[0xfb50, 0xfdff]]],
  ["CombiningHalfMarks", [[0xfe20, 0xfe2f]]],
  ["CJKCompatibilityForms", [[0xfe30, 0xfe4f]]],
  ["SmallFormVariants", [[0xfe50, 0xfe6f]]],
  ["ArabicPresentationForms-B", [[0xfe70, 0xfefe]]],
  ["HalfwidthandFullwidthForms", [[0xff00, 0xffef]]],
  ["OldItalic", [[0x10300, 0x1032f]]],
  ["Gothic", [[0x10330, 0x1034f]]],
  ["Deseret", [[0x10400, 0x1044f]]],
  ["ByzantineMusicalSymbols", [[0x1d000, 0x1d0ff]]],
  ["MusicalSymbols", [[0x1d100, 0x1d1ff]]],
  ["MathematicalAlphanumericSymbols", [[0x1d400, 0x1d7ff]]],
  ["CJKUnifiedIdeographsExtensionB", [[0x20000, 0x2a6d6]]],
  ["CJKCompatibilityIdeographsSupplement", [[0x2f800, 0x2fa1f]]],
  ["Tags", [[0xe0000, 0xe007f]]],
];

const blocks = Record.fromEntries(blockList);

/** `\p{…}` (or, negated, `\P{…}`) for a category or `Is` block name. */
const property = (name: string, negated: boolean): Option.Option<string> => {
  if (categories.includes(name)) return Option.some(`\\${negated ? "P" : "p"}{${name}}`);
  if (!name.startsWith("Is")) return Option.none();
  return Option.map(
    Record.get(blocks, name.slice(2)),
    (rs) => `[${negated ? "^" : ""}${ranges(rs)}]`,
  );
};

const lit = Token.literal;

/** `\p{…}` and `\P{…}`. */
const categoryEscape: Parser.Parser<string> = Parser.flatMap(
  Parser.seq(
    Parser.alt(lit("\\p{"), lit("\\P{")),
    Token.takeWhile((c: string) => c !== "}", { min: 1 }),
    lit("}"),
  ),
  ([open, name]) =>
    Option.match(property(name, open === "\\P{"), {
      onNone: () => Parser.failMessage(`unknown character property \\p{${name}}`),
      onSome: (out) => Parser.succeed(out),
    }),
);

/** `\s`, `\i`, `\d`, …: a class written as a whole class or escape. */
const multiCharEscape: Parser.Parser<string> = Parser.map(
  Parser.preceded(lit("\\"), Token.oneOf("sSiIcCdDwW")),
  (c) => multiCharEscapes[c] ?? "",
);

/** An escaped single character, as the character itself. */
const singleCharEscape: Parser.Parser<string> = Parser.map(
  Parser.preceded(lit("\\"), Token.oneOf("nrt\\|.?*+(){}-[]^")),
  (c) => singleCharEscapes[c] ?? c,
);

const classEscape = Parser.alt(categoryEscape, multiCharEscape);

/** A character that stands for itself outside a class. */
const normalChar = Parser.map(Token.noneOf(".\\?*+{}()|[]"), escape);

/** A single character inside a class (escaped or not), as the character itself. */
const classChar = Parser.alt(singleCharEscape, Token.noneOf("[]\\-"));

/** `a`, `a-z`, or a `-` that can only be a literal one. */
const classRange: Parser.Parser<string> = Parser.flatMap(
  Parser.seq(
    classChar,
    Parser.opt(
      Parser.preceded(Parser.seq(lit("-"), Parser.not(lit("["))), Parser.alt(classChar, lit("-"))),
    ),
  ),
  ([from, to]) =>
    Option.match(to, {
      onNone: () => Parser.succeed(escape(from)),
      onSome: (end) =>
        (end.codePointAt(0) ?? 0) < (from.codePointAt(0) ?? 0)
          ? Parser.failMessage(`the range ${from}-${end} is backwards`)
          : Parser.succeed(`${escape(from)}-${escape(end)}`),
    }),
);

/** A `-` at the start or end of a group stands for itself. */
const literalDash = Parser.map(
  Parser.terminated(lit("-"), Parser.peek(Parser.alt(lit("]"), lit("-[")))),
  escape,
);

const classItems: Parser.Parser<string> = Parser.map(
  Parser.seq(
    Parser.opt(Parser.map(lit("-"), escape)),
    Parser.repeat(Parser.alt(classEscape, classRange, literalDash), { min: 1 }),
  ),
  ([dash, items]) => Option.getOrElse(dash, () => "") + items.join(""),
);

/** `[…]`, `[^…]` and `[…-[…]]`. */
const charClassExpr: Parser.Parser<string> = Parser.map(
  Parser.delimited(
    lit("["),
    Parser.seq(
      Parser.opt(lit("^")),
      classItems,
      Parser.opt(
        Parser.preceded(
          lit("-"),
          Parser.suspend(() => charClassExpr),
        ),
      ),
    ),
    lit("]"),
  ),
  ([negated, items, subtracted]) => {
    const base = `[${Option.isSome(negated) ? "^" : ""}${items}]`;
    return Option.match(subtracted, {
      onNone: () => base,
      onSome: (sub) => `[${base}--${sub}]`,
    });
  },
);

const atom: Parser.Parser<string> = Parser.alt(
  normalChar,
  Parser.map(lit("."), () => "[^\\u{a}\\u{d}]"),
  classEscape,
  Parser.map(singleCharEscape, escape),
  charClassExpr,
  Parser.map(
    Parser.delimited(
      lit("("),
      Parser.suspend(() => regExp),
      lit(")"),
    ),
    (inner) => `(?:${inner})`,
  ),
);

const digits = Token.takeWhile(Token.range("0", "9"), { min: 1 });

/** `{n}`, `{n,}` or `{n,m}`. */
const quantity: Parser.Parser<string> = Parser.flatMap(
  Parser.delimited(
    lit("{"),
    Parser.seq(digits, Parser.opt(Parser.preceded(lit(","), Parser.opt(digits)))),
    lit("}"),
  ),
  ([min, rest]) =>
    Option.match(rest, {
      onNone: () => Parser.succeed(`{${min}}`),
      onSome: (max) =>
        Option.match(max, {
          onNone: () => Parser.succeed(`{${min},}`),
          onSome: (m) =>
            Number(m) < Number(min)
              ? Parser.failMessage(`the quantity {${min},${m}} is backwards`)
              : Parser.succeed(`{${min},${m}}`),
        }),
    }),
);

const piece = Parser.map(
  Parser.seq(atom, Parser.opt(Parser.alt(Token.oneOf("?*+"), quantity))),
  ([a, q]) => a + Option.getOrElse(q, () => ""),
);

const branch = Parser.map(Parser.repeat(piece), (ps) => ps.join(""));

const regExp: Parser.Parser<string> = Parser.map(Parser.separated(branch, lit("|")), (bs) =>
  bs.join("|"),
);

/**
 * The `RegExp` an XSD pattern denotes (matching whole strings), or why the
 * pattern isn't a valid XSD regular expression.
 */
export const translate = (pattern: string): Result.Result<RegExp, string> =>
  Result.match(Parser.parse(regExp, pattern), {
    onFailure: (error) => Result.fail(`invalid pattern ${quote(pattern)}: ${error.message}`),
    onSuccess: (source) => Result.succeed(new RegExp(`^(?:${source})$`, "v")),
  });
