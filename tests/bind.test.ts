import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Namespaces, Sax, Xml } from "../src/index.ts";
import { at, failure, success } from "./support/narrow.ts";

const { Bind } = Xml;

/** A schema whose decoding and encoding need no services, so its effects run synchronously. */
type Pure = Schema.Top & { readonly DecodingServices: never; readonly EncodingServices: never };

const decode = <S extends Pure>(schema: S, input: string) =>
  Effect.runSync(Effect.result(Bind.decode(schema)(input)));

const encode = <S extends Pure>(schema: S, value: S["Type"]) =>
  Effect.runSync(Bind.encode(schema)(value));

class Author extends Schema.Class<Author>("Author")({
  id: Schema.String.pipe(Bind.attribute()),
  name: Schema.String,
}) {}

class Book extends Schema.Class<Book>("Book")(
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
  test("attributes, elements, arrays, wrappers and optional fields", () => {
    const book = success(decode(Book, dune));
    expect(book).toBeInstanceOf(Book);
    expect(book.isbn).toBe("978-0441013593");
    expect(book.lang).toBe("en");
    expect(book.title).toBe("Dune");
    expect(book.year).toBe(1965);
    expect(book.inPrint).toBe(true);
    expect(at(book.authors, 0)).toEqual(new Author({ id: "fh", name: "Frank Herbert" }));
    expect(book.tags).toEqual(["sf", "classic"]);
    expect(book.subtitle).toBeUndefined();
  });

  test("text content next to attributes", () => {
    const Price = Schema.Struct({
      currency: Schema.String.pipe(Bind.attribute()),
      amount: Schema.NumberFromString.pipe(Bind.text()),
    });
    const Item = Schema.Struct({ price: Price });
    expect(
      success(decode(Item, `<item><price currency="EUR">9<!-- c -->.5</price></item>`)),
    ).toEqual({ price: { currency: "EUR", amount: 9.5 } });
  });

  test("an array of leaves in an attribute is a whitespace-separated list", () => {
    const Cell = Schema.Struct({
      classes: Schema.Array(Schema.String).pipe(Bind.attribute("class")),
    });
    expect(success(decode(Cell, `<c class=" a  b c"/>`))).toEqual({ classes: ["a", "b", "c"] });
  });

  test("a union of tagged structs is a choice picked by element name", () => {
    const Circle = Schema.TaggedStruct("Circle", {
      r: Schema.NumberFromString.pipe(Bind.attribute()),
    }).pipe(Bind.named("circle"));
    const Square = Schema.TaggedStruct("Square", {
      side: Schema.NumberFromString.pipe(Bind.attribute()),
    }).pipe(Bind.named("square"));
    const Drawing = Schema.Struct({
      figures: Schema.Array(Schema.Union([Circle, Square])),
      main: Schema.Union([Circle, Square]),
    });
    expect(
      success(
        decode(
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
  });

  test("tagged classes are named after their tag when not annotated", () => {
    class Cat extends Schema.TaggedClass<Cat>()("Cat", { name: Schema.String }) {}
    class Dog extends Schema.TaggedClass<Dog>()("Dog", { name: Schema.String }) {}
    const Pets = Schema.Struct({ pets: Schema.Array(Schema.Union([Cat, Dog])) });
    const pets = success(
      decode(Pets, `<pets><Dog><name>Rex</name></Dog><Cat><name>Tom</name></Cat></pets>`),
    ).pets;
    expect(pets).toEqual([new Dog({ name: "Rex" }), new Cat({ name: "Tom" })]);
  });

  test("recursive schemas", () => {
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
        decode(
          Category,
          `<category name="a"><category name="b"><category name="c"/></category></category>`,
        ),
      ),
    ).toEqual({
      name: "a",
      children: [{ name: "b", children: [{ name: "c", children: [] }] }],
    });
  });

  test("elements match by local name in any namespace unless one is given", () => {
    const Feed = Schema.Struct({
      title: Schema.String,
      link: Schema.optional(
        Schema.String.pipe(Bind.element({ name: "link", namespace: "urn:other" })),
      ),
    });
    expect(
      success(
        decode(
          Feed,
          `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:o="urn:other"><link>no</link><title>T</title><o:link>yes</o:link></feed>`,
        ),
      ),
    ).toEqual({ title: "T", link: "yes" });
  });

  test("the root name is checked when the schema names it", () => {
    const error = failure(decode(Book, `<magazine/>`));
    expect(error._tag).toBe("XmlBindError");
    expect(error.message).toBe("Cannot bind XML: expected the element <book> but found <magazine>");
  });

  test("values that fail the schema are SchemaErrors with the field path", () => {
    const error = failure(decode(Book, dune.replace("1965", "soon")));
    expect(error._tag).toBe("SchemaError");
    expect(String(error)).toContain("year");
  });

  test("a missing required element fails the schema", () => {
    const error = failure(decode(Book, `<book isbn="1"><year>1</year></book>`));
    expect(error._tag).toBe("SchemaError");
  });

  test("malformed XML fails with the parse error", () => {
    expect(failure(decode(Book, `<book>`))._tag).toBe("InvalidDocumentStructure");
  });

  test.each([
    ["a record", Schema.Struct({ r: Schema.Record(Schema.String, Schema.String) })],
    ["a tuple", Schema.Struct({ t: Schema.Tuple([Schema.String, Schema.String]) })],
    ["a struct attribute", Schema.Struct({ s: Schema.Struct({}).pipe(Bind.attribute()) })],
    ["an array of arrays", Schema.Struct({ a: Schema.Array(Schema.Array(Schema.String)) })],
    ["a leaf root", Schema.String],
  ] as const)("%s has no XML mapping", (_, schema) => {
    expect(failure(decode(schema, `<x/>`))._tag).toBe("XmlBindError");
  });

  test("decodeElement decodes subtrees selected from a SAX stream", () => {
    const Row = Schema.Struct({
      r: Schema.NumberFromString.pipe(Bind.attribute()),
      v: Schema.String,
    });
    const rows = Stream.make(
      `<sheet><row r="1"><v>a</v></row><row r="2"><v>b</v></row></sheet>`,
    ).pipe(Sax.tokenize(), Sax.select("/sheet/row"), Stream.mapEffect(Bind.decodeElement(Row)));
    expect(Effect.runSync(Stream.runCollect(rows))).toEqual([
      { r: 1, v: "a" },
      { r: 2, v: "b" },
    ]);
  });
});

