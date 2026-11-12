import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Namespaces, Sax, Xml } from "../src/index.ts";
import { at, failure, success } from "./support/narrow.ts";

const { Bind } = Xml;

/** A schema whose decoding and encoding need no services, so its effects run synchronously. */
type Pure = Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never };

const decode = <S extends Pure>(schema: S, input: string) =>
  Effect.result(Bind.decode(schema)(input));

const encode = <S extends Pure>(schema: S, value: S["Type"]) => Bind.encode(schema)(value);

class Author extends Schema.Class<Author, { readonly brand: unique symbol }>("Author")({
  id: Schema.String.pipe(Bind.attribute()),
  name: Schema.String,
}) {}

class Book extends Schema.Class<Book, { readonly brand: unique symbol }>("Book")(
  {
    isbn: Schema.String.pipe(Bind.attribute()),
    lang: Schema.optional(Schema.String).pipe(Bind.attribute("xml:lang")),
    title: Schema.String,
    year: Schema.Int,
    inPrint: Schema.Boolean.pipe(Bind.element("in-print")),
    authors: Schema.Array(Author).pipe(Bind.element("author")),
    tags: Schema.Array(Schema.String).pipe(Bind.element({ name: "tag", wrapper: "tags" })),
    subtitle: Schema.optional(Schema.String),
  },
  Bind.annotations.named("book"),
) {}

const dune = `<book isbn="978-0441013593" xml:lang="en">
  <title>Dune</title>
  <year>1965</year>
  <in-print>true</in-print>
  <author id="fh"><name>Frank Herbert</name></author>
  <tags><tag>sf</tag><tag>classic</tag></tags>
  <unrelated>ignored</unrelated>
</book>`;

