/**
 * The prolog's half of static analysis: folding the declarations into the
 * static context, with the errors a prolog can have on its own (duplicate
 * setters and declarations, reserved namespaces and prefixes, library
 * module rules, decimal formats, options), then checking the initializers,
 * function bodies and query body against that context.
 *
 * Scoping follows XQuery 3.1 §4.16 and §4.18: a variable's initializer sees
 * the variables declared before it; function bodies and the query body see
 * every variable in the prolog, and every declared function.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type {
  Annotation,
  Decl as DeclT,
  EQName,
  Expr,
  Module as ModuleT,
  VersionDecl,
} from "./ast.ts";
import { Decl, Module } from "./ast.ts";
import type { Errors, ExpandedName, Scope } from "./analyze.ts";
import {
  annotationErrors,
  annotationName,
  bind,
  collationErrors,
  isVisibility,
  expr,
  itemType,
  keyOf,
  nameErrors,
  none,
  optionalExpr,
  optionalType,
  params,
  reservedNamespaces,
  resolveName,
  scopeOf,
  show,
} from "./analyze.ts";
import type { Arity } from "./builtins.ts";
import { Namespaces } from "./builtins.ts";
import type { StaticContext, StaticOptions } from "./context.ts";
import { initialContext } from "./context.ts";
import type { StaticError } from "./errors.ts";
import { staticError } from "./errors.ts";

/** The namespace of unprefixed option names (XQuery 3.1 §4.19). */
const queryOptions = "http://www.w3.org/2012/xquery";

/** The serialization parameters an `output:` option may set in a prolog (XQuery 3.1 §2.2.4). */
const serializationParameters: ReadonlyArray<string> = [
  "allow-duplicate-names",
  "byte-order-mark",
  "cdata-section-elements",
  "doctype-public",
  "doctype-system",
  "encoding",
  "escape-uri-attributes",
  "html-version",
  "include-content-type",
  "indent",
  "item-separator",
  "json-node-output-method",
  "media-type",
  "method",
  "normalization-form",
  "omit-xml-declaration",
  "standalone",
  "suppress-indentation",
  "undeclare-prefixes",
  "version",
  "parameter-document",
];

/** The decimal-format properties that are single characters, and their defaults. */
const pictureCharacters: ReadonlyArray<readonly [string, string]> = [
  ["decimal-separator", "."],
  ["grouping-separator", ","],
  ["percent", "%"],
  ["per-mille", "‰"],
  ["zero-digit", "0"],
  ["digit", "#"],
  ["pattern-separator", ";"],
  ["exponent-separator", "e"],
];

/** What folding the prolog's declarations builds. */
interface Fold {
  readonly errors: Errors;
  readonly context: StaticContext;
  /** Keys of what has been declared once already: setters, prefixes, names. */
  readonly seen: HashSet.HashSet<string>;
  /** The prolog's variables, in order, with their resolved names. */
  readonly variables: ReadonlyArray<readonly [ExpandedName, DeclT]>;
}

const fail = (code: string, description: string, offset: number): Errors => [
  staticError(code, description, offset),
];

const resolved = (scope: Scope, name: EQName, kind: "function" | "variable" | "other") =>
  Result.getOrUndefined(resolveName(scope, name, kind));

/** Record `key` as seen, or report `code` if it was. */
const once = (fold: Fold, key: string, code: string, what: string, offset: number): Fold =>
  HashSet.has(fold.seen, key)
    ? {
        ...fold,
        errors: [...fold.errors, ...fail(code, `${what} is declared more than once`, offset)],
      }
    : { ...fold, seen: HashSet.add(fold.seen, key) };

const withErrors = (fold: Fold, errors: Errors): Fold => ({
  ...fold,
  errors: [...fold.errors, ...errors],
});

const withContext = (fold: Fold, f: (c: StaticContext) => StaticContext): Fold => ({
  ...fold,
  context: f(fold.context),
});

/** `XQST0070`: `xml` and `xmlns` can't be declared, and their URIs can't be bound to other prefixes. */
const prefixErrors = (prefix: string, uri: string, offset: number): Errors =>
  prefix === "xml" || prefix === "xmlns"
    ? fail("XQST0070", `the prefix "${prefix}" can't be declared`, offset)
    : uri === Namespaces.xml || uri === Namespaces.xmlns
      ? fail("XQST0070", `"${uri}" can't be bound to a prefix`, offset)
      : none;

