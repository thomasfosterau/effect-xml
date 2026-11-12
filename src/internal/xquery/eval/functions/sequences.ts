/**
 * The functions on sequences (F&O 3.1 §14: `index-of`, `distinct-values`,
 * `insert-before`, `remove`, `unordered`, `deep-equal` with a collation,
 * `trace`), on nodes (§2, §13: `has-children`, `innermost`, `outermost`,
 * `path`, `generate-id`, `nilled`, `base-uri`, `document-uri`, `lang`), on
 * QNames and namespaces (§10: `resolve-QName`, the `*-from-QName`
 * accessors, `in-scope-prefixes`, `namespace-uri-for-prefix`), and
 * `resolve-uri` and `implicit-timezone`.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { isValidNCName, QName } from "../../../../Name.ts";
import { AtomicValue } from "../../atomic.ts";
import { isNode, type Sequence } from "../../item.ts";
import type { NodeKind, XdmNode } from "../../node.ts";
import { AtomicTypes } from "../../types.ts";
import { axisNodes, documentOrder } from "../axes.ts";
import { atomicDeepEqual, deepEqual, equalityBucket } from "../compare.ts";
import { raise } from "../raise.ts";
import { collate, collationArg, type Collation } from "./collation.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import {
  arg,
  atomOf,
  atomsOf,
  bool,
  contextNode,
  int,
  isEmpty,
  optionalAtom,
  ofNode,
  optionalNode,
  str,
  text,
} from "./values.ts";

const isQName = Schema.is(QName);

/** How strings compare under a collation, as the comparison helpers take it. */
const order =
  (c: Collation) =>
  (a: string, b: string): number =>
    collate(c, a, b);

// -----------------------------------------------------------------------------
// Sequences
// -----------------------------------------------------------------------------

const isNaNValue = (a: AtomicValue): boolean => P.isNumber(a.value) && Number.isNaN(a.value);

/** Whether two values are equal as `index-of` takes it: `eq`, with incomparable values unequal. */
const equalForIndex = (a: AtomicValue, b: AtomicValue, tz: number, c: Collation): boolean =>
  !isNaNValue(a) && !isNaNValue(b) && atomicDeepEqual(a, b, tz, order(c));

const indexOf = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const c = collationArg(args, 2, call);
  const target = atomOf(arg(args, 1));
  const tz = call.ctx.dyn.implicitTimezone;
  return atomsOf(arg(args, 0)).flatMap((a, i) =>
    equalForIndex(a, target, tz, c) ? int(i + 1) : [],
  );
};

const distinctValues = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const c = collationArg(args, 1, call);
  const tz = call.ctx.dyn.implicitTimezone;
  const strings = order(c);
  const [, kept] = Arr.mapAccum(
    atomsOf(arg(args, 0)),
    HashMap.empty<string, ReadonlyArray<AtomicValue>>(),
    (seen, a) => {
      const key = equalityBucket(a, c.fold);
      const bucket = Option.getOrElse(HashMap.get(seen, key), () => []);
      return bucket.some((b) => atomicDeepEqual(a, b, tz, strings))
        ? [seen, []]
        : [HashMap.set(seen, key, [...bucket, a]), [a]];
    },
  );
  return kept.flat();
};

const position = (s: Sequence): number => Number(atomOf(s).value);

const sequenceFunctions: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:index-of",
    params: ["xs:anyAtomicType*", "xs:anyAtomicType"],
    result: "xs:integer*",
    impl: indexOf,
  },
  {
    name: "fn:index-of",
    params: ["xs:anyAtomicType*", "xs:anyAtomicType", "xs:string"],
    result: "xs:integer*",
    impl: indexOf,
  },
  {
    name: "fn:distinct-values",
    params: ["xs:anyAtomicType*"],
    result: "xs:anyAtomicType*",
    impl: distinctValues,
  },
  {
    name: "fn:distinct-values",
    params: ["xs:anyAtomicType*", "xs:string"],
    result: "xs:anyAtomicType*",
    impl: distinctValues,
  },
  {
    name: "fn:insert-before",
    params: ["item()*", "xs:integer", "item()*"],
    result: "item()*",
    impl: (args) => {
      const s = arg(args, 0);
      const at = Math.min(Math.max(position(arg(args, 1)), 1), s.length + 1) - 1;
      return [...s.slice(0, at), ...arg(args, 2), ...s.slice(at)];
    },
  },
  {
    name: "fn:remove",
    params: ["item()*", "xs:integer"],
    result: "item()*",
    impl: (args) => {
      const at = position(arg(args, 1));
      return arg(args, 0).filter((_, i) => i + 1 !== at);
    },
  },
  {
    name: "fn:unordered",
    params: ["item()*"],
    result: "item()*",
    impl: (args) => arg(args, 0),
  },
  {
    name: "fn:deep-equal",
    params: ["item()*", "item()*", "xs:string"],
    result: "xs:boolean",
    impl: (args, call) =>
      bool(
        deepEqual(
          arg(args, 0),
          arg(args, 1),
          call.ctx.dyn.implicitTimezone,
          order(collationArg(args, 2, call)),
        ),
      ),
  },
  {
    name: "fn:trace",
    params: ["item()*"],
    result: "item()*",
    impl: (args) => arg(args, 0),
  },
  {
    name: "fn:trace",
    params: ["item()*", "xs:string"],
    result: "item()*",
    impl: (args) => arg(args, 0),
  },
];

