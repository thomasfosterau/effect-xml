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
import { rawTextElements, rcdataElements, voidElements } from "./Tokenizer.ts"
import {
  adjustForeignAttrs,
  FOREIGN_BREAKOUT,
  MATHML_NS,
  MATHML_TEXT_IP,
  SVG_NS,
  svgTagName,
} from "./foreign.ts"

/** The HTML namespace, assigned to every element produced by document parsing. */
export const HTML_NS = "http://www.w3.org/1999/xhtml"

// -----------------------------------------------------------------------------
// Mutable working DOM
// -----------------------------------------------------------------------------

interface MAttr {
  name: string
  value: string
  prefix?: string | null
  ns?: string | null
}

interface MElement {
  readonly _t: "element"
  name: string
  /** Element namespace (HTML by default; SVG/MathML for foreign content). */
  ns: string
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

const mkElement = (name: string, attrs: Array<MAttr>, ns: string = HTML_NS): MElement => ({
  _t: "element",
  name,
  ns,
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
  "plaintext", "xmp",
])

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"])

// "in body" end tags that close a block element in scope (generate implied end
// tags, then pop up to and including the named element).
const BLOCK_END = new Set([
  "address", "article", "aside", "blockquote", "button", "center", "details",
  "dialog", "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer",
  "header", "hgroup", "listing", "main", "menu", "nav", "ol", "pre", "section",
  "summary", "ul",
])

// Block start tags that insert without reconstructing the active formatting
// elements (their <p>/list-item/heading closing has already run by this point).
const BLOCK_INSERT = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog",
  "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "header",
  "hgroup", "main", "menu", "nav", "ol", "p", "section", "summary", "ul", "pre",
  "listing", "h1", "h2", "h3", "h4", "h5", "h6", "li", "dd", "dt",
])

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
// The "thoroughly" variant additionally pops table-section and caption elements.
const IMPLIED_END_THOROUGH = new Set([
  ...IMPLIED_END,
  "caption", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr",
])

