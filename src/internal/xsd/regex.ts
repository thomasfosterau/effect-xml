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
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import { quote } from "../quote.ts";
import { isIn, tagSet } from "../tagSet.ts";

/** A code point as a `v`-mode escape. */
const escape = (c: string): string => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`;

/**
 * How the literal characters of a pattern are spelled in the translation:
 * as themselves, or, to match case-insensitively without the `i` flag, as
 * the class of their case variants.
 */
interface Spelling {
  /** A character outside a class. */
  readonly literal: (c: string) => string;
  /** A character inside a class. */
  readonly char: (c: string) => string;
  /** The range `from-to` inside a class. */
  readonly span: (from: string, to: string) => string;
}

const exactSpelling: Spelling = {
  literal: escape,
  char: escape,
  span: (from, to) => `${escape(from)}-${escape(to)}`,
};

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

/** A table of escape letters, to the text each stands for. */
interface EscapeTable {
  readonly [letter: string]: string;
}

const multiCharEscapes: EscapeTable = {
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

const singleCharEscapes: EscapeTable = { n: "\n", r: "\r", t: "\t" };

const categories = tagSet(
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
);

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

const blocks = R.fromEntries(blockList);

/** `\p{…}` (or, negated, `\P{…}`) for a category or `Is` block name. */
const property = (
  name: string,
  negated: boolean,
  known: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>,
): Option.Option<string> => {
  if (isIn(categories, name)) return Option.some(`\\${negated ? "P" : "p"}{${name}}`);
  if (!name.startsWith("Is")) return Option.none();
  return Option.map(R.get(known, name.slice(2)), (rs) => `[${negated ? "^" : ""}${ranges(rs)}]`);
};

const lit = Token.literal;

/** `\p{…}` and `\P{…}`, with these block names. */
const categoryEscapeOf = (
  known: Readonly<Record<string, ReadonlyArray<readonly [number, number]>>>,
): Parser.Parser<string> =>
  Parser.flatMap(
    Parser.seq(
      Parser.alt(lit("\\p{"), lit("\\P{")),
      Token.takeWhile((c: string) => c !== "}", { min: 1 }),
      lit("}"),
    ),
    ([open, name]) =>
      Option.match(property(name, open === "\\P{", known), {
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

const classEscape = Parser.alt(categoryEscapeOf(blocks), multiCharEscape);

/** A character that stands for itself outside a class. */
const normalChar = Parser.map(Token.noneOf(".\\?*+{}()|[]"), escape);

/**
 * `[…]`, `[^…]` and `[…-[…]]`, for a dialect's single-character escapes
 * (XPath adds `\$` to XML Schema's).
 */
const charClassOf = (
  singleEscape: Parser.Parser<string>,
  classEsc: Parser.Parser<string>,
  spelling: Spelling = exactSpelling,
): Parser.Parser<string> => {
  /** A single character inside a class (escaped or not), as the character itself. */
  const classChar = Parser.alt(singleEscape, Token.noneOf("[]\\-"));

  /** `a`, `a-z`, or a `-` that can only be a literal one. */
  const classRange: Parser.Parser<string> = Parser.flatMap(
    Parser.seq(
      classChar,
      Parser.opt(
        Parser.preceded(
          Parser.seq(lit("-"), Parser.not(lit("["))),
          Parser.alt(classChar, lit("-")),
        ),
      ),
    ),
    ([from, to]) =>
      Option.match(to, {
        onNone: () => Parser.succeed(spelling.char(from)),
        onSome: (end) =>
          (end.codePointAt(0) ?? 0) < (from.codePointAt(0) ?? 0)
            ? Parser.failMessage(`the range ${from}-${end} is backwards`)
            : Parser.succeed(spelling.span(from, end)),
      }),
  );

  /** A `-` at the start or end of a group stands for itself. */
  const literalDash = Parser.map(
    Parser.terminated(lit("-"), Parser.peek(Parser.alt(lit("]"), lit("-[")))),
    spelling.char,
  );

  const classItems: Parser.Parser<string> = Parser.map(
    Parser.seq(
      Parser.opt(Parser.map(lit("-"), spelling.char)),
      Parser.repeat(Parser.alt(classEsc, classRange, literalDash)),
    ),
    ([dash, items]) => Option.getOrElse(dash, () => "") + items.join(""),
  ).pipe(Parser.filter((items) => items !== ""));

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
  return charClassExpr;
};

/** `[…]`, `[^…]` and `[…-[…]]`. */
const charClassExpr = charClassOf(singleCharEscape, classEscape);

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

const quantityDigits = Token.takeWhile(Token.range("0", "9"), { min: 1 });

/** `{n}`, `{n,}` or `{n,m}`. */
const quantity: Parser.Parser<string> = Parser.flatMap(
  Parser.delimited(
    lit("{"),
    Parser.seq(quantityDigits, Parser.opt(Parser.preceded(lit(","), Parser.opt(quantityDigits)))),
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

// -----------------------------------------------------------------------------
// The XPath dialect (F&O 3.1 §5.6.1)
// -----------------------------------------------------------------------------

/**
 * A piece of a translated XPath regular expression: translated source, or a
 * construct whose translation depends on the flags or on the groups around
 * it, resolved once the whole expression is parsed.
 */
type Segment = Data.TaggedEnum<{
  Source: { readonly text: string };
  /** `.`, `^` or `$`, whose meaning the flags set. */
  Meta: { readonly char: "." | "^" | "$" };
  /** A capturing group's opening or closing parenthesis. */
  Group: { readonly open: boolean };
  BackRef: { readonly digits: string };
}>;

const Segment = Data.taggedEnum<Segment>();

const src = (text: string): Segment => Segment.Source({ text });

/** XPath's single-character escapes: XML Schema's and `\$`. */
const xpSingleCharEscape: Parser.Parser<string> = Parser.map(
  Parser.preceded(lit("\\"), Token.oneOf("nrt\\|.?*+(){}$-[]^")),
  (c) => singleCharEscapes[c] ?? c,
);

/**
 * Block names XPath takes beyond XML Schema 1.0's: blocks added or renamed
 * in later versions of Unicode, as later XML Schema versions allow.
 */
const laterBlocks: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]>]> = [
  ["GreekandCoptic", [[0x370, 0x3ff]]],
  ["CombiningDiacriticalMarksforSymbols", [[0x20d0, 0x20ff]]],
  ["PrivateUseArea", [[0xe000, 0xf8ff]]],
  ["SupplementaryPrivateUseArea-A", [[0xf0000, 0xfffff]]],
  ["SupplementaryPrivateUseArea-B", [[0x100000, 0x10ffff]]],
  ["Specials", [[0xfff0, 0xffff]]],
  ["Emoticons", [[0x1f600, 0x1f64f]]],
  ["CyrillicSupplement", [[0x500, 0x52f]]],
  ["PhoneticExtensions", [[0x1d00, 0x1d7f]]],
  ["MiscellaneousSymbolsandArrows", [[0x2b00, 0x2bff]]],
  ["MiscellaneousSymbolsandPictographs", [[0x1f300, 0x1f5ff]]],
  ["TransportandMapSymbols", [[0x1f680, 0x1f6ff]]],
  ["SupplementalArrows-A", [[0x27f0, 0x27ff]]],
  ["SupplementalArrows-B", [[0x2900, 0x297f]]],
  ["SupplementalMathematicalOperators", [[0x2a00, 0x2aff]]],
  ["HighSurrogates", [[0xd800, 0xdb7f]]],
  ["LowSurrogates", [[0xdc00, 0xdfff]]],
];

const xpBlocks = R.fromEntries([...blockList, ...laterBlocks]);

const xpClassEscape = Parser.alt(categoryEscapeOf(xpBlocks), multiCharEscape);

/** `\1` … `\99`: a back-reference, its digits resolved against the groups closed before it. */
const backReference: Parser.Parser<Segment> = Parser.map(
  Parser.preceded(
    lit("\\"),
    Parser.seq(Token.oneOf("123456789"), Token.takeWhile(Token.range("0", "9"))),
  ),
  ([first, rest]) => Segment.BackRef({ digits: first + rest }),
);

/**
 * The case variants of the characters that have any: a character is a
 * variant of another when their lower-case or their upper-case forms are
 * equal (F&O 3.1 §5.6.1). Built on first use.
 */
interface CaseVariants {
  /** The code points with a case variant, ascending. */
  readonly cased: ReadonlyArray<number>;
  /** The code points each of `cased` is a variant of (itself included), by code point. */
  readonly of: Readonly<Record<string, ReadonlyArray<number>>>;
}

let caseVariants: CaseVariants | undefined;

interface Cased {
  readonly cp: number;
  readonly lower: string;
  readonly upper: string;
}

const codePoints = (group: ReadonlyArray<Cased> | undefined): ReadonlyArray<number> =>
  Arr.map(group ?? [], (f) => f.cp);

const variantsTable = (): CaseVariants => {
  if (caseVariants !== undefined) return caseVariants;
  // Every cased character is below U+1F000; the surrogates stand for nothing.
  const forms = Arr.filterMap(Arr.range(0, 0x1efff), (cp): Result.Result<Cased, void> => {
    if (cp >= 0xd800 && cp <= 0xdfff) return Result.failVoid;
    const c = String.fromCodePoint(cp);
    const lower = c.toLowerCase();
    const upper = c.toUpperCase();
    return lower === c && upper === c ? Result.failVoid : Result.succeed({ cp, lower, upper });
  });
  const byLower = Arr.groupBy(forms, (f) => f.lower);
  const byUpper = Arr.groupBy(forms, (f) => f.upper);
  caseVariants = {
    cased: Arr.map(forms, (f) => f.cp),
    of: R.fromEntries(
      Arr.map(forms, (f) => [
        String(f.cp),
        Arr.dedupe([...codePoints(byLower[f.lower]), ...codePoints(byUpper[f.upper])]),
      ]),
    ),
  };
  return caseVariants;
};

/** A code point and its case variants, as the escapes of a class's body. */
const variantEscapes = (cp: number): string => {
  const variants = variantsTable().of[cp] ?? [cp];
  return variants.map((v) => `\\u{${v.toString(16)}}`).join("");
};

/**
 * Case-insensitive matching spelt out: each literal is the class of its case
 * variants, and a range adds the variants of the characters in it. Category
 * escapes stay as they are, which `\p{Lu}` needs (the `i` flag of a `v`-mode
 * `RegExp` folds them: `m` would match it).
 */
const caselessSpelling: Spelling = {
  literal: (c) => {
    const cp = c.codePointAt(0) ?? 0;
    return (variantsTable().of[cp]?.length ?? 1) > 1 ? `[${variantEscapes(cp)}]` : escape(c);
  },
  char: (c) => variantEscapes(c.codePointAt(0) ?? 0),
  span: (from, to) => {
    const lo = from.codePointAt(0) ?? 0;
    const hi = to.codePointAt(0) ?? 0;
    return (
      exactSpelling.span(from, to) +
      variantsTable()
        .cased.filter((cp) => cp >= lo && cp <= hi)
        .map(variantEscapes)
        .join("")
    );
  },
};

/** The XPath dialect's grammar, spelling literal characters as `spelling` says. */
const xpathDialect = (spelling: Spelling): Parser.Parser<ReadonlyArray<Segment>> => {
  const xpCharClassExpr = charClassOf(xpSingleCharEscape, xpClassEscape, spelling);

  const xpAtom: Parser.Parser<ReadonlyArray<Segment>> = Parser.alt(
    Parser.map(Token.noneOf(".\\?*+{}()|[]^$"), (c) => [src(spelling.literal(c))]),
    Parser.map(Token.oneOf(".^$"), (c) => [
      Segment.Meta({ char: c === "." ? "." : c === "^" ? "^" : "$" }),
    ]),
    Parser.map(xpClassEscape, (c) => [src(c)]),
    Parser.map(backReference, (b) => [b]),
    Parser.map(xpSingleCharEscape, (c) => [src(spelling.literal(c))]),
    Parser.map(xpCharClassExpr, (c) => [src(c)]),
    Parser.map(
      Parser.delimited(
        lit("(?:"),
        Parser.suspend(() => xpRegExp),
        lit(")"),
      ),
      (inner): ReadonlyArray<Segment> => [src("(?:"), ...inner, src(")")],
    ),
    Parser.map(
      Parser.delimited(
        lit("("),
        Parser.suspend(() => xpRegExp),
        lit(")"),
      ),
      (inner): ReadonlyArray<Segment> => [
        Segment.Group({ open: true }),
        ...inner,
        Segment.Group({ open: false }),
      ],
    ),
  );

  /** An atom and its quantifier, which may be reluctant (`*?`, `{2,3}?`). */
  const xpPiece: Parser.Parser<ReadonlyArray<Segment>> = Parser.map(
    Parser.seq(
      xpAtom,
      Parser.opt(Parser.seq(Parser.alt(Token.oneOf("?*+"), quantity), Parser.opt(lit("?")))),
    ),
    ([a, q]) =>
      Option.match(q, {
        onNone: () => a,
        onSome: ([quantifier, reluctant]) => [
          src("(?:"),
          ...a,
          src(")"),
          src(quantifier + Option.getOrElse(reluctant, () => "")),
        ],
      }),
  );

  const xpRegExp: Parser.Parser<ReadonlyArray<Segment>> = Parser.map(
    Parser.separated(
      Parser.map(Parser.repeat(xpPiece), (ps) => ps.flat()),
      lit("|"),
    ),
    (branches) => branches.flatMap((b, i) => (i === 0 ? b : [src("|"), ...b])),
  );
  return xpRegExp;
};

const xpExact = xpathDialect(exactSpelling);

const xpCaseless = xpathDialect(caselessSpelling);

/** The categories the `i` flag of a `v`-mode `RegExp` would get wrong: those that case folding doesn't preserve. */
const casedCategory = /\\[pP]\{L[ult]\}/;

/** How an XPath regular expression is read: the `s`, `m` and `q` flags. */
export interface XPathRegexOptions {
  /** `s`: `.` matches every character, newlines included. */
  readonly dotAll: boolean;
  /** `m`: `^` and `$` match at the start and end of every line. */
  readonly multiline: boolean;
  /** `q`: every character of the pattern stands for itself. */
  readonly literal: boolean;
  /** `i`: matching ignores case. */
  readonly caseless?: boolean;
}

/** An XPath regular expression translated to the source of a `v`-flag `RegExp` (unanchored). */
export interface XPathRegex {
  readonly source: string;
  /** How many capturing groups it has. */
  readonly groups: number;
  /** The group each group is nested in, by group number (`0` for none): `parents[n - 1]` is group `n`'s. */
  readonly parents: ReadonlyArray<number>;
  /**
   * Whether the source already matches case-insensitively, so the `RegExp`
   * is not to take the `i` flag. A pattern with `\p{Lu}`, `\p{Ll}` or
   * `\p{Lt}` is translated so, its back-references then matching exactly.
   */
  readonly spelledCaseless: boolean;
}

interface Resolved {
  readonly out: ReadonlyArray<string>;
  readonly opened: number;
  /** Groups opened and not yet closed, innermost last. */
  readonly stack: ReadonlyArray<number>;
  /** The groups closed so far. */
  readonly closed: ReadonlyArray<number>;
  readonly parents: ReadonlyArray<number>;
}

/**
 * The group a back-reference's digits name (as many digits as still name a
 * group opened before it) and the digits left over, which stand for
 * themselves; the group must be closed before the back-reference.
 */
const backReferenceTo = (
  digits: string,
  state: Resolved,
): Result.Result<readonly [number, string], string> => {
  const k = Option.getOrElse(
    Arr.findLast(Arr.range(1, digits.length), (n) => Number(digits.slice(0, n)) <= state.opened),
    () => 1,
  );
  const group = Number(digits.slice(0, k));
  return state.closed.includes(group)
    ? Result.succeed([group, digits.slice(k)] as const)
    : Result.fail(`the back-reference \\${group} is not to a group closed before it`);
};

const resolveSegment = (
  state: Resolved,
  segment: Segment,
  options: XPathRegexOptions,
): Result.Result<Resolved, string> => {
  const emit = (text: string) => Result.succeed({ ...state, out: [...state.out, text] });
  const innermost = Option.getOrElse(Arr.last(state.stack), () => 0);
  return Segment.$match(segment, {
    Source: ({ text }) => emit(text),
    Meta: ({ char }) =>
      emit(
        char === "."
          ? options.dotAll
            ? "[^]"
            : "[^\\u{a}\\u{d}]"
          : char === "^"
            ? // As in Java: at the start, and after every newline but a final one.
              options.multiline
              ? "(?:^|(?<=\\u{a})(?!$))"
              : "^"
            : options.multiline
              ? "(?=$|\\u{a})"
              : "$",
      ),
    Group: ({ open }) => {
      if (!open)
        return Result.succeed({
          ...state,
          out: [...state.out, ")"],
          stack: state.stack.slice(0, -1),
          closed: [...state.closed, innermost],
        });
      const n = state.opened + 1;
      return Result.succeed({
        out: [...state.out, "("],
        opened: n,
        stack: [...state.stack, n],
        closed: state.closed,
        parents: [...state.parents, innermost],
      });
    },
    BackRef: ({ digits }) =>
      Result.map(backReferenceTo(digits, state), ([n, rest]) => ({
        ...state,
        out: [...state.out, `(?:\\${n})`, ...Arr.map(Arr.fromIterable(rest), escape)],
      })),
  });
};

const initialResolved: Result.Result<Resolved, string> = Result.succeed({
  out: [],
  opened: 0,
  stack: [],
  closed: [],
  parents: [],
});

/** Whitespace outside character classes, which the `x` flag removes. */
const extendedWhitespace = /\\[^\t\n\r ]|\[(?:\\[^]|\[(?:\\[^]|[^\\\]])*\]|[^\\\]])*\]|[\t\n\r ]+/g;

/** A pattern with the `x` flag's whitespace removed: all of it outside character classes. */
export const stripWhitespace = (pattern: string): string =>
  pattern.replace(extendedWhitespace, (m) => (/^[\t\n\r ]/.test(m) ? "" : m));

/**
 * The `RegExp` source an XPath 3.1 regular expression denotes, with the
 * number and nesting of its capturing groups, or why the pattern isn't a
 * valid XPath regular expression. The source is for the `v` flag, and
 * matches anywhere in a string (it is not anchored).
 */
export const translateXPath = (
  pattern: string,
  options: XPathRegexOptions,
): Result.Result<XPathRegex, string> => {
  if (options.literal)
    return Result.succeed({
      source: Arr.map(Arr.fromIterable(pattern), escape).join(""),
      groups: 0,
      parents: [],
      spelledCaseless: false,
    });
  const spelt = options.caseless === true && casedCategory.test(pattern);
  return Result.match(Parser.parse(spelt ? xpCaseless : xpExact, pattern), {
    onFailure: (error) => Result.fail(`invalid pattern ${quote(pattern)}: ${error.message}`),
    onSuccess: (segments) =>
      Result.map(
        Arr.reduce(segments, initialResolved, (acc, segment) =>
          Result.flatMap(acc, (state) => resolveSegment(state, segment, options)),
        ),
        (state) => ({
          source: state.out.join(""),
          groups: state.opened,
          parents: state.parents,
          spelledCaseless: spelt,
        }),
      ),
  });
};
