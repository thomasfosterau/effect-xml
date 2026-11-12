/**
 * The built-in functions the evaluator core needs: booleans, the focus
 * (`fn:position`, `fn:last`), counting and taking sequences apart, the
 * string and typed values of items, node names and roots, `fn:deep-equal`,
 * `fn:error`, documents and collections, and the basic map and array
 * accessors. The rest of Functions and Operators 3.1 is added as further
 * libraries (`registry.ts`).
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { isValidNCName, QName } from "../../../../Name.ts";
import { XQueryError, errorCode } from "../../../../XQuery/Error.ts";
import { canonicalEncoding } from "../../../../Encoding.ts";
import { AtomicValue } from "../../atomic.ts";
import {
  atomize,
  effectiveBooleanValue,
  FunctionItem,
  isNode,
  MapItem,
  stringValue,
  type Item,
  type Sequence,
} from "../../item.ts";
import type { XdmNode } from "../../node.ts";
import { AtomicTypes } from "../../types.ts";
import { castAtomic, toNumber } from "../cast.ts";
import { deepEqual } from "../compare.ts";
import { orElse, raise, succeeds, unwrap } from "../raise.ts";
import { arrayMember, contextItem, fetchResource } from "../runtime.ts";
import { collationOf } from "./collation.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import { arg, arrayOf, atomOf, bool, int, isEmpty, mapOf, ofNode, str, text } from "./values.ts";

const isQName = Schema.is(QName);

/** How many characters (code points, not UTF-16 units) a string has. */
const codepoints = (s: string): number => Arr.fromIterable(s).length;

const nodeName = (node: XdmNode | undefined): Option.Option<QName> =>
  node === undefined ? Option.none() : node.name;

const booleans: ReadonlyArray<BuiltinSpec> = [
  { name: "fn:true", params: [], result: "xs:boolean", impl: () => bool(true) },
  { name: "fn:false", params: [], result: "xs:boolean", impl: () => bool(false) },
  {
    name: "fn:boolean",
    params: ["item()*"],
    result: "xs:boolean",
    impl: (args, call) => bool(unwrap(effectiveBooleanValue(arg(args, 0)), call.offset)),
  },
  {
    name: "fn:not",
    params: ["item()*"],
    result: "xs:boolean",
    impl: (args, call) => bool(!unwrap(effectiveBooleanValue(arg(args, 0)), call.offset)),
  },
];

const focus: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:position",
    params: [],
    result: "xs:integer",
    focus: true,
    impl: (_, { ctx, offset }) => (contextItem(ctx, offset) ? int(ctx.position) : []),
  },
  {
    name: "fn:last",
    params: [],
    result: "xs:integer",
    focus: true,
    impl: (_, { ctx, offset }) => (contextItem(ctx, offset) ? int(ctx.size) : []),
  },
];

/**
 * F&O 3.1 §14.1.10: the items at the positions p with `from <= p < to`
 * (`to` absent: no upper bound). The bounds may be infinite, and a NaN bound
 * selects nothing (`-INF + INF`, from a three-argument call, is NaN).
 */
const positions = (s: Sequence, from: number, to: number | undefined): Sequence => {
  if (Number.isNaN(from) || (to !== undefined && Number.isNaN(to))) return [];
  const lo = from <= 1 ? 0 : Math.min(from - 1, s.length);
  const hi = to === undefined ? s.length : to <= 1 ? 0 : Math.min(to - 1, s.length);
  return s.slice(lo, Math.max(lo, hi));
};

const cardinality = (
  name: string,
  result: string,
  ok: (n: number) => boolean,
  code: string,
  what: string,
): BuiltinSpec => ({
  name,
  params: ["item()*"],
  result,
  impl: (args, call) => {
    const s = arg(args, 0);
    return ok(s.length)
      ? s
      : raise(code, `${name} was given ${s.length} items: ${what}`, call.offset);
  },
});

