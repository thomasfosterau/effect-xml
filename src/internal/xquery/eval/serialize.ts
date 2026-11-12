/**
 * Serialization (XSLT and XQuery Serialization 3.1), as `fn:serialize`
 * uses it: the parameters, from an options map or an
 * `output:serialization-parameters` element, and the output methods.
 *
 * Supported methods: `xml` (the default) and `xhtml` (through `Xml.Writer`,
 * with `indent`, `omit-xml-declaration`, `standalone`, `version` and
 * `use-character-maps`), `html` (the same
 * writer, with an HTML5 `<!DOCTYPE html>` before an `html` root), `text`,
 * `json` (with `allow-duplicate-names`, `indent` and
 * `json-node-output-method`) and `adaptive`. `item-separator` applies to
 * all of them. The other parameters are checked (their types, and the
 * element form's structure) and otherwise have no effect: the result is a
 * string, so `encoding` only decides which characters a JSON string
 * escapes, and `byte-order-mark`, `normalization-form`, `doctype-*`,
 * `media-type`, `escape-uri-attributes`, `include-content-type`,
 * `undeclare-prefixes`, `cdata-section-elements` and `suppress-indentation`
 * are accepted and ignored.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { isValidNCName, QName } from "../../../Name.ts";
import { XmlDocument, type XmlNode } from "../../../Xml/Node.ts";
import { serializeSync } from "../../../Xml/Writer.ts";
import { text as textNode } from "../../nodes.ts";
import { AtomicValue, atomicString } from "../atomic.ts";
import {
  ArrayItem,
  atomize,
  FunctionItem,
  isAtomic,
  isNode,
  MapItem,
  type Item,
  type Sequence,
} from "../item.ts";
import type { XdmNode } from "../node.ts";
import { AtomicTypes, derivesFrom, isNumericType, type AtomicType } from "../types.ts";
import { castAtomic } from "./cast.ts";
import { raise, unwrap } from "./raise.ts";
import { maybe } from "../../optional.ts";

/** The serialization namespace, of the parameter elements. */
const OUTPUT_NAMESPACE = "http://www.w3.org/2010/xslt-xquery-serialization";

/** The serialization parameters, as `fn:serialize` reads them. */
export interface Params {
  readonly method: string;
  readonly indent: boolean;
  readonly omitXmlDeclaration: boolean;
  /** `undefined` for `omit`. */
  readonly standalone: boolean | undefined;
  readonly itemSeparator: string | undefined;
  readonly encoding: string;
  readonly version: string;
  readonly allowDuplicateNames: boolean;
  readonly jsonNodeOutputMethod: string;
  /** Characters and the strings that replace them. */
  readonly characterMaps: HashMap.HashMap<string, string>;
}

/** `fn:serialize`'s defaults: the XML output method, with no XML declaration. */
export const defaults: Params = {
  method: "xml",
  indent: false,
  omitXmlDeclaration: true,
  standalone: undefined,
  itemSeparator: undefined,
  encoding: "utf-8",
  version: "1.0",
  allowDuplicateNames: false,
  jsonNodeOutputMethod: "xml",
  characterMaps: HashMap.empty(),
};

/** A parameter's type, as the options map gives it. */
type Kind = "boolean" | "standalone" | "string" | "decimal" | "qnames" | "map";

const KINDS = /*#__PURE__*/ HashMap.make<ReadonlyArray<readonly [string, Kind]>>(
  ["allow-duplicate-names", "boolean"],
  ["byte-order-mark", "boolean"],
  ["cdata-section-elements", "qnames"],
  ["doctype-public", "string"],
  ["doctype-system", "string"],
  ["encoding", "string"],
  ["escape-uri-attributes", "boolean"],
  ["html-version", "decimal"],
  ["include-content-type", "boolean"],
  ["indent", "boolean"],
  ["item-separator", "string"],
  ["json-node-output-method", "string"],
  ["media-type", "string"],
  ["method", "string"],
  ["normalization-form", "string"],
  ["omit-xml-declaration", "boolean"],
  ["standalone", "standalone"],
  ["suppress-indentation", "qnames"],
  ["undeclare-prefixes", "boolean"],
  ["use-character-maps", "map"],
  ["version", "string"],
);

