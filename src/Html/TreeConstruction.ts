/**
 * WHATWG HTML tree construction.
 *
 * The HTML parsing algorithm on top of the lenient tokenizer: implicit
 * `html`/`head`/`body` insertion, every insertion mode (tables with foster
 * parenting, select, template, frameset), the stack of open elements, the list
 * of active formatting elements, the **adoption agency algorithm** for misnested
 * formatting tags (`<b>1<i>2</b>3</i>` → `<b>1<i>2</i></b><i>3</i>`), foreign
 * (SVG / MathML) content and quirks-mode detection. The html5lib
 * tree-construction suite is the conformance gate (`tests/conformance.test.ts`).
 *
 * Tree construction needs a *mutable* tree (the adoption agency algorithm
 * reparents and clones nodes), so we build an internal mutable DOM with parent
 * pointers and convert it to the immutable, Schema-backed {@link XmlNode} DOM at
 * the end. Output is therefore fully interoperable with the rest of the library.
 *
 * Remaining spec gaps are tracked in issue #12.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import type { SaxError } from "../Error.ts";
import { defaultLimits, resolveLimits, type Limits } from "../Limits.ts";
import { origin, type Position } from "../Position.ts";
import { resolveSaxOptions, SaxEvent } from "../Sax.ts";
import { convert as convertLexEvent } from "../internal/convert.ts";
import { depthExceeded, Guard } from "../internal/guard.ts";
import * as Nodes from "../internal/nodes.ts";
import { acceptAll, tryAccept } from "../internal/unwind.ts";
import { isFault, Lexer } from "../internal/lexer.ts";
import { type XmlDoctype, type XmlDocument, XmlElement, type XmlNode } from "../Xml/Node.ts";
import { rawTextElements, rcdataElements, voidElements } from "./Tokenizer.ts";
import {
  adjustForeignAttrs,
  FOREIGN_BREAKOUT,
  MATHML_TEXT_IP,
  svgTagName,
} from "../internal/foreign.ts";
import { HTML_NS, MATHML_NS, SVG_NS } from "./Namespaces.ts";
import { isIn, tagSet, union, type TagSet } from "../internal/tagSet.ts";

// -----------------------------------------------------------------------------
// Mutable working DOM
// -----------------------------------------------------------------------------

interface MAttr {
  name: string;
  value: string;
  prefix?: string | null;
  ns?: string | null;
}

interface MElement {
  readonly _t: "element";
  name: string;
  /** Element namespace (HTML by default; SVG/MathML for foreign content). */
  ns: string;
  attrs: Array<MAttr>;
  children: Array<MNode>;
  parent: MElement | null;
}

interface MText {
  readonly _t: "text";
  data: string;
  parent: MElement | null;
}

interface MComment {
  readonly _t: "comment";
  data: string;
  parent: MElement | null;
}

interface MCData {
  readonly _t: "cdata";
  data: string;
  parent: MElement | null;
}

interface MPi {
  readonly _t: "pi";
  target: string;
  data: string;
  parent: MElement | null;
}

type MNode = MElement | MText | MComment | MCData | MPi;

const mkElement = (name: string, attrs: Array<MAttr>, ns: string = HTML_NS): MElement => ({
  _t: "element",
  name,
  ns,
  attrs,
  children: [],
  parent: null,
});

const detach = (node: MNode): void => {
  const p = node.parent;
  if (p === null) return;
  const i = p.children.indexOf(node);
  if (i !== -1) p.children.splice(i, 1);
  node.parent = null;
};

const appendChild = (parent: MElement, node: MNode): void => {
  detach(node);
  node.parent = parent;
  parent.children.push(node);
};

const insertBefore = (parent: MElement, node: MNode, ref: MNode): void => {
  detach(node);
  const idx = parent.children.indexOf(ref);
  if (idx === -1) parent.children.push(node);
  else parent.children.splice(idx, 0, node);
  node.parent = parent;
};

// -----------------------------------------------------------------------------
// Element categories
// -----------------------------------------------------------------------------

// The public element-category sets, as lookup tables.
const VOID = union(voidElements);
const RAW_TEXT = union(rawTextElements);
const RCDATA = union(rcdataElements);

const FORMATTING = tagSet(
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
);

// "Special" category (subset sufficient for the supported subset; table/foreign
// members are included so scope checks behave even though those modes are lenient).
const SPECIAL = tagSet(
  "address",
  "applet",
  "area",
  "article",
  "aside",
  "base",
  "basefont",
  "bgsound",
  "blockquote",
  "body",
  "br",
  "button",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dir",
  "div",
  "dl",
  "dt",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "iframe",
  "img",
  "input",
  "keygen",
  "li",
  "link",
  "listing",
  "main",
  "marquee",
  "menu",
  "meta",
  "nav",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "p",
  "param",
  "plaintext",
  "pre",
  "script",
  "section",
  "select",
  "source",
  "style",
  "summary",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
  "wbr",
  "xmp",
);

const HEADINGS = tagSet("h1", "h2", "h3", "h4", "h5", "h6");

// Metadata start tags processed with the "in head" rules from (almost) any mode.
const HEAD_CONTENT = tagSet(
  "base",
  "basefont",
  "bgsound",
  "link",
  "meta",
  "title",
  "noframes",
  "style",
  "script",
);

// "in body" end tags that close a block element in scope (generate implied end
// tags, then pop up to and including the named element).
const BLOCK_END = tagSet(
  "address",
  "article",
  "aside",
  "blockquote",
  "button",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "listing",
  "main",
  "menu",
  "nav",
  "ol",
  "pre",
  "section",
  "summary",
  "ul",
);

// Block start tags that insert without reconstructing the active formatting
// elements (their <p>/list-item/heading closing has already run by this point).
const BLOCK_INSERT = tagSet(
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "header",
  "hgroup",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "section",
  "summary",
  "ul",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "listing",
  "plaintext",
  "li",
  "dd",
  "dt",
);

// Tags that close an open <p> in button scope when started: the block
// insertions plus the ones that insert with their own handling.
const CLOSES_P = union(BLOCK_INSERT, ["hr", "table", "xmp"]);

// Public identifier prefixes that put the document into quirks mode.
const QUIRKY_PUBLIC_PREFIXES = [
  "+//silmaril//dtd html pro v0r11 19970101//",
  "-//as//dtd html 3.0 aswedit + extensions//",
  "-//ietf//dtd html 2.0",
  "-//ietf//dtd html 3.0",
  "-//w3c//dtd html 3 1995-03-24//",
  "-//w3c//dtd html 3.2",
  "-//w3c//dtd html 4.0",
  "-//w3c//dtd html experimental",
  "-//w3o//dtd w3 html 3.0",
  "-//webtechs//dtd mozilla html",
];

/** Whether a DOCTYPE puts the document into (full) quirks mode. */
const computeQuirks = (name: string, publicId: string | null, systemId: string | null): boolean => {
  if (name.toLowerCase() !== "html") return true;
  const p = publicId === null ? null : publicId.toLowerCase();
  const s = systemId === null ? null : systemId.toLowerCase();
  if (
    p === "-//w3o//dtd w3 html strict 3.0//en//" ||
    p === "-/w3c/dtd html 4.0 transitional/en" ||
    p === "html"
  ) {
    return true;
  }
  if (s === "http://www.ibm.com/data/dtd/v11/ibmxhtml1-transitional.dtd") return true;
  if (p !== null) {
    if (Arr.some(QUIRKY_PUBLIC_PREFIXES, (prefix) => p.startsWith(prefix))) return true;
    if (
      s === null &&
      (p.startsWith("-//w3c//dtd html 4.01 frameset//") ||
        p.startsWith("-//w3c//dtd html 4.01 transitional//"))
    ) {
      return true;
    }
  }
  return false;
};

// Scope stop sets.
const DEFAULT_SCOPE = tagSet(
  "applet",
  "caption",
  "html",
  "table",
  "td",
  "th",
  "marquee",
  "object",
  "template",
  // Foreign scope markers (MathML text integration points + SVG integration points).
  "mi",
  "mo",
  "mn",
  "ms",
  "mtext",
  "annotation-xml",
  "foreignObject",
  "desc",
  "title",
);
const BUTTON_SCOPE = union(DEFAULT_SCOPE, ["button"]);
const LIST_ITEM_SCOPE = union(DEFAULT_SCOPE, ["ol", "ul"]);
// Adoption-agency scope: a <select> ancestor bounds formatting-element adoption.
const AAA_SCOPE = union(DEFAULT_SCOPE, ["select"]);

// Tags whose end tags trigger generate-implied-end-tags.
const IMPLIED_END = tagSet("dd", "dt", "li", "optgroup", "option", "p", "rb", "rp", "rt", "rtc");
// The "thoroughly" variant additionally pops table-section and caption elements.
const IMPLIED_END_THOROUGH = union(
  IMPLIED_END,
  tagSet("caption", "colgroup", "tbody", "td", "tfoot", "th", "thead", "tr"),
);

// Table scoping / context sets.
const TABLE_SCOPE = tagSet("html", "table", "template");
const TABLE_CONTEXT = tagSet("table", "template", "html");
const TABLE_BODY_CONTEXT = tagSet("tbody", "tfoot", "thead", "template", "html");
const TABLE_ROW_CONTEXT = tagSet("tr", "template", "html");
// Table-section tags that are simply ignored when seen directly in the body.
const STRAY_TABLE_TAGS = tagSet(
  "caption",
  "col",
  "colgroup",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "frame",
  "head",
);
// Table tags that drop the parser out of "in select in table".
const SELECT_TABLE_TAGS = tagSet("caption", "table", "tbody", "tfoot", "thead", "tr", "td", "th");
// "in body" start tags that clear the frameset-ok flag (input is conditional).
const FRAMESET_NOT_OK = tagSet(
  "area",
  "br",
  "embed",
  "img",
  "keygen",
  "wbr",
  "hr",
  "textarea",
  "xmp",
  "iframe",
  "noembed",
  "select",
  "table",
  "applet",
  "marquee",
  "object",
  "pre",
  "listing",
  "button",
  "li",
  "dd",
  "dt",
  "plaintext",
);

// Markers in the active-formatting list are introduced by table/applet/object/
// marquee/template scoping, which is handled leniently for now; the type is kept
// so the reconstruct/push logic already accounts for them.
type Marker = { readonly marker: true };
const MARKER: Marker = { marker: true };

type FormattingEntry = MElement | Marker;
const isMarker = (entry: FormattingEntry): entry is Marker => "marker" in entry;
const isFormattingElement = (entry: FormattingEntry): entry is MElement => !isMarker(entry);

const isElementNode = (node: MNode): node is MElement => node._t === "element";

const isHtmlTemplate = (el: MElement): boolean => el.name === "template" && el.ns === HTML_NS;

// Table elements whose content is foster-parented out of the table.
const FOSTER_TARGETS = tagSet("table", "tbody", "tfoot", "thead", "tr");
const isFosterTarget = (el: MElement): boolean =>
  el.ns === HTML_NS && isIn(FOSTER_TARGETS, el.name);

/** The "appropriate place for inserting a node". */
type InsertionPlace =
  | { readonly kind: "topLevel" }
  | { readonly kind: "append"; readonly parent: MElement }
  | { readonly kind: "before"; readonly parent: MElement; readonly before: MNode };
