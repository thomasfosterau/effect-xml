/**
 * Library modules (XQuery 3.1 §4.12, §5): loading what `import module`
 * names from the host's module sources, analysing each library module once,
 * and collecting what each makes visible to the modules that import it.
 *
 * Modules may import each other in cycles: a module already being loaded is
 * not loaded again, and an import of it from inside the cycle sees its
 * namespace as opaque (its names are not checked statically; the evaluator
 * resolves them across every loaded module).
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import type { Module as ModuleT } from "./ast.ts";
import { Decl, Module } from "./ast.ts";
import {
  normalizeUri,
  type ModuleExports,
  type StaticContext,
  type StaticOptions,
} from "./context.ts";
import type { StaticError } from "./errors.ts";
import { parseXQuery } from "./parse.ts";
import { analyzeModule, exportsOf } from "./prolog-check.ts";
import { maybe } from "../../optional.ts";

/** A library module, analysed: its tree, target namespace and static context. */
export interface LibraryModule {
  readonly uri: string;
  readonly module: Extract<ModuleT, { readonly _tag: "Library" }>;
  readonly context: StaticContext;
}

/** An `import module` the host gave no sources for: its namespace and location hints. */
export interface UnresolvedImport {
  readonly uri: string;
  readonly at: ReadonlyArray<string>;
}

/** The module imports of a module's prolog. */
export const importsOf = (module: ModuleT): ReadonlyArray<UnresolvedImport & { offset: number }> =>
  Module.$match(module, { Main: (m) => m.prolog, Library: (l) => l.prolog }).flatMap((d) =>
    Decl.$is("ModuleImport")(d) && d.uri !== ""
      ? [{ uri: normalizeUri(d.uri), at: d.at, offset: d.offset }]
      : [],
  );

/** One compilation's modules: each target namespace's analysed modules, or `loading` while in a cycle. */
interface Loaded {
  modules: HashMap.HashMap<string, ReadonlyArray<LibraryModule> | "loading">;
}

const mergeExports = (modules: ReadonlyArray<LibraryModule>): ModuleExports => {
  const all = modules.map((m) => exportsOf(m.module, m.context));
  return {
    functions: all.flatMap((e) => e.functions),
    variables: all.flatMap((e) => e.variables),
  };
};

/** One source's module, analysed; `undefined` for a source that is not a library module of the namespace. */
type Loading = Result.Result<LibraryModule | undefined, StaticError>;

const none: Result.Result<
  HashMap.HashMap<string, ModuleExports>,
  StaticError
> = /*#__PURE__*/ Result.succeed(HashMap.empty());

/** Load, parse and analyse every module `module` imports, and what each import makes visible. */
const load = (
  module: ModuleT,
  options: StaticOptions | undefined,
  loaded: Loaded,
): Result.Result<HashMap.HashMap<string, ModuleExports>, StaticError> => {
  const sources = options?.modules;
  return Arr.reduce(importsOf(module), none, (acc, imp) =>
    Result.flatMap(acc, (visible) => {
      const known = Option.getOrUndefined(HashMap.get(loaded.modules, imp.uri));
      if (known === "loading") return Result.succeed(visible);
      if (known !== undefined)
        return Result.succeed(HashMap.set(visible, imp.uri, mergeExports(known)));
      if (sources === undefined) return Result.succeed(visible);
      // A namespace with no module is left out: analysing the import reports `XQST0059`,
      // in its turn among the prolog's errors.
      const found = sources[imp.uri];
      if (found === undefined || Arr.isReadonlyArrayEmpty(found)) return Result.succeed(visible);
      loaded.modules = HashMap.set(loaded.modules, imp.uri, "loading");
      const libraries = Result.all(
        found.map((source) =>
          Result.flatMap(parseXQuery(source.text), (parsed): Loading => {
            // A library module without a namespace is analysed, to report `XQST0088`.
            if (
              !Module.$is("Library")(parsed) ||
              (parsed.uri !== "" && normalizeUri(parsed.uri) !== imp.uri)
            )
              return Result.succeed(undefined);
            const base: StaticOptions = {
              ...options,
              ...maybe("baseUri", source.location ?? options?.baseUri),
            };
            return Result.flatMap(load(parsed, base, loaded), (exports) => {
              // Imports of modules still loading (a cycle) are opaque to this one.
              const cyclic = importsOf(parsed)
                .map((i) => i.uri)
                .filter((u) => Option.contains(HashMap.get(loaded.modules, u), "loading" as const));
              const own: StaticOptions = {
                ...base,
                opaqueNamespaces: [...(base.opaqueNamespaces ?? []), ...cyclic],
              };
              return Result.map(
                analyzeModule(parsed, own, exports),
                ({ context }): LibraryModule => ({ uri: imp.uri, module: parsed, context }),
              );
            });
          }),
        ),
      );
      return Result.map(libraries, (all) => {
        const ms = all.filter(P.isNotUndefined);
        loaded.modules = HashMap.set(loaded.modules, imp.uri, ms);
        return Arr.isReadonlyArrayEmpty(ms)
          ? visible
          : HashMap.set(visible, imp.uri, mergeExports(ms));
      });
    }),
  );
};

/** A main module's imports, loaded: what they make visible, every library module loaded, and the imports left unresolved. */
export interface Imports {
  readonly visible: HashMap.HashMap<string, ModuleExports>;
  readonly libraries: ReadonlyArray<LibraryModule>;
  readonly unresolved: ReadonlyArray<UnresolvedImport>;
}

/** Load a main module's imports (transitively) from the host's module sources. */
export const loadImports = (
  module: ModuleT,
  options: StaticOptions | undefined,
): Result.Result<Imports, StaticError> => {
  const loaded: Loaded = { modules: HashMap.empty() };
  return Result.map(load(module, options, loaded), (visible) => ({
    visible,
    libraries: Array.from(HashMap.values(loaded.modules)).flatMap((v) =>
      v === "loading" ? [] : v,
    ),
    unresolved:
      options?.modules === undefined ? importsOf(module).map(({ uri, at }) => ({ uri, at })) : [],
  }));
};
