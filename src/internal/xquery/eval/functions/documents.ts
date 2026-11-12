/**
 * Functions on documents and the environment (F&O 3.1 §14): `fn:parse-xml`
 * and `fn:parse-xml-fragment` (parsed by `XQuery.evaluate`, see
 * `parseXml.ts`), `fn:id`, `fn:element-with-id` and `fn:idref`, and
 * `fn:serialize` (see `serialize.ts`), and `fn:environment-variable` /
 * `fn:available-environment-variables`.
 *
 * Nodes carry no type annotations and DTD attribute types are not kept, so
 * the only IDs are `xml:id` attributes (whose element both `fn:id` and
 * `fn:element-with-id` return) and there are no IDREFs: `fn:idref` checks
 * its arguments and returns the empty sequence.
 */
import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import { isValidNCName } from "../../../../Name.ts";
import { AtomicValue } from "../../atomic.ts";
import { isNode, MapItem, stringValue, type Sequence } from "../../item.ts";
import type { XdmNode } from "../../node.ts";
import { Namespaces } from "../../parser/builtins.ts";
import { axisNodes } from "../axes.ts";
import { raise, unwrap } from "../raise.ts";
import { fetchResource } from "../runtime.ts";
import {
  defaults,
  paramsFromElement,
  paramsFromMap,
  serializeSequence,
  type Params,
} from "../serialize.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import { arg, contextNode, isEmpty, optionalNode, str, text } from "./values.ts";
import { maybe } from "../../../optional.ts";

/** `fn:parse-xml` or `fn:parse-xml-fragment`: the text parsed, at the static base URI. */
const parseXml =
  (kind: "xml" | "xml-fragment") =>
  (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
    if (isEmpty(arg(args, 0))) return [];
    const got = fetchResource(
      call.ctx.dyn,
      {
        kind,
        uri: text(arg(args, 0)),
        encoding: undefined,
        ...maybe("base", Option.getOrUndefined(call.statics.baseUri)),
      },
      call.offset,
    );
    return Predicate.isString(got) ? [] : got;
  };

/** The tokens of `fn:id`'s first argument: whitespace-separated NCNames (any other token matches nothing). */
const idTokens = (s: Sequence): HashSet.HashSet<string> =>
  HashSet.fromIterable(
    s
      .flatMap((item) => unwrap(stringValue(item)).split(/[ \t\r\n]+/))
      .filter((t) => t !== "" && isValidNCName(t)),
  );

/** The document node a node is in: `err:FODC0001` when its tree's root is not a document. */
const documentOf = (node: XdmNode, call: Call): XdmNode => {
  const root = node.root;
  return root.kind === "document"
    ? root
    : raise("FODC0001", "the node is not in a tree rooted at a document node", call.offset);
};

const xmlId = (element: XdmNode): string | undefined =>
  element.attributes
    .find((a) =>
      Option.match(a.name, {
        onNone: () => false,
        onSome: (q) => q.namespace === Namespaces.xml && q.local === "id",
      }),
    )
    ?.stringValue.trim()
    .replace(/[ \t\r\n]+/g, " ");

/** The elements of a document with one of the IDs, in document order, the first for each ID. */
const withIds = (ids: HashSet.HashSet<string>, root: XdmNode): Sequence =>
  Arr.reduce(
    axisNodes("descendant", root, (n) => n.kind === "element"),
    { seen: HashSet.empty<string>(), found: Arr.empty<XdmNode>() },
    (acc, e) => {
      const id = xmlId(e);
      return id === undefined || !HashSet.has(ids, id) || HashSet.has(acc.seen, id)
        ? acc
        : { seen: HashSet.add(acc.seen, id), found: Arr.append(acc.found, e) };
    },
  ).found;

/** `fn:id` and `fn:element-with-id`, at both arities. */
const byId = (name: string): ReadonlyArray<BuiltinSpec> => [
  {
    name,
    params: ["xs:string*"],
    result: "element()*",
    focus: true,
    impl: (args, call) => withIds(idTokens(arg(args, 0)), documentOf(contextNode(call), call)),
  },
  {
    name,
    params: ["xs:string*", "node()"],
    result: "element()*",
    impl: (args, call) => {
      const node = optionalNode(arg(args, 1));
      return node === undefined ? [] : withIds(idTokens(arg(args, 0)), documentOf(node, call));
    },
  },
];

/** `fn:serialize`'s parameters: the defaults, an options map, or an `output:serialization-parameters` element. */
const serializationParams = (s: Sequence, call: Call): Params => {
  const [p] = s;
  if (p === undefined) return defaults;
  if (p instanceof MapItem) return paramsFromMap(p, call.offset);
  if (isNode(p)) return paramsFromElement(p, call.offset);
  return raise("XPTY0004", "the serialization parameters are not a map or an element", call.offset);
};

/** The document and environment functions. */
export const documents: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:parse-xml",
    params: ["xs:string?"],
    result: "document-node(element(*))?",
    impl: parseXml("xml"),
  },
  {
    name: "fn:parse-xml-fragment",
    params: ["xs:string?"],
    result: "document-node()?",
    impl: parseXml("xml-fragment"),
  },
  ...byId("fn:id"),
  ...byId("fn:element-with-id"),
  {
    name: "fn:idref",
    params: ["xs:string*"],
    result: "node()*",
    focus: true,
    impl: (_, call) => {
      documentOf(contextNode(call), call);
      return [];
    },
  },
  {
    name: "fn:idref",
    params: ["xs:string*", "node()"],
    result: "node()*",
    impl: (args, call) => {
      const node = optionalNode(arg(args, 1));
      if (node !== undefined) documentOf(node, call);
      return [];
    },
  },
  {
    name: "fn:serialize",
    params: ["item()*"],
    result: "xs:string",
    impl: (args, call) => str(serializeSequence(arg(args, 0), defaults, call.offset)),
  },
  {
    name: "fn:serialize",
    params: ["item()*", "item()?"],
    result: "xs:string",
    impl: (args, call) =>
      str(serializeSequence(arg(args, 0), serializationParams(arg(args, 1), call), call.offset)),
  },
  {
    name: "fn:environment-variable",
    params: ["xs:string"],
    result: "xs:string?",
    impl: (args, call) => {
      const value = Record.get(call.ctx.dyn.environment, text(arg(args, 0)));
      return Option.isSome(value) ? str(value.value) : [];
    },
  },
  {
    name: "fn:available-environment-variables",
    params: [],
    result: "xs:string*",
    impl: (_, call) =>
      Record.keys(call.ctx.dyn.environment).map((name) => AtomicValue.string(name)),
  },
];
