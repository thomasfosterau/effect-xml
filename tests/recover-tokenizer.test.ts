/**
 * Tokenizer-level recovery (`recover: true` in XML mode, #52): a `<` or `&`
 * that starts nothing, unquoted and valueless attributes, and markup out of
 * place at the top level are read rather than failing; characters XML does
 * not allow, resource limits and encoding errors still fail. A strict parse
 * of the same inputs fails exactly as it did before recovery existed.
 */
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Sax, Xml } from "../src/index.ts";
import { documents } from "./support/documents.ts";
import { at, failure, some, success } from "./support/narrow.ts";
import { plain } from "./support/plain.ts";

const recovered = (input: string) =>
  Effect.gen(function* () {
    return Xml.serializeDocument(yield* Xml.parse(input, { recover: true }));
  });
const strict = (input: string) => Effect.result(Xml.parse(input));
const recoverResult = (input: string) => Effect.result(Xml.parse(input, { recover: true }));
/** The text of a recovered `<a>` around `input`. */
const textOf = (input: string) =>
  Effect.gen(function* () {
    return success(yield* recoverResult(`<a>${input}</a>`)).root.textContent;
  });
/** The tag of a recovering parse's failure. */
const failureTag = (input: string) =>
  Effect.gen(function* () {
    return failure(yield* recoverResult(input))._tag;
  });
/** A recovering parse's failure under `limits`. */
const limited = (input: string, limits: NonNullable<Xml.ParseOptions["limits"]>) =>
  Effect.gen(function* () {
    return failure(yield* Effect.result(Xml.parse(input, { recover: true, limits })));
  });
const events = (input: string, options?: Sax.SaxOptions) =>
  Sax.collect(input, { recover: true, ...options });

const chunked = (input: string, size: number): ReadonlyArray<string> =>
  Arr.makeBy(Math.ceil(input.length / size), (i) => input.slice(i * size, i * size + size));

/** The events of `chunks` (or the failure), with every span resolved. */
const tokenized = (chunks: ReadonlyArray<string>, options: Sax.SaxOptions) =>
  Effect.gen(function* () {
    return Exit.map(
      yield* Effect.exit(
        Stream.fromIterable(chunks).pipe(Sax.tokenize(options), Stream.runCollect),
      ),
      (all) => plain(Arr.fromIterable(all)),
    );
  });

describe("recover: a `<` that opens no markup", () => {
  it.effect("is text: a bare `<`, `<` and a space, `a < b`", () =>
    Effect.gen(function* () {
      expect(yield* recovered("<a><</a>")).toBe("<a>&lt;</a>");
      expect(yield* recovered("<a>< b</a>")).toBe("<a>&lt; b</a>");
      expect(yield* recovered("<a>a < b</a>")).toBe("<a>a &lt; b</a>");
      expect(yield* recovered("<a>1<2 & 3<=4</a>")).toBe("<a>1&lt;2 &amp; 3&lt;=4</a>");
    }),
  );

  it.effect("joins the text around it in one event, spanning it all", () =>
    Effect.gen(function* () {
      const text = at(yield* events("<a>x < y <b/></a>"), 1);
      expect(text).toMatchObject({ _tag: "Text", data: "x < y " });
      expect(plain(text.span)).toMatchObject({
        start: { offset: 3 },
        end: { offset: 9 },
      });
    }),
  );

  it.effect("a `<` that opens a name is still a tag", () =>
    Effect.gen(function* () {
      expect(yield* recovered("<a>AT&T <b>x</b></a>")).toBe("<a>AT&amp;T <b>x</b></a>");
    }),
  );

  it.effect("`</` and no name: a bogus comment, `</>` dropped, `</` at the end text", () =>
    Effect.gen(function* () {
      expect(yield* recovered("<a>x</ y>z</a>")).toBe("<a>x<!-- y-->z</a>");
      expect(yield* recovered("<a>x</>z</a>")).toBe("<a>xz</a>");
      expect(yield* recovered("<a>x</")).toBe("<a>x&lt;/</a>");
      // What follows an end tag's name is ignored.
      expect(yield* recovered("<a><b>x</b junk></a>")).toBe("<a><b>x</b></a>");
    }),
  );

  it.effect("`<!` that opens no comment, CDATA section or DOCTYPE is a bogus comment", () =>
    Effect.gen(function* () {
      expect(yield* recovered("<a><!x y></a>")).toBe("<a><!--x y--></a>");
    }),
  );
});

