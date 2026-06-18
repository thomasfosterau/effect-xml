import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Html, Xml } from "../src/index.ts"

const doc = (input: string) => Effect.runPromise(Html.parseDocument(input))

// Serialize ignoring namespaces (HTML elements all share the HTML namespace).
const html = (input: string) => Effect.runPromise(Html.parseDocument(input).pipe(Effect.map((d) => Xml.serialize(d.root))))

describe("Html.parseDocument — structure", () => {
  test("synthesizes html/head/body for bare text", async () => {
    const d = await doc(`hello`)
    expect(d.root.name.local).toBe("html")
    expect(d.root.name.namespace).toBe(Html.HTML_NS)
    const names = d.root.elements.map((e) => e.name.local)
    expect(names).toEqual(["head", "body"])
    const body = d.root.elements.find((e) => e.name.local === "body")!
    expect(body.textContent).toBe("hello")
  })

  test("routes head content into <head> and flow content into <body>", async () => {
    const d = await doc(`<title>T</title><p>P</p>`)
    const head = d.root.elements.find((e) => e.name.local === "head")!
    const body = d.root.elements.find((e) => e.name.local === "body")!
    expect(head.elements.map((e) => e.name.local)).toEqual(["title"])
    expect(head.elements[0]!.textContent).toBe("T")
    expect(body.elements.map((e) => e.name.local)).toEqual(["p"])
  })

  test("captures doctype", async () => {
    const d = await doc(`<!DOCTYPE html><p>x</p>`)
    expect(d.doctype?.name).toBe("html")
  })

  test("auto-closes <p> on block-level start tags", async () => {
    const out = await html(`<p>1<p>2<div>3</div>`)
    expect(out).toContain("<p>1</p>")
    expect(out).toContain("<p>2</p>")
    expect(out).toContain("<div>3</div>")
  })

  test("void elements never capture following siblings", async () => {
    const out = await html(`<p>a<br>b</p>`)
    expect(out).toContain("<p>a<br/>b</p>")
  })

  test("lowercases tag and attribute names", async () => {
    const out = await html(`<DIV CLASS="x">y</DIV>`)
    expect(out).toContain(`<div class="x">y</div>`)
  })
})

describe("Html.parseDocument — adoption agency", () => {
  test("misnested formatting tags are repaired", async () => {
    // The canonical example.
    const out = await html(`<body><b>1<i>2</b>3</i></body>`)
    const body = (await doc(`<b>1<i>2</b>3</i>`)).root.elements.find((e) => e.name.local === "body")!
    // <b>1<i>2</i></b><i>3</i>
    expect(body.elements.map((e) => e.name.local)).toEqual(["b", "i"])
    const b = body.elements[0]!
    expect(b.textContent).toBe("12")
    expect(b.elements.map((e) => e.name.local)).toEqual(["i"])
    const trailingI = body.elements[1]!
    expect(trailingI.textContent).toBe("3")
    void out
  })

  test("reconstructs formatting into the furthest block", async () => {
    // <b>1<p>2</b>3  =>  <b>1</b><p><b>2</b>3</p>
    const d = await doc(`<b>1<p>2</b>3`)
    const body = d.root.elements.find((e) => e.name.local === "body")!
    expect(body.elements.map((e) => e.name.local)).toEqual(["b", "p"])
    expect(body.elements[0]!.textContent).toBe("1")
    const p = body.elements[1]!
    const innerB = p.elements.find((e) => e.name.local === "b")
    expect(innerB).toBeDefined()
    expect(innerB!.textContent).toBe("2")
    expect(p.textContent).toBe("23")
  })

  test("handles deeply misnested formatting without looping", async () => {
    const out = await html(`<em><b><i>x</em>y</b>z</i>`)
    expect(typeof out).toBe("string")
    expect(out).toContain("x")
    expect(out).toContain("y")
    expect(out).toContain("z")
  })
})

describe("Html.parseDocument — tables", () => {
  test("synthesizes tbody/tr around bare cells", async () => {
    const out = await html(`<table><td>x</td></table>`)
    expect(out).toContain("<table><tbody><tr><td>x</td></tr></tbody></table>")
  })

  test("foster-parents non-table content before the table", async () => {
    // <b><table><td><i></table> => the <b> wraps a table whose cell holds <i>.
    const d = await doc(`<b><table><td><i></table>`)
    const body = d.root.elements.find((e) => e.name.local === "body")!
    const b = body.elements.find((e) => e.name.local === "b")!
    const table = b.elements.find((e) => e.name.local === "table")!
    const td = table.elements[0]!.elements[0]!.elements[0]! // tbody>tr>td
    expect(td.name.local).toBe("td")
    expect(td.elements[0]!.name.local).toBe("i")
  })

  test("captions and column groups nest correctly", async () => {
    const out = await html(`<table><caption>C</caption><colgroup><col></colgroup><tr><td>x</table>`)
    expect(out).toContain("<caption>C</caption>")
    expect(out).toContain("<colgroup><col/></colgroup>")
    expect(out).toContain("<tbody><tr><td>x</td></tr></tbody>")
  })
})

