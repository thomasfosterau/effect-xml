/**
 * Tokenizer-level recovery (`recover: true` in XML mode, #52, #184): a `<` or
 * `&` that starts nothing, unquoted and valueless attributes, markup out of
 * place at the top level, the short end tag `</>`, comments with `--` in
 * them, markup the input ends inside of, malformed DOCTYPEs and processing
 * instructions, and entity replacement text that is not balanced markup are
 * read rather than failing; characters XML does not allow, resource limits
 * and encoding errors still fail. A strict parse of the same inputs fails
 * exactly as it did before recovery existed.
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

  it.effect("`</` and no name: a bogus comment, `</` at the end text", () =>
    Effect.gen(function* () {
      expect(yield* recovered("<a>x</ y>z</a>")).toBe("<a>x<!-- y-->z</a>");
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

  it.effect("an element name that is not an XML Name", () =>
    Effect.gen(function* () {
      expect(yield* failureTag("<a!b>")).toBe("UnexpectedCharacter");
      expect(yield* failureTag("<a><b!c x='1'>")).toBe("UnexpectedCharacter");
      // (A tag the input ends inside of is dropped before its name is checked.)
      expect(yield* recovered("<a><b!c x='1'")).toBe("<a/>");
    }),
  );

  it.effect("a forbidden character in markup the input ends inside of", () =>
    Effect.gen(function* () {
      expect(yield* failureTag("<a><!-- \u0001")).toBe("UnexpectedCharacter");
      expect(yield* failureTag("<a><b x='\u0001")).toBe("UnexpectedCharacter");
      expect(yield* failureTag("<a><?pi \u0001")).toBe("UnexpectedCharacter");
    }),
  );

  it.effect("entity replacement text: recursion, characters XML does not allow, limits", () =>
    Effect.gen(function* () {
      expect(yield* internalFailure(`<!ENTITY e "<b>&e;</b>">`, "&e;")).toMatchObject({
        _tag: "InvalidEntity",
        reason: 'recursive entity "e"',
      });
      expect((yield* internalFailure(`<!ENTITY e "<b>&#0;</b>">`, "&e;"))._tag).toBe(
        "MalformedDeclaration",
      );
      expect((yield* internalFailure(`<!ENTITY e "<b>&#38;#0;</b>">`, "&e;"))._tag).toBe(
        "InvalidEntity",
      );
      expect(
        yield* internalFailure(`<!ENTITY e "<b>xxxxxxxx</b>">`, "&e;&e;&e;", {
          maxEntityExpansion: 20,
        }),
      ).toMatchObject({ _tag: "LimitExceeded", limit: "maxEntityExpansion" });
    }),
  );
});

/** The tag, name or data, and span offsets of each recovered event. */
const outline = (input: string, options?: Sax.SaxOptions) =>
  Effect.map(events(input, options), (all) =>
    all.map((e) => [
      e._tag,
      Sax.isStartElement(e) || Sax.isEndElement(e)
        ? e.name
        : Sax.isProcessingInstruction(e)
          ? `${e.target}|${e.data}`
          : Sax.isDoctype(e)
            ? e.name
            : "data" in e
              ? e.data
              : "",
      e.span.start.offset,
      e.span.end.offset,
    ]),
  );

/** Whether every chunk size of `input` gives its whole events and spans (failing the test if not). */
const chunkSafe = (input: string, options: Sax.SaxOptions = {}) =>
  Effect.gen(function* () {
    const whole = yield* tokenized([input], { recover: true, ...options });
    expect(Exit.isSuccess(whole), input).toBe(true);
    yield* Effect.forEach(
      Arr.range(1, input.length),
      (size) =>
        Effect.gen(function* () {
          return expect(
            yield* tokenized(chunked(input, size), { recover: true, ...options }),
            `${input} in chunks of ${size}`,
          ).toStrictEqual(whole);
        }),
      { concurrency: 1, discard: true },
    );
    return true;
  });