describe("recover: an `&` that starts no reference", () => {
  it.effect("stays as written: `AT&T`, `&nbsp;`, `&#xZZ;`, `&;`, `&#X41;`, `&#65`", () =>
    Effect.gen(function* () {
      expect(yield* textOf("AT&T")).toBe("AT&T");
      expect(yield* textOf("&nbsp;")).toBe("&nbsp;");
      expect(yield* textOf("&eacute;t&eacute;")).toBe("&eacute;t&eacute;");
      expect(yield* textOf("&#xZZ;")).toBe("&#xZZ;");
      expect(yield* textOf("&;")).toBe("&;");
      expect(yield* textOf("&#X41;")).toBe("&#X41;");
      expect(yield* textOf("&#65")).toBe("&#65");
      expect(yield* textOf("& &amp; &#65; &lt;")).toBe("& & A <");
    }),
  );

  it.effect("`]]>` in text is text", () =>
    Effect.gen(function* () {
      expect(success(yield* recoverResult("<a>]]></a>")).root.textContent).toBe("]]>");
    }),
  );

  it.effect("HTML's named references are not expanded, but a declared entity is", () =>
    Effect.gen(function* () {
      const doc = `<!DOCTYPE a [<!ENTITY e "E">]><a>&e; &nbsp;</a>`;
      expect(
        success(yield* Effect.result(Xml.parse(doc, { recover: true, dtd: "internal" }))).root
          .textContent,
      ).toBe("E &nbsp;");
    }),
  );
});

describe("recover: attributes", () => {
  it.effect("an unquoted value runs to whitespace or `>`", () =>
    Effect.gen(function* () {
      const root = success(yield* recoverResult(`<a href=http://x/?a=1&b=2 n=3>t</a>`)).root;
      expect(root.attribute("href")).toEqual(Option.some("http://x/?a=1&b=2"));
      expect(root.attribute("n")).toEqual(Option.some("3"));
    }),
  );

  it.effect('a valueless attribute has the value `""`', () =>
    Effect.gen(function* () {
      const root = success(yield* recoverResult(`<td nowrap x="1" checked>t</td>`)).root;
      expect(root.attributes.map((a) => [a.name.qualified, a.value])).toStrictEqual([
        ["nowrap", ""],
        ["x", "1"],
        ["checked", ""],
      ]);
    }),
  );

  it.effect("`<` and `&` in a value are text", () =>
    Effect.gen(function* () {
      expect(yield* recovered(`<a x="a<b" y='AT&T &nbsp;'/>`)).toBe(
        `<a x="a&lt;b" y="AT&amp;T &amp;nbsp;"/>`,
      );
    }),
  );

  it.effect("no whitespace is needed between attributes, a stray `/` is ignored", () =>
    Effect.gen(function* () {
      expect(yield* recovered(`<a x="1"y='2' / z/>`)).toBe(`<a x="1" y="2" z=""/>`);
    }),
  );

  it.effect("an attribute whose name is not an XML Name is dropped", () =>
    Effect.gen(function* () {
      expect(yield* recovered(`<a "q" 1x=2 b=3>t</a>`)).toBe(`<a b="3">t</a>`);
    }),
  );

  it.effect(
    "spans: a valued attribute's ends after its value, a valueless one's after its name",
    () =>
      Effect.gen(function* () {
        const start = (yield* events(`<a x=1  y z = 'q'>`))[0];
        expect(start?._tag).toBe("StartElement");
        const attributes = start !== undefined && Sax.isStartElement(start) ? start.attributes : [];
        expect(attributes.map((a) => [a.name, a.value, plain(a.span)])).toMatchObject([
          ["x", "1", { start: { offset: 3 }, end: { offset: 6 } }],
          ["y", "", { start: { offset: 8 }, end: { offset: 9 } }],
          ["z", "q", { start: { offset: 10 }, end: { offset: 17 } }],
        ]);
      }),
  );
});

