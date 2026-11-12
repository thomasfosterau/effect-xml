import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import { Html, Sax, Xml } from "../src/index.ts";
import {
  at,
  htmlChild as child,
  htmlDescendantOrFail,
  isHtmlComment as isComment,
  isHtmlElement,
  templateContent,
} from "./support/narrow.ts";

const doc = (input: string) => Html.parseDocument(input);

// Serialize through the XML DOM (`Html.toXml`), whose empty elements are
// self-closing (`<br/>`); the XML serializer writes the HTML namespace once,
// on <html>.
const html = (input: string) =>
  Html.parseDocument(input).pipe(Effect.map((d) => Xml.serialize(Html.toXml(d).root)));

describe("Html.parseDocument — structure", () => {
  it.effect("synthesizes html/head/body for bare text", () =>
    Effect.gen(function* () {
      const d = yield* doc(`hello`);
      expect(d.documentElement.name).toBe("html");
      expect(d.documentElement.namespace).toBe("html");
      const elementNames = d.documentElement.elements.map((e) => e.name);
      expect(elementNames).toEqual(["head", "body"]);
      const body = child(d.documentElement, "body");
      expect(body.textContent).toBe("hello");
    }),
  );

  it.effect("routes head content into <head> and flow content into <body>", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<title>T</title><p>P</p>`);
      const head = child(d.documentElement, "head");
      const body = child(d.documentElement, "body");
      expect(head.elements.map((e) => e.name)).toEqual(["title"]);
      expect(at(head.elements, 0).textContent).toBe("T");
      expect(body.elements.map((e) => e.name)).toEqual(["p"]);
    }),
  );

  it.effect("captures doctype", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<!DOCTYPE html><p>x</p>`);
      expect(Option.map(d.doctype, (dt) => dt.name)).toEqual(Option.some("html"));
    }),
  );

  it.effect("auto-closes <p> on block-level start tags", () =>
    Effect.gen(function* () {
      const out = yield* html(`<p>1<p>2<div>3</div>`);
      expect(out).toContain("<p>1</p>");
      expect(out).toContain("<p>2</p>");
      expect(out).toContain("<div>3</div>");
    }),
  );

  it.effect("void elements never capture following siblings", () =>
    Effect.gen(function* () {
      const out = yield* html(`<p>a<br>b</p>`);
      expect(out).toContain("<p>a<br/>b</p>");
    }),
  );

  it.effect("lowercases tag and attribute names", () =>
    Effect.gen(function* () {
      const out = yield* html(`<DIV CLASS="x">y</DIV>`);
      expect(out).toContain(`<div class="x">y</div>`);
    }),
  );
});

describe("Html.parseDocument — adoption agency", () => {
  it.effect("misnested formatting tags are repaired", () =>
    Effect.gen(function* () {
      // The canonical example.
      const out = yield* html(`<body><b>1<i>2</b>3</i></body>`);
      const body = child((yield* doc(`<b>1<i>2</b>3</i>`)).documentElement, "body");
      // <b>1<i>2</i></b><i>3</i>
      expect(body.elements.map((e) => e.name)).toEqual(["b", "i"]);
      const b = at(body.elements, 0);
      expect(b.textContent).toBe("12");
      expect(b.elements.map((e) => e.name)).toEqual(["i"]);
      const trailingI = at(body.elements, 1);
      expect(trailingI.textContent).toBe("3");
      void out;
    }),
  );

  it.effect("reconstructs formatting into the furthest block", () =>
    Effect.gen(function* () {
      // <b>1<p>2</b>3  =>  <b>1</b><p><b>2</b>3</p>
      const d = yield* doc(`<b>1<p>2</b>3`);
      const body = child(d.documentElement, "body");
      expect(body.elements.map((e) => e.name)).toEqual(["b", "p"]);
      expect(at(body.elements, 0).textContent).toBe("1");
      const p = at(body.elements, 1);
      const innerB = p.elements.find((e) => e.name === "b");
      expect(innerB).toBeDefined();
      assert.isDefined(innerB);
      expect(innerB.textContent).toBe("2");
      expect(p.textContent).toBe("23");
    }),
  );

  it.effect("handles deeply misnested formatting without looping", () =>
    Effect.gen(function* () {
      const out = yield* html(`<em><b><i>x</em>y</b>z</i>`);
      expect(out).toBeTypeOf("string");
      expect(out).toContain("x");
      expect(out).toContain("y");
      expect(out).toContain("z");
    }),
  );
});