const TOP_LEVEL: InsertionPlace = { kind: "topLevel" };
const appendTo = (parent: MElement | undefined): InsertionPlace =>
  parent === undefined ? TOP_LEVEL : { kind: "append", parent };

/** An entry of the stack of open elements together with its index. */
interface StackEntry {
  readonly el: MElement;
  readonly index: number;
}

/** Pop a stack up to and including its topmost entry satisfying `predicate` (emptying it if none does). */
const popThrough = <A>(stack: Array<A>, predicate: (entry: A) => boolean): void => {
  stack.splice(Option.getOrElse(Arr.findLastIndex(stack, predicate), () => 0));
};

/** Pop a stack while its topmost entry satisfies `predicate`. */
const popWhile = <A>(stack: Array<A>, predicate: (entry: A) => boolean): void => {
  const keep = Arr.findLastIndex(stack, (entry) => !predicate(entry));
  stack.splice(Option.match(keep, { onNone: () => 0, onSome: (index) => index + 1 }));
};

// -----------------------------------------------------------------------------
// The tree builder
// -----------------------------------------------------------------------------

type Mode =
  | "initial"
  | "beforeHtml"
  | "beforeHead"
  | "inHead"
  | "inHeadNoscript"
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
  | "afterAfterBody";

/** A table with one entry per insertion mode. */
type ModeTable<A> = { readonly [M in Mode]: A };

/** The template insertion mode a start tag switches to in "in template". */
const templateModeForStart = (name: string): Mode => {
  if (
    name === "caption" ||
    name === "colgroup" ||
    name === "tbody" ||
    name === "tfoot" ||
    name === "thead"
  ) {
    return "inTable";
  }
  if (name === "col") return "inColumnGroup";
  if (name === "tr") return "inTableBody";
  if (name === "td" || name === "th") return "inRow";
  return "inBody";
};

/** Insertion modes keyed by tag name. */
interface ModeByTag {
  readonly [tag: string]: Mode;
}

/**
 * The fixed steps of "reset the insertion mode appropriately": the mode an
 * open element of this name selects (td / th / head only when not the last
 * node of the stack).
 */
const RESET_MODES: ModeByTag = {
  td: "inCell",
  th: "inCell",
  tr: "inRow",
  tbody: "inTableBody",
  tfoot: "inTableBody",
  thead: "inTableBody",
  caption: "inCaption",
  colgroup: "inColumnGroup",
  table: "inTable",
  head: "inHead",
  body: "inBody",
};

const matchSaxEvent = SaxEvent.$match;

/** One handler per SAX event kind. */
type SaxHandlers = {
  readonly [Tag in SaxEvent["_tag"]]: (ev: Extract<SaxEvent, { _tag: Tag }>) => void;
};

/** What a tree builder is set up with besides the input. */
interface BuilderOptions {
  readonly limits?: Limits | undefined;
  /** The scripting flag: `<noscript>` content is raw text when set. */
  readonly scripting?: boolean | undefined;
  /** The fragment parsing context element; absent for a whole document. */
  readonly context?: FragmentContext | undefined;
}

/**
 * The context element of an HTML fragment parse: a local name and its
 * namespace (HTML unless written `svg <name>` or `math <name>`).
 *
 * @since 0.3.0
 * @category models
 */
export interface FragmentContext {
  readonly name: string;
  readonly ns: string;
}

/**
 * Read a context element as html5lib's `#document-fragment` lines and the
 * `context` option spell it: `td`, `svg path`, `math mi`. HTML names are
 * case-insensitive.
 *
 * @since 0.3.0
 * @category parsing
 */
export const parseFragmentContext = (spec: string): FragmentContext => {
  const [first = "", second] = spec.trim().split(/\s+/);
  if (second !== undefined && first.toLowerCase() === "svg") return { name: second, ns: SVG_NS };
  if (second !== undefined && first.toLowerCase() === "math") {
    return { name: second.toLowerCase(), ns: MATHML_NS };
  }
  return { name: first.toLowerCase(), ns: HTML_NS };
};

class HtmlTreeBuilder {
  private mode: Mode = "initial";
  private readonly open: Array<MElement> = [];
  private readonly afe: Array<FormattingEntry> = [];
  /** The stack of template insertion modes (one entry per open <template>). */
  private readonly templateModes: Array<Mode> = [];
  private readonly topLevel: Array<MNode> = [];
  private doctype: XmlDoctype | null = null;
  private htmlEl: MElement | null = null;
  private headEl: MElement | null = null;
  private bodyEl: MElement | null = null;
  /** When set, insertions are foster-parented out of an open table. */
  private foster = false;
  /** Self-closing flag of the start tag currently being processed. */
  private selfClosing = false;
  /** The frameset-ok flag: whether a <frameset> may still replace the body. */
  private framesetOk = true;
  /** Set after <pre>/<listing>/<textarea>: a single leading newline is dropped. */
  private ignoreLeadingNewline = false;
  /** The form element pointer (at most one open form outside templates). */
  private formEl: MElement | null = null;
  /** Quirks mode (no DOCTYPE, or a quirky one): affects e.g. <table> closing <p>. */
  private quirks = true;
  /** Where the token being processed starts, for limit failures. */
  private position: Position = origin;
  private readonly limits: Limits;
  private readonly scripting: boolean;
  /** The fragment case's context element (never inserted); `null` for a document. */
  private readonly context: MElement | null;

  constructor(options: BuilderOptions = {}) {
    this.limits = options.limits ?? defaultLimits;
    this.scripting = options.scripting ?? false;
    this.context =
      options.context === undefined
        ? null
        : mkElement(options.context.name, [], options.context.ns);
    if (this.context !== null) this.startFragment(this.context);
  }

  /**
   * The fragment case's set-up (WHATWG "parsing HTML fragments", steps 5–11):
   * a root `html` element alone on the stack, a template insertion mode when
   * the context is a template, and the insertion mode reset from the context.
   * The document is in no-quirks mode. Unless the reset selects "before head"
   * (an `html` context), the root stands in for the body, so nothing
   * synthesizes `<head>` / `<body>` around the fragment.
   */
  private startFragment(context: MElement): void {
    const root = mkElement("html", []);
    this.topLevel.push(root);
    this.open.push(root);
    this.htmlEl = root;
    this.quirks = false;
    if (isHtmlTemplate(context)) this.templateModes.push("inTemplate");
    this.resetInsertionMode();
    if (this.mode !== "beforeHead") this.bodyEl = root;
  }

  /** Whether `el` is the fragment root standing in for the body. */
  private isFragmentBody(el: MElement): boolean {
    return this.context !== null && el === this.htmlEl && el === this.bodyEl;
  }

  /** Whether an element of this name holds raw text (or rcdata) content. */
  private isRawTextName(name: string): boolean {
    return isIn(RAW_TEXT, name) || isIn(RCDATA, name) || (this.scripting && name === "noscript");
  }

  // --- stack helpers -------------------------------------------------------

  private get current(): MElement | null {
    return this.open.at(-1) ?? null;
  }

  /**
   * The adjusted current node: the context element when the fragment root is
   * alone on the stack, otherwise the current node.
   */
  private get adjustedCurrent(): MElement | null {
    return this.context !== null && this.open.length === 1 ? this.context : this.current;
  }

  /** Whether a template is open (one template insertion mode per open <template>). */
  private get templateOpen(): boolean {
    return Arr.isReadonlyArrayNonEmpty(this.templateModes);
  }

  /** The topmost HTML <template> or <table> on the stack (the foster-parenting anchor). */
  private fosterAnchor(): Option.Option<StackEntry> {
    return Arr.findLast(this.open, (el, index) =>
      isHtmlTemplate(el) || el.name === "table" ? Option.some({ el, index }) : Option.none(),
    );
  }

  /** The "appropriate place for inserting a node", honouring foster parenting. */
  private appropriatePlace(): InsertionPlace {
    // Foster parenting only applies when the current node is itself a table
    // section element; content nested in (e.g. fostered foreign) elements is
    // inserted normally even while foster parenting is enabled.
    const cur = this.current;
    if (cur === null) return TOP_LEVEL;
    if (!this.foster || !isFosterTarget(cur)) return { kind: "append", parent: cur };
    const anchor = this.fosterAnchor();
    if (Option.isNone(anchor)) return { kind: "append", parent: cur };
    const { el, index } = anchor.value;
    // A template lower than any table: foster into its contents.
    if (isHtmlTemplate(el)) return { kind: "append", parent: el };
    if (el.parent !== null) return { kind: "before", parent: el.parent, before: el };
    return appendTo(this.open[index - 1]);
  }

  private insert(node: MNode): void {
    const place = this.appropriatePlace();
    if (place.kind === "topLevel") {
      detach(node);
      node.parent = null;
      this.topLevel.push(node);
    } else if (place.kind === "append") {
      appendChild(place.parent, node);
    } else {
      insertBefore(place.parent, node, place.before);
    }
  }

  private clearStackBackTo(context: TagSet): void {
    popWhile(this.open, (el) => !isIn(context, el.name));
  }

  private resetInsertionMode(): void {
    this.mode = Option.getOrElse(
      Arr.findLast(this.open, (el, index) => this.resetModeAt(el, index)),
      (): Mode => "inBody",
    );
  }

  /**
   * The reset walk's step at stack entry `index`. In the fragment case the
   * walk reaches the context element in place of the root (which is last):
   * a foreign context selects nothing, a `frameset` one "in frameset".
   */
  private resetModeAt(el: MElement, index: number): Option.Option<Mode> {
    const context = index === 0 ? this.context : null;
    if (context === null) return this.resetModeFor(el.name, index);
    if (context.ns !== HTML_NS) return Option.none();
    if (context.name === "frameset") return Option.some("inFrameset");
    return this.resetModeFor(context.name, index);
  }

  /** The mode the "reset the insertion mode" walk selects at stack entry `index`, if any. */
  // (`RESET_MODES` holds the fixed name → mode steps of the reset algorithm.)
  private resetModeFor(name: string, index: number): Option.Option<Mode> {
    const last = index === 0;
    if (name === "select") {
      // In a table (with no template in between), the select is "in select in table".
      const ancestor = Arr.findLast(
        Arr.take(this.open, index),
        (el) => el.name === "template" || el.name === "table",
      );
      return Option.some(
        Option.exists(ancestor, (el) => el.name === "table") ? "inSelectInTable" : "inSelect",
      );
    }
    if ((name === "td" || name === "th" || name === "head") && last) return Option.none();
    if (name === "template") return Option.some(this.templateModes.at(-1) ?? "inBody");
    if (name === "html") return Option.some(this.headEl ? "afterHead" : "beforeHead");
    return Option.fromNullishOr(RESET_MODES[name]);
  }

  private insertElement(name: string, attrs: Array<MAttr>, ns: string = HTML_NS): MElement {
    const el = mkElement(name, attrs, ns);
    this.insert(el);
    this.pushOpen(el);
    return el;
  }

  /** Push onto the stack of open elements, throwing {@link LimitExceeded} past `maxDepth`. */
  private pushOpen(el: MElement): void {
    const over = depthExceeded(this.limits, this.open.length + 1, this.position);
    if (over !== null) throw over;
    this.open.push(el);
  }

