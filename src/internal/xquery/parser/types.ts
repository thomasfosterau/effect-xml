/**
 * Sequence types, item types and kind tests (XQuery 3.1 §2.5.4, A.1
 * `SequenceType` … `ArrayTest`).
 *
 * Occurrence indicators are greedy (grammar note `occurrence-indicators`):
 * a `?`, `*` or `+` right after an item type always belongs to it, so
 * `4 treat as item() + - 5` is `(4 treat as item()+) - 5`.
 */
import * as Option from "effect/Option";
import { Parser } from "@thomasfosterau/effect-parse";
import type { Annotation, EQName, Occurrence, SingleType } from "./ast.ts";
import { ItemType, SequenceType } from "./ast.ts";
import type { Lexical, P } from "./lexical.ts";

/** The type parsers. */
export interface Types {
  readonly sequenceType: P<SequenceType>;
  readonly itemType: P<ItemType>;
  readonly singleType: P<SingleType>;
  /** `KindTest`, as used in node tests. */
  readonly kindTest: P<ItemType>;
  /** `TypeDeclaration ::= "as" SequenceType` */
  readonly typeDeclaration: P<SequenceType>;
}

/** `fn:normalize-space`, as applied to a `processing-instruction("…")` target. */
const normalizeSpace = (s: string): string => s.trim().replace(/[ \t\r\n]+/g, " ");

const element = (
  args: Option.Option<readonly [Option.Option<EQName>, Option.Option<readonly [EQName, boolean]>]>,
): ItemType =>
  Option.match(args, {
    onNone: () => ItemType.Element({ name: Option.none(), type: Option.none(), nillable: false }),
    onSome: ([name, type]) =>
      ItemType.Element({
        name,
        type: Option.map(type, ([t]) => t),
        nillable: Option.exists(type, ([, nillable]) => nillable),
      }),
  });

const attribute = (
  args: Option.Option<readonly [Option.Option<EQName>, Option.Option<EQName>]>,
): ItemType =>
  Option.match(args, {
    onNone: () => ItemType.Attribute({ name: Option.none(), type: Option.none() }),
    onSome: ([name, type]) => ItemType.Attribute({ name, type }),
  });

/** Builds the type parsers over `lex`; `annotations` parses `%name(…)` lists (XQuery only). */
export const types = (lex: Lexical, annotations: P<ReadonlyArray<Annotation>>): Types => {
  const { tok, kw, lexeme, eqname, ncname, stringLiteral } = lex;
  const name = lexeme(eqname);
  const open = tok("(");
  const close = Parser.cut(tok(")"));
  const empty = <A>(keyword: string, value: A): P<A> =>
    Parser.as(Parser.seq(kw(keyword), open, close), value);
  const call = <A>(keyword: string, args: P<A>): P<A> =>
    Parser.preceded(Parser.seq(kw(keyword), open), Parser.cut(Parser.terminated(args, close)));

  const nameOrWildcard: P<Option.Option<EQName>> = Parser.alt(
    Parser.as(tok("*"), Option.none()),
    Parser.map(name, Option.some),
  );
  const elementTest: P<ItemType> = Parser.map(
    call(
      "element",
      Parser.opt(
        Parser.seq(
          nameOrWildcard,
          Parser.opt(
            Parser.preceded(
              tok(","),
              Parser.seq(
                name,
                Parser.map(Parser.optional(tok("?")), (q) => q !== undefined),
              ),
            ),
          ),
        ),
      ),
    ),
    element,
  );
  const attributeTest: P<ItemType> = Parser.map(
    call(
      "attribute",
      Parser.opt(Parser.seq(nameOrWildcard, Parser.opt(Parser.preceded(tok(","), name)))),
    ),
    attribute,
  );
  const schemaElementTest: P<ItemType> = Parser.map(call("schema-element", name), (n) =>
    ItemType.SchemaElement({ name: n }),
  );
  const schemaAttributeTest: P<ItemType> = Parser.map(call("schema-attribute", name), (n) =>
    ItemType.SchemaAttribute({ name: n }),
  );
  const documentTest: P<ItemType> = Parser.map(
    call("document-node", Parser.opt(Parser.alt(elementTest, schemaElementTest))),
    (e) => ItemType.Document({ element: e }),
  );
  const piTest: P<ItemType> = Parser.map(
    call(
      "processing-instruction",
      Parser.opt(Parser.alt(lexeme(ncname), Parser.map(stringLiteral, normalizeSpace))),
    ),
    (target) => ItemType.ProcessingInstruction({ target }),
  );

  const kindTest: P<ItemType> = Parser.alt(
    documentTest,
    elementTest,
    attributeTest,
    schemaElementTest,
    schemaAttributeTest,
    piTest,
    empty("comment", ItemType.Comment()),
    empty("text", ItemType.Text()),
    empty("namespace-node", ItemType.NamespaceNode()),
    empty("node", ItemType.AnyKind()),
  );

  const sequenceType: P<SequenceType> = Parser.suspend(() =>
    Parser.alt(
      empty("empty-sequence", SequenceType.EmptySequence()),
      Parser.map(
        Parser.seq(itemType, Parser.optional(Parser.alt(tok("?"), tok("*"), tok("+")))),
        ([item, occurrence]) =>
          SequenceType.Items({ item, occurrence: (occurrence ?? "") satisfies Occurrence }),
      ),
    ),
  );

  const functionTest: P<ItemType> = Parser.map(
    Parser.seq(
      annotations,
      Parser.preceded(
        Parser.seq(kw("function"), open),
        Parser.cut(
          Parser.alt(
            Parser.as(Parser.seq(tok("*"), close), Option.none()),
            Parser.map(
              Parser.seq(
                Parser.terminated(Parser.separated(sequenceType, tok(",")), close),
                Parser.preceded(Parser.cut(kw("as")), Parser.cut(sequenceType)),
              ),
              Option.some,
            ),
          ),
        ),
      ),
    ),
    ([annots, typed]) =>
      Option.match(typed, {
        onNone: () => ItemType.AnyFunction({ annotations: annots }),
        onSome: ([parameters, result]) =>
          ItemType.TypedFunction({ annotations: annots, parameters, result }),
      }),
  );
  const mapTest: P<ItemType> = call(
    "map",
    Parser.alt(
      Parser.as(tok("*"), ItemType.AnyMap()),
      Parser.map(Parser.separatedPair(name, tok(","), sequenceType), ([key, value]) =>
        ItemType.TypedMap({ key, value }),
      ),
    ),
  );
  const arrayTest: P<ItemType> = call(
    "array",
    Parser.alt(
      Parser.as(tok("*"), ItemType.AnyArray()),
      Parser.map(sequenceType, (member) => ItemType.TypedArray({ member })),
    ),
  );

  const itemType: P<ItemType> = Parser.alt(
    kindTest,
    empty("item", ItemType.AnyItem()),
    functionTest,
    mapTest,
    arrayTest,
    Parser.delimited(
      open,
      Parser.suspend(() => itemType),
      close,
    ),
    Parser.map(name, (n) => ItemType.Atomic({ name: n })),
  );

  const singleType: P<SingleType> = Parser.map(
    Parser.seq(name, Parser.optional(tok("?"))),
    ([n, q]) => ({ name: n, optional: q !== undefined }),
  );

  return {
    sequenceType,
    itemType,
    singleType,
    kindTest,
    typeDeclaration: Parser.preceded(kw("as"), Parser.cut(sequenceType)),
  };
};