describe("Html.parseDocument — tables", () => {
  it.effect("synthesizes tbody/tr around bare cells", () =>
    Effect.gen(function* () {
      const out = yield* html(`<table><td>x</td></table>`);
      expect(out).toContain("<table><tbody><tr><td>x</td></tr></tbody></table>");
    }),
  );

  it.effect("foster-parents non-table content before the table", () =>
    Effect.gen(function* () {
      // <b><table><td><i></table> => the <b> wraps a table whose cell holds <i>.
      const d = yield* doc(`<b><table><td><i></table>`);
      const body = child(d.documentElement, "body");
      const b = child(body, "b");
      const table = child(b, "table");
      const td = at(at(at(table.elements, 0).elements, 0).elements, 0); // tbody>tr>td
      expect(td.name).toBe("td");
      expect(at(td.elements, 0).name).toBe("i");
    }),
  );

  it.effect("captions and column groups nest correctly", () =>
    Effect.gen(function* () {
      const out = yield* html(
        `<table><caption>C</caption><colgroup><col></colgroup><tr><td>x</table>`,
      );
      expect(out).toContain("<caption>C</caption>");
      expect(out).toContain("<colgroup><col/></colgroup>");
      expect(out).toContain("<tbody><tr><td>x</td></tr></tbody>");
    }),
  );
});

describe("Html.parseDocument — select", () => {
  it.effect("options auto-close their previous sibling", () =>
    Effect.gen(function* () {
      const out = yield* html(`<select><option>a<option>b</select>`);
      expect(out).toContain("<select><option>a</option><option>b</option></select>");
    }),
  );

  it.effect("optgroup closes a previous option and optgroup", () =>
    Effect.gen(function* () {
      const out = yield* html(`<select><optgroup><option>a<optgroup><option>b</select>`);
      expect(out).toContain(
        "<select><optgroup><option>a</option></optgroup><optgroup><option>b</option></optgroup></select>",
      );
    }),
  );

  it.effect("a nested <select> closes the open select", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<select><option>a<select><option>b`);
      const body = child(d.documentElement, "body");
      // second option is a sibling of select, not nested.
      expect(body.elements.map((e) => e.name)).toEqual(["select", "option"]);
    }),
  );

  it.effect("select inside a table drops out on </table>", () =>
    Effect.gen(function* () {
      const out = yield* html(`<table><select><option>x</table>y`);
      expect(out).toContain("<select><option>x</option></select>");
      expect(out).toContain("<table/>");
    }),
  );
});

describe("Html.parseDocument — foreign content", () => {
  const find = htmlDescendantOrFail;

  it.effect("svg/math elements land in their own namespace", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<svg><circle></circle></svg><math><mi>x</mi></math>`);
      const svg = find(d.documentElement, "svg");
      const math = find(d.documentElement, "math");
      expect(svg.namespace).toBe("svg");
      expect(at(svg.elements, 0).namespace).toBe("svg");
      expect(math.namespace).toBe("mathml");
    }),
  );

  it.effect("SVG tag and attribute names are case-corrected", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<svg viewbox="0 0 1 1"><foreignobject></foreignobject></svg>`);
      const svg = find(d.documentElement, "svg");
      expect(at(svg.attributes, 0).name).toBe("viewBox");
      expect(at(svg.elements, 0).name).toBe("foreignObject");
    }),
  );

  it.effect("xlink/xml attributes get their foreign namespaces", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<svg><a xlink:href="u" xml:lang="en"></a></svg>`);
      const a = find(d.documentElement, "a");
      const xlink = a.attributes.find((x) => x.name === "href");
      const xml = a.attributes.find((x) => x.name === "lang");
      assert.isDefined(xlink);
      assert.isDefined(xml);
      expect(xlink.namespace).toEqual(Option.some("xlink"));
      expect(xlink.prefix).toEqual(Option.some("xlink"));
      expect(xlink.qualifiedName).toBe("xlink:href");
      expect(a.attribute("xlink:href")).toEqual(Option.some("u"));
      expect(xml.namespace).toEqual(Option.some("xml"));
      // The XML DOM places them in their namespace URIs.
      const converted = Html.toXml(a);
      const href = converted.attributes.find((x) => x.name.local === "href");
      expect(href?.name.namespace).toEqual(Option.some(Html.XLINK_NS));
      expect(href?.name.prefix).toEqual(Option.some("xlink"));
    }),
  );

  it.effect("breakout tags return to HTML content", () =>
    Effect.gen(function* () {
      // <p> is a breakout tag: it closes the SVG subtree.
      const d = yield* doc(`<svg><p>after`);
      const body = child(d.documentElement, "body");
      const names = body.elements.map((e) => e.name);
      expect(names).toEqual(["svg", "p"]);
      expect(at(body.elements, 1).namespace).toBe("html");
    }),
  );
});