/** A recovering `dtd: "internal"` parse's failure, of `<a>body</a>` under an internal subset. */
const internalFailure = (subset: string, body: string, limits: Xml.ParseOptions["limits"] = {}) =>
  Effect.gen(function* () {
    return failure(
      yield* Effect.result(
        Xml.parse(`<!DOCTYPE a [${subset}]><a>${body}</a>`, {
          recover: true,
          dtd: "internal",
          limits,
        }),
      ),
    );
  });

/** A recovering `dtd: "internal"` parse of `<a>body</a>`, serialized without its DOCTYPE. */
const internal = (subset: string, body: string) =>
  Effect.gen(function* () {
    const doc = yield* Xml.parse(`<!DOCTYPE a [${subset}]><a>${body}</a>`, {
      recover: true,
      dtd: "internal",
    });
    return Xml.serializeDocument(doc).replace(/^<!DOCTYPE[^\]]*\]>/, "");
  });

describe("recover: the short end tag `</>`", () => {
  it.effect("closes the element open innermost: an end tag with its name", () =>
    Effect.gen(function* () {
      expect(yield* recovered("<a><b>x</>y</>")).toBe("<a><b>x</b>y</a>");
      expect(yield* recovered("<a><b><c/>x</></a>")).toBe("<a><b><c/>x</b></a>");
      expect(yield* outline("<a><b>x</></>")).toStrictEqual([
        ["StartElement", "a", 0, 3],
        ["StartElement", "b", 3, 6],
        ["Text", "x", 6, 7],
        ["EndElement", "b", 7, 10],
        ["EndElement", "a", 10, 13],
      ]);
      // (`</>` closes the root, which a recovering tree builder keeps open.)
      expect(yield* recovered("<a>x</>z</a>")).toBe("<a>xz</a>");
    }),
  );

  it.effect(
    "closes what the tree builder has open: after a mismatched end tag, and after the root",
    () =>
      Effect.gen(function* () {
        // `</a>` closes `b` and `a`, so `</>` has nothing to close.
        expect((yield* outline("<a><b></a></>")).map(([tag, name]) => [tag, name])).toStrictEqual([
          ["StartElement", "a"],
          ["StartElement", "b"],
          ["EndElement", "a"],
        ]);
        // An end tag that names nothing open closes nothing.
        expect((yield* outline("<a><b></c></>")).at(-1)).toStrictEqual(["EndElement", "b", 10, 13]);
        expect(yield* recovered("<a></a><b>x</>y")).toBe("<a><b>x</b>y</a>");
      }),
  );

  it.effect("is dropped with no element open", () =>
    Effect.gen(function* () {
      expect(yield* outline("</><a/></>")).toStrictEqual([["StartElement", "a", 3, 7]]);
    }),
  );

  it.effect("gives the same events at every chunk size", () =>
    Effect.gen(function* () {
      expect(yield* chunkSafe("<a><b>x</><c>y</></><d></>")).toBe(true);
      expect(yield* chunkSafe("<a><b>x</><c>y</></><d></>", { dtd: "internal" })).toBe(true);
    }),
  );
});

describe("recover: comments with `--` in them", () => {
  it.effect("are comments up to `-->` or `--!>`, as in HTML", () =>
    Effect.gen(function* () {
      expect((yield* outline("<a><!-- a -- b -->c</a>")).slice(1, 3)).toStrictEqual([
        ["Comment", " a -- b ", 3, 18],
        ["Text", "c", 18, 19],
      ]);
      expect((yield* outline("<a><!--a--->b</a>"))[1]).toStrictEqual(["Comment", "a-", 3, 12]);
      expect((yield* outline("<a><!-- x --!>y</a>")).slice(1, 3)).toStrictEqual([
        ["Comment", " x ", 3, 14],
        ["Text", "y", 14, 15],
      ]);
    }),
  );

  it.effect("a comment strict XML reads ends where it does", () =>
    Effect.gen(function* () {
      expect((yield* outline("<a><!---->x--></a>"))[1]).toStrictEqual(["Comment", "", 3, 10]);
      expect((yield* outline("<a><!-->x--></a>"))[1]).toStrictEqual(["Comment", ">x", 3, 12]);
    }),
  );

  it.effect("give the same events at every chunk size", () =>
    Effect.gen(function* () {
      expect(yield* chunkSafe("<a><!-- a -- b -->c<!--x--!>-->d<!---- -->e</a>")).toBe(true);
    }),
  );
});

