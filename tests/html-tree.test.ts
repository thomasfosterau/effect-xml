import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import { Html, Sax, Xml } from "../src/index.ts";
import {
  at,
  htmlChild as child,
  htmlDescendantOrFail,
  isHtmlComment as isComment,
  isHtmlElement,
  templateContent,
} from "./support/narrow.ts";

const doc = (input: string) => Effect.runPromise(Html.parseDocument(input));

// Serialize through the XML DOM (`Html.toXml`), whose empty elements are
// self-closing (`<br/>`); the XML serializer writes the HTML namespace once,
// on <html>.
const html = (input: string) =>
  Effect.runPromise(
    Html.parseDocument(input).pipe(Effect.map((d) => Xml.serialize(Html.toXml(d).root))),
  );

describe("Html.parseDocument — structure", () => {
  test("synthesizes html/head/body for bare text", async () => {
    const d = await doc(`hello`);
    expect(d.documentElement.name).toBe("html");
    expect(d.documentElement.namespace).toBe("html");
    const names = d.documentElement.elements.map((e) => e.name);
    expect(names).toEqual(["head", "body"]);
    const body = child(d.documentElement, "body");
    expect(body.textContent).toBe("hello");
  });

  test("routes head content into <head> and flow content into <body>", async () => {
    const d = await doc(`<title>T</title><p>P</p>`);
    const head = child(d.documentElement, "head");
    const body = child(d.documentElement, "body");
    expect(head.elements.map((e) => e.name)).toEqual(["title"]);
    expect(at(head.elements, 0).textContent).toBe("T");
    expect(body.elements.map((e) => e.name)).toEqual(["p"]);
  });

  test("captures doctype", async () => {
    const d = await doc(`<!DOCTYPE html><p>x</p>`);
    expect(d.doctype?.name).toBe("html");
  });

  test("auto-closes <p> on block-level start tags", async () => {
    const out = await html(`<p>1<p>2<div>3</div>`);
    expect(out).toContain("<p>1</p>");
    expect(out).toContain("<p>2</p>");
    expect(out).toContain("<div>3</div>");
  });

  test("void elements never capture following siblings", async () => {
    const out = await html(`<p>a<br>b</p>`);
    expect(out).toContain("<p>a<br/>b</p>");
  });

  test("lowercases tag and attribute names", async () => {
    const out = await html(`<DIV CLASS="x">y</DIV>`);
    expect(out).toContain(`<div class="x">y</div>`);
  });
});

describe("Html.parseDocument — adoption agency", () => {
  test("misnested formatting tags are repaired", async () => {
    // The canonical example.
    const out = await html(`<body><b>1<i>2</b>3</i></body>`);
    const body = child((await doc(`<b>1<i>2</b>3</i>`)).documentElement, "body");
    // <b>1<i>2</i></b><i>3</i>
    expect(body.elements.map((e) => e.name)).toEqual(["b", "i"]);
    const b = at(body.elements, 0);
    expect(b.textContent).toBe("12");
    expect(b.elements.map((e) => e.name)).toEqual(["i"]);
    const trailingI = at(body.elements, 1);
    expect(trailingI.textContent).toBe("3");
    void out;
  });

  test("reconstructs formatting into the furthest block", async () => {
    // <b>1<p>2</b>3  =>  <b>1</b><p><b>2</b>3</p>
    const d = await doc(`<b>1<p>2</b>3`);
    const body = child(d.documentElement, "body");
    expect(body.elements.map((e) => e.name)).toEqual(["b", "p"]);
    expect(at(body.elements, 0).textContent).toBe("1");
    const p = at(body.elements, 1);
    const innerB = p.elements.find((e) => e.name === "b");
    expect(innerB).toBeDefined();
    assert.isDefined(innerB);
    expect(innerB.textContent).toBe("2");
    expect(p.textContent).toBe("23");
  });

  test("handles deeply misnested formatting without looping", async () => {
    const out = await html(`<em><b><i>x</em>y</b>z</i>`);
    expect(out).toBeTypeOf("string");
    expect(out).toContain("x");
    expect(out).toContain("y");
    expect(out).toContain("z");
  });
});