const sequences: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:count",
    params: ["item()*"],
    result: "xs:integer",
    impl: (args) => int(arg(args, 0).length),
  },
  {
    name: "fn:empty",
    params: ["item()*"],
    result: "xs:boolean",
    impl: (args) => bool(Arr.isReadonlyArrayEmpty(arg(args, 0))),
  },
  {
    name: "fn:exists",
    params: ["item()*"],
    result: "xs:boolean",
    impl: (args) => bool(Arr.isReadonlyArrayNonEmpty(arg(args, 0))),
  },
  {
    name: "fn:head",
    params: ["item()*"],
    result: "item()?",
    impl: (args) => arg(args, 0).slice(0, 1),
  },
  {
    name: "fn:tail",
    params: ["item()*"],
    result: "item()*",
    impl: (args) => arg(args, 0).slice(1),
  },
  {
    name: "fn:reverse",
    params: ["item()*"],
    result: "item()*",
    impl: (args) => Arr.reverse(arg(args, 0)),
  },
  {
    name: "fn:subsequence",
    params: ["item()*", "xs:double"],
    result: "item()*",
    impl: (args) => positions(arg(args, 0), Math.round(toNumber(atomOf(arg(args, 1)))), undefined),
  },
  {
    name: "fn:subsequence",
    params: ["item()*", "xs:double", "xs:double"],
    result: "item()*",
    impl: (args) => {
      const from = Math.round(toNumber(atomOf(arg(args, 1))));
      return positions(arg(args, 0), from, from + Math.round(toNumber(atomOf(arg(args, 2)))));
    },
  },
  cardinality("fn:zero-or-one", "item()?", (n) => n <= 1, "FORG0003", "expected at most one"),
  cardinality("fn:one-or-more", "item()+", (n) => n >= 1, "FORG0004", "expected at least one"),
  cardinality("fn:exactly-one", "item()", (n) => n === 1, "FORG0005", "expected exactly one"),
  {
    name: "fn:deep-equal",
    params: ["item()*", "item()*"],
    result: "xs:boolean",
    impl: (args, call) =>
      bool(
        deepEqual(
          arg(args, 0),
          arg(args, 1),
          call.ctx.dyn.implicitTimezone,
          collationOf(undefined, call).compare,
        ),
      ),
  },
];

const stringOf = (item: Item | undefined, call: Call): Sequence =>
  item === undefined ? str("") : str(unwrap(stringValue(item), call.offset));

const strings: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:string",
    params: [],
    result: "xs:string",
    focus: true,
    impl: (_, call) => stringOf(contextItem(call.ctx, call.offset), call),
  },
  {
    name: "fn:string",
    params: ["item()?"],
    result: "xs:string",
    impl: (args, call) => stringOf(arg(args, 0)[0], call),
  },
  {
    name: "fn:data",
    params: [],
    result: "xs:anyAtomicType*",
    focus: true,
    impl: (_, call) => unwrap(atomize([contextItem(call.ctx, call.offset)]), call.offset),
  },
  {
    name: "fn:data",
    params: ["item()*"],
    result: "xs:anyAtomicType*",
    impl: (args, call) => unwrap(atomize(arg(args, 0)), call.offset),
  },
  {
    name: "fn:concat",
    params: ["xs:anyAtomicType?", "xs:anyAtomicType?"],
    result: "xs:string",
    variadic: true,
    impl: (args) => str(args.map(text).join("")),
  },
  {
    name: "fn:string-join",
    params: ["xs:anyAtomicType*"],
    result: "xs:string",
    impl: (args) =>
      str(
        arg(args, 0)
          .map((a) => text([a]))
          .join(""),
      ),
  },
  {
    name: "fn:string-join",
    params: ["xs:anyAtomicType*", "xs:string"],
    result: "xs:string",
    impl: (args) =>
      str(
        arg(args, 0)
          .map((a) => text([a]))
          .join(text(arg(args, 1))),
      ),
  },
  {
    name: "fn:string-length",
    params: [],
    result: "xs:integer",
    focus: true,
    impl: (_, call) => int(codepoints(text(stringOf(contextItem(call.ctx, call.offset), call)))),
  },
  {
    name: "fn:string-length",
    params: ["xs:string?"],
    result: "xs:integer",
    impl: (args) => int(codepoints(text(arg(args, 0)))),
  },
  {
    name: "fn:number",
    params: [],
    result: "xs:double",
    focus: true,
    impl: (_, call) => numberOf(unwrap(atomize([contextItem(call.ctx, call.offset)]))),
  },
  {
    name: "fn:number",
    params: ["xs:anyAtomicType?"],
    result: "xs:double",
    impl: (args) => numberOf(arg(args, 0)),
  },
];