// -----------------------------------------------------------------------------
// Nodes
// -----------------------------------------------------------------------------

/** A function of a node, also defined with no argument (the context node): the empty sequence for `()`. */
const ofPresentNode = (
  name: string,
  result: string,
  f: (node: XdmNode, call: Call) => Sequence,
): ReadonlyArray<BuiltinSpec> =>
  ofNode(name, result, (n, call) => (n === undefined ? [] : f(n, call)));

const nodesOf = (s: Sequence): Array<XdmNode> => s.filter(isNode);

/** The ancestors of a node, nearest first. */
const ancestors = (n: XdmNode): ReadonlyArray<XdmNode> => axisNodes("ancestor", n, () => true);

const innermost = (s: Sequence): Sequence => {
  const nodes = documentOrder(nodesOf(s));
  const containing = HashSet.fromIterable(
    nodes.flatMap((n) => ancestors(n).map((a) => a.identity)),
  );
  return nodes.filter((n) => !HashSet.has(containing, n.identity));
};

const outermost = (s: Sequence): Sequence => {
  const nodes = documentOrder(nodesOf(s));
  const present = HashSet.fromIterable(nodes.map((n) => n.identity));
  return nodes.filter((n) => !ancestors(n).some((a) => HashSet.has(present, a.identity)));
};

const fnNamespace = "http://www.w3.org/2005/xpath-functions";

const eqName = (q: QName): string => `Q{${q.namespace ?? ""}}${q.local}`;

/** Whether two nodes have the same kind and name, as `fn:path` counts siblings. */
const sameKindAndName = (a: XdmNode, b: XdmNode): boolean =>
  a.kind === b.kind &&
  Option.makeEquivalence(
    (x: QName, y: QName) => x.namespace === y.namespace && x.local === y.local,
  )(a.name, b.name);

/** How each kind of node is written as a step of `fn:path`, given its name and its position among its like siblings. */
const pathSteps: Readonly<Record<NodeKind, (name: QName | undefined, nth: number) => string>> = {
  element: (name, nth) => `${name === undefined ? "" : eqName(name)}[${nth}]`,
  attribute: (name) =>
    name === undefined ? "@" : name.namespace === null ? `@${name.local}` : `@${eqName(name)}`,
  text: (_, nth) => `text()[${nth}]`,
  comment: (_, nth) => `comment()[${nth}]`,
  "processing-instruction": (name, nth) => `processing-instruction(${name?.local ?? ""})[${nth}]`,
  namespace: (name) =>
    name === undefined
      ? `namespace::*[Q{${fnNamespace}}local-name()=""]`
      : `namespace::${name.local}`,
  document: () => "",
};

/** A node's step in its `fn:path`. */
const pathStep = (n: XdmNode): string => {
  const siblings = Option.match(n.parent, { onNone: () => [n], onSome: (p) => p.children });
  const here = siblings.indexOf(n);
  const nth = siblings.filter((s, i) => i <= here && sameKindAndName(s, n)).length;
  return pathSteps[n.kind](Option.getOrUndefined(n.name), nth);
};

/** `fn:path`: the path from the root, `Q{…}root()` first when the root is not a document. */
const path = (n: XdmNode): string => {
  const chain = ancestors(n).toReversed();
  const [root] = chain;
  const top = root ?? n;
  if (top === n) return n.kind === "document" ? "/" : `Q{${fnNamespace}}root()`;
  const steps = [...chain.slice(1), n].map(pathStep).join("/");
  return top.kind === "document" ? `/${steps}` : `Q{${fnNamespace}}root()/${steps}`;
};

