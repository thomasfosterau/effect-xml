import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Html } from "../src/index.ts";
import { narrowAt, isHtmlElement, isHtmlText } from "./support/narrow.ts";

const fragment = (input: string, options?: Html.HtmlFragmentOptions) =>
  Effect.runSync(Html.parseDocumentFragment(input, options));
const html = (input: string, options?: Html.HtmlFragmentOptions) =>
  Html.serializeFragment(fragment(input, options));

describe("Html.parseDocumentFragment", () => {
  test("defaults to a body context", () => {
    expect(html("<p>a<p>b")).toBe("<p>a</p><p>b</p>");
    // No <html> / <head> / <body> is synthesized around the fragment.
    expect(html(" x ")).toBe(" x ");
  });

  test("the context selects the insertion mode", () => {
    expect(html("<td>a<td>b", { context: "tr" })).toBe("<td>a</td><td>b</td>");
    expect(html("<tr><td>x", { context: "table" })).toBe("<tbody><tr><td>x</td></tr></tbody>");
    // In a div, table-structure tags are dropped.
    expect(html("<td>a", { context: "div" })).toBe("a");
    expect(html("<option>a<option>b", { context: "select" })).toBe(
      "<option>a</option><option>b</option>",
    );
  });

  test("an html context builds head and body", () => {
    expect(html("x", { context: "html" })).toBe("<head></head><body>x</body>");
  });

  test("raw-text contexts read everything as text", () => {
    const nodes = fragment("a <b>c</b> &amp; </textarea>", { context: "textarea" });
    expect(nodes).toHaveLength(1);
    // rcdata decodes character references; no end tag is appropriate.
    expect(narrowAt(nodes, 0, isHtmlText).data).toBe("a <b>c</b> & </textarea>");
    const script = fragment("if (a < b) {} </script> &amp;", { context: "script" });
    expect(narrowAt(script, 0, isHtmlText).data).toBe("if (a < b) {} </script> &amp;");
    // Context names are case-insensitive.
    expect(fragment("<i>", { context: "TITLE" })[0]?._tag).toBe("HtmlText");
  });

  test("a template context keeps template contents rules", () => {
    expect(html("<tr><td>x", { context: "template" })).toBe("<tr><td>x</td></tr>");
  });

  test("a foreign context parses its children as foreign content", () => {
    const circle = narrowAt(
      fragment("<circle r=1></circle>", { context: "svg svg" }),
      0,
      isHtmlElement,
    );
    expect(circle.namespace).toBe("svg");
    const title = narrowAt(fragment("<title>t</title>", { context: "svg svg" }), 0, isHtmlElement);
    expect(title.namespace).toBe("svg");
    // An HTML breakout tag leaves foreign content.
    const p = narrowAt(fragment("<p>x", { context: "math math" }), 0, isHtmlElement);
    expect(p.namespace).toBe("html");
  });

  test("the lenient parseFragment keeps what parseDocumentFragment drops", () => {
    const el = narrowAt(Effect.runSync(Html.parseFragment("<td>a")), 0, isHtmlElement);
    expect(el.name).toBe("td");
  });

  test("a template's contents are its content fragment", () => {
    const t = narrowAt(fragment("<template><td>x</td></template>"), 0, isHtmlElement);
    expect(t.children).toEqual([]);
    expect(Html.serializeFragment(t.content?.children ?? [])).toBe("<td>x</td>");
    expect(Html.serialize(t)).toBe("<template><td>x</td></template>");
  });
});

describe("the scripting flag", () => {
  const noscript = "<noscript><b>x</b></noscript>";

  test("off (the default): <noscript> content is markup", () => {
    expect(html(noscript)).toBe("<noscript><b>x</b></noscript>");
  });

  test("on: <noscript> content is raw text", () => {
    expect(html(noscript, { scripting: true })).toBe("<noscript>&lt;b&gt;x&lt;/b&gt;</noscript>");
    const doc = Effect.runSync(Html.parseDocument(noscript, { scripting: true }));
    expect(Html.serialize(doc)).toContain("<head><noscript>&lt;b&gt;x&lt;/b&gt;</noscript></head>");
  });

  test("on: the streaming document parser agrees with the string parser", () => {
    const input = "<p><noscript><i>a</i></noscript>b</p>";
    const viaString = Effect.runSync(Html.parseDocument(input, { scripting: true }));
    const viaStream = Effect.runSync(
      Stream.make("<p><nosc", "ript><i>a</i></nos", "cript>b</p>").pipe(
        Html.parseDocumentStream({ scripting: true }),
      ),
    );
    expect(Html.serialize(viaStream)).toBe(Html.serialize(viaString));
  });
});