describe("decoding", () => {
  it.effect("attributes, elements, arrays, wrappers and optional fields", () =>
    Effect.gen(function* () {
      const book = success(yield* decode(Book, dune));
      expect(book).toBeInstanceOf(Book);
      expect(book.isbn).toBe("978-0441013593");
      expect(book.lang).toBe("en");
      expect(book.title).toBe("Dune");
      expect(book.year).toBe(1965);
      expect(book.inPrint).toBe(true);
      expect(at(book.authors, 0)).toEqual(new Author({ id: "fh", name: "Frank Herbert" }));
      expect(book.tags).toEqual(["sf", "classic"]);
      expect(book.subtitle).toBeUndefined();
    }),
  );

  it.effect("text content next to attributes", () =>
    Effect.gen(function* () {
      const Price = Schema.Struct({
        currency: Schema.String.pipe(Bind.attribute()),
        amount: Schema.FiniteFromString.pipe(Bind.text()),
      });
      const Item = Schema.Struct({ price: Price });
      expect(
        success(yield* decode(Item, `<item><price currency="EUR">9<!-- c -->.5</price></item>`)),
      ).toEqual({ price: { currency: "EUR", amount: 9.5 } });
    }),
  );

  it.effect("an array of leaves in an attribute is a whitespace-separated list", () =>
    Effect.gen(function* () {
      const Cell = Schema.Struct({
        classes: Schema.Array(Schema.String).pipe(Bind.attribute("class")),
      });
      expect(success(yield* decode(Cell, `<c class=" a  b c"/>`))).toEqual({
        classes: ["a", "b", "c"],
      });
    }),
  );

  it.effect("a union of tagged structs is a choice picked by element name", () =>
    Effect.gen(function* () {
      const Circle = Schema.TaggedStruct("Circle", {
        r: Schema.FiniteFromString.pipe(Bind.attribute()),
      }).pipe(Bind.named("circle"));
      const Square = Schema.TaggedStruct("Square", {
        side: Schema.FiniteFromString.pipe(Bind.attribute()),
      }).pipe(Bind.named("square"));
      const Drawing = Schema.Struct({
        figures: Schema.Array(Schema.Union([Circle, Square])),
        main: Schema.Union([Circle, Square]),
      });
      expect(
        success(
          yield* decode(
            Drawing,
            `<drawing><circle r="1"/><other/><square side="2"/><circle r="3"/></drawing>`,
          ),
        ),
      ).toEqual({
        figures: [
          { _tag: "Circle", r: 1 },
          { _tag: "Square", side: 2 },
          { _tag: "Circle", r: 3 },
        ],
        main: { _tag: "Circle", r: 1 },
      });
    }),
  );

  it.effect("tagged classes are named after their tag when not annotated", () =>
    Effect.gen(function* () {
      class Cat extends Schema.TaggedClass<Cat, { readonly brand: unique symbol }>()("Cat", {
        name: Schema.String,
      }) {}
      class Dog extends Schema.TaggedClass<Dog, { readonly brand: unique symbol }>()("Dog", {
        name: Schema.String,
      }) {}
      const Pets = Schema.Struct({ pets: Schema.Array(Schema.Union([Cat, Dog])) });
      const pets = success(
        yield* decode(Pets, `<pets><Dog><name>Rex</name></Dog><Cat><name>Tom</name></Cat></pets>`),
      ).pets;
      expect(pets).toEqual([new Dog({ name: "Rex" }), new Cat({ name: "Tom" })]);
    }),
  );

  it.effect("recursive schemas", () =>
    Effect.gen(function* () {
      interface Category {
        readonly name: string;
        readonly children: ReadonlyArray<Category>;
      }
      const Category = Schema.Struct({
        name: Schema.String.pipe(Bind.attribute()),
        children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category)).pipe(
          Bind.element("category"),
        ),
      });
      expect(
        success(
          yield* decode(
            Category,
            `<category name="a"><category name="b"><category name="c"/></category></category>`,
          ),
        ),
      ).toEqual({
        name: "a",
        children: [{ name: "b", children: [{ name: "c", children: [] }] }],
      });
    }),
  );

  it.effect("elements match by local name in any namespace unless one is given", () =>
    Effect.gen(function* () {
      const Feed = Schema.Struct({
        title: Schema.String,
        link: Schema.optional(
          Schema.String.pipe(Bind.element({ name: "link", namespace: Option.some("urn:other") })),
        ),
      });
      expect(
        success(
          yield* decode(
            Feed,
            `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:o="urn:other"><link>no</link><title>T</title><o:link>yes</o:link></feed>`,
          ),
        ),
      ).toEqual({ title: "T", link: "yes" });
    }),
  );

  it.effect("the root name is checked when the schema names it", () =>
    Effect.gen(function* () {
      const error = failure(yield* decode(Book, `<magazine/>`));
      expect(error._tag).toBe("XmlBindError");
      expect(error.message).toBe(
        "Cannot bind XML: expected the element <book> but found <magazine>",
      );
    }),
  );

  it.effect("values that fail the schema are SchemaErrors with the field path", () =>
    Effect.gen(function* () {
      const error = failure(yield* decode(Book, dune.replace("1965", "soon")));
      expect(error._tag).toBe("SchemaError");
      expect(String(error)).toContain("year");
    }),
  );

  it.effect("a missing required element fails the schema", () =>
    Effect.gen(function* () {
      const error = failure(yield* decode(Book, `<book isbn="1"><year>1</year></book>`));
      expect(error._tag).toBe("SchemaError");
    }),
  );

  it.effect("malformed XML fails with the parse error", () =>
    Effect.gen(function* () {
      expect(failure(yield* decode(Book, `<book>`))._tag).toBe("InvalidDocumentStructure");
    }),
  );

  it.effect.each([
    ["a record", Schema.Struct({ r: Schema.Record(Schema.String, Schema.String) })],
    ["a tuple", Schema.Struct({ t: Schema.Tuple([Schema.String, Schema.String]) })],
    ["a struct attribute", Schema.Struct({ s: Schema.Struct({}).pipe(Bind.attribute()) })],
    ["an array of arrays", Schema.Struct({ a: Schema.Array(Schema.Array(Schema.String)) })],
    ["a leaf root", Schema.String],
  ] as const)("%s has no XML mapping", ([_, schema]) =>
    Effect.gen(function* () {
      expect(failure(yield* decode(schema, `<x/>`))._tag).toBe("XmlBindError");
    }),
  );

  it.effect("decodeElement decodes subtrees selected from a SAX stream", () =>
    Effect.gen(function* () {
      const Row = Schema.Struct({
        r: Schema.FiniteFromString.pipe(Bind.attribute()),
        v: Schema.String,
      });
      const rows = Stream.make(
        `<sheet><row r="1"><v>a</v></row><row r="2"><v>b</v></row></sheet>`,
      ).pipe(Sax.tokenize(), Sax.select("/sheet/row"), Stream.mapEffect(Bind.decodeElement(Row)));
      expect(yield* Stream.runCollect(rows)).toEqual([
        { r: 1, v: "a" },
        { r: 2, v: "b" },
      ]);
    }),
  );
});