describe("recover: markup out of place at the top level", () => {
  it.effect("a reference or CDATA section outside the root goes into the recovered tree", () =>
    Effect.gen(function* () {
      expect(yield* recovered("&amp; hi<a/>")).toBe("<root>&amp; hi<a/></root>");
      expect(yield* recovered("<a/>&amp;")).toBe("<a>&amp;</a>");
      expect(yield* recovered("<![CDATA[x]]><a/>")).toBe("<root><![CDATA[x]]><a/></root>");
      expect(yield* recovered("AT&T")).toBe("<root>AT&amp;T</root>");
    }),
  );

  it.effect("a late XML declaration is dropped; the first one stays", () =>
    Effect.gen(function* () {
      const doc = success(
        yield* recoverResult(`<?xml version="1.1"?><a/><?xml version="1.0" encoding="x"?>`),
      );
      expect(some(doc.declaration).version).toBe("1.1");
      expect(some(doc.declaration).encoding).toEqual(Option.none());
      expect(Xml.serializeDocument(doc)).toBe(`<?xml version="1.1"?><a/>`);
      expect((yield* events(`<a/><?xml version="1.0"?>`)).map((e) => e._tag)).toStrictEqual([
        "StartElement",
      ]);
      expect(yield* recovered(` <?xml version="1.0"?><a/>`)).toBe("<a/>");
    }),
  );

  it.effect("a second DOCTYPE, or one after the root's start, is dropped", () =>
    Effect.gen(function* () {
      const doc = success(yield* recoverResult(`<!DOCTYPE a><!DOCTYPE b><a/><!DOCTYPE c>`));
      expect(some(doc.doctype).name).toBe("a");
    }),
  );
});

describe("recover: what still fails", () => {
  it.effect("characters XML does not allow, as written or as a character reference", () =>
    Effect.gen(function* () {
      expect(yield* failureTag("<a>\u0001</a>")).toBe("UnexpectedCharacter");
      expect(yield* failureTag("<a x='￿'/>")).toBe("UnexpectedCharacter");
      expect(yield* failureTag("<a>&#0;</a>")).toBe("InvalidEntity");
      expect(yield* failureTag("<a>&#x1;</a>")).toBe("InvalidEntity");
      expect(yield* failureTag("<a>&#xD800;</a>")).toBe("InvalidEntity");
      expect(yield* failureTag("<a>&#x110000;</a>")).toBe("InvalidEntity");
      expect(yield* failureTag("<a x='&#0;'/>")).toBe("InvalidEntity");
    }),
  );

  it.effect("resource limits", () =>
    Effect.gen(function* () {
      expect(yield* limited("<a>a < b and more</a>", { maxTextLength: 5 })).toMatchObject({
        _tag: "LimitExceeded",
        limit: "maxTextLength",
      });
      expect(yield* limited("<a x=1 y z/>", { maxAttributes: 2 })).toMatchObject({
        _tag: "LimitExceeded",
        limit: "maxAttributes",
      });
      expect(yield* limited("<a><b x=1><c y>t</c></b></a>", { maxDepth: 2 })).toMatchObject({
        _tag: "LimitExceeded",
        limit: "maxDepth",
      });
    }),
  );

  it.effect("encoding errors", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([0x3c, 0x61, 0x3e, 0xff, 0x3c, 0x2f, 0x61, 0x3e]);
      const result = yield* Effect.result(Xml.parseBytes(bytes, { recover: true }));
      expect(failure(result)._tag).toBe("InvalidByteSequence");
    }),
  );

  it.effect("markup the input ends inside of", () =>
    Effect.gen(function* () {
      expect(failure(yield* recoverResult("<a><b x='1"))._tag).toBe("UnexpectedEndOfInput");
      expect(failure(yield* recoverResult("<a><b"))._tag).toBe("UnexpectedEndOfInput");
    }),
  );
});

