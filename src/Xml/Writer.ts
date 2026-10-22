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
import { Data, Effect, Result, Stream } from "effect"
import { Namespaces, QName } from "../Name.ts"
import { XmlDocument, type XmlAttribute, type XmlNode } from "./Node.ts"

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

/** What the writer writes. Names are namespace-aware {@link QName}s. */
export type WriterEvent =
  | {
      readonly _tag: "StartElement"
      readonly name: QName
      readonly attributes: ReadonlyArray<XmlAttribute>
      /**
       * The element has text content, so pretty-printing must not add
       * whitespace inside it. (Set by {@link events}; when streaming, text in
       * an element turns indentation off from there on anyway.)
       */
      readonly inline?: boolean
    }
  | { readonly _tag: "EndElement" }
  | { readonly _tag: "Text"; readonly data: string }
  | { readonly _tag: "CData"; readonly data: string }
  | { readonly _tag: "Comment"; readonly data: string }
  | { readonly _tag: "ProcessingInstruction"; readonly target: string; readonly data: string }

const toQName = (name: string | QName): QName => (typeof name === "string" ? QName.fromRaw(name) : name)

/** A start tag. */
export const start = (
  name: string | QName,
  attributes: ReadonlyArray<XmlAttribute> = [],
  inline?: boolean
): WriterEvent => ({ _tag: "StartElement", name: toQName(name), attributes, ...(inline !== undefined ? { inline } : {}) })

/** An end tag (for the innermost open element). */
export const end: WriterEvent = { _tag: "EndElement" }

/** Character data. */
export const text = (data: string): WriterEvent => ({ _tag: "Text", data })

/** A CDATA section. */
export const cdata = (data: string): WriterEvent => ({ _tag: "CData", data })

/** A comment. */
export const comment = (data: string): WriterEvent => ({ _tag: "Comment", data })

/** A processing instruction. */
export const processingInstruction = (target: string, data = ""): WriterEvent => ({
  _tag: "ProcessingInstruction",
  target,
  data,
})

/** The events of a node (iteratively, so any depth is fine). */
export function* events(node: XmlNode | XmlDocument): Generator<WriterEvent> {
  const stack: Array<XmlNode | "end"> =
    node instanceof XmlDocument ? [...node.children].reverse() : [node]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (item === "end") {
      yield end
      continue
    }
    switch (item._tag) {
      case "XmlElement": {
        // Whitespace-only text is layout, which pretty-printing replaces.
        const inline = item.children.some((c) => c._tag === "XmlCData" || (c._tag === "XmlText" && /[^ \t\r\n]/.test(c.data)))
        yield { _tag: "StartElement", name: item.name, attributes: item.attributes, inline }
        stack.push("end")
        for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]!)
        break
      }
      case "XmlText":
        yield { _tag: "Text", data: item.data }
        break
      case "XmlCData":
        yield { _tag: "CData", data: item.data }
        break
      case "XmlComment":
        yield { _tag: "Comment", data: item.data }
        break
      case "XmlProcessingInstruction":
        yield { _tag: "ProcessingInstruction", target: item.target, data: item.data }
        break
    }
  }
}

// -----------------------------------------------------------------------------
// Options and errors
// -----------------------------------------------------------------------------

/** What can't be written as asked. */
export class SerializationError extends Data.TaggedError("SerializationError")<{
  readonly reason: string
}> {
  override get message(): string {
    return `Cannot serialize: ${this.reason}`
  }
}