/** Bind a prefix declared in the prolog (`XQST0033` if the prolog binds it twice). */
const declarePrefix = (fold: Fold, prefix: string, uri: string, offset: number): Fold => {
  const checked = withErrors(fold, prefixErrors(prefix, uri, offset));
  return withContext(
    once(checked, `prefix:${prefix}`, "XQST0033", `the prefix "${prefix}"`, offset),
    (c) => ({
      ...c,
      namespaces:
        uri === "" ? HashMap.remove(c.namespaces, prefix) : HashMap.set(c.namespaces, prefix, uri),
    }),
  );
};

const opaque = (fold: Fold, uri: string): Fold =>
  withContext(fold, (c) => ({ ...c, opaqueNamespaces: HashSet.add(c.opaqueNamespaces, uri) }));

const isDigit = (cp: number): boolean => /^\p{Nd}$/u.test(String.fromCodePoint(cp));

/**
 * Whether `c` is a digit with the value zero. Unicode's decimal digits come
 * in runs of ten starting at zero, so a digit is a zero when the character
 * before it is not a digit, except in the run of mathematical digits.
 */
const isZeroDigit = (c: string): boolean => {
  const cp = c.codePointAt(0) ?? 0;
  return (
    isDigit(cp) &&
    (!isDigit(cp - 1) || (cp >= 0x1d7ce && cp <= 0x1d7ff && (cp - 0x1d7ce) % 10 === 0))
  );
};

/** `XQST0097` / `XQST0098` / `XQST0114`: a decimal format's properties. */
const decimalFormatErrors = (
  properties: ReadonlyArray<readonly [string, string]>,
  offset: number,
): Errors => {
  const names = properties.map(([k]) => k);
  const repeated = names.find((k, i) => names.indexOf(k) !== i);
  if (repeated !== undefined)
    return fail("XQST0114", `the property ${repeated} is given twice`, offset);
  const values = HashMap.fromIterable(properties);
  const bad = properties.find(
    ([k, v]) =>
      k !== "infinity" &&
      k !== "NaN" &&
      (Array.from(v).length !== 1 || (k === "zero-digit" && !isZeroDigit(v))),
  );
  if (bad !== undefined)
    return fail("XQST0097", `"${bad[1]}" is not a valid value of ${bad[0]}`, offset);
  const pictures = pictureCharacters.map(([k, d]) =>
    Option.getOrElse(HashMap.get(values, k), () => d),
  );
  const zero = pictures[4]?.codePointAt(0) ?? 0x30;
  const digits = Arr.makeBy(10, (i) => String.fromCodePoint(zero + i));
  const all = [...pictures.filter((_, i) => i !== 4), ...digits];
  return all.some((c, i) => all.indexOf(c) !== i)
    ? fail("XQST0098", "the picture characters of a decimal format must be distinct", offset)
    : none;
};

const versionErrors = (version: Option.Option<VersionDecl>): Errors =>
  Option.match(version, {
    onNone: () => none,
    onSome: (v) => [
      ...Option.match(v.version, {
        onNone: () => none,
        onSome: (n) =>
          Arr.contains(["1.0", "3.0", "3.1"], n)
            ? none
            : fail("XQST0031", `XQuery version "${n}" is not supported`, v.offset),
      }),
      ...Option.match(v.encoding, {
        onNone: () => none,
        onSome: (e) =>
          /^[A-Za-z][A-Za-z0-9._-]*$/.test(e)
            ? none
            : fail("XQST0087", `"${e}" is not a valid encoding name`, v.offset),
      }),
    ],
  });

/** `%public` / `%private`: at most one, once (`XQST0106` on functions, `XQST0116` on variables). */
const visibilityErrors = (
  scope: Scope,
  annotations: ReadonlyArray<Annotation>,
  code: string,
): Errors => {
  const visibility = annotations.filter((a) =>
    Option.exists(Result.getSuccess(annotationName(scope, a)), isVisibility),
  );
  return Option.match(Arr.get(visibility, 1), {
    onNone: () => none,
    onSome: (a) => fail(code, "%public and %private may be given only once", a.name.offset),
  });
};