/** `fn:number`: the value as an `xs:double`, NaN when it has none. */
const numberOf = (s: Sequence): Sequence => {
  const [a] = s;
  const nan = AtomicValue.double(Number.NaN);
  return [a instanceof AtomicValue ? orElse(() => castAtomic(a, AtomicTypes.double), nan) : nan];
};

const qnameValue = (q: Option.Option<QName>): Sequence =>
  Arr.fromOption(Option.map(q, (n) => AtomicValue.qname(n)));

const names: ReadonlyArray<BuiltinSpec> = [
  ...ofNode("fn:node-name", "xs:QName?", (n) => qnameValue(nodeName(n))),
  ...ofNode("fn:name", "xs:string", (n) =>
    str(
      Option.match(nodeName(n), {
        onNone: () => "",
        onSome: (q) => (n?.kind === "namespace" ? q.local : q.qualified),
      }),
    ),
  ),
  ...ofNode("fn:local-name", "xs:string", (n) =>
    str(Option.match(nodeName(n), { onNone: () => "", onSome: (q) => q.local })),
  ),
  ...ofNode("fn:namespace-uri", "xs:anyURI", (n) => [
    AtomicValue.anyURI(
      n?.kind === "element" || n?.kind === "attribute"
        ? Option.match(nodeName(n), {
            onNone: () => "",
            onSome: (q) => Option.getOrElse(q.namespace, () => ""),
          })
        : "",
    ),
  ]),
  ...ofNode("fn:root", "node()?", (n) => (n === undefined ? [] : [n.root])),
];

/** A URI resolved against the static base URI: `err:FODC0005` if it is not a URI. */
const absolute = (
  uri: string,
  call: Call,
  unresolved = "FODC0002",
  invalid = "FODC0005",
): string => {
  const base = Option.getOrUndefined(call.statics.baseUri);
  const resolved = URL.parse(uri, base) ?? (base === undefined ? undefined : URL.parse(uri));
  if (resolved !== null && resolved !== undefined) return resolved.href;
  if (base === undefined && !/^[^:/?#]+:/.test(uri) && uri !== "")
    return raise(unresolved, `${uri} cannot be resolved: there is no base URI`, call.offset);
  return raise(invalid, `${uri} is not a valid URI`, call.offset);
};

const fetchDocument = (uri: string, call: Call): Sequence => {
  const got = fetchResource(
    call.ctx.dyn,
    { kind: "document", uri: absolute(uri, call), encoding: undefined },
    call.offset,
  );
  return P.isString(got) ? [] : got;
};

const resources: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:doc",
    params: ["xs:string?"],
    result: "document-node()?",
    impl: (args, call) => (isEmpty(arg(args, 0)) ? [] : fetchDocument(text(arg(args, 0)), call)),
  },
  {
    name: "fn:doc-available",
    params: ["xs:string?"],
    result: "xs:boolean",
    impl: (args, call) =>
      bool(!isEmpty(arg(args, 0)) && succeeds(() => fetchDocument(text(arg(args, 0)), call))),
  },
  {
    name: "fn:collection",
    params: [],
    result: "item()*",
    impl: (_, call) => collection("", call),
  },
  {
    name: "fn:collection",
    params: ["xs:string?"],
    result: "item()*",
    impl: (args, call) =>
      collection(
        isEmpty(arg(args, 0)) ? "" : absolute(text(arg(args, 0)), call, "FODC0002", "FODC0004"),
        call,
      ),
  },
  {
    name: "fn:unparsed-text",
    params: ["xs:string?"],
    result: "xs:string?",
    impl: (args, call) => unparsedText(args, call),
  },
  {
    name: "fn:unparsed-text",
    params: ["xs:string?", "xs:string"],
    result: "xs:string?",
    impl: (args, call) => unparsedText(args, call),
  },
  {
    name: "fn:unparsed-text-lines",
    params: ["xs:string?"],
    result: "xs:string*",
    impl: (args, call) => textLines(unparsedText(args, call)),
  },
  {
    name: "fn:unparsed-text-lines",
    params: ["xs:string?", "xs:string"],
    result: "xs:string*",
    impl: (args, call) => textLines(unparsedText(args, call)),
  },
  {
    name: "fn:uri-collection",
    params: [],
    result: "xs:anyURI*",
    impl: (_, call) => uriCollection("", call),
  },
  {
    name: "fn:uri-collection",
    params: ["xs:string?"],
    result: "xs:anyURI*",
    impl: (args, call) =>
      uriCollection(
        isEmpty(arg(args, 0)) ? "" : absolute(text(arg(args, 0)), call, "FODC0002", "FODC0004"),
        call,
      ),
  },
  {
    name: "fn:unparsed-text-available",
    params: ["xs:string?"],
    result: "xs:boolean",
    impl: (args, call) => bool(!isEmpty(arg(args, 0)) && succeeds(() => unparsedText(args, call))),
  },
  {
    name: "fn:unparsed-text-available",
    params: ["xs:string?", "xs:string"],
    result: "xs:boolean",
    impl: (args, call) => bool(!isEmpty(arg(args, 0)) && succeeds(() => unparsedText(args, call))),
  },
];

