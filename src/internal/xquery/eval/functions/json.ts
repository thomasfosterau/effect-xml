/**
 * The JSON functions of F&O 3.1 §17.5: `parse-json`, `json-doc`,
 * `json-to-xml` and `xml-to-json`.
 *
 * JSON text is read in one pass over its tokens (a regular expression splits
 * it), with an explicit stack of open objects and arrays, so neither long
 * nor deeply nested input uses the call stack. Numbers are `xs:double`s;
 * `null` is the empty sequence (`parse-json`) or an `fn:null` element
 * (`json-to-xml`). The `liberal` option accepts nothing beyond RFC 7159.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as HashMap from "effect/HashMap";
import * as Record from "effect/Record";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { XmlAttribute, XmlElement } from "../../../../Xml/Node.ts";
import { attribute, document, element, qname, text as textNode } from "../../../nodes.ts";
import { quote } from "../../../quote.ts";
import { AtomicValue, atomicString } from "../../atomic.ts";
import { ArrayItem, isNode, MapItem, type Sequence } from "../../item.ts";
import { AtomicTypes } from "../../types.ts";
import { XdmNode } from "../../node.ts";
import { Namespaces } from "../../parser/builtins.ts";
import { castAtomic } from "../cast.ts";
import { orElse, raise } from "../raise.ts";
import { callFunction, fetchResource, isCallable } from "../runtime.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import { arg, mapOf, optionalAtom, text } from "./values.ts";

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

interface Options {
  readonly liberal: boolean;
  readonly duplicates: "reject" | "use-first" | "use-last" | "retain";
  readonly escape: boolean;
  readonly validate: boolean;
  readonly fallback: ((s: string) => string) | undefined;
  readonly indent: boolean;
}

const badOption = (what: string, call: Call): never =>
  raise("XPTY0004", `the JSON option ${what} has the wrong type`, call.offset);

const booleanOption = (m: MapItem, name: string, fallback: boolean, call: Call): boolean =>
  Option.match(m.get(AtomicValue.string(name)), {
    onNone: () => fallback,
    onSome: (v) => {
      const [a] = v;
      return v.length === 1 && a instanceof AtomicValue && Predicate.isBoolean(a.value)
        ? a.value
        : badOption(name, call);
    },
  });

const optionsOf = (
  s: Sequence | undefined,
  call: Call,
  duplicates: Options["duplicates"],
  allowRetain: boolean,
): Options => {
  const m = s === undefined || Arr.isReadonlyArrayEmpty(s) ? MapItem.empty : mapOf(s);
  const dup = Option.match(m.get(AtomicValue.string("duplicates")), {
    onNone: () => duplicates,
    onSome: (v) => {
      const [a] = v;
      const d =
        a instanceof AtomicValue && v.length === 1
          ? atomicString(a)
          : badOption("duplicates", call);
      return d === "reject" ||
        d === "use-first" ||
        d === "use-last" ||
        (allowRetain && d === "retain")
        ? d
        : raise("FOJS0005", `"${d}" is not a value of the duplicates option`, call.offset);
    },
  });
  const fallback = Option.map(m.get(AtomicValue.string("fallback")), (v) => {
    const [f] = v;
    if (v.length !== 1 || f === undefined || !isCallable(f)) return badOption("fallback", call);
    return (escaped: string) => text(callFunction(f, [[AtomicValue.string(escaped)]], call.offset));
  });
  const escape = booleanOption(m, "escape", false, call);
  if (escape && Option.isSome(fallback))
    raise("FOJS0005", "the escape and fallback options cannot both be given", call.offset);
  return {
    liberal: booleanOption(m, "liberal", false, call),
    duplicates: dup,
    escape,
    validate: booleanOption(m, "validate", false, call),
    fallback: Option.getOrUndefined(fallback),
    indent: booleanOption(m, "indent", false, call),
  };
};

// -----------------------------------------------------------------------------
// Strings
// -----------------------------------------------------------------------------

const isXmlCode = (c: number): boolean =>
  c === 0x9 ||
  c === 0xa ||
  c === 0xd ||
  (c >= 0x20 && c <= 0xd7ff) ||
  (c >= 0xe000 && c <= 0xfffd) ||
  (c >= 0x10000 && c <= 0x10ffff);

const hex4 = (c: number): string => `\\u${c.toString(16).toUpperCase().padStart(4, "0")}`;

/** The characters of JSON's two-character escapes, by the letter after the backslash. */
const shortEscapes: HashMap.HashMap<string, string> = /*#__PURE__*/ HashMap.make(
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
);