describe("recover: markup the input ends inside of", () => {
  it.effect("a comment, CDATA section or processing instruction keeps its data", () =>
    Effect.gen(function* () {
      expect(yield* outline("<a>t<!-- x -")).toStrictEqual([
        ["StartElement", "a", 0, 3],
        ["Text", "t", 3, 4],
        ["Comment", " x ", 4, 12],
      ]);
      expect((yield* outline("<a><!-- x --"))[1]).toStrictEqual(["Comment", " x ", 3, 12]);
      expect((yield* outline("<a><!-- x --!"))[1]).toStrictEqual(["Comment", " x ", 3, 13]);
      expect((yield* outline("<a><![CDATA[x]]"))[1]).toStrictEqual(["CData", "x]]", 3, 15]);
      expect((yield* outline("<a><?pi x y?"))[1]).toStrictEqual([
        "ProcessingInstruction",
        "pi|x y",
        3,
        12,
      ]);
      expect(yield* recovered("<a><![CDATA[x")).toBe("<a><![CDATA[x]]></a>");
    }),
  );

  it.effect("a comment `<!-->` or `<!--->` with no end is empty, as in HTML", () =>
    Effect.gen(function* () {
      expect((yield* outline("<a><!-->x")).slice(1)).toStrictEqual([
        ["Comment", "", 3, 8],
        ["Text", "x", 8, 9],
      ]);
      expect((yield* outline("<a><!--->x"))[1]).toStrictEqual(["Comment", "", 3, 9]);
    }),
  );

  it.effect("an unfinished start or end tag is dropped, as in HTML", () =>
    Effect.gen(function* () {
      expect(yield* recovered("<a><b x='1")).toBe("<a/>");
      expect(yield* recovered("<a>t<b x=1 y")).toBe("<a>t</a>");
      expect(yield* recovered("<a><b")).toBe("<a/>");
      expect(yield* recovered("<a><b>x</b")).toBe("<a><b>x</b></a>");
      expect(yield* outline("<a>t</a")).toStrictEqual([
        ["StartElement", "a", 0, 3],
        ["Text", "t", 3, 4],
      ]);
    }),
  );

  it.effect("give the same events at every chunk size", () =>
    Effect.forEach(
      [
        "<a>t<!-- x -- y",
        "<a><!-->x",
        "<a><![CDATA[x]]",
        "<a><?pi x?",
        "<a><?123 x",
        "<?xml version='1.0'",
        "<a>t<b x='1>2",
        "<a>t</a",
        "<!doctype a SYSTEM 'x",
      ],
      (doc) =>
        Effect.gen(function* () {
          return expect(yield* chunkSafe(doc), doc).toBe(true);
        }),
      { concurrency: 1, discard: true },
    ),
  );
});

