/**
 * The DOCTYPE internal subset, interpreted (with `dtd: "internal"`).
 *
 * {@link Dtd.declare} reads the internal subset's declarations (XML 1.0
 * §2.8, §3.3, §4.2): general entities and attribute-list declarations are
 * recorded; element and notation declarations, comments and processing
 * instructions are skipped. External and parameter entities are never
 * fetched: a reference to an external entity, or any parameter entity
 * reference, is an error.
 *
 * References then resolve in two ways. An entity whose replacement text is
 * plain text is decoded where it is referenced, by the entity decoder
 * ({@link Dtd.resolve}). An entity whose replacement text contains markup is
 * a token of its own, which the SAX layer expands by lexing its replacement
 * text ({@link Dtd.isMarkup}). Both count against one expansion budget, and
 * nesting is bounded, so recursive and exponential ("billion laughs")
 * entities fail with typed errors.
 */
import { Parser, Token } from "@thomasfosterau/effect-parse";
import { Result } from "effect";
import type { Limits } from "../Limits.ts";
import type { EntityResolver, ExpansionFailure } from "./entities.ts";
import { Name, NCName } from "./names.ts";

/** An attribute declared in an `<!ATTLIST>`. */
export interface AttributeDecl {
  readonly name: string;
  /** Any type but CDATA: the value is normalized further (§3.3.3). */
  readonly tokenized: boolean;
  /** The default (or `#FIXED`) value, normalized; `null` for `#REQUIRED`/`#IMPLIED`. */
  readonly value: string | null;
}

const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

/** Collapse runs of spaces and trim: normalization for tokenized attribute types. */
export const collapse = (s: string): string => s.replace(/ +/g, " ").replace(/^ | $/g, "");

const isXmlChar = (cp: number): boolean =>
  cp === 0x9 ||
  cp === 0xa ||
  cp === 0xd ||
  (cp >= 0x20 && cp <= 0xd7ff) ||
  (cp >= 0xe000 && cp <= 0xfffd) ||
  (cp >= 0x10000 && cp <= 0x10ffff);

/** A character reference body (`#38`, `#x26`) as a string, or null if it isn't a valid one. */
const charRef = (body: string): string | null => {
  const m = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(body);
  if (m === null) return null;
  const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2]!, 10);
  return isXmlChar(cp) ? String.fromCodePoint(cp) : null;
};

// -----------------------------------------------------------------------------
// The internal subset grammar
// -----------------------------------------------------------------------------

type Decl =
  | {
      readonly _tag: "Entity";
      readonly name: string;
      readonly value: string | null;
      readonly parameter: boolean;
    }
  | {
      readonly _tag: "Attlist";
      readonly element: string;
      readonly attributes: ReadonlyArray<RawAttribute>;
    }
  | { readonly _tag: "Skip" };

interface RawAttribute {
  readonly name: string;
  readonly tokenized: boolean;
  readonly value: string | null;
}

const S = Token.takeWhile(" \t\r\n", { min: 1 }).pipe(Parser.expected("whitespace"));
const S0 = Token.takeWhile(" \t\r\n");
const lit = Token.literal;
const quoted: Parser.Parser<string> = Parser.alt(
  Parser.delimited(lit('"'), Token.takeTill('"'), lit('"')),
  Parser.delimited(lit("'"), Token.takeTill("'"), lit("'")),
).pipe(Parser.expected("a quoted string"));

/** `SYSTEM "…"` or `PUBLIC "…" "…"`. */
const externalId = Parser.alt(
  Parser.seq(lit("SYSTEM"), S, quoted),
  Parser.seq(lit("PUBLIC"), S, quoted, S, quoted),
);

const entityDecl: Parser.Parser<Decl> = Parser.gen(function* () {
  yield* lit("<!ENTITY");
  yield* S;
  const parameter = (yield* Parser.optional(Parser.seq(lit("%"), S))) !== undefined;
  const name = yield* NCName.pipe(Parser.expected("an entity name"));
  yield* S;
  const value = yield* Parser.alt(
    quoted,
    Parser.as(
      Parser.seq(externalId, Parser.optional(Parser.seq(S, lit("NDATA"), S, NCName))),
      null,
    ),
  );
  yield* S0;
  yield* lit(">");
  return { _tag: "Entity", name, value, parameter } as const;
});

/** `CDATA`, a tokenized type, `NOTATION (…)` or an enumeration `(…)`. */
const attType: Parser.Parser<boolean> = Parser.alt(
  Parser.as(lit("CDATA"), false),
  Parser.as(Parser.seq(lit("NOTATION"), S, lit("("), Token.takeTill(")"), lit(")")), true),
  Parser.as(Parser.seq(lit("("), Token.takeTill(")"), lit(")")), true),
  ...["IDREFS", "IDREF", "ID", "ENTITY", "ENTITIES", "NMTOKENS", "NMTOKEN"].map((t) =>
    Parser.as(lit(t), true),
  ),
).pipe(Parser.expected("an attribute type"));

