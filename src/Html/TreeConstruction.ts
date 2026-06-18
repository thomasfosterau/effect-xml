/**
 * WHATWG-style HTML tree construction (html5ever phase 1).
 *
 * This implements the spine of the HTML parsing algorithm on top of the lenient
 * tokenizer: implicit `html`/`head`/`body` insertion, the relevant insertion
 * modes, the stack of open elements, the list of active formatting elements, and
 * the **adoption agency algorithm** for misnested formatting tags (the thing that
 * turns `<b>1<i>2</b>3</i>` into `<b>1<i>2</i></b><i>3</i>`).
 *
 * Tree construction needs a *mutable* tree (the adoption agency algorithm
 * reparents and clones nodes), so we build an internal mutable DOM with parent
 * pointers and convert it to the immutable, Schema-backed {@link XmlNode} DOM at
 * the end. Output is therefore fully interoperable with the rest of the library.
 *
 * Deliberately deferred (tracked in ROADMAP.md): full table/select/template
 * insertion modes with foster parenting, foreign (SVG/MathML) content
 * adjustments, quirks-mode detection, and the complete named-entity table. Those
 * tags are handled leniently (as generic flow content) rather than per-spec.
 */
import { Effect, Stream } from "effect"
import type { SaxError } from "../Error.ts"
import { QName } from "../Name.ts"
import type { SaxEvent } from "../Sax.ts"
import {
  XmlCData,
  XmlComment,
  XmlDoctype,
  XmlDocument,
  XmlElement,
  XmlProcessingInstruction,
  XmlText,
  XmlAttribute,
  type XmlNode,
} from "../Xml/Node.ts"
import { voidElements } from "./Tokenizer.ts"

/** The HTML namespace, assigned to every element produced by document parsing. */
export const HTML_NS = "http://www.w3.org/1999/xhtml"

// -----------------------------------------------------------------------------
// Mutable working DOM
// -----------------------------------------------------------------------------

interface MAttr {
  name: string
  value: string
}

interface MElement {
  readonly _t: "element"
  name: string
  attrs: Array<MAttr>
  children: Array<MNode>
  parent: MElement | null
}

interface MText {
  readonly _t: "text"
  data: string
  parent: MElement | null
}

interface MComment {
  readonly _t: "comment"
  data: string
  parent: MElement | null
}

interface MCData {
  readonly _t: "cdata"
  data: string
  parent: MElement | null
}

interface MPi {
  readonly _t: "pi"
  target: string
  data: string
  parent: MElement | null
}

type MNode = MElement | MText | MComment | MCData | MPi

const mkElement = (name: string, attrs: Array<MAttr>): MElement => ({
  _t: "element",
  name,
  attrs,
  children: [],
  parent: null,
})

const detach = (node: MNode): void => {
  const p = node.parent
  if (p === null) return
  const i = p.children.indexOf(node)
  if (i !== -1) p.children.splice(i, 1)
  node.parent = null
}

const appendChild = (parent: MElement, node: MNode): void => {
  detach(node)
  node.parent = parent
  parent.children.push(node)
}

const insertBefore = (parent: MElement, node: MNode, ref: MNode): void => {
  detach(node)
  const idx = parent.children.indexOf(ref)
  if (idx === -1) parent.children.push(node)
  else parent.children.splice(idx, 0, node)
  node.parent = parent
}

// -----------------------------------------------------------------------------
// Element categories
// -----------------------------------------------------------------------------

const FORMATTING = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
])

// "Special" category (subset sufficient for the supported subset; table/foreign
// members are included so scope checks behave even though those modes are lenient).
const SPECIAL = new Set([
  "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound",
  "blockquote", "body", "br", "button", "caption", "center", "col", "colgroup",
  "dd", "details", "dir", "div", "dl", "dt", "embed", "fieldset", "figcaption",
  "figure", "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5",
  "h6", "head", "header", "hgroup", "hr", "html", "iframe", "img", "input",
  "keygen", "li", "link", "listing", "main", "marquee", "menu", "meta", "nav",
  "noembed", "noframes", "noscript", "object", "ol", "p", "param", "plaintext",
  "pre", "script", "section", "select", "source", "style", "summary", "table",
  "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "title", "tr",
  "track", "ul", "wbr", "xmp",
])

// Tags that close an open <p> in button scope when started.
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog",
  "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "header",
  "hgroup", "main", "menu", "nav", "ol", "p", "section", "summary", "ul",
  "h1", "h2", "h3", "h4", "h5", "h6", "pre", "listing", "form", "hr", "table",
])

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"])

// Scope stop sets.
const DEFAULT_SCOPE = new Set([
  "applet", "caption", "html", "table", "td", "th", "marquee", "object", "template",
])
const BUTTON_SCOPE = new Set([...DEFAULT_SCOPE, "button"])
const LIST_ITEM_SCOPE = new Set([...DEFAULT_SCOPE, "ol", "ul"])

// Tags whose end tags trigger generate-implied-end-tags.
const IMPLIED_END = new Set([
  "dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc",
])