const anyURI = (o: Option.Option<string>): Sequence =>
  Arr.fromOption(Option.map(o, (u) => AtomicValue.anyURI(u)));

const lang = (testlang: string, n: XdmNode): Sequence =>
  bool(
    Option.match(n.lang, {
      onNone: () => false,
      onSome: (l) => {
        const [x, y] = [l.toLowerCase(), testlang.toLowerCase()];
        return x === y || x.startsWith(`${y}-`);
      },
    }),
  );

const nodeFunctions: ReadonlyArray<BuiltinSpec> = [
  ...ofPresentNode("fn:has-children", "xs:boolean", (n) =>
    bool(Arr.isReadonlyArrayNonEmpty(n.children)),
  ),
  {
    name: "fn:innermost",
    params: ["node()*"],
    result: "node()*",
    impl: (args) => innermost(arg(args, 0)),
  },
  {
    name: "fn:outermost",
    params: ["node()*"],
    result: "node()*",
    impl: (args) => outermost(arg(args, 0)),
  },
  ...ofPresentNode("fn:path", "xs:string?", (n) => str(path(n))),
  ...ofPresentNode("fn:generate-id", "xs:string", (n) => str(n.identity)),
  ...ofPresentNode("fn:nilled", "xs:boolean?", (n) => (n.kind === "element" ? bool(false) : [])),
  ...ofPresentNode("fn:base-uri", "xs:anyURI?", (n) => anyURI(n.baseUri)),
  ...ofPresentNode("fn:document-uri", "xs:anyURI?", (n) => anyURI(n.documentUri)),
  {
    name: "fn:lang",
    params: ["xs:string?"],
    result: "xs:boolean",
    focus: true,
    impl: (args, call) => lang(text(arg(args, 0)), contextNode(call)),
  },
  {
    name: "fn:lang",
    params: ["xs:string?", "node()"],
    result: "xs:boolean",
    impl: (args) => {
      const n = optionalNode(arg(args, 1));
      return n === undefined ? bool(false) : lang(text(arg(args, 0)), n);
    },
  },
];

// The `(): Sequence` for `fn:generate-id` and `fn:path` on an empty argument is
// `""` and `()`; `ofNode` returns `()` for both, so generate-id is redefined.
const generateIdEmpty: BuiltinSpec = {
  name: "fn:generate-id",
  params: ["node()?"],
  result: "xs:string",
  impl: (args) => {
    const n = optionalNode(arg(args, 0));
    return str(n === undefined ? "" : n.identity);
  },
};

// -----------------------------------------------------------------------------
// QNames and namespaces
// -----------------------------------------------------------------------------

const qnameArg = (s: Sequence): QName | undefined => {
  const a = optionalAtom(s);
  return a !== undefined && isQName(a.value) ? a.value : undefined;
};

/** The namespace bindings in scope on an element, by prefix (`""` for the default namespace). */
const inScope = (element: XdmNode): ReadonlyArray<readonly [string, string]> =>
  element.namespaces.map((ns) => [
    Option.match(ns.name, { onNone: () => "", onSome: (q) => q.local }),
    ns.stringValue,
  ]);

const resolveQName = (lexical: string, element: XdmNode, call: Call): Sequence => {
  const colon = lexical.indexOf(":");
  const prefix = colon < 0 ? "" : lexical.slice(0, colon);
  const local = lexical.slice(colon + 1);
  if (!isValidNCName(local) || (colon >= 0 && !isValidNCName(prefix)))
    return raise("FOCA0002", `${lexical} is not a lexical QName`, call.offset);
  const uri = inScope(element).find(([p]) => p === prefix)?.[1];
  if (uri === undefined && prefix !== "")
    return raise("FONS0004", `the prefix ${prefix} is not in scope`, call.offset);
  return [
    AtomicValue.qname(
      new QName({
        prefix: prefix === "" ? null : prefix,
        local,
        namespace: uri === undefined || uri === "" ? null : uri,
      }),
    ),
  ];
};

