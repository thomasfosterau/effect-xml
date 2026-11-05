/**
 * Small helpers the libraries of built-in functions share: building result
 * sequences and reading arguments that the function conversion rules have
 * already converted to their declared types.
 */
import * as Arr from "effect/Array";
import { isValidNCName } from "../../../../Name.ts";
import { AtomicValue } from "../../atomic.ts";
import { ArrayItem, isNode, MapItem, stringValue, type Item, type Sequence } from "../../item.ts";
import type { XdmNode } from "../../node.ts";
import { raise, unwrap } from "../raise.ts";
import { contextItem } from "../runtime.ts";
import type { BuiltinSpec, Call } from "./define.ts";

/** A single `xs:boolean`. */
export const bool = (b: boolean): Sequence => [AtomicValue.boolean(b)];

/** A single `xs:integer`. */
export const int = (n: number | bigint): Sequence => [AtomicValue.integer(BigInt(n))];

/** A single `xs:string`. */
export const str = (s: string): Sequence => [AtomicValue.string(s)];

/** The `i`th argument (the empty sequence past the last). */
export const arg = (args: ReadonlyArray<Sequence>, i: number): Sequence => args[i] ?? [];

/** Whether an argument is the empty sequence. */
export const isEmpty = (s: Sequence): boolean => Arr.isReadonlyArrayEmpty(s);

/** The string an optional `xs:string?` argument stands for: `""` when it is empty. */
export const text = (s: Sequence | undefined): string => {
  const [first] = s ?? [];
  return first === undefined ? "" : unwrap(stringValue(first));
};

/** The characters (code points, not UTF-16 units) of a string. */
export const chars = (s: string): ReadonlyArray<string> => Arr.fromIterable(s);

/** The one item of a converted argument, as its declared type guarantees it is. */
const only = <A>(s: Sequence, guard: (item: Item) => item is Item & A): A => {
  const [item] = s;
  return item !== undefined && guard(item)
    ? item
    : raise("XPTY0004", "an argument does not have its declared type");
};

/** The map of a `map(*)` argument. */
export const mapOf = (s: Sequence): MapItem => only(s, (i): i is MapItem => i instanceof MapItem);

/** The array of an `array(*)` argument. */
export const arrayOf = (s: Sequence): ArrayItem =>
  only(s, (i): i is ArrayItem => i instanceof ArrayItem);

/** The atomic value of a single atomic argument. */
export const atomOf = (s: Sequence): AtomicValue =>
  only(s, (i): i is AtomicValue => i instanceof AtomicValue);

/** The atomic value of an optional atomic argument. */
export const optionalAtom = (s: Sequence): AtomicValue | undefined => {
  const [a] = s;
  return a instanceof AtomicValue ? a : undefined;
};

/** The atomic values of an atomic sequence argument. */
export const atomsOf = (s: Sequence): ReadonlyArray<AtomicValue> =>
  s.filter((i): i is AtomicValue => i instanceof AtomicValue);

/** The context item, which must be a node: `err:XPTY0004` otherwise. */
export const contextNode = (call: Call): XdmNode => {
  const item = contextItem(call.ctx, call.offset);
  return isNode(item) ? item : raise("XPTY0004", "the context item is not a node", call.offset);
};

/** The node of an optional `node()?` argument. */
export const optionalNode = (s: Sequence): XdmNode | undefined => {
  const [n] = s;
  return n !== undefined && isNode(n) ? n : undefined;
};

/**
 * The Clark name (`{uri}local`) an EQName string stands for: `local` (in no
 * namespace), `prefix:local` with the prefix statically known, or
 * `Q{uri}local`, after trimming whitespace; `undefined` when it is none of
 * these or its prefix is unbound.
 */
export const clarkOfEQName = (s: string, call: Call): string | undefined => {
  const trimmed = s.trim();
  const braced = /^Q\{([^{}]*)\}(.*)$/.exec(trimmed);
  if (braced !== null) {
    const [, uri = "", local = ""] = braced;
    return isValidNCName(local) ? `{${uri.trim()}}${local}` : undefined;
  }
  const colon = trimmed.indexOf(":");
  const local = trimmed.slice(colon + 1);
  if (!isValidNCName(local)) return undefined;
  if (colon < 0) return `{}${local}`;
  const prefix = trimmed.slice(0, colon);
  const uri = isValidNCName(prefix) ? call.statics.namespace(prefix) : undefined;
  return uri === undefined ? undefined : `{${uri}}${local}`;
};

/**
 * A function of an optional node, also defined with no argument (the
 * context node, `err:XPTY0004` when it is not a node): `fn:name`,
 * `fn:root`, `fn:path` and the like.
 */
export const ofNode = (
  name: string,
  result: string,
  f: (node: XdmNode | undefined, call: Call) => Sequence,
): ReadonlyArray<BuiltinSpec> => [
  { name, params: [], result, focus: true, impl: (_, call) => f(contextNode(call), call) },
  { name, params: ["node()?"], result, impl: (args, call) => f(optionalNode(arg(args, 0)), call) },
];
