import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { isValidName, isValidNCName, Sax } from "../src/index.ts";

const html = (input: string) => Effect.runPromise(Sax.collect(input, { mode: "html" }));
const xmlError = async (input: string) => {
  const r = await Effect.runPromise(Sax.collect(input).pipe(Effect.result));
  assert(Result.isFailure(r), `expected a failure for ${input}`);
  return r.failure;
};
/** Events without spans, for comparing structure. */
const withoutSpans = (events: ReadonlyArray<Sax.SaxEvent>) =>
  events.map(({ span: _, ...rest }) => rest);

describe("HTML tokenization follows WHATWG", () => {
  test("`</script/>` is an end tag", async () => {
    expect(withoutSpans(await html(`<script>x</script/>y`))).toMatchObject([
      { _tag: "StartElement", name: "script" },
      { _tag: "Text", data: "x" },
      { _tag: "EndElement", name: "script" },
      { _tag: "Text", data: "y" },
    ]);
  });

  test("`-->` in double-escaped script data returns to plain script data", async () => {
    // `<!--<script>` double-escapes; `-->` ends the escape entirely, so the
    // next `</script>` closes the element.
    const events = await html(`<script><!--<script>--><script/</script>after`);
    expect(events.filter(Sax.isText).map((t) => t.data)).toEqual([
      "<!--<script>--><script/",
      "after",
    ]);
  });

  test("`</script>` inside a double-escaped section does not end the script", async () => {
    const events = await html(`<script><!--<script></script>x--></script>`);
    expect(events.filter(Sax.isText).map((t) => t.data)).toEqual(["<!--<script></script>x-->"]);
  });

  test("`<!>` is an empty bogus comment", async () => {
    expect(withoutSpans(await html(`<!>x`))).toEqual([
      { _tag: "Comment", data: "" },
      { _tag: "Text", data: "x" },
    ]);
  });

  test("`<!--!>` does not close the comment", async () => {
    expect(withoutSpans(await html(`<!--!>x`))).toEqual([{ _tag: "Comment", data: "!>x" }]);
  });

  test("a comment cut short by EOF drops a pending `-`", async () => {
    expect(withoutSpans(await html(`<!--a-`))).toEqual([{ _tag: "Comment", data: "a" }]);
  });

  test("rcdata cut short by EOF is still decoded", async () => {
    const events = await html(`<title>a &amp; b`);
    expect(events.filter(Sax.isText).map((t) => t.data)).toEqual(["a & b"]);
  });

  test("an unterminated quoted attribute at EOF drops the tag", async () => {
    expect(await html(`<img alt="><div>`)).toEqual([]);
  });

  test("DOCTYPE: a keyword must follow the name after whitespace", async () => {
    const [dt] = await html(`<!DOCTYPE htmlPUBLIC "x">`);
    expect(dt).toMatchObject({
      _tag: "Doctype",
      name: "htmlPUBLIC",
      publicId: null,
      systemId: null,
    });
  });

  test("DOCTYPE: a `>` inside an identifier ends the DOCTYPE", async () => {
    const events = await html(`<!DOCTYPE html PUBLIC "a>b">`);
    expect(withoutSpans(events)).toEqual([
      { _tag: "Doctype", name: "html", publicId: "a", systemId: null, internalSubset: null },
      { _tag: "Text", data: 'b">' },
    ]);
  });

  test("raw text and its end tag have the right spans", async () => {
    const events = await html(`<title>ab</title>`);
    const text = events.find(Sax.isText);
    const end = events.find(Sax.isEndElement);
    assert.isDefined(text);
    assert.isDefined(end);
    expect([text.span.start.offset, text.span.end.offset]).toEqual([7, 9]);
    expect([end.span.start.offset, end.span.end.offset]).toEqual([9, 17]);
  });
});

describe("XML tokenization errors", () => {
  test("an entity error in an attribute points at the `&`", async () => {
    const e = await xmlError(`<a x="ab&bad;"/>`);
    expect(e._tag).toBe("InvalidEntity");
    expect(e.message).toContain("at 1:9");
  });

  test("an unexpected astral character is reported whole", async () => {
    const e = await xmlError(`<a /😀>`);
    expect(e.message).toContain(`"😀"`);
  });

  test("comments and literals in the internal subset may contain `]` and `>`", async () => {
    const events = await Effect.runPromise(
      Sax.collect(`<!DOCTYPE r [<!-- ] > --><!ENTITY a "]>">]><r/>`),
    );
    expect(events.find(Sax.isDoctype)?.internalSubset).toBe(`<!-- ] > --><!ENTITY a "]>">`);
  });
});