  private popUntilIncluding(name: string): void {
    popThrough(this.open, (el) => el.name === name);
  }

  /** Whether an element satisfying `target` is in the given scope. */
  private inScope(target: (el: MElement) => boolean, scope: TagSet): boolean {
    return Option.exists(
      Arr.findLast(this.open, (el) => target(el) || isIn(scope, el.name)),
      target,
    );
  }

  private hasInScope(name: string, scope: TagSet): boolean {
    return this.inScope((el) => el.name === name, scope);
  }

  private generateImpliedEndTags(except?: string): void {
    popWhile(this.open, (el) => el.name !== except && isIn(IMPLIED_END, el.name));
  }

  private generateImpliedEndTagsThoroughly(): void {
    popWhile(this.open, (el) => isIn(IMPLIED_END_THOROUGH, el.name));
  }

  // --- active formatting elements -----------------------------------------

  private pushFormatting(el: MElement): void {
    // Noah's Ark clause: keep at most 3 equal entries since the last marker (a
    // fourth evicts the earliest of the three).
    const sinceMarker = Option.getOrElse(Arr.findLastIndex(this.afe, isMarker), () => -1) + 1;
    const equal = Arr.filter(
      Arr.drop(this.afe, sinceMarker),
      (e): e is MElement =>
        isFormattingElement(e) && e.name === el.name && sameAttrs(e.attrs, el.attrs),
    );
    const evicted = equal.at(-3);
    if (evicted !== undefined) this.removeFromAfe(evicted);
    this.afe.push(el);
  }

  private reconstructFormatting(): void {
    const isMarkerOrOpen = (e: FormattingEntry): boolean =>
      isFormattingElement(e) ? this.open.includes(e) : true;
    if (!Arr.isReadonlyArrayNonEmpty(this.afe) || isMarkerOrOpen(Arr.lastNonEmpty(this.afe))) {
      return;
    }
    // Rewind to the entry after the last marker / open element, then advance,
    // replacing each entry with a clone inserted at the current node.
    const start = Option.getOrElse(Arr.findLastIndex(this.afe, isMarkerOrOpen), () => -1) + 1;
    const clones = Arr.map(Arr.drop(this.afe, start), (entry) =>
      isMarker(entry) ? entry : this.insertClone(entry),
    );
    this.afe.splice(start, clones.length, ...clones);
  }

  /** Insert (and push) a fresh HTML element with a copy of `el`'s name and attributes. */
  private insertClone(el: MElement): MElement {
    const clone = mkElement(
      el.name,
      el.attrs.map((a) => ({ ...a })),
    );
    this.insert(clone);
    this.pushOpen(clone);
    return clone;
  }

  // --- entry point ---------------------------------------------------------

  /** Process one SAX event (the dispatcher is compiled once per builder). */
  accept(ev: SaxEvent): void {
    this.position = ev.span.start;
    matchSaxEvent(ev, this.handlers);
  }

  /** What each event kind does; built once per builder, not per event. */
  private readonly handlers: SaxHandlers = {
    Doctype: (ev) => {
      if (this.mode !== "initial") return;
      this.quirks = computeQuirks(ev.name, ev.publicId, ev.systemId);
      this.doctype = Nodes.doctype(
        // The HTML parser lowercases the DOCTYPE name.
        ev.name.toLowerCase(),
        ev.publicId,
        ev.systemId,
        ev.internalSubset,
      );
      this.mode = "beforeHtml";
    },
    Comment: (ev) => {
      if (this.mode === "afterAfterBody" || this.mode === "afterAfterFrameset") {
        // After </html>: a comment belongs at the document level.
        this.topLevel.push({ _t: "comment", data: ev.data, parent: null });
      } else if (
        (this.mode === "afterBody" || this.mode === "afterFrameset") &&
        this.htmlEl !== null
      ) {
        // After </body>/frameset: a comment is the html element's last child.
        appendChild(this.htmlEl, { _t: "comment", data: ev.data, parent: null });
      } else {
        this.insert({ _t: "comment", data: ev.data, parent: null });
      }
    },
    ProcessingInstruction: (ev) => {
      this.insert({ _t: "pi", target: ev.target, data: ev.data, parent: null });
    },
    XmlDeclaration: () => undefined,
    CData: (ev) => {
      const cur = this.adjustedCurrent;
      if (cur !== null && cur.ns !== HTML_NS) {
        // Foreign content: a real CDATA section is character data.
        if (Str.isNonEmpty(ev.data)) this.insertText(ev.data);
      } else {
        // HTML content: `<![CDATA[…]]>` is a bogus comment.
        this.insert({ _t: "comment", data: "[CDATA[" + ev.data + "]]", parent: null });
      }
    },
    Text: (ev) => {
      const node = this.adjustedCurrent;
      if (node !== null && this.usesForeignRules(node, "char")) this.foreignText(ev.data);
      else this.onText(ev.data);
    },
    StartElement: (ev) => {
      const name = ev.name.toLowerCase();
      const attrs = ev.attributes.map((a) => ({
        name: a.name.toLowerCase(),
        value: a.value,
      }));
      this.selfClosing = ev.selfClosing;
      const node = this.adjustedCurrent;
      if (node !== null && this.usesForeignRules(node, "start", name)) {
        this.foreignStart(node, name, attrs);
      } else {
        this.onStart(name, attrs);
      }
    },
    EndElement: (ev) => {
      const name = ev.name.toLowerCase();
      const node = this.adjustedCurrent;
      if (node !== null && this.usesForeignRules(node, "end", name)) this.foreignEnd(name);
      else this.onEnd(name);
    },
  };

  // --- foreign content (SVG / MathML) -------------------------------------

  private isMathMLTextIP(el: MElement): boolean {
    return el.ns === MATHML_NS && isIn(MATHML_TEXT_IP, el.name);
  }

  private isHTMLIntegrationPoint(el: MElement): boolean {
    if (el.ns === MATHML_NS && el.name === "annotation-xml") {
      const enc = el.attrs.find((a) => a.name === "encoding")?.value.toLowerCase();
      return enc === "text/html" || enc === "application/xhtml+xml";
    }
    return (
      el.ns === SVG_NS && (el.name === "foreignObject" || el.name === "desc" || el.name === "title")
    );
  }

  /**
   * Whether the current node is in foreign content where HTML raw-text/rcdata
   * elements should NOT trigger their raw tokenizer state (i.e. a foreign
   * element that is not an integration point). Used by the coupled driver.
   */
  currentIsForeignContent(): boolean {
    const c = this.adjustedCurrent;
    return (
      c !== null && c.ns !== HTML_NS && !this.isHTMLIntegrationPoint(c) && !this.isMathMLTextIP(c)
    );
  }

  /**
   * Whether the current token should be processed with foreign-content rules
   * rather than the current insertion mode (per the WHATWG tree-construction
   * dispatcher).
   */
  private usesForeignRules(
    node: MElement, // the adjusted current node
    kind: "start" | "end" | "char",
    startName?: string,
  ): boolean {
    if (node.ns === HTML_NS) return false;
    if (this.isMathMLTextIP(node)) {
      if (kind === "char") return false;
      if (kind === "start" && startName !== "mglyph" && startName !== "malignmark") return false;
    }
    if (
      node.ns === MATHML_NS &&
      node.name === "annotation-xml" &&
      kind === "start" &&
      startName === "svg"
    ) {
      return false;
    }
    if (this.isHTMLIntegrationPoint(node)) {
      if (kind === "char" || kind === "start") return false;
    }
    return true;
  }

  /** Insert a foreign (SVG/MathML) element in the namespace of the current node. */
  private insertForeignElement(name: string, attrs: Array<MAttr>, ns: string): void {
    const tag = ns === SVG_NS ? svgTagName(name) : name;
    this.insertElement(tag, adjustForeignAttrs(attrs, ns), ns);
    if (this.selfClosing) this.open.pop();
  }

  private foreignText(data: string): void {
    if (/[^\t\n\f\r ]/.test(data)) this.framesetOk = false;
    // U+0000 in foreign content becomes U+FFFD.
    this.insertText(data.replaceAll("\u0000", "\uFFFD"));
  }

  private foreignStart(current: MElement, name: string, attrs: Array<MAttr>): void {
    const isFontBreakout =
      name === "font" &&
      attrs.some((a) => a.name === "color" || a.name === "face" || a.name === "size");
    if (isIn(FOREIGN_BREAKOUT, name) || isFontBreakout) {
      // Pop foreign elements until we're back at an HTML element or an
      // integration point, then reprocess the token with HTML rules.
      popWhile(
        this.open,
        (el) => el.ns !== HTML_NS && !this.isMathMLTextIP(el) && !this.isHTMLIntegrationPoint(el),
      );
      this.onStart(name, attrs);
      return;
    }
    this.insertForeignElement(name, attrs, current.ns);
  }

  /** Whether an element is in the "special" category (namespace-aware). */
  private isSpecialElement(el: MElement): boolean {
    if (el.ns === HTML_NS) return isIn(SPECIAL, el.name);
    // Foreign elements are special only at the integration points.
    return this.isHTMLIntegrationPoint(el) || this.isMathMLTextIP(el);
  }

  private hasIntegrationPointAbove(idx: number): boolean {
    return Arr.some(
      this.open,
      (el, i) => i > idx && (this.isHTMLIntegrationPoint(el) || this.isMathMLTextIP(el)),
    );
  }

  private foreignEnd(name: string): void {
    // Walk up the stack of open elements (bottommost first) to the first node
    // that matches the end tag or sits directly on an HTML element; reaching the
    // topmost element ends the walk without a match.
    const stop = Arr.findLastIndex(
      this.open,
      (el, i) => i > 0 && (el.name.toLowerCase() === name || this.open[i - 1]?.ns === HTML_NS),
    );
    if (Option.isNone(stop)) return;
    const idx = stop.value;
    if (this.open[idx]?.name.toLowerCase() === name) {
      this.open.splice(idx);
      return;
    }
    // The next element up is HTML: process the end tag with HTML rules. An
    // HTML breakout tag (e.g. </p>) abandons the intervening foreign subtree
    // first, unless an integration point intervenes (then scope handles it).
    if (isIn(FOREIGN_BREAKOUT, name) && !this.hasIntegrationPointAbove(idx - 1)) {
      this.open.splice(idx);
    }
    this.onEnd(name);
  }

  // --- structural bootstrapping -------------------------------------------

  private ensureHtml(): void {
    if (this.htmlEl === null) {
      this.htmlEl = this.insertElement("html", []);
      this.mode = "beforeHead";
    }
  }

  private ensureHead(): void {
    this.ensureHtml();
    if (this.headEl === null) {
      this.headEl = this.insertElement("head", []);
      this.mode = "inHead";
    }
  }

  private ensureBody(): void {
    // (A fragment root standing in for the body is already in place.)
    if (this.bodyEl !== null) return;
    this.ensureHtml();
    if (this.headEl === null) this.ensureHead();
    if (this.bodyEl === null) {
      // Pop head if still open.
      if (this.current?.name === "head") this.open.pop();
      this.bodyEl = this.insertElement("body", []);
      this.mode = "inBody";
    }
  }

  private onText(input: string): void {
    Option.map(this.afterIgnoredNewline(input), (data) => this.onCharacters(data));
  }