export interface WriterOptions {
  /** Emit an XML declaration (default `false`), optionally with `standalone`. */
  readonly declaration?: boolean | { readonly standalone?: boolean }
  /** The encoding named in the declaration and used by {@link writeBytes} (default `"utf-8"`). */
  readonly encoding?: "utf-8" | "utf-16"
  /**
   * Pretty-print with this indentation (spaces, or the string itself).
   * Whitespace is never added inside elements with text content, or under
   * `xml:space="preserve"`; whitespace-only text is dropped elsewhere.
   */
  readonly indent?: number | string
  /** Write empty elements as `<a/>` (default `true`), or `<a></a>`; or decide per element. */
  readonly selfClose?: boolean | ((name: QName) => boolean)
  /** What to do with content XML can't represent (see the module docs). Default `"fail"`. */
  readonly invalid?: "fail" | "strip" | "replace"
  /**
   * Encode a character XML 1.0 forbids, before `invalid` applies: return its
   * replacement (written as text, so escaped as usual), or `undefined` to
   * leave it to `invalid`. OOXML: `(cp) => "_x" + cp.toString(16).toUpperCase().padStart(4, "0") + "_"`.
   */
  readonly escape?: (codePoint: number) => string | undefined
  /** Preferred prefixes (prefix → namespace URI), declared on the root element. */
  readonly prefixes?: Readonly<Record<string, string>>
  /** Sort attributes by namespace URI and local name (default: as given). */
  readonly sortAttributes?: boolean
  /**
   * `"manage"` (default) declares namespaces as described above. `"asIs"`
   * writes names as their prefixes say and adds no declarations, for trees
   * that already carry their `xmlns` attributes.
   */
  readonly namespaces?: "manage" | "asIs"
}

// -----------------------------------------------------------------------------
// Characters
// -----------------------------------------------------------------------------

// Characters XML 1.0 forbids (lone surrogates included, thanks to the `u` flag).
const INVALID = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/u
const INVALID_ALL = /[^\t\n\r\x20-퟿-�\u{10000}-\u{10FFFF}]/gu