const collection = (uri: string, call: Call): Sequence => {
  const got = fetchResource(
    call.ctx.dyn,
    { kind: "collection", uri, encoding: undefined },
    call.offset,
  );
  return P.isString(got) ? [] : got;
};

/**
 * `fn:unparsed-text-lines`: a text's lines, split at CR LF, CR or LF, without
 * the empty line after a final line ending.
 */
const textLines = (content: Sequence): Sequence => {
  const [t] = content;
  if (t === undefined) return [];
  const lines = unwrap(stringValue(t)).split(/\r\n|\r|\n/);
  return (lines.at(-1) === "" ? lines.slice(0, -1) : lines).map((l) => AtomicValue.string(l));
};

/**
 * `fn:uri-collection`: the URIs of a collection's documents (the resolver's
 * collection, read for its nodes' document URIs; other items have none).
 */
const uriCollection = (uri: string, call: Call): Sequence =>
  collection(uri, call).flatMap((item) =>
    isNode(item) ? Option.toArray(Option.map(item.documentUri, (u) => AtomicValue.anyURI(u))) : [],
  );

/** A character XML 1.0 does not allow (a lone surrogate included). */
const NON_XML = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;

const unparsedText = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  if (isEmpty(arg(args, 0))) return [];
  const encoding = args.length > 1 ? text(arg(args, 1)) : undefined;
  if (encoding !== undefined && Option.isNone(canonicalEncoding(encoding)))
    return raise("FOUT1190", `the encoding "${encoding}" is not supported`, call.offset);
  const got = fetchResource(
    call.ctx.dyn,
    // F&O 3.1 §14.8.1: a URI that can't be resolved is FOUT1170, as a missing resource is.
    { kind: "text", uri: absolute(text(arg(args, 0)), call, "FOUT1170", "FOUT1170"), encoding },
    call.offset,
  );
  if (!P.isString(got)) return [];
  return NON_XML.test(got)
    ? raise("FOUT1190", "the resource contains a character that is not allowed in XML", call.offset)
    : str(got);
};

const errorQName = (s: Sequence, call: Call): QName => {
  const [q] = s;
  return q !== undefined && q instanceof AtomicValue && isQName(q.value)
    ? q.value
    : raise("XPTY0004", "fn:error's code must be an xs:QName", call.offset);
};

const raiseUser = (
  code: QName,
  description: string,
  value: Sequence | undefined,
  call: Call,
): never => {
  throw new XQueryError({ code, description, offset: call.offset, value });
};

/** `fn:QName`: a QName from a namespace URI and a lexical QName; `err:FOCA0002` if the name is not one. */
const makeQName = (uri: string, lexical: string, call: Call): Sequence => {
  const colon = lexical.indexOf(":");
  const prefix = colon < 0 ? null : lexical.slice(0, colon);
  const local = lexical.slice(colon + 1);
  const valid = isValidNCName(local) && (prefix === null || isValidNCName(prefix));
  if (!valid) return raise("FOCA0002", `${lexical} is not a lexical QName`, call.offset);
  if (prefix !== null && uri === "")
    return raise("FOCA0002", `${lexical} has a prefix but no namespace`, call.offset);
  return [
    AtomicValue.qname(
      new QName({
        prefix: Option.fromNullOr(prefix),
        local,
        namespace: uri === "" ? Option.none() : Option.some(uri),
      }),
    ),
  ];
};