const libraryErrors = (library: Option.Option<string>, n: ExpandedName, name: EQName): Errors =>
  Option.exists(library, (uri) => uri !== n.uri)
    ? fail("XQST0048", `${show(name)} is not in the library module's namespace`, name.offset)
    : none;

const functionDecl = (
  fold: Fold,
  d: Extract<DeclT, { readonly _tag: "Function" }>,
  library: Option.Option<string>,
): Fold => {
  const scope = scopeOf(fold.context);
  const n = resolved(scope, d.name, "function");
  const checks = withErrors(fold, [
    ...nameErrors(scope, d.name, "function"),
    ...annotationErrors(scope, d.annotations),
    ...visibilityErrors(scope, d.annotations, "XQST0106"),
    ...params(scope, d.params),
    ...optionalType(scope, d.returnType),
  ]);
  if (n === undefined) return checks;
  const arity = d.params.length;
  const reserved =
    n.uri === ""
      ? fail("XQST0060", `the function ${show(d.name)} is not in a namespace`, d.name.offset)
      : Arr.contains(reservedNamespaces, n.uri)
        ? fail("XQST0045", `the function ${show(d.name)} is in a reserved namespace`, d.name.offset)
        : libraryErrors(library, n, d.name);
  return withContext(
    once(
      withErrors(checks, reserved),
      `function:${keyOf(n)}#${arity}`,
      "XQST0034",
      `the function ${show(d.name)}#${arity}`,
      d.offset,
    ),
    (c) => ({
      ...c,
      functions: HashMap.set(c.functions, keyOf(n), [
        ...Option.getOrElse(HashMap.get(c.functions, keyOf(n)), (): ReadonlyArray<Arity> => []),
        { min: arity, max: arity },
      ]),
    }),
  );
};

const variableDecl = (
  fold: Fold,
  d: Extract<DeclT, { readonly _tag: "Variable" }>,
  library: Option.Option<string>,
): Fold => {
  const scope = scopeOf(fold.context);
  const n = resolved(scope, d.name, "variable");
  const checks = withErrors(fold, [
    ...nameErrors(scope, d.name, "variable"),
    ...annotationErrors(scope, d.annotations),
    ...visibilityErrors(scope, d.annotations, "XQST0116"),
    ...optionalType(scope, d.type),
  ]);
  if (n === undefined) return checks;
  const declared = once(
    withErrors(checks, libraryErrors(library, n, d.name)),
    `variable:${keyOf(n)}`,
    "XQST0049",
    `the variable $${show(d.name)}`,
    d.offset,
  );
  return { ...declared, variables: [...declared.variables, [n, d] as const] };
};

const optionDecl = (
  fold: Fold,
  d: Extract<DeclT, { readonly _tag: "Option" }>,
  library: Option.Option<string>,
): Fold => {
  const scope = scopeOf(fold.context);
  const n =
    Option.isNone(d.name.prefix) && Option.isNone(d.name.uri)
      ? { uri: queryOptions, local: d.name.local }
      : resolved(scope, d.name, "other");
  if (n === undefined) return withErrors(fold, nameErrors(scope, d.name, "other"));
  const output = n.uri === Namespaces.output;
  const errors = !output
    ? none
    : Option.isSome(library)
      ? fail("XQST0108", "a library module can't declare serialization options", d.offset)
      : Arr.contains(serializationParameters, n.local)
        ? none
        : fail("XQST0109", `output:${n.local} is not a serialization parameter`, d.offset);
  const checked = withErrors(fold, errors);
  return withContext(
    output
      ? once(checked, `option:${keyOf(n)}`, "XQST0110", `the option ${show(d.name)}`, d.offset)
      : checked,
    (c) => ({ ...c, options: HashMap.set(c.options, keyOf(n), d.value) }),
  );
};

const decimalFormatDecl = (
  fold: Fold,
  d: Extract<DeclT, { readonly _tag: "DecimalFormat" }>,
): Fold => {
  const scope = scopeOf(fold.context);
  const key = Option.match(d.name, {
    onNone: () => "decimal-format:",
    onSome: (n) =>
      `decimal-format:${Option.match(Option.fromNullishOr(resolved(scope, n, "other")), { onNone: () => show(n), onSome: keyOf })}`,
  });
  return once(
    withErrors(fold, [
      ...Option.match(d.name, { onNone: () => none, onSome: (n) => nameErrors(scope, n, "other") }),
      ...decimalFormatErrors(d.properties, d.offset),
    ]),
    key,
    "XQST0111",
    "the decimal format",
    d.offset,
  );
};