  /**
   * A single newline immediately after <pre>/<listing>/<textarea> is dropped;
   * `None` when that leaves nothing.
   */
  private afterIgnoredNewline(data: string): Option.Option<string> {
    if (!this.ignoreLeadingNewline) return Option.some(data);
    this.ignoreLeadingNewline = false;
    const rest = data.startsWith("\n") ? data.slice(1) : data;
    return Str.isEmpty(rest) ? Option.none() : Option.some(rest);
  }

  private onCharacters(data: string): void {
    // Text whose current node is a raw-text/rcdata element (script, style,
    // title, textarea, noframes, …) is that element's content regardless of mode.
    const open = this.current;
    if (open !== null && this.isRawTextName(open.name)) {
      this.insertText(data);
      return;
    }

    // Non-whitespace character data makes the document no longer frameset-ok.
    if (/[^\t\n\f\r ]/.test(data)) this.framesetOk = false;

    // Frameset modes keep only whitespace characters.
    if (
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset"
    ) {
      const ws = data.replace(/[^\t\n\f\r ]/g, "");
      if (Str.isNonEmpty(ws)) this.insertText(ws);
      return;
    }

    // After </body>/</html>, non-whitespace content switches back to "in body".
    if (
      (this.mode === "afterBody" || this.mode === "afterAfterBody") &&
      /[^\t\n\f\r ]/.test(data)
    ) {
      this.mode = "inBody";
    }

    if (this.mode === "inHeadNoscript" && this.keptInNoscript(data)) return;
    Option.map(this.throughSpine(data), (rest) => this.onFlowText(rest));
  }

  /**
   * In head noscript: whitespace stays (true); anything else pops noscript and
   * is reprocessed in "in head" (false).
   */
  private keptInNoscript(data: string): boolean {
    if (/[^\t\n\f\r ]/.test(data)) {
      this.open.pop(); // noscript
      this.mode = "inHead";
      return false;
    }
    this.insertText(data);
    return true;
  }

  /**
   * Text inside an open content element (e.g. <title>, <p>, <b>) belongs there
   * regardless of insertion mode. Only text directly in the structural spine
   * (document / <html> / <head>) drives the section transitions: its leading
   * whitespace is placed (or dropped) here and the rest opens the body. `None`
   * when nothing is left to insert as flow content.
   */
  private throughSpine(data: string): Option.Option<string> {
    const cur = this.current;
    if (cur !== null && cur.name !== "html" && cur.name !== "head") return Option.some(data);
    if (cur !== null && this.isFragmentBody(cur)) return Option.some(data);
    const inHead = cur !== null && cur.name === "head";
    if (/^[\t\n\f\r ]*$/.test(data)) {
      this.placeSpineWhitespace(data, inHead);
      return Option.none();
    }
    // Peel leading whitespace: kept in <head>/<html> around the head, dropped
    // before the head; the rest opens the body.
    const lead = /^[\t\n\f\r ]+/.exec(data);
    const keepLead = inHead || this.mode === "afterHead";
    if (lead && keepLead) this.insert({ _t: "text", data: lead[0], parent: null });
    this.ensureBody();
    return Option.some(lead ? data.slice(lead[0].length) : data);
  }

  /** Whitespace-only text in the spine; leading inter-section whitespace is dropped. */
  private placeSpineWhitespace(data: string, inHead: boolean): void {
    if (inHead || this.mode === "afterHead") {
      // In <head>, or inter-section whitespace after </head> (kept in <html>).
      this.insert({ _t: "text", data, parent: null });
    } else if (
      this.bodyEl !== null &&
      (this.mode === "afterBody" || this.mode === "afterAfterBody")
    ) {
      appendChild(this.bodyEl, { _t: "text", data, parent: null });
    }
  }

  /** Character data in flow content, by insertion mode. */
  private onFlowText(data: string): void {
    // In column group: whitespace stays; anything else closes the colgroup and
    // is reprocessed (or is ignored when there is no colgroup, e.g. in template).
    if (this.mode === "inColumnGroup") {
      const rest = data.replace(/^[\t\n\f\r ]+/, "");
      const ws = data.slice(0, data.length - rest.length);
      if (Str.isNonEmpty(ws)) this.insertText(ws);
      if (Str.isEmpty(rest)) return;
      if (this.current?.name === "colgroup") {
        this.open.pop();
        this.mode = "inTable";
        this.onText(rest);
      }
      return;
    }
    // Select content uses the in-body rules, so reconstruct formatting too.
    if (this.mode === "inSelect" || this.mode === "inSelectInTable") {
      this.reconstructFormatting();
      this.insertText(data);
      return;
    }
    // In table modes, only non-whitespace character data is foster-parented out
    // of the table; whitespace-only runs stay inside it, without reconstructing
    // or fostering. Foster parenting is enabled around the formatting
    // reconstruction too, so cloned formatting elements are relocated before
    // the table rather than left inside it.
    if (this.mode === "inTable" || this.mode === "inTableBody" || this.mode === "inRow") {
      if (/[^\t\n\f\r ]/.test(data)) {
        this.foster = true;
        this.reconstructFormatting();
        this.insertText(data);
        this.foster = false;
      } else {
        this.insertText(data);
      }
      return;
    }
    this.reconstructFormatting();
    this.insertText(data);
  }

  /** Insert character data, merging with the adjacent preceding text node (DOM coalescing). */
  private insertText(data: string): void {
    const place = this.appropriatePlace();
    if (place.kind === "topLevel") {
      const last = this.topLevel.at(-1);
      if (last !== undefined && last._t === "text") last.data += data;
      else this.topLevel.push({ _t: "text", data, parent: null });
      return;
    }
    const { parent } = place;
    if (place.kind === "append") {
      const last = parent.children.at(-1);
      if (last !== undefined && last._t === "text") last.data += data;
      else appendChild(parent, { _t: "text", data, parent: null });
      return;
    }
    const idx = parent.children.indexOf(place.before);
    const prev = idx > 0 ? parent.children[idx - 1] : undefined;
    if (prev !== undefined && prev._t === "text") prev.data += data;
    else insertBefore(parent, { _t: "text", data, parent: null }, place.before);
  }

  // --- start tags ----------------------------------------------------------

  private onStart(name: string, attrs: Array<MAttr>): void {
    // The "ignore next newline" flag only applies to the immediately following
    // character token; any tag clears it (it is re-armed below for pre/listing).
    this.ignoreLeadingNewline = false;
    if (name === "html") {
      this.ensureHtml();
      // With a template open the attributes are ignored; otherwise merge.
      if (this.htmlEl && !this.templateOpen) mergeAttrs(this.htmlEl, attrs);
      return;
    }
    if (name === "head") {
      this.ensureHead();
      return;
    }
    if (name === "body") {
      // Inside an open template a stray <body> start tag is ignored.
      if (this.templateOpen) return;
      this.ensureBody();
      if (this.bodyEl) mergeAttrs(this.bodyEl, attrs);
      // An explicit <body> tag makes the document no longer frameset-ok.
      this.framesetOk = false;
      return;
    }
    // <template> is not allowed in frameset modes (there it is ignored below).
    if (
      name === "template" &&
      this.mode !== "inFrameset" &&
      this.mode !== "afterFrameset" &&
      this.mode !== "afterAfterFrameset"
    ) {
      // Handled identically in every insertion mode (via the "in head" rules).
      if (this.bodyEl === null) this.ensureHead();
      // After </head>, the template still belongs in <head>.
      this.insertInHead("template", attrs, false);
      this.afe.push(MARKER);
      this.templateModes.push("inTemplate");
      this.mode = "inTemplate";
      return;
    }
    if (name === "frameset") {
      this.startFrameset(attrs);
      return;
    }
    if (name === "noscript") {
      // In head (scripting disabled), <noscript> opens "in head noscript".
      if (this.bodyEl === null && this.mode !== "afterHead") this.ensureHead();
      if (this.mode === "inHead") {
        // With scripting enabled it is a raw text element instead.
        this.insertElement("noscript", attrs);
        if (!this.scripting) this.mode = "inHeadNoscript";
        return;
      }
      // in body: a generic element
    } else if (
      isIn(HEAD_CONTENT, name) &&
      // In table modes only script/style/template use in-head rules; other
      // metadata tags are foster-parented out of the table (handled below).
      !(
        (this.mode === "inTable" || this.mode === "inTableBody" || this.mode === "inRow") &&
        name !== "script" &&
        name !== "style"
      )
    ) {
      // Head content. If we're still before/around the head, route it there.
      if (this.bodyEl === null) {
        this.ensureHead();
      }
      // After </head>, a stray head element is processed in <head> (which is
      // pushed back on, then removed); void ones are popped immediately. For
      // title/style/script/noframes the tokenizer already delivered text + end
      // tag (raw/rcdata), so nothing special to do here.
      const isVoidHead =
        isIn(VOID, name) ||
        name === "meta" ||
        name === "link" ||
        name === "base" ||
        name === "basefont" ||
        name === "bgsound";
      this.insertInHead(name, attrs, isVoidHead);
      return;
    }

    // Frameset / in-head-noscript modes never synthesize a body before dispatch.
    if (
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset" ||
      this.mode === "inHeadNoscript"
    ) {
      this.dispatchStart(name, attrs);
      return;
    }
    // Everything else implies we have a body, then dispatch by insertion mode.
    // Inside an open <template>, content lands in the template's contents — never
    // synthesize the document <body>.
    if (this.templateOpen) this.ensureHtml();
    else this.ensureBody();
    this.dispatchStart(name, attrs);
  }

  /**
   * Insert a head element. After </head> the head element is pushed back on the
   * stack around the insertion and removed again; `popAfter` pops the inserted
   * (void) element immediately.
   */
  private insertInHead(name: string, attrs: Array<MAttr>, popAfter: boolean): void {
    const head = this.headEl;
    const reopenHead = this.mode === "afterHead" && head !== null && !this.open.includes(head);
    if (reopenHead) this.open.push(head);
    this.insertElement(name, attrs);
    if (popAfter) this.open.pop();
    if (reopenHead) {
      const hi = this.open.indexOf(head);
      if (hi !== -1) this.open.splice(hi, 1);
    }
  }

  /** Start-tag handlers per insertion mode. */
  private readonly startHandlers: ModeTable<(name: string, attrs: Array<MAttr>) => void> = {
    initial: (name, attrs) => this.inBodyStart(name, attrs),
    beforeHtml: (name, attrs) => this.inBodyStart(name, attrs),
    beforeHead: (name, attrs) => this.inBodyStart(name, attrs),
    inHead: (name, attrs) => this.inBodyStart(name, attrs),
    inHeadNoscript: (name, attrs) => this.inHeadNoscriptStart(name, attrs),
    afterHead: (name, attrs) => this.inBodyStart(name, attrs),
    inBody: (name, attrs) => this.inBodyStart(name, attrs),
    inTable: (name, attrs) => this.inTableStart(name, attrs),
    inTableBody: (name, attrs) => this.inTableBodyStart(name, attrs),
    inRow: (name, attrs) => this.inRowStart(name, attrs),
    inCell: (name, attrs) => this.inCellStart(name, attrs),
    inCaption: (name, attrs) => this.inCaptionStart(name, attrs),
    inColumnGroup: (name, attrs) => this.inColumnGroupStart(name, attrs),
    inSelect: (name, attrs) => this.inSelectStart(name, attrs),
    inSelectInTable: (name, attrs) => this.inSelectInTableStart(name, attrs),
    inTemplate: (name, attrs) => this.inTemplateStart(name, attrs),
    inFrameset: (name, attrs) => this.inFramesetStart(name, attrs),
    // html and noframes are handled earlier in onStart; everything else is ignored.
    afterFrameset: () => undefined,
    afterAfterFrameset: () => undefined,
    afterBody: (name, attrs) => this.inBodyStart(name, attrs),
    afterAfterBody: (name, attrs) => this.inBodyStart(name, attrs),
  };