const qnameFunctions: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:resolve-QName",
    params: ["xs:string?", "element()"],
    result: "xs:QName?",
    impl: (args, call) => {
      const element = optionalNode(arg(args, 1));
      return isEmpty(arg(args, 0)) || element === undefined
        ? []
        : resolveQName(text(arg(args, 0)), element, call);
    },
  },
  {
    name: "fn:prefix-from-QName",
    params: ["xs:QName?"],
    result: "xs:NCName?",
    impl: (args) => {
      const q = qnameArg(arg(args, 0));
      return q === undefined || q.prefix === null
        ? []
        : [new AtomicValue(AtomicTypes.NCName, q.prefix)];
    },
  },
  {
    name: "fn:local-name-from-QName",
    params: ["xs:QName?"],
    result: "xs:NCName?",
    impl: (args) => {
      const q = qnameArg(arg(args, 0));
      return q === undefined ? [] : [new AtomicValue(AtomicTypes.NCName, q.local)];
    },
  },
  {
    name: "fn:namespace-uri-from-QName",
    params: ["xs:QName?"],
    result: "xs:anyURI?",
    impl: (args) => {
      const q = qnameArg(arg(args, 0));
      return q === undefined ? [] : [AtomicValue.anyURI(q.namespace ?? "")];
    },
  },
  {
    name: "fn:in-scope-prefixes",
    params: ["element()"],
    result: "xs:string*",
    impl: (args) => {
      const element = optionalNode(arg(args, 0));
      return element === undefined ? [] : inScope(element).map(([p]) => AtomicValue.string(p));
    },
  },
  {
    name: "fn:namespace-uri-for-prefix",
    params: ["xs:string?", "element()"],
    result: "xs:anyURI?",
    impl: (args) => {
      const element = optionalNode(arg(args, 1));
      const prefix = text(arg(args, 0));
      const uri =
        element === undefined ? undefined : inScope(element).find(([p]) => p === prefix)?.[1];
      return uri === undefined || uri === "" ? [] : [AtomicValue.anyURI(uri)];
    },
  },
];

// -----------------------------------------------------------------------------
// URIs and the implicit timezone
// -----------------------------------------------------------------------------

/** Whether a string is an absolute URI: it has a scheme. */
const isAbsolute = (uri: string): boolean => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(uri);

const resolveUri = (relative: string, base: string | undefined, call: Call): Sequence => {
  if (/[\s<>"{}|\\^`]/.test(relative.trim()) || relative.includes("%%"))
    return raise("FORG0002", `${relative} is not a valid URI reference`, call.offset);
  if (isAbsolute(relative)) return [AtomicValue.anyURI(relative)];
  if (base === undefined)
    return raise("FONS0005", "there is no base URI to resolve against", call.offset);
  if (!isAbsolute(base) || base.includes("#"))
    return raise("FORG0002", `${base} is not an absolute URI`, call.offset);
  const resolved = URL.parse(relative, base);
  return resolved === null
    ? raise("FORG0002", `${relative} cannot be resolved against ${base}`, call.offset)
    : [AtomicValue.anyURI(resolved.href)];
};

const uriFunctions: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:resolve-uri",
    params: ["xs:string?"],
    result: "xs:anyURI?",
    impl: (args, call) =>
      isEmpty(arg(args, 0))
        ? []
        : resolveUri(text(arg(args, 0)), Option.getOrUndefined(call.statics.baseUri), call),
  },
  {
    name: "fn:resolve-uri",
    params: ["xs:string?", "xs:string"],
    result: "xs:anyURI?",
    impl: (args, call) =>
      isEmpty(arg(args, 0)) ? [] : resolveUri(text(arg(args, 0)), text(arg(args, 1)), call),
  },
  {
    name: "fn:implicit-timezone",
    params: [],
    result: "xs:dayTimeDuration",
    impl: (_, call) => {
      const minutes = call.ctx.dyn.implicitTimezone;
      const abs = Math.abs(minutes);
      const h = Math.floor(abs / 60);
      const m = abs % 60;
      const lexical = `${minutes < 0 ? "-" : ""}PT${h}H${m}M`;
      return [new AtomicValue(AtomicTypes.dayTimeDuration, lexical)];
    },
  },
];

/** The default language of the dynamic context (F&O 3.1 §16.2.5). */
const defaultLanguage: BuiltinSpec = {
  name: "fn:default-language",
  params: [],
  result: "xs:language",
  impl: (_, call) => [new AtomicValue(AtomicTypes.language, call.ctx.dyn.defaultLanguage)],
};

/** The sequence, node, QName and URI functions. */
export const sequences: ReadonlyArray<BuiltinSpec> = [
  ...sequenceFunctions,
  ...nodeFunctions.filter((b) => !(b.name === "fn:generate-id" && b.params.length === 1)),
  generateIdEmpty,
  defaultLanguage,
  ...qnameFunctions,
  ...uriFunctions,
];