describe("Html.parseDocument — tables", () => {
  test("synthesizes tbody/tr around bare cells", async () => {
    const out = await html(`<table><td>x</td></table>`);
    expect(out).toContain("<table><tbody><tr><td>x</td></tr></tbody></table>");
  });

  test("foster-parents non-table content before the table", async () => {
    // <b><table><td><i></table> => the <b> wraps a table whose cell holds <i>.
    const d = await doc(`<b><table><td><i></table>`);
    const body = child(d.documentElement, "body");
    const b = child(body, "b");
    const table = child(b, "table");
    const td = at(at(at(table.elements, 0).elements, 0).elements, 0); // tbody>tr>td
    expect(td.name).toBe("td");
    expect(at(td.elements, 0).name).toBe("i");
  });

  test("captions and column groups nest correctly", async () => {
    const out = await html(
      `<table><caption>C</caption><colgroup><col></colgroup><tr><td>x</table>`,
    );
    expect(out).toContain("<caption>C</caption>");
    expect(out).toContain("<colgroup><col/></colgroup>");
    expect(out).toContain("<tbody><tr><td>x</td></tr></tbody>");
  });
});

describe("Html.parseDocument — select", () => {
  test("options auto-close their previous sibling", async () => {
    const out = await html(`<select><option>a<option>b</select>`);
    expect(out).toContain("<select><option>a</option><option>b</option></select>");
  });

  test("optgroup closes a previous option and optgroup", async () => {
    const out = await html(`<select><optgroup><option>a<optgroup><option>b</select>`);
    expect(out).toContain(
      "<select><optgroup><option>a</option></optgroup><optgroup><option>b</option></optgroup></select>",
    );
  });

  test("a nested <select> closes the open select", async () => {
    const d = await doc(`<select><option>a<select><option>b`);
    const body = child(d.documentElement, "body");
    // second option is a sibling of select, not nested.
    expect(body.elements.map((e) => e.name)).toEqual(["select", "option"]);
  });

  test("select inside a table drops out on </table>", async () => {
    const out = await html(`<table><select><option>x</table>y`);
    expect(out).toContain("<select><option>x</option></select>");
    expect(out).toContain("<table/>");
  });
});

describe("Html.parseDocument — foreign content", () => {
  const find = htmlDescendantOrFail;

  test("svg/math elements land in their own namespace", async () => {
    const d = await doc(`<svg><circle></circle></svg><math><mi>x</mi></math>`);
    const svg = find(d.documentElement, "svg");
    const math = find(d.documentElement, "math");
    expect(svg.namespace).toBe("svg");
    expect(at(svg.elements, 0).namespace).toBe("svg");
    expect(math.namespace).toBe("mathml");
  });

  test("SVG tag and attribute names are case-corrected", async () => {
    const d = await doc(`<svg viewbox="0 0 1 1"><foreignobject></foreignobject></svg>`);
    const svg = find(d.documentElement, "svg");
    expect(at(svg.attributes, 0).name).toBe("viewBox");
    expect(at(svg.elements, 0).name).toBe("foreignObject");
  });

  test("xlink/xml attributes get their foreign namespaces", async () => {
    const d = await doc(`<svg><a xlink:href="u" xml:lang="en"></a></svg>`);
    const a = find(d.documentElement, "a");
    const xlink = a.attributes.find((x) => x.name === "href");
    const xml = a.attributes.find((x) => x.name === "lang");
    assert.isDefined(xlink);
    assert.isDefined(xml);
    expect(xlink.namespace).toBe("xlink");
    expect(xlink.prefix).toBe("xlink");
    expect(xlink.qualifiedName).toBe("xlink:href");
    expect(a.attribute("xlink:href")).toBe("u");
    expect(xml.namespace).toBe("xml");
    // The XML DOM places them in their namespace URIs.
    const converted = Html.toXml(a);
    const href = converted.attributes.find((x) => x.name.local === "href");
    expect(href?.name.namespace).toBe(Html.XLINK_NS);
    expect(href?.name.prefix).toBe("xlink");
  });

  test("breakout tags return to HTML content", async () => {
    // <p> is a breakout tag: it closes the SVG subtree.
    const d = await doc(`<svg><p>after`);
    const body = child(d.documentElement, "body");
    const names = body.elements.map((e) => e.name);
    expect(names).toEqual(["svg", "p"]);
    expect(at(body.elements, 1).namespace).toBe("html");
  });
});

const tpl = (root: Html.HtmlElement) => htmlDescendantOrFail(root, "template");
const names = (nodes: ReadonlyArray<Html.HtmlNode>) =>
  nodes.filter(isHtmlElement).map((e) => e.name);
const mode = async (input: string) => (await doc(input)).mode;