describe("encoding", () => {
  it.effect("writes attributes, elements, wrappers and text", () =>
    Effect.gen(function* () {
      const book = success(yield* decode(Book, dune));
      expect(yield* encode(Book, book)).toBe(
        `<book isbn="978-0441013593" xml:lang="en"><title>Dune</title><year>1965</year>` +
          `<in-print>true</in-print><author id="fh"><name>Frank Herbert</name></author>` +
          `<tags><tag>sf</tag><tag>classic</tag></tags></book>`,
      );
    }),
  );

  it.effect("round-trips through decode", () =>
    Effect.gen(function* () {
      const book = success(yield* decode(Book, dune));
      expect(success(yield* decode(Book, yield* encode(Book, book)))).toEqual(book);
    }),
  );

  it.effect("names the root after the identifier, and leaves _tag out", () =>
    Effect.gen(function* () {
      class Cat extends Schema.TaggedClass<Cat, { readonly brand: unique symbol }>()("Cat", {
        name: Schema.String.pipe(Bind.attribute()),
        lives: Schema.Finite,
      }) {}
      expect(yield* encode(Cat, new Cat({ name: "Tom", lives: 9 }))).toBe(
        `<Cat name="Tom"><lives>9</lives></Cat>`,
      );
    }),
  );

  it.effect("a choice writes the member the value belongs to", () =>
    Effect.gen(function* () {
      const Circle = Schema.TaggedStruct("Circle", {
        r: Schema.Finite.pipe(Bind.attribute()),
      }).pipe(Bind.named("circle"));
      const Square = Schema.TaggedStruct("Square", {
        side: Schema.Finite.pipe(Bind.attribute()),
      }).pipe(Bind.named("square"));
      const Drawing = Schema.Struct({ figures: Schema.Array(Schema.Union([Circle, Square])) }).pipe(
        Bind.named("drawing"),
      );
      const xml = yield* encode(Drawing, {
        figures: [
          { _tag: "Square", side: 2 },
          { _tag: "Circle", r: 1 },
        ],
      });
      expect(xml).toBe(`<drawing><square side="2"/><circle r="1"/></drawing>`);
      expect(success(yield* decode(Drawing, xml)).figures).toHaveLength(2);
    }),
  );

  it.effect("children inherit the root's namespace; namespaced attributes get a prefix", () =>
    Effect.gen(function* () {
      const Note = Schema.Struct({
        id: Schema.Finite.pipe(Bind.attribute()),
        lang: Schema.String.pipe(
          Bind.attribute({ name: "lang", namespace: Option.some(Namespaces.xml) }),
        ),
        ref: Schema.String.pipe(
          Bind.attribute({ name: "ref", namespace: Option.some("urn:x"), prefix: "x" }),
        ),
        body: Schema.String,
      }).pipe(Bind.named({ name: "note", namespace: Option.some("urn:notes") }));
      const value = { id: 1, lang: "en", ref: "r", body: "Hi" };
      const xml = yield* encode(Note, value);
      expect(xml).toBe(
        `<note xmlns="urn:notes" xmlns:x="urn:x" id="1" xml:lang="en" x:ref="r"><body>Hi</body></note>`,
      );
      expect(success(yield* decode(Note, xml))).toEqual(value);
    }),
  );

  it.effect("an encoding failure is a SchemaError", () =>
    Effect.gen(function* () {
      const Positive = Schema.Struct({ n: Schema.Finite.check(Schema.isGreaterThan(0)) }).pipe(
        Bind.named("p"),
      );
      const exit = yield* Effect.result(Bind.encode(Positive)({ n: -1 }));
      expect(failure(exit)._tag).toBe("SchemaError");
    }),
  );

  it.effect("a root without a name fails", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.result(
        Bind.encode(Schema.Struct({ a: Schema.String }))({ a: "x" }),
      );
      expect(failure(exit).message).toContain("Xml.Bind.named");
    }),
  );
});