// Table scoping / context sets.
const TABLE_SCOPE = new Set(["html", "table", "template"])
const TABLE_CONTEXT = new Set(["table", "template", "html"])
const TABLE_BODY_CONTEXT = new Set(["tbody", "tfoot", "thead", "template", "html"])
const TABLE_ROW_CONTEXT = new Set(["tr", "template", "html"])
// Table-section tags that are simply ignored when seen directly in the body.
const STRAY_TABLE_TAGS = new Set([
  "caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr",
])
// Table tags that drop the parser out of "in select in table".
const SELECT_TABLE_TAGS = new Set([
  "caption", "table", "tbody", "tfoot", "thead", "tr", "td", "th",
])

// Markers in the active-formatting list are introduced by table/applet/object/
// marquee/template scoping, which is handled leniently for now; the type is kept
// so the reconstruct/push logic already accounts for them.
type Marker = { readonly marker: true }
const MARKER: Marker = { marker: true }

// -----------------------------------------------------------------------------
// The tree builder
// -----------------------------------------------------------------------------

type Mode =
  | "initial"
  | "beforeHtml"
  | "beforeHead"
  | "inHead"
  | "afterHead"
  | "inBody"
  | "inTable"
  | "inTableBody"
  | "inRow"
  | "inCell"
  | "inCaption"
  | "inColumnGroup"
  | "inSelect"
  | "inSelectInTable"
  | "afterBody"
  | "afterAfterBody"

class HtmlTreeBuilder {
  private mode: Mode = "initial"
  private readonly open: Array<MElement> = []
  private readonly afe: Array<MElement | Marker> = []
  private readonly topLevel: Array<MNode> = []
  private doctype: XmlDoctype | null = null
  private htmlEl: MElement | null = null
  private headEl: MElement | null = null
  private bodyEl: MElement | null = null
  /** When set, insertions are foster-parented out of an open table. */
  private foster = false

  // --- stack helpers -------------------------------------------------------

  private get current(): MElement | null {
    return this.open.length > 0 ? this.open[this.open.length - 1]! : null
  }

  /** The "appropriate place for inserting a node", honouring foster parenting. */
  private appropriatePlace(): { parent: MElement | null; before: MNode | null } {
    if (this.foster) {
      for (let i = this.open.length - 1; i >= 0; i--) {
        if (this.open[i]!.name === "table") {
          const table = this.open[i]!
          if (table.parent !== null) return { parent: table.parent, before: table }
          return { parent: this.open[i - 1] ?? null, before: null }
        }
      }
    }
    return { parent: this.current, before: null }
  }

  private insert(node: MNode): void {
    const { parent, before } = this.appropriatePlace()
    if (parent === null) {
      detach(node)
      node.parent = null
      this.topLevel.push(node)
    } else if (before === null) {
      appendChild(parent, node)
    } else {
      insertBefore(parent, node, before)
    }
  }

  private clearStackBackTo(context: ReadonlySet<string>): void {
    while (this.current !== null && !context.has(this.current.name)) this.open.pop()
  }

  private resetInsertionMode(): void {
    for (let i = this.open.length - 1; i >= 0; i--) {
      const name = this.open[i]!.name
      const last = i === 0
      if ((name === "td" || name === "th") && !last) {
        this.mode = "inCell"
        return
      }
      if (name === "tr") {
        this.mode = "inRow"
        return
      }
      if (name === "tbody" || name === "tfoot" || name === "thead") {
        this.mode = "inTableBody"
        return
      }
      if (name === "caption") {
        this.mode = "inCaption"
        return
      }
      if (name === "colgroup") {
        this.mode = "inColumnGroup"
        return
      }
      if (name === "table") {
        this.mode = "inTable"
        return
      }
      if (name === "body" || name === "head") {
        this.mode = "inBody"
        return
      }
      if (name === "html") {
        this.mode = this.headEl ? "afterHead" : "beforeHead"
        return
      }
      if (last) break
    }
    this.mode = "inBody"
  }

  private insertElement(name: string, attrs: Array<MAttr>): MElement {
    const el = mkElement(name, attrs)
    this.insert(el)
    this.open.push(el)
    return el
  }

  private popUntilIncluding(name: string): void {
    while (this.open.length > 0) {
      const el = this.open.pop()!
      if (el.name === name) break
    }
  }

  private hasInScope(name: string, scope: ReadonlySet<string>): boolean {
    for (let i = this.open.length - 1; i >= 0; i--) {
      const el = this.open[i]!
      if (el.name === name) return true
      if (scope.has(el.name)) return false
    }
    return false
  }

  private generateImpliedEndTags(except?: string): void {
    while (this.open.length > 0) {
      const c = this.current!
      if (c.name === except || !IMPLIED_END.has(c.name)) break
      this.open.pop()
    }
  }

  // --- active formatting elements -----------------------------------------

  private pushFormatting(el: MElement): void {
    // Noah's Ark clause: keep at most 3 equal entries since the last marker.
    let count = 0
    for (let i = this.afe.length - 1; i >= 0; i--) {
      const e = this.afe[i]!
      if ("marker" in e) break
      if (e.name === el.name && sameAttrs(e.attrs, el.attrs)) {
        count++
        if (count >= 3) {
          this.afe.splice(i, 1)
          break
        }
      }
    }
    this.afe.push(el)
  }