const METHODS = /*#__PURE__*/ HashSet.make("xml", "xhtml", "html", "text", "json", "adaptive");

/** A parameter's value, read from either form. */
type Value =
  | { readonly _tag: "boolean"; readonly value: boolean | undefined }
  | { readonly _tag: "string"; readonly value: string }
  | { readonly _tag: "qnames"; readonly value: ReadonlyArray<string> }
  | { readonly _tag: "map"; readonly value: HashMap.HashMap<string, string> };

const clark = (q: QName): string => `{${q.namespace ?? ""}}${q.local}`;

const boolOf = (v: Value): boolean | undefined =>
  Match.valueTags(v, {
    boolean: (b) => b.value,
    string: () => undefined,
    qnames: () => undefined,
    map: () => undefined,
  });

const stringOf = (v: Value): string | undefined =>
  Match.valueTags(v, {
    boolean: () => undefined,
    string: (b) => b.value,
    qnames: () => undefined,
    map: () => undefined,
  });

const mapOf = (v: Value): HashMap.HashMap<string, string> | undefined =>
  Match.valueTags(v, {
    boolean: () => undefined,
    string: () => undefined,
    qnames: () => undefined,
    map: (m) => m.value,
  });

/** How each parameter that has an effect sets its value. */
const SETTERS = /*#__PURE__*/ HashMap.make<
  ReadonlyArray<readonly [string, (params: Params, v: Value) => Params]>
>(
  ["method", (p, v) => ({ ...p, method: stringOf(v) ?? p.method })],
  ["indent", (p, v) => ({ ...p, indent: boolOf(v) === true })],
  ["omit-xml-declaration", (p, v) => ({ ...p, omitXmlDeclaration: boolOf(v) === true })],
  ["standalone", (p, v) => ({ ...p, standalone: boolOf(v) })],
  ["item-separator", (p, v) => ({ ...p, itemSeparator: stringOf(v) })],
  ["encoding", (p, v) => ({ ...p, encoding: (stringOf(v) ?? p.encoding).toLowerCase() })],
  ["version", (p, v) => ({ ...p, version: stringOf(v) ?? p.version })],
  ["allow-duplicate-names", (p, v) => ({ ...p, allowDuplicateNames: boolOf(v) === true })],
  [
    "json-node-output-method",
    (p, v) => ({ ...p, jsonNodeOutputMethod: stringOf(v) ?? p.jsonNodeOutputMethod }),
  ],
  ["use-character-maps", (p, v) => ({ ...p, characterMaps: mapOf(v) ?? p.characterMaps })],
);

/** Parameters with one parameter's value set; the parameters without an effect leave them as they are. */
const withValue = (params: Params, name: string, v: Value): Params =>
  Option.match(HashMap.get(SETTERS, name), {
    onNone: () => params,
    onSome: (set) => set(params, v),
  });

/** The method, checked: one this serializer has (`err:SEPM0016` otherwise). */
const checked = (params: Params, offset: number): Params =>
  HashSet.has(METHODS, params.method)
    ? params
    : raise("SEPM0016", `the output method "${params.method}" is not supported`, offset);

// -----------------------------------------------------------------------------
// The options map
// -----------------------------------------------------------------------------

const typeError = (name: string, offset: number): never =>
  raise("XPTY0004", `the serialization parameter ${name} has the wrong type`, offset);

/** An options-map value converted to `target` as the function conversion rules would. */
const converted = (
  values: ReadonlyArray<AtomicValue>,
  target: AtomicType,
  name: string,
  offset: number,
): ReadonlyArray<AtomicValue> =>
  values.map((a) => {
    if (a.type === AtomicTypes.untypedAtomic) return castAtomic(a, target, undefined, offset);
    if (derivesFrom(a.type, target)) return a;
    if (target === AtomicTypes.decimal && isNumericType(a.type))
      return castAtomic(a, target, undefined, offset);
    return typeError(name, offset);
  });