/** `XQST0046`: a URI literal must be a valid `xs:anyURI` (here: no malformed `%` escape). */
const uriErrors = (uris: ReadonlyArray<string>, offset: number): Errors =>
  uris.some((u) => /%(?![0-9A-Fa-f]{2})/.test(u))
    ? fail("XQST0046", "a URI literal has a malformed percent-escape", offset)
    : none;

const importDecl = (
  fold: Fold,
  kind: "schema" | "module",
  prefix: Option.Option<string>,
  uri: string,
  at: ReadonlyArray<string>,
  offset: number,
): Fold => {
  const empty = uriErrors([uri, ...at], offset);
  const missing =
    uri === ""
      ? kind === "module"
        ? fail("XQST0088", "a module import needs a target namespace", offset)
        : Option.isSome(prefix)
          ? fail("XQST0057", "a schema import with a prefix needs a target namespace", offset)
          : none
      : none;
  const imported = once(
    withErrors(fold, [...empty, ...missing]),
    `${kind}:${uri}`,
    kind === "module" ? "XQST0047" : "XQST0058",
    `the ${kind} import of "${uri}"`,
    offset,
  );
  const bound = Option.match(prefix, {
    onNone: () => imported,
    onSome: (p) => declarePrefix(imported, p, uri, offset),
  });
  return opaque(bound, uri);
};

/** One setter: record it, or report it declared twice. */
const setter = (
  fold: Fold,
  key: string,
  code: string,
  what: string,
  offset: number,
  f: (c: StaticContext) => StaticContext,
): Fold => withContext(once(fold, key, code, what, offset), f);

const declaration =
  (library: Option.Option<string>) =>
  (fold: Fold, d: DeclT): Fold =>
    Decl.$match(d, {
      DefaultNamespace: ({ kind, uri, offset }) =>
        setter(
          withErrors(
            fold,
            uri === Namespaces.xml || uri === Namespaces.xmlns
              ? fail("XQST0070", `"${uri}" can't be a default namespace`, offset)
              : none,
          ),
          `default-${kind}`,
          "XQST0066",
          `the default ${kind} namespace`,
          offset,
          (c) =>
            kind === "element"
              ? { ...c, defaultElementNamespace: uri }
              : { ...c, defaultFunctionNamespace: uri },
        ),
      BoundarySpace: ({ preserve, offset }) =>
        setter(fold, "boundary-space", "XQST0068", "boundary-space", offset, (c) => ({
          ...c,
          boundarySpace: preserve ? "preserve" : "strip",
        })),
      DefaultCollation: ({ uri, offset }) =>
        setter(
          withErrors(fold, collationErrors(scopeOf(fold.context), uri, "XQST0038", offset)),
          "collation",
          "XQST0038",
          "the default collation",
          offset,
          (c) => ({
            ...c,
            defaultCollation: uri,
          }),
        ),
      BaseURI: ({ uri, offset }) =>
        setter(fold, "base-uri", "XQST0032", "the base URI", offset, (c) => ({
          ...c,
          baseUri: Option.some(uri),
        })),
      Construction: ({ preserve, offset }) =>
        setter(fold, "construction", "XQST0067", "construction", offset, (c) => ({
          ...c,
          construction: preserve ? "preserve" : "strip",
        })),
      OrderingMode: ({ ordered, offset }) =>
        setter(fold, "ordering", "XQST0065", "the ordering mode", offset, (c) => ({
          ...c,
          ordering: ordered ? "ordered" : "unordered",
        })),
      EmptyOrder: ({ greatest, offset }) =>
        setter(
          fold,
          "empty-order",
          "XQST0069",
          "the default order for empty sequences",
          offset,
          (c) => ({
            ...c,
            emptyOrder: greatest ? "greatest" : "least",
          }),
        ),
      CopyNamespaces: ({ preserve, inherit, offset }) =>
        setter(fold, "copy-namespaces", "XQST0055", "copy-namespaces", offset, (c) => ({
          ...c,
          copyNamespaces: { preserve, inherit },
        })),
      DecimalFormat: (df) => decimalFormatDecl(fold, df),
      Namespace: ({ prefix, uri, offset }) => declarePrefix(fold, prefix, uri, offset),
      SchemaImport: ({ prefix, defaultElement, uri, at, offset }) =>
        withContext(importDecl(fold, "schema", prefix, uri, at, offset), (c) =>
          defaultElement ? { ...c, defaultElementNamespace: uri } : c,
        ),
      ModuleImport: ({ prefix, uri, at, offset }) =>
        importDecl(fold, "module", prefix, uri, at, offset),
      ContextItem: ({ type, offset }) =>
        setter(
          withErrors(
            fold,
            Option.match(type, {
              onNone: () => none,
              onSome: (t) => itemType(scopeOf(fold.context), t),
            }),
          ),
          "context-item",
          "XQST0099",
          "the context item",
          offset,
          (c) => ({ ...c, contextItemType: type }),
        ),
      Variable: (v) => variableDecl(fold, v, library),
      Function: (f) => functionDecl(fold, f, library),
      Option: (o) => optionDecl(fold, o, library),
    });