  private dispatchStart(name: string, attrs: Array<MAttr>): void {
    this.startHandlers[this.mode](name, attrs);
  }

  private switchTemplateMode(m: Mode): void {
    this.templateModes.pop();
    this.templateModes.push(m);
    this.mode = m;
  }

  private inTemplateStart(name: string, attrs: Array<MAttr>): void {
    // Head-content tags (base/link/meta/script/style/title/...) are handled
    // earlier in onStart before dispatch, so they never reach here.
    this.switchTemplateMode(templateModeForStart(name));
    this.dispatchStart(name, attrs);
  }

  private inHeadNoscriptStart(name: string, attrs: Array<MAttr>): void {
    if (
      name === "basefont" ||
      name === "bgsound" ||
      name === "link" ||
      name === "meta" ||
      name === "noframes" ||
      name === "style"
    ) {
      this.insertElement(name, attrs);
      if (
        isIn(VOID, name) ||
        name === "meta" ||
        name === "link" ||
        name === "basefont" ||
        name === "bgsound"
      ) {
        this.open.pop();
      }
      return;
    }
    if (name === "html") {
      this.inBodyStart(name, attrs);
      return;
    }
    if (name === "head" || name === "noscript") return; // ignore
    // Pop the noscript element and reprocess the token in "in head".
    this.open.pop();
    this.mode = "inHead";
    this.onStart(name, attrs);
  }

  // --- frameset ------------------------------------------------------------

  private startFrameset(attrs: Array<MAttr>): void {
    // Before/after head with no body yet: this is a frameset document.
    if (
      this.bodyEl === null &&
      (this.mode === "initial" ||
        this.mode === "beforeHtml" ||
        this.mode === "beforeHead" ||
        this.mode === "inHead" ||
        this.mode === "afterHead")
    ) {
      this.ensureHead();
      if (this.current?.name === "head") this.open.pop();
      this.insertElement("frameset", attrs);
      this.mode = "inFrameset";
      return;
    }
    // In body: only a frameset-ok document with a real <body> as the second
    // open element may be replaced; otherwise ignore the token.
    if (this.mode === "inFrameset") {
      this.insertElement("frameset", attrs);
      return;
    }
    const body = this.open[1];
    if (this.framesetOk && body !== undefined && body.name === "body") {
      detach(body);
      this.open.splice(1);
      this.bodyEl = null;
      this.insertElement("frameset", attrs);
      this.mode = "inFrameset";
    }
    // else: ignore the token.
  }

  private inFramesetStart(name: string, attrs: Array<MAttr>): void {
    // noframes is routed through the in-head handling earlier in onStart; other
    // tags are ignored.
    if (name === "frameset") {
      this.insertElement("frameset", attrs);
    } else if (name === "frame") {
      this.insertElement("frame", attrs);
      this.open.pop();
    }
  }

  private inTableContext(): boolean {
    return Arr.some(
      this.open,
      (el) =>
        el.name === "table" ||
        el.name === "tbody" ||
        el.name === "tfoot" ||
        el.name === "thead" ||
        el.name === "tr" ||
        el.name === "td" ||
        el.name === "th" ||
        el.name === "caption",
    );
  }

  private hasSelectInScope(): boolean {
    return this.hasInScope("select", DEFAULT_SCOPE);
  }

  /** An `<optgroup>` start tag: closes an open option / optgroup first. */
  private insertOptgroup(attrs: Array<MAttr>): void {
    if (this.current?.name === "option") this.open.pop();
    if (this.current?.name === "optgroup") this.open.pop();
    this.reconstructFormatting();
    this.insertElement("optgroup", attrs);
  }

  /**
   * A nested <select> acts as </select>; an <input> / <textarea> closes the
   * select and is reprocessed. Ignored when no select is in scope.
   */
  private leaveSelectFor(name: string, attrs: Array<MAttr>): void {
    if (!this.hasSelectInScope()) return;
    this.popUntilIncluding("select");
    this.resetInsertionMode();
    if (name !== "select") this.dispatchStart(name, attrs);
  }

  private inSelectStart(name: string, attrs: Array<MAttr>): void {
    if (name === "option") {
      if (this.current?.name === "option") this.open.pop();
      this.reconstructFormatting();
      this.insertElement("option", attrs);
      return;
    }
    if (name === "optgroup") {
      this.insertOptgroup(attrs);
      return;
    }
    if (name === "hr") {
      if (this.current?.name === "option") this.open.pop();
      if (this.current?.name === "optgroup") this.open.pop();
      this.insertElement("hr", attrs);
      this.open.pop();
      return;
    }
    if (name === "select" || name === "input" || name === "textarea") {
      this.leaveSelectFor(name, attrs);
      return;
    }
    // Other content is parsed with the in-body rules (it nests in the select).
    this.inBodyStart(name, attrs);
  }

  private inSelectInTableStart(name: string, attrs: Array<MAttr>): void {
    if (isIn(SELECT_TABLE_TAGS, name)) {
      this.popUntilIncluding("select");
      this.resetInsertionMode();
      this.dispatchStart(name, attrs);
      return;
    }
    return this.inSelectStart(name, attrs);
  }

  /** Process a start tag with the in-body rules but foster-parented (the "anything else in table" case). */
  private fosterInBody(name: string, attrs: Array<MAttr>): void {
    this.foster = true;
    this.inBodyStart(name, attrs);
    this.foster = false;
  }

  /** The table-structure start tags in "in table" (caption, colgroup, col, row groups, rows, cells); false for anything else. */
  private tableStructureStart(name: string, attrs: Array<MAttr>): boolean {
    if (name === "caption") {
      this.clearStackBackTo(TABLE_CONTEXT);
      this.afe.push(MARKER);
      this.insertElement("caption", attrs);
      this.mode = "inCaption";
      return true;
    }
    if (name === "colgroup") {
      this.clearStackBackTo(TABLE_CONTEXT);
      this.insertElement("colgroup", attrs);
      this.mode = "inColumnGroup";
      return true;
    }
    if (name === "col") {
      this.clearStackBackTo(TABLE_CONTEXT);
      this.insertElement("colgroup", []);
      this.mode = "inColumnGroup";
      this.inColumnGroupStart("col", attrs);
      return true;
    }
    if (name === "tbody" || name === "tfoot" || name === "thead") {
      this.clearStackBackTo(TABLE_CONTEXT);
      this.insertElement(name, attrs);
      this.mode = "inTableBody";
      return true;
    }
    if (name === "td" || name === "th" || name === "tr") {
      this.clearStackBackTo(TABLE_CONTEXT);
      this.insertElement("tbody", []);
      this.mode = "inTableBody";
      this.inTableBodyStart(name, attrs);
      return true;
    }
    return false;
  }

  private inTableStart(name: string, attrs: Array<MAttr>): void {
    if (this.tableStructureStart(name, attrs)) return;
    if (name === "table") {
      // Nested <table>: act as if </table> then reprocess.
      if (this.hasInScope("table", TABLE_SCOPE)) {
        this.popUntilIncluding("table");
        this.resetInsertionMode();
        this.dispatchStart("table", attrs);
      }
      return;
    }
    if (name === "style" || name === "script") {
      this.insertElement(name, attrs);
      return;
    }
    if (name === "form") {
      // In table: insert the form, set the pointer, and pop it immediately.
      if (this.formEl !== null || this.templateOpen) return;
      this.formEl = this.insertElement("form", attrs);
      this.open.pop();
      return;
    }
    // <input type=hidden> is inserted into the table; others foster out.
    if (
      name === "input" &&
      attrs.some((a) => a.name === "type" && a.value.toLowerCase() === "hidden")
    ) {
      this.insertElement("input", attrs);
      this.open.pop();
      return;
    }
    this.fosterInBody(name, attrs);
  }

  private inTableBodyStart(name: string, attrs: Array<MAttr>): void {
    if (name === "tr") {
      this.clearStackBackTo(TABLE_BODY_CONTEXT);
      this.insertElement("tr", attrs);
      this.mode = "inRow";
      return;
    }
    if (name === "td" || name === "th") {
      this.clearStackBackTo(TABLE_BODY_CONTEXT);
      this.insertElement("tr", []);
      this.mode = "inRow";
      this.inRowStart(name, attrs);
      return;
    }
    if (
      name === "caption" ||
      name === "col" ||
      name === "colgroup" ||
      name === "tbody" ||
      name === "tfoot" ||
      name === "thead"
    ) {
      if (this.hasAnyTableSection()) {
        this.clearStackBackTo(TABLE_BODY_CONTEXT);
        this.open.pop();
        this.mode = "inTable";
        this.dispatchStart(name, attrs);
      }
      return;
    }
    this.inTableStart(name, attrs);
  }

  private inRowStart(name: string, attrs: Array<MAttr>): void {
    if (name === "td" || name === "th") {
      this.clearStackBackTo(TABLE_ROW_CONTEXT);
      this.insertElement(name, attrs);
      this.mode = "inCell";
      this.afe.push(MARKER);
      return;
    }
    if (
      name === "caption" ||
      name === "col" ||
      name === "colgroup" ||
      name === "tbody" ||
      name === "tfoot" ||
      name === "thead" ||
      name === "tr"
    ) {
      if (this.hasInScope("tr", TABLE_SCOPE)) {
        this.clearStackBackTo(TABLE_ROW_CONTEXT);
        this.open.pop();
        this.mode = "inTableBody";
        this.dispatchStart(name, attrs);
      }
      return;
    }
    this.inTableStart(name, attrs);
  }

  private inCellStart(name: string, attrs: Array<MAttr>): void {
    if (isIn(STRAY_TABLE_TAGS, name)) {
      if (this.hasInScope("td", TABLE_SCOPE) || this.hasInScope("th", TABLE_SCOPE)) {
        this.closeCell();
        this.dispatchStart(name, attrs);
      }
      return;
    }
    return this.inBodyStart(name, attrs);
  }

  private inCaptionStart(name: string, attrs: Array<MAttr>): void {
    if (isIn(STRAY_TABLE_TAGS, name) || name === "table") {
      if (this.hasInScope("caption", TABLE_SCOPE)) {
        this.generateImpliedEndTags();
        this.popUntilIncluding("caption");
        this.clearFormattingToMarker();
        this.mode = "inTable";
        this.dispatchStart(name, attrs);
      }
      return;
    }
    return this.inBodyStart(name, attrs);
  }

  private inColumnGroupStart(name: string, attrs: Array<MAttr>): void {
    if (name === "col") {
      this.insertElement("col", attrs);
      this.open.pop();
      return;
    }
    if (this.current?.name === "colgroup") {
      this.open.pop();
      this.mode = "inTable";
      this.dispatchStart(name, attrs);
    }
  }