/** One atomic value of a map entry, or none when `optional` allows the empty sequence. */
const single = (
  values: ReadonlyArray<AtomicValue>,
  name: string,
  optional: boolean,
  offset: number,
): AtomicValue | undefined => {
  const [first, second] = values;
  if (second !== undefined || (first === undefined && !optional)) return typeError(name, offset);
  return first;
};

/** `use-character-maps`: a map from single characters to strings. */
const characterMapOf = (value: Sequence, offset: number): HashMap.HashMap<string, string> => {
  const [m, extra] = value;
  if (!(m instanceof MapItem) || extra !== undefined)
    return typeError("use-character-maps", offset);
  return HashMap.fromIterable(
    m.toEntries().map(([key, v]): readonly [string, string] => {
      const [s, more] = v;
      if (!derivesFrom(key.type, AtomicTypes.string))
        return typeError("use-character-maps", offset);
      if (
        !(s instanceof AtomicValue) ||
        more !== undefined ||
        !derivesFrom(s.type, AtomicTypes.string)
      )
        return typeError("use-character-maps", offset);
      const character = String(key.value);
      if (Arr.fromIterable(character).length !== 1)
        return raise("SEPM0016", `"${character}" is not a single character`, offset);
      return [character, String(s.value)];
    }),
  );
};

const mapValue = (name: string, kind: Kind, value: Sequence, offset: number): Value => {
  if (kind === "map") return { _tag: "map", value: characterMapOf(value, offset) };
  const atoms = unwrap(atomize(value), offset);
  if (kind === "qnames")
    return {
      _tag: "qnames",
      value: converted(atoms, AtomicTypes.QName, name, offset).map((a) =>
        a.value instanceof QName ? clark(a.value) : typeError(name, offset),
      ),
    };
  if (kind === "boolean" || kind === "standalone") {
    const a = single(
      converted(atoms, AtomicTypes.boolean, name, offset),
      name,
      kind === "standalone",
      offset,
    );
    return { _tag: "boolean", value: a === undefined ? undefined : a.value === true };
  }
  const target = kind === "decimal" ? AtomicTypes.decimal : AtomicTypes.string;
  const a = single(converted(atoms, target, name, offset), name, false, offset);
  return { _tag: "string", value: a === undefined ? "" : atomicString(a) };
};

/** The parameters an options map gives: entries in no namespace, by name; others are ignored. */
export const paramsFromMap = (map: MapItem, offset: number): Params =>
  checked(
    Arr.reduce(map.toEntries(), defaults, (params, [key, value]) => {
      // QName keys are vendor parameters (in a namespace), never the standard ones.
      const name = derivesFrom(key.type, AtomicTypes.string) ? String(key.value) : undefined;
      if (name === undefined) return params;
      return Option.match(HashMap.get(KINDS, name), {
        onNone: () => params,
        onSome: (kind) => withValue(params, name, mapValue(name, kind, value, offset)),
      });
    }),
    offset,
  );

// -----------------------------------------------------------------------------
// The parameters element
// -----------------------------------------------------------------------------

const structureError = (what: string, offset: number): never =>
  raise("SEPM0017", `invalid serialization parameters: ${what}`, offset);

const qnameOf = (node: XdmNode): QName | undefined => Option.getOrUndefined(node.name);

/** The attributes of a node other than namespace declarations. */
const attributesOf = (node: XdmNode): ReadonlyArray<XdmNode> => node.attributes;

const BOOLEANS = /*#__PURE__*/ HashMap.make(
  ["yes", true],
  ["true", true],
  ["1", true],
  ["no", false],
  ["false", false],
  ["0", false],
);

/** A lexical QName in an element's scope, as a Clark name. */
const elementQName = (lexical: string, element: XdmNode, offset: number): string => {
  const braced = /^Q\{([^{}]*)\}(.+)$/.exec(lexical);
  if (braced !== null) return `{${braced[1] ?? ""}}${braced[2] ?? ""}`;
  const colon = lexical.indexOf(":");
  const local = lexical.slice(colon + 1);
  if (!isValidNCName(local)) return structureError(`"${lexical}" is not a QName`, offset);
  if (colon < 0) return `{}${local}`;
  const prefix = lexical.slice(0, colon);
  const uri = element.namespaces.find((ns) =>
    Option.match(ns.name, { onNone: () => false, onSome: (q) => q.local === prefix }),
  )?.stringValue;
  return uri === undefined
    ? structureError(`the prefix "${prefix}" is not bound`, offset)
    : `{${uri}}${local}`;
};