describe("recover: DOCTYPEs and processing instructions", () => {
  it.effect("a DOCTYPE keyword in any case", () =>
    Effect.gen(function* () {
      const doc = success(yield* recoverResult("<!doctype html><html/>"));
      expect(some(doc.doctype).name).toBe("html");
      const subset = `<!doctype a [<!ENTITY e "E">]><a>&e;</a>`;
      expect(
        success(yield* Effect.result(Xml.parse(subset, { recover: true, dtd: "internal" }))).root
          .textContent,
      ).toBe("E");
    }),
  );

  it.effect("a malformed DOCTYPE as HTML reads it; one with no name is dropped", () =>
    Effect.gen(function* () {
      const xhtml = success(
        yield* recoverResult(`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html/>`),
      );
      expect(some(xhtml.doctype).publicId).toEqual(Option.some("-//W3C//DTD XHTML 1.0 Strict//EN"));
      expect(some(xhtml.doctype).systemId).toEqual(Option.none());
      expect((yield* outline(`<!DOCTYPE a junk><a/>`))[0]).toStrictEqual(["Doctype", "a", 0, 17]);
      expect(yield* outline(`<!DOCTYPE><a/>`)).toStrictEqual([["StartElement", "a", 10, 14]]);
      const event = at(yield* events(`<!doctype a junk>`), 0);
      expect(Sax.isDoctype(event) && event.forceQuirks).toBe(false);
    }),
  );

  it.effect("a processing instruction whose target is a Name keeps it, its data to `?>`", () =>
    Effect.gen(function* () {
      expect((yield* outline("<a><?pi?x?></a>"))[1]).toStrictEqual([
        "ProcessingInstruction",
        "pi|?x",
        3,
        11,
      ]);
      expect((yield* outline("<a><?a:b:c d?></a>"))[1]).toStrictEqual([
        "ProcessingInstruction",
        "a:b:c|d",
        3,
        14,
      ]);
    }),
  );

  it.effect("one whose target is not a Name is a bogus comment up to `>`", () =>
    Effect.gen(function* () {
      expect((yield* outline("<a><?123 x?></a>"))[1]).toStrictEqual(["Comment", "123 x?", 3, 12]);
      expect((yield* outline("<a><? x>y</a>")).slice(1, 3)).toStrictEqual([
        ["Comment", " x", 3, 8],
        ["Text", "y", 8, 9],
      ]);
    }),
  );

  it.effect("a malformed XML declaration is dropped", () =>
    Effect.gen(function* () {
      expect(yield* outline(`<?xml version=1.0?><a/>`)).toStrictEqual([
        ["StartElement", "a", 19, 23],
      ]);
      expect(yield* outline(`<?XML version="1.0"?><a/>`)).toStrictEqual([
        ["StartElement", "a", 21, 25],
      ]);
      expect((yield* outline(`<a><?xml-stylesheet href="x"?></a>`))[1]).toStrictEqual([
        "ProcessingInstruction",
        'xml-stylesheet|href="x"',
        3,
        30,
      ]);
    }),
  );

  it.effect("give the same events at every chunk size", () =>
    Effect.gen(function* () {
      expect(
        yield* chunkSafe(`<?xml version=1.0?><!doctype a PUBLIC "p"><a><?pi?x?><?1 x?><? y></a>`),
      ).toBe(true);
    }),
  );
});

describe("recover: entity replacement text that is not balanced markup", () => {
  it.effect("an element left open is closed at its end", () =>
    Effect.gen(function* () {
      expect(yield* internal(`<!ENTITY e "<b>t">`, "&e;x")).toBe("<a><b>t</b>x</a>");
      expect(yield* internal(`<!ENTITY e "<b><c>t</b>u">`, "&e;")).toBe("<a><b><c>t</c></b>u</a>");
    }),
  );

  it.effect("an end tag for nothing open in it is dropped", () =>
    Effect.gen(function* () {
      expect(yield* internal(`<!ENTITY e "x</a>y">`, "&e;z")).toBe("<a>xyz</a>");
    }),
  );

  it.effect("it is read as recovering content is, its declarations dropped", () =>
    Effect.gen(function* () {
      expect(yield* internal(`<!ENTITY e "<b x=1>AT&#38;T &#38;nbsp;</>">`, "&e;")).toBe(
        `<a><b x="1">AT&amp;T &amp;nbsp;</b></a>`,
      );
      expect(yield* internal(`<!ENTITY e "<?xml version='1.0'?><b/>">`, "&e;")).toBe("<a><b/></a>");
    }),
  );

  it.effect("a reference to an undeclared entity in it is text, as written", () =>
    Effect.gen(function* () {
      expect(yield* internal(`<!ENTITY e "x &u; y">`, "&e;")).toBe("<a>x &amp;u; y</a>");
      expect(yield* internal(`<!ENTITY e "<b>&u;</b>">`, "&e;")).toBe("<a><b>&amp;u;</b></a>");
    }),
  );

  it.effect("an entity whose value is not well-formed is not declared", () =>
    Effect.gen(function* () {
      expect(yield* internal(`<!ENTITY e "a & b"><!ENTITY f "F">`, "&e;&f;")).toBe(
        "<a>&amp;e;F</a>",
      );
    }),
  );

  it.effect("the SAX events of an expansion are balanced", () =>
    Effect.gen(function* () {
      const all = yield* events(`<!DOCTYPE a [<!ENTITY e "<b><c>t</b></d>">]><a>&e;</a>`, {
        dtd: "internal",
      });
      expect(
        all.flatMap((e) =>
          Sax.isStartElement(e) || Sax.isEndElement(e) ? [`${e._tag}:${e.name}`] : [],
        ),
      ).toStrictEqual([
        "StartElement:a",
        "StartElement:b",
        "StartElement:c",
        "EndElement:c",
        "EndElement:b",
        "EndElement:a",
      ]);
    }),
  );
});