describe("XML well-formedness", () => {
  const rejects = (cases: ReadonlyArray<readonly [input: string, message: string]>) =>
    Promise.all(
      cases.map(async ([input, message]) => {
        const e = await xmlError(input);
        expect(e.message, input).toContain(message);
      }),
    );
  const accepts = (input: string) => Effect.runPromise(Sax.collect(input));

  test("characters XML does not allow are rejected wherever they are", () =>
    rejects([
      ["<a>\f</a>", "at 1:4 while reading a character XML does not allow"],
      ["<a>x</a><!-- \u001B -->", "at 1:14"],
      [`<a b="\u0000"/>`, "at 1:7"],
      ["<a>\uFFFF</a>", "at 1:4"],
      ["<?pi \uFFFE?><a/>", "at 1:6"],
    ]));

  test("tab, LF and CR are allowed, as are characters beyond the BMP", async () => {
    const events = await accepts("<a>\t\r\n\u{1F600}\uFFFD</a>");
    expect(events.find(Sax.isText)?.data).toBe("\t\n\u{1F600}\uFFFD");
  });

  test("character references must refer to characters XML allows, with a lower-case x", () =>
    rejects([
      ["<a>&#X58;</a>", "Invalid entity reference"],
      ["<a>&#5;</a>", "code point out of range"],
      ["<a>&#x1f;</a>", "code point out of range"],
      [`<a b="&#xFFFE;"/>`, "code point out of range"],
    ]));

  test("comments may not contain `--` or end in `--->`", () =>
    rejects([
      ["<a><!-- a -- b --></a>", "at 1:11 while reading a comment"],
      ["<a><!-- a ---></a>", "at 1:11 while reading a comment"],
    ]));

  test("text may not contain `]]>`", () =>
    rejects([["<a>x ]]> y</a>", `"]" at 1:6 while reading text`]]));

  test("attributes have a name, `=` and a quoted value without `<`, apart from each other", () =>
    rejects([
      ["<a b></a>", "at 1:5 while after an attribute name"],
      ["<a b=></a>", "at 1:6 while reading an attribute value"],
      ["<a b=c></a>", "at 1:6 while reading an attribute value"],
      [`<a b="<"></a>`, `"<" at 1:7 while reading an attribute value`],
      [`<a b="1"c="2"></a>`, "at 1:9 while reading a start tag"],
      [`<a b="1" "2"="3"></a>`, "at 1:10 while reading an attribute name"],
      [`<a 1="2"></a>`, `"1" at 1:4 while reading an attribute name`],
    ]));

  test("element names are XML names", () =>
    rejects([[`<a\u00D7></a\u00D7>`, `"×" at 1:3 while reading an element name`]]));

  test("the XML declaration comes first, and only there", () =>
    rejects([
      [` <?xml version="1.0"?><a/>`, "at 1:2: the XML declaration must be at the very start"],
      [`<!-- c --><?xml version="1.0"?><a/>`, "the XML declaration must be at the very start"],
      [`<a><?xml version="1.0"?></a>`, "the XML declaration must be at the very start"],
    ]));

  test("outside the root element there are no references or CDATA sections", () =>
    rejects([
      ["<a/>&#32;", "at 1:5: references are not allowed outside the root element"],
      ["&#32;<a/>", "references are not allowed outside the root element"],
      ["<a/><![CDATA[ ]]>", "CDATA sections are not allowed outside the root element"],
    ]));

  test("references and CDATA sections in an entity's replacement text are content", async () => {
    const events = await Effect.runPromise(
      Sax.collect(`<!DOCTYPE a [<!ENTITY e "&#38;amp;<![CDATA[x]]>">]><a>&e;</a>`, {
        dtd: "internal",
      }),
    );
    expect(events.filter(Sax.isCData).map((c) => c.data)).toStrictEqual(["x"]);
  });
});

describe("names", () => {
  test("XML names may use characters outside the BMP (#x10000-#xEFFFF)", () => {
    expect(isValidName("x\u{10000}:\u{1F600}")).toBe(true);
    expect(isValidNCName("\u{EFFFF}")).toBe(true);
    expect(isValidNCName("\u{F0000}")).toBe(false);
    expect(isValidName("a:b:c")).toBe(false);
  });
});
