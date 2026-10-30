/**
 * The static context (XQuery 3.1 §2.1.1, Appendix C.1): what a query is
 * compiled against, from the host's options and the query's prolog.
 *
 * In-scope namespaces start with the predeclared prefixes (`xml`, `xs`,
 * `xsi`, `fn`, `math`, `map`, `array`, `err`, and `local` in XQuery); the
 * host may add or rebind any of them but `xml`, and the prolog may add more.
 * In-scope variables and function signatures are keyed by Clark name
 * (`{uri}local`).
 */
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type { Arity } from "./builtins.ts";
import { Namespaces } from "./builtins.ts";
import type { ItemType } from "./ast.ts";

/** The host's part of the static context: what a caller may set before compiling. */
export interface StaticOptions {
  /** Prefix → namespace URI bindings, added to (and overriding) the predeclared ones. */
  readonly namespaces?: Readonly<Record<string, string>> | undefined;
  /** The default namespace of element and type names (default: none). */
  readonly defaultElementNamespace?: string | undefined;
  /** The default namespace of function names (default: `fn`). */
  readonly defaultFunctionNamespace?: string | undefined;
  /** External variables in scope, as Clark names (`{uri}local`, or `local` for no namespace). */
  readonly variables?: ReadonlyArray<string> | undefined;
  /** Functions the host provides, beyond the built-in library: Clark name → arities. */
  readonly functions?: Readonly<Record<string, ReadonlyArray<number>>> | undefined;
  /** Collation URIs the host supports, beyond the codepoint, HTML case-insensitive and UCA collations. */
  readonly collations?: ReadonlyArray<string> | undefined;
  /** The static base URI. */
  readonly baseUri?: string | undefined;
  /**
   * Namespaces whose functions, variables and types the analysis cannot see
   * and so does not check: schemas and modules the host imports on the
   * query's behalf.
   */
  readonly opaqueNamespaces?: ReadonlyArray<string> | undefined;
}

/** The static context a query is compiled in. */
export interface StaticContext {
  readonly xquery: boolean;
  /** Statically known namespaces: prefix → URI. */
  readonly namespaces: HashMap.HashMap<string, string>;
  /** `""` when element and type names are in no namespace by default. */
  readonly defaultElementNamespace: string;
  readonly defaultFunctionNamespace: string;
  /** In-scope variables (the host's and the prolog's), by Clark name. */
  readonly variables: HashSet.HashSet<string>;
  /** Function signatures beyond the built-in library (the host's and the prolog's), by Clark name. */
  readonly functions: HashMap.HashMap<string, ReadonlyArray<Arity>>;
  /** Namespaces of imported modules and schemas: names in them are not checked. */
  readonly opaqueNamespaces: HashSet.HashSet<string>;
  readonly baseUri: Option.Option<string>;
  readonly defaultCollation: string;
  /** Statically known collations beyond the built-in ones. */
  readonly collations: HashSet.HashSet<string>;
  readonly boundarySpace: "preserve" | "strip";
  readonly construction: "preserve" | "strip";
  readonly ordering: "ordered" | "unordered";
  readonly emptyOrder: "greatest" | "least";
  readonly copyNamespaces: { readonly preserve: boolean; readonly inherit: boolean };
  /** The context item's static type, from `declare context item as …`. */
  readonly contextItemType: Option.Option<ItemType>;
  /** `declare option` values, by Clark name. */
  readonly options: HashMap.HashMap<string, string>;
}

/** The Unicode codepoint collation, the default collation. */
export const codepointCollation = "http://www.w3.org/2005/xpath-functions/collation/codepoint";

/** The prefixes every query starts with. */
const predeclared = (xquery: boolean): ReadonlyArray<readonly [string, string]> => [
  ["xml", Namespaces.xml],
  ["xs", Namespaces.xs],
  ["xsi", Namespaces.xsi],
  ["fn", Namespaces.fn],
  ["math", Namespaces.math],
  ["map", Namespaces.map],
  ["array", Namespaces.array],
  ["err", Namespaces.err],
  ...(xquery ? [["local", Namespaces.local] as const] : []),
];

const toArities = (ns: ReadonlyArray<number>): ReadonlyArray<Arity> =>
  ns.map((n) => ({ min: n, max: n }));

/** The static context before the prolog: the predeclared namespaces and the host's options. */
export const initialContext = (xquery: boolean, options: StaticOptions = {}): StaticContext => ({
  xquery,
  namespaces: HashMap.fromIterable([
    ...predeclared(xquery),
    ...Record.toEntries(options.namespaces ?? {}).filter(([prefix]) => prefix !== "xml"),
  ]),
  defaultElementNamespace: options.defaultElementNamespace ?? "",
  defaultFunctionNamespace: options.defaultFunctionNamespace ?? Namespaces.fn,
  variables: HashSet.fromIterable(
    (options.variables ?? []).map((v) => (v.startsWith("{") ? v : `{}${v}`)),
  ),
  functions: HashMap.fromIterable(
    Record.toEntries(options.functions ?? {}).map(([k, v]) => [k, toArities(v)] as const),
  ),
  opaqueNamespaces: HashSet.fromIterable(options.opaqueNamespaces ?? []),
  baseUri: Option.fromNullishOr(options.baseUri),
  defaultCollation: codepointCollation,
  collations: HashSet.fromIterable(options.collations ?? []),
  boundarySpace: "strip",
  construction: "preserve",
  ordering: "ordered",
  emptyOrder: "least",
  copyNamespaces: { preserve: true, inherit: true },
  contextItemType: Option.none(),
  options: HashMap.empty(),
});