/** The two-character escape of a control character JSON has one for (`\n`, …). */
const controlEscape = (ch: string): string | undefined =>
  ch === "\b"
    ? "\\b"
    : ch === "\f"
      ? "\\f"
      : ch === "\n"
        ? "\\n"
        : ch === "\r"
          ? "\\r"
          : ch === "\t"
            ? "\\t"
            : undefined;

/** The decoded code units of a JSON string's body, `err:FOJS0001` for a bad escape or a raw control character. */
const decodeUnits = (body: string, call: Call): ReadonlyArray<number | string> =>
  Arr.fromIterable(body.matchAll(/\\u([0-9a-fA-F]{4})|\\(.)|\\$|[^\\]+/gsu)).flatMap(
    (m): ReadonlyArray<number | string> => {
      const [whole, code, short] = m;
      if (code !== undefined) return [Number.parseInt(code, 16)];
      if (short !== undefined) {
        return Option.match(HashMap.get(shortEscapes, short), {
          onNone: () => raise("FOJS0001", `\\${short} is not a JSON escape`, call.offset),
          onSome: (c) => [c],
        });
      }
      if (whole === "\\")
        return raise("FOJS0001", "a JSON string ends in a backslash", call.offset);
      return Arr.fromIterable(whole).some((c) => (c.codePointAt(0) ?? 0) < 0x20)
        ? raise("FOJS0001", "a JSON string has an unescaped control character", call.offset)
        : [whole];
    },
  );

/**
 * A JSON string's value: escapes decoded, and characters XML doesn't allow
 * (unpaired surrogates too) replaced by U+FFFD or by the fallback function;
 * with `escape`, special characters are kept as JSON escapes instead.
 */
const jsonString = (body: string, options: Options, call: Call): string => {
  const units = decodeUnits(body, call);
  // Join the \uXXXX units first, so escaped surrogate pairs become one character.
  const joined = units.map((u) => (Predicate.isNumber(u) ? String.fromCharCode(u) : u)).join("");
  return Arr.fromIterable(joined)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      const bad = !isXmlCode(c);
      if (options.escape) {
        if (ch === "\\") return "\\\\";
        if (bad || c < 0x20 || c === 0x7f) {
          return controlEscape(ch) ?? hex4(c);
        }
        return ch;
      }
      if (!bad) return ch;
      return options.fallback === undefined ? "�" : options.fallback(hex4(c));
    })
    .join("");
};

/** The options when none are given. */
const defaults: Options = {
  liberal: false,
  duplicates: "use-first",
  escape: false,
  validate: false,
  fallback: undefined,
  indent: false,
};

// -----------------------------------------------------------------------------
// Parsing
// -----------------------------------------------------------------------------

/** A parsed JSON value, before it becomes XDM. */
type Json = Data.TaggedEnum<{
  JString: { readonly value: string };
  JNumber: { readonly value: string };
  JBoolean: { readonly value: boolean };
  JNull: { readonly value: "null" };
  JArray: { readonly members: ReadonlyArray<Json> };
  JObject: { readonly entries: ReadonlyArray<readonly [key: string, raw: string, value: Json]> };
}>;

const Json = Data.taggedEnum<Json>();

const jsonNull: Json = Json.JNull({ value: "null" });

/** An object or array being read, and what it expects next. */
interface Frame {
  readonly kind: "array" | "object";
  readonly items: Array<Json>;
  readonly keys: Array<readonly [string, string]>;
  /** `value`, `key`, `colon`, `comma` (or the end). */
  expect: "value" | "key" | "colon" | "comma" | "first";
}

const tokens =
  /[ \t\n\r]+|"((?:[^"\\]|\\[^])*)"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\]:,]|[^]/gu;