const defaultDecl: Parser.Parser<string | null> = Parser.alt(
  Parser.as(lit("#REQUIRED"), null),
  Parser.as(lit("#IMPLIED"), null),
  Parser.preceded(Parser.optional(Parser.seq(lit("#FIXED"), S)), quoted),
).pipe(Parser.expected("a default value"));

const attDef: Parser.Parser<RawAttribute> = Parser.gen(function* () {
  yield* S;
  const name = yield* Name;
  yield* S;
  const tokenized = yield* attType;
  yield* S;
  const value = yield* defaultDecl;
  return { name, tokenized, value };
});

const attlistDecl: Parser.Parser<Decl> = Parser.gen(function* () {
  yield* lit("<!ATTLIST");
  yield* S;
  const element = yield* Name.pipe(Parser.expected("an element name"));
  const attributes = yield* Parser.repeat(Parser.backtrack(attDef));
  yield* S0;
  yield* lit(">");
  return { _tag: "Attlist", element, attributes } as const;
});

/** `<!ELEMENT …>` and `<!NOTATION …>`, skipped (respecting quotes). */
const skippedDecl: Parser.Parser<Decl> = Parser.as(
  Parser.seq(
    Parser.alt(lit("<!ELEMENT"), lit("<!NOTATION")),
    Parser.repeat(Parser.alt(quoted, Token.takeTill(">\"'", { min: 1 }))),
    lit(">"),
  ),
  { _tag: "Skip" } as const,
);

const commentDecl: Parser.Parser<Decl> = Parser.as(
  Parser.seq(lit("<!--"), Token.takeUntil("-->"), lit("-->")),
  { _tag: "Skip" },
);
const piDecl: Parser.Parser<Decl> = Parser.as(
  Parser.seq(lit("<?"), Token.takeUntil("?>"), lit("?>")),
  { _tag: "Skip" },
);

const markupDecl: Parser.Parser<Decl> = Parser.alt(
  Parser.preceded(Parser.peek(lit("<!ENTITY")), Parser.cut(entityDecl)),
  Parser.preceded(Parser.peek(lit("<!ATTLIST")), Parser.cut(attlistDecl)),
  Parser.preceded(
    Parser.peek(Parser.alt(lit("<!ELEMENT"), lit("<!NOTATION"))),
    Parser.cut(skippedDecl),
  ),
  Parser.preceded(Parser.peek(lit("<!--")), Parser.cut(commentDecl)),
  Parser.preceded(Parser.peek(lit("<?")), Parser.cut(piDecl)),
  Parser.preceded(
    lit("%"),
    Parser.cut(
      Parser.failMessage("a markup declaration (parameter entity references are not supported)"),
    ),
  ),
).pipe(Parser.expected("a markup declaration"));

const internalSubset: Parser.Parser<ReadonlyArray<Decl>> = Parser.terminated(
  Parser.repeat(Parser.preceded(S0, markupDecl)),
  Parser.seq(S0, Parser.eof),
);

// -----------------------------------------------------------------------------
// The declarations
// -----------------------------------------------------------------------------

/** Why a declaration was rejected, at an offset in the internal subset. */
export interface DeclarationError {
  readonly offset: number;
  readonly expected: string;
}

export class Dtd implements EntityResolver {
  /** Internal general entities: the literal value, with character references expanded. */
  private readonly entities = new Map<string, string>();
  private readonly external = new Set<string>();
  private readonly attlists = new Map<string, Array<AttributeDecl>>();
  private readonly markup = new Map<string, boolean>();
  /** Replacement text added so far. */
  private expanded = 0;

  private readonly limits: Limits;

  constructor(limits: Limits) {
    this.limits = limits;
  }

  /** Read an internal subset's declarations. */
  declare(subset: string): DeclarationError | null {
    const parsed = Parser.parse(internalSubset, subset);
    if (Result.isFailure(parsed)) {
      const e = parsed.failure;
      const expected =
        e.description ?? (e.expected.length > 0 ? e.expected.join(" or ") : "a markup declaration");
      return { offset: e.offset, expected };
    }
    for (const decl of parsed.success) {
      if (decl._tag === "Entity") {
        if (decl.parameter) continue;
        // The first declaration of an entity wins (§4.2); the predefined ones can't change.
        if (this.entities.has(decl.name) || this.external.has(decl.name) || decl.name in PREDEFINED)
          continue;
        if (decl.value === null) {
          this.external.add(decl.name);
          continue;
        }
        const value = this.literal(decl.value);
        if (typeof value !== "string")
          return {
            offset: 0,
            expected: `a valid value for entity "${decl.name}" (${value.reason})`,
          };
        this.entities.set(decl.name, value);
      } else if (decl._tag === "Attlist") {
        let list = this.attlists.get(decl.element);
        if (list === undefined) this.attlists.set(decl.element, (list = []));
        for (const a of decl.attributes) {
          // The first declaration of an attribute wins too.
          if (list.some((x) => x.name === a.name)) continue;
          let value: string | null = null;
          if (a.value !== null) {
            const expanded = this.expand(a.value, true, []);
            if (typeof expanded !== "string")
              return {
                offset: 0,
                expected: `a valid default for attribute "${a.name}" (${expanded.reason})`,
              };
            value = a.tokenized ? collapse(expanded) : expanded;
          }
          list.push({ name: a.name, tokenized: a.tokenized, value });
        }
      }
    }
    return null;
  }

