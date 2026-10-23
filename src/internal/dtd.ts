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
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type { Limits } from "../Limits.ts";
import { isXmlChar, type EntityResolver, type ExpansionFailure } from "./entities.ts";
import { Name, NCName } from "./names.ts";

/** An attribute declared in an `<!ATTLIST>`. */
export interface AttributeDecl {
  readonly name: string;
  /** Any type but CDATA: the value is normalized further (§3.3.3). */
  readonly tokenized: boolean;
  /** The default (or `#FIXED`) value, normalized; `null` for `#REQUIRED`/`#IMPLIED`. */
  readonly value: string | null;
}

/** The five predefined entities, by name. */
interface PredefinedEntities {
  readonly [name: string]: string;
}
const PREDEFINED: PredefinedEntities = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

/** Collapse runs of spaces and trim: normalization for tokenized attribute types. */
export const collapse = (s: string): string => s.replace(/ +/g, " ").replace(/^ | $/g, "");

/** A character reference body (`#38`, `#x26`) as a string, or null if it isn't a valid one. */
const charRef = (body: string): string | null => {
  const m = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(body);
  if (m === null) return null;
  // One of the two groups matched.
  const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2] ?? "", 10);
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
  private readonly entities = MutableHashMap.empty<string, string>();
  private readonly external = MutableHashSet.empty<string>();
  private readonly attlists = MutableHashMap.empty<string, Array<AttributeDecl>>();
  private readonly markup = MutableHashMap.empty<string, boolean>();
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
        e.description ??
        (Arr.isReadonlyArrayNonEmpty(e.expected)
          ? e.expected.join(" or ")
          : "a markup declaration");
      return { offset: e.offset, expected };
    }
    // In order; the first rejected declaration stops the rest.
    return Option.getOrNull(
      Arr.findFirst(parsed.success, (decl) => Option.fromNullishOr(this.declareOne(decl))),
    );
  }

  private declareOne(decl: Decl): DeclarationError | null {
    if (Predicate.isTagged(decl, "Entity")) return this.declareEntity(decl);
    if (Predicate.isTagged(decl, "Attlist")) return this.declareAttlist(decl);
    return null;
  }

  private declareEntity(decl: Extract<Decl, { _tag: "Entity" }>): DeclarationError | null {
    if (decl.parameter) return null;
    // The first declaration of an entity wins (§4.2); the predefined ones can't change.
    if (
      MutableHashMap.has(this.entities, decl.name) ||
      MutableHashSet.has(this.external, decl.name) ||
      decl.name in PREDEFINED
    )
      return null;
    if (decl.value === null) {
      MutableHashSet.add(this.external, decl.name);
      return null;
    }
    const value = this.literal(decl.value);
    if (!Predicate.isString(value))
      return {
        offset: 0,
        expected: `a valid value for entity "${decl.name}" (${value.reason})`,
      };
    MutableHashMap.set(this.entities, decl.name, value);
    return null;
  }

  private declareAttlist(decl: Extract<Decl, { _tag: "Attlist" }>): DeclarationError | null {
    const list = Option.getOrElse(MutableHashMap.get(this.attlists, decl.element), () => {
      const fresh: Array<AttributeDecl> = [];
      MutableHashMap.set(this.attlists, decl.element, fresh);
      return fresh;
    });
    return Option.getOrNull(
      Arr.findFirst(decl.attributes, (a) => {
        // The first declaration of an attribute wins too.
        if (list.some((x) => x.name === a.name)) return Option.none();
        if (a.value === null) {
          list.push({ name: a.name, tokenized: a.tokenized, value: null });
          return Option.none();
        }
        const expanded = this.expand(a.value, true, []);
        if (!Predicate.isString(expanded))
          return Option.some({
            offset: 0,
            expected: `a valid default for attribute "${a.name}" (${expanded.reason})`,
          });
        list.push({
          name: a.name,
          tokenized: a.tokenized,
          value: a.tokenized ? collapse(expanded) : expanded,
        });
        return Option.none();
      }),
    );
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
    return MutableHashMap.has(this.entities, name) || MutableHashSet.has(this.external, name);
  }

  resolve(name: string, inAttribute: boolean): string | ExpansionFailure {
    return this.expand(`&${name};`, inAttribute, []);
  }

  /** Whether the replacement text of `name` contains markup, directly or through the entities it references. */
  isMarkup(name: string, seen: ReadonlyArray<string> = []): boolean {
    const cached = MutableHashMap.get(this.markup, name);
    if (Option.isSome(cached)) return cached.value;
    const value = Option.getOrUndefined(MutableHashMap.get(this.entities, name));
    if (value === undefined || seen.includes(name)) return false;
    // Each referenced entity is walked only until one is found to hold markup.
    // Native array methods keep each level of this recursion to a few stack
    // frames: a chain of thousands of entities must reach its depth limit, not
    // overflow the stack.
    const next = [...seen, name];
    const result =
      value.includes("<") ||
      Array.from(value.matchAll(/&([^#;&][^;&]*);/g)).some((m) => this.isMarkup(m[1] ?? "", next));
    // Memoized at every level, or a chain of entities that each reference the
    // next many times is exponential. A cycle only cuts the walk short:
    // expanding a cyclic entity is an error anyway.
    MutableHashMap.set(this.markup, name, result);
    return result;
  }

  /** The replacement text of `name`, checked and counted against the expansion budget. */
  replacement(name: string, stack: ReadonlyArray<string>): string | ExpansionFailure {
    if (MutableHashSet.has(this.external, name))
      return { reason: `external entity "${name}" is not supported` };
    const value = Option.getOrUndefined(MutableHashMap.get(this.entities, name));
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
    // The text in order: runs without `&`, references up to the next `;`, and
    // a `&` with no `;` after it. The first failure stops the walk, so no
    // later reference is resolved (or charged against the budget).
    // (Native array methods: this recurses once per nesting level, and must
    // reach its depth limit rather than overflow the stack.)
    return Array.from(raw.matchAll(/&[^;]*;|&|[^&]+/g)).reduce<string | ExpansionFailure>(
      (out, [segment]) =>
        Predicate.isString(out) ? this.expandSegment(out, segment, inAttribute, stack) : out,
      "",
    );
  }

  private expandSegment(
    out: string,
    segment: string,
    inAttribute: boolean,
    stack: ReadonlyArray<string>,
  ): string | ExpansionFailure {
    if (!segment.startsWith("&")) {
      if (segment.includes("<"))
        return {
          reason: inAttribute
            ? '"<" is not allowed in attribute values'
            : "entity replacement text contains markup",
        };
      return out + (inAttribute ? segment.replace(/[\t\n\r]/g, " ") : segment);
    }
    if (segment === "&") return { reason: "unterminated entity reference" };
    const body = segment.slice(1, -1);
    if (body.startsWith("#")) {
      const ch = charRef(body);
      return ch === null ? { reason: "invalid character reference" } : out + ch;
    }
    const predefined = PREDEFINED[body];
    if (predefined !== undefined) return out + predefined;
    const value = this.replacement(body, stack);
    if (!Predicate.isString(value)) return value;
    const inner = this.expand(value, inAttribute, [...stack, body]);
    return Predicate.isString(inner) ? out + inner : inner;
  }

  /** The attributes declared for an element. */
  attributes(element: string): ReadonlyArray<AttributeDecl> | undefined {
    return Option.getOrUndefined(MutableHashMap.get(this.attlists, element));
  }
}