/** The state of a read: the open objects and arrays, innermost last, and the finished top-level value. */
interface Reader {
  readonly stack: Array<Frame>;
  readonly done: Array<Json>;
  readonly syntax: (what: string) => never;
}

/** Whether the innermost open container (or the top level) takes a value next. */
const takesValue = (r: Reader): boolean => {
  const top = r.stack.at(-1);
  if (top === undefined) return Arr.isArrayEmpty(r.done);
  return top.expect === "value" || (top.kind === "array" && top.expect === "first");
};

/** A finished value, put where the reader is. */
const put = (r: Reader, value: Json): void => {
  if (!takesValue(r)) r.syntax("a value where none is allowed");
  const top = r.stack.at(-1);
  if (top === undefined) {
    r.done.push(value);
    return;
  }
  top.items.push(value);
  top.expect = "comma";
};

/** `}` or `]`: the innermost container, finished. */
const close = (r: Reader, token: string): void => {
  const want = token === "}" ? "object" : "array";
  const top = r.stack.pop();
  if (top === undefined || top.kind !== want || (top.expect !== "comma" && top.expect !== "first"))
    return r.syntax(`an unexpected ${token}`);
  put(
    r,
    want === "array"
      ? Json.JArray({ members: top.items })
      : Json.JObject({
          entries: top.keys.map(([k, raw], i) => [k, raw, top.items[i] ?? jsonNull] as const),
        }),
  );
};

/** `:` or `,`: what the innermost container expects next. */
const separator = (r: Reader, token: string): void => {
  const top = r.stack.at(-1);
  if (top === undefined) return r.syntax(`an unexpected ${token}`);
  if (token === ":" && top.kind === "object" && top.expect === "colon") top.expect = "value";
  else if (token === "," && top.expect === "comma")
    top.expect = top.kind === "object" ? "key" : "value";
  else r.syntax(`an unexpected ${token}`);
};

/** A string token: a key in an object that expects one, a value otherwise. */
const stringToken = (r: Reader, body: string, options: Options, call: Call): void => {
  const top = r.stack.at(-1);
  if (top?.kind === "object" && (top.expect === "key" || top.expect === "first")) {
    top.keys.push([jsonString(body, options, call), body]);
    top.expect = "colon";
    return;
  }
  put(r, Json.JString({ value: jsonString(body, options, call) }));
};

/** A literal or number token, as its value. */
const scalar = (r: Reader, token: string): Json => {
  if (token === "true" || token === "false") return Json.JBoolean({ value: token === "true" });
  if (token === "null") return jsonNull;
  return /^-?\d/.test(token)
    ? Json.JNumber({ value: token })
    : r.syntax(`unexpected ${quote(token)}`);
};

/** Read one token. */
const step = (r: Reader, token: string, body: string | undefined, options: Options, call: Call) => {
  if (/^[ \t\n\r]/.test(token)) return;
  if (body !== undefined) return stringToken(r, body, options, call);
  if (token === "{" || token === "[") {
    if (!takesValue(r)) r.syntax(`an unexpected ${token}`);
    r.stack.push({
      kind: token === "{" ? "object" : "array",
      items: [],
      keys: [],
      expect: "first",
    });
    return;
  }
  if (token === "}" || token === "]") return close(r, token);
  if (token === ":" || token === ",") return separator(r, token);
  return put(r, scalar(r, token));
};

/** Read JSON text into its value: `err:FOJS0001` when it is not JSON. */
const readJson = (input: string, options: Options, call: Call): Json => {
  const r: Reader = {
    stack: [],
    done: [],
    syntax: (what) => raise("FOJS0001", `invalid JSON: ${what}`, call.offset),
  };
  Arr.fromIterable(input.matchAll(tokens)).forEach(([token, body]) =>
    step(r, token, body, options, call),
  );
  if (Arr.isArrayNonEmpty(r.stack)) return r.syntax("the input ends inside an object or array");
  return r.done[0] ?? r.syntax("there is no value");
};

