/**
 * The XML writer: events (or a DOM) to well-formed XML, streaming.
 *
 * {@link write} turns a `Stream` of {@link WriterEvent}s into a `Stream` of
 * strings (or bytes, with {@link writeBytes}) in constant memory, so a very
 * large document (an XLSX sheet, say) can be generated row by row. It:
 *
 * - **manages namespaces**: names carry namespace URIs ({@link QName}), and
 *   the writer declares each binding where it is first needed (or on the root
 *   element, for the `prefixes` you supply), reuses bindings already in scope
 *   instead of redeclaring them, and emits declarations in a fixed order;
 * - **escapes correctly**: `&`, `<`, `>` in text; `&`, `<`, `"` and tab, CR,
 *   LF (as character references, so they survive attribute normalization) in
 *   attribute values; a CDATA section containing `]]>` is split in two;
 * - **checks what can't be escaped**: characters XML 1.0 forbids, a comment
 *   containing `--` or ending in `-`, a PI containing `?>` or targeting `xml`.
 *   The `invalid` policy decides: fail with a {@link SerializationError}
 *   (the default), strip, or replace (with U+FFFD, or spaces in comments and
 *   PIs). An `escape` hook can encode forbidden characters first, e.g. as
 *   OOXML's `_xHHHH_`.
 *
 * {@link serialize} does the same for a DOM node or document, declaring the
 * namespaces the tree uses on its root.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Str from "effect/String";
import { Namespaces, QName } from "../Name.ts";
import { quote } from "../internal/quote.ts";
import { byKey, byNamespaceThenLocal } from "../internal/order.ts";
import { isEnter, preorder } from "../internal/tree.ts";
import { XmlDocument, type XmlAttribute, type XmlElement, type XmlNode } from "./Node.ts";

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

/**
 * What the writer writes. Names are namespace-aware {@link QName}s.
 *
 * @since 0.3.0
 * @category models
 */
export type WriterEvent =
  | {
      readonly _tag: "StartElement";
      readonly name: QName;
      readonly attributes: ReadonlyArray<XmlAttribute>;
      /**
       * The element has text content, so pretty-printing must not add
       * whitespace inside it. (Set by {@link events}; when streaming, text in
       * an element turns indentation off from there on anyway.)
       */
      readonly inline?: boolean | undefined;
    }
  | { readonly _tag: "EndElement" }
  | { readonly _tag: "Text"; readonly data: string }
  | { readonly _tag: "CData"; readonly data: string }
  | { readonly _tag: "Comment"; readonly data: string }
  | { readonly _tag: "ProcessingInstruction"; readonly target: string; readonly data: string };

const toQName = (name: string | QName): QName =>
  Predicate.isString(name) ? QName.fromRaw(name) : name;

/**
 * A start tag.
 *
 * @since 0.3.0
 * @category constructors
 */
export const start = (
  name: string | QName,
  attributes: ReadonlyArray<XmlAttribute> = [],
  inline?: boolean,
): WriterEvent => ({
  _tag: "StartElement",
  name: toQName(name),
  attributes,
  inline,
});

/**
 * An end tag (for the innermost open element).
 *
 * @since 0.3.0
 * @category constructors
 */
export const end: WriterEvent = { _tag: "EndElement" };

/**
 * Character data.
 *
 * @since 0.3.0
 * @category constructors
 */
export const text = (data: string): WriterEvent => ({ _tag: "Text", data });

/**
 * A CDATA section.
 *
 * @since 0.3.0
 * @category constructors
 */
export const cdata = (data: string): WriterEvent => ({ _tag: "CData", data });

/**
 * A comment.
 *
 * @since 0.3.0
 * @category constructors
 */
export const comment = (data: string): WriterEvent => ({ _tag: "Comment", data });

/**
 * A processing instruction.
 *
 * @since 0.3.0
 * @category constructors
 */
export const processingInstruction = (target: string, data = ""): WriterEvent => ({
  _tag: "ProcessingInstruction",
  target,
  data,
});