  private reconstructFormatting(): void {
    if (this.afe.length === 0) return
    const last = this.afe[this.afe.length - 1]!
    if ("marker" in last || this.open.includes(last)) return
    let i = this.afe.length - 1
    // Rewind
    while (i > 0) {
      const e = this.afe[i - 1]!
      if ("marker" in e || this.open.includes(e)) break
      i--
    }
    // Advance + create
    for (; i < this.afe.length; i++) {
      const entry = this.afe[i]!
      if ("marker" in entry) continue
      const clone = mkElement(entry.name, entry.attrs.map((a) => ({ ...a })))
      this.insert(clone)
      this.open.push(clone)
      this.afe[i] = clone
    }
  }

  // --- entry point ---------------------------------------------------------

  accept(ev: SaxEvent): void {
    switch (ev._tag) {
      case "Doctype":
        if (this.mode === "initial") {
          this.doctype = new XmlDoctype({
            name: ev.name,
            publicId: ev.publicId,
            systemId: ev.systemId,
            internalSubset: ev.internalSubset,
          })
          this.mode = "beforeHtml"
        }
        return
      case "Comment":
        this.insert({ _t: "comment", data: ev.data, parent: null })
        return
      case "ProcessingInstruction":
        this.insert({ _t: "pi", target: ev.target, data: ev.data, parent: null })
        return
      case "XmlDeclaration":
        return
      case "CData":
        this.ensureBody()
        this.reconstructFormatting()
        this.insert({ _t: "cdata", data: ev.data, parent: null })
        return
      case "Text":
        this.onText(ev.data)
        return
      case "StartElement":
        this.onStart((ev.name as string).toLowerCase(), ev.attributes.map((a) => ({
          name: (a.name as string).toLowerCase(),
          value: a.value,
        })))
        return
      case "EndElement":
        this.onEnd((ev.name as string).toLowerCase())
        return
    }
  }

  // --- structural bootstrapping -------------------------------------------

  private ensureHtml(): void {
    if (this.htmlEl === null) {
      this.htmlEl = this.insertElement("html", [])
      this.mode = "beforeHead"
    }
  }

  private ensureHead(): void {
    this.ensureHtml()
    if (this.headEl === null) {
      this.headEl = this.insertElement("head", [])
      this.mode = "inHead"
    }
  }

  private ensureBody(): void {
    this.ensureHtml()
    if (this.headEl === null) this.ensureHead()
    if (this.bodyEl === null) {
      // Pop head if still open.
      if (this.current?.name === "head") this.open.pop()
      this.bodyEl = this.insertElement("body", [])
      this.mode = "inBody"
    }
  }

  private onText(data: string): void {
    const cur = this.current
    // Text inside an open content element (e.g. <title>, <p>, <b>) belongs there
    // regardless of insertion mode. Only text directly in the structural spine
    // (document / <html> / <head>) drives the section transitions.
    const structural = cur === null || cur.name === "html" || cur.name === "head"
    if (structural) {
      if (/^\s*$/.test(data)) {
        if (cur !== null && cur.name === "head") {
          this.insert({ _t: "text", data, parent: null })
        } else if (this.bodyEl !== null && (this.mode === "afterBody" || this.mode === "afterAfterBody")) {
          appendChild(this.bodyEl, { _t: "text", data, parent: null })
        }
        // Otherwise leading inter-section whitespace is dropped.
        return
      }
      this.ensureBody()
    }
    // In select, character data is inserted as-is (no formatting reconstruction).
    if (this.mode === "inSelect" || this.mode === "inSelectInTable") {
      this.insertText(data)
      return
    }
    this.reconstructFormatting()
    // In table modes, character data is foster-parented out of the table.
    if (this.mode === "inTable" || this.mode === "inTableBody" || this.mode === "inRow") {
      this.foster = true
      this.insertText(data)
      this.foster = false
      return
    }
    this.insertText(data)
  }

  /** Insert character data, merging with the adjacent preceding text node (DOM coalescing). */
  private insertText(data: string): void {
    const { parent, before } = this.appropriatePlace()
    if (parent === null) {
      const last = this.topLevel[this.topLevel.length - 1]
      if (last !== undefined && last._t === "text") last.data += data
      else this.topLevel.push({ _t: "text", data, parent: null })
      return
    }
    if (before === null) {
      const last = parent.children[parent.children.length - 1]
      if (last !== undefined && last._t === "text") last.data += data
      else appendChild(parent, { _t: "text", data, parent: null })
      return
    }
    const idx = parent.children.indexOf(before)
    const prev = idx > 0 ? parent.children[idx - 1] : undefined
    if (prev !== undefined && prev._t === "text") prev.data += data
    else insertBefore(parent, { _t: "text", data, parent: null }, before)
  }

  // --- start tags ----------------------------------------------------------

