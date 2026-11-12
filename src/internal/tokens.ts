/**
 * Token grammars for the lexer.
 *
 * Each grammar reads one token at the lexer's cursor: a run of text, a tag, a
 * comment, and so on. Which grammar applies depends on the tokenizer state
 * the lexer is in (ordinary data, or the raw text of `<script>`, `<style>`,
 * `<title>`… in HTML), and on the mode:
 *
 * - XML is strict. Where the input breaks the rules the grammar fails with a
 *   cut, carrying an {@link Issue} (or, inside a declaration, the
 *   declaration's context label), and the lexer reports it as a typed error.
 * - HTML recovers, following WHATWG tokenization: every input yields tokens.
 * - XML with `recover: true` reads what strict XML reads exactly as strict XML
 *   does, and recovers where strict XML fails at a `<` or `&` that starts
 *   nothing, or an attribute HTML would read (XML5, after xml5ever): see
 *   {@link recoverText} and {@link recoverStartTag}.
 *
 * The grammars also run on partial input (`State.partial`), where running
 * into the end of the buffer means "Incomplete"; that is what keeps the
 * lexer chunk-boundary safe. In complete mode the HTML grammars have
 * fallbacks for constructs that end at EOF.
 *
 * Positions in tokens are offsets into the lexer's buffer; the lexer turns
 * them into line/column {@link Position}s.
 */
import { Ascii, Compiler, Parser, Token } from "@thomasfosterau/effect-parse";
import * as Data from "effect/Data";
import { identity } from "effect/Function";
import * as Result from "effect/Result";
import { doctype as xmlDoctype, processingInstruction } from "./declarations.ts";
import { decode, htmlLegacyEntities, type EntityLimit, type EntityTable } from "./entities.ts";
import { DtdSlot } from "./dtd.ts";
import { invalidNameAt } from "./names.ts";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";

// -----------------------------------------------------------------------------
// Tokens
// -----------------------------------------------------------------------------