const WriterEvent = Data.taggedEnum<WriterEvent>();
const matchWriterEvent = WriterEvent.$match;
const isStartEvent = WriterEvent.$is("StartElement");

const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");

/** The event a node starts with (an element's start tag; all of a leaf). */
const eventOf = (node: XmlNode): WriterEvent =>
  Match.valueTags(node, {
    XmlElement: (e): WriterEvent => ({
      _tag: "StartElement",
      name: e.name,
      attributes: e.attributes,
      // Whitespace-only text is layout, which pretty-printing replaces.
      inline: e.children.some(
        (c) =>
          Predicate.isTagged(c, "XmlCData") ||
          (Predicate.isTagged(c, "XmlText") && /[^ \t\r\n]/.test(c.data)),
      ),
    }),
    XmlText: (t): WriterEvent => ({ _tag: "Text", data: t.data }),
    XmlCData: (t): WriterEvent => ({ _tag: "CData", data: t.data }),
    XmlComment: (c): WriterEvent => ({ _tag: "Comment", data: c.data }),
    XmlProcessingInstruction: (pi): WriterEvent => ({
      _tag: "ProcessingInstruction",
      target: pi.target,
      data: pi.data,
    }),
  });

/**
 * The events of a node (without recursion, so any depth is fine).
 *
 * @since 0.3.0
 * @category conversions
 */
export function* events(node: XmlNode | XmlDocument): Generator<WriterEvent> {
  yield* Iterable.map(
    preorder(node instanceof XmlDocument ? node.children : [node], (n) =>
      isElement(n) ? n.children : undefined,
    ),
    (step) => (isEnter(step) ? eventOf(step.node) : end),
  );
}

// -----------------------------------------------------------------------------
// Options and errors
// -----------------------------------------------------------------------------

/**
 * What can't be written as asked.
 *
 * @since 0.3.0
 * @category errors
 */
export class SerializationError extends Schema.TaggedError<SerializationError>()(
  "SerializationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Cannot serialize: ${this.reason}`;
  }
}

/**
 * Options for the writer: declaration, encoding, indentation, handling of characters XML 1.0 forbids, and namespace management.
 *
 * @since 0.3.0
 * @category options
 */
export interface WriterOptions {
  /** Emit an XML declaration (default `false`), optionally with `standalone`. */
  readonly declaration?: boolean | { readonly standalone?: boolean } | undefined;
  /** The encoding named in the declaration and used by {@link writeBytes} (default `"utf-8"`). */
  readonly encoding?: "utf-8" | "utf-16" | undefined;
  /**
   * Pretty-print with this indentation (spaces, or the string itself).
   * Whitespace is never added inside elements with text content, or under
   * `xml:space="preserve"`; whitespace-only text is dropped elsewhere.
   */
  readonly indent?: number | string | undefined;
  /** Write empty elements as `<a/>` (default `true`), or `<a></a>`; or decide per element. */
  readonly selfClose?: boolean | ((name: QName) => boolean) | undefined;
  /** What to do with content XML can't represent (see the module docs). Default `"fail"`. */
  readonly invalid?: "fail" | "strip" | "replace" | undefined;
  /**
   * Encode a character XML 1.0 forbids, before `invalid` applies: return its
   * replacement (written as text, so escaped as usual), or `undefined` to
   * leave it to `invalid`. OOXML: `(cp) => "_x" + cp.toString(16).toUpperCase().padStart(4, "0") + "_"`.
   */
  readonly escape?: ((codePoint: number) => string | undefined) | undefined;
  /** Preferred prefixes (prefix → namespace URI), declared on the root element. */
  readonly prefixes?: Readonly<Record<string, string>> | undefined;
  /** Sort attributes by namespace URI and local name (default: as given). */
  readonly sortAttributes?: boolean | undefined;
  /**
   * `"manage"` (default) declares namespaces as described above. `"asIs"`
   * writes names as their prefixes say and adds no declarations, for trees
   * that already carry their `xmlns` attributes.
   */
  readonly namespaces?: "manage" | "asIs" | undefined;
}