describe("recover: chunk boundaries", () => {
  const document =
    `<?xml version="1.0"?>&amp; lead <![CDATA[c]]>` +
    `<feed xmlns="urn:f"><title>AT&T &nbsp; &#xZZ; &; a < b <</title>` +
    `<link href=http://x/?a=1&b=2 rel=alternate nowrap/>` +
    `<entry x="a<b"y='&c' / z>1 <= 2 ]]> </ x></></entry>` +
    `<!bogus><p>&eacute;t&eacute;</p></feed><?xml version="1.0"?><!DOCTYPE late>tail &amp; </`;

  it.effect("give the same events and spans at every chunk size", () =>
    Effect.gen(function* () {
      const whole = yield* tokenized([document], { recover: true });
      expect(Exit.isSuccess(whole)).toBe(true);
      yield* Effect.forEach(
        Arr.range(1, document.length),
        (size) =>
          Effect.gen(function* () {
            return expect(
              yield* tokenized(chunked(document, size), { recover: true }),
              `size ${size}`,
            ).toStrictEqual(whole);
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("give the same tree at every chunk size, and from Xml.parse", () =>
    Effect.gen(function* () {
      const whole = yield* recovered(document);
      yield* Effect.forEach(
        Arr.range(1, document.length),
        (size) =>
          Effect.gen(function* () {
            return expect(
              Xml.serializeDocument(
                yield* Stream.fromIterable(chunked(document, size)).pipe(
                  Xml.parseStream({ recover: true }),
                ),
              ),
            ).toBe(whole);
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("give the same events with and without positions, and with `strict: false`", () =>
    Effect.gen(function* () {
      const withPositions = yield* events(document);
      const without = yield* events(document, { positions: false });
      expect(without.map((e) => e._tag)).toStrictEqual(withPositions.map((e) => e._tag));
      const each: Array<Sax.SaxEvent> = [];
      yield* Sax.forEach(document, (e) => each.push(e), { recover: true, strict: false });
      expect(plain(each)).toStrictEqual(plain(withPositions));
      expect(
        Xml.serializeDocument(yield* Xml.parse(document, { recover: true, strict: false })),
      ).toBe(yield* recovered(document));
    }),
  );
});

describe("recover: documents that need no recovery", () => {
  // Generated documents (see `tests/support/documents.ts`), well-formed or not.
  const docs = documents(52, 3000);

  it.effect("read as strictly where strict XML reads them, and fail no worse", () =>
    Effect.gen(function* () {
      const wellFormed = yield* Effect.filter(docs, (doc) =>
        Effect.map(tokenized([doc], {}), Exit.isSuccess),
      );
      expect(wellFormed.length).toBeGreaterThan(500);
      yield* Effect.forEach(
        wellFormed,
        (doc) =>
          Effect.gen(function* () {
            return expect(yield* tokenized([doc], { recover: true }), doc).toStrictEqual(
              yield* tokenized([doc], {}),
            );
          }),
        { concurrency: 1, discard: true },
      );
    }),
  );

  it.effect("the scanner and the recovering grammars agree, whole and chunked", () =>
    Effect.forEach(
      docs.slice(0, 1500),
      (doc) =>
        Effect.forEach(
          [doc.length, 1, 3],
          (size) =>
            Effect.gen(function* () {
              return expect(
                yield* tokenized(chunked(doc, size), { recover: true }),
                `${doc} in chunks of ${size}`,
              ).toStrictEqual(
                yield* tokenized(chunked(doc, size), { recover: true, dtd: "internal" }),
              );
            }),
          { concurrency: 1, discard: true },
        ),
      { concurrency: 1, discard: true },
    ),
  );
});

describe("without recover", () => {
  // Each input's strict failure, as on trunk before tokenizer recovery.
  const before: ReadonlyArray<readonly [string, string, string]> = [
    ["<a><</a>", "UnexpectedCharacter", 'Unexpected character "<" at 1:5 while opening a tag'],
    ["<a>< b</a>", "UnexpectedCharacter", 'Unexpected character " " at 1:5 while opening a tag'],
    ["<a>a < b</a>", "UnexpectedCharacter", 'Unexpected character " " at 1:7 while opening a tag'],
    [
      "<a>AT&T</a>",
      "InvalidEntity",
      'Invalid entity reference "&T" at 1:6: unterminated entity reference',
    ],
    ["<a>&nbsp;</a>", "InvalidEntity", 'Invalid entity reference "&nbsp;" at 1:4: unknown entity'],
    [
      "<a>&#xZZ;</a>",
      "InvalidEntity",
      'Invalid entity reference "&#" at 1:4: invalid numeric reference',
    ],
    ["<a>&;</a>", "InvalidEntity", 'Invalid entity reference "&;" at 1:4: unknown entity'],
    [
      "<a x=1/>",
      "UnexpectedCharacter",
      'Unexpected character "1" at 1:6 while reading an attribute value (it must be quoted)',
    ],
    [
      "<a y/>",
      "UnexpectedCharacter",
      'Unexpected character "/" at 1:5 while after an attribute name (`=` and a value must follow)',
    ],
    [
      "<a x='<'/>",
      "UnexpectedCharacter",
      'Unexpected character "<" at 1:7 while reading an attribute value (`<` must be escaped)',
    ],
    [
      "&amp;<a/>",
      "InvalidDocumentStructure",
      "Invalid document structure at 1:1: references are not allowed outside the root element",
    ],
    [
      "<a/>&amp;",
      "InvalidDocumentStructure",
      "Invalid document structure at 1:5: references are not allowed outside the root element",
    ],
    [
      "<![CDATA[x]]><a/>",
      "InvalidDocumentStructure",
      "Invalid document structure at 1:1: CDATA sections are not allowed outside the root element",
    ],
    [
      "<a/><?xml version='1.0'?>",
      "InvalidDocumentStructure",
      "Invalid document structure at 1:5: the XML declaration must be at the very start of the document",
    ],
    [
      "<a/><!DOCTYPE a>",
      "InvalidDocumentStructure",
      "Invalid document structure at 1:5: a document type declaration is only allowed once, in the prolog before the root element",
    ],
    [
      "<a></ b></a>",
      "UnexpectedCharacter",
      'Unexpected character " " at 1:6 while opening an end tag',
    ],
    [
      "<a></></a>",
      "UnexpectedCharacter",
      'Unexpected character ">" at 1:6 while opening an end tag',
    ],
    [
      "<a><!x></a>",
      "UnexpectedCharacter",
      'Unexpected character "x" at 1:6 while reading a markup declaration',
    ],
    [
      "<a>]]></a>",
      "UnexpectedCharacter",
      'Unexpected character "]" at 1:4 while reading text (`]]>` must be escaped)',
    ],
  ];

  it.effect("the same inputs fail with the same errors as before", () =>
    Effect.forEach(
      before,
      ([input, tag, message]) =>
        Effect.gen(function* () {
          const error = failure(yield* strict(input), input);
          expect([error._tag, error.message], input).toStrictEqual([tag, message]);
          // and every one of them is recovered from
          expect(Result.isSuccess(yield* recoverResult(input)), input).toBe(true);
        }),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("`Sax.tokenize` without `recover` fails on them too", () =>
    Effect.forEach(
      before,
      ([input]) =>
        Effect.gen(function* () {
          return expect(Exit.isFailure(yield* tokenized([input], {})), input).toBe(true);
        }),
      { concurrency: 1, discard: true },
    ),
  );

  it.effect("`recover` is ignored in HTML mode", () =>
    Effect.gen(function* () {
      const html = "<p>AT&amp;T <b x=1>a < b</b></p>";
      expect(yield* tokenized([html], { mode: "html", recover: true })).toStrictEqual(
        yield* tokenized([html], { mode: "html" }),
      );
    }),
  );
});
