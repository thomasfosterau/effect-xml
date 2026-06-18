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

describe("Html.parseDocument — robustness", () => {
  test("never throws on garbage", async () => {
    const d = await doc(`<<>></p></div><b><b><b>x`)
    expect(d.root.name.local).toBe("html")
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