  private onStart(name: string, attrs: Array<MAttr>): void {
    switch (name) {
      case "html":
        this.ensureHtml()
        // Merge attributes onto the existing html element.
        if (this.htmlEl) mergeAttrs(this.htmlEl, attrs)
        return
      case "head":
        this.ensureHead()
        return
      case "body":
        this.ensureBody()
        if (this.bodyEl) mergeAttrs(this.bodyEl, attrs)
        return
      case "base":
      case "basefont":
      case "bgsound":
      case "link":
      case "meta":
      case "title":
      case "noframes":
      case "style":
      case "script": {
        // Head content. If we're still before/around the head, route it there.
        if (this.bodyEl === null) {
          this.ensureHead()
        }
        // After </head>, a stray metadata element re-opens <head> just for itself.
        const isVoidHead =
          voidElements.has(name) || name === "meta" || name === "link" || name === "base"
        const reopenHead =
          isVoidHead &&
          this.mode === "afterHead" &&
          this.headEl !== null &&
          !this.open.includes(this.headEl)
        if (reopenHead) this.open.push(this.headEl!)
        const el = this.insertElement(name, attrs)
        if (isVoidHead) this.open.pop()
        if (reopenHead) {
          const hi = this.open.indexOf(this.headEl!)
          if (hi !== -1) this.open.splice(hi, 1)
        }
        // For title/style/script/noframes the tokenizer already delivered text +
        // end tag (raw/rcdata), so nothing special to do here.
        void el
        return
      }
      default:
        break
    }

    // Everything else implies we have a body, then dispatch by insertion mode.
    this.ensureBody()
    this.dispatchStart(name, attrs)
  }

  private dispatchStart(name: string, attrs: Array<MAttr>): void {
    switch (this.mode) {
      case "inTable":
        return this.inTableStart(name, attrs)
      case "inTableBody":
        return this.inTableBodyStart(name, attrs)
      case "inRow":
        return this.inRowStart(name, attrs)
      case "inCell":
        return this.inCellStart(name, attrs)
      case "inCaption":
        return this.inCaptionStart(name, attrs)
      case "inColumnGroup":
        return this.inColumnGroupStart(name, attrs)
      case "inSelect":
        return this.inSelectStart(name, attrs)
      case "inSelectInTable":
        return this.inSelectInTableStart(name, attrs)
      default:
        return this.inBodyStart(name, attrs)
    }
  }

  private inTableContext(): boolean {
    for (const el of this.open) {
      if (
        el.name === "table" || el.name === "tbody" || el.name === "tfoot" ||
        el.name === "thead" || el.name === "tr" || el.name === "td" ||
        el.name === "th" || el.name === "caption"
      ) {
        return true
      }
    }
    return false
  }

  private hasSelectInScope(): boolean {
    for (let i = this.open.length - 1; i >= 0; i--) {
      const name = this.open[i]!.name
      if (name === "select") return true
      if (name !== "optgroup" && name !== "option") return false
    }
    return false
  }

  private inSelectStart(name: string, attrs: Array<MAttr>): void {
    switch (name) {
      case "option":
        if (this.current?.name === "option") this.open.pop()
        this.insertElement("option", attrs)
        return
      case "optgroup":
        if (this.current?.name === "option") this.open.pop()
        if (this.current?.name === "optgroup") this.open.pop()
        this.insertElement("optgroup", attrs)
        return
      case "hr":
        if (this.current?.name === "option") this.open.pop()
        if (this.current?.name === "optgroup") this.open.pop()
        this.insertElement("hr", attrs)
        this.open.pop()
        return
      case "select":
        // A nested <select> acts as </select>.
        if (this.hasSelectInScope()) {
          this.popUntilIncluding("select")
          this.resetInsertionMode()
        }
        return
      case "input":
      case "keygen":
      case "textarea":
        if (this.hasSelectInScope()) {
          this.popUntilIncluding("select")
          this.resetInsertionMode()
          this.dispatchStart(name, attrs)
        }
        return
      case "script":
      case "template":
        this.insertElement(name, attrs)
        return
      default:
        return // anything else is ignored in select
    }
  }

  private inSelectInTableStart(name: string, attrs: Array<MAttr>): void {
    if (SELECT_TABLE_TAGS.has(name)) {
      this.popUntilIncluding("select")
      this.resetInsertionMode()
      this.dispatchStart(name, attrs)
      return
    }
    return this.inSelectStart(name, attrs)
  }

  /** Process a start tag with the in-body rules but foster-parented (the "anything else in table" case). */
  private fosterInBody(name: string, attrs: Array<MAttr>): void {
    this.foster = true
    this.inBodyStart(name, attrs)
    this.foster = false
  }

  private inTableStart(name: string, attrs: Array<MAttr>): void {
    switch (name) {
      case "caption":
        this.clearStackBackTo(TABLE_CONTEXT)
        this.afe.push(MARKER)
        this.insertElement("caption", attrs)
        this.mode = "inCaption"
        return
      case "colgroup":
        this.clearStackBackTo(TABLE_CONTEXT)
        this.insertElement("colgroup", attrs)
        this.mode = "inColumnGroup"
        return
      case "col":
        this.clearStackBackTo(TABLE_CONTEXT)
        this.insertElement("colgroup", [])
        this.mode = "inColumnGroup"
        this.inColumnGroupStart("col", attrs)
        return
      case "tbody":
      case "tfoot":
      case "thead":
        this.clearStackBackTo(TABLE_CONTEXT)
        this.insertElement(name, attrs)
        this.mode = "inTableBody"
        return
      case "td":
      case "th":
      case "tr":
        this.clearStackBackTo(TABLE_CONTEXT)
        this.insertElement("tbody", [])
        this.mode = "inTableBody"
        this.inTableBodyStart(name, attrs)
        return
      case "table":
        // Nested <table>: act as if </table> then reprocess.
        if (this.hasInScope("table", TABLE_SCOPE)) {
          this.popUntilIncluding("table")
          this.resetInsertionMode()
          this.dispatchStart("table", attrs)
        }
        return
      case "style":
      case "script":
        this.insertElement(name, attrs)
        return
      default:
        this.fosterInBody(name, attrs)
        return
    }
  }