// Table scoping / context sets.
const TABLE_SCOPE = new Set(["html", "table", "template"])
const TABLE_CONTEXT = new Set(["table", "template", "html"])
const TABLE_BODY_CONTEXT = new Set(["tbody", "tfoot", "thead", "template", "html"])
const TABLE_ROW_CONTEXT = new Set(["tr", "template", "html"])
// Table-section tags that are simply ignored when seen directly in the body.
const STRAY_TABLE_TAGS = new Set([
  "caption", "col", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr",
  "frame", "head",
])
// Table tags that drop the parser out of "in select in table".
const SELECT_TABLE_TAGS = new Set([
  "caption", "table", "tbody", "tfoot", "thead", "tr", "td", "th",
])
// "in body" start tags that clear the frameset-ok flag (input is conditional).
const FRAMESET_NOT_OK = new Set([
  "area", "br", "embed", "img", "keygen", "wbr", "hr", "textarea", "xmp",
  "iframe", "noembed", "select", "table", "applet", "marquee", "object", "pre",
  "listing", "button", "li", "dd", "dt", "plaintext",
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
  | "inTemplate"
  | "inFrameset"
  | "afterFrameset"
  | "afterAfterFrameset"
  | "afterBody"
  | "afterAfterBody"

class HtmlTreeBuilder {
  private mode: Mode = "initial"
  private readonly open: Array<MElement> = []
  private readonly afe: Array<MElement | Marker> = []
  /** The stack of template insertion modes (one entry per open <template>). */
  private readonly templateModes: Array<Mode> = []
  private readonly topLevel: Array<MNode> = []
  private doctype: XmlDoctype | null = null
  private htmlEl: MElement | null = null
  private headEl: MElement | null = null
  private bodyEl: MElement | null = null
  /** When set, insertions are foster-parented out of an open table. */
  private foster = false
  /** Self-closing flag of the start tag currently being processed. */
  private selfClosing = false
  /** The frameset-ok flag: whether a <frameset> may still replace the body. */
  private framesetOk = true
  /** Set after <pre>/<listing>/<textarea>: a single leading newline is dropped. */
  private ignoreLeadingNewline = false

  // --- stack helpers -------------------------------------------------------

  private get current(): MElement | null {
    return this.open.length > 0 ? this.open[this.open.length - 1]! : null
  }

  /** The "appropriate place for inserting a node", honouring foster parenting. */
  private appropriatePlace(): { parent: MElement | null; before: MNode | null } {
    // Foster parenting only applies when the current node is itself a table
    // section element; content nested in (e.g. fostered foreign) elements is
    // inserted normally even while foster parenting is enabled.
    const cur = this.current
    const fosterHere =
      this.foster &&
      cur !== null &&
      cur.ns === HTML_NS &&
      (cur.name === "table" || cur.name === "tbody" || cur.name === "tfoot" ||
        cur.name === "thead" || cur.name === "tr")
    if (fosterHere) {
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
      if (name === "select") {
        if (!last) {
          for (let j = i - 1; j >= 0; j--) {
            const n2 = this.open[j]!.name
            if (n2 === "template") break
            if (n2 === "table") {
              this.mode = "inSelectInTable"
              return
            }
          }
        }
        this.mode = "inSelect"
        return
      }
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
      if (name === "template") {
        this.mode = this.templateModes[this.templateModes.length - 1] ?? "inBody"
        return
      }
      if (name === "head" && !last) {
        this.mode = "inHead"
        return
      }
      if (name === "body") {
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

  private insertElement(name: string, attrs: Array<MAttr>, ns: string = HTML_NS): MElement {
    const el = mkElement(name, attrs, ns)
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

  private generateImpliedEndTagsThoroughly(): void {
    while (this.open.length > 0) {
      if (!IMPLIED_END_THOROUGH.has(this.current!.name)) break
      this.open.pop()
    }
  }

  private clearAfeToMarker(): void {
    while (this.afe.length > 0) {
      const e = this.afe.pop()!
      if ("marker" in e) break
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
            // The HTML parser lowercases the DOCTYPE name.
            name: ev.name.toLowerCase(),
            publicId: ev.publicId,
            systemId: ev.systemId,
            internalSubset: ev.internalSubset,
          })
          this.mode = "beforeHtml"
        }
        return
      case "Comment":
        if (this.mode === "afterAfterBody" || this.mode === "afterAfterFrameset") {
          // After </html>: a comment belongs at the document level.
          this.topLevel.push({ _t: "comment", data: ev.data, parent: null })
        } else if (
          (this.mode === "afterBody" || this.mode === "afterFrameset") &&
          this.htmlEl !== null
        ) {
          // After </body>/frameset: a comment is the html element's last child.
          appendChild(this.htmlEl, { _t: "comment", data: ev.data, parent: null })
        } else {
          this.insert({ _t: "comment", data: ev.data, parent: null })
        }
        return
      case "ProcessingInstruction":
        this.insert({ _t: "pi", target: ev.target, data: ev.data, parent: null })
        return
      case "XmlDeclaration":
        return
      case "CData": {
        const cur = this.current
        if (cur !== null && cur.ns !== HTML_NS) {
          // Foreign content: a real CDATA section is character data.
          if (ev.data.length > 0) this.insertText(ev.data)
        } else {
          // HTML content: `<![CDATA[…]]>` is a bogus comment.
          this.insert({ _t: "comment", data: "[CDATA[" + ev.data + "]]", parent: null })
        }
        return
      }
      case "Text":
        if (this.usesForeignRules("char")) this.foreignText(ev.data)
        else this.onText(ev.data)
        return
      case "StartElement": {
        const name = (ev.name as string).toLowerCase()
        const attrs = ev.attributes.map((a) => ({
          name: (a.name as string).toLowerCase(),
          value: a.value,
        }))
        this.selfClosing = ev.selfClosing
        if (this.usesForeignRules("start", name)) this.foreignStart(name, attrs)
        else this.onStart(name, attrs)
        return
      }
      case "EndElement": {
        const name = (ev.name as string).toLowerCase()
        if (this.usesForeignRules("end", name)) this.foreignEnd(name)
        else this.onEnd(name)
        return
      }
    }
  }

  // --- foreign content (SVG / MathML) -------------------------------------

  private isMathMLTextIP(el: MElement): boolean {
    return el.ns === MATHML_NS && MATHML_TEXT_IP.has(el.name)
  }

  private isHTMLIntegrationPoint(el: MElement): boolean {
    if (el.ns === MATHML_NS && el.name === "annotation-xml") {
      const enc = el.attrs.find((a) => a.name === "encoding")?.value.toLowerCase()
      return enc === "text/html" || enc === "application/xhtml+xml"
    }
    return el.ns === SVG_NS && (el.name === "foreignobject" || el.name === "desc" || el.name === "title")
  }

  /**
   * Whether the current token should be processed with foreign-content rules
   * rather than the current insertion mode (per the WHATWG tree-construction
   * dispatcher).
   */
  private usesForeignRules(kind: "start" | "end" | "char", startName?: string): boolean {
    const node = this.current // adjusted current node (no fragment context here)
    if (node === null || node.ns === HTML_NS) return false
    if (this.isMathMLTextIP(node)) {
      if (kind === "char") return false
      if (kind === "start" && startName !== "mglyph" && startName !== "malignmark") return false
    }
    if (node.ns === MATHML_NS && node.name === "annotation-xml" && kind === "start" && startName === "svg") {
      return false
    }
    if (this.isHTMLIntegrationPoint(node)) {
      if (kind === "char" || kind === "start") return false
    }
    return true
  }

  /** Insert a foreign (SVG/MathML) element in the namespace of the current node. */
  private insertForeignElement(name: string, attrs: Array<MAttr>, ns: string): void {
    const tag = ns === SVG_NS ? svgTagName(name) : name
    this.insertElement(tag, adjustForeignAttrs(attrs, ns), ns)
    if (this.selfClosing) this.open.pop()
  }

  private foreignText(data: string): void {
    if (/[^\t\n\f\r ]/.test(data)) this.framesetOk = false
    // U+0000 in foreign content becomes U+FFFD.
    this.insertText(data.replace(/\u0000/g, "\uFFFD"))
  }

  private foreignStart(name: string, attrs: Array<MAttr>): void {
    const isFontBreakout =
      name === "font" &&
      attrs.some((a) => a.name === "color" || a.name === "face" || a.name === "size")
    if (FOREIGN_BREAKOUT.has(name) || isFontBreakout) {
      // Pop foreign elements until we're back at an HTML element or an
      // integration point, then reprocess the token with HTML rules.
      while (
        this.current !== null &&
        this.current.ns !== HTML_NS &&
        !this.isMathMLTextIP(this.current) &&
        !this.isHTMLIntegrationPoint(this.current)
      ) {
        this.open.pop()
      }
      this.onStart(name, attrs)
      return
    }
    this.insertForeignElement(name, attrs, this.current!.ns)
  }

  private foreignEnd(name: string): void {
    // Walk up the stack of open elements (bottommost first).
    let idx = this.open.length - 1
    while (idx >= 0) {
      const node = this.open[idx]!
      if (idx === 0) return // reached the topmost element without a match
      if (node.name.toLowerCase() === name) {
        while (this.open.length > idx) this.open.pop()
        return
      }
      idx--
      if (this.open[idx]!.ns === HTML_NS) {
        // The next element up is HTML: process the end tag with HTML rules.
        this.onEnd(name)
        return
      }
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
    // A single newline immediately after <pre>/<listing>/<textarea> is dropped.
    if (this.ignoreLeadingNewline) {
      this.ignoreLeadingNewline = false
      if (data.startsWith("\n")) data = data.slice(1)
      if (data.length === 0) return
    }

    // Non-whitespace character data makes the document no longer frameset-ok.
    if (/[^\t\n\f\r ]/.test(data)) this.framesetOk = false

    // Frameset modes keep only whitespace characters.
    if (
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset"
    ) {
      const ws = data.replace(/[^\t\n\f\r ]/g, "")
      if (ws.length > 0) this.insertText(ws)
      return
    }

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
    // In table modes, only non-whitespace character data is foster-parented out
    // of the table; whitespace-only runs stay inside it.
    if (this.mode === "inTable" || this.mode === "inTableBody" || this.mode === "inRow") {
      if (/[^\t\n\f\r ]/.test(data)) {
        this.foster = true
        this.insertText(data)
        this.foster = false
      } else {
        this.insertText(data)
      }
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
    // The "ignore next newline" flag only applies to the immediately following
    // character token; any tag clears it (it is re-armed below for pre/listing).
    this.ignoreLeadingNewline = false
    switch (name) {
      case "html":
        this.ensureHtml()
        // With a template open the attributes are ignored; otherwise merge.
        if (this.htmlEl && this.templateModes.length === 0) mergeAttrs(this.htmlEl, attrs)
        return
      case "head":
        this.ensureHead()
        return
      case "body":
        // Inside an open template a stray <body> start tag is ignored.
        if (this.templateModes.length > 0) return
        this.ensureBody()
        if (this.bodyEl) mergeAttrs(this.bodyEl, attrs)
        // An explicit <body> tag makes the document no longer frameset-ok.
        this.framesetOk = false
        return
      case "template":
        // Not allowed in frameset modes — fall through to be ignored there.
        if (
          this.mode === "inFrameset" ||
          this.mode === "afterFrameset" ||
          this.mode === "afterAfterFrameset"
        ) {
          break
        }
        // Handled identically in every insertion mode (via the "in head" rules).
        if (this.bodyEl === null) this.ensureHead()
        this.insertElement("template", attrs)
        this.afe.push(MARKER)
        this.templateModes.push("inTemplate")
        this.mode = "inTemplate"
        return
      case "frameset":
        this.startFrameset(attrs)
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
        // In table modes only script/style/template use in-head rules; other
        // metadata tags are foster-parented out of the table (handled below).
        if (
          (this.mode === "inTable" || this.mode === "inTableBody" || this.mode === "inRow") &&
          name !== "script" &&
          name !== "style"
        ) {
          break
        }
        // Head content. If we're still before/around the head, route it there.
        if (this.bodyEl === null) {
          this.ensureHead()
        }
        // After </head>, a stray head element is processed in <head> (which is
        // pushed back on, then removed); void ones are popped immediately.
        const isVoidHead =
          voidElements.has(name) || name === "meta" || name === "link" ||
          name === "base" || name === "basefont" || name === "bgsound"
        const reopenHead =
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

    // Frameset modes never have (or synthesize) a body.
    if (
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset"
    ) {
      this.dispatchStart(name, attrs)
      return
    }
    // Everything else implies we have a body, then dispatch by insertion mode.
    // Inside an open <template>, content lands in the template's contents — never
    // synthesize the document <body>.
    if (this.templateModes.length === 0) this.ensureBody()
    else this.ensureHtml()
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
      case "inTemplate":
        return this.inTemplateStart(name, attrs)
      case "inFrameset":
        return this.inFramesetStart(name, attrs)
      case "afterFrameset":
      case "afterAfterFrameset":
        return this.afterFramesetStart(name, attrs)
      default:
        return this.inBodyStart(name, attrs)
    }
  }

  private switchTemplateMode(m: Mode): void {
    this.templateModes.pop()
    this.templateModes.push(m)
    this.mode = m
  }

  private inTemplateStart(name: string, attrs: Array<MAttr>): void {
    // Head-content tags (base/link/meta/script/style/title/...) are handled
    // earlier in onStart before dispatch, so they never reach here.
    switch (name) {
      case "caption":
      case "colgroup":
      case "tbody":
      case "tfoot":
      case "thead":
        this.switchTemplateMode("inTable")
        return this.dispatchStart(name, attrs)
      case "col":
        this.switchTemplateMode("inColumnGroup")
        return this.dispatchStart(name, attrs)
      case "tr":
        this.switchTemplateMode("inTableBody")
        return this.dispatchStart(name, attrs)
      case "td":
      case "th":
        this.switchTemplateMode("inRow")
        return this.dispatchStart(name, attrs)
      default:
        this.switchTemplateMode("inBody")
        return this.dispatchStart(name, attrs)
    }
  }

  // --- frameset ------------------------------------------------------------

  private startFrameset(attrs: Array<MAttr>): void {
    // Before/after head with no body yet: this is a frameset document.
    if (
      this.bodyEl === null &&
      (this.mode === "initial" || this.mode === "beforeHtml" ||
        this.mode === "beforeHead" || this.mode === "inHead" || this.mode === "afterHead")
    ) {
      this.ensureHead()
      if (this.current?.name === "head") this.open.pop()
      this.insertElement("frameset", attrs)
      this.mode = "inFrameset"
      return
    }
    // In body: only a frameset-ok document with a real <body> as the second
    // open element may be replaced; otherwise ignore the token.
    if (this.mode === "inFrameset") {
      this.insertElement("frameset", attrs)
      return
    }
    if (this.framesetOk && this.open.length >= 2 && this.open[1]!.name === "body") {
      const body = this.open[1]!
      detach(body)
      while (this.open.length > 1) this.open.pop()
      this.bodyEl = null
      this.insertElement("frameset", attrs)
      this.mode = "inFrameset"
    }
    // else: ignore the token.
  }

  private inFramesetStart(name: string, attrs: Array<MAttr>): void {
    switch (name) {
      case "frameset":
        this.insertElement("frameset", attrs)
        return
      case "frame":
        this.insertElement("frame", attrs)
        this.open.pop()
        return
      // noframes is routed through the in-head handling earlier in onStart.
      default:
        return // ignore
    }
  }

  private afterFramesetStart(name: string, attrs: Array<MAttr>): void {
    // html and noframes are handled earlier in onStart; ignore everything else.
    void name
    void attrs
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
      default:
        // Other content is parsed with the in-body rules (it nests in the select).
        return this.inBodyStart(name, attrs)
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
      case "input":
        // <input type=hidden> is inserted into the table; others foster out.
        if (attrs.some((a) => a.name === "type" && a.value.toLowerCase() === "hidden")) {
          this.insertElement("input", attrs)
          this.open.pop()
          return
        }
        this.fosterInBody(name, attrs)
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

    // Certain start tags make the document no longer frameset-ok, so a later
    // <frameset> can no longer replace the body.
    if (
      FRAMESET_NOT_OK.has(name) ||
      (name === "input" &&
        !attrs.some((a) => a.name === "type" && a.value.toLowerCase() === "hidden"))
    ) {
      this.framesetOk = false
    }

    // Stray table-section start tags are ignored in the body.
    if (STRAY_TABLE_TAGS.has(name)) return

    if (CLOSES_P.has(name) && this.hasInScope("p", BUTTON_SCOPE)) {
      this.closeP()
    }

    // <pre>/<listing>/<textarea> swallow an immediately-following newline.
    if (name === "pre" || name === "listing" || name === "textarea") {
      this.ignoreLeadingNewline = true
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

    if (name === "svg" || name === "math") {
      this.reconstructFormatting()
      const ns = name === "svg" ? SVG_NS : MATHML_NS
      this.insertElement(name, adjustForeignAttrs(attrs, ns), ns)
      if (this.selfClosing) this.open.pop()
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

    // Ruby annotation tags close open ruby sub-parts (generate implied end tags).
    if (name === "rb" || name === "rtc") {
      this.generateImpliedEndTags()
      this.insertElement(name, attrs)
      return
    }
    if (name === "rp" || name === "rt") {
      this.generateImpliedEndTags("rtc")
      this.insertElement(name, attrs)
      return
    }

    // Block elements are inserted without reconstructing active formatting.
    if (BLOCK_INSERT.has(name)) {
      this.insertElement(name, attrs)
      return
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
    this.ignoreLeadingNewline = false
    if (name === "template") {
      // Processed via the "in head" rules in every insertion mode.
      if (!this.open.some((e) => e.name === "template")) return
      this.generateImpliedEndTagsThoroughly()
      this.popUntilIncluding("template")
      this.clearAfeToMarker()
      this.templateModes.pop()
      this.resetInsertionMode()
      return
    }
    if (name === "html") {
      if (this.mode === "afterFrameset" || this.mode === "afterAfterFrameset") {
        this.mode = "afterAfterFrameset"
      } else if (this.bodyEl) {
        // In body, </html> switches to "after body" then reprocesses (→ after
        // after body); from "after body" it goes straight to "after after body".
        this.mode = "afterAfterBody"
      }
      return
    }
    if (name === "frameset" && this.mode === "inFrameset") {
      if (this.current?.name === "html") return // fragment edge: ignore
      this.open.pop()
      if (this.current?.name !== "frameset") this.mode = "afterFrameset"
      return
    }
    if (name === "body") {
      if (this.mode === "inFrameset" || this.mode === "afterFrameset") return
      this.ensureBody()
      this.mode = "afterBody"
      return
    }
    // In frameset modes all other end tags are ignored.
    if (
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset"
    ) {
      return
    }

    // A </br> end tag is treated as a <br> start tag.
    if (name === "br") {
      this.onStart("br", [])
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
      case "inTemplate":
        // Only </template> (handled above) is meaningful; ignore other end tags.
        return
      default:
        break
    }

    // Before a body exists these end tags don't open one — they're ignored.
    const noBodyYet = this.bodyEl === null && this.templateModes.length === 0

    if (name === "p") {
      if (noBodyYet) return
      if (!this.hasInScope("p", BUTTON_SCOPE)) {
        // Act as if <p></p> — insert an empty paragraph.
        this.insertElement("p", [])
      }
      this.closeP()
      return
    }

    if (FORMATTING.has(name)) {
      if (noBodyYet) return
      this.adoptionAgency(name)
      return
    }

    // Block elements: close to and including the named element if it's in scope.
    if (BLOCK_END.has(name)) {
      if (this.hasInScope(name, DEFAULT_SCOPE)) {
        this.generateImpliedEndTags()
        this.popUntilIncluding(name)
      }
      return
    }

    if (name === "li") {
      if (this.hasInScope("li", LIST_ITEM_SCOPE)) {
        this.generateImpliedEndTags("li")
        this.popUntilIncluding("li")
      }
      return
    }

    if (name === "dd" || name === "dt") {
      if (this.hasInScope(name, DEFAULT_SCOPE)) {
        this.generateImpliedEndTags(name)
        this.popUntilIncluding(name)
      }
      return
    }

    if (HEADINGS.has(name)) {
      // Close the nearest heading of any level if one is in scope.
      const inScope = [...HEADINGS].some((h) => this.hasInScope(h, DEFAULT_SCOPE))
      if (inScope) {
        this.generateImpliedEndTags()
        while (this.open.length > 0) {
          if (HEADINGS.has(this.open.pop()!.name)) break
        }
      }
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
    // Close any templates still open at EOF (the "in template" EOF rule) so a
    // synthesized body never lands inside template contents.
    while (this.templateModes.length > 0) {
      this.popUntilIncluding("template")
      this.templateModes.pop()
    }

    // An unclosed raw-text/rcdata element (e.g. <script> with no </script>) is
    // popped at EOF (the "text" insertion mode's EOF rule) so that nothing nests
    // inside it.
    while (
      this.current !== null &&
      (rawTextElements.has(this.current.name) || rcdataElements.has(this.current.name))
    ) {
      this.open.pop()
    }

    // Ensure a minimal valid document exists (but never add a <body> to a
    // frameset document).
    this.ensureHtml()
    if (this.headEl === null) this.ensureHead()
    const isFrameset =
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset"
    if (this.bodyEl === null && !isFrameset) this.ensureBody()

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
        name: new QName({ prefix: null, local: node.name, namespace: node.ns }),
        attributes: node.attrs.map(
          (a) =>
            new XmlAttribute({
              name: new QName({
                prefix: a.prefix ?? null,
                local: a.name,
                namespace: a.ns ?? null,
              }),
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