// -----------------------------------------------------------------------------
// Characters
// -----------------------------------------------------------------------------

// Characters XML 1.0 forbids (lone surrogates included, thanks to the `u` flag).
const INVALID = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const INVALID_ALL = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

const escapeTextChars = (s: string): string =>
  s.replace(/[&<>\r]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#xD;",
  );

const escapeAttributeChars = (s: string): string =>
  s.replace(/[&<>"\t\n\r]/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : c === "\t"
              ? "&#x9;"
              : c === "\n"
                ? "&#xA;"
                : "&#xD;",
  );

/** Namespace bindings: prefix (`""` for the default namespace) to URI, in declaration order. */
type Bindings = Record.ReadonlyRecord<string, string>;

// -----------------------------------------------------------------------------
// The writer
// -----------------------------------------------------------------------------

interface Frame {
  readonly name: string;
  /** Prefix → URI bindings in scope inside this element (`""`: the default namespace). */
  readonly scope: Bindings;
  /** No whitespace may be added inside (text content, or `xml:space="preserve"`). */
  inline: boolean;
  readonly preserve: boolean;
  hasChildren: boolean;
}

const INITIAL_SCOPE: Bindings = { xml: Namespaces.xml, "": "" };

/** @internal The writer's state machine: one event in, some text out. */
export class XmlWriter {
  private readonly stack: Array<Frame> = [];
  /** A start tag waiting for `>` or `/>`, until we know whether the element is empty. */
  private pendingStart: QName | null = null;
  private started = false;
  private topLevelNodes = 0;
  private readonly indent: string | null;
  private readonly invalid: "fail" | "strip" | "replace";

  private readonly options: WriterOptions;

  constructor(options: WriterOptions = {}) {
    this.options = options;
    const i = options.indent;
    this.indent = i === undefined ? null : Predicate.isNumber(i) ? " ".repeat(i) : i;
    this.invalid = options.invalid ?? "fail";
  }

  private get scope(): Bindings {
    return this.stack.at(-1)?.scope ?? INITIAL_SCOPE;
  }

  // --- content ---------------------------------------------------------------

  /** Encode, strip or replace characters XML forbids; `null` when the policy is to fail. */
  private chars(s: string, what: string): string | SerializationError {
    if (!INVALID.test(s)) return s;
    let failed: string | null = null;
    const out = s.replace(INVALID_ALL, (c) => {
      // `c` is one matched character, so it has a code point.
      const cp = c.codePointAt(0) ?? 0;
      const escaped = this.options.escape?.(cp);
      if (escaped !== undefined) return escaped;
      if (this.invalid === "strip") return "";
      if (this.invalid === "replace") return "�";
      failed ??= `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
      return c;
    });
    return failed === null
      ? out
      : new SerializationError({
          reason: `${what} contains ${failed}, which XML 1.0 does not allow`,
        });
  }

  private text(data: string, attribute: boolean): string | SerializationError {
    const s = this.chars(data, attribute ? "an attribute value" : "text");
    if (!Predicate.isString(s)) return s;
    return attribute ? escapeAttributeChars(s) : escapeTextChars(s);
  }

  /** Content that can't be escaped (comments, PIs): fail, or patch it up. */
  private unescapable(
    s: string,
    what: string,
    bad: RegExp,
    fix: (s: string) => string,
  ): string | SerializationError {
    const chars = this.chars(s, what);
    if (!Predicate.isString(chars)) return chars;
    if (!bad.test(chars)) return chars;
    if (this.invalid === "fail")
      return new SerializationError({
        reason: `${what} contains ${quote(chars.match(bad)?.[0] ?? "")}`,
      });
    return fix(chars);
  }

  // --- layout ----------------------------------------------------------------

  /** Close a pending start tag, as `>` (the element has content). */
  private flush(): string {
    if (this.pendingStart === null) return "";
    this.pendingStart = null;
    return ">";
  }

  /** Whitespace before a child node, when pretty-printing. */
  private newline(): string {
    if (this.indent === null) return "";
    const parent = this.stack[this.stack.length - 1];
    if (parent === undefined) return this.started ? "\n" : "";
    if (parent.inline) return "";
    return "\n" + this.indent.repeat(this.stack.length);
  }

  private beforeNode(): string {
    let out = this.prolog();
    out += this.flush();
    out += this.newline();
    const parent = this.stack[this.stack.length - 1];
    if (parent !== undefined) parent.hasChildren = true;
    else this.topLevelNodes++;
    this.started = true;
    return out;
  }

  /** The XML declaration, before anything else. */
  private prolog(): string {
    if (this.started) return "";
    const d = this.options.declaration;
    if (d === undefined || d === false) return "";
    this.started = true;
    const encoding = this.options.encoding === "utf-16" ? "UTF-16" : "UTF-8";
    const standalone =
      Predicate.isObjectOrArray(d) && d.standalone !== undefined
        ? ` standalone="${d.standalone ? "yes" : "no"}"`
        : "";
    return `<?xml version="1.0" encoding="${encoding}"${standalone}?>`;
  }

  // --- names -----------------------------------------------------------------

  /** Pick prefixes for an element and its attributes, adding the declarations needed. */
  private names(ev: Extract<WriterEvent, { _tag: "StartElement" }>):
    | {
        element: string;
        attributes: Array<readonly [string, string]>;
        decls: Bindings;
        scope: Bindings;
      }
    | SerializationError {
    let scope: Bindings = this.scope;
    let decls: Bindings = {};
    const declare = (prefix: string, uri: string) => {
      if (Option.getOrUndefined(Record.get(scope, prefix)) === uri) return;
      decls = Record.set(decls, prefix, uri);
      scope = Record.set(scope, prefix, uri);
    };
    // The first prefix (in declaration order) bound to `uri`.
    const prefixFor = (uri: string): string | undefined =>
      Option.getOrUndefined(
        Arr.findFirst(Record.toEntries(scope), ([p, u]) =>
          u === uri && p !== "" ? Option.some(p) : Option.none(),
        ),
      );
    /** The prefix the element's own name uses: rebinding it would change the element's namespace. */
    let elementPrefix: string | null = null;
    /** A prefix to declare for `uri`: the one asked for, a preferred one, or a new `nsN`. */
    const fresh = (preferred: string | null, uri: string): string => {
      const candidates = [
        preferred,
        ...Arr.filterMap(Record.toEntries(this.options.prefixes ?? {}), ([p, u]) =>
          u === uri ? Result.succeed(p) : Result.failVoid,
        ),
      ];
      const usable = Arr.findFirst(
        candidates,
        (p): p is string =>
          p !== null &&
          p !== "" &&
          p !== "xml" &&
          p !== "xmlns" &&
          p !== elementPrefix &&
          // A prefix this element already declared for something else is taken.
          !(Record.has(decls, p) && Option.getOrUndefined(Record.get(decls, p)) !== uri),
      );
      if (Option.isSome(usable)) return usable.value;
      // One of the first `size + 1` is free: there are only `size` bindings.
      return Option.getOrElse(
        Arr.findFirst(Arr.range(0, Record.size(scope)), (i) => !Record.has(scope, `ns${i}`)).pipe(
          Option.map((i) => `ns${i}`),
        ),
        () => `ns${Record.size(scope)}`,
      );
    };

    // Declarations the input asks for (xmlns attributes), and the preferred
    // prefixes on the root element.
    const attributes = ev.attributes.filter((a) => {
      const isDeclaration =
        a.name.namespace === Namespaces.xmlns ||
        a.name.qualified === "xmlns" ||
        a.name.prefix === "xmlns";
      if (isDeclaration) declare(a.name.qualified === "xmlns" ? "" : a.name.local, a.value);
      return !isDeclaration;
    });
    if (Arr.isReadonlyArrayEmpty(this.stack)) {
      Arr.sort(Record.toEntries(this.options.prefixes ?? {}), byKey).forEach(([p, uri]) =>
        declare(p, uri),
      );
    }

    // The element's own name.
    const name = ev.name;
    let element: string;
    if (name.namespace === null) {
      if (name.prefix !== null) element = name.qualified; // an unresolved name: as written
      else {
        if (Option.getOrUndefined(Record.get(scope, "")) !== "") declare("", "");
        element = name.local;
      }
    } else if (name.namespace === Namespaces.xml) {
      element = `xml:${name.local}`;
    } else if (
      name.prefix !== null &&
      Option.getOrUndefined(Record.get(scope, name.prefix)) === name.namespace
    ) {
      element = name.qualified;
    } else if (
      name.prefix === null &&
      Option.getOrUndefined(Record.get(scope, "")) === name.namespace
    ) {
      element = name.local;
    } else {
      const existing = prefixFor(name.namespace);
      if (existing !== undefined) element = `${existing}:${name.local}`;
      else if (name.prefix === null && !Record.has(decls, "")) {
        declare("", name.namespace);
        element = name.local;
      } else {
        const p = fresh(name.prefix, name.namespace);
        declare(p, name.namespace);
        element = `${p}:${name.local}`;
      }
    }
    const colon = element.indexOf(":");
    elementPrefix = colon === -1 ? null : element.slice(0, colon);

    // Attributes: unprefixed ones are in no namespace; others need a prefix.
    const sorted = this.options.sortAttributes
      ? Arr.sort(attributes, byNamespaceThenLocal)
      : attributes;
    const out: Array<readonly [string, string]> = [];
    const seen = MutableHashSet.empty<string>();
    let duplicate: SerializationError | null = null;
    sorted.every((a) => {
      const n = a.name;
      let qualified: string;
      if (n.namespace === null) qualified = n.qualified;
      else if (n.namespace === Namespaces.xml) qualified = `xml:${n.local}`;
      else if (
        n.prefix !== null &&
        Option.getOrUndefined(Record.get(scope, n.prefix)) === n.namespace
      )
        qualified = n.qualified;
      else {
        const existing = prefixFor(n.namespace);
        if (existing !== undefined) qualified = `${existing}:${n.local}`;
        else {
          const p = fresh(n.prefix, n.namespace);
          declare(p, n.namespace);
          qualified = `${p}:${n.local}`;
        }
      }
      const key = n.namespace === null ? qualified : `{${n.namespace}}${n.local}`;
      if (MutableHashSet.has(seen, key)) {
        if (this.invalid === "fail")
          duplicate = new SerializationError({
            reason: `<${element}> has two ${qualified} attributes`,
          });
        return duplicate === null;
      }
      MutableHashSet.add(seen, key);
      out.push([qualified, a.value]);
      return true;
    });
    if (duplicate !== null) return duplicate;
    return { element, attributes: out, decls, scope };
  }

  // --- events ----------------------------------------------------------------

  write(ev: WriterEvent): string | SerializationError {
    return matchWriterEvent(ev, this.handlers);
  }

  /** What each event kind writes; built once per writer. */
  private readonly handlers = {
    StartElement: (ev: Extract<WriterEvent, { _tag: "StartElement" }>) => this.startElement(ev),
    EndElement: () => this.endElement(),
    Text: (ev: Extract<WriterEvent, { _tag: "Text" }>) => this.textNode(ev.data),
    CData: (ev: Extract<WriterEvent, { _tag: "CData" }>) => this.cdata(ev.data),
    Comment: (ev: Extract<WriterEvent, { _tag: "Comment" }>) => this.comment(ev.data),
    ProcessingInstruction: (ev: Extract<WriterEvent, { _tag: "ProcessingInstruction" }>) =>
      this.processingInstruction(ev.target, ev.data),
  };

  /** The attributes as they are, and their names as written (`namespaces: "asIs"`). */
  private attributesAsIs(
    element: string,
    attributes: ReadonlyArray<XmlAttribute>,
  ): string | SerializationError {
    const seen = MutableHashSet.empty<string>();
    return Arr.reduce(attributes, "", (out: string | SerializationError, a) => {
      if (!Predicate.isString(out)) return out;
      if (MutableHashSet.has(seen, a.name.qualified)) {
        return this.invalid === "fail"
          ? new SerializationError({
              reason: `<${element}> has two ${a.name.qualified} attributes`,
            })
          : out;
      }
      MutableHashSet.add(seen, a.name.qualified);
      const v = this.text(a.value, true);
      return Predicate.isString(v) ? `${out} ${a.name.qualified}="${v}"` : v;
    });
  }

  /** The declarations (default namespace first, then by prefix) and attributes `names` chose. */
  private attributesManaged(names: {
    readonly attributes: ReadonlyArray<readonly [string, string]>;
    readonly decls: Bindings;
  }): string | SerializationError {
    const xmlns = Arr.sort(Record.toEntries(names.decls), byKey)
      .map(([p, uri]) => ` ${p === "" ? "xmlns" : `xmlns:${p}`}="${escapeAttributeChars(uri)}"`)
      .join("");
    return Arr.reduce(names.attributes, xmlns, (out: string | SerializationError, [q, value]) => {
      if (!Predicate.isString(out)) return out;
      const v = this.text(value, true);
      return Predicate.isString(v) ? `${out} ${q}="${v}"` : v;
    });
  }

  private startElement(
    ev: Extract<WriterEvent, { _tag: "StartElement" }>,
  ): string | SerializationError {
    const out = this.beforeNode();
    let element: string;
    let scope: Bindings;
    let attrs: string | SerializationError;
    if (this.options.namespaces === "asIs") {
      element = ev.name.qualified;
      scope = this.scope;
      attrs = this.attributesAsIs(element, ev.attributes);
    } else {
      const names = this.names(ev);
      if (names instanceof SerializationError) return names;
      element = names.element;
      scope = names.scope;
      attrs = this.attributesManaged(names);
    }
    if (!Predicate.isString(attrs)) return attrs;
    const space = ev.attributes.find(
      (a) =>
        a.name.local === "space" &&
        (a.name.namespace === Namespaces.xml || a.name.prefix === "xml"),
    )?.value;
    const parent = this.stack.at(-1);
    const preserve =
      space === "preserve" ? true : space === "default" ? false : (parent?.preserve ?? false);
    this.stack.push({
      name: element,
      scope,
      inline: preserve || ev.inline === true,
      preserve,
      hasChildren: false,
    });
    this.pendingStart = ev.name;
    return out + `<${element}${attrs}`;
  }

  private endElement(): string | SerializationError {
    const frame = this.stack.pop();
    if (frame === undefined)
      return new SerializationError({ reason: "an end tag with no open element" });
    if (this.pendingStart !== null) {
      const name = this.pendingStart;
      this.pendingStart = null;
      const sc = this.options.selfClose ?? true;
      return (Predicate.isFunction(sc) ? sc(name) : sc) ? "/>" : `></${frame.name}>`;
    }
    const nl =
      this.indent !== null && frame.hasChildren && !frame.inline
        ? "\n" + this.indent.repeat(this.stack.length)
        : "";
    return `${nl}</${frame.name}>`;
  }

  private textNode(data: string): string | SerializationError {
    const parent = this.stack.at(-1);
    // Pretty-printing replaces whitespace-only text where it may add its own.
    if (
      this.indent !== null &&
      (parent === undefined || !parent.inline) &&
      /^[ \t\r\n]*$/.test(data)
    )
      return "";
    if (data === "") return "";
    if (parent !== undefined) parent.inline = true;
    const t = this.text(data, false);
    if (!Predicate.isString(t)) return t;
    return this.prolog() + this.flush() + t;
  }

  private cdata(text: string): string | SerializationError {
    const parent = this.stack.at(-1);
    if (parent !== undefined) parent.inline = true;
    const data = this.chars(text, "a CDATA section");
    if (!Predicate.isString(data)) return data;
    // `]]>` can't occur inside a section: end it after `]]` and start another.
    return (
      this.prolog() + this.flush() + `<![CDATA[${data.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`
    );
  }

  private comment(text: string): string | SerializationError {
    const data = this.unescapable(text, "a comment", /--|-$/, (s) => {
      // A space between every two dashes, and after a trailing one.
      const out = s.replace(/-(?=-)/g, "- ");
      return out.endsWith("-") ? out + " " : out;
    });
    if (!Predicate.isString(data)) return data;
    return this.beforeNode() + `<!--${data}-->`;
  }

  private processingInstruction(target: string, text: string): string | SerializationError {
    if (/^xml$/i.test(target) && this.invalid === "fail") {
      return new SerializationError({
        reason: `the processing instruction target "${target}" is reserved`,
      });
    }
    const data = this.unescapable(text, "a processing instruction", /\?>/, (s) =>
      s.replaceAll("?>", "? >"),
    );
    if (!Predicate.isString(data)) return data;
    return this.beforeNode() + `<?${target}${data === "" ? "" : " " + data}?>`;
  }

  /** Raw markup at the top level (a DOCTYPE), laid out like a node. */
  markup(s: string): string {
    return this.beforeNode() + s;
  }

  /** After the last event: everything must be closed. */
  end(): string | SerializationError {
    const open = this.stack.at(-1);
    if (open !== undefined) {
      return new SerializationError({ reason: `<${open.name}> was never closed` });
    }
    return this.prolog();
  }
}

// -----------------------------------------------------------------------------
// Streaming
// -----------------------------------------------------------------------------

const lift = (out: string | SerializationError) =>
  Predicate.isString(out) ? Effect.succeed(out) : Effect.fail(out);

/**
 * Write a stream of events as a stream of XML text.
 *
 * @since 0.3.0
 * @category streaming
 */
export const write =
  (options?: WriterOptions) =>
  <E, R>(
    input: Stream.Stream<WriterEvent, E, R>,
  ): Stream.Stream<string, E | SerializationError, R> =>
    Stream.suspend(() => {
      const writer = new XmlWriter(options);
      const body = input.pipe(Stream.mapEffect((ev) => lift(writer.write(ev))));
      const tail = Stream.fromEffect(Effect.suspend(() => lift(writer.end())));
      return Stream.concat(body, tail).pipe(Stream.filter(Str.isNonEmpty));
    });

/**
 * Encode text as UTF-8, or as UTF-16LE with a byte order mark.
 *
 * @since 0.3.0
 * @category streaming
 */
export const encode =
  (encoding: "utf-8" | "utf-16" = "utf-8") =>
  <E, R>(input: Stream.Stream<string, E, R>): Stream.Stream<Uint8Array, E, R> =>
    Stream.suspend(() => {
      if (encoding === "utf-8") {
        const encoder = new TextEncoder();
        return input.pipe(Stream.map((s) => encoder.encode(s)));
      }
      let first = true;
      return input.pipe(
        Stream.map((s) => {
          const bom = first ? 1 : 0;
          first = false;
          const out = new Uint8Array((s.length + bom) * 2);
          const view = new DataView(out.buffer);
          if (bom) view.setUint16(0, 0xfeff, true);
          Array.from({ length: s.length }, (_, i) =>
            view.setUint16((i + bom) * 2, s.charCodeAt(i), true),
          );
          return out;
        }),
      );
    });

/**
 * Write a stream of events as bytes in `options.encoding` (default UTF-8).
 *
 * @since 0.3.0
 * @category streaming
 */
export const writeBytes =
  (options?: WriterOptions) =>
  <E, R>(
    input: Stream.Stream<WriterEvent, E, R>,
  ): Stream.Stream<Uint8Array, E | SerializationError, R> =>
    input.pipe(write(options), encode(options?.encoding));

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------

/** The namespaces a tree uses with a prefix, keyed by prefix (the first URI seen wins). */
const usedPrefixes = (node: XmlNode | XmlDocument): Bindings => {
  const prefixed = (n: QName): ReadonlyArray<readonly [string, string]> =>
    n.prefix !== null &&
    n.namespace !== null &&
    n.namespace !== Namespaces.xml &&
    n.namespace !== Namespaces.xmlns
      ? [[n.prefix, n.namespace]]
      : [];
  const none: Bindings = {};
  return Iterable.reduce(events(node), none, (found, ev) =>
    !isStartEvent(ev)
      ? found
      : Arr.reduce(
          [...prefixed(ev.name), ...ev.attributes.flatMap((a) => prefixed(a.name))],
          found,
          (acc, [prefix, uri]) => (Record.has(acc, prefix) ? acc : Record.set(acc, prefix, uri)),
        ),
  );
};

const doctypeOf = (doc: XmlDocument): string => {
  const d = doc.doctype;
  if (d === null) return "";
  let out = `<!DOCTYPE ${d.name}`;
  if (d.publicId !== null) out += ` PUBLIC "${d.publicId}" "${d.systemId ?? ""}"`;
  else if (d.systemId !== null) out += ` SYSTEM "${d.systemId}"`;
  if (d.internalSubset !== null) out += ` [${d.internalSubset}]`;
  return out + ">";
};

/** The XML declaration a document was parsed with. */
const declarationOf = (doc: XmlDocument): string => {
  const d = doc.declaration;
  if (d === null) return "";
  let out = `<?xml version="${d.version}"`;
  if (d.encoding !== null) out += ` encoding="${d.encoding}"`;
  if (d.standalone !== null) out += ` standalone="${d.standalone ? "yes" : "no"}"`;
  return out + "?>";
};

/** @internal Serialize synchronously. */
export const serializeSync = (
  node: XmlNode | XmlDocument,
  options: WriterOptions = {},
): Result.Result<string, SerializationError> => {
  const isDoc = node instanceof XmlDocument;
  const manage = (options.namespaces ?? "manage") === "manage";
  const writer = new XmlWriter(
    // The prefixes the tree uses are declared on its root.
    manage ? { ...options, prefixes: { ...usedPrefixes(node), ...options.prefixes } } : options,
  );
  // A document keeps its own declaration and DOCTYPE, unless told otherwise.
  const out = isDoc && options.declaration === undefined ? declarationOf(node) : "";
  let doctype = isDoc ? doctypeOf(node) : "";
  if (out !== "") writer.markup("");
  const written = Iterable.reduce(events(node), out, (acc: string | SerializationError, ev) => {
    if (!Predicate.isString(acc)) return acc;
    let prefix = "";
    if (doctype !== "" && isStartEvent(ev)) {
      // The DOCTYPE goes right before the root element.
      prefix = writer.markup(doctype);
      doctype = "";
    }
    const s = writer.write(ev);
    return Predicate.isString(s) ? acc + prefix + s : s;
  });
  if (!Predicate.isString(written)) return Result.fail(written);
  const tail = writer.end();
  if (!Predicate.isString(tail)) return Result.fail(tail);
  return Result.succeed(written + tail);
};

/**
 * Serialize a node or a document, declaring the namespaces it uses on its root.
 *
 * @since 0.3.0
 * @category serialization
 */
export const serialize = (
  node: XmlNode | XmlDocument,
  options?: WriterOptions,
): Effect.Effect<string, SerializationError> =>
  Effect.suspend(() => Effect.fromResult(serializeSync(node, options)));