describe("Html.parseDocument — template", () => {
  test("a bare <template> lands in <head> and holds its contents", async () => {
    const d = await doc(`<template><div>x</div></template>`);
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
  });

  test("only HTML templates have contents", async () => {
    const d = await doc(`<template></template><svg><template><g/></template></svg>`);
    expect(tpl(d.documentElement).content?.children).toEqual([]);
    const svgTemplate = htmlDescendantOrFail(child(d.documentElement, "body"), "template");
    expect(svgTemplate.namespace).toBe("svg");
    expect(svgTemplate.content).toBeNull();
    expect(names(svgTemplate.children)).toEqual(["g"]);
  });

  test("content is not wrapped in a synthesized <body>", async () => {
    const d = await doc(`<head><template><div></div></template></head>`);
    expect(names(templateContent(tpl(d.documentElement)))).toEqual(["div"]);
  });

  test("table sections are allowed directly inside template content", async () => {
    const d = await doc(`<template><tr><td>c</td></tr></template>`);
    // tr is kept (no enclosing <table> is synthesized for template contents)
    expect(names(templateContent(tpl(d.documentElement)))).toContain("tr");
  });

  test("</template> closes the template and restores the prior mode", async () => {
    const d = await doc(`<body><template><div></div></template><p>after`);
    const body = child(d.documentElement, "body");
    expect(body.elements.map((e) => e.name)).toEqual(["template", "p"]);
  });

  test("Html.serialize writes the contents; Html.toXml makes them children", async () => {
    const d = await doc(`<template><b>x</b></template>`);
    expect(Html.serialize(d)).toBe(
      "<html><head><template><b>x</b></template></head><body></body></html>",
    );
    expect(Xml.serialize(Html.toXml(tpl(d.documentElement)))).toBe("<template><b>x</b></template>");
  });
});