const tpl = (root: Html.HtmlElement) => htmlDescendantOrFail(root, "template");
const names = (nodes: ReadonlyArray<Html.HtmlNode>) =>
  nodes.filter(isHtmlElement).map((e) => e.name);
const mode = (input: string) =>
  Effect.gen(function* () {
    return (yield* doc(input)).mode;
  });

describe("Html.parseDocument — template", () => {
  it.effect("a bare <template> lands in <head> and holds its contents", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<template><div>x</div></template>`);
      const head = child(d.documentElement, "head");
      const t = tpl(head);
      // The contents are a separate fragment, not the template's children.
      expect(t.children).toEqual([]);
      expect(names(templateContent(t))).toEqual(["div"]);
      const div = at(templateContent(t), 0);
      assert(isHtmlElement(div));
      expect(div.textContent).toBe("x");
      // As in the DOM, template contents are not descendants or text content.
      expect(head.descendants("div")).toEqual([]);
      expect(head.textContent).toBe("");
    }),
  );

  it.effect("only HTML templates have contents", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<template></template><svg><template><g/></template></svg>`);
      expect(Option.map(tpl(d.documentElement).content, (c) => c.children)).toEqual(
        Option.some([]),
      );
      const svgTemplate = htmlDescendantOrFail(child(d.documentElement, "body"), "template");
      expect(svgTemplate.namespace).toBe("svg");
      expect(svgTemplate.content).toEqual(Option.none());
      expect(names(svgTemplate.children)).toEqual(["g"]);
    }),
  );

  it.effect("content is not wrapped in a synthesized <body>", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<head><template><div></div></template></head>`);
      expect(names(templateContent(tpl(d.documentElement)))).toEqual(["div"]);
    }),
  );

  it.effect("table sections are allowed directly inside template content", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<template><tr><td>c</td></tr></template>`);
      // tr is kept (no enclosing <table> is synthesized for template contents)
      expect(names(templateContent(tpl(d.documentElement)))).toContain("tr");
    }),
  );

  it.effect("</template> closes the template and restores the prior mode", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<body><template><div></div></template><p>after`);
      const body = child(d.documentElement, "body");
      expect(body.elements.map((e) => e.name)).toEqual(["template", "p"]);
    }),
  );

  it.effect("Html.serialize writes the contents; Html.toXml makes them children", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<template><b>x</b></template>`);
      expect(Html.serialize(d)).toBe(
        "<html><head><template><b>x</b></template></head><body></body></html>",
      );
      expect(Xml.serialize(Html.toXml(tpl(d.documentElement)))).toBe(
        "<template><b>x</b></template>",
      );
    }),
  );
});

