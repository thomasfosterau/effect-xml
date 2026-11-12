import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Html } from "../src/index.ts";
import { narrowAt, isHtmlElement, isHtmlText } from "./support/narrow.ts";

const fragment = (input: string, options?: Html.HtmlFragmentOptions) =>
  Html.parseDocumentFragment(input, options);
const html = (input: string, options?: Html.HtmlFragmentOptions) =>
  Effect.gen(function* () {
    return Html.serializeFragment(yield* fragment(input, options));
  });

describe("Html.parseDocumentFragment", () => {
  it.effect("defaults to a body context", () =>
    Effect.gen(function* () {
      expect(yield* html("<p>a<p>b")).toBe("<p>a</p><p>b</p>");
      // No <html> / <head> / <body> is synthesized around the fragment.
      expect(yield* html(" x ")).toBe(" x ");
    }),
  );

  it.effect("the context selects the insertion mode", () =>
    Effect.gen(function* () {
      expect(yield* html("<td>a<td>b", { context: "tr" })).toBe("<td>a</td><td>b</td>");
      expect(yield* html("<tr><td>x", { context: "table" })).toBe(
        "<tbody><tr><td>x</td></tr></tbody>",
      );
      // In a div, table-structure tags are dropped.
      expect(yield* html("<td>a", { context: "div" })).toBe("a");
      expect(yield* html("<option>a<option>b", { context: "select" })).toBe(
        "<option>a</option><option>b</option>",
      );
    }),
  );

  it.effect("an html context builds head and body", () =>
    Effect.gen(function* () {
      expect(yield* html("x", { context: "html" })).toBe("<head></head><body>x</body>");
    }),
  );

  it.effect("raw-text contexts read everything as text", () =>
    Effect.gen(function* () {
      const nodes = yield* fragment("a <b>c</b> &amp; </textarea>", { context: "textarea" });
      expect(nodes).toHaveLength(1);
      // rcdata decodes character references; no end tag is appropriate.
      expect(narrowAt(nodes, 0, isHtmlText).data).toBe("a <b>c</b> & </textarea>");
      const script = yield* fragment("if (a < b) {} </script> &amp;", { context: "script" });
      expect(narrowAt(script, 0, isHtmlText).data).toBe("if (a < b) {} </script> &amp;");
      // Context names are case-insensitive.
      expect((yield* fragment("<i>", { context: "TITLE" }))[0]?._tag).toBe("HtmlText");
    }),
  );

  it.effect("a template context keeps template contents rules", () =>
    Effect.gen(function* () {
      expect(yield* html("<tr><td>x", { context: "template" })).toBe("<tr><td>x</td></tr>");
    }),
  );

  it.effect("a foreign context parses its children as foreign content", () =>
    Effect.gen(function* () {
      const circle = narrowAt(
        yield* fragment("<circle r=1></circle>", { context: "svg svg" }),
        0,
        isHtmlElement,
      );
      expect(circle.namespace).toBe("svg");
      const title = narrowAt(
        yield* fragment("<title>t</title>", { context: "svg svg" }),
        0,
        isHtmlElement,
      );
      expect(title.namespace).toBe("svg");
      // An HTML breakout tag leaves foreign content.
      const p = narrowAt(yield* fragment("<p>x", { context: "math math" }), 0, isHtmlElement);
      expect(p.namespace).toBe("html");
    }),
  );

  it.effect("the lenient parseFragment keeps what parseDocumentFragment drops", () =>
    Effect.gen(function* () {
      const el = narrowAt(yield* Html.parseFragment("<td>a"), 0, isHtmlElement);
      expect(el.name).toBe("td");
    }),
  );

  it.effect("a template's contents are its content fragment", () =>
    Effect.gen(function* () {
      const t = narrowAt(yield* fragment("<template><td>x</td></template>"), 0, isHtmlElement);
      expect(t.children).toEqual([]);
      expect(
        Html.serializeFragment(
          Option.match(t.content, { onNone: () => [], onSome: (c) => c.children }),
        ),
      ).toBe("<td>x</td>");
      expect(Html.serialize(t)).toBe("<template><td>x</td></template>");
    }),
  );
});

describe("the scripting flag", () => {
  const noscript = "<noscript><b>x</b></noscript>";

  it.effect("off (the default): <noscript> content is markup", () =>
    Effect.gen(function* () {
      expect(yield* html(noscript)).toBe("<noscript><b>x</b></noscript>");
    }),
  );

  it.effect("on: <noscript> content is raw text", () =>
    Effect.gen(function* () {
      expect(yield* html(noscript, { scripting: true })).toBe(
        "<noscript>&lt;b&gt;x&lt;/b&gt;</noscript>",
      );
      const doc = yield* Html.parseDocument(noscript, { scripting: true });
      expect(Html.serialize(doc)).toContain(
        "<head><noscript>&lt;b&gt;x&lt;/b&gt;</noscript></head>",
      );
    }),
  );

  it.effect("on: the streaming document parser agrees with the string parser", () =>
    Effect.gen(function* () {
      const input = "<p><noscript><i>a</i></noscript>b</p>";
      const viaString = yield* Html.parseDocument(input, { scripting: true });
      const viaStream = yield* Stream.make("<p><nosc", "ript><i>a</i></nos", "cript>b</p>").pipe(
        Html.parseDocumentStream({ scripting: true }),
      );
      expect(Html.serialize(viaStream)).toBe(Html.serialize(viaString));
    }),
  );
});