describe("encoding", () => {
  test("writes attributes, elements, wrappers and text", () => {
    const book = success(decode(Book, dune));
    expect(encode(Book, book)).toBe(
      `<book isbn="978-0441013593" xml:lang="en"><title>Dune</title><year>1965</year>` +
        `<in-print>true</in-print><author id="fh"><name>Frank Herbert</name></author>` +
        `<tags><tag>sf</tag><tag>classic</tag></tags></book>`,
    );
  });

  test("round-trips through decode", () => {
    const book = success(decode(Book, dune));
    expect(success(decode(Book, encode(Book, book)))).toEqual(book);
  });

  test("names the root after the identifier, and leaves _tag out", () => {
    class Cat extends Schema.TaggedClass<Cat>()("Cat", {
      name: Schema.String.pipe(Bind.attribute()),
      lives: Schema.Number,
    }) {}
    expect(encode(Cat, new Cat({ name: "Tom", lives: 9 }))).toBe(
      `<Cat name="Tom"><lives>9</lives></Cat>`,
    );
  });

  test("a choice writes the member the value belongs to", () => {
    const Circle = Schema.TaggedStruct("Circle", {
      r: Schema.Number.pipe(Bind.attribute()),
    }).pipe(Bind.named("circle"));
    const Square = Schema.TaggedStruct("Square", {
      side: Schema.Number.pipe(Bind.attribute()),
    }).pipe(Bind.named("square"));
    const Drawing = Schema.Struct({ figures: Schema.Array(Schema.Union([Circle, Square])) }).pipe(
      Bind.named("drawing"),
    );
    const xml = encode(Drawing, {
      figures: [
        { _tag: "Square", side: 2 },
        { _tag: "Circle", r: 1 },
      ],
    });
    expect(xml).toBe(`<drawing><square side="2"/><circle r="1"/></drawing>`);
    expect(success(decode(Drawing, xml)).figures).toHaveLength(2);
  });

  test("children inherit the root's namespace; namespaced attributes get a prefix", () => {
    const Note = Schema.Struct({
      id: Schema.Number.pipe(Bind.attribute()),
      lang: Schema.String.pipe(Bind.attribute({ name: "lang", namespace: Namespaces.xml })),
      ref: Schema.String.pipe(Bind.attribute({ name: "ref", namespace: "urn:x", prefix: "x" })),
      body: Schema.String,
    }).pipe(Bind.named({ name: "note", namespace: "urn:notes" }));
    const value = { id: 1, lang: "en", ref: "r", body: "Hi" };
    const xml = encode(Note, value);
    expect(xml).toBe(
      `<note xmlns="urn:notes" xmlns:x="urn:x" id="1" xml:lang="en" x:ref="r"><body>Hi</body></note>`,
    );
    expect(success(decode(Note, xml))).toEqual(value);
  });

  test("an encoding failure is a SchemaError", () => {
    const Positive = Schema.Struct({ n: Schema.Number.check(Schema.isGreaterThan(0)) }).pipe(
      Bind.named("p"),
    );
    const exit = Effect.runSync(Effect.result(Bind.encode(Positive)({ n: -1 })));
    expect(failure(exit)._tag).toBe("SchemaError");
  });

  test("a root without a name fails", () => {
    const exit = Effect.runSync(
      Effect.result(Bind.encode(Schema.Struct({ a: Schema.String }))({ a: "x" })),
    );
    expect(failure(exit).message).toContain("Xml.Bind.named");
  });
});