describe("Html.parseDocument — document mode", () => {
  it.effect("no DOCTYPE, or a legacy one, is quirks mode", () =>
    Effect.gen(function* () {
      expect(yield* mode("<p>x")).toBe("quirks");
      expect(yield* mode("<!DOCTYPE foo><p>x")).toBe("quirks");
      expect(yield* mode(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">`)).toBe("quirks");
      expect(yield* mode(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">`)).toBe(
        "quirks",
      );
    }),
  );

  it.effect("the tokenizer's force-quirks flag makes an html DOCTYPE quirks", () =>
    Effect.gen(function* () {
      expect(yield* mode("<!DOCTYPE html bogus><p>x")).toBe("quirks");
      expect(yield* mode("<!DOCTYPE html")).toBe("quirks");
      expect(yield* mode(`<!DOCTYPE html PUBLIC>`)).toBe("quirks");
      expect(yield* mode(`<!DOCTYPE html SYSTEM "about:legacy-compat`)).toBe("quirks");
      expect(yield* mode(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN>`)).toBe("quirks");
      // A bogus tail after the system identifier leaves the flag unset.
      expect(yield* mode(`<!DOCTYPE html SYSTEM "about:legacy-compat" x>`)).toBe("no-quirks");
    }),
  );

  it.effect("XHTML 1.0 and HTML 4.01 transitional with a system id are limited-quirks", () =>
    Effect.gen(function* () {
      expect(
        yield* mode(
          `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ` +
            `"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">`,
        ),
      ).toBe("limited-quirks");
      expect(
        yield* mode(
          `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" ` +
            `"http://www.w3.org/TR/html4/loose.dtd">`,
        ),
      ).toBe("limited-quirks");
    }),
  );

  it.effect("<!DOCTYPE html> and HTML 4.01 strict are no-quirks", () =>
    Effect.gen(function* () {
      expect(yield* mode("<!DOCTYPE html>")).toBe("no-quirks");
      expect(yield* mode("<!doctype HTML>")).toBe("no-quirks");
      expect(
        yield* mode(
          `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">`,
        ),
      ).toBe("no-quirks");
    }),
  );

  it.effect("in quirks mode <table> does not close an open <p>", () =>
    Effect.gen(function* () {
      expect(yield* html("<p><table></table>")).toContain("<p><table/></p>");
      expect(yield* html("<!DOCTYPE html><p><table></table>")).toContain("<p/><table/>");
    }),
  );

  it.effect("a fragment is parsed in no-quirks mode", () =>
    Effect.gen(function* () {
      const nodes = yield* Html.parseDocumentFragment("<p><table></table>");
      expect(Html.serializeFragment(nodes)).toBe("<p></p><table></table>");
    }),
  );

  it.effect("the DOCTYPE's absent identifiers are empty strings", () =>
    Effect.gen(function* () {
      const d = yield* doc("<!DOCTYPE html>");
      expect(d.doctype).toEqual(
        Option.some(new Html.HtmlDoctype({ name: "html", publicId: "", systemId: "" })),
      );
    }),
  );
});

describe("Html.parseDocument — frameset", () => {
  it.effect("a frameset document has no body", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<frameset><frame><frame></frameset>`);
      const elementNames = d.documentElement.elements.map((e) => e.name);
      expect(elementNames).toEqual(["head", "frameset"]);
      const fs = child(d.documentElement, "frameset");
      expect(fs.elements.map((e) => e.name)).toEqual(["frame", "frame"]);
    }),
  );

  it.effect("an explicit <body> makes the document no longer frameset-ok", () =>
    Effect.gen(function* () {
      // <body> clears frameset-ok, so the later <frameset> is ignored.
      const d = yield* doc(`<body><frameset></frameset>`);
      expect(d.documentElement.elements.map((e) => e.name)).toEqual(["head", "body"]);
    }),
  );

  it.effect("a frameset right after </head> replaces the (absent) body", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<head></head><frameset></frameset>`);
      expect(d.documentElement.elements.map((e) => e.name)).toEqual(["head", "frameset"]);
    }),
  );

  it.effect("real content makes the document no longer frameset-ok", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<body><p>x<frameset></frameset>`);
      const elementNames = d.documentElement.elements.map((e) => e.name);
      expect(elementNames).toEqual(["head", "body"]);
    }),
  );

  it.effect("nested framesets and after-frameset comments", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<frameset><frameset></frameset></frameset></html><!--c-->`);
      // the trailing comment lands at the document level, after <html>
      const comment = d.children.find(isComment);
      expect(comment).toBeDefined();
      assert.isDefined(comment);
      expect(comment.data).toBe("c");
    }),
  );
});