describe("recover with `strict: false`", () => {
  it.effect("reads a document strict XML reads directly, and recovers from one it doesn't", () =>
    Effect.forEach(
      [
        `<?xml version="1.0"?><a x="1"><b>t</b><!--c--></a>`,
        `<a x=1>AT&T <b>x</></a>`,
        `<a xmlns:p="urn:p"><p:b/></a><!--after-->`,
        `<a><b x='1`,
      ],
      (doc) =>
        Effect.gen(function* () {
          return expect(
            Xml.serializeDocument(yield* Xml.parse(doc, { recover: true, strict: false })),
            doc,
          ).toBe(yield* recovered(doc));
        }),
      { concurrency: 1, discard: true },
    ),
  );
});

describe("recover: chunk boundaries", () => {
  const document =
    `<?xml version="1.0"?>&amp; lead <![CDATA[c]]>` +
    `<feed xmlns="urn:f"><title>AT&T &nbsp; &#xZZ; &; a < b <</title>` +
    `<link href=http://x/?a=1&b=2 rel=alternate nowrap/>` +
    `<entry x="a<b"y='&c' / z>1 <= 2 ]]> </ x></></entry>` +
    `<!bogus><p>&eacute;t&eacute;</p><!-- a -- b --><?1 x?><?pi?y?><q>q</></feed>` +
    `<?xml version="1.0"?><!DOCTYPE late>tail &amp; <!-- unterminated -- `;

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

  it.effect("with #184's recoveries spliced in, the scanner and the grammars agree", () => {
    // What recovery reads since #184, at a place each document picks, and
    // markup each document is cut off inside of.
    const spliced = ["</>", "<!-- a -- b -->", "<!-- x --!>", "<!doctype a>", "<?1 x?>", "<?p?x?>"];
    const cut = ["<!-- x", "<![CDATA[x", "<?pi x", "<b x='1", "</b"];
    const variants = docs.slice(0, 600).flatMap((doc, i) => {
      const where = (i * 7919) % (doc.length + 1);
      return [
        doc.slice(0, where) + (spliced[i % spliced.length] ?? "") + doc.slice(where),
        doc.slice(0, where) + (cut[i % cut.length] ?? ""),
      ];
    });
    return Effect.forEach(
      variants,
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
    );
  });

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
    // #184
    [
      "<a><b>x</>y</a>",
      "UnexpectedCharacter",
      'Unexpected character ">" at 1:10 while opening an end tag',
    ],
    [
      "<a><!-- a -- b --></a>",
      "UnexpectedCharacter",
      'Unexpected character "-" at 1:11 while reading a comment (only `-->` may contain `--`)',
    ],
    [
      "<a><!-- a --!></a>",
      "UnexpectedCharacter",
      'Unexpected character "-" at 1:11 while reading a comment (only `-->` may contain `--`)',
    ],
    ["<a><!-- x", "UnexpectedEndOfInput", "Unexpected end of input at 1:10 while parsing markup"],
    [
      "<a><![CDATA[x",
      "UnexpectedEndOfInput",
      "Unexpected end of input at 1:14 while parsing markup",
    ],
    [
      "<a><?pi x",
      "MalformedDeclaration",
      'Malformed processing instruction at 1:8: expected ":" or "?>", found " "',
    ],
    ["<a><b x='1", "UnexpectedEndOfInput", "Unexpected end of input at 1:11 while parsing markup"],
    ["<a><b", "UnexpectedEndOfInput", "Unexpected end of input at 1:6 while parsing markup"],
    ["<a></b", "UnexpectedEndOfInput", "Unexpected end of input at 1:7 while parsing markup"],
    [
      "<!doctype a><a/>",
      "MalformedDeclaration",
      'Malformed DOCTYPE at 1:3: expected "DOCTYPE", found "d"',
    ],
    [
      '<!DOCTYPE a PUBLIC "p"><a/>',
      "MalformedDeclaration",
      'Malformed DOCTYPE at 1:23: expected whitespace, found ">"',
    ],
    [
      "<!DOCTYPE><a/>",
      "MalformedDeclaration",
      'Malformed DOCTYPE at 1:10: expected whitespace, found ">"',
    ],
    [
      "<a><?123 x?></a>",
      "MalformedDeclaration",
      'Malformed processing instruction at 1:6: expected processing instruction target, found "1"',
    ],
    [
      "<a><?pi?x?></a>",
      "MalformedDeclaration",
      'Malformed processing instruction at 1:8: expected ":", whitespace or "?>", found "?"',
    ],
    [
      "<?xml version=1.0?><a/>",
      "MalformedDeclaration",
      'Malformed processing instruction at 1:15: expected "\\"" or "\'", found "1"',
    ],
    [
      "<?XML version='1.0'?><a/>",
      "MalformedDeclaration",
      'Malformed processing instruction at 1:3: expected processing instruction target, found "X"',
    ],
  ];

  // The same with `dtd: "internal"`, as on trunk before #184.
  const withDtd: ReadonlyArray<readonly [string, string, string]> = [
    [
      `<!DOCTYPE a [<!ENTITY e "<b>">]><a>&e;</a>`,
      "InvalidEntity",
      'Invalid entity reference "&e;" at 1:36: replacement text is not balanced markup',
    ],
    [
      `<!DOCTYPE a [<!ENTITY e "</a>">]><a>&e;</a>`,
      "InvalidEntity",
      'Invalid entity reference "&e;" at 1:37: replacement text is not balanced markup',
    ],
    [
      `<!DOCTYPE a [<!ENTITY e "x &u; y">]><a>&e;</a>`,
      "InvalidEntity",
      'Invalid entity reference "&e;" at 1:40: unknown entity',
    ],
    [
      `<!DOCTYPE a [<!ENTITY e "a & b">]><a>&e;</a>`,
      "MalformedDeclaration",
      'Malformed DOCTYPE internal subset at 1:1: expected a valid value for entity "e" (invalid reference), found "<"',
    ],
    [
      `<!DOCTYPE a [<!ENTITY e "<?xml version='1.0'?><b/>">]><a>&e;</a>`,
      "InvalidEntity",
      'Invalid entity reference "&e;" at 1:58: Invalid document structure at 1:1: the XML declaration must be at the very start of the document',
    ],
  ];

  it.effect('with `dtd: "internal"`, the same inputs fail with the same errors as before', () =>
    Effect.forEach(
      withDtd,
      ([input, tag, message]) =>
        Effect.gen(function* () {
          const error = failure(yield* Effect.result(Xml.parse(input, { dtd: "internal" })));
          expect([error._tag, error.message], input).toStrictEqual([tag, message]);
          const recovering = yield* Effect.result(
            Xml.parse(input, { recover: true, dtd: "internal" }),
          );
          expect(Result.isSuccess(recovering), input).toBe(true);
        }),
      { concurrency: 1, discard: true },
    ),
  );

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