  private hasAnyTableSection(): boolean {
    return (
      this.hasInScope("tbody", TABLE_SCOPE) ||
      this.hasInScope("tfoot", TABLE_SCOPE) ||
      this.hasInScope("thead", TABLE_SCOPE)
    );
  }

  private closeCell(): void {
    const cell = this.hasInScope("td", TABLE_SCOPE) ? "td" : "th";
    this.generateImpliedEndTags();
    this.popUntilIncluding(cell);
    this.clearFormattingToMarker();
    this.mode = "inRow";
  }

  private clearFormattingToMarker(): void {
    popThrough(this.afe, isMarker);
  }

  private inBodyStart(name: string, attrs: Array<MAttr>): void {
    // <image> is a willful violation: it is treated as <img>.
    if (name === "image") name = "img";

    // Certain start tags make the document no longer frameset-ok, so a later
    // <frameset> can no longer replace the body.
    if (
      isIn(FRAMESET_NOT_OK, name) ||
      (name === "input" &&
        !attrs.some((a) => a.name === "type" && a.value.toLowerCase() === "hidden"))
    ) {
      this.framesetOk = false;
    }

    // Stray table-section start tags are ignored in the body.
    if (isIn(STRAY_TABLE_TAGS, name)) return;

    if (isIn(CLOSES_P, name) && this.hasInScope("p", BUTTON_SCOPE)) {
      // In quirks mode <table> does not close an open <p>.
      if (name !== "table" || !this.quirks) this.closeP();
    }

    // <pre>/<listing>/<textarea> swallow an immediately-following newline.
    if (name === "pre" || name === "listing" || name === "textarea") {
      this.ignoreLeadingNewline = true;
    }

    if (name === "form") {
      // Only one open form outside templates (the form element pointer).
      if (this.formEl !== null && !this.templateOpen) return;
      if (this.hasInScope("p", BUTTON_SCOPE)) this.closeP();
      const el = this.insertElement("form", attrs);
      if (!this.templateOpen) this.formEl = el;
      return;
    }

    if (name === "applet" || name === "marquee" || name === "object") {
      this.reconstructFormatting();
      this.insertElement(name, attrs);
      this.afe.push(MARKER);
      this.framesetOk = false;
      return;
    }

    if (name === "button") {
      // A <button> in scope is closed first.
      if (this.hasInScope("button", DEFAULT_SCOPE)) {
        this.generateImpliedEndTags();
        this.popUntilIncluding("button");
      }
      this.reconstructFormatting();
      this.insertElement("button", attrs);
      return;
    }

    if (name === "table") {
      this.insertElement("table", attrs);
      this.mode = "inTable";
      return;
    }

    if (name === "select") {
      this.reconstructFormatting();
      this.insertElement("select", attrs);
      this.mode = this.inTableContext() ? "inSelectInTable" : "inSelect";
      return;
    }

    if (name === "svg" || name === "math") {
      this.reconstructFormatting();
      const ns = name === "svg" ? SVG_NS : MATHML_NS;
      this.insertElement(name, adjustForeignAttrs(attrs, ns), ns);
      if (this.selfClosing) this.open.pop();
      return;
    }

    if (name === "optgroup") {
      this.insertOptgroup(attrs);
      return;
    }

    if (name === "option") {
      if (this.current?.name === "option") this.open.pop();
      this.reconstructFormatting();
      this.insertElement("option", attrs);
      return;
    }

    if (name === "li") {
      this.closeListItem("li", LIST_ITEM_SCOPE);
    } else if (name === "dd" || name === "dt") {
      this.closeListItem(name, DEFAULT_SCOPE, ["dd", "dt"]);
    }

    if (isIn(HEADINGS, name) && this.current && isIn(HEADINGS, this.current.name)) {
      this.open.pop();
    }

    if (name === "a") {
      // If an <a> is already in the active formatting list, run AAA on it first.
      const existing = this.lastFormatting("a");
      if (Option.isSome(existing)) {
        this.adoptionAgency("a");
        this.removeFromAfe(existing.value);
        const oi = this.open.indexOf(existing.value);
        if (oi !== -1) this.open.splice(oi, 1);
      }
    }

    if (name === "nobr" && this.hasInScope("nobr", DEFAULT_SCOPE)) {
      this.adoptionAgency("nobr");
    }

    // Ruby annotation tags close open ruby sub-parts (generate implied end tags).
    if (name === "rb" || name === "rtc") {
      this.generateImpliedEndTags();
      this.insertElement(name, attrs);
      return;
    }
    if (name === "rp" || name === "rt") {
      this.generateImpliedEndTags("rtc");
      this.insertElement(name, attrs);
      return;
    }

    // Block elements are inserted without reconstructing active formatting.
    if (isIn(BLOCK_INSERT, name)) {
      this.insertElement(name, attrs);
      return;
    }

    if (isIn(FORMATTING, name)) {
      this.reconstructFormatting();
      const el = this.insertElement(name, attrs);
      this.pushFormatting(el);
      return;
    }

    // void elements
    if (isIn(VOID, name)) {
      this.reconstructFormatting();
      const el = this.insertElement(name, attrs);
      this.open.pop();
      void el;
      return;
    }

    // Generic flow content.
    this.reconstructFormatting();
    this.insertElement(name, attrs);
  }

  private closeP(): void {
    this.generateImpliedEndTags("p");
    this.popUntilIncluding("p");
  }

  private closeListItem(name: string, scope: TagSet, names: ReadonlyArray<string> = [name]): void {
    // The topmost list item of the given kind, unless a special element (other
    // than address/div/p) comes first.
    const found = Arr.findLast(
      this.open,
      (el) =>
        names.includes(el.name) ||
        (isIn(scope, el.name) && el.name !== "p" && el.name !== "address" && el.name !== "div"),
    );
    if (Option.isSome(found) && names.includes(found.value.name)) {
      this.generateImpliedEndTags(found.value.name);
      this.popUntilIncluding(found.value.name);
    }
  }

  // --- end tags ------------------------------------------------------------

  private onEnd(name: string): void {
    this.ignoreLeadingNewline = false;
    // A matching raw-text/rcdata element (e.g. </noframes>) is always popped,
    // even in frameset modes where other end tags are ignored.
    if (this.isRawTextName(name) && this.current?.name === name) {
      this.open.pop();
      return;
    }
    if (name === "template") {
      // Processed via the "in head" rules; targets the HTML <template> (a foreign
      // <svg template> is a different element).
      if (!Arr.some(this.open, isHtmlTemplate)) return;
      this.generateImpliedEndTagsThoroughly();
      popThrough(this.open, isHtmlTemplate);
      this.clearFormattingToMarker();
      this.templateModes.pop();
      this.resetInsertionMode();
      return;
    }
    if (this.mode === "inHeadNoscript") {
      // </noscript> returns to "in head"; </br> reprocesses; others are ignored.
      if (name === "noscript") {
        this.open.pop();
        this.mode = "inHead";
        return;
      }
      if (name === "br") {
        this.open.pop();
        this.mode = "inHead";
        // fall through to the </br> handling below
      } else {
        return;
      }
    }
    // In table-structural modes, </html> and </body> are ignored (the table
    // insertion modes handle their own end tags below).
    const tableMode =
      this.mode === "inTable" ||
      this.mode === "inTableBody" ||
      this.mode === "inRow" ||
      this.mode === "inCell" ||
      this.mode === "inCaption" ||
      this.mode === "inColumnGroup";
    if (name === "html") {
      if (tableMode) {
        // fall through to the table mode dispatch (ignored there)
      } else if (this.mode === "afterFrameset" || this.mode === "afterAfterFrameset") {
        this.mode = "afterAfterFrameset";
        return;
      } else {
        // </html> cascades through head/body creation to "after after body".
        this.ensureBody();
        this.mode = "afterAfterBody";
        return;
      }
    }
    if (name === "frameset" && this.mode === "inFrameset") {
      if (this.current?.name === "html") return; // fragment edge: ignore
      this.open.pop();
      if (this.current?.name !== "frameset") this.mode = "afterFrameset";
      return;
    }
    if (name === "body" && !tableMode) {
      if (this.mode === "inFrameset" || this.mode === "afterFrameset") return;
      this.ensureBody();
      this.mode = "afterBody";
      return;
    }
    // In frameset modes all other end tags are ignored.
    if (
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset"
    ) {
      return;
    }

    // A </br> end tag is treated as a <br> start tag.
    if (name === "br") {
      this.onStart("br", []);
      return;
    }
    if (name === "head") {
      if (this.bodyEl !== null) return; // ignored once in the body
      // Cascade: ensure a head, pop it, and move to "after head".
      this.ensureHead();
      if (this.current?.name === "head") this.open.pop();
      this.mode = "afterHead";
      return;
    }

    // Table insertion modes handle their own end tags.
    if (this.endHandlers[this.mode](name)) return;

    // Before a body exists these end tags don't open one — they're ignored.
    const noBodyYet = this.bodyEl === null && !this.templateOpen;

    if (name === "p") {
      if (noBodyYet) return;
      if (!this.hasInScope("p", BUTTON_SCOPE)) {
        // Act as if <p></p> — insert an empty paragraph (foster-parented out of
        // a table when in a table insertion mode).
        const tableMode =
          this.mode === "inTable" || this.mode === "inTableBody" || this.mode === "inRow";
        if (tableMode) this.foster = true;
        this.insertElement("p", []);
        this.foster = false;
      }
      this.closeP();
      return;
    }

    if (isIn(FORMATTING, name)) {
      if (noBodyYet) return;
      this.adoptionAgency(name);
      return;
    }

    if (name === "form" && !this.templateOpen) {
      const node = this.formEl;
      this.formEl = null;
      const i = node ? this.open.indexOf(node) : -1;
      if (i === -1) return;
      this.generateImpliedEndTags();
      this.open.splice(i, 1);
      return;
    }

    if (name === "applet" || name === "marquee" || name === "object") {
      if (this.hasInScope(name, DEFAULT_SCOPE)) {
        this.generateImpliedEndTags();
        this.popUntilIncluding(name);
        this.clearFormattingToMarker();
      }
      return;
    }

    // Block elements: close to and including the named element if it's in scope.
    if (isIn(BLOCK_END, name)) {
      if (this.hasInScope(name, DEFAULT_SCOPE)) {
        this.generateImpliedEndTags();
        this.popUntilIncluding(name);
      }
      return;
    }

    if (name === "li") {
      if (this.hasInScope("li", LIST_ITEM_SCOPE)) {
        this.generateImpliedEndTags("li");
        this.popUntilIncluding("li");
      }
      return;
    }

    if (name === "dd" || name === "dt") {
      if (this.hasInScope(name, DEFAULT_SCOPE)) {
        this.generateImpliedEndTags(name);
        this.popUntilIncluding(name);
      }
      return;
    }

    if (isIn(HEADINGS, name)) {
      // Close the nearest heading of any level if one is in scope.
      const isHeading = (el: MElement): boolean => isIn(HEADINGS, el.name);
      if (this.inScope(isHeading, DEFAULT_SCOPE)) {
        this.generateImpliedEndTags();
        popThrough(this.open, isHeading);
      }
      return;
    }

    // Any other end tag — close the matching open element wherever it is (this
    // also pops head-level rcdata elements like </title> without forcing a body).
    this.anyOtherEndTag(name);
  }

