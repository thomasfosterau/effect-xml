import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { isValidName, isValidNCName, Sax } from "../src/index.ts";

const html = (input: string) => Sax.collect(input, { mode: "html" });
const xmlError = (input: string) =>
  Effect.gen(function* () {
    const r = yield* Sax.collect(input).pipe(Effect.result);
    assert(Result.isFailure(r), `expected a failure for ${input}`);
    return r.failure;
  });
/** Assert that each input fails with an error message containing its expected text. */
const rejects = (cases: ReadonlyArray<readonly [input: string, message: string]>) =>
  Effect.forEach(
    cases,
    ([input, message]) =>
      Effect.gen(function* () {
        const e = yield* xmlError(input);
        expect(e.message, input).toContain(message);
      }),
    { concurrency: 1, discard: true },
  );
/** The events of a well-formed document (the promise rejects otherwise). */
const accepts = (input: string) => Sax.collect(input);
/** Events without spans, for comparing structure. */
const withoutSpans = (events: ReadonlyArray<Sax.SaxEvent>) =>
  events.map(({ span: _, ...rest }) => rest);

describe("HTML tokenization follows WHATWG", () => {
  it.effect("`</script/>` is an end tag", () =>
    Effect.gen(function* () {
      expect(withoutSpans(yield* html(`<script>x</script/>y`))).toMatchObject([
        { _tag: "StartElement", name: "script" },
        { _tag: "Text", data: "x" },
        { _tag: "EndElement", name: "script" },
        { _tag: "Text", data: "y" },
      ]);
    }),
  );

  it.effect("`-->` in double-escaped script data returns to plain script data", () =>
    Effect.gen(function* () {
      // `<!--<script>` double-escapes; `-->` ends the escape entirely, so the
      // next `</script>` closes the element.
      const events = yield* html(`<script><!--<script>--><script/</script>after`);
      expect(events.filter(Sax.isText).map((t) => t.data)).toEqual([
        "<!--<script>--><script/",
        "after",
      ]);
    }),
  );

  it.effect("`</script>` inside a double-escaped section does not end the script", () =>
    Effect.gen(function* () {
      const events = yield* html(`<script><!--<script></script>x--></script>`);
      expect(events.filter(Sax.isText).map((t) => t.data)).toEqual(["<!--<script></script>x-->"]);
    }),
  );

  it.effect("`<!>` is an empty bogus comment", () =>
    Effect.gen(function* () {
      expect(withoutSpans(yield* html(`<!>x`))).toEqual([
        { _tag: "Comment", data: "" },
        { _tag: "Text", data: "x" },
      ]);
    }),
  );

  it.effect("`<!--!>` does not close the comment", () =>
    Effect.gen(function* () {
      expect(withoutSpans(yield* html(`<!--!>x`))).toEqual([{ _tag: "Comment", data: "!>x" }]);
    }),
  );

  it.effect("a comment cut short by EOF drops a pending `-`", () =>
    Effect.gen(function* () {
      expect(withoutSpans(yield* html(`<!--a-`))).toEqual([{ _tag: "Comment", data: "a" }]);
    }),
  );

  it.effect("rcdata cut short by EOF is still decoded", () =>
    Effect.gen(function* () {
      const events = yield* html(`<title>a &amp; b`);
      expect(events.filter(Sax.isText).map((t) => t.data)).toEqual(["a & b"]);
    }),
  );

  it.effect("an unterminated quoted attribute at EOF drops the tag", () =>
    Effect.gen(function* () {
      expect(yield* html(`<img alt="><div>`)).toEqual([]);
    }),
  );

  it.effect("DOCTYPE: a keyword must follow the name after whitespace", () =>
    Effect.gen(function* () {
      const [dt] = yield* html(`<!DOCTYPE htmlPUBLIC "x">`);
      expect(dt).toMatchObject({
        _tag: "Doctype",
        name: "htmlPUBLIC",
        publicId: Option.none(),
        systemId: Option.none(),
      });
    }),
  );

  it.effect("DOCTYPE: a `>` inside an identifier ends the DOCTYPE", () =>
    Effect.gen(function* () {
      const events = yield* html(`<!DOCTYPE html PUBLIC "a>b">`);
      expect(withoutSpans(events)).toEqual([
        {
          _tag: "Doctype",
          name: "html",
          publicId: Option.some("a"),
          systemId: Option.none(),
          internalSubset: Option.none(),
          forceQuirks: true,
        },
        { _tag: "Text", data: 'b">' },
      ]);
    }),
  );

  it.effect("raw text and its end tag have the right spans", () =>
    Effect.gen(function* () {
      const events = yield* html(`<title>ab</title>`);
      const text = events.find(Sax.isText);
      const end = events.find(Sax.isEndElement);
      assert.isDefined(text);
      assert.isDefined(end);
      expect([text.span.start.offset, text.span.end.offset]).toEqual([7, 9]);
      expect([end.span.start.offset, end.span.end.offset]).toEqual([9, 17]);
    }),
  );
});

describe("XML tokenization errors", () => {
  it.effect("an entity error in an attribute points at the `&`", () =>
    Effect.gen(function* () {
      const e = yield* xmlError(`<a x="ab&bad;"/>`);
      expect(e._tag).toBe("InvalidEntity");
      expect(e.message).toContain("at 1:9");
    }),
  );

  it.effect("an unexpected astral character is reported whole", () =>
    Effect.gen(function* () {
      const e = yield* xmlError(`<a /😀>`);
      expect(e.message).toContain(`"😀"`);
    }),
  );

  it.effect("comments and literals in the internal subset may contain `]` and `>`", () =>
    Effect.gen(function* () {
      const events = yield* Sax.collect(`<!DOCTYPE r [<!-- ] > --><!ENTITY a "]>">]><r/>`);
      expect(events.find(Sax.isDoctype)?.internalSubset).toEqual(
        Option.some(`<!-- ] > --><!ENTITY a "]>">`),
      );
    }),
  );
});