/** `fn:error` with a code, and optionally a description and an error value. */
const errorArity = (params: ReadonlyArray<string>): BuiltinSpec => ({
  name: "fn:error",
  params,
  result: "item()*",
  impl: (args, call) =>
    raiseUser(
      isEmpty(arg(args, 0)) ? errorCode("FOER0000") : errorQName(arg(args, 0), call),
      args.length > 1 ? text(arg(args, 1)) : "fn:error was called",
      args.length > 2 ? arg(args, 2) : undefined,
      call,
    ),
});

const errors: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:QName",
    params: ["xs:string?", "xs:string"],
    result: "xs:QName",
    impl: (args, call) => makeQName(text(arg(args, 0)), text(arg(args, 1)), call),
  },
  {
    name: "fn:error",
    params: [],
    result: "item()*",
    impl: (_, call) => raiseUser(errorCode("FOER0000"), "fn:error was called", undefined, call),
  },
  errorArity(["xs:QName?"]),
  errorArity(["xs:QName?", "xs:string"]),
  errorArity(["xs:QName?", "xs:string", "item()*"]),
];

const mapsAndArrays: ReadonlyArray<BuiltinSpec> = [
  {
    name: "map:size",
    params: ["map(*)"],
    result: "xs:integer",
    impl: (args) => int(mapOf(arg(args, 0)).size),
  },
  {
    name: "map:keys",
    params: ["map(*)"],
    result: "xs:anyAtomicType*",
    impl: (args) => mapOf(arg(args, 0)).keys(),
  },
  {
    name: "map:contains",
    params: ["map(*)", "xs:anyAtomicType"],
    result: "xs:boolean",
    impl: (args) => bool(mapOf(arg(args, 0)).has(atomOf(arg(args, 1)))),
  },
  {
    name: "map:get",
    params: ["map(*)", "xs:anyAtomicType"],
    result: "item()*",
    impl: (args) => Option.getOrElse(mapOf(arg(args, 0)).get(atomOf(arg(args, 1))), () => []),
  },
  {
    name: "map:entry",
    params: ["xs:anyAtomicType", "item()*"],
    result: "map(*)",
    impl: (args) => [MapItem.empty.set(atomOf(arg(args, 0)), arg(args, 1))],
  },
  {
    name: "array:size",
    params: ["array(*)"],
    result: "xs:integer",
    impl: (args) => int(arrayOf(arg(args, 0)).size),
  },
  {
    name: "array:get",
    params: ["array(*)", "xs:integer"],
    result: "item()*",
    impl: (args, call) => arrayMember(arrayOf(arg(args, 0)), atomOf(arg(args, 1)), call.offset),
  },
  {
    name: "fn:function-arity",
    params: ["function(*)"],
    result: "xs:integer",
    impl: (args) => {
      const f = arg(args, 0)[0];
      return int(f instanceof FunctionItem ? f.arity : 1);
    },
  },
];

const context: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:current-dateTime",
    params: [],
    result: "xs:dateTimeStamp",
    impl: (_, { ctx }) => [new AtomicValue(AtomicTypes.dateTimeStamp, ctx.dyn.currentDateTime)],
  },
  {
    name: "fn:current-date",
    params: [],
    result: "xs:date",
    impl: (_, { ctx }) => [
      castAtomic(new AtomicValue(AtomicTypes.dateTime, ctx.dyn.currentDateTime), AtomicTypes.date),
    ],
  },
  {
    name: "fn:current-time",
    params: [],
    result: "xs:time",
    impl: (_, { ctx }) => [
      castAtomic(new AtomicValue(AtomicTypes.dateTime, ctx.dyn.currentDateTime), AtomicTypes.time),
    ],
  },
  {
    name: "fn:static-base-uri",
    params: [],
    result: "xs:anyURI?",
    impl: (_, call) =>
      Arr.fromOption(Option.map(call.statics.baseUri, (u) => AtomicValue.anyURI(u))),
  },
];

/** The core built-in functions. */
export const core: ReadonlyArray<BuiltinSpec> = [
  ...booleans,
  ...focus,
  ...sequences,
  ...strings,
  ...names,
  ...resources,
  ...errors,
  ...mapsAndArrays,
  ...context,
];