  private anyOtherEndTag(name: string): void {
    // The topmost element with this name, unless a special element comes first
    // (then the end tag is ignored).
    const stop = Arr.findLastIndex(
      this.open,
      (el) => el.name === name || this.isSpecialElement(el),
    );
    if (Option.isNone(stop) || this.open[stop.value]?.name !== name) return;
    this.generateImpliedEndTags(name);
    // pop up to and including the element
    this.open.splice(stop.value);
  }

  // --- table-mode end tags (return true if handled) -----------------------

  /** End-tag handlers per insertion mode; `false` falls through to the in-body rules. */
  private readonly endHandlers: ModeTable<(name: string) => boolean> = {
    initial: () => false,
    beforeHtml: () => false,
    beforeHead: () => false,
    inHead: () => false,
    inHeadNoscript: () => false,
    afterHead: () => false,
    inBody: () => false,
    inTable: (name) => this.inTableEnd(name),
    inTableBody: (name) => this.inTableBodyEnd(name),
    inRow: (name) => this.inRowEnd(name),
    inCell: (name) => this.inCellEnd(name),
    inCaption: (name) => this.inCaptionEnd(name),
    inColumnGroup: (name) => this.inColumnGroupEnd(name),
    inSelect: (name) => this.inSelectEnd(name),
    inSelectInTable: (name) => this.inSelectInTableEnd(name),
    // Only </template> (handled in onEnd) is meaningful; ignore other end tags.
    inTemplate: () => true,
    inFrameset: () => false,
    afterFrameset: () => false,
    afterAfterFrameset: () => false,
    afterBody: () => false,
    afterAfterBody: () => false,
  };

  private inTableEnd(name: string): boolean {
    if (name === "table") {
      if (this.hasInScope("table", TABLE_SCOPE)) {
        this.popUntilIncluding("table");
        this.resetInsertionMode();
      }
      return true;
    }
    // body/caption/col/colgroup/html/tbody/td/tfoot/th/thead/tr: ignored here.
    return (
      name === "body" ||
      name === "caption" ||
      name === "col" ||
      name === "colgroup" ||
      name === "html" ||
      isIn(STRAY_TABLE_TAGS, name)
    );
  }

  private inTableBodyEnd(name: string): boolean {
    if (name === "tbody" || name === "tfoot" || name === "thead") {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.clearStackBackTo(TABLE_BODY_CONTEXT);
        this.open.pop();
        this.mode = "inTable";
      }
      return true;
    }
    if (name === "table") {
      if (this.hasAnyTableSection()) {
        this.clearStackBackTo(TABLE_BODY_CONTEXT);
        this.open.pop();
        this.mode = "inTable";
        this.onEnd("table");
      }
      return true;
    }
    if (
      name === "body" ||
      name === "caption" ||
      name === "col" ||
      name === "colgroup" ||
      name === "html" ||
      name === "td" ||
      name === "th" ||
      name === "tr"
    ) {
      return true;
    }
    return this.inTableEnd(name);
  }

  private inRowEnd(name: string): boolean {
    if (name === "tr") {
      if (this.hasInScope("tr", TABLE_SCOPE)) {
        this.clearStackBackTo(TABLE_ROW_CONTEXT);
        this.open.pop();
        this.mode = "inTableBody";
      }
      return true;
    }
    if (name === "table") {
      if (this.hasInScope("tr", TABLE_SCOPE)) {
        this.clearStackBackTo(TABLE_ROW_CONTEXT);
        this.open.pop();
        this.mode = "inTableBody";
        this.onEnd("table");
      }
      return true;
    }
    if (name === "tbody" || name === "tfoot" || name === "thead") {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        if (this.hasInScope("tr", TABLE_SCOPE)) {
          this.clearStackBackTo(TABLE_ROW_CONTEXT);
          this.open.pop();
          this.mode = "inTableBody";
        }
        this.onEnd(name);
      }
      return true;
    }
    if (
      name === "body" ||
      name === "caption" ||
      name === "col" ||
      name === "colgroup" ||
      name === "html" ||
      name === "td" ||
      name === "th"
    ) {
      return true;
    }
    return this.inTableEnd(name);
  }

  private inCellEnd(name: string): boolean {
    if (name === "td" || name === "th") {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.generateImpliedEndTags();
        this.popUntilIncluding(name);
        this.clearFormattingToMarker();
        this.mode = "inRow";
      }
      return true;
    }
    if (
      name === "table" ||
      name === "tbody" ||
      name === "tfoot" ||
      name === "thead" ||
      name === "tr"
    ) {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.closeCell();
        this.onEnd(name);
      }
      return true;
    }
    if (
      name === "body" ||
      name === "caption" ||
      name === "col" ||
      name === "colgroup" ||
      name === "html"
    ) {
      return true;
    }
    return false; // anything else uses the in-body rules
  }

  private inCaptionEnd(name: string): boolean {
    if (name === "caption" || name === "table") {
      if (this.hasInScope("caption", TABLE_SCOPE)) {
        this.generateImpliedEndTags();
        this.popUntilIncluding("caption");
        this.clearFormattingToMarker();
        this.mode = "inTable";
        if (name === "table") this.onEnd("table");
      }
      return true;
    }
    if (
      name === "body" ||
      name === "col" ||
      name === "colgroup" ||
      name === "html" ||
      isIn(STRAY_TABLE_TAGS, name)
    ) {
      return true;
    }
    return false; // anything else uses the in-body rules
  }

  private inSelectEnd(name: string): boolean {
    if (name === "optgroup") {
      if (this.current?.name === "option" && this.open.at(-2)?.name === "optgroup") {
        this.open.pop();
      }
      if (this.current?.name === "optgroup") this.open.pop();
      return true;
    }
    if (name === "option") {
      if (this.current?.name === "option") this.open.pop();
      return true;
    }
    if (name === "select") {
      if (this.hasSelectInScope()) {
        this.popUntilIncluding("select");
        this.resetInsertionMode();
      }
      return true;
    }
    return false; // other end tags use the in-body rules
  }

  private inSelectInTableEnd(name: string): boolean {
    if (isIn(SELECT_TABLE_TAGS, name)) {
      if (this.hasInScope(name, TABLE_SCOPE)) {
        this.popUntilIncluding("select");
        this.resetInsertionMode();
        this.onEnd(name);
      }
      return true;
    }
    return this.inSelectEnd(name);
  }

  private inColumnGroupEnd(name: string): boolean {
    if (name === "colgroup") {
      if (this.current?.name === "colgroup") {
        this.open.pop();
        this.mode = "inTable";
      }
      return true;
    }
    if (name === "col") return true;
    if (this.current?.name === "colgroup") {
      this.open.pop();
      this.mode = "inTable";
      this.onEnd(name);
      return true;
    }
    return true;
  }

  // --- active formatting helpers ------------------------------------------

  /** The last active formatting element with this name after the last marker. */
  private lastFormatting(name: string): Option.Option<MElement> {
    return Option.filter(
      Arr.findLast(this.afe, (e) => isMarker(e) || e.name === name),
      isFormattingElement,
    );
  }

  private removeFromAfe(el: MElement): void {
    const i = this.afe.indexOf(el);
    if (i !== -1) this.afe.splice(i, 1);
  }

  // --- the adoption agency algorithm --------------------------------------

  /** Insert a node into a target, foster-parenting if the target is a table section. */
  private fosterOrAppend(target: MElement, node: MNode): void {
    const anchor = isFosterTarget(target) ? this.fosterAnchor() : Option.none<StackEntry>();
    if (Option.isNone(anchor)) {
      appendChild(target, node);
      return;
    }
    const { el, index } = anchor.value;
    if (isHtmlTemplate(el)) {
      appendChild(el, node);
    } else if (el.parent !== null) {
      insertBefore(el.parent, node, el);
    } else {
      const prev = this.open[index - 1];
      if (prev) appendChild(prev, node);
    }
  }

  private adoptionAgency(subject: string): void {
    // Step 1
    const cur = this.current;
    if (cur && cur.name === subject && !this.afe.includes(cur)) {
      this.open.pop();
      return;
    }

    let outer = 0;
    while (outer < 8) {
      outer++;

      // Step 4.3: formatting element
      const formatting = this.lastFormatting(subject);
      if (Option.isNone(formatting)) {
        this.anyOtherEndTag(subject);
        return;
      }
      const formattingElement = formatting.value;
      // Step 4.4
      const feOpenIdx = this.open.indexOf(formattingElement);
      if (feOpenIdx === -1) {
        this.removeFromAfe(formattingElement);
        return;
      }
      // Step 4.5 (a <select> ancestor also bounds the scope, so a formatting
      // element outside an open select is not adopted across it).
      if (!this.hasInScope(formattingElement.name, AAA_SCOPE)) {
        return;
      }
      // Step 4.7: furthest block
      const furthest = Arr.findFirst(
        this.open,
        (el, i) => i > feOpenIdx && this.isSpecialElement(el),
      );
      // Step 4.8
      if (Option.isNone(furthest)) {
        this.open.splice(feOpenIdx);
        this.removeFromAfe(formattingElement);
        return;
      }
      const furthestBlock = furthest.value;
      // Step 4.9 (the formatting element is never the root <html>, so it always
      // has an element below it on the stack)
      const commonAncestor = this.open[feOpenIdx - 1];
      if (commonAncestor === undefined) return;
      // Step 4.10: bookmark
      let bookmark = this.afe.indexOf(formattingElement);
      // Step 4.11
      let node = furthestBlock;
      let lastNode = furthestBlock;
      let nodeIdx = this.open.indexOf(node);
      let inner = 0;
      while (true) {
        inner++;
        nodeIdx--;
        // The formatting element is below the furthest block, so it is reached
        // before the walk runs off the stack.
        const next = this.open[nodeIdx];
        if (next === undefined || next === formattingElement) break;
        node = next;
        const afeIdx = this.afe.indexOf(node);
        if (inner > 3 && afeIdx !== -1) {
          this.afe.splice(afeIdx, 1);
          if (afeIdx < bookmark) bookmark--;
          continue;
        }
        if (afeIdx === -1) {
          // remove from open, keep nodeIdx pointing correctly
          this.open.splice(nodeIdx, 1);
          continue;
        }
        // Create a clone, replace in afe and open
        const clone = mkElement(
          node.name,
          node.attrs.map((a) => ({ ...a })),
        );
        this.afe[afeIdx] = clone;
        this.open[nodeIdx] = clone;
        node = clone;
        if (lastNode === furthestBlock) {
          bookmark = afeIdx + 1;
        }
        appendChild(node, lastNode);
        lastNode = node;
      }
      // Step 4.12: place lastNode at the appropriate place in the common
      // ancestor (foster-parented when the ancestor is a table section).
      this.fosterOrAppend(commonAncestor, lastNode);
      // Step 4.13: clone formatting element
      const feClone = mkElement(
        formattingElement.name,
        formattingElement.attrs.map((a) => ({ ...a })),
      );
      // Step 4.14: move furthestBlock children to clone
      Arr.forEach(Arr.copy(furthestBlock.children), (child) => appendChild(feClone, child));
      // Step 4.15: append clone to furthestBlock
      appendChild(furthestBlock, feClone);
      // Step 4.16/4.17: fix active formatting list
      this.removeFromAfe(formattingElement);
      // bookmark may be stale after removal; clamp
      if (bookmark > this.afe.length) bookmark = this.afe.length;
      this.afe.splice(bookmark, 0, feClone);
      // Step 4.18/4.19: fix open elements stack
      const feStackIdx = this.open.indexOf(formattingElement);
      if (feStackIdx !== -1) this.open.splice(feStackIdx, 1);
      const fbStackIdx = this.open.indexOf(furthestBlock);
      this.open.splice(fbStackIdx + 1, 0, feClone);
    }
  }

  // --- finishing -----------------------------------------------------------

  /**
   * Fill each `<selectedcontent>` with a deep clone of its select's currently
   * selected option (the first `<option selected>`, else the first option).
   */
  private populateSelectedContent(): void {
    // The element children of `el` that belong to `select` (not nested selects).
    const ownChildren = (select: MElement, el: MElement): Array<MElement> =>
      Arr.filter(
        Arr.filter(el.children, isElementNode),
        (c) => c.name !== "select" || c === select,
      );
    // The select's options in tree order.
    const optionsOf = (select: MElement, el: MElement): Array<MElement> =>
      Arr.flatMap(ownChildren(select, el), (c) =>
        c.name === "option" && c.ns === HTML_NS
          ? [c, ...optionsOf(select, c)]
          : optionsOf(select, c),
      );
    const findSelected = (select: MElement): Option.Option<MElement> => {
      const options = optionsOf(select, select);
      return Option.orElse(
        Arr.findFirst(options, (o) => o.attrs.some((a) => a.name === "selected")),
        () => Arr.head(options),
      );
    };
    const fill = (select: MElement, opt: MElement): void => {
      const walk = (el: MElement): void =>
        Arr.forEach(ownChildren(select, el), (c) => {
          if (c.name === "selectedcontent" && c.ns === HTML_NS) {
            adoptChildren(c, Arr.map(opt.children, cloneMNode));
          } else {
            walk(c);
          }
        });
      walk(select);
    };
    const visit = (el: MElement): void => {
      if (el.name === "select" && el.ns === HTML_NS) {
        const opt = findSelected(el);
        if (Option.isSome(opt)) fill(el, opt.value);
      }
      Arr.forEach(Arr.filter(el.children, isElementNode), visit);
    };
    Arr.forEach(Arr.filter(this.topLevel, isElementNode), visit);
  }

  /** The end-of-input steps both {@link finish} and {@link finishFragment} take first. */
  private closeAtEof(): void {
    // Close any templates still open at EOF (the "in template" EOF rule) so a
    // synthesized body never lands inside template contents. Only HTML templates
    // carry a template insertion mode (a foreign <svg template> does not).
    // Each template insertion mode closes one open HTML <template> (a template
    // fragment context has a mode but no element, so it closes nothing).
    Arr.forEach(this.templateModes, () => {
      if (Arr.some(this.open, isHtmlTemplate)) popThrough(this.open, isHtmlTemplate);
    });
    this.templateModes.splice(0);

    // An unclosed raw-text/rcdata element (e.g. <script> with no </script>) is
    // popped at EOF (the "text" insertion mode's EOF rule) so that nothing nests
    // inside it.
    popWhile(this.open, (el) => this.isRawTextName(el.name));
  }

  /** The fragment case's result: the root element's children (WHATWG step 15). */
  finishFragment(): ReadonlyArray<XmlNode> {
    this.closeAtEof();
    this.populateSelectedContent();
    const root = this.htmlEl;
    if (root === null) return [];
    const built = toXmlNode(root);
    return built instanceof XmlElement ? built.children : [];
  }

  finish(): XmlDocument {
    this.closeAtEof();

    // Ensure a minimal valid document exists (but never add a <body> to a
    // frameset document).
    this.ensureHtml();
    if (this.headEl === null) this.ensureHead();
    const isFrameset =
      this.mode === "inFrameset" ||
      this.mode === "afterFrameset" ||
      this.mode === "afterAfterFrameset";
    if (this.bodyEl === null && !isFrameset) this.ensureBody();

    this.populateSelectedContent();

    const children: Array<XmlNode> = this.topLevel.map(toXmlNode);
    return Nodes.document(null, this.doctype, children);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const sameAttrs = (a: ReadonlyArray<MAttr>, b: ReadonlyArray<MAttr>): boolean =>
  a.length === b.length &&
  Arr.every(a, (x) => {
    const y = b.find((z) => z.name === x.name);
    return y !== undefined && y.value === x.value;
  });

const mergeAttrs = (el: MElement, attrs: ReadonlyArray<MAttr>): void =>
  Arr.forEach(attrs, (a) => {
    if (!el.attrs.some((x) => x.name === a.name)) el.attrs.push({ ...a });
  });

/** Make `children` the children of `parent`. */
const adoptChildren = (parent: MElement, children: Array<MNode>): void => {
  parent.children = children;
  Arr.forEach(children, (child) => {
    child.parent = parent;
  });
};

// The mutable DOM's own `_t` discriminant, checked directly: these two run
// once per node of every document, where a compiled `Match` costs a third of
// the parse.
const cloneMNode = (node: MNode): MNode => {
  if (node._t === "element") {
    const el = mkElement(
      node.name,
      node.attrs.map((a) => ({ ...a })),
      node.ns,
    );
    adoptChildren(el, Arr.map(node.children, cloneMNode));
    return el;
  }
  if (node._t === "pi") return { _t: "pi", target: node.target, data: node.data, parent: null };
  return { _t: node._t, data: node.data, parent: null };
};

const toXmlLeaf = (node: Exclude<MNode, MElement>): XmlNode => {
  if (node._t === "text") return Nodes.text(node.data);
  if (node._t === "comment") return Nodes.comment(node.data);
  if (node._t === "cdata") return Nodes.cdata(node.data);
  return Nodes.processingInstruction(node.target, node.data);
};

const toXmlElement = (node: MElement, children: ReadonlyArray<XmlNode>): XmlElement =>
  Nodes.element(
    Nodes.qname(null, node.name, node.ns),
    node.attrs.map((a) =>
      Nodes.attribute(Nodes.qname(a.prefix ?? null, a.name, a.ns ?? null), a.value),
    ),
    children,
  );

/** Convert to the immutable DOM, iteratively so deep trees can't overflow the stack. */
const toXmlNode = (root: MNode): XmlNode => {
  if (root._t !== "element") return toXmlLeaf(root);
  // Post-order: an element is built once all of its children have been.
  const stack: Array<{ readonly node: MElement; readonly children: Array<XmlNode> }> = [
    { node: root, children: [] },
  ];
  for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
    const next = frame.node.children[frame.children.length];
    if (next === undefined) {
      stack.pop();
      const el = toXmlElement(frame.node, frame.children);
      const parent = stack.at(-1);
      if (parent === undefined) return el;
      parent.children.push(el);
    } else if (next._t === "element") {
      stack.push({ node: next, children: [] });
    } else {
      frame.children.push(toXmlLeaf(next));
    }
  }
  // The loop returns when it closes the root; the stack never empties first.
  return toXmlElement(root, []);
};