/** A parameter element's `value`, as the parameter's type reads it. */
const elementValue = (kind: Kind, raw: string, element: XdmNode, offset: number): Value => {
  const v = raw.trim();
  if (kind === "boolean" || kind === "standalone") {
    if (kind === "standalone" && v === "omit") return { _tag: "boolean", value: undefined };
    return Option.match(HashMap.get(BOOLEANS, v), {
      onNone: () => structureError(`"${raw}" is not yes or no`, offset),
      onSome: (b) => ({ _tag: "boolean", value: b }),
    });
  }
  if (kind === "qnames")
    return {
      _tag: "qnames",
      value: v
        .split(/\s+/)
        .filter((s) => s !== "")
        .map((s) => elementQName(s, element, offset)),
    };
  return { _tag: "string", value: kind === "decimal" ? v : raw };
};

/** `use-character-maps` as elements: `output:character-map` children with `character` and `map-string`. */
const characterMapElements = (element: XdmNode, offset: number): Value => {
  if (!Arr.isReadonlyArrayEmpty(attributesOf(element)))
    return structureError("use-character-maps has attributes", offset);
  const entries = element.children
    .filter((c) => c.kind === "element")
    .map((c): readonly [string, string] => {
      const q = qnameOf(c);
      const attrs = attributesOf(c);
      const attr = (local: string) =>
        attrs.find((a) => qnameOf(a)?.local === local && qnameOf(a)?.namespace === null)
          ?.stringValue;
      const character = attr("character");
      const mapped = attr("map-string");
      if (
        q?.namespace !== OUTPUT_NAMESPACE ||
        q.local !== "character-map" ||
        attrs.length !== 2 ||
        character === undefined ||
        mapped === undefined ||
        Arr.fromIterable(character).length !== 1
      )
        return structureError("an invalid character-map", offset);
      return [character, mapped];
    });
  const characters = entries.map(([c]) => c);
  if (characters.some((c, i) => characters.indexOf(c) !== i))
    return raise("SEPM0018", "a character is mapped twice", offset);
  return { _tag: "map", value: HashMap.fromIterable(entries) };
};

/** One child of the parameters element: its parameter's name and value, or `undefined` for a vendor one. */
const elementParam = (child: XdmNode, offset: number): readonly [string, Value] | undefined => {
  const q = qnameOf(child);
  if (q === undefined || q.namespace === null)
    return structureError("a parameter element in no namespace", offset);
  if (q.namespace !== OUTPUT_NAMESPACE) return undefined;
  const kind = Option.getOrUndefined(HashMap.get(KINDS, q.local));
  if (kind === undefined) return structureError(`unknown parameter ${q.local}`, offset);
  if (kind === "map") return [q.local, characterMapElements(child, offset)];
  const attrs = attributesOf(child);
  const [value] = attrs;
  if (
    attrs.length !== 1 ||
    value === undefined ||
    qnameOf(value)?.local !== "value" ||
    qnameOf(value)?.namespace !== null
  )
    return structureError(`the parameter ${q.local} must have one value attribute`, offset);
  return [q.local, elementValue(kind, value.stringValue, child, offset)];
};

/** The parameters an `output:serialization-parameters` element gives (`err:XPTY0004` for any other element). */
export const paramsFromElement = (element: XdmNode, offset: number): Params => {
  const q = qnameOf(element);
  if (
    element.kind !== "element" ||
    q?.namespace !== OUTPUT_NAMESPACE ||
    q.local !== "serialization-parameters"
  )
    return raise(
      "XPTY0004",
      "the parameters are not an output:serialization-parameters element",
      offset,
    );
  if (!Arr.isReadonlyArrayEmpty(attributesOf(element)))
    return structureError("the parameters element has attributes", offset);
  const children = element.children.filter((c) => c.kind === "element");
  const names = children.map((c) => Option.match(c.name, { onNone: () => "", onSome: clark }));
  if (names.some((n, i) => names.indexOf(n) !== i))
    return raise("SEPM0019", "a serialization parameter is given twice", offset);
  return checked(
    Arr.reduce(children, defaults, (params, child) => {
      const param = elementParam(child, offset);
      return param === undefined ? params : withValue(params, param[0], param[1]);
    }),
    offset,
  );
};