interface TokAttribute {
  readonly name: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

interface Offsets {
  readonly start: number;
  readonly end: number;
}

export type Tok =
  | ({ readonly _tag: "Text"; readonly data: string } & Offsets)
  | ({
      readonly _tag: "StartElement";
      readonly name: string;
      readonly attributes: ReadonlyArray<TokAttribute>;
      readonly selfClosing: boolean;
    } & Offsets)
  | ({ readonly _tag: "EndElement"; readonly name: string } & Offsets)
  | ({ readonly _tag: "Comment"; readonly data: string } & Offsets)
  | ({ readonly _tag: "CData"; readonly data: string } & Offsets)
  | ({
      readonly _tag: "ProcessingInstruction";
      readonly target: string;
      readonly data: string;
    } & Offsets)
  | ({
      readonly _tag: "Doctype";
      readonly name: string;
      readonly publicId: string | null;
      readonly systemId: string | null;
      readonly internalSubset: string | null;
      readonly forceQuirks: boolean;
    } & Offsets)
  | ({
      readonly _tag: "XmlDeclaration";
      readonly version: string;
      readonly encoding: string | null;
      readonly standalone: boolean | null;
    } & Offsets)
  /** A reference to a DTD entity whose replacement text contains markup (expanded by the SAX layer). */
  | ({ readonly _tag: "EntityReference"; readonly name: string } & Offsets);

/** Why a strict (XML) grammar rejected its input. */
export type Issue =
  | { readonly _tag: "Char"; readonly context: string; readonly offset: number }
  | {
      readonly _tag: "Entity";
      readonly reference: string;
      readonly reason: string;
      readonly offset: number;
      readonly limit?: EntityLimit | undefined;
    };

/** Guards for {@link Issue}. */
export const Issue = Data.taggedEnum<Issue>();

/** What one step of the lexer produces: tokens, possibly none (input dropped at EOF). */
export type Step = ReadonlyArray<Tok>;

type P<A> = Parser.Parser<A, Issue>;

// -----------------------------------------------------------------------------
// Characters
// -----------------------------------------------------------------------------

const ws = " \t\n\f\r";

/** A tag name's first character: ASCII letters, `_`, `:` and anything non-ASCII. */
const nameStart = [
  Token.range("A", "Z"),
  Token.range("a", "z"),
  "_:",
  Token.range("\u0080", "\u{10FFFF}"),
];

/** Characters allowed in an XML end tag name. */
const nameChar = [...nameStart, Token.range("0", "9"), "-."];

const S0 = Token.takeWhile(ws);
const S1 = Token.takeWhile(ws, { min: 1 });
const anyChar = Token.any;
const nextChar = Parser.peek(Token.any);
const eof = Parser.eof;
const gt = Token.literal(">");
const gtOrEof = Parser.alt(Parser.asVoid(gt), eof);

/** In XML: fail here, unrecoverably, with an unexpected-character issue. */
const unexpected = (context: string): P<never> =>
  Parser.flatMap(Parser.location, (offset) =>
    Parser.cut(Parser.fail(Issue.Char({ context, offset }))),
  );

const none: Step = [];

/**
 * What `p` matched and where, as one object: a `Parser.withSpan` would build
 * a pair and a span for every token.
 */
const located = <A, E>(p: Parser.Parser<A, E>) =>
  Parser.struct({ start: Parser.location, value: p, end: Parser.location });

/** A token built from what `p` matched and where. */
const spanned = <A, E>(
  p: Parser.Parser<A, E>,
  f: (a: A, start: number, end: number) => Tok,
): Parser.Parser<Step, E> =>
  Parser.map(located(p), ({ start, value, end }) => [f(value, start, end)]);

// -----------------------------------------------------------------------------
// Character references
// -----------------------------------------------------------------------------

interface EntityConfig {
  readonly strict: boolean;
  /** XML `recover: true` (with `strict`): see `EntityOptions.recover` in `entities.ts`. */
  readonly recover: boolean;
  readonly entities: EntityTable;
  readonly legacy: EntityTable | undefined;
  /** Declared entities (XML with `dtd: "internal"`). */
  readonly dtd?: DtdSlot | undefined;
}

/**
 * Decode the character references in the text `p` matched; a bad one is an
 * error in XML. `p` must not fail (other than for lack of input): the
 * decoding failure is a cut, and so would be its failure.
 */
const decoded = (cfg: EntityConfig, inAttribute: boolean) => {
  const options = {
    entities: cfg.entities,
    legacy: cfg.legacy,
    dtd: cfg.dtd,
    strict: cfg.strict,
    recover: cfg.recover,
    inAttribute,
  };
  const normalizeWhitespace = cfg.strict && inAttribute;
  // XML: a literal `<` in an attribute value (§3.1), or `]]>` in text (§2.4);
  // both are text when recovering.
  const banned = cfg.strict && !cfg.recover ? (inAttribute ? "<" : "]]>") : undefined;
  const context = inAttribute
    ? "reading an attribute value (`<` must be escaped)"
    : "reading text (`]]>` must be escaped)";
  const check = (start: number, raw: string): Result.Result<string, Issue> => {
    const at = banned === undefined ? -1 : raw.indexOf(banned);
    if (at !== -1) return Result.fail(Issue.Char({ context, offset: start + at }));
    // XML attribute-value normalization (§3.3.3): literal whitespace
    // characters become spaces; those from character references stay.
    return Result.orElse(
      decode(normalizeWhitespace ? raw.replace(/[\t\n\r]/g, " ") : raw, options),
      ({ reference, reason, relativeOffset, limit }) =>
        cfg.strict
          ? Result.fail(Issue.Entity({ reference, reason, offset: start + relativeOffset, limit }))
          : Result.succeed(raw),
    );
  };
  // (Where the text starts is all the check needs: `zipWith` hands it over
  // without a pair and a span per run.)
  return (p: Parser.Parser<string>): P<string> =>
    Parser.zipWith(Parser.location, p, check).pipe(Parser.tryMap(identity), Parser.cut);
};

// -----------------------------------------------------------------------------
// Data state
// -----------------------------------------------------------------------------

const text = (data: string, start: number, end: number): Tok => ({
  _tag: "Text",
  data,
  start,
  end,
});
const commentTok = (data: string, start: number, end: number): Tok => ({
  _tag: "Comment",
  data,
  start,
  end,
});

/** Text up to the next `<`, with character references decoded. */
const textRun = (cfg: EntityConfig): P<Step> => {
  const dtd = cfg.dtd;
  if (dtd === undefined) {
    return Parser.preceded(
      Parser.peek(Token.noneOf("<")),
      spanned(decoded(cfg, false)(Token.takeTill("<")), text),
    );
  }
  return dtdText(cfg, dtd, []);
};

/**
 * Text with a DTD, which also stops at a reference to an entity with markup
 * in it, a token of its own; `more` is what else text takes in (recovering,
 * a stray `<`).
 */
const dtdText = (
  cfg: EntityConfig,
  dtd: DtdSlot,
  more: ReadonlyArray<Parser.Parser<string>>,
): P<Step> => {
  const markupRef = markupReference(dtd);
  const body = Parser.taken(
    Parser.repeat(
      Parser.alt(
        Token.takeTill("<&", { min: 1 }),
        Parser.preceded(Parser.not(markupRef), Token.literal("&")),
        ...more,
      ),
      { min: 1 },
    ),
  );
  const run = spanned(decoded(cfg, false)(body), text);
  return Parser.alt(
    spanned(markupRef, (name, start, end): Tok => ({ _tag: "EntityReference", name, start, end })),
    run,
  );
};

/** `&name;` where `name` is a declared entity whose replacement text contains markup. */
const markupReference = (dtd: DtdSlot): Parser.Parser<string> =>
  Parser.delimited(
    Token.literal("&"),
    Token.takeTill(";&<>\"' \t\n\r", { min: 1 }),
    Token.literal(";"),
  ).pipe(Parser.filter((name) => dtd.isMarkup(name)));

/** HTML: a `<` that opens nothing is text, along with what follows it. */
const strayLessThan = (cfg: EntityConfig): P<Step> =>
  spanned(
    decoded(cfg, false)(Parser.taken(Parser.seq(Token.literal("<"), Token.takeTill("<")))),
    text,
  );

/** `<` and an element name: up to whitespace, `/` or `>`. */
const startTagName = Parser.preceded(
  Token.literal("<"),
  Parser.taken(Parser.seq(Token.oneOf(nameStart), Token.takeTill(ws + "/>"))),
);

/**
 * Attribute values in double and single quotes, keyed by the opening quote.
 * The next character decides; an unclosed quote is not retried unquoted.
 */
const quotedValues = (value: (p: Parser.Parser<string>) => P<string>) => ({
  '"': Parser.delimited(Token.literal('"'), value(Token.takeTill('"')), Token.literal('"')),
  "'": Parser.delimited(Token.literal("'"), value(Token.takeTill("'")), Token.literal("'")),
});

const startElement = (
  [name, attributes, selfClosing]: readonly [string, ReadonlyArray<TokAttribute>, boolean],
  start: number,
  end: number,
): Tok => ({ _tag: "StartElement", name, attributes, selfClosing, start, end });

/**
 * The start tag read, failing where its element name or one of
 * its attribute names stops being an XML `Name` (§2.3). Checked once the
 * whole tag has been read: one step per tag on the hot path.
 */
const validNames = (
  tag: Extract<Tok, { readonly _tag: "StartElement" }>,
): Result.Result<Step, Issue> => {
  const { attributes } = tag;
  const named = validElementName(tag);
  if (Result.isFailure(named)) return named;
  const attribute = attributes.find((a) => invalidNameAt(a.name) !== -1);
  return attribute === undefined
    ? Result.succeed([tag])
    : Result.fail(
        Issue.Char({
          context: "reading an attribute name",
          offset: attribute.start + invalidNameAt(attribute.name),
        }),
      );
};

/** The start tag read, failing where its element name stops being an XML `Name` (§2.3). */
const validElementName = (
  tag: Extract<Tok, { readonly _tag: "StartElement" }>,
): Result.Result<Step, Issue> => {
  // The element name follows the `<`.
  const at = invalidNameAt(tag.name);
  return at === -1
    ? Result.succeed([tag])
    : Result.fail(Issue.Char({ context: "reading an element name", offset: tag.start + 1 + at }));
};

/**
 * XML `<name attr="value" … >` or `/>` (§3.1): names are `Name`s, every
 * attribute has `=` and a quoted value, and whitespace separates them.
 */
const xmlStartTag = (cfg: EntityConfig): P<Step> => {
  const value = decoded(cfg, true);
  const attrValue: P<string> = Parser.dispatch(
    nextChar,
    quotedValues(value),
    unexpected("reading an attribute value (it must be quoted)"),
  );
  const eq = Parser.alt(
    Parser.delimited(S0, Token.literal("="), S0),
    unexpected("after an attribute name (`=` and a value must follow)"),
  );
  // Built as the attribute itself, with no pairs or span in between.
  const attribute: P<TokAttribute> = Parser.struct({
    start: Parser.location,
    // (Only an attribute starts with some character other than these.)
    name: Parser.preceded(
      Parser.peek(Token.noneOf(ws + "/>")),
      Token.takeTill(ws + "=/>", { min: 1 }),
    ),
    // Committed once the value has started: an unclosed quote is reported where
    // the input ends, not backtracked to the separator before the attribute.
    value: Parser.preceded(eq, Parser.cut(attrValue)),
    end: Parser.location,
  });
  const close = Parser.preceded(
    S0,
    Parser.alt(
      Parser.as(gt, false),
      Parser.as(Token.literal("/>"), true),
      Parser.preceded(Token.literal("/"), unexpected("closing a self-closing tag")),
      unexpected("reading a start tag (attributes must be separated by whitespace)"),
    ),
  );
  // Built as the token itself, with no tuples or span in between.
  const tag = Parser.struct({
    _tag: Parser.succeed("StartElement" as const),
    start: Parser.location,
    name: startTagName,
    attributes: Parser.repeat(Parser.preceded(S1, attribute)),
    selfClosing: close,
    end: Parser.location,
  });
  // (The data grammar cuts at a start tag, so a failure here is fatal.)
  return Parser.tryMap(tag, validNames);
};

/**
 * An attribute value as HTML reads it: quoted, `""` right before the `>`,
 * or unquoted up to whitespace or `>`.
 */
const htmlAttributeValue = (value: (p: Parser.Parser<string>) => P<string>): P<string> =>
  Parser.dispatch(
    nextChar,
    { ...quotedValues(value), ">": Parser.succeed("") },
    value(Token.takeTill(ws + ">", { min: 1 })),
  );

/** An attribute name as HTML reads it: up to whitespace, `=`, `/` or `>`. */
const htmlAttributeName = Parser.taken(
  Parser.seq(Token.noneOf(ws + "/>"), Token.takeTill(ws + "=/>")),
);

/** `<name attr=value … >` or `/>`, as HTML reads it. */
const startTag = (cfg: EntityConfig): P<Step> => {
  const attrValue = htmlAttributeValue(decoded(cfg, true));
  // Its span takes in the whitespace after a valueless one.
  // (Built as the attribute itself, with no pairs or span in between.)
  const attribute: P<TokAttribute | null> = Parser.struct({
    start: Parser.location,
    name: htmlAttributeName,
    value: Parser.preceded(
      S0,
      Parser.orElseSucceed(
        Parser.preceded(Parser.seq(Token.literal("="), S0), Parser.cut(attrValue)),
        () => "",
      ),
    ),
    end: Parser.location,
  });
  // A `/` not before `>` is ignored in HTML.
  const strayslash = Parser.seq(Token.literal("/"), Parser.not(gt));
  const slash: P<null> = Parser.as(strayslash, null);
  const close = Parser.preceded(
    S0,
    Parser.alt(Parser.as(gt, false), Parser.as(Token.literal("/>"), true)),
  );
  return spanned(
    Parser.seq(
      startTagName,
      Parser.map(Parser.repeat(Parser.preceded(S0, Parser.alt(attribute, slash))), (attributes) =>
        attributes.filter((a) => a !== null),
      ),
      close,
    ),
    startElement,
  );
};

const endTagOpen = Token.literal("</");
const endElement = (name: string, start: number, end: number): Tok => ({
  _tag: "EndElement",
  name,
  start,
  end,
});

/** XML `</name>`, with optional whitespace before the `>`. */
const xmlEndTag: P<Step> = spanned(
  Parser.delimited(
    Parser.seq(
      endTagOpen,
      Parser.alt(Parser.peek(Token.oneOf(nameStart)), unexpected("opening an end tag")),
    ),
    Parser.taken(Parser.seq(Token.oneOf(nameStart), Token.takeWhile(nameChar))),
    Parser.alt(
      gt,
      Parser.preceded(S1, Parser.alt(gt, unexpected("after an end tag name"))),
      unexpected("reading an end tag name"),
    ),
  ),
  endElement,
);

/**
 * HTML `</name …>`: the name runs to whitespace or `>`, and anything after it
 * is ignored. `</` + a non-letter is a bogus comment; at EOF a lone `</` is
 * text and an unfinished end tag is dropped.
 */
const htmlEndTag: P<Step> = Parser.alt(
  spanned(
    Parser.delimited(
      Parser.seq(endTagOpen, Parser.peek(Token.oneOf(nameStart))),
      Token.takeTill(ws + ">"),
      Parser.seq(Token.takeTill(">"), gt),
    ),
    endElement,
  ),
  spanned(
    Parser.delimited(
      Parser.seq(endTagOpen, Parser.peek(Token.noneOf(nameStart))),
      Token.takeTill(">"),
      gtOrEof,
    ),
    commentTok,
  ),
  spanned(Parser.terminated(endTagOpen, eof), text),
  Parser.as(Parser.seq(endTagOpen, Token.rest, eof), none),
);

// -----------------------------------------------------------------------------
// XML recovery (`recover: true`)
// -----------------------------------------------------------------------------
//
// Each grammar here reads what its strict counterpart reads, to the same
// token at the same offset, and recovers only where that one fails: so a
// well-formed document is read exactly as strictly, and the scanner (an
// optimisation of the strict grammars) stays one of these too. They follow
// XML5 (and xml5ever), which takes the HTML tokenizer's recoveries without
// its raw text, its name lowercasing or its character references.

/** `<` and what makes it markup: a name start character, `/`, `!` or `?`. */
const markupOpen = Parser.seq(Token.literal("<"), Token.oneOf([...nameStart, "/!?"]));

/** A `<` that opens no markup, which is text. */
const strayLessThanSign = Parser.preceded(Parser.not(markupOpen), Token.literal("<"));

/**
 * Text up to the next `<` that opens markup, with character references
 * decoded: a stray `<` (`a < b`) is text, an `&` that starts no reference,
 * or one to an entity nobody declared, is itself, and so is `]]>`.
 */
const recoverText = (cfg: EntityConfig): P<Step> => {
  const dtd = cfg.dtd;
  if (dtd === undefined) {
    const body = Parser.taken(
      Parser.repeat(Parser.alt(Token.takeTill("<", { min: 1 }), strayLessThanSign), { min: 1 }),
    );
    return spanned(decoded(cfg, false)(body), text);
  }
  return dtdText(cfg, dtd, [strayLessThanSign]);
};

/**
 * The attributes a recovering start tag keeps: those whose names are XML
 * `Name`s (§2.3), as the strict grammar requires of all of them. The others
 * (`<a "b">`, `<p class=x &>`) are dropped, and so is {@link noAttribute}.
 */
const namedAttributes = (attributes: ReadonlyArray<TokAttribute>): ReadonlyArray<TokAttribute> =>
  attributes.every((a) => invalidNameAt(a.name) === -1)
    ? attributes
    : attributes.filter((a) => invalidNameAt(a.name) === -1);

/** What a stray `/` in a recovering start tag reads as: no `Name`, so dropped. */
const noAttribute: TokAttribute = { name: "", value: "", start: 0, end: 0 };

/**
 * `<name attr="value" … >` or `/>` as XML reads it, recovering as HTML does:
 * an unquoted value runs to whitespace or `>`, a valueless attribute's value
 * is `""`, attributes need no whitespace between them, and a `/` not before
 * the `>` is ignored. `<` and `&` in a value are text. The element name must
 * still be a `Name`.
 */
const recoverStartTag = (cfg: EntityConfig): P<Step> => {
  const attrValue = htmlAttributeValue(decoded(cfg, true));
  // Built as the attribute itself, with no pairs or span in between; the
  // span of a valueless one ends with its name.
  const attribute: P<TokAttribute> = Parser.struct({
    start: Parser.location,
    name: htmlAttributeName,
    value: Parser.orElseSucceed(
      Parser.preceded(Parser.delimited(S0, Token.literal("="), S0), Parser.cut(attrValue)),
      () => "",
    ),
    end: Parser.location,
  });
  const slash: P<TokAttribute> = Parser.as(
    Parser.seq(Token.literal("/"), Parser.not(gt)),
    noAttribute,
  );
  const close = Parser.preceded(
    S0,
    Parser.alt(Parser.as(gt, false), Parser.as(Token.literal("/>"), true)),
  );
  const tag = Parser.struct({
    _tag: Parser.succeed("StartElement" as const),
    start: Parser.location,
    name: startTagName,
    attributes: Parser.map(
      Parser.repeat(Parser.preceded(S0, Parser.alt(attribute, slash))),
      namedAttributes,
    ),
    selfClosing: close,
    end: Parser.location,
  });
  return Parser.tryMap(tag, validElementName);
};

/**
 * `</name>` as XML reads it, recovering as XML5 does: what follows the name
 * up to the `>` is ignored, `</` followed by anything but a name is a bogus
 * comment up to the next `>`, `</>` is dropped, and a `</` that ends the
 * input is text.
 */
const recoverEndTag: P<Step> = Parser.alt(
  spanned(
    Parser.delimited(
      Parser.seq(endTagOpen, Parser.peek(Token.oneOf(nameStart))),
      Parser.taken(Parser.seq(Token.oneOf(nameStart), Token.takeWhile(nameChar))),
      Parser.cut(Parser.seq(Token.takeTill(">"), gt)),
    ),
    endElement,
  ),
  Parser.as(Token.literal("</>"), none),
  spanned(
    Parser.delimited(Parser.seq(endTagOpen, Parser.peek(anyChar)), Token.takeTill(">"), gtOrEof),
    commentTok,
  ),
  spanned(Parser.terminated(endTagOpen, eof), text),
);

/** After `<!--`: data up to `-->` or `--!>` (WHATWG comment states). */
const commentClose = Parser.seq(Token.literal("--"), Parser.optional(Token.literal("!")), gt);
const commentData = Parser.taken(
  Parser.repeat(
    Parser.alt(
      Token.takeTill("-", { min: 1 }),
      Parser.preceded(Parser.not(commentClose), Token.literal("-")),
    ),
  ),
);
const commentBody: Parser.Parser<string> = Parser.alt(
  // `<!-->` and `<!--->` are empty comments.
  Parser.as(gt, ""),
  Parser.as(Token.literal("->"), ""),
  Parser.terminated(commentData, commentClose),
);

/** HTML: a comment cut short by EOF keeps its data, minus a partial `--!`. */
const commentAtEof: Parser.Parser<string> = Parser.terminated(Token.rest, eof).pipe(
  Parser.map((data) =>
    data.endsWith("--!")
      ? data.slice(0, -3)
      : data.endsWith("--")
        ? data.slice(0, -2)
        : data.endsWith("-")
          ? data.slice(0, -1)
          : data,
  ),
);

/** XML: comment data up to `-->`, with no `--` in it (§2.5). */
const xmlCommentBody: P<string> = Parser.terminated(
  Token.takeUntil("--"),
  Parser.alt(Token.literal("-->"), unexpected("reading a comment (only `-->` may contain `--`)")),
);

const comment = (strict: boolean): P<Step> =>
  spanned(
    Parser.preceded(
      Token.literal("<!--"),
      strict ? xmlCommentBody : Parser.alt(commentBody, commentAtEof),
    ),
    commentTok,
  );

const cdata = (strict: boolean): P<Step> => {
  const body = Parser.terminated(Token.takeUntil("]]>"), Token.literal("]]>"));
  return spanned(
    // HTML keeps the data of a section cut short by EOF.
    Parser.preceded(
      Token.literal("<![CDATA["),
      strict ? body : Parser.alt(body, Parser.terminated(Token.rest, eof)),
    ),
    (data, start, end) => ({ _tag: "CData", data, start, end }),
  );
};

/** HTML: `<!…>`, `<?…>` and the like are comments up to the next `>` (or EOF). */
const bogusComment = (open: string): Parser.Parser<Step> =>
  spanned(Parser.delimited(Token.literal(open), Token.takeTill(">"), gtOrEof), commentTok);

/** XML: `<!` that starts none of `--`, `[CDATA[`, `DOCTYPE`; fails where it stops matching. */
const markupKeywords = ["--", "[CDATA[", "DOCTYPE"];
/** Read characters while `seen` plus them still starts a keyword; fail at the first that does not. */
const markupKeywordPrefix = (seen: string): P<never> =>
  Parser.flatMap(nextChar, (c) =>
    markupKeywords.some((k) => k.startsWith((seen + c).toUpperCase()))
      ? Parser.preceded(anyChar, markupKeywordPrefix(seen + c))
      : unexpected("reading a markup declaration"),
  );
const badMarkupDeclaration: P<never> = Parser.preceded(
  Token.literal("<!"),
  Parser.cut(markupKeywordPrefix("")),
);

/** `<!DOCTYPE …>` in XML: the full grammar, as one token. */
const xmlDoctypeToken: P<Step> = spanned(
  Parser.preceded(Token.literal("<!"), xmlDoctype),
  (dt, start, end) => ({
    _tag: "Doctype",
    ...dt,
    forceQuirks: false,
    start,
    end,
  }),
);

/** `<?…?>` in XML: a processing instruction or the XML declaration. */
const piToken: P<Step> = spanned(
  Parser.preceded(Token.literal("<?"), processingInstruction),
  (pi, start, end) => ({
    ...pi,
    start,
    end,
  }),
);

// -----------------------------------------------------------------------------
// HTML DOCTYPE (WHATWG DOCTYPE states)
// -----------------------------------------------------------------------------

/** End of a DOCTYPE: `>`, or EOF. Either way the DOCTYPE is emitted. */
const doctypeEnd = Parser.alt(Parser.asVoid(Token.literal(">")), eof);

/**
 * End of a DOCTYPE where the WHATWG states emit it: `>` as it stands, EOF
 * with the force-quirks flag set. Returns the flag.
 */
const doctypeClose: Parser.Parser<boolean> = Parser.alt(
  Parser.as(Token.literal(">"), false),
  Parser.as(eof, true),
);

/** Bogus DOCTYPE state: skip to `>`. EOF there leaves force-quirks as it was. */
const bogusDoctype = Parser.preceded(Token.takeTill(">"), doctypeEnd);

/**
 * An identifier in quotes, and whether its closing quote ended it. A `>`
 * ends it (and the DOCTYPE) early; so does EOF.
 */
const doctypeId = (q: string): Parser.Parser<readonly [string, boolean]> =>
  Parser.preceded(
    anyChar,
    Parser.seq(
      Token.takeTill(q + ">"),
      Parser.alt(Parser.as(Token.literal(q), true), Parser.as(gtOrEof, false)),
    ),
  );
const doctypeIds = { '"': doctypeId('"'), "'": doctypeId("'") };

/** The next character, not consumed, or `""` at EOF. */
const doctypePeek = Parser.alt(nextChar, Parser.as(eof, ""));

/** An identifier step: the identifier, whether the DOCTYPE continues after it, and force-quirks. */
type DoctypeIdStep = readonly [id: string | null, more: boolean, forceQuirks: boolean];

const doctypeIdEnd = (forceQuirks: boolean): DoctypeIdStep => [null, false, forceQuirks];

/**
 * After a keyword or the public identifier: `"…"`/`'…'`, `>`, EOF, or
 * anything else (bogus). An identifier cut short by `>` or EOF, EOF itself
 * and a bogus DOCTYPE set force-quirks; so does `>` where an identifier is
 * required (`missing` — straight after `PUBLIC` or `SYSTEM`).
 */
const doctypeNextId = (missing: boolean): Parser.Parser<DoctypeIdStep> => {
  const atGt = doctypeIdEnd(missing);
  const quirks = doctypeIdEnd(true);
  return Parser.preceded(
    S0,
    Parser.dispatch(doctypePeek, (c) =>
      c === '"' || c === "'"
        ? Parser.map(doctypeIds[c], ([id, closed]): DoctypeIdStep => [id, closed, !closed])
        : c === ">"
          ? Parser.as(gt, atGt)
          : c === ""
            ? Parser.as(eof, quirks)
            : Parser.as(bogusDoctype, quirks),
    ),
  );
};
const afterKeywordId = doctypeNextId(true);
const betweenIds = doctypeNextId(false);

/**
 * After the system identifier: whitespace, then `>`, EOF (force-quirks) or
 * bogus (which here leaves force-quirks unset). Returns the flag.
 */
const doctypeAfterIds: Parser.Parser<boolean> = Parser.preceded(
  S0,
  Parser.alt(doctypeClose, Parser.as(bogusDoctype, false)),
);
const doctypeKeyword = Parser.alt(
  Ascii.caseless("PUBLIC"),
  Ascii.caseless("SYSTEM"),
  Parser.succeed(""),
);

type DoctypeFields = readonly [
  name: string,
  publicId: string | null,
  systemId: string | null,
  forceQuirks: boolean,
];

/** WHATWG DOCTYPE states, from after the keyword to the end. */
const doctypeFields: Parser.Parser<DoctypeFields> = Parser.gen(function* () {
  yield* S0;
  const first = yield* doctypePeek;
  if (first === ">" || first === "") {
    // A missing name sets force-quirks, whichever way the DOCTYPE ends.
    yield* doctypeEnd;
    return ["", null, null, true] as const;
  }
  const name = yield* Token.takeTill(ws + ">", { min: 1 });
  yield* S0;
  const next = yield* doctypePeek;
  if (next === ">" || next === "") {
    return [name, null, null, yield* doctypeClose] as const;
  }
  const keyword = (yield* doctypeKeyword).toUpperCase();
  if (keyword === "PUBLIC") {
    const [publicId, more, quirks] = yield* afterKeywordId;
    if (!more) return [name, publicId, null, quirks] as const;
    const [systemId, rest, systemQuirks] = yield* betweenIds;
    if (!rest) return [name, publicId, systemId, systemQuirks] as const;
    return [name, publicId, systemId, yield* doctypeAfterIds] as const;
  }
  if (keyword === "SYSTEM") {
    const [systemId, rest, quirks] = yield* afterKeywordId;
    if (!rest) return [name, null, systemId, quirks] as const;
    return [name, null, systemId, yield* doctypeAfterIds] as const;
  }
  // Anything else after the name is a bogus DOCTYPE, with force-quirks set.
  yield* bogusDoctype;
  return [name, null, null, true] as const;
});

const htmlDoctype: Parser.Parser<Step> = spanned(
  Parser.preceded(Parser.seq(Token.literal("<!"), Ascii.caseless("DOCTYPE")), doctypeFields),
  ([name, publicId, systemId, forceQuirks], start, end) => ({
    _tag: "Doctype",
    name,
    publicId,
    systemId,
    internalSubset: null,
    forceQuirks,
    start,
    end,
  }),
);

// -----------------------------------------------------------------------------
// Raw text: <script>, <style>, <title>, … (HTML only)
// -----------------------------------------------------------------------------

const endTagDelimiter = Token.oneOf(ws + "/>");

/** `</name` followed by whitespace, `/` or `>` (not consumed). */
const appropriateEndTag = (name: string) =>
  Parser.seq(endTagOpen, Ascii.caseless(name), Parser.peek(endTagDelimiter));

/** The rest of the end tag after its name; attributes and `/` are ignored. */
const endTagRest = Parser.terminated(Token.takeTill(">"), gt);

/**
 * Raw text up to the element's end tag, then the end tag. At EOF the text
 * still counts, but an unfinished end tag is dropped.
 */
const rawText = (name: string, body: P<string>): P<Step> => {
  const endTag = Parser.withSpan(Parser.preceded(appropriateEndTag(name), endTagRest));
  const endOrEof = Parser.alt(
    Parser.map(endTag, ([, span]): Tok | null => endElement(name, span.start, span.end)),
    Parser.as(Parser.seq(Token.rest, eof), null),
  );
  return Parser.map(Parser.seq(Parser.withSpan(body), endOrEof), ([[data, span], end]) => {
    const out: Array<Tok> = [];
    if (data !== "") out.push(text(data, span.start, span.end));
    if (end !== null) out.push(end);
    return out;
  });
};

/** Text with no markup in it but the given end tag. */
const plainBody = (name: string) => {
  const end = appropriateEndTag(name);
  return Parser.taken(
    Parser.repeat(
      Parser.alt(
        Token.takeTill("<", { min: 1 }),
        Parser.preceded(Parser.not(end), Token.literal("<")),
      ),
    ),
  );
};

/** A run of script text, or one `<` or `-` that does not start `stop`. */
const dashOrLt = (stop: Parser.Parser<unknown>) =>
  Parser.alt(
    Token.takeTill("<-", { min: 1 }),
    Parser.preceded(Parser.not(stop), Token.oneOf("<-")),
  );

/**
 * Script data, with its escape states (WHATWG §13.2.5.15–31): inside
 * `<!-- … -->` a `<script>` starts a "double escaped" section, in which
 * `</script>` does not end the script.
 */
const scriptBody: Parser.Parser<string> = (() => {
  const end = appropriateEndTag("script");
  const doubleStart = Parser.seq(Token.literal("<"), Ascii.caseless("script"), endTagDelimiter);
  const doubleEnd = Parser.seq(endTagOpen, Ascii.caseless("script"), endTagDelimiter);
  const escapedEnd = Token.literal("-->");
  // Double escaped: up to `</script>` (back to escaped) or `-->` (back to data).
  const doubleText = Parser.repeat(dashOrLt(Parser.alt(escapedEnd, doubleEnd)));
  const doubleToEscaped = Parser.seq(doubleStart, doubleText, doubleEnd);
  const doubleToData = Parser.seq(doubleStart, doubleText, Parser.alt(escapedEnd, eof));
  // Escaped: `<!--` … `-->`; the dashes of `<!--` count towards `-->`.
  const escapedText = Parser.repeat(
    Parser.alt(doubleToEscaped, dashOrLt(Parser.alt(end, escapedEnd, doubleStart))),
  );
  const escaped = Parser.preceded(
    Token.literal("<!--"),
    Parser.alt(
      gt,
      Token.literal("->"),
      Parser.seq(escapedText, Parser.alt(escapedEnd, doubleToData, Parser.peek(end), eof)),
    ),
  );
  return Parser.taken(
    Parser.repeat(
      Parser.alt(
        Token.takeTill("<", { min: 1 }),
        escaped,
        Parser.preceded(Parser.not(end), Token.literal("<")),
      ),
    ),
  );
})();

/** `<plaintext>`: everything to EOF is text. */
const plaintext: Parser.Parser<Step> = Parser.map(
  Parser.withSpan(Parser.terminated(Token.rest, eof)),
  ([data, span]) => (data === "" ? none : [text(data, span.start, span.end)]),
);

// -----------------------------------------------------------------------------
// Grammars per mode
// -----------------------------------------------------------------------------

export type RawKind = "rawtext" | "rcdata" | "script";

export interface Grammars {
  /** One token in the data state. */
  readonly data: P<Step>;
  /** The contents and end tag of a raw text element. */
  readonly raw: (name: string, kind: RawKind) => P<Step>;
  readonly plaintext: P<Step>;
  /**
   * Rcdata with no appropriate end tag (an HTML fragment parsed in a
   * `<title>` / `<textarea>` context): everything to EOF is text, with
   * character references decoded.
   */
  readonly rcdataToEnd: P<Step>;
  /** The slot to point at the document's DTD before each run (used with `dtd: "internal"` only). */
  readonly dtd: DtdSlot;
}

/**
 * Text, or markup chosen by the character after its `<` (`""` when the `<`
 * is the last character of the input).
 */
const dispatchMarkup = (
  textStep: P<Step>,
  markup: { readonly "/": P<Step>; readonly "!": P<Step>; readonly "?": P<Step> },
  tag: P<Step>,
  other: P<Step>,
): P<Step> => {
  const afterLt = Parser.preceded(Token.literal("<"), Parser.alt(Token.any, Parser.as(eof, "")));
  // Any other character opens a tag when a name starts there.
  const nameStartsHere = Parser.peek(Parser.preceded(Token.literal("<"), Token.oneOf(nameStart)));
  return Parser.dispatch(
    nextChar,
    {
      "<": Parser.dispatch(
        Parser.peek(afterLt),
        markup,
        Parser.alt(Parser.preceded(nameStartsHere, tag), other),
      ),
    },
    textStep,
  );
};

const makeGrammars = (cfg: EntityConfig): Grammars => {
  // (With a DTD, `textRun` also produces entity references.)
  const textToken = cfg.recover ? recoverText(cfg) : textRun(cfg);
  const tagOpen = Parser.seq(Token.literal("<"), Token.oneOf(nameStart));
  let data: P<Step>;
  if (cfg.strict) {
    // Once a construct's opening delimiter has matched, it must parse: a
    // failure inside it (EOF included) is an error, not a cue to try another.
    const committed = <A>(open: Parser.Parser<unknown>, p: P<A>): P<A> =>
      Parser.preceded(Parser.peek(open), Parser.cut(p));
    const markupDeclaration = Parser.alt(
      committed(Token.literal("<!--"), comment(true)),
      committed(Token.literal("<![CDATA["), cdata(true)),
      committed(Parser.seq(Token.literal("<!"), Ascii.caseless("DOCTYPE")), xmlDoctypeToken),
      // Recovering, any other `<!` is a bogus comment (XML5).
      cfg.recover ? bogusComment("<!") : badMarkupDeclaration,
    );
    // Recovering, a `<` that opens nothing is text (`recoverText` reads it).
    const badOpen = cfg.recover
      ? textToken
      : Parser.preceded(Token.literal("<"), unexpected("opening a tag"));
    data = dispatchMarkup(
      textToken,
      {
        "/": cfg.recover ? recoverEndTag : Parser.cut(xmlEndTag),
        "!": markupDeclaration,
        "?": Parser.cut(piToken),
      },
      Parser.cut(cfg.recover ? recoverStartTag(cfg) : xmlStartTag(cfg)),
      badOpen,
    );
  } else {
    const start = startTag(cfg);
    // At EOF an unfinished start tag is dropped.
    const startOrDrop = Parser.alt(
      Parser.backtrack(start),
      Parser.as(Parser.seq(tagOpen, Token.rest, eof), none),
    );
    const markupDeclaration = Parser.alt(
      comment(false),
      cdata(false),
      htmlDoctype,
      bogusComment("<!"),
    );
    const stray = strayLessThan(cfg);
    const pi = bogusComment("<");
    data = dispatchMarkup(
      textToken,
      { "/": htmlEndTag, "!": markupDeclaration, "?": pi },
      startOrDrop,
      stray,
    );
  }
  const raws = MutableHashMap.empty<string, P<Step>>();
  const raw = (name: string, kind: RawKind): P<Step> => {
    const key = `${kind}:${name}`;
    return Option.getOrElse(MutableHashMap.get(raws, key), () => {
      const g = Compiler.jit(
        rawText(
          name,
          kind === "script"
            ? scriptBody
            : kind === "rcdata"
              ? decoded(cfg, false)(plainBody(name))
              : plainBody(name),
        ),
      );
      MutableHashMap.set(raws, key, g);
      return g;
    });
  };
  const rcdataToEnd: P<Step> = Parser.map(
    Parser.withSpan(Parser.terminated(decoded(cfg, false)(Token.rest), eof)),
    ([rest, span]) => (rest === "" ? none : [text(rest, span.start, span.end)]),
  );
  return {
    data: Compiler.jit(data),
    raw,
    plaintext: Compiler.jit(plaintext),
    rcdataToEnd: Compiler.jit(rcdataToEnd),
    dtd: cfg.dtd ?? new DtdSlot(),
  };
};

const cache = new WeakMap<
  Record<string, string>,
  { xml?: Grammars; html?: Grammars; dtd?: Grammars; recover?: Grammars; recoverDtd?: Grammars }
>();

/**
 * The grammars for a mode and named-entity table (built once per table). With
 * `dtd: "internal"` (XML) they are built once per table too, reading the
 * declared entities through their {@link Grammars.dtd} slot; so are XML's
 * recovering grammars (`recover`, ignored in HTML, which always recovers),
 * with a DTD and without.
 */
export const grammars = (
  mode: "xml" | "html",
  entities: Record<string, string>,
  dtd: boolean,
  recover = false,
): Grammars => {
  let byMode = cache.get(entities);
  if (byMode === undefined) cache.set(entities, (byMode = {}));
  const xml = (withDtd: boolean, recovering: boolean): Grammars =>
    makeGrammars({
      strict: true,
      recover: recovering,
      entities,
      legacy: undefined,
      dtd: withDtd ? new DtdSlot() : undefined,
    });
  if (mode === "xml" && recover) {
    return dtd ? (byMode.recoverDtd ??= xml(true, true)) : (byMode.recover ??= xml(false, true));
  }
  if (dtd) return (byMode.dtd ??= xml(true, false));
  return (byMode[mode] ??= makeGrammars({
    strict: mode === "xml",
    recover: false,
    entities,
    legacy: mode === "html" ? htmlLegacyEntities : undefined,
  }));
};