// -----------------------------------------------------------------------------
// Public driver
// -----------------------------------------------------------------------------

/**
 * Build a full HTML document (with implicit html/head/body) from a stream of
 * HTML-mode SAX events. Never fails on malformed markup; the error channel
 * carries only the input stream's own failures.
 *
 * @since 0.2.0
 * @category parsing
 */
export const buildDocument = <E, R>(
  events: Stream.Stream<SaxEvent, E, R>,
  options?: {
    readonly limits?: Partial<Limits> | undefined;
    readonly scripting?: boolean | undefined;
  },
): Effect.Effect<XmlDocument, SaxError | E, R> =>
  Effect.gen(function* () {
    const builder = new HtmlTreeBuilder({
      limits: resolveLimits(options?.limits),
      scripting: options?.scripting,
    });
    yield* acceptAll(events, (ev) => builder.accept(ev));
    return builder.finish();
  });

/** Options for the coupled string drivers. */
interface StringBuildOptions {
  readonly entities?: Record<string, string> | undefined;
  readonly limits?: Partial<Limits> | undefined;
  readonly scripting?: boolean | undefined;
}

/**
 * Run the tokenizer and a tree builder over a string in lockstep: after each
 * event the builder tells the tokenizer whether it is inside foreign content,
 * so raw-text/rcdata elements (title/style/script/textarea/plaintext) inside
 * SVG/MathML are parsed as ordinary elements.
 */
const runCoupled = <A>(
  input: string,
  options: StringBuildOptions | undefined,
  context: FragmentContext | undefined,
  result: (builder: HtmlTreeBuilder) => A,
): Effect.Effect<A, SaxError> =>
  Effect.suspend(() => {
    const opts = resolveSaxOptions({
      mode: "html",
      entities: options?.entities,
      limits: options?.limits,
      scripting: options?.scripting,
    });
    const lexer = new Lexer({
      mode: "html",
      entities: opts.entities,
      content: false,
      scripting: opts.scripting,
    });
    const guard = new Guard(opts.limits, false);
    const builder = new HtmlTreeBuilder({
      limits: opts.limits,
      scripting: opts.scripting,
      context,
    });
    const over = guard.input(input.length, lexer);
    if (over !== null) return Effect.fail(over);
    if (context !== undefined && context.ns === HTML_NS) lexer.startInContext(context.name);
    lexer.suppressRawText = builder.currentIsForeignContent();
    // One token at a time, so the builder can switch raw text off in between.
    lexer.push(input);
    lexer.close();
    for (let outs = lexer.pull(); outs !== null; outs = lexer.pull()) {
      for (const o of outs) {
        if (isFault(o)) continue; // HTML mode never faults
        const limit = guard.event(o);
        if (limit !== null) return Effect.fail(limit);
        const ev = convertLexEvent(o, opts);
        const failed = ev === null ? null : tryAccept(() => builder.accept(ev));
        if (failed !== null) return Effect.fail(failed);
        lexer.suppressRawText = builder.currentIsForeignContent();
      }
    }
    return Effect.succeed(result(builder));
  });

/**
 * Build an HTML document from a string with the tokenizer and tree builder
 * coupled: after each event the builder tells the tokenizer whether it is inside
 * foreign content, so raw-text/rcdata elements (title/style/script/textarea/
 * plaintext) inside SVG/MathML are parsed as ordinary elements.
 *
 * @since 0.2.0
 * @category parsing
 */
export const buildDocumentString = (
  input: string,
  options?: StringBuildOptions,
): Effect.Effect<XmlDocument, SaxError> =>
  runCoupled(input, options, undefined, (builder) => builder.finish());

/**
 * Parse an HTML fragment from a string with the WHATWG fragment parsing
 * algorithm, in the given context element: the nodes a browser's
 * `innerHTML` setter would put in that element.
 *
 * @since 0.3.0
 * @category parsing
 */
export const buildFragmentString = (
  input: string,
  context: FragmentContext,
  options?: StringBuildOptions,
): Effect.Effect<ReadonlyArray<XmlNode>, SaxError> =>
  runCoupled(input, options, context, (builder) => builder.finishFragment());