/** An object's entries with duplicate keys resolved as the option says: `err:FOJS0003` to reject them. */
const deduplicate = (
  entries: ReadonlyArray<readonly [string, string, Json]>,
  options: Options,
  call: Call,
): ReadonlyArray<readonly [string, string, Json]> => {
  if (options.duplicates === "retain") return entries;
  const byKey = Arr.groupBy(entries, ([k]) => k);
  if (options.duplicates === "reject" && Record.values(byKey).some((g) => g.length > 1))
    return raise("FOJS0003", "a JSON object has duplicate keys", call.offset);
  return entries.filter(([k], i) => {
    const group = byKey[k] ?? [];
    const keep = options.duplicates === "use-last" ? group.at(-1) : group[0];
    return keep === entries[i];
  });
};

const toXdm = (json: Json, options: Options, call: Call): Sequence =>
  Json.$match(json, {
    JString: ({ value }) => [AtomicValue.string(value)],
    JNumber: ({ value }) => [AtomicValue.double(Number(value))],
    JBoolean: ({ value }) => [AtomicValue.boolean(value)],
    JNull: () => [],
    JArray: ({ members }) => [new ArrayItem(members.map((m) => toXdm(m, options, call)))],
    JObject: ({ entries }) => [
      MapItem.fromEntries(
        deduplicate(entries, options, call).map(
          ([k, , v]) => [AtomicValue.string(k), toXdm(v, options, call)] as const,
        ),
      ),
    ],
  });

const parseJson = (input: Sequence, options: Options, call: Call): Sequence => {
  const a = optionalAtom(input);
  return a === undefined ? [] : toXdm(readJson(atomicString(a), options, call), options, call);
};

/** The text of a JSON document, fetched as `fn:unparsed-text` fetches it. */
const fetchJson = (href: string, call: Call): string => {
  const base = Option.getOrUndefined(call.statics.baseUri);
  const uri =
    URL.parse(href, base)?.href ?? raise("FOUT1170", `${href} cannot be resolved`, call.offset);
  const got = fetchResource(call.ctx.dyn, { kind: "text", uri, encoding: undefined }, call.offset);
  return Predicate.isString(got)
    ? got.replace(/^﻿/, "")
    : raise("FOUT1170", `${href} is not a text`, call.offset);
};

// -----------------------------------------------------------------------------
// json-to-xml
// -----------------------------------------------------------------------------

const fn = (local: string) => qname(null, local, Namespaces.fn);

/** Whether a string's escaped form (with `escape`) has any escape in it. */
const hasEscape = (s: string): boolean => s.includes("\\");

const jsonElement = (
  json: Json,
  key: readonly [string, string] | undefined,
  options: Options,
  call: Call,
): XmlElement => {
  const keyAttributes: ReadonlyArray<XmlAttribute> =
    key === undefined
      ? []
      : [
          attribute(qname(null, "key", null), key[0]),
          ...(options.escape && hasEscape(key[0])
            ? [attribute(qname(null, "escaped-key", null), "true")]
            : []),
        ];
  return Json.$match(json, {
    JString: ({ value }) =>
      element(
        fn("string"),
        [
          ...keyAttributes,
          ...(options.escape && hasEscape(value)
            ? [attribute(qname(null, "escaped", null), "true")]
            : []),
        ],
        value === "" ? [] : [textNode(value)],
      ),
    JNumber: ({ value }) => element(fn("number"), keyAttributes, [textNode(value)]),
    JBoolean: ({ value }) => element(fn("boolean"), keyAttributes, [textNode(String(value))]),
    JNull: () => element(fn("null"), keyAttributes, []),
    JArray: ({ members }) =>
      element(
        fn("array"),
        keyAttributes,
        members.map((m) => jsonElement(m, undefined, options, call)),
      ),
    JObject: ({ entries }) =>
      element(
        fn("map"),
        keyAttributes,
        deduplicate(entries, options, call).map(([k, raw, v]) =>
          jsonElement(v, [k, raw], options, call),
        ),
      ),
  });
};

const jsonToXml = (input: Sequence, options: Options, call: Call): Sequence => {
  const a = optionalAtom(input);
  if (a === undefined) return [];
  if (options.validate)
    return raise(
      "FOJS0004",
      "json-to-xml cannot validate: schema validation is not supported",
      call.offset,
    );
  const root = jsonElement(readJson(atomicString(a), options, call), undefined, options, call);
  const withNamespace = element(
    root.name,
    [attribute(qname(null, "xmlns", null), Namespaces.fn), ...root.attributes],
    root.children,
  );
  return [XdmNode.fromDocument(document(null, null, [withNamespace]))];
};