const escapeTextChars = (s: string): string =>
  s.replace(/[&<>\r]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#xD;"))

const escapeAttributeChars = (s: string): string =>
  s.replace(/[&<>"\t\n\r]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : c === "\t" ? "&#x9;" : c === "\n" ? "&#xA;" : "&#xD;"
  )

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// -----------------------------------------------------------------------------
// The writer
// -----------------------------------------------------------------------------

interface Frame {
  readonly name: string
  /** Prefix → URI bindings in scope inside this element (`""`: the default namespace). */
  readonly scope: ReadonlyMap<string, string>
  /** No whitespace may be added inside (text content, or `xml:space="preserve"`). */
  inline: boolean
  readonly preserve: boolean
  hasChildren: boolean
}

const INITIAL_SCOPE: ReadonlyMap<string, string> = new Map([
  ["xml", Namespaces.xml],
  ["", ""],
])

/** @internal The writer's state machine: one event in, some text out. */
export class XmlWriter {
  private readonly stack: Array<Frame> = []
  /** A start tag waiting for `>` or `/>`, until we know whether the element is empty. */
  private pendingStart: QName | null = null
  private started = false
  private topLevelNodes = 0
  private readonly indent: string | null
  private readonly invalid: "fail" | "strip" | "replace"

  constructor(private readonly options: WriterOptions = {}) {
    const i = options.indent
    this.indent = i === undefined ? null : typeof i === "number" ? " ".repeat(i) : i
    this.invalid = options.invalid ?? "fail"
  }

  private get scope(): ReadonlyMap<string, string> {
    return this.stack[this.stack.length - 1]?.scope ?? INITIAL_SCOPE
  }

  // --- content ---------------------------------------------------------------

  /** Encode, strip or replace characters XML forbids; `null` when the policy is to fail. */
  private chars(s: string, what: string): string | SerializationError {
    if (!INVALID.test(s)) return s
    let failed: string | null = null
    const out = s.replace(INVALID_ALL, (c) => {
      const cp = c.codePointAt(0)!
      const escaped = this.options.escape?.(cp)
      if (escaped !== undefined) return escaped
      if (this.invalid === "strip") return ""
      if (this.invalid === "replace") return "�"
      failed ??= `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`
      return c
    })
    return failed === null ? out : new SerializationError({ reason: `${what} contains ${failed}, which XML 1.0 does not allow` })
  }

  private text(data: string, attribute: boolean): string | SerializationError {
    const s = this.chars(data, attribute ? "an attribute value" : "text")
    if (typeof s !== "string") return s
    return attribute ? escapeAttributeChars(s) : escapeTextChars(s)
  }

  /** Content that can't be escaped (comments, PIs): fail, or patch it up. */
  private unescapable(s: string, what: string, bad: RegExp, fix: (s: string) => string): string | SerializationError {
    const chars = this.chars(s, what)
    if (typeof chars !== "string") return chars
    if (!bad.test(chars)) return chars
    if (this.invalid === "fail") return new SerializationError({ reason: `${what} contains ${JSON.stringify(chars.match(bad)![0])}` })
    return fix(chars)
  }

  // --- layout ----------------------------------------------------------------

  /** Close a pending start tag, as `>` (the element has content). */
  private flush(): string {
    if (this.pendingStart === null) return ""
    this.pendingStart = null
    return ">"
  }

  /** Whitespace before a child node, when pretty-printing. */
  private newline(): string {
    if (this.indent === null) return ""
    const parent = this.stack[this.stack.length - 1]
    if (parent === undefined) return this.started ? "\n" : ""
    if (parent.inline) return ""
    return "\n" + this.indent.repeat(this.stack.length)
  }

  private beforeNode(): string {
    let out = this.prolog()
    out += this.flush()
    out += this.newline()
    const parent = this.stack[this.stack.length - 1]
    if (parent !== undefined) parent.hasChildren = true
    else this.topLevelNodes++
    this.started = true
    return out
  }

  /** The XML declaration, before anything else. */
  private prolog(): string {
    if (this.started) return ""
    const d = this.options.declaration
    if (d === undefined || d === false) return ""
    this.started = true
    const encoding = this.options.encoding === "utf-16" ? "UTF-16" : "UTF-8"
    const standalone = typeof d === "object" && d.standalone !== undefined ? ` standalone="${d.standalone ? "yes" : "no"}"` : ""
    return `<?xml version="1.0" encoding="${encoding}"${standalone}?>`
  }

  // --- names -----------------------------------------------------------------

  /** Pick prefixes for an element and its attributes, adding the declarations needed. */
  private names(ev: Extract<WriterEvent, { _tag: "StartElement" }>):
    | { element: string; attributes: Array<readonly [string, string]>; decls: Map<string, string>; scope: ReadonlyMap<string, string> }
    | SerializationError {
    const scope = new Map(this.scope)
    const decls = new Map<string, string>()
    const declare = (prefix: string, uri: string) => {
      if (scope.get(prefix) === uri) return
      decls.set(prefix, uri)
      scope.set(prefix, uri)
    }
    const prefixFor = (uri: string): string | undefined => {
      for (const [p, u] of scope) if (u === uri && p !== "") return p
      return undefined
    }
    /** The prefix the element's own name uses: rebinding it would change the element's namespace. */
    let elementPrefix: string | null = null
    /** A prefix to declare for `uri`: the one asked for, a preferred one, or a new `nsN`. */
    const fresh = (preferred: string | null, uri: string): string => {
      const candidates = [preferred, ...Object.entries(this.options.prefixes ?? {}).filter(([, u]) => u === uri).map(([p]) => p)]
      for (const p of candidates) {
        if (p === null || p === "" || p === "xml" || p === "xmlns" || p === elementPrefix) continue
        // A prefix this element already declared for something else is taken.
        if (decls.has(p) && decls.get(p) !== uri) continue
        return p
      }
      for (let i = 0; ; i++) if (!scope.has(`ns${i}`)) return `ns${i}`
    }

    // Declarations the input asks for (xmlns attributes), and the preferred
    // prefixes on the root element.
    const attributes: Array<XmlAttribute> = []
    for (const a of ev.attributes) {
      if (a.name.namespace === Namespaces.xmlns || a.name.qualified === "xmlns" || a.name.prefix === "xmlns") {
        declare(a.name.qualified === "xmlns" ? "" : a.name.local, a.value)
      } else attributes.push(a)
    }
    if (this.stack.length === 0) {
      for (const [p, uri] of Object.entries(this.options.prefixes ?? {}).sort(([a], [b]) => compare(a, b))) declare(p, uri)
    }

    // The element's own name.
    const name = ev.name
    let element: string
    if (name.namespace === null) {
      if (name.prefix !== null) element = name.qualified // an unresolved name: as written
      else {
        if (scope.get("") !== "") declare("", "")
        element = name.local
      }
    } else if (name.namespace === Namespaces.xml) {
      element = `xml:${name.local}`
    } else if (name.prefix !== null && scope.get(name.prefix) === name.namespace) {
      element = name.qualified
    } else if (name.prefix === null && scope.get("") === name.namespace) {
      element = name.local
    } else {
      const existing = prefixFor(name.namespace)
      if (existing !== undefined) element = `${existing}:${name.local}`
      else if (name.prefix === null && !decls.has("")) {
        declare("", name.namespace)
        element = name.local
      } else {
        const p = fresh(name.prefix, name.namespace)
        declare(p, name.namespace)
        element = `${p}:${name.local}`
      }
    }
    const colon = element.indexOf(":")
    elementPrefix = colon === -1 ? null : element.slice(0, colon)

    // Attributes: unprefixed ones are in no namespace; others need a prefix.
    const sorted = this.options.sortAttributes
      ? [...attributes].sort((a, b) => compare(a.name.namespace ?? "", b.name.namespace ?? "") || compare(a.name.local, b.name.local))
      : attributes
    const out: Array<readonly [string, string]> = []
    const seen = new Set<string>()
    for (const a of sorted) {
      const n = a.name
      let qualified: string
      if (n.namespace === null) qualified = n.qualified
      else if (n.namespace === Namespaces.xml) qualified = `xml:${n.local}`
      else if (n.prefix !== null && scope.get(n.prefix) === n.namespace) qualified = n.qualified
      else {
        const existing = prefixFor(n.namespace)
        if (existing !== undefined) qualified = `${existing}:${n.local}`
        else {
          const p = fresh(n.prefix, n.namespace)
          declare(p, n.namespace)
          qualified = `${p}:${n.local}`
        }
      }
      const key = n.namespace === null ? qualified : `{${n.namespace}}${n.local}`
      if (seen.has(key)) {
        if (this.invalid === "fail") return new SerializationError({ reason: `<${element}> has two ${qualified} attributes` })
        continue
      }
      seen.add(key)
      out.push([qualified, a.value])
    }
    return { element, attributes: out, decls, scope }
  }

  // --- events ----------------------------------------------------------------

  write(ev: WriterEvent): string | SerializationError {
    switch (ev._tag) {
      case "StartElement": {
        let out = this.beforeNode()
        let element: string
        let scope: ReadonlyMap<string, string>
        let attrs = ""
        if (this.options.namespaces === "asIs") {
          element = ev.name.qualified
          scope = this.scope
          const seen = new Set<string>()
          for (const a of ev.attributes) {
            if (seen.has(a.name.qualified)) {
              if (this.invalid === "fail") return new SerializationError({ reason: `<${element}> has two ${a.name.qualified} attributes` })
              continue
            }
            seen.add(a.name.qualified)
            const v = this.text(a.value, true)
            if (typeof v !== "string") return v
            attrs += ` ${a.name.qualified}="${v}"`
          }
        } else {
          const names = this.names(ev)
          if (names instanceof SerializationError) return names
          element = names.element
          scope = names.scope
          // Declarations first, the default namespace before prefixes, then by prefix.
          for (const [p, uri] of [...names.decls].sort(([a], [b]) => compare(a, b))) {
            attrs += ` ${p === "" ? "xmlns" : `xmlns:${p}`}="${escapeAttributeChars(uri)}"`
          }
          for (const [qualified, value] of names.attributes) {
            const v = this.text(value, true)
            if (typeof v !== "string") return v
            attrs += ` ${qualified}="${v}"`
          }
        }
        const space = ev.attributes.find((a) => a.name.local === "space" && (a.name.namespace === Namespaces.xml || a.name.prefix === "xml"))?.value
        const parent = this.stack[this.stack.length - 1]
        const preserve = space === "preserve" ? true : space === "default" ? false : (parent?.preserve ?? false)
        this.stack.push({ name: element, scope, inline: preserve || ev.inline === true, preserve, hasChildren: false })
        out += `<${element}${attrs}`
        this.pendingStart = ev.name
        return out
      }
      case "EndElement": {
        const frame = this.stack.pop()
        if (frame === undefined) return new SerializationError({ reason: "an end tag with no open element" })
        if (this.pendingStart !== null) {
          const name = this.pendingStart
          this.pendingStart = null
          const sc = this.options.selfClose ?? true
          return (typeof sc === "function" ? sc(name) : sc) ? "/>" : `></${frame.name}>`
        }
        const nl = this.indent !== null && frame.hasChildren && !frame.inline ? "\n" + this.indent.repeat(this.stack.length) : ""
        return `${nl}</${frame.name}>`
      }
      case "Text": {
        const parent = this.stack[this.stack.length - 1]
        // Pretty-printing replaces whitespace-only text where it may add its own.
        if (this.indent !== null && (parent === undefined || !parent.inline) && /^[ \t\r\n]*$/.test(ev.data)) return ""
        if (ev.data === "") return ""
        if (parent !== undefined) parent.inline = true
        const t = this.text(ev.data, false)
        if (typeof t !== "string") return t
        return this.prolog() + this.flush() + t
      }
      case "CData": {
        const parent = this.stack[this.stack.length - 1]
        if (parent !== undefined) parent.inline = true
        const data = this.chars(ev.data, "a CDATA section")
        if (typeof data !== "string") return data
        // `]]>` can't occur inside a section: end it after `]]` and start another.
        return this.prolog() + this.flush() + `<![CDATA[${data.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`
      }
      case "Comment": {
        const data = this.unescapable(ev.data, "a comment", /--|-$/, (s) => {
          let out = s
          while (out.includes("--")) out = out.replaceAll("--", "- -")
          return out.endsWith("-") ? out + " " : out
        })
        if (typeof data !== "string") return data
        return this.beforeNode() + `<!--${data}-->`
      }
      case "ProcessingInstruction": {
        if (/^xml$/i.test(ev.target) && this.invalid === "fail") {
          return new SerializationError({ reason: `the processing instruction target "${ev.target}" is reserved` })
        }
        const data = this.unescapable(ev.data, "a processing instruction", /\?>/, (s) => s.replaceAll("?>", "? >"))
        if (typeof data !== "string") return data
        return this.beforeNode() + `<?${ev.target}${data === "" ? "" : " " + data}?>`
      }
    }
  }

  /** Raw markup at the top level (a DOCTYPE), laid out like a node. */
  markup(s: string): string {
    return this.beforeNode() + s
  }

  /** After the last event: everything must be closed. */
  end(): string | SerializationError {
    if (this.stack.length > 0) {
      return new SerializationError({ reason: `<${this.stack[this.stack.length - 1]!.name}> was never closed` })
    }
    return this.prolog()
  }
}

// -----------------------------------------------------------------------------
// Streaming
// -----------------------------------------------------------------------------

const lift = (out: string | SerializationError) => (typeof out === "string" ? Effect.succeed(out) : Effect.fail(out))

/** Write a stream of events as a stream of XML text. */
export const write =
  (options?: WriterOptions) =>
  <E, R>(input: Stream.Stream<WriterEvent, E, R>): Stream.Stream<string, E | SerializationError, R> =>
    Stream.suspend(() => {
      const writer = new XmlWriter(options)
      const body = input.pipe(Stream.mapEffect((ev) => lift(writer.write(ev))))
      const tail = Stream.fromEffect(Effect.suspend(() => lift(writer.end())))
      return Stream.concat(body, tail).pipe(Stream.filter((s) => s.length > 0))
    })

/** Encode text as UTF-8, or as UTF-16LE with a byte order mark. */
export const encode =
  (encoding: "utf-8" | "utf-16" = "utf-8") =>
  <E, R>(input: Stream.Stream<string, E, R>): Stream.Stream<Uint8Array, E, R> =>
    Stream.suspend(() => {
      if (encoding === "utf-8") {
        const encoder = new TextEncoder()
        return input.pipe(Stream.map((s) => encoder.encode(s)))
      }
      let first = true
      return input.pipe(
        Stream.map((s) => {
          const bom = first ? 1 : 0
          first = false
          const out = new Uint8Array((s.length + bom) * 2)
          const view = new DataView(out.buffer)
          if (bom) view.setUint16(0, 0xfeff, true)
          for (let i = 0; i < s.length; i++) view.setUint16((i + bom) * 2, s.charCodeAt(i), true)
          return out
        })
      )
    })

/** Write a stream of events as bytes in `options.encoding` (default UTF-8). */
export const writeBytes =
  (options?: WriterOptions) =>
  <E, R>(input: Stream.Stream<WriterEvent, E, R>): Stream.Stream<Uint8Array, E | SerializationError, R> =>
    input.pipe(write(options), encode(options?.encoding))

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------

/** The namespaces a tree uses with a prefix, keyed by prefix (the first URI seen wins). */
const usedPrefixes = (node: XmlNode | XmlDocument): Record<string, string> => {
  const found: Record<string, string> = {}
  const note = (n: QName) => {
    if (n.prefix !== null && n.namespace !== null && n.namespace !== Namespaces.xml && n.namespace !== Namespaces.xmlns) {
      found[n.prefix] ??= n.namespace
    }
  }
  for (const ev of events(node)) {
    if (ev._tag !== "StartElement") continue
    note(ev.name)
    for (const a of ev.attributes) note(a.name)
  }
  return found
}

const doctypeOf = (doc: XmlDocument): string => {
  const d = doc.doctype
  if (d === null) return ""
  let out = `<!DOCTYPE ${d.name}`
  if (d.publicId !== null) out += ` PUBLIC "${d.publicId}" "${d.systemId ?? ""}"`
  else if (d.systemId !== null) out += ` SYSTEM "${d.systemId}"`
  if (d.internalSubset !== null) out += ` [${d.internalSubset}]`
  return out + ">"
}

/** The XML declaration a document was parsed with. */
const declarationOf = (doc: XmlDocument): string => {
  const d = doc.declaration
  if (d === null) return ""
  let out = `<?xml version="${d.version}"`
  if (d.encoding !== null) out += ` encoding="${d.encoding}"`
  if (d.standalone !== null) out += ` standalone="${d.standalone ? "yes" : "no"}"`
  return out + "?>"
}

/** @internal Serialize synchronously. */
export const serializeSync = (node: XmlNode | XmlDocument, options: WriterOptions = {}): Result.Result<string, SerializationError> => {
  const isDoc = node instanceof XmlDocument
  const manage = (options.namespaces ?? "manage") === "manage"
  const writer = new XmlWriter(
    // The prefixes the tree uses are declared on its root.
    manage ? { ...options, prefixes: { ...usedPrefixes(node), ...options.prefixes } } : options
  )
  // A document keeps its own declaration and DOCTYPE, unless told otherwise.
  let out = isDoc && options.declaration === undefined ? declarationOf(node) : ""
  let doctype = isDoc ? doctypeOf(node) : ""
  if (out !== "") writer.markup("")
  for (const ev of events(node)) {
    if (doctype !== "" && ev._tag === "StartElement") {
      // The DOCTYPE goes right before the root element.
      out += writer.markup(doctype)
      doctype = ""
    }
    const s = writer.write(ev)
    if (typeof s !== "string") return Result.fail(s)
    out += s
  }
  const tail = writer.end()
  if (typeof tail !== "string") return Result.fail(tail)
  return Result.succeed(out + tail)
}

/** Serialize a node or a document, declaring the namespaces it uses on its root. */
export const serialize = (node: XmlNode | XmlDocument, options?: WriterOptions): Effect.Effect<string, SerializationError> =>
  Effect.suspend(() => Effect.fromResult(serializeSync(node, options)))
