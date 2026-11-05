/**
 * The built-in function registry: every library of built-ins, indexed by
 * expanded name and arity, with each signature parsed from its F&O 3.1
 * spelling the first time the registry is used.
 *
 * A new library (strings, numerics, dates, higher-order functions, …) is an
 * array of {@link BuiltinSpec}s added to {@link libraries}; nothing else
 * changes. A name the static context knows (`parser/builtins.ts`) but no
 * library implements yet compiles, and fails when it is called.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { Expr } from "../../parser/ast.ts";
import { Namespaces } from "../../parser/builtins.ts";
import { parseXPath } from "../../parser/parse.ts";
import { raise } from "../raise.ts";
import type { SeqType, Signature } from "../runtime.ts";
import { sequenceType, type Resolve } from "../seqtype.ts";
import { core } from "./core.ts";
import type { BuiltinSpec } from "./define.ts";
import { dates } from "./dates.ts";
import { numberFormatting } from "./format.ts";
import { dateFormatting } from "./formatDates.ts";
import { higherOrder } from "./higher.ts";
import { json } from "./json.ts";
import { numerics } from "./numerics.ts";
import { sequences } from "./sequences.ts";
import { strings } from "./strings.ts";

/** Every library of built-in functions. */
const libraries: ReadonlyArray<ReadonlyArray<BuiltinSpec>> = [
  core,
  strings,
  numerics,
  sequences,
  higherOrder,
  dates,
  json,
  numberFormatting,
  dateFormatting,
];

/** A built-in function, ready to call: its spec, its expanded name and its parsed signature. */
export interface Builtin {
  readonly spec: BuiltinSpec;
  readonly uri: string;
  readonly local: string;
  readonly signature: Signature;
}

/** The namespace of a standard prefix the signatures are written with. */
const prefixed = (prefix: string): string =>
  prefix === "fn"
    ? Namespaces.fn
    : prefix === "math"
      ? Namespaces.math
      : prefix === "map"
        ? Namespaces.map
        : prefix === "array"
          ? Namespaces.array
          : prefix === "xs"
            ? Namespaces.xs
            : "";

/** Resolves the standard prefixes the signatures are written with. */
const resolveStandard: Resolve = (name) => ({
  uri: Option.match(name.prefix, {
    onNone: () => Option.getOrElse(name.uri, () => ""),
    onSome: prefixed,
  }),
  local: name.local,
});

/** A sequence type as F&O writes it, parsed with the XPath grammar. */
const parseType = (text: string): SeqType => {
  const parsed = parseXPath(`() treat as ${text}`);
  if (Result.isSuccess(parsed) && Expr.$is("TreatAs")(parsed.success))
    return sequenceType(parsed.success.type, resolveStandard, text);
  return raise("XPST0003", `the built-in signature type ${text} does not parse`);
};

type Table = HashMap.HashMap<string, ReadonlyArray<Builtin>>;

const build = (): Table => {
  const types = HashMap.fromIterable(
    Arr.dedupe(libraries.flat().flatMap((spec) => Arr.append(spec.params, spec.result))).map(
      (text) => [text, parseType(text)] as const,
    ),
  );
  const typeOf = (text: string): SeqType =>
    Option.getOrElse(HashMap.get(types, text), () => parseType(text));
  return Arr.reduce(
    libraries.flat(),
    HashMap.empty<string, ReadonlyArray<Builtin>>(),
    (table, spec) => {
      const colon = spec.name.indexOf(":");
      const uri = prefixed(spec.name.slice(0, colon));
      const local = spec.name.slice(colon + 1);
      const key = `{${uri}}${local}`;
      const builtin: Builtin = {
        spec,
        uri,
        local,
        signature: { params: spec.params.map(typeOf), result: typeOf(spec.result) },
      };
      return HashMap.set(table, key, [
        ...Option.getOrElse(HashMap.get(table, key), () => []),
        builtin,
      ]);
    },
  );
};

let registry: Table | undefined;

/** The built-in function `{uri}local` of this arity, if a library implements it. */
export const lookupBuiltin = (
  uri: string,
  local: string,
  arity: number,
): Option.Option<Builtin> => {
  registry ??= build();
  const candidates = Option.getOrElse(HashMap.get(registry, `{${uri}}${local}`), () => []);
  return Option.fromUndefinedOr(
    candidates.find((b) =>
      b.spec.variadic === true ? arity >= b.spec.params.length : b.spec.params.length === arity,
    ),
  );
};

/** The parameter type of a built-in's `i`th argument (a variadic function's last type repeats). */
export const paramType = (b: Builtin, i: number): SeqType =>
  b.signature.params[Math.min(i, b.signature.params.length - 1)] ?? b.signature.result;