describe("Html.parseDocument — select", () => {
  test("options auto-close their previous sibling", async () => {
    const out = await html(`<select><option>a<option>b</select>`)
    expect(out).toContain("<select><option>a</option><option>b</option></select>")
  })

  test("optgroup closes a previous option and optgroup", async () => {
    const out = await html(`<select><optgroup><option>a<optgroup><option>b</select>`)
    expect(out).toContain(
      "<select><optgroup><option>a</option></optgroup><optgroup><option>b</option></optgroup></select>"
    )
  })

  test("a nested <select> closes the open select", async () => {
    const d = await doc(`<select><option>a<select><option>b`)
    const body = d.root.elements.find((e) => e.name.local === "body")!
    // second option is a sibling of select, not nested.
    expect(body.elements.map((e) => e.name.local)).toEqual(["select", "option"])
  })

  test("select inside a table drops out on </table>", async () => {
    const out = await html(`<table><select><option>x</table>y`)
    expect(out).toContain("<select><option>x</option></select>")
    expect(out).toContain("<table/>")
  })
})

describe("Html.parseDocument — foreign content", () => {
  const find = (root: any, local: string): any => {
    if (root.name?.local === local) return root
    for (const c of root.elements ?? []) {
      const r = find(c, local)
      if (r) return r
    }
    return null
  }

  test("svg/math elements land in their own namespace", async () => {
    const d = await doc(`<svg><circle></circle></svg><math><mi>x</mi></math>`)
    const svg = find(d.root, "svg")
    const math = find(d.root, "math")
    expect(svg.name.namespace).toBe(Html.SVG_NS)
    expect(svg.elements[0]!.name.namespace).toBe(Html.SVG_NS)
    expect(math.name.namespace).toBe(Html.MATHML_NS)
  })

  test("SVG tag and attribute names are case-corrected", async () => {
    const d = await doc(`<svg viewbox="0 0 1 1"><foreignobject></foreignobject></svg>`)
    const svg = find(d.root, "svg")
    expect(svg.attributes[0]!.name.local).toBe("viewBox")
    expect(svg.elements[0]!.name.local).toBe("foreignObject")
  })

  test("xlink/xml attributes get their foreign namespaces", async () => {
    const d = await doc(`<svg><a xlink:href="u" xml:lang="en"></a></svg>`)
    const a = find(d.root, "a")
    const xlink = a.attributes.find((x: any) => x.name.local === "href")
    const xml = a.attributes.find((x: any) => x.name.local === "lang")
    expect(xlink.name.namespace).toBe(Html.XLINK_NS)
    expect(xlink.name.prefix).toBe("xlink")
    expect(xml.name.namespace).toBe(Html.XML_NS)
  })

  test("breakout tags return to HTML content", async () => {
    // <p> is a breakout tag: it closes the SVG subtree.
    const d = await doc(`<svg><p>after`)
    const body = d.root.elements.find((e) => e.name.local === "body")!
    const names = body.elements.map((e) => e.name.local)
    expect(names).toEqual(["svg", "p"])
    expect(body.elements[1]!.name.namespace).toBe(Html.HTML_NS)
  })
})

describe("Html.parseDocument — template", () => {
  const tpl = (root: any): any => {
    if (root.name?.local === "template") return root
    for (const c of root.elements ?? []) {
      const r = tpl(c)
      if (r) return r
    }
    return null
  }

  test("a bare <template> lands in <head> and holds its contents", async () => {
    const d = await doc(`<template><div>x</div></template>`)
    const head = d.root.elements.find((e: any) => e.name.local === "head")!
    const t = tpl(head)
    expect(t).not.toBeNull()
    expect(t.elements.map((e: any) => e.name.local)).toEqual(["div"])
    expect(t.elements[0].textContent).toBe("x")
  })

  test("content is not wrapped in a synthesized <body>", async () => {
    const d = await doc(`<head><template><div></div></template></head>`)
    const t = tpl(d.root)
    expect(t.elements.map((e: any) => e.name.local)).toEqual(["div"])
  })

  test("table sections are allowed directly inside template content", async () => {
    const d = await doc(`<template><tr><td>c</td></tr></template>`)
    const t = tpl(d.root)
    // tr is kept (no enclosing <table> is synthesized for template contents)
    expect(t.elements.map((e: any) => e.name.local)).toContain("tr")
  })

  test("</template> closes the template and restores the prior mode", async () => {
    const d = await doc(`<body><template><div></div></template><p>after`)
    const body = d.root.elements.find((e: any) => e.name.local === "body")!
    expect(body.elements.map((e: any) => e.name.local)).toEqual(["template", "p"])
  })
})

describe("Html.parseDocument — robustness", () => {
  test("never throws on garbage", async () => {
    const d = await doc(`<<>></p></div><b><b><b>x`)
    expect(d.root.name.local).toBe("html")
  })

  test("abruptly-closed comments are empty (<!-->)", async () => {
    const d = await doc(`<!--><p>x`)
    // The comment is empty and lives before <html>.
    const comment = d.children.find((c) => c._tag === "XmlComment")
    expect(comment).toBeDefined()
    expect((comment as any).data).toBe("")
  })

  test("<? opens a bogus comment in HTML", async () => {
    const d = await doc(`<?php echo 1?>`)
    const comment = d.children.find((c) => c._tag === "XmlComment")
    expect((comment as any)?.data).toBe("?php echo 1?")
  })

  test("stray end tags are ignored", async () => {
    const out = await html(`<div>a</span>b</div>`)
    expect(out).toContain("<div>ab</div>")
  })

  test("implied list item closing", async () => {
    const d = await doc(`<ul><li>1<li>2</ul>`)
    const body = d.root.elements.find((e) => e.name.local === "body")!
    const ul = body.elements.find((e) => e.name.local === "ul")!
    expect(ul.elements.map((e) => e.name.local)).toEqual(["li", "li"])
    expect(ul.elements.map((e) => e.textContent)).toEqual(["1", "2"])
  })
})