  private inTableBodyStart(name: string, attrs: Array<MAttr>): void {
    switch (name) {
      case "tr":
        this.clearStackBackTo(TABLE_BODY_CONTEXT)
        this.insertElement("tr", attrs)
        this.mode = "inRow"
        return
      case "td":
      case "th":
        this.clearStackBackTo(TABLE_BODY_CONTEXT)
        this.insertElement("tr", [])
        this.mode = "inRow"
        this.inRowStart(name, attrs)
        return
      case "caption":
      case "col":
      case "colgroup":
      case "tbody":
      case "tfoot":
      case "thead":
        if (this.hasAnyTableSection()) {
          this.clearStackBackTo(TABLE_BODY_CONTEXT)
          this.open.pop()
          this.mode = "inTable"
          this.dispatchStart(name, attrs)
        }
        return
      default:
        return this.inTableStart(name, attrs)
    }
  }

  private inRowStart(name: string, attrs: Array<MAttr>): void {
    switch (name) {
      case "td":
      case "th":
        this.clearStackBackTo(TABLE_ROW_CONTEXT)
        this.insertElement(name, attrs)
        this.mode = "inCell"
        this.afe.push(MARKER)
        return
      case "caption":
      case "col":
      case "colgroup":
      case "tbody":
      case "tfoot":
      case "thead":
      case "tr":
        if (this.hasInScope("tr", TABLE_SCOPE)) {
          this.clearStackBackTo(TABLE_ROW_CONTEXT)
          this.open.pop()
          this.mode = "inTableBody"
          this.dispatchStart(name, attrs)
        }
        return
      default:
        return this.inTableStart(name, attrs)
    }
  }

  private inCellStart(name: string, attrs: Array<MAttr>): void {
    if (STRAY_TABLE_TAGS.has(name)) {
      if (this.hasInScope("td", TABLE_SCOPE) || this.hasInScope("th", TABLE_SCOPE)) {
        this.closeCell()
        this.dispatchStart(name, attrs)
      }
      return
    }
    return this.inBodyStart(name, attrs)
  }

  private inCaptionStart(name: string, attrs: Array<MAttr>): void {
    if (STRAY_TABLE_TAGS.has(name) || name === "table") {
      if (this.hasInScope("caption", TABLE_SCOPE)) {
        this.generateImpliedEndTags()
        this.popUntilIncluding("caption")
        this.clearFormattingToMarker()
        this.mode = "inTable"
        this.dispatchStart(name, attrs)
      }
      return
    }
    return this.inBodyStart(name, attrs)
  }

  private inColumnGroupStart(name: string, attrs: Array<MAttr>): void {
    if (name === "col") {
      this.insertElement("col", attrs)
      this.open.pop()
      return
    }
    if (this.current?.name === "colgroup") {
      this.open.pop()
      this.mode = "inTable"
      this.dispatchStart(name, attrs)
    }
  }

  private hasAnyTableSection(): boolean {
    return (
      this.hasInScope("tbody", TABLE_SCOPE) ||
      this.hasInScope("tfoot", TABLE_SCOPE) ||
      this.hasInScope("thead", TABLE_SCOPE)
    )
  }

  private closeCell(): void {
    const cell = this.hasInScope("td", TABLE_SCOPE) ? "td" : "th"
    this.generateImpliedEndTags()
    this.popUntilIncluding(cell)
    this.clearFormattingToMarker()
    this.mode = "inRow"
  }

  private clearFormattingToMarker(): void {
    while (this.afe.length > 0) {
      const e = this.afe.pop()!
      if ("marker" in e) break
    }
  }