/** Every variable of the prolog is in scope everywhere but in its own initializer (XQuery 3.1 §4.16). */
const bodies = (fold: Fold, decls: ReadonlyArray<DeclT>): Errors => {
  const full = scopeOf(fold.context);
  const initializers = fold.variables.flatMap(([n, d]) =>
    Decl.$is("Variable")(d)
      ? optionalExpr({ ...full, variables: HashSet.remove(full.variables, keyOf(n)) }, d.value)
      : none,
  );
  const parametersOf = (ps: ReadonlyArray<{ readonly name: EQName }>) =>
    ps.flatMap((p) => Option.toArray(Option.fromNullishOr(resolved(full, p.name, "variable"))));
  const others = decls.flatMap((d): Errors =>
    Decl.$is("Function")(d)
      ? optionalExpr(bind(full, parametersOf(d.params)), d.body)
      : Decl.$is("ContextItem")(d)
        ? optionalExpr(full, d.value)
        : none,
  );
  return [...initializers, ...others];
};

/** The result of static analysis: the module, and the static context its body is compiled in. */
export interface Analyzed {
  readonly module: ModuleT;
  readonly context: StaticContext;
}

const first = (errors: Errors): Option.Option<StaticError> => Arr.head(errors);

/** Analyse an XQuery module: build its static context and report its first static error. */
export const analyzeModule = (
  module: ModuleT,
  options?: StaticOptions | undefined,
): Result.Result<Analyzed, StaticError> => {
  const base = initialContext(true, options);
  const start: Fold = { errors: none, context: base, seen: HashSet.empty(), variables: [] };
  const library = Module.$match(module, {
    Main: () => Option.none<string>(),
    Library: (l) => Option.some(l.uri),
  });
  const header = Module.$match(module, {
    Main: (m) => ({ ...start, errors: versionErrors(m.version) }),
    Library: (l) =>
      withErrors(
        declarePrefix({ ...start, errors: versionErrors(l.version) }, l.prefix, l.uri, l.offset),
        l.uri === ""
          ? fail("XQST0088", "a library module needs a target namespace", l.offset)
          : none,
      ),
  });
  const decls = Module.$match(module, { Main: (m) => m.prolog, Library: (l) => l.prolog });
  const folded = Arr.reduce(decls, header, declaration(library));
  const context: StaticContext = {
    ...folded.context,
    variables: Arr.reduce(folded.variables, folded.context.variables, (vs, [n]) =>
      HashSet.add(vs, keyOf(n)),
    ),
  };
  const done = { ...folded, context };
  const errors = [
    ...done.errors,
    ...bodies(done, decls),
    ...Module.$match(module, {
      Main: (m) => expr(scopeOf(context), m.body),
      Library: () => none,
    }),
  ];
  return Option.match(first(errors), {
    onNone: () => Result.succeed({ module, context }),
    onSome: Result.fail,
  });
};

/** Analyse an XPath expression against the host's static context. */
export const analyzeExpression = (
  e: Expr,
  options?: StaticOptions | undefined,
): Result.Result<StaticContext, StaticError> => {
  const context = initialContext(false, options);
  return Option.match(first(expr(scopeOf(context), e)), {
    onNone: () => Result.succeed(context),
    onSome: Result.fail,
  });
};