describe("Html.parseDocument — robustness", () => {
  it.effect("never throws on garbage", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<<>></p></div><b><b><b>x`);
      expect(d.documentElement.name).toBe("html");
    }),
  );

  it.effect("abruptly-closed comments are empty (<!-->)", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<!--><p>x`);
      // The comment is empty and lives before <html>.
      const comment = d.children.find(isComment);
      expect(comment).toBeDefined();
      assert.isDefined(comment);
      expect(comment.data).toBe("");
    }),
  );

  it.effect("a processing instruction event becomes a comment", () =>
    Effect.gen(function* () {
      // The XML tokenizer reports `<?php echo 1?>` as a processing instruction;
      // tree construction makes the comment the HTML tokenizer would have.
      const d = yield* Html.buildDocument(Sax.tokenizeString(`<?php echo 1?><p>x`));
      const comment = d.children.find(isComment);
      expect(comment?.data).toBe("?php echo 1?");
    }),
  );

  it.effect("<? opens a bogus comment in HTML", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<?php echo 1?>`);
      const comment = d.children.find(isComment);
      expect(comment?.data).toBe("?php echo 1?");
    }),
  );

  it.effect("stray end tags are ignored", () =>
    Effect.gen(function* () {
      const out = yield* html(`<div>a</span>b</div>`);
      expect(out).toContain("<div>ab</div>");
    }),
  );

  it.effect("implied list item closing", () =>
    Effect.gen(function* () {
      const d = yield* doc(`<ul><li>1<li>2</ul>`);
      const body = child(d.documentElement, "body");
      const ul = child(body, "ul");
      expect(ul.elements.map((e) => e.name)).toEqual(["li", "li"]);
      expect(ul.elements.map((e) => e.textContent)).toEqual(["1", "2"]);
    }),
  );
});

describe("Html round trips", () => {
  const inputs = [
    `<!DOCTYPE html><title>T</title><p class=x>a<b>b<i>c</b>d</i><!-- c -->`,
    `<!DOCTYPE html><table><caption>c<tr><td>1<td>2</table><ul><li>a<li>b</ul>`,
    `<!DOCTYPE html><template><tr><td>x</template><select><option>a<option selected>b</select>`,
    `<!DOCTYPE html><svg viewBox="0 0 1 1"><a xlink:href="#u"><foreignObject><p>x</p></foreignObject></a></svg><math><mi>y</mi></math>`,
    `<!DOCTYPE html><script>if (a < b) {}</script><textarea>&lt;x&gt;</textarea><pre>line</pre>`,
  ];

  const docs = () => Effect.forEach(inputs, doc, { concurrency: 1 });

  it.effect("parsing a serialized document gives back an equal document", () =>
    Effect.gen(function* () {
      const firsts = yield* docs();
      const agains = yield* Effect.forEach(firsts, (first) => doc(Html.serialize(first)), {
        concurrency: 1,
      });
      expect(agains.map((d) => Html.serialize(d))).toEqual(firsts.map((d) => Html.serialize(d)));
      firsts.forEach((first, i) => expect(Eq.equals(agains[i], first)).toBe(true));
    }),
  );

  // WHATWG serializing HTML fragments: no extra U+000A is written for these
  // elements (whatwg/html#944), so the parser's dropped leading newline is not
  // restored and the round trip loses one newline.
  it.effect.each(["pre", "textarea", "listing"])(
    "a leading newline in <%s> is not doubled on serialization",
    (name) =>
      Effect.gen(function* () {
        const first = yield* doc(`<!DOCTYPE html><${name}>\n\nHello.</${name}>`);
        const body = child(first.documentElement, "body");
        expect(Html.serializeFragment(body.children)).toBe(`<${name}>\nHello.</${name}>`);
        const again = yield* doc(Html.serialize(first));
        expect(child(child(again.documentElement, "body"), name).textContent).toBe("Hello.");
      }),
  );

  it.effect("Html.toXml is structural: equal documents convert to equal XML documents", () =>
    Effect.gen(function* () {
      const [as, bs] = yield* Effect.all([docs(), docs()], { concurrency: 1 });
      as.forEach((a, i) => {
        const b = at(bs, i);
        expect(a).not.toBe(b);
        expect(Eq.equals(Html.toXml(a), Html.toXml(b))).toBe(true);
        // Every node converts the same alone as inside its document.
        const body = child(a.documentElement, "body");
        expect(Html.toXml(body.children)).toEqual(
          Html.toXml(a).root.elements.find((e) => e.name.local === "body")?.children,
        );
      });
    }),
  );
});

describe("Html.parseDocument — <noscript> in <head>, scripting off", () => {
  it.effect("head content stays in it; anything else closes it", () =>
    Effect.gen(function* () {
      const d = yield* doc(
        `<html><head><noscript><link rel=a><meta charset=utf-8><basefont><bgsound>` +
          `<style>s</style><noframes>n</noframes><html lang=en><head><noscript><p>x`,
      );
      expect(Html.serialize(d)).toBe(
        `<html lang="en"><head><noscript><link rel="a"><meta charset="utf-8"><basefont><bgsound>` +
          `<style>s</style><noframes>n</noframes></noscript></head><body><p>x</p></body></html>`,
      );
    }),
  );
});