  /** An entity value: character references expanded, entity references kept (§4.5). */
  private literal(raw: string): string | ExpansionFailure {
    if (raw.includes("%")) return { reason: "parameter entity references are not supported" };
    let bad = false;
    const value = raw.replace(
      /&(#x[0-9a-fA-F]+|#[0-9]+|[^;&\s]+);|&/g,
      (m, body: string | undefined) => {
        if (body === undefined) bad = true;
        else if (body.startsWith("#")) {
          const c = charRef(body);
          if (c !== null) return c;
          bad = true;
        }
        return m;
      },
    );
    return bad ? { reason: "invalid reference" } : value;
  }

  // EntityResolver ------------------------------------------------------------

  declares(name: string): boolean {
    return this.entities.has(name) || this.external.has(name);
  }

  resolve(name: string, inAttribute: boolean): string | ExpansionFailure {
    return this.expand(`&${name};`, inAttribute, []);
  }

  /** Whether the replacement text of `name` contains markup, directly or through the entities it references. */
  isMarkup(name: string, seen: ReadonlySet<string> = new Set()): boolean {
    const cached = this.markup.get(name);
    if (cached !== undefined) return cached;
    const value = this.entities.get(name);
    if (value === undefined || seen.has(name)) return false;
    const next = new Set(seen).add(name);
    let result = value.includes("<");
    for (const m of value.matchAll(/&([^#;&][^;&]*);/g))
      if (!result) result = this.isMarkup(m[1]!, next);
    // Memoized at every level, or a chain of entities that each reference the
    // next many times is exponential. A cycle only cuts the walk short:
    // expanding a cyclic entity is an error anyway.
    this.markup.set(name, result);
    return result;
  }

  /** The replacement text of `name`, checked and counted against the expansion budget. */
  replacement(name: string, stack: ReadonlyArray<string>): string | ExpansionFailure {
    if (this.external.has(name)) return { reason: `external entity "${name}" is not supported` };
    const value = this.entities.get(name);
    if (value === undefined) return { reason: "unknown entity" };
    if (stack.includes(name)) return { reason: `recursive entity "${name}"` };
    const depth = this.limits.maxEntityDepth;
    if (stack.length >= depth)
      return {
        reason: "entity references nested too deeply",
        limit: { name: "maxEntityDepth", max: depth },
      };
    return this.charge(value.length) ?? value;
  }

  /** Replacement text added so far. */
  get spent(): number {
    return this.expanded;
  }

  /** Count `n` characters of replacement text against the budget. */
  charge(n: number): ExpansionFailure | null {
    this.expanded += n;
    const max = this.limits.maxEntityExpansion;
    return this.expanded > max
      ? { reason: "entity expansion limit exceeded", limit: { name: "maxEntityExpansion", max } }
      : null;
  }

  /**
   * Expand the references in text, as content (markup is an error here: it is
   * expanded by the SAX layer) or as an attribute value (normalized, §3.3.3).
   */
  private expand(
    raw: string,
    inAttribute: boolean,
    stack: ReadonlyArray<string>,
  ): string | ExpansionFailure {
    let out = "";
    for (let i = 0; i < raw.length;) {
      const c = raw[i]!;
      if (c === "<")
        return {
          reason: inAttribute
            ? '"<" is not allowed in attribute values'
            : "entity replacement text contains markup",
        };
      if (c !== "&") {
        out += inAttribute && (c === "\t" || c === "\n" || c === "\r") ? " " : c;
        i++;
        continue;
      }
      const semi = raw.indexOf(";", i);
      if (semi === -1) return { reason: "unterminated entity reference" };
      const body = raw.slice(i + 1, semi);
      i = semi + 1;
      if (body.startsWith("#")) {
        const ch = charRef(body);
        if (ch === null) return { reason: "invalid character reference" };
        out += ch;
        continue;
      }
      const predefined = PREDEFINED[body];
      if (predefined !== undefined) {
        out += predefined;
        continue;
      }
      const value = this.replacement(body, stack);
      if (typeof value !== "string") return value;
      const inner = this.expand(value, inAttribute, [...stack, body]);
      if (typeof inner !== "string") return inner;
      out += inner;
    }
    return out;
  }

  /** The attributes declared for an element. */
  attributes(element: string): ReadonlyArray<AttributeDecl> | undefined {
    return this.attlists.get(element);
  }
}
