import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Html } from "../src/index.ts";
import { at, isHtmlElement as isElement, narrowAt } from "./support/narrow.ts";

const frag = (input: string) => Html.parseFragment(input);
const drain = (input: string) => Html.events(input).pipe(Stream.runDrain, Effect.ignore);

describe("Html tokenization (lenient)", () => {
  it.effect("unquoted and boolean attributes", () =>
    Effect.gen(function* () {
      const el = narrowAt(yield* frag(`<input type=text disabled>`), 0, isElement);
      expect(el.name).toBe("input");
      expect(el.attribute("type")).toEqual(Option.some("text"));
      expect(el.attribute("disabled")).toEqual(Option.some(""));
    }),
  );

  it.effect("bare '<' is treated as text, not an error", () =>
    Effect.gen(function* () {
      const nodes = yield* frag(`<p>1 < 2</p>`);
      expect(nodes[0]?._tag).toBe("HtmlElement");
      const p = narrowAt(nodes, 0, isElement);
      expect(p.textContent).toBe("1 < 2");
    }),
  );

  it.effect("raw text element keeps '<' and '&' verbatim", () =>
    Effect.gen(function* () {
      const nodes = yield* frag(`<script>if (a < b && c > d) {}</script>`);
      expect(nodes[0]?._tag).toBe("HtmlElement");
      const script = narrowAt(nodes, 0, isElement);
      expect(script.name).toBe("script");
      expect(script.textContent).toBe("if (a < b && c > d) {}");
    }),
  );

  it.effect("rcdata element decodes entities but keeps markup-ish text", () =>
    Effect.gen(function* () {
      const nodes = yield* frag(`<title>A &amp; B</title>`);
      const title = narrowAt(nodes, 0, isElement);
      expect(title.textContent).toBe("A & B");
    }),
  );
});

describe("Html lenient tree building", () => {
  it.effect("void elements do not capture following content", () =>
    Effect.gen(function* () {
      const nodes = yield* frag(`<p>a<br>b</p>`);
      const p = narrowAt(nodes, 0, isElement);
      expect(p.children.map((c) => c._tag)).toEqual(["HtmlText", "HtmlElement", "HtmlText"]);
      expect(at(p.elements, 0).name).toBe("br");
      expect(at(p.elements, 0).children.length).toBe(0);
    }),
  );

  it.effect("auto-closes implied tags on mismatched end tag", () =>
    Effect.gen(function* () {
      const nodes = yield* frag(`<p>x<b>bold</p>`);
      const p = narrowAt(nodes, 0, isElement);
      // <b> is auto-closed when </p> is seen
      expect(p.name).toBe("p");
      const b = p.elements.find((e) => e.name === "b");
      expect(b?.textContent).toBe("bold");
    }),
  );

  it.effect("stray end tags are ignored", () =>
    Effect.gen(function* () {
      const nodes = yield* frag(`</x><a>hi</a>`);
      expect(nodes.length).toBe(1);
      expect(narrowAt(nodes, 0, isElement).name).toBe("a");
    }),
  );

  it.effect("tag names are lowercased", () =>
    Effect.gen(function* () {
      const nodes = yield* frag(`<DIV><SPAN/></DIV>`);
      const div = narrowAt(nodes, 0, isElement);
      expect(div.name).toBe("div");
      expect(at(div.elements, 0).name).toBe("span");
    }),
  );

  it.effect("elements are HTML, attributes in no namespace", () =>
    Effect.gen(function* () {
      const svg = narrowAt(
        yield* frag(`<svg viewBox="0 0 1 1"><a xlink:href=u /></svg>`),
        0,
        isElement,
      );
      expect(svg.namespace).toBe("html");
      expect(svg.attributes.map((a) => [a.name, a.namespace])).toEqual([
        ["viewbox", Option.none()],
      ]);
      expect(at(svg.elements, 0).attribute("xlink:href")).toEqual(Option.some("u"));
    }),
  );

  it.effect(
    "CDATA becomes text merged with its neighbours; a processing instruction a comment",
    () =>
      Effect.gen(function* () {
        const p = narrowAt(yield* frag(`<p>a<![CDATA[<b>]]>c<?pi d?></p>`), 0, isElement);
        expect(p.children.map((c) => c._tag)).toEqual(["HtmlText", "HtmlComment"]);
        expect(p.textContent).toBe("a<b>c");
      }),
  );

  it.effect("never fails on malformed input", () =>
    Effect.gen(function* () {
      yield* drain(`<<>><p attr=<>`);
      const nodes = yield* frag(`<a><b></c></a><<`);
      expect(Array.isArray(nodes)).toBe(true);
    }),
  );
});
