import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Html } from "../src/index.ts";
import { at, isElement, narrowAt } from "./support/narrow.ts";

const frag = (input: string) => Effect.runPromise(Html.parseFragment(input));
const drain = (input: string) =>
  Effect.runPromise(
    Html.events(input).pipe(
      Stream.runDrain,
      Effect.catch(() => Effect.void),
    ),
  );

describe("Html tokenization (lenient)", () => {
  test("unquoted and boolean attributes", async () => {
    const el = narrowAt(await frag(`<input type=text disabled>`), 0, isElement);
    expect(el.name.qualified).toBe("input");
    expect(el.attribute("type")).toBe("text");
    expect(el.attribute("disabled")).toBe("");
  });

  test("bare '<' is treated as text, not an error", async () => {
    const nodes = await frag(`<p>1 < 2</p>`);
    expect(nodes[0]?._tag).toBe("XmlElement");
    const p = narrowAt(nodes, 0, isElement);
    expect(p.textContent).toBe("1 < 2");
  });

  test("raw text element keeps '<' and '&' verbatim", async () => {
    const nodes = await frag(`<script>if (a < b && c > d) {}</script>`);
    expect(nodes[0]?._tag).toBe("XmlElement");
    const script = narrowAt(nodes, 0, isElement);
    expect(script.name.qualified).toBe("script");
    expect(script.textContent).toBe("if (a < b && c > d) {}");
  });

  test("rcdata element decodes entities but keeps markup-ish text", async () => {
    const nodes = await frag(`<title>A &amp; B</title>`);
    const title = narrowAt(nodes, 0, isElement);
    expect(title.textContent).toBe("A & B");
  });
});

describe("Html lenient tree building", () => {
  test("void elements do not capture following content", async () => {
    const nodes = await frag(`<p>a<br>b</p>`);
    const p = narrowAt(nodes, 0, isElement);
    expect(p.children.map((c) => c._tag)).toEqual(["XmlText", "XmlElement", "XmlText"]);
    expect(at(p.elements, 0).name.qualified).toBe("br");
    expect(at(p.elements, 0).children.length).toBe(0);
  });

  test("auto-closes implied tags on mismatched end tag", async () => {
    const nodes = await frag(`<p>x<b>bold</p>`);
    const p = narrowAt(nodes, 0, isElement);
    // <b> is auto-closed when </p> is seen
    expect(p.name.qualified).toBe("p");
    const b = p.elements.find((e) => e.name.qualified === "b");
    expect(b?.textContent).toBe("bold");
  });

  test("stray end tags are ignored", async () => {
    const nodes = await frag(`</x><a>hi</a>`);
    expect(nodes.length).toBe(1);
    expect(narrowAt(nodes, 0, isElement).name.qualified).toBe("a");
  });

  test("tag names are lowercased", async () => {
    const nodes = await frag(`<DIV><SPAN/></DIV>`);
    const div = narrowAt(nodes, 0, isElement);
    expect(div.name.qualified).toBe("div");
    expect(at(div.elements, 0).name.qualified).toBe("span");
  });

  test("never fails on malformed input", async () => {
    await drain(`<<>><p attr=<>`);
    const nodes = await frag(`<a><b></c></a><<`);
    expect(Array.isArray(nodes)).toBe(true);
  });
});