describe("Html.parseDocument — document mode", () => {
  test("no DOCTYPE, or a legacy one, is quirks mode", async () => {
    expect(await mode("<p>x")).toBe("quirks");
    expect(await mode("<!DOCTYPE foo><p>x")).toBe("quirks");
    expect(await mode(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 3.2 Final//EN">`)).toBe("quirks");
    expect(await mode(`<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">`)).toBe(
      "quirks",
    );
  });

  test("XHTML 1.0 and HTML 4.01 transitional with a system id are limited-quirks", async () => {
    expect(
      await mode(
        `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" ` +
          `"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">`,
      ),
    ).toBe("limited-quirks");
    expect(
      await mode(
        `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" ` +
          `"http://www.w3.org/TR/html4/loose.dtd">`,
      ),
    ).toBe("limited-quirks");
  });

  test("<!DOCTYPE html> and HTML 4.01 strict are no-quirks", async () => {
    expect(await mode("<!DOCTYPE html>")).toBe("no-quirks");
    expect(await mode("<!doctype HTML>")).toBe("no-quirks");
    expect(
      await mode(
        `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">`,
      ),
    ).toBe("no-quirks");
  });

  test("in quirks mode <table> does not close an open <p>", async () => {
    expect(await html("<p><table></table>")).toContain("<p><table/></p>");
    expect(await html("<!DOCTYPE html><p><table></table>")).toContain("<p/><table/>");
  });

  test("a fragment is parsed in no-quirks mode", () => {
    const nodes = Effect.runSync(Html.parseDocumentFragment("<p><table></table>"));
    expect(Html.serializeFragment(nodes)).toBe("<p></p><table></table>");
  });

  test("the DOCTYPE's absent identifiers are empty strings", async () => {
    const d = await doc("<!DOCTYPE html>");
    expect(d.doctype).toEqual(new Html.HtmlDoctype({ name: "html", publicId: "", systemId: "" }));
  });
});

describe("Html.parseDocument — frameset", () => {
  test("a frameset document has no body", async () => {
    const d = await doc(`<frameset><frame><frame></frameset>`);
    const names = d.documentElement.elements.map((e) => e.name);
    expect(names).toEqual(["head", "frameset"]);
    const fs = child(d.documentElement, "frameset");
    expect(fs.elements.map((e) => e.name)).toEqual(["frame", "frame"]);
  });

  test("an explicit <body> makes the document no longer frameset-ok", async () => {
    // <body> clears frameset-ok, so the later <frameset> is ignored.
    const d = await doc(`<body><frameset></frameset>`);
    expect(d.documentElement.elements.map((e) => e.name)).toEqual(["head", "body"]);
  });

  test("a frameset right after </head> replaces the (absent) body", async () => {
    const d = await doc(`<head></head><frameset></frameset>`);
    expect(d.documentElement.elements.map((e) => e.name)).toEqual(["head", "frameset"]);
  });

  test("real content makes the document no longer frameset-ok", async () => {
    const d = await doc(`<body><p>x<frameset></frameset>`);
    const names = d.documentElement.elements.map((e) => e.name);
    expect(names).toEqual(["head", "body"]);
  });

  test("nested framesets and after-frameset comments", async () => {
    const d = await doc(`<frameset><frameset></frameset></frameset></html><!--c-->`);
    // the trailing comment lands at the document level, after <html>
    const comment = d.children.find(isComment);
    expect(comment).toBeDefined();
    assert.isDefined(comment);
    expect(comment.data).toBe("c");
  });
});

describe("Html.parseDocument — robustness", () => {
  test("never throws on garbage", async () => {
    const d = await doc(`<<>></p></div><b><b><b>x`);
    expect(d.documentElement.name).toBe("html");
  });

  test("abruptly-closed comments are empty (<!-->)", async () => {
    const d = await doc(`<!--><p>x`);
    // The comment is empty and lives before <html>.
    const comment = d.children.find(isComment);
    expect(comment).toBeDefined();
    assert.isDefined(comment);
    expect(comment.data).toBe("");
  });

  test("a processing instruction event becomes a comment", async () => {
    // The XML tokenizer reports `<?php echo 1?>` as a processing instruction;
    // tree construction makes the comment the HTML tokenizer would have.
    const d = await Effect.runPromise(Html.buildDocument(Sax.tokenizeString(`<?php echo 1?><p>x`)));
    const comment = d.children.find(isComment);
    expect(comment?.data).toBe("?php echo 1?");
  });

  test("<? opens a bogus comment in HTML", async () => {
    const d = await doc(`<?php echo 1?>`);
    const comment = d.children.find(isComment);
    expect(comment?.data).toBe("?php echo 1?");
  });

  test("stray end tags are ignored", async () => {
    const out = await html(`<div>a</span>b</div>`);
    expect(out).toContain("<div>ab</div>");
  });

  test("implied list item closing", async () => {
    const d = await doc(`<ul><li>1<li>2</ul>`);
    const body = child(d.documentElement, "body");
    const ul = child(body, "ul");
    expect(ul.elements.map((e) => e.name)).toEqual(["li", "li"]);
    expect(ul.elements.map((e) => e.textContent)).toEqual(["1", "2"]);
  });
});

describe("Html round trips", () => {
  const inputs = [
    `<!DOCTYPE html><title>T</title><p class=x>a<b>b<i>c</b>d</i><!-- c -->`,
    `<!DOCTYPE html><table><caption>c<tr><td>1<td>2</table><ul><li>a<li>b</ul>`,
    `<!DOCTYPE html><template><tr><td>x</template><select><option>a<option selected>b</select>`,
    `<!DOCTYPE html><svg viewBox="0 0 1 1"><a xlink:href="#u"><foreignObject><p>x</p></foreignObject></a></svg><math><mi>y</mi></math>`,
    `<!DOCTYPE html><script>if (a < b) {}</script><textarea>&lt;x&gt;</textarea><pre>line</pre>`,
  ];

  const docs = () => Promise.all(inputs.map(doc));

  test("parsing a serialized document gives back an equal document", async () => {
    const firsts = await docs();
    const agains = await Promise.all(firsts.map((first) => doc(Html.serialize(first))));
    expect(agains.map((d) => Html.serialize(d))).toEqual(firsts.map((d) => Html.serialize(d)));
    firsts.forEach((first, i) => expect(Equal.equals(agains[i], first)).toBe(true));
  });

  test("Html.toXml is structural: equal documents convert to equal XML documents", async () => {
    const [as, bs] = await Promise.all([docs(), docs()]);
    as.forEach((a, i) => {
      const b = at(bs, i);
      expect(a).not.toBe(b);
      expect(Equal.equals(Html.toXml(a), Html.toXml(b))).toBe(true);
      // Every node converts the same alone as inside its document.
      const body = child(a.documentElement, "body");
      expect(Html.toXml(body.children)).toEqual(
        Html.toXml(a).root.elements.find((e) => e.name.local === "body")?.children,
      );
    });
  });
});