  private inBodyStart(name: string, attrs: Array<MAttr>): void {
    // <image> is a willful violation: it is treated as <img>.
    if (name === "image") name = "img"

    // Stray table-section start tags are ignored in the body.
    if (STRAY_TABLE_TAGS.has(name)) return

    if (CLOSES_P.has(name) && this.hasInScope("p", BUTTON_SCOPE)) {
      this.closeP()
    }

    if (name === "table") {
      this.insertElement("table", attrs)
      this.mode = "inTable"
      return
    }

    if (name === "select") {
      this.reconstructFormatting()
      this.insertElement("select", attrs)
      this.mode = this.inTableContext() ? "inSelectInTable" : "inSelect"
      return
    }

    if (name === "optgroup") {
      if (this.current?.name === "option") this.open.pop()
      if (this.current?.name === "optgroup") this.open.pop()
      this.reconstructFormatting()
      this.insertElement("optgroup", attrs)
      return
    }

    if (name === "option") {
      if (this.current?.name === "option") this.open.pop()
      this.reconstructFormatting()
      this.insertElement("option", attrs)
      return
    }

    if (name === "li") {
      this.closeListItem("li", LIST_ITEM_SCOPE)
    } else if (name === "dd" || name === "dt") {
      this.closeListItem(name, DEFAULT_SCOPE, ["dd", "dt"])
    }

    if (HEADINGS.has(name) && this.current && HEADINGS.has(this.current.name)) {
      this.open.pop()
    }

    if (name === "a") {
      // If an <a> is already in the active formatting list, run AAA on it first.
      const existing = this.lastFormatting("a")
      if (existing) {
        this.adoptionAgency("a")
        this.removeFromAfe(existing)
        const oi = this.open.indexOf(existing)
        if (oi !== -1) this.open.splice(oi, 1)
      }
    }

    if (name === "nobr" && this.hasInScope("nobr", DEFAULT_SCOPE)) {
      this.adoptionAgency("nobr")
    }

    if (FORMATTING.has(name)) {
      this.reconstructFormatting()
      const el = this.insertElement(name, attrs)
      this.pushFormatting(el)
      return
    }

    // void elements
    if (voidElements.has(name)) {
      this.reconstructFormatting()
      const el = this.insertElement(name, attrs)
      this.open.pop()
      void el
      return
    }

    // Generic flow content.
    this.reconstructFormatting()
    this.insertElement(name, attrs)
  }

  private closeP(): void {
    this.generateImpliedEndTags("p")
    this.popUntilIncluding("p")
  }

  private closeListItem(name: string, scope: ReadonlySet<string>, names: ReadonlyArray<string> = [name]): void {
    for (let i = this.open.length - 1; i >= 0; i--) {
      const el = this.open[i]!
      if (names.includes(el.name)) {
        this.generateImpliedEndTags(el.name)
        this.popUntilIncluding(el.name)
        return
      }
      if (scope.has(el.name) && el.name !== "p" && el.name !== "address" && el.name !== "div") {
        return
      }
    }
  }

  // --- end tags ------------------------------------------------------------

  private onEnd(name: string): void {
    if (name === "html") {
      if (this.bodyEl) this.mode = "afterBody"
      return
    }
    if (name === "body") {
      this.ensureBody()
      this.mode = "afterBody"
      return
    }
    if (name === "head") {
      if (this.current?.name === "head") this.open.pop()
      if (this.mode === "inHead") this.mode = "afterHead"
      return
    }

    // Table insertion modes handle their own end tags.
    switch (this.mode) {
      case "inTable":
        if (this.inTableEnd(name)) return
        break
      case "inTableBody":
        if (this.inTableBodyEnd(name)) return
        break
      case "inRow":
        if (this.inRowEnd(name)) return
        break
      case "inCell":
        if (this.inCellEnd(name)) return
        break
      case "inCaption":
        if (this.inCaptionEnd(name)) return
        break
      case "inColumnGroup":
        if (this.inColumnGroupEnd(name)) return
        break
      case "inSelect":
        if (this.inSelectEnd(name)) return
        break
      case "inSelectInTable":
        if (this.inSelectInTableEnd(name)) return
        break
      default:
        break
    }

    if (name === "p") {
      this.ensureBody()
      if (!this.hasInScope("p", BUTTON_SCOPE)) {
        // Act as if <p></p> — insert an empty paragraph.
        this.insertElement("p", [])
      }
      this.closeP()
      return
    }

    if (FORMATTING.has(name)) {
      this.ensureBody()
      this.adoptionAgency(name)
      return
    }

    // Any other end tag — close the matching open element wherever it is (this
    // also pops head-level rcdata elements like </title> without forcing a body).
    this.anyOtherEndTag(name)
  }

  private anyOtherEndTag(name: string): void {
    for (let i = this.open.length - 1; i >= 0; i--) {
      const el = this.open[i]!
      if (el.name === name) {
        this.generateImpliedEndTags(name)
        // pop up to and including el
        while (this.open.length > i) this.open.pop()
        return
      }
      if (SPECIAL.has(el.name)) return // ignore the end tag
    }
  }

  // --- table-mode end tags (return true if handled) -----------------------

  private inTableEnd(name: string): boolean {
    if (name === "table") {
      if (this.hasInScope("table", TABLE_SCOPE)) {
        this.popUntilIncluding("table")
        this.resetInsertionMode()
      }
      return true
    }
    // body/caption/col/colgroup/html/tbody/td/tfoot/th/thead/tr: ignored here.
    return (
      name === "body" ||
      name === "caption" ||
      name === "col" ||
      name === "colgroup" ||
      name === "html" ||
      STRAY_TABLE_TAGS.has(name)
    )
  }