// -----------------------------------------------------------------------------
// Output methods
// -----------------------------------------------------------------------------

const notSerializable = (what: string, offset: number): never =>
  raise("SENR0001", `${what} cannot be serialized with this output method`, offset);

/** The DOM a node stands for, for the writer: a text node's data as a text node. */
const domOf = (node: XdmNode, offset: number): XmlNode | XmlDocument => {
  const dom = node.dom;
  if (Predicate.isString(dom)) return textNode(dom);
  if (dom instanceof XmlDocument) return dom;
  return Predicate.isTagged(dom, "XmlElement") ||
    Predicate.isTagged(dom, "XmlComment") ||
    Predicate.isTagged(dom, "XmlProcessingInstruction")
    ? dom
    : notSerializable(`an ${node.kind} node`, offset);
};

/** Text with the character maps applied. */
const mapCharacters = (s: string, params: Params): string =>
  Array.from(s, (ch) => Option.getOrElse(HashMap.get(params.characterMaps, ch), () => ch)).join("");

/**
 * Markup with the character maps applied to its text and attribute values
 * (never to names or other markup), as Serialization 3.1 §11 asks.
 */
const mapMarkup = (markup: string, params: Params): string =>
  HashMap.isEmpty(params.characterMaps)
    ? markup
    : markup
        .split(/(<[^>]*>)/)
        .map((part) =>
          part.startsWith("<")
            ? part.replace(
                /(=\s*)(["'])(.*?)\2/g,
                (_, eq: string, q: string, v: string) => `${eq}${q}${mapCharacters(v, params)}${q}`,
              )
            : mapCharacters(part, params),
        )
        .join("");

/** A node as markup, with the XML writer and the parameters that apply to it. */
const writeNode = (node: XdmNode, params: Params, offset: number): string => {
  if (node.kind === "attribute" || node.kind === "namespace")
    return notSerializable(`an ${node.kind} node`, offset);
  const written = serializeSync(domOf(node, offset), {
    declaration: false,
    ...maybe("indent", params.indent ? 2 : undefined),
    invalid: "replace",
  });
  return mapMarkup(
    Result.getOrElse(written, (e) => raise("SERE0003", e.message, offset)),
    params,
  );
};

/** HTML's content-type `meta`, first in the `head` (the `include-content-type` parameter's default). */
const withContentType = (html: string, params: Params): string =>
  html.replace(
    /<head(\s[^>]*)?(\/?)>/i,
    (_, attrs: string | undefined, empty: string) =>
      `<head${attrs ?? ""}><meta http-equiv="Content-Type" content="text/html; charset=${params.encoding.toUpperCase()}">${empty === "/" ? "</head>" : ""}`,
  );

/** The XML declaration the parameters ask for. */
const declaration = (params: Params): string =>
  params.omitXmlDeclaration
    ? ""
    : `<?xml version="${params.version}" encoding="${params.encoding.toUpperCase()}"${
        params.standalone === undefined ? "" : ` standalone="${params.standalone ? "yes" : "no"}"`
      }?>`;

/** Sequence normalization (Serialization 3.1 §2): arrays flattened, documents and nodes kept, atomic values as text. */
const flatten = (s: Sequence): ReadonlyArray<Item> =>
  s.flatMap((item) => (item instanceof ArrayItem ? flatten(item.members.flat()) : [item]));

/** Items joined: the item separator between every two, or a space between adjacent atomic values. */
const joined = (
  items: ReadonlyArray<Item>,
  params: Params,
  write: (item: Item) => string,
): string =>
  items
    .map((item, i) => {
      const previous = items[i - 1];
      const separator =
        i === 0
          ? ""
          : (params.itemSeparator ??
            (isAtomic(item) && previous !== undefined && isAtomic(previous) ? " " : ""));
      return separator + write(item);
    })
    .join("");

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The `xml`, `xhtml` and `html` methods. */
const markup = (items: ReadonlyArray<Item>, params: Params, offset: number): string => {
  const body = joined(items, params, (item) => {
    if (isNode(item)) return writeNode(item, params, offset);
    if (isAtomic(item)) return escapeText(atomicString(item));
    return notSerializable("a function item", offset);
  });
  if (params.method !== "html") return declaration(params) + body;
  const doctype = /^\s*<html[\s>/]/i.test(body) ? "<!DOCTYPE html>" : "";
  return doctype + withContentType(body, params);
};

/** The `text` method: string values, unescaped. */
const plainText = (items: ReadonlyArray<Item>, params: Params, offset: number): string =>
  joined(items, params, (item) => {
    if (isNode(item)) return item.stringValue;
    if (isAtomic(item)) return atomicString(item);
    return notSerializable("a function item", offset);
  });

/** A JSON string, with the characters the encoding can't write escaped as `\u` sequences. */
const jsonString = (s: string, params: Params): string => {
  const limit =
    params.encoding === "us-ascii" ? 0x7f : params.encoding.startsWith("utf") ? Infinity : 0xff;
  return `"${Array.from(s, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    if (ch === '"') return '\\"';
    if (ch === "\\") return "\\\\";
    if (ch === "/") return "\\/";
    const short = Option.getOrUndefined(HashMap.get(JSON_ESCAPES, ch));
    if (short !== undefined) return short;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c > limit)
      return Array.from(
        { length: ch.length },
        (_, i) => `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`,
      ).join("");
    return ch;
  }).join("")}"`;
};

const JSON_ESCAPES = /*#__PURE__*/ HashMap.make(
  ["\b", "\\b"],
  ["\f", "\\f"],
  ["\n", "\\n"],
  ["\r", "\\r"],
  ["\t", "\\t"],
);

/** An atomic value as JSON: numbers (finite ones; `err:SERE0020` otherwise), booleans and strings. */
const jsonAtomic = (a: AtomicValue, params: Params, offset: number): string => {
  if (a.type === AtomicTypes.boolean || derivesFrom(a.type, AtomicTypes.boolean))
    return a.value === true ? "true" : "false";
  if (isNumericType(a.type)) {
    const s = atomicString(a);
    return /^-?(INF|NaN)$/.test(s)
      ? raise("SERE0020", `${s} cannot be written as JSON`, offset)
      : s;
  }
  return jsonString(atomicString(a), params);
};

const indentation = (params: Params, depth: number): string =>
  params.indent ? `\n${"  ".repeat(depth)}` : "";

/** One item as JSON (`err:SERE0023` for a sequence of more than one where one value is needed). */
const jsonValue = (s: Sequence, params: Params, depth: number, offset: number): string => {
  const [item, extra] = s;
  if (extra !== undefined) return raise("SERE0023", "JSON cannot represent a sequence", offset);
  if (item === undefined) return "null";
  if (isAtomic(item)) return jsonAtomic(item, params, offset);
  if (isNode(item))
    return jsonString(
      params.jsonNodeOutputMethod === "text" ? item.stringValue : writeNode(item, params, offset),
      params,
    );
  if (item instanceof ArrayItem) {
    const members = item.members.map(
      (m) => indentation(params, depth + 1) + jsonValue(m, params, depth + 1, offset),
    );
    return `[${members.join(",")}${Arr.isReadonlyArrayEmpty(members) ? "" : indentation(params, depth)}]`;
  }
  if (item instanceof MapItem) return jsonObject(item, params, depth, offset);
  return notSerializable("a function item", offset);
};

const jsonObject = (m: MapItem, params: Params, depth: number, offset: number): string => {
  const entries = m.toEntries().map(([k, v]) => [atomicString(k), v] as const);
  const keys = entries.map(([k]) => k);
  if (!params.allowDuplicateNames && keys.some((k, i) => keys.indexOf(k) !== i))
    return raise("SERE0022", "two map keys have the same string value", offset);
  const members = entries.map(
    ([k, v]) =>
      `${indentation(params, depth + 1)}${jsonString(k, params)}:${jsonValue(v, params, depth + 1, offset)}`,
  );
  return `{${members.join(",")}${Arr.isReadonlyArrayEmpty(members) ? "" : indentation(params, depth)}}`;
};

/** The `json` method. */
const json = (s: Sequence, params: Params, offset: number): string => {
  if (params.itemSeparator !== undefined && s.length > 1)
    return raise("SERE0023", "JSON cannot represent a sequence", offset);
  return jsonValue(s, params, 0, offset);
};

/** An atomic value as the adaptive method writes it (Serialization 3.1 §10.1). */
const adaptiveAtomic = (a: AtomicValue): string => {
  const s = atomicString(a);
  if (
    derivesFrom(a.type, AtomicTypes.string) ||
    a.type === AtomicTypes.untypedAtomic ||
    a.type === AtomicTypes.anyURI
  )
    return `"${s.replace(/"/g, '""')}"`;
  if (a.type === AtomicTypes.boolean) return `${s}()`;
  if (a.value instanceof QName) return `Q{${a.value.namespace ?? ""}}${a.value.local}`;
  if (
    a.type === AtomicTypes.integer ||
    a.type === AtomicTypes.decimal ||
    a.type === AtomicTypes.double
  )
    return s;
  return `xs:${a.type.name}("${s}")`;
};

/** An item as the adaptive method writes it. */
const adaptiveItem = (item: Item, params: Params, offset: number): string => {
  if (isAtomic(item)) return adaptiveAtomic(item);
  if (isNode(item))
    return item.kind === "attribute"
      ? `${Option.match(item.name, { onNone: () => "", onSome: (q) => q.qualified })}="${escapeText(item.stringValue).replace(/"/g, "&quot;")}"`
      : item.kind === "namespace"
        ? `xmlns${Option.match(item.name, { onNone: () => "", onSome: (q) => `:${q.local}` })}="${item.stringValue}"`
        : writeNode(item, params, offset);
  if (item instanceof ArrayItem)
    return `[${item.members.map((m) => adaptiveSequence(m, params, offset)).join(",")}]`;
  if (item instanceof MapItem)
    return `map{${Arr.sort(
      item.toEntries(),
      Order.mapInput(Order.String, ([k]: readonly [AtomicValue, Sequence]) => atomicString(k)),
    )
      .map(([k, v]) => `${adaptiveAtomic(k)}:${adaptiveSequence(v, params, offset)}`)
      .join(",")}}`;
  return item instanceof FunctionItem
    ? `${Option.match(item.name, { onNone: () => "(anonymous-function)", onSome: (q) => `Q{${q.namespace ?? ""}}${q.local}` })}#${item.arity}`
    : "";
};

/** A sequence inside a map or array, as the adaptive method writes it: in parentheses unless it is one item. */
const adaptiveSequence = (s: Sequence, params: Params, offset: number): string => {
  const [item, extra] = s;
  return item !== undefined && extra === undefined
    ? adaptiveItem(item, params, offset)
    : `(${s.map((i) => adaptiveItem(i, params, offset)).join(",")})`;
};

/** The `adaptive` method: items separated by the item separator (a newline by default). */
const adaptive = (s: Sequence, params: Params, offset: number): string =>
  s.map((item) => adaptiveItem(item, params, offset)).join(params.itemSeparator ?? "\n");

/** A sequence serialized with the parameters' output method. */
export const serializeSequence = (s: Sequence, params: Params, offset: number): string => {
  if (params.method === "json") return json(s, params, offset);
  if (params.method === "adaptive") return adaptive(s, params, offset);
  const items = flatten(s);
  if (items.some((i) => i instanceof MapItem || i instanceof FunctionItem))
    return notSerializable("a map or function item", offset);
  return params.method === "text"
    ? plainText(items, params, offset)
    : markup(items, params, offset);
};