// -----------------------------------------------------------------------------
// xml-to-json
// -----------------------------------------------------------------------------

const invalidXml = (what: string, call: Call): never =>
  raise("FOJS0006", `the XML is not a JSON representation: ${what}`, call.offset);

const isFn = (n: XdmNode): boolean =>
  Option.match(n.name, { onNone: () => false, onSome: (q) => q.namespace === Namespaces.fn });

const localName = (n: XdmNode): string =>
  Option.match(n.name, { onNone: () => "", onSome: (q) => q.local });

/** A string as JSON writes it: `"` and `\` escaped, control characters as escapes, `/` as `\/`. */
const writeString = (s: string): string =>
  `"${Arr.fromIterable(s)
    .map((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      if (ch === '"') return '\\"';
      if (ch === "\\") return "\\\\";
      if (ch === "/") return "\\/";
      if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
        return controlEscape(ch) ?? hex4(c);
      }
      return ch;
    })
    .join("")}"`;

/** An escaped string (`escaped="true"`) as JSON: its escapes kept, checked, and other characters written as `writeString` would. */
const writeEscaped = (s: string, call: Call): string => {
  if (/\\(?![bfnrt"\\/]|u[0-9a-fA-F]{4})/.test(s))
    return raise("FOJS0007", `"${s}" has an invalid JSON escape`, call.offset);
  return `"${Arr.fromIterable(s.matchAll(/\\(?:u[0-9a-fA-F]{4}|.)|[^\\]+/gsu))
    .map(([part]) => (part.startsWith("\\") ? part : writeString(part).slice(1, -1)))
    .join("")}"`;
};

const attributeValue = (n: XdmNode, local: string): string | undefined =>
  n.attributes.find((a) =>
    Option.match(a.name, {
      onNone: () => false,
      onSome: (q) => q.local === local && q.namespace === null,
    }),
  )?.stringValue;

const isTrue = (s: string | undefined, call: Call): boolean => {
  if (s === undefined) return false;
  const v = s.trim();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return invalidXml(`"${s}" is not a boolean`, call);
};

/** The element children of a map or array, checking that there is only whitespace text besides. */
const memberElements = (n: XdmNode, call: Call): ReadonlyArray<XdmNode> =>
  n.children.flatMap((c) => {
    if (c.kind === "element") return [c];
    if (c.kind === "text" && c.stringValue.trim() !== "")
      return invalidXml(`${localName(n)} has text content`, call);
    return [];
  });

const writeJson = (n: XdmNode, call: Call, inMap: boolean): string => {
  if (n.kind === "document") {
    const [root] = memberElements(n, call);
    return root === undefined
      ? invalidXml("there is no element", call)
      : writeJson(root, call, false);
  }
  if (n.kind !== "element" || !isFn(n))
    return invalidXml("an element not in the fn namespace", call);
  const kind = localName(n);
  const foreign = n.attributes.some((a) =>
    Option.match(a.name, {
      onNone: () => false,
      onSome: (q) =>
        q.namespace === null &&
        !(["key", "escaped-key"].includes(q.local) && inMap) &&
        !(q.local === "escaped" && kind === "string"),
    }),
  );
  if (foreign) return invalidXml(`an attribute on ${kind} is not allowed`, call);
  if (inMap && attributeValue(n, "key") === undefined)
    return invalidXml("a map member has no key", call);
  const write = writers[kind];
  return write === undefined
    ? invalidXml(`fn:${kind} is not a JSON element`, call)
    : write(n, call);
};

/** A map key's string value, its escapes decoded when it has `escaped-key`. */
const keyValue = (m: XdmNode, call: Call): string => {
  const key = attributeValue(m, "key") ?? "";
  return isTrue(attributeValue(m, "escaped-key"), call)
    ? jsonString(writeEscaped(key, call).slice(1, -1), defaults, call)
    : key;
};

/** How each element of the JSON vocabulary is written as JSON. */
const writers: Readonly<Partial<Record<string, (n: XdmNode, call: Call) => string>>> = {
  null: (n, call) =>
    Arr.isReadonlyArrayEmpty(
      n.children.filter((c) => c.kind !== "comment" && c.kind !== "processing-instruction"),
    )
      ? "null"
      : invalidXml("null has content", call),
  boolean: (n, call) => (isTrue(n.stringValue, call) ? "true" : "false"),
  number: (n, call) => {
    const v = orElse(
      () => castAtomic(AtomicValue.string(n.stringValue), AtomicTypes.double).value,
      Number.NaN,
    );
    const d = Predicate.isNumber(v) ? v : Number.NaN;
    return Number.isFinite(d)
      ? atomicString(AtomicValue.double(d))
      : invalidXml(`"${n.stringValue}" is not a JSON number`, call);
  },
  string: (n, call) => {
    if (n.children.some((c) => c.kind === "element"))
      return invalidXml("string has element content", call);
    return isTrue(attributeValue(n, "escaped"), call)
      ? writeEscaped(n.stringValue, call)
      : writeString(n.stringValue);
  },
  array: (n, call) =>
    `[${memberElements(n, call)
      .map((m) => writeJson(m, call, false))
      .join(",")}]`,
  map: (n, call) => {
    const members = memberElements(n, call);
    const keys = members.map((m) => keyValue(m, call));
    if (Arr.dedupe(keys).length !== keys.length)
      return invalidXml("a map has duplicate keys", call);
    return `{${members.map((m, i) => `${writeString(keys[i] ?? "")}:${writeJson(m, call, true)}`).join(",")}}`;
  },
};

const xmlToJson = (input: Sequence, call: Call): Sequence => {
  const [n] = input;
  if (n === undefined) return [];
  return isNode(n)
    ? [AtomicValue.string(writeJson(n, call, false))]
    : invalidXml("not a node", call);
};

/** The JSON functions. */
export const json: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:parse-json",
    params: ["xs:string?"],
    result: "item()?",
    impl: (args, call) =>
      parseJson(arg(args, 0), optionsOf(undefined, call, "use-first", false), call),
  },
  {
    name: "fn:parse-json",
    params: ["xs:string?", "map(*)"],
    result: "item()?",
    impl: (args, call) =>
      parseJson(arg(args, 0), optionsOf(arg(args, 1), call, "use-first", false), call),
  },
  {
    name: "fn:json-doc",
    params: ["xs:string?"],
    result: "item()?",
    impl: (args, call) => {
      const href = optionalAtom(arg(args, 0));
      return href === undefined
        ? []
        : parseJson(
            [AtomicValue.string(fetchJson(atomicString(href), call))],
            optionsOf(undefined, call, "use-first", false),
            call,
          );
    },
  },
  {
    name: "fn:json-doc",
    params: ["xs:string?", "map(*)"],
    result: "item()?",
    impl: (args, call) => {
      const href = optionalAtom(arg(args, 0));
      return href === undefined
        ? []
        : parseJson(
            [AtomicValue.string(fetchJson(atomicString(href), call))],
            optionsOf(arg(args, 1), call, "use-first", false),
            call,
          );
    },
  },
  {
    name: "fn:json-to-xml",
    params: ["xs:string?"],
    result: "document-node()?",
    impl: (args, call) =>
      jsonToXml(arg(args, 0), optionsOf(undefined, call, "use-first", true), call),
  },
  {
    name: "fn:json-to-xml",
    params: ["xs:string?", "map(*)"],
    result: "document-node()?",
    impl: (args, call) =>
      jsonToXml(arg(args, 0), optionsOf(arg(args, 1), call, "use-first", true), call),
  },
  {
    name: "fn:xml-to-json",
    params: ["node()?"],
    result: "xs:string?",
    impl: (args, call) => xmlToJson(arg(args, 0), call),
  },
  {
    name: "fn:xml-to-json",
    params: ["node()?", "map(*)"],
    result: "xs:string?",
    impl: (args, call) => {
      optionsOf(arg(args, 1), call, "use-first", false);
      return xmlToJson(arg(args, 0), call);
    },
  },
];