describe("XML well-formedness", () => {
  it.effect("characters XML does not allow are rejected wherever they are", () =>
    rejects([
      ["<a>\f</a>", "at 1:4 while reading a character XML does not allow"],
      ["<a>x</a><!-- \u001B -->", "at 1:14"],
      [`<a b="\u0000"/>`, "at 1:7"],
      ["<a>\uFFFF</a>", "at 1:4"],
      ["<?pi \uFFFE?><a/>", "at 1:6"],
    ]),
  );

  it.effect("tab, LF and CR are allowed, as are characters beyond the BMP", () =>
    Effect.gen(function* () {
      const events = yield* accepts("<a>\t\r\n\u{1F600}\uFFFD</a>");
      expect(events.find(Sax.isText)?.data).toBe("\t\n\u{1F600}\uFFFD");
    }),
  );

  it.effect("character references must refer to characters XML allows, with a lower-case x", () =>
    rejects([
      ["<a>&#X58;</a>", "Invalid entity reference"],
      ["<a>&#5;</a>", "code point out of range"],
      ["<a>&#x1f;</a>", "code point out of range"],
      [`<a b="&#xFFFE;"/>`, "code point out of range"],
    ]),
  );

  it.effect("comments may not contain `--` or end in `--->`", () =>
    rejects([
      ["<a><!-- a -- b --></a>", "at 1:11 while reading a comment"],
      ["<a><!-- a ---></a>", "at 1:11 while reading a comment"],
    ]),
  );

  it.effect("text may not contain `]]>`", () =>
    rejects([["<a>x ]]> y</a>", `"]" at 1:6 while reading text`]]),
  );

  it.effect(
    "attributes have a name, `=` and a quoted value without `<`, apart from each other",
    () =>
      rejects([
        ["<a b></a>", "at 1:5 while after an attribute name"],
        ["<a b=></a>", "at 1:6 while reading an attribute value"],
        ["<a b=c></a>", "at 1:6 while reading an attribute value"],
        [`<a b="<"></a>`, `"<" at 1:7 while reading an attribute value`],
        [`<a b="1"c="2"></a>`, "at 1:9 while reading a start tag"],
        [`<a b="1" "2"="3"></a>`, "at 1:10 while reading an attribute name"],
        [`<a 1="2"></a>`, `"1" at 1:4 while reading an attribute name`],
      ]),
  );

  it.effect("element names are XML names", () =>
    rejects([[`<a\u00D7></a\u00D7>`, `"×" at 1:3 while reading an element name`]]),
  );

  it.effect("the XML declaration comes first, and only there", () =>
    rejects([
      [` <?xml version="1.0"?><a/>`, "at 1:2: the XML declaration must be at the very start"],
      [`<!-- c --><?xml version="1.0"?><a/>`, "the XML declaration must be at the very start"],
      [`<a><?xml version="1.0"?></a>`, "the XML declaration must be at the very start"],
    ]),
  );

  it.effect("outside the root element there are no references or CDATA sections", () =>
    rejects([
      ["<a/>&#32;", "at 1:5: references are not allowed outside the root element"],
      ["&#32;<a/>", "references are not allowed outside the root element"],
      ["<a/><![CDATA[ ]]>", "CDATA sections are not allowed outside the root element"],
    ]),
  );

  it.effect("a document type declaration comes once, in the prolog (§2.8)", () =>
    rejects([
      [
        "<w><!DOCTYPE html PUBLIC 'a' 'b'><a/></w>",
        "at 1:4: a document type declaration is only allowed once, in the prolog",
      ],
      ["<a/><!DOCTYPE a>", "at 1:5: a document type declaration is only allowed once"],
      ["<!DOCTYPE a><!DOCTYPE a><a/>", "at 1:13: a document type declaration is only allowed once"],
    ]),
  );

  it.effect("a document type declaration may follow the XML declaration, comments and PIs", () =>
    Effect.gen(function* () {
      const events = yield* Sax.collect(`<?xml version="1.0"?><!-- c --><?p?> <!DOCTYPE a><a/>`);
      expect(events.filter(Sax.isDoctype).map((d) => d.name)).toStrictEqual(["a"]);
    }),
  );

  it.effect("references and CDATA sections in an entity's replacement text are content", () =>
    Effect.gen(function* () {
      const events = yield* Sax.collect(
        `<!DOCTYPE a [<!ENTITY e "&#38;amp;<![CDATA[x]]>">]><a>&e;</a>`,
        {
          dtd: "internal",
        },
      );
      expect(events.filter(Sax.isCData).map((c) => c.data)).toStrictEqual(["x"]);
    }),
  );
});

describe("names", () => {
  it("XML names may use characters outside the BMP (#x10000-#xEFFFF)", () => {
    expect(isValidName("x\u{10000}:\u{1F600}")).toBe(true);
    expect(isValidNCName("\u{EFFFF}")).toBe(true);
    expect(isValidNCName("\u{F0000}")).toBe(false);
    expect(isValidName("a:b:c")).toBe(false);
  });
});