  private inTableBodyEnd(name: string): boolean {
    if (name === "tbody" || name === "tfoot" || name === "thead") {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.clearStackBackTo(TABLE_BODY_CONTEXT)
        this.open.pop()
        this.mode = "inTable"
      }
      return true
    }
    if (name === "table") {
      if (this.hasAnyTableSection()) {
        this.clearStackBackTo(TABLE_BODY_CONTEXT)
        this.open.pop()
        this.mode = "inTable"
        this.onEnd("table")
      }
      return true
    }
    if (
      name === "body" || name === "caption" || name === "col" ||
      name === "colgroup" || name === "html" || name === "td" ||
      name === "th" || name === "tr"
    ) {
      return true
    }
    return this.inTableEnd(name)
  }

  private inRowEnd(name: string): boolean {
    if (name === "tr") {
      if (this.hasInScope("tr", TABLE_SCOPE)) {
        this.clearStackBackTo(TABLE_ROW_CONTEXT)
        this.open.pop()
        this.mode = "inTableBody"
      }
      return true
    }
    if (name === "table") {
      if (this.hasInScope("tr", TABLE_SCOPE)) {
        this.clearStackBackTo(TABLE_ROW_CONTEXT)
        this.open.pop()
        this.mode = "inTableBody"
        this.onEnd("table")
      }
      return true
    }
    if (name === "tbody" || name === "tfoot" || name === "thead") {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        if (this.hasInScope("tr", TABLE_SCOPE)) {
          this.clearStackBackTo(TABLE_ROW_CONTEXT)
          this.open.pop()
          this.mode = "inTableBody"
        }
        this.onEnd(name)
      }
      return true
    }
    if (
      name === "body" || name === "caption" || name === "col" ||
      name === "colgroup" || name === "html" || name === "td" || name === "th"
    ) {
      return true
    }
    return this.inTableEnd(name)
  }

  private inCellEnd(name: string): boolean {
    if (name === "td" || name === "th") {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.generateImpliedEndTags()
        this.popUntilIncluding(name)
        this.clearFormattingToMarker()
        this.mode = "inRow"
      }
      return true
    }
    if (name === "table" || name === "tbody" || name === "tfoot" || name === "thead" || name === "tr") {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.closeCell()
        this.onEnd(name)
      }
      return true
    }
    if (name === "body" || name === "caption" || name === "col" || name === "colgroup" || name === "html") {
      return true
    }
    return false // anything else uses the in-body rules
  }

  private inCaptionEnd(name: string): boolean {
    if (name === "caption" || name === "table") {
      if (this.hasInScope("caption", TABLE_SCOPE)) {
        this.generateImpliedEndTags()
        this.popUntilIncluding("caption")
        this.clearFormattingToMarker()
        this.mode = "inTable"
        if (name === "table") this.onEnd("table")
      }
      return true
    }
    if (
      name === "body" || name === "col" || name === "colgroup" || name === "html" ||
      STRAY_TABLE_TAGS.has(name)
    ) {
      return true
    }
    return false // anything else uses the in-body rules
  }

  private inSelectEnd(name: string): boolean {
    switch (name) {
      case "optgroup":
        if (
          this.current?.name === "option" &&
          this.open[this.open.length - 2]?.name === "optgroup"
        ) {
          this.open.pop()
        }
        if (this.current?.name === "optgroup") this.open.pop()
        return true
      case "option":
        if (this.current?.name === "option") this.open.pop()
        return true
      case "select":
        if (this.hasSelectInScope()) {
          this.popUntilIncluding("select")
          this.resetInsertionMode()
        }
        return true
      default:
        return true // other end tags are ignored in select
    }
  }

  private inSelectInTableEnd(name: string): boolean {
    if (SELECT_TABLE_TAGS.has(name)) {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.popUntilIncluding("select")
        this.resetInsertionMode()
        this.onEnd(name)
      }
      return true
    }
    return this.inSelectEnd(name)
  }

  private inColumnGroupEnd(name: string): boolean {
    if (name === "colgroup") {
      if (this.current?.name === "colgroup") {
        this.open.pop()
        this.mode = "inTable"
      }
      return true
    }
    if (name === "col") return true
    if (this.current?.name === "colgroup") {
      this.open.pop()
      this.mode = "inTable"
      this.onEnd(name)
      return true
    }
    return true
  }

  // --- active formatting helpers ------------------------------------------

  private lastFormatting(name: string): MElement | null {
    for (let i = this.afe.length - 1; i >= 0; i--) {
      const e = this.afe[i]!
      if ("marker" in e) return null
      if (e.name === name) return e
    }
    return null
  }

  private removeFromAfe(el: MElement): void {
    const i = this.afe.indexOf(el)
    if (i !== -1) this.afe.splice(i, 1)
  }

  // --- the adoption agency algorithm --------------------------------------

  private adoptionAgency(subject: string): void {
    // Step 1
    const cur = this.current
    if (cur && cur.name === subject && !this.afe.includes(cur)) {
      this.open.pop()
      return
    }

    let outer = 0
    while (outer < 8) {
      outer++

      // Step 4.3: formatting element
      const formattingElement = this.lastFormatting(subject)
      if (formattingElement === null) {
        this.anyOtherEndTag(subject)
        return
      }
      // Step 4.4
      const feOpenIdx = this.open.indexOf(formattingElement)
      if (feOpenIdx === -1) {
        this.removeFromAfe(formattingElement)
        return
      }
      // Step 4.5
      if (!this.hasInScope(formattingElement.name, DEFAULT_SCOPE)) {
        return
      }
      // Step 4.7: furthest block
      let furthestBlock: MElement | null = null
      for (let i = feOpenIdx + 1; i < this.open.length; i++) {
        if (SPECIAL.has(this.open[i]!.name)) {
          furthestBlock = this.open[i]!
          break
        }
      }
      // Step 4.8
      if (furthestBlock === null) {
        while (this.open.length > feOpenIdx) this.open.pop()
        this.removeFromAfe(formattingElement)
        return
      }
      // Step 4.9
      const commonAncestor = this.open[feOpenIdx - 1]!
      // Step 4.10: bookmark
      let bookmark = this.afe.indexOf(formattingElement)
      // Step 4.11
      let node = furthestBlock
      let lastNode = furthestBlock
      let nodeIdx = this.open.indexOf(node)
      let inner = 0
      while (true) {
        inner++
        nodeIdx--
        node = this.open[nodeIdx]!
        if (node === formattingElement) break
        const afeIdx = this.afe.indexOf(node)
        if (inner > 3 && afeIdx !== -1) {
          this.afe.splice(afeIdx, 1)
          if (afeIdx < bookmark) bookmark--
          continue
        }
        if (afeIdx === -1) {
          // remove from open, keep nodeIdx pointing correctly
          this.open.splice(nodeIdx, 1)
          continue
        }
        // Create a clone, replace in afe and open
        const clone = mkElement(node.name, node.attrs.map((a) => ({ ...a })))
        this.afe[afeIdx] = clone
        this.open[nodeIdx] = clone
        node = clone
        if (lastNode === furthestBlock) {
          bookmark = afeIdx + 1
        }
        appendChild(node, lastNode)
        lastNode = node
      }
      // Step 4.12: place lastNode under common ancestor
      appendChild(commonAncestor, lastNode)
      // Step 4.13: clone formatting element
      const feClone = mkElement(
        formattingElement.name,
        formattingElement.attrs.map((a) => ({ ...a }))
      )
      // Step 4.14: move furthestBlock children to clone
      for (const child of [...furthestBlock.children]) appendChild(feClone, child)
      // Step 4.15: append clone to furthestBlock
      appendChild(furthestBlock, feClone)
      // Step 4.16/4.17: fix active formatting list
      this.removeFromAfe(formattingElement)
      const fbAfe = this.afe.indexOf(furthestBlock)
      // bookmark may be stale after removal; clamp
      if (bookmark > this.afe.length) bookmark = this.afe.length
      this.afe.splice(bookmark, 0, feClone)
      void fbAfe
      // Step 4.18/4.19: fix open elements stack
      const feStackIdx = this.open.indexOf(formattingElement)
      if (feStackIdx !== -1) this.open.splice(feStackIdx, 1)
      const fbStackIdx = this.open.indexOf(furthestBlock)
      this.open.splice(fbStackIdx + 1, 0, feClone)
    }
  }

  // --- finishing -----------------------------------------------------------

  finish(): XmlDocument {
    // Ensure a minimal valid document exists.
    this.ensureHtml()
    if (this.headEl === null) this.ensureHead()
    if (this.bodyEl === null) this.ensureBody()

    const children: Array<XmlNode> = this.topLevel.map(toXmlNode)
    return new XmlDocument({
      declaration: null,
      doctype: this.doctype,
      children,
    })
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const sameAttrs = (a: ReadonlyArray<MAttr>, b: ReadonlyArray<MAttr>): boolean => {
  if (a.length !== b.length) return false
  for (const x of a) {
    const y = b.find((z) => z.name === x.name)
    if (!y || y.value !== x.value) return false
  }
  return true
}

const mergeAttrs = (el: MElement, attrs: ReadonlyArray<MAttr>): void => {
  for (const a of attrs) {
    if (!el.attrs.some((x) => x.name === a.name)) el.attrs.push({ ...a })
  }
}

const toXmlNode = (node: MNode): XmlNode => {
  switch (node._t) {
    case "text":
      return new XmlText({ data: node.data })
    case "comment":
      return new XmlComment({ data: node.data })
    case "cdata":
      return new XmlCData({ data: node.data })
    case "pi":
      return new XmlProcessingInstruction({ target: node.target, data: node.data })
    case "element":
      return new XmlElement({
        name: new QName({ prefix: null, local: node.name, namespace: HTML_NS }),
        attributes: node.attrs.map(
          (a) =>
            new XmlAttribute({
              name: new QName({ prefix: null, local: a.name, namespace: null }),
              value: a.value,
            })
        ),
        children: node.children.map(toXmlNode),
      })
  }
}

// -----------------------------------------------------------------------------
// Public driver
// -----------------------------------------------------------------------------

/** Build a full HTML document (with implicit html/head/body) from a SAX stream. */
export const buildDocument = <E, R>(
  events: Stream.Stream<SaxEvent, E, R>
): Effect.Effect<XmlDocument, SaxError | E, R> =>
  Effect.gen(function* () {
    const builder = new HtmlTreeBuilder()
    yield* Stream.runForEach(events, (ev) => Effect.sync(() => builder.accept(ev)))
    return builder.finish()
  })
