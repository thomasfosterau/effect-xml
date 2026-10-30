/**
 * A driver for the W3C QT3 test suite (XPath 3.1 / XQuery 3.1), vendored
 * under `tests/fixtures/qt3/` (see its README for the pinned commit and the
 * licence).
 *
 * It reads the catalog and the test sets with the library's own parser
 * (`Xml.parseBytes`), works out which tests apply to a run (one {@link Spec}
 * at a time, as the suite's guide asks, filtered by their dependencies and
 * what their environments need), builds each test's environment (source
 * documents, parameters, namespaces, collections, resources, modules, the
 * static base URI) and checks the result against every assertion kind the
 * catalog schema defines.
 *
 * The XQuery processor is a parameter: an {@link Engine}. Assertions that
 * need XPath (`assert`, `assert-eq`, `assert-deep-eq`, `assert-type`,
 * `assert-permutation`, `serialization-matches`) are evaluated by the same
 * engine with the result bound to `$result`; the structural ones
 * (`assert-empty`, `assert-count`, `assert-true` / `false`,
 * `assert-string-value`, `assert-xml`, `error`) are checked here against the
 * XDM model.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Xml, XQuery } from "../../src/index.ts";
import * as Fixtures from "./fixtures.ts";

/** The vendored suite. */
const QT3 = new URL("../fixtures/qt3/", import.meta.url);

const NS = "http://www.w3.org/2010/09/qt-fots-catalog";

/** The catalog's directories that are vendored; test sets elsewhere (`app`, `ser`) are skipped. */
const VENDORED: ReadonlyArray<string> = ["fn", "op", "prod", "math", "map", "array", "xs", "misc"];

// -----------------------------------------------------------------------------
// What this implementation supports: every dependency decision is here.
// -----------------------------------------------------------------------------

/** The language a run tests: XQuery 3.1 or XPath 3.1. */
export type Spec = "XQ31" | "XP31";

export const SPECS: ReadonlyArray<Spec> = ["XQ31", "XP31"];

/**
 * Optional features (`<dependency type="feature">`), and whether this
 * implementation has them. A feature not listed is unsupported. Turning one
 * on adds its tests to the runnable counts, so the baselines only go up.
 */
const FEATURES: HashMap.HashMap<string, boolean> = /*#__PURE__*/ HashMap.make(
  ["higherOrderFunctions", true],
  ["moduleImport", true],
  ["arbitraryPrecisionDecimal", true],
  ["collection-stability", true],
  ["non_empty_sequence_collection", true],
  // Unsupported (#70): schema awareness, static typing, the namespace axis,
  // UCA collations, typed data.
  ["schemaImport", false],
  ["schemaValidation", false],
  ["schema-location-hint", false],
  ["typedData", false],
  ["staticTyping", false],
  ["namespace-axis", false],
  ["simple-uca-fallback", false],
  ["advanced-uca-fallback", false],
  ["non_unicode_codepoint_collation", false],
  // Unsupported for now: candidates for later phases.
  ["serialization", false],
  ["infoset-dtd", false],
  ["xpath-1.0-compatibility", false],
  ["fn-load-xquery-module", false],
  ["fn-format-integer-CLDR", false],
  ["olson-timezone", false],
  // Out of scope: needs an XSLT processor, the network or a file system.
  ["fn-transform-XSLT", false],
  ["fn-transform-XSLT30", false],
  ["remote_http", false],
  ["directory-as-collection-uri", false],
);

/** The values of the other dependency types this implementation satisfies; any other type or value is unsatisfied. */
const SATISFIED: HashMap.HashMap<string, ReadonlyArray<string>> = /*#__PURE__*/ HashMap.make(
  ["xml-version", ["1.0", "1.0:5+"]],
  ["xsd-version", ["1.0"]],
  ["language", ["en"]],
  ["default-language", ["en"]],
  ["unicode-normalization-form", ["NFC", "NFD", "NFKC", "NFKD"]],
);

/** The collation URIs an environment may declare. */
const COLLATIONS: ReadonlyArray<string> = [
  "http://www.w3.org/2005/xpath-functions/collation/codepoint",
  "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive",
];

// -----------------------------------------------------------------------------
// The catalog model
// -----------------------------------------------------------------------------

/** One `<dependency>`: its `satisfied="false"` form asks for the feature to be absent. */
export interface Dependency {
  readonly type: string;
  readonly value: string;
  readonly satisfied: boolean;
}

/** A source document: the context item (`role="."`), a variable (`role="$name"`) or one `fn:doc` can load (`uri`). */
export interface Source {
  readonly role: Option.Option<string>;
  readonly file: URL;
  readonly uri: Option.Option<string>;
  readonly validation: Option.Option<string>;
}

/** A text resource for `fn:unparsed-text` and friends. */
export interface Resource {
  readonly file: URL;
  readonly uri: string;
  readonly mediaType: Option.Option<string>;
  readonly encoding: Option.Option<string>;
}

/** An external variable, bound to the value of an XPath expression or to a source document. */
export interface Param {
  readonly name: string;
  readonly select: Option.Option<string>;
  readonly as: Option.Option<string>;
  readonly declared: boolean;
  readonly source: Option.Option<string>;
}

/** A collection: its URI (`""` for the default collection), its documents and its queries. */
export interface Collection {
  readonly uri: string;
  readonly sources: ReadonlyArray<Source>;
  readonly queries: ReadonlyArray<string>;
}

/** A namespace binding in the static context. */
export interface Binding {
  readonly prefix: string;
  readonly uri: string;
}

/** A decimal format: its name (`None` for the default) and its properties by attribute name. */
export interface DecimalFormat {
  readonly name: Option.Option<{ readonly namespace: string | null; readonly local: string }>;
  readonly properties: Readonly<Record<string, string>>;
}

/** A test environment: the static and dynamic context a test runs in. */
export interface Environment {
  readonly name: Option.Option<string>;
  readonly sources: ReadonlyArray<Source>;
  readonly resources: ReadonlyArray<Resource>;
  readonly params: ReadonlyArray<Param>;
  readonly namespaces: ReadonlyArray<Binding>;
  readonly schemas: number;
  readonly collections: ReadonlyArray<Collection>;
  readonly contextItem: Option.Option<string>;
  /** `None`: the default (the query's own URI); `Some(None)`: undefined (`#UNDEFINED`). */
  readonly staticBaseUri: Option.Option<Option.Option<string>>;
  readonly decimalFormats: ReadonlyArray<DecimalFormat>;
  readonly collations: ReadonlyArray<{ readonly uri: string; readonly isDefault: boolean }>;
}

/** An expected result: a tree of assertions. */
export type Assertion = Data.TaggedEnum<{
  AnyOf: { readonly of: ReadonlyArray<Assertion> };
  AllOf: { readonly of: ReadonlyArray<Assertion> };
  Not: { readonly of: Assertion };
  Assert: { readonly expr: string };
  AssertEq: { readonly expr: string };
  AssertDeepEq: { readonly expr: string };
  AssertPermutation: { readonly expr: string };
  AssertStringValue: { readonly expected: string; readonly normalizeSpace: boolean };
  AssertType: { readonly type: string };
  AssertCount: { readonly count: number };
  AssertBoolean: { readonly expected: boolean };
  AssertXml: { readonly expected: string; readonly ignorePrefixes: boolean };
  AssertSerialization: { readonly expected: string };
  SerializationMatches: { readonly regex: string; readonly flags: string };
  AssertSerializationError: { readonly code: string };
  Error: { readonly code: string };
  Unknown: { readonly element: string };
}>;

export const Assertion = Data.taggedEnum<Assertion>();

/** A library module a test imports. */
export interface Module {
  readonly uri: string;
  readonly file: URL;
}

/** One test case, with its test set's dependencies and environments resolved. */
export interface TestCase {
  readonly set: string;
  readonly name: string;
  /** The file the query is in: its URI is the static base URI by default. */
  readonly base: URL;
  /** The environment; a `Failure` names an environment the catalog doesn't define. */
  readonly environment: Result.Result<Environment, string>;
  readonly modules: ReadonlyArray<Module>;
  readonly dependencies: ReadonlyArray<Dependency>;
  readonly query:
    | { readonly _tag: "Inline"; readonly text: string }
    | { readonly _tag: "File"; readonly file: URL };
  readonly result: Assertion;
}

/** A test set and its test cases. */
export interface TestSet {
  readonly name: string;
  readonly file: string;
  readonly cases: ReadonlyArray<TestCase>;
}

// -----------------------------------------------------------------------------
// Reading the catalog
// -----------------------------------------------------------------------------

const attribute = (element: Xml.XmlElement, name: string): Option.Option<string> =>
  Option.fromUndefinedOr(element.attribute(name));

const children = (element: Xml.XmlElement, local: string): ReadonlyArray<Xml.XmlElement> =>
  element.childElements(NS, local);

const required = (element: Xml.XmlElement, name: string): string =>
  Option.getOrElse(attribute(element, name), () => "");

const readSource = (element: Xml.XmlElement, base: URL): Source => ({
  role: attribute(element, "role"),
  file: new URL(required(element, "file"), base),
  uri: attribute(element, "uri"),
  validation: attribute(element, "validation"),
});

/** The namespace bindings an element declares itself, for QName-valued attributes. */
const declared = (element: Xml.XmlElement, prefix: string): string | null =>
  Option.getOrNull(
    Option.map(
      Arr.findFirst(element.attributes, (a) =>
        prefix === "" ? a.name.qualified === "xmlns" : a.name.qualified === `xmlns:${prefix}`,
      ),
      (a) => a.value,
    ),
  );

const readDecimalFormat = (element: Xml.XmlElement): DecimalFormat => ({
  name: Option.map(attribute(element, "name"), (raw) => {
    const colon = raw.indexOf(":");
    return colon < 0
      ? { namespace: null, local: raw }
      : { namespace: declared(element, raw.slice(0, colon)), local: raw.slice(colon + 1) };
  }),
  properties: Record.fromEntries(
    element.attributes
      .filter((a) => a.name.prefix === null && a.name.local !== "name" && a.name.local !== "xmlns")
      .map((a) => [a.name.local, a.value]),
  ),
});

const readEnvironment = (element: Xml.XmlElement, base: URL): Environment => ({
  name: attribute(element, "name"),
  sources: children(element, "source").map((s) => readSource(s, base)),
  resources: children(element, "resource").map((r) => ({
    file: new URL(required(r, "file"), base),
    uri: required(r, "uri"),
    mediaType: attribute(r, "media-type"),
    encoding: attribute(r, "encoding"),
  })),
  params: children(element, "param").map((p) => ({
    name: required(p, "name"),
    select: attribute(p, "select"),
    as: attribute(p, "as"),
    declared: Option.contains(attribute(p, "declared"), "true"),
    source: attribute(p, "source"),
  })),
  namespaces: children(element, "namespace").map((n) => ({
    prefix: required(n, "prefix"),
    uri: required(n, "uri"),
  })),
  schemas: children(element, "schema").length,
  collections: children(element, "collection").map((c) => ({
    uri: required(c, "uri"),
    sources: children(c, "source").map((s) => readSource(s, base)),
    queries: children(c, "query").map((q) => q.textContent),
  })),
  contextItem: Option.flatMap(Arr.head(children(element, "context-item")), (c) =>
    attribute(c, "select"),
  ),
  staticBaseUri: Option.map(Arr.head(children(element, "static-base-uri")), (s) =>
    Option.filter(attribute(s, "uri"), (uri) => uri !== "#UNDEFINED"),
  ),
  decimalFormats: children(element, "decimal-format").map(readDecimalFormat),
  collations: children(element, "collation").map((c) => ({
    uri: required(c, "uri"),
    isDefault: Option.contains(attribute(c, "default"), "true"),
  })),
});

const readDependencies = (element: Xml.XmlElement): ReadonlyArray<Dependency> =>
  children(element, "dependency").map((d) => ({
    type: required(d, "type"),
    value: required(d, "value"),
    satisfied: !Option.contains(attribute(d, "satisfied"), "false"),
  }));

type ReadAssertion = (e: Xml.XmlElement) => Assertion;

const assertionKinds: HashMap.HashMap<string, ReadAssertion> = /*#__PURE__*/ HashMap.make<
  ReadonlyArray<readonly [string, ReadAssertion]>
>(
  ["any-of", (e) => Assertion.AnyOf({ of: e.elements.map(readAssertion) })],
  ["all-of", (e) => Assertion.AllOf({ of: e.elements.map(readAssertion) })],
  [
    "not",
    (e) =>
      Assertion.Not({
        of: Option.match(Arr.head(e.elements), {
          onNone: () => Assertion.Unknown({ element: "not (empty)" }),
          onSome: readAssertion,
        }),
      }),
  ],
  ["assert", (e) => Assertion.Assert({ expr: e.textContent })],
  ["assert-eq", (e) => Assertion.AssertEq({ expr: e.textContent })],
  ["assert-deep-eq", (e) => Assertion.AssertDeepEq({ expr: e.textContent })],
  ["assert-permutation", (e) => Assertion.AssertPermutation({ expr: e.textContent })],
  [
    "assert-string-value",
    (e) =>
      Assertion.AssertStringValue({
        expected: e.textContent,
        normalizeSpace: Option.contains(attribute(e, "normalize-space"), "true"),
      }),
  ],
  ["assert-type", (e) => Assertion.AssertType({ type: e.textContent })],
  ["assert-count", (e) => Assertion.AssertCount({ count: Number(e.textContent.trim()) })],
  ["assert-empty", () => Assertion.AssertCount({ count: 0 })],
  ["assert-true", () => Assertion.AssertBoolean({ expected: true })],
  ["assert-false", () => Assertion.AssertBoolean({ expected: false })],
  [
    "assert-xml",
    (e) =>
      Assertion.AssertXml({
        expected: e.textContent,
        ignorePrefixes: Option.contains(attribute(e, "ignore-prefixes"), "true"),
      }),
  ],
  ["assert-serialization", (e) => Assertion.AssertSerialization({ expected: e.textContent })],
  [
    "serialization-matches",
    (e) =>
      Assertion.SerializationMatches({
        regex: e.textContent,
        flags: Option.getOrElse(attribute(e, "flags"), () => ""),
      }),
  ],
  [
    "assert-serialization-error",
    (e) => Assertion.AssertSerializationError({ code: required(e, "code") }),
  ],
  ["error", (e) => Assertion.Error({ code: required(e, "code") })],
);

/** An assertion element. Expected XML or serializations given as `file=` are read later, by {@link loadExpected}. */
const readAssertion = (element: Xml.XmlElement): Assertion =>
  Option.match(HashMap.get(assertionKinds, element.name.local), {
    onNone: () => Assertion.Unknown({ element: element.name.local }),
    onSome: (read) => read(element),
  });

/** The `file=` references of the assertions that compare against a file's contents. */
const expectedFiles = (
  element: Xml.XmlElement,
  base: URL,
): ReadonlyArray<readonly [Xml.XmlElement, URL]> => [
  ...Option.toArray(
    Option.map(attribute(element, "file"), (file) => [element, new URL(file, base)] as const),
  ),
  ...element.elements.flatMap((e) => expectedFiles(e, base)),
];

const latin1 = /*#__PURE__*/ new TextDecoder("latin1");

/** Whether the bytes contain `<!DOCTYPE` (in an ASCII-compatible encoding). */
const hasDoctype = (bytes: Uint8Array): boolean => latin1.decode(bytes).includes("<!DOCTYPE");

/**
 * Parse a fixture as XML, as the library reads a document's bytes. The
 * internal subset is read only when there is one: it costs a third of the
 * parse otherwise.
 */
const readXml = (file: URL) =>
  Fixtures.readBytes(file, "").pipe(
    Effect.flatMap((bytes) =>
      Xml.parseBytes(bytes, { dtd: hasDoctype(bytes) ? "internal" : "ignore" }),
    ),
  );

/**
 * Read an assertion, filling the expected text of `assert-xml`,
 * `assert-serialization` and `serialization-matches` from their `file=` when
 * they have one.
 */
const loadAssertion = Effect.fnUntraced(function* (element: Xml.XmlElement, base: URL) {
  const files = expectedFiles(element, base);
  const texts = yield* Effect.forEach(files, ([, file]) => Fixtures.readText(file, ""), {
    concurrency: 1,
  });
  const byElement = Arr.zip(
    files.map(([e]) => e),
    texts,
  );
  const withFile = (e: Xml.XmlElement): Assertion => {
    const text = Option.map(
      Arr.findFirst(byElement, ([f]) => f === e),
      ([, t]) => t,
    );
    if (Option.isNone(text)) return readAssertion(e);
    const kind = e.name.local;
    if (kind === "assert-xml")
      return Assertion.AssertXml({
        expected: text.value,
        ignorePrefixes: Option.contains(attribute(e, "ignore-prefixes"), "true"),
      });
    if (kind === "assert-serialization")
      return Assertion.AssertSerialization({ expected: text.value });
    if (kind === "serialization-matches")
      return Assertion.SerializationMatches({
        regex: text.value,
        flags: Option.getOrElse(attribute(e, "flags"), () => ""),
      });
    return readAssertion(e);
  };
  // Re-read containers so the file-backed leaves are the filled ones.
  const fill = (e: Xml.XmlElement): Assertion => {
    const kind = e.name.local;
    if (kind === "any-of") return Assertion.AnyOf({ of: e.elements.map(fill) });
    if (kind === "all-of") return Assertion.AllOf({ of: e.elements.map(fill) });
    if (kind === "not")
      return Option.match(Arr.head(e.elements), {
        onNone: () => readAssertion(e),
        onSome: (inner) => Assertion.Not({ of: fill(inner) }),
      });
    return withFile(e);
  };
  return fill(element);
});

const readTestCase = Effect.fnUntraced(function* (
  element: Xml.XmlElement,
  set: string,
  base: URL,
  setDependencies: ReadonlyArray<Dependency>,
  environments: HashMap.HashMap<string, Environment>,
) {
  const name = required(element, "name");
  const environment: Result.Result<Environment, string> = Option.match(
    Arr.head(children(element, "environment")),
    {
      onNone: () => Result.succeed(emptyEnvironment),
      onSome: (e) =>
        Option.match(attribute(e, "ref"), {
          onNone: () => Result.succeed(readEnvironment(e, base)),
          onSome: (ref) =>
            Result.fromOption(HashMap.get(environments, ref), () => `no environment "${ref}"`),
        }),
    },
  );
  const test = Arr.head(children(element, "test"));
  const query = Option.match(
    Option.flatMap(test, (t) => attribute(t, "file")),
    {
      onNone: () =>
        ({
          _tag: "Inline",
          text: Option.match(test, { onNone: () => "", onSome: (t) => t.textContent }),
        }) as const,
      onSome: (file) => ({ _tag: "File", file: new URL(file, base) }) as const,
    },
  );
  const resultElement = Arr.head(children(element, "result"));
  const result = yield* Option.match(
    Option.flatMap(resultElement, (r) => Arr.head(r.elements)),
    {
      onNone: () => Effect.succeed(Assertion.Unknown({ element: "result (empty)" })),
      onSome: (a) => loadAssertion(a, base),
    },
  );
  const testCase: TestCase = {
    set,
    name,
    base: Predicate.isTagged(query, "File") ? query.file : base,
    environment,
    modules: children(element, "module").map((m) => ({
      uri: required(m, "uri"),
      file: new URL(required(m, "file"), base),
    })),
    dependencies: [...setDependencies, ...readDependencies(element)],
    query,
    result,
  };
  return testCase;
});

const emptyEnvironment: Environment = {
  name: Option.some("empty"),
  sources: [],
  resources: [],
  params: [],
  namespaces: [],
  schemas: 0,
  collections: [],
  contextItem: Option.none(),
  staticBaseUri: Option.none(),
  decimalFormats: [],
  collations: [],
};

const environmentsOf = (root: Xml.XmlElement, base: URL): HashMap.HashMap<string, Environment> =>
  HashMap.fromIterable(
    children(root, "environment").flatMap((e) =>
      Arr.fromOption(
        Option.map(attribute(e, "name"), (name) => [name, readEnvironment(e, base)] as const),
      ),
    ),
  );

const readTestSet = Effect.fnUntraced(function* (
  name: string,
  file: string,
  catalogEnvironments: HashMap.HashMap<string, Environment>,
) {
  const url = new URL(file, QT3);
  const doc = yield* readXml(url);
  const root = doc.root;
  // A test set's own environments shadow the catalog's.
  const environments = HashMap.union(catalogEnvironments, environmentsOf(root, url));
  const dependencies = readDependencies(root);
  const cases = yield* Effect.forEach(
    children(root, "test-case"),
    (tc) => readTestCase(tc, name, url, dependencies, environments),
    { concurrency: 1 },
  );
  const set: TestSet = { name, file, cases };
  return set;
});

/** Every vendored test set in catalog order, with its test cases. */
export const readCatalog = Effect.fnUntraced(function* () {
  const catalogUrl = new URL("catalog.xml", QT3);
  const catalog = yield* readXml(catalogUrl);
  const environments = environmentsOf(catalog.root, catalogUrl);
  const sets = children(catalog.root, "test-set").flatMap((s) => {
    const file = required(s, "file");
    return Arr.contains(VENDORED, file.split("/")[0] ?? "")
      ? [[required(s, "name"), file] as const]
      : [];
  });
  return yield* Effect.forEach(sets, ([name, file]) => readTestSet(name, file, environments), {
    concurrency: 8,
  });
});

// -----------------------------------------------------------------------------
// Which tests apply
// -----------------------------------------------------------------------------

/** The versions of each language the suite knows. */
const versionsOf = (language: string): ReadonlyArray<number> =>
  language === "XP" ? [20, 30, 31] : language === "XQ" ? [10, 30, 31] : [];

/** Whether a `spec` dependency's value (`"XP30+ XQ31"`, …) covers `spec`. */
export const specApplies = (spec: Spec, value: string): boolean =>
  value
    .split(/\s+/)
    .filter((t) => t !== "")
    .some((token) => {
      const m = /^(XP|XQ|XT)(\d\d)(\+?)$/.exec(token);
      if (m === null || m[1] !== spec.slice(0, 2)) return false;
      const version = Number(m[2]);
      const target = Number(spec.slice(2));
      return (
        Arr.contains(versionsOf(m[1] ?? ""), version) &&
        (m[3] === "+" ? version <= target : version === target)
      );
    });

const dependencySatisfied = (spec: Spec, d: Dependency): boolean => {
  if (d.type === "spec") return specApplies(spec, d.value);
  const has =
    d.type === "feature"
      ? Option.getOrElse(HashMap.get(FEATURES, d.value), () => false)
      : d.value.split(/\s+/).some((v) =>
          Arr.contains(
            Option.getOrElse(HashMap.get(SATISFIED, d.type), () => []),
            v,
          ),
        );
  return has === d.satisfied;
};

/** What an environment needs beyond its test's dependencies: validated sources, schemas, other collations. */
const environmentNeeds = (environment: Environment): Option.Option<string> => {
  if (environment.schemas > 0 || environment.sources.some((s) => Option.isSome(s.validation)))
    return Option.some("environment needs schema awareness");
  const collation = Arr.findFirst(environment.collations, (c) => !Arr.contains(COLLATIONS, c.uri));
  return Option.map(collation, (c) => `environment needs the collation ${c.uri}`);
};

/** Why a test does not apply to a run of `spec`, or `None` when it is runnable. */
export const notApplicable = (spec: Spec, test: TestCase): Option.Option<string> => {
  // A test without a spec dependency applies to every language and version.
  const unmet = Arr.findFirst(test.dependencies, (d) => !dependencySatisfied(spec, d));
  if (Option.isSome(unmet))
    return Option.some(
      `${unmet.value.type} ${unmet.value.value}${unmet.value.satisfied ? "" : " (absent)"}`,
    );
  return Result.match(test.environment, {
    onFailure: () => Option.none(),
    onSuccess: environmentNeeds,
  });
};

// -----------------------------------------------------------------------------
// The engine under test
// -----------------------------------------------------------------------------

/** An external variable as the engine receives it. */
export interface Variable {
  /** The name as written (`x`, or `p:x` with `p` in {@link Request.namespaces}). */
  readonly name: string;
  readonly value: XQuery.Sequence;
  /** Whether the query declares it (`declare variable $x external`); XPath queries never do. */
  readonly declared: boolean;
  /** The sequence type the catalog gives it, if any. */
  readonly type: Option.Option<string>;
}

/** A text resource's bytes, as `fn:unparsed-text` would fetch them. */
export interface LoadedResource {
  readonly bytes: Uint8Array;
  readonly mediaType: Option.Option<string>;
  readonly encoding: Option.Option<string>;
}

/** Everything one evaluation needs: the query and its static and dynamic context. */
export interface Request {
  readonly spec: Spec;
  readonly query: string;
  /** The static base URI: `None` when the environment makes it undefined. */
  readonly baseUri: Option.Option<string>;
  readonly namespaces: ReadonlyArray<Binding>;
  readonly contextItem: Option.Option<XQuery.Item>;
  readonly variables: ReadonlyArray<Variable>;
  /** Documents `fn:doc` can load, by absolute URI; a `Failure` is a document that isn't well-formed. */
  readonly documents: HashMap.HashMap<string, Result.Result<XQuery.XdmNode, string>>;
  /** Collections by absolute URI; `""` is the default collection. */
  readonly collections: HashMap.HashMap<string, XQuery.Sequence>;
  readonly resources: HashMap.HashMap<string, LoadedResource>;
  /** Library modules by target namespace, with their source text. */
  readonly modules: ReadonlyArray<{
    readonly uri: string;
    readonly location: string;
    readonly text: string;
  }>;
  readonly decimalFormats: ReadonlyArray<DecimalFormat>;
  readonly defaultCollation: Option.Option<string>;
}

/** The engine can't run this yet: never a pass, whatever the test expects. */
class NotImplemented extends Schema.TaggedError<NotImplemented>()("NotImplemented", {
  what: Schema.String,
}) {}

/** What an engine fails with: an XQuery error (which `error` assertions check) or {@link NotImplemented}. */
export type EngineError = XQuery.XQueryError | NotImplemented;

/** An XQuery 3.1 / XPath 3.1 processor under test. */
export interface Engine {
  /** Evaluate a query (XQuery for `XQ31`, XPath for `XP31`) to a sequence. */
  readonly evaluate: (request: Request) => Effect.Effect<XQuery.Sequence, EngineError>;
  /** Serialize a result with the serialization parameters the query declares. */
  readonly serialize: (
    request: Request,
    result: XQuery.Sequence,
  ) => Effect.Effect<string, EngineError>;
}

const isXQueryError = /*#__PURE__*/ Schema.is(XQuery.XQueryError);

/** The engine before there is an evaluator: every test fails. */
export const notImplemented: Engine = {
  evaluate: () => Effect.fail(new NotImplemented({ what: "evaluation" })),
  serialize: () => Effect.fail(new NotImplemented({ what: "serialization" })),
};

// -----------------------------------------------------------------------------
// Running a test
// -----------------------------------------------------------------------------

/** What evaluating a test's query came to. */
export type Outcome = Data.TaggedEnum<{
  /** The query returned a sequence. */
  Value: { readonly sequence: XQuery.Sequence };
  /** The query raised an XQuery error. */
  Raised: { readonly error: XQuery.XQueryError };
  /** The test couldn't be run: the engine can't, or the environment couldn't be built. */
  Broken: { readonly reason: string };
}>;

export const Outcome = Data.taggedEnum<Outcome>();

const outcomeOf = (exit: Result.Result<XQuery.Sequence, EngineError>): Outcome =>
  Result.match(exit, {
    onSuccess: (sequence) => Outcome.Value({ sequence }),
    onFailure: (error) =>
      isXQueryError(error)
        ? Outcome.Raised({ error })
        : Outcome.Broken({ reason: `not implemented: ${error.what}` }),
  });

/** Pre-parsed source documents, by file URL. */
export type Documents = HashMap.HashMap<string, Result.Result<Xml.XmlDocument, string>>;

/** Every source file the given tests' environments use. */
const sourceFiles = (tests: ReadonlyArray<TestCase>): ReadonlyArray<string> =>
  Arr.dedupe(
    tests.flatMap((t) =>
      Result.match(t.environment, {
        onFailure: () => [],
        onSuccess: (e) =>
          [...e.sources, ...e.collections.flatMap((c) => c.sources)].map((s) => s.file.href),
      }),
    ),
  );

/** Parse every source document the tests use, once. A document that isn't well-formed is kept as its error. */
export const loadDocuments = (tests: ReadonlyArray<TestCase>) =>
  Effect.forEach(
    sourceFiles(tests),
    (href) =>
      readXml(new URL(href)).pipe(
        Effect.result,
        Effect.map((r) => [href, Result.mapError(r, (e) => e.message)] as const),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((entries): Documents => HashMap.fromIterable(entries)));

const failed = (reason: string) => Effect.fail(new NotImplemented({ what: reason }));

/** The document node a source stands for (fresh for each test, so node identity is per test). */
const documentNode = (documents: Documents, source: Source, uri: Option.Option<string>) =>
  Option.match(HashMap.get(documents, source.file.href), {
    onNone: () => Result.fail(`${source.file.href} was not loaded`),
    onSome: (parsed) =>
      Result.map(parsed, (doc) =>
        XQuery.XdmNode.fromDocument(doc, {
          documentUri: Option.getOrElse(uri, () => source.file.href),
        }),
      ),
  });

/** A source document, the URI it is known by and its document node (or why there is none). */
type Loaded = readonly [Source, Option.Option<string>, Result.Result<XQuery.XdmNode, string>];

/** Build the request for a test's query: its environment's documents, variables and context. */
const buildRequest = Effect.fnUntraced(function* (
  engine: Engine,
  spec: Spec,
  test: TestCase,
  environment: Environment,
  documents: Documents,
) {
  const queryBase = test.base.href;
  const baseUri = Option.getOrElse(environment.staticBaseUri, () => Option.some(queryBase));
  const resolve = (uri: string) =>
    URL.parse(
      uri,
      Option.getOrElse(baseUri, () => queryBase),
    )?.href ?? uri;
  const query =
    test.query._tag === "Inline" ? test.query.text : yield* Fixtures.readText(test.query.file, "");
  const nodes = yield* Effect.forEach(
    environment.sources,
    (source): Effect.Effect<Loaded, NotImplemented> => {
      const uri = Option.map(source.uri, resolve);
      return Result.match(documentNode(documents, source, uri), {
        onFailure: (reason) =>
          // Only a document the query itself needs must parse; one for `fn:doc` may be broken on purpose.
          Option.isSome(source.role)
            ? failed(`source ${source.file.href}: ${reason}`)
            : Effect.succeed<Loaded>([source, uri, Result.fail(reason)]),
        onSuccess: (node) => Effect.succeed<Loaded>([source, uri, Result.succeed(node)]),
      });
    },
    { concurrency: 1 },
  );
  const documentsByUri = HashMap.fromIterable(
    nodes.flatMap(([source, uri, node]) => [
      [source.file.href, node] as const,
      ...Option.toArray(Option.map(uri, (u) => [u, node] as const)),
    ]),
  );
  const contextDocument = Arr.findFirst(nodes, ([source]) => Option.contains(source.role, "."));
  const roleVariables = nodes.flatMap(([source, , node]) =>
    Option.match(
      Option.filter(source.role, (r) => r.startsWith("$")),
      {
        onNone: () => [],
        onSome: (role) =>
          Result.isSuccess(node)
            ? [
                {
                  name: role.slice(1),
                  value: [node.success],
                  declared: spec === "XQ31",
                  type: Option.none(),
                } satisfies Variable,
              ]
            : [],
      },
    ),
  );
  const collections = yield* Effect.forEach(
    environment.collections,
    (c) =>
      Effect.forEach(
        c.sources,
        (source) =>
          Result.match(documentNode(documents, source, Option.map(source.uri, resolve)), {
            onFailure: (reason) => failed(`collection source ${source.file.href}: ${reason}`),
            onSuccess: (node) => Effect.succeed<XQuery.Item>(node),
          }),
        { concurrency: 1 },
      ).pipe(Effect.map((items) => [c.uri === "" ? "" : resolve(c.uri), items] as const)),
    { concurrency: 1 },
  );
  const resources = yield* Effect.forEach(
    environment.resources,
    (r) =>
      Fixtures.readBytes(r.file, "").pipe(
        Effect.map(
          (bytes) =>
            [resolve(r.uri), { bytes, mediaType: r.mediaType, encoding: r.encoding }] as const,
        ),
      ),
    { concurrency: 1 },
  );
  const modules = yield* Effect.forEach(
    test.modules,
    (m) =>
      Fixtures.readText(m.file, "").pipe(
        Effect.map((text) => ({ uri: m.uri, location: m.file.href, text })),
      ),
    { concurrency: 1 },
  );
  const base: Request = {
    spec,
    query,
    baseUri,
    namespaces: environment.namespaces,
    contextItem: Option.flatMap(contextDocument, ([, , node]) => Result.getSuccess(node)),
    variables: roleVariables,
    documents: documentsByUri,
    collections: HashMap.fromIterable(collections),
    resources: HashMap.fromIterable(resources),
    modules,
    decimalFormats: environment.decimalFormats,
    defaultCollation: Option.map(
      Arr.findFirst(environment.collations, (c) => c.isDefault),
      (c) => c.uri,
    ),
  };
  // Parameters and the context item are XPath expressions, evaluated by the engine in this context.
  const evaluateIn = (expr: string) =>
    engine.evaluate({ ...base, spec: "XP31", query: expr, contextItem: Option.none() });
  const valueOf = (p: Param): Effect.Effect<XQuery.Sequence, EngineError> =>
    Option.match(p.source, {
      onSome: (src) =>
        Option.match(HashMap.get(documentsByUri, resolve(src)), {
          onNone: () => failed(`param ${p.name}: no source ${src}`),
          onSome: (node) =>
            Result.match(node, {
              onFailure: (reason) => failed(`param ${p.name}: ${reason}`),
              onSuccess: (n) => Effect.succeed<XQuery.Sequence>([n]),
            }),
        }),
      onNone: () =>
        Option.match(p.select, {
          onNone: () => Effect.succeed<XQuery.Sequence>([]),
          onSome: evaluateIn,
        }),
    });
  const params = yield* Effect.forEach(
    environment.params,
    (p) =>
      valueOf(p).pipe(
        Effect.map((value): Variable => ({
          name: p.name,
          value,
          declared: p.declared,
          type: p.as,
        })),
      ),
    { concurrency: 1 },
  );
  const contextItem = yield* Option.match(environment.contextItem, {
    onNone: () => Effect.succeed(base.contextItem),
    onSome: (select) => evaluateIn(select).pipe(Effect.map((items) => Arr.head(items))),
  });
  const request: Request = { ...base, contextItem, variables: [...roleVariables, ...params] };
  return request;
});

/** One test's verdict: `None` when it passed, otherwise why it failed. */
export interface Verdict {
  readonly spec: Spec;
  readonly set: string;
  readonly name: string;
  readonly failure: Option.Option<string>;
}

/** Run a test against an engine and check its result. */
export const runTest = Effect.fnUntraced(function* (
  engine: Engine,
  spec: Spec,
  test: TestCase,
  documents: Documents,
) {
  const verdict = (failure: Option.Option<string>): Verdict => ({
    spec,
    set: test.set,
    name: test.name,
    failure,
  });
  if (Result.isFailure(test.environment)) return verdict(Option.some(test.environment.failure));
  const built = yield* Effect.result(
    buildRequest(engine, spec, test, test.environment.success, documents),
  );
  if (Result.isFailure(built)) {
    const error = built.failure;
    return verdict(
      Option.some(
        Schema.is(NotImplemented)(error)
          ? `environment: not implemented: ${error.what}`
          : `environment: ${error.message}`,
      ),
    );
  }
  const request = built.success;
  const outcome = outcomeOf(yield* Effect.result(engine.evaluate(request)));
  return verdict(yield* check(test.result, outcome, { engine, request }));
});

// -----------------------------------------------------------------------------
// Checking assertions
// -----------------------------------------------------------------------------

/** What assertions that need XPath evaluate in: the engine and the test's request. */
export interface CheckContext {
  readonly engine: Engine;
  readonly request: Request;
}

const pass = Effect.succeed(Option.none<string>());
const fail = (reason: string) => Effect.succeed(Option.some(reason));

const ERR = "http://www.w3.org/2005/xqt-errors";

/** Whether an error has the code an `error` assertion names: `*`, an `err:` local name or an EQName `Q{uri}local`. */
export const codeMatches = (expected: string, code: QNameLike): boolean => {
  if (expected === "*") return true;
  const eqname = /^Q\{(.*)\}(.+)$/.exec(expected);
  if (eqname !== null)
    return (code.namespace ?? "") === (eqname[1] ?? "") && code.local === eqname[2];
  const local = expected.includes(":") ? expected.slice(expected.indexOf(":") + 1) : expected;
  return code.namespace === ERR && code.local === local;
};

interface QNameLike {
  readonly namespace: string | null;
  readonly local: string;
}

/** Evaluate an assertion's XPath with the result bound to `$result`. */
const evaluateWith = (
  context: CheckContext,
  query: string,
  bindings: ReadonlyArray<readonly [string, XQuery.Sequence]>,
) =>
  context.engine.evaluate({
    ...context.request,
    spec: "XP31",
    query,
    contextItem: Option.none(),
    variables: [
      ...context.request.variables,
      ...bindings.map(([name, value]): Variable => ({
        name,
        value,
        declared: false,
        type: Option.none(),
      })),
    ],
  });

const describe = (error: EngineError): string =>
  isXQueryError(error) ? error.message : `not implemented: ${error.what}`;

/** An assertion XPath that must come out true. */
const holds = (
  context: CheckContext,
  query: string,
  bindings: ReadonlyArray<readonly [string, XQuery.Sequence]>,
  what: string,
) =>
  evaluateWith(context, query, bindings).pipe(
    Effect.map((value) =>
      Result.match(XQuery.effectiveBooleanValue(value), {
        onFailure: (e) => Option.some(`${what}: ${e.message}`),
        onSuccess: (ok) => (ok ? Option.none() : Option.some(`${what} is false`)),
      }),
    ),
    Effect.catch((e: EngineError) => fail(`${what}: ${describe(e)}`)),
  );

/** The result's items' string values joined by spaces, as `assert-string-value` compares them. */
const stringOf = (sequence: XQuery.Sequence): Result.Result<string, string> =>
  Result.mapError(Result.all(sequence.map(XQuery.stringValue)), (e) => e.message).pipe(
    Result.map((parts) => parts.join(" ")),
  );

const normalizeSpace = (s: string): string => s.replace(/[ \t\r\n]+/g, " ").trim();

// ---- assert-xml: comparing a result's nodes with expected XML ---------------

/** A canonical rendering of DOM nodes: names by namespace URI, attributes sorted, adjacent text merged. */
const isTextLike = (node: Xml.XmlNode): node is Xml.XmlText | Xml.XmlCData =>
  Predicate.isTagged(node, "XmlText") || Predicate.isTagged(node, "XmlCData");

/** Adjacent text and CDATA as one text node. */
const mergeText = (nodes: ReadonlyArray<Xml.XmlNode>): ReadonlyArray<Xml.XmlNode> =>
  nodes.reduce<Array<Xml.XmlNode>>((out, node) => {
    const last = out.at(-1);
    if (!isTextLike(node)) out.push(node);
    else if (last !== undefined && isTextLike(last))
      out[out.length - 1] = Xml.text(last.data + node.data);
    else out.push(Xml.text(node.data));
    return out;
  }, []);

const isNamespaceDeclaration = (a: Xml.XmlAttribute): boolean =>
  a.name.prefix === "xmlns" || (a.name.prefix === null && a.name.local === "xmlns");

/** A canonical rendering of DOM nodes: names by namespace URI, attributes sorted, adjacent text merged. */
const canonicalNodes = (nodes: ReadonlyArray<Xml.XmlNode>, prefixes: boolean): string => {
  const name = (q: {
    readonly prefix: string | null;
    readonly namespace: string | null;
    readonly local: string;
  }) => `${prefixes && q.prefix !== null ? `${q.prefix}=` : ""}{${q.namespace ?? ""}}${q.local}`;
  // Recursive: expected results are small.
  return mergeText(nodes)
    .map((node) =>
      Match.valueTags(node, {
        XmlText: (t) => escapeText(t.data),
        XmlCData: (t) => escapeText(t.data),
        XmlComment: (c) => `<!--${c.data}-->`,
        XmlProcessingInstruction: (pi) => `<?${pi.target} ${pi.data}?>`,
        XmlElement: (e) => {
          const attributes = Arr.sort(
            e.attributes
              .filter((a) => !isNamespaceDeclaration(a))
              .map((a) => `${name(a.name)}="${escapeText(a.value)}"`),
            Order.String,
          );
          return `<${name(e.name)}${attributes.map((a) => ` ${a}`).join("")}>${canonicalNodes(e.children, prefixes)}</>`;
        },
      }),
    )
    .join("");
};

const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

const isComment = Schema.is(Xml.XmlComment);
const isProcessingInstruction = Schema.is(Xml.XmlProcessingInstruction);

/** The DOM nodes an XDM node stands for as XML content: a document stands for its children. */
const domOf = (node: XQuery.XdmNode): Result.Result<ReadonlyArray<Xml.XmlNode>, string> => {
  const dom = node.dom;
  if (node.kind === "document")
    return Result.map(Result.all(node.children.map(domOf)), Arr.flatten);
  if (node.kind === "text") return Result.succeed([Xml.text(node.stringValue)]);
  if (isComment(dom) || isProcessingInstruction(dom)) return Result.succeed([dom]);
  return Option.match(node.element, {
    onNone: () => Result.fail(`a ${node.kind} node cannot be serialized as XML content`),
    onSome: (element) => Result.succeed([element]),
  });
};

/** The DOM nodes a result stands for, as serializing it would write them: atomic values as text, separated by spaces. */
const resultNodes = (
  sequence: XQuery.Sequence,
): Result.Result<ReadonlyArray<Xml.XmlNode>, string> =>
  Result.all(
    sequence.map((item, i): Result.Result<ReadonlyArray<Xml.XmlNode>, string> => {
      if (XQuery.isNode(item)) return domOf(item);
      const previous = sequence[i - 1];
      return Result.match(XQuery.stringValue(item), {
        onFailure: (e) => Result.fail(e.message),
        onSuccess: (s) =>
          Result.succeed([
            Xml.text(previous !== undefined && XQuery.isAtomic(previous) ? ` ${s}` : s),
          ]),
      });
    }),
  ).pipe(Result.map(Arr.flatten));

/** Parse expected XML content (a fragment: any number of nodes, an XML declaration dropped). */
const expectedNodes = (xml: string) =>
  Xml.parse(`<qt3-expected>${xml.replace(/^﻿?<\?xml[^?]*\?>/, "")}</qt3-expected>`).pipe(
    Effect.map((doc) => doc.root.children),
  );

const assertXml = (sequence: XQuery.Sequence, expected: string, ignorePrefixes: boolean) =>
  Result.match(resultNodes(sequence), {
    onFailure: fail,
    onSuccess: (got) =>
      expectedNodes(expected).pipe(
        Effect.flatMap((want) => {
          const a = canonicalNodes(got, !ignorePrefixes);
          const b = canonicalNodes(want, !ignorePrefixes);
          return a === b ? pass : fail(`assert-xml: got ${a}, expected ${b}`);
        }),
        Effect.catch((e) => fail(`assert-xml: the expected XML does not parse: ${e.message}`)),
      ),
  });

// ---- assert-permutation ------------------------------------------------------

type Unmatched = Option.Option<ReadonlyArray<XQuery.Item>>;

/** Whether two items are `deep-equal`, as the engine says. */
const deepEqual = (context: CheckContext, a: XQuery.Item, b: XQuery.Item) =>
  evaluateWith(context, "deep-equal($a, $b)", [
    ["a", [a]],
    ["b", [b]],
  ]).pipe(Effect.map((r) => Result.getOrElse(XQuery.effectiveBooleanValue(r), () => false)));

/** Remove from `left` an item deep-equal to `want`; `None` once some expected item has no match. */
const matchOne = (context: CheckContext, left: Unmatched, want: XQuery.Item) =>
  Option.match(left, {
    onNone: () => Effect.succeed<Unmatched>(Option.none()),
    onSome: (items) =>
      Effect.findFirst(items, (item) => deepEqual(context, want, item)).pipe(
        Effect.map((found): Unmatched =>
          Option.map(found, (f) => Arr.remove(items, items.indexOf(f))),
        ),
      ),
  });

const permutation = (context: CheckContext, sequence: XQuery.Sequence, expr: string) =>
  evaluateWith(context, expr, []).pipe(
    Effect.flatMap((expected) =>
      expected.length === sequence.length
        ? Effect.reduce(
            expected,
            (): Unmatched => Option.some(sequence),
            (left, want) => matchOne(context, left, want),
          ).pipe(
            Effect.flatMap((left) =>
              Option.isSome(left) ? pass : fail("assert-permutation: not a permutation"),
            ),
          )
        : fail(`assert-permutation: ${sequence.length} items, expected ${expected.length}`),
    ),
    Effect.catch((e: EngineError) => fail(`assert-permutation: ${describe(e)}`)),
  );

// ---- serialization -----------------------------------------------------------

const serialized = (
  context: CheckContext,
  sequence: XQuery.Sequence,
  then: (s: string) => Effect.Effect<Option.Option<string>>,
) =>
  context.engine.serialize(context.request, sequence).pipe(
    Effect.flatMap(then),
    Effect.catch((e: EngineError) => fail(`serialization: ${describe(e)}`)),
  );

/** A string as an XPath string literal. */
const literal = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** Check an assertion against an outcome: `None` when it holds, otherwise why not. */
export const check = (
  assertion: Assertion,
  outcome: Outcome,
  context: CheckContext,
): Effect.Effect<Option.Option<string>> => {
  if (Outcome.$is("Broken")(outcome)) return fail(outcome.reason);
  return Assertion.$match(assertion, {
    AnyOf: ({ of }) =>
      Effect.forEach(of, (a) => check(a, outcome, context), { concurrency: 1 }).pipe(
        Effect.map((results) =>
          results.some(Option.isNone)
            ? Option.none()
            : Option.some(`any-of: ${results.map(Option.getOrElse(() => "")).join("; ")}`),
        ),
      ),
    AllOf: ({ of }) =>
      Effect.forEach(of, (a) => check(a, outcome, context), { concurrency: 1 }).pipe(
        Effect.map((results) =>
          Option.map(
            Arr.findFirst(results, Option.isSome),
            (r) => `all-of: ${Option.getOrElse(r, () => "")}`,
          ),
        ),
      ),
    Not: ({ of }) =>
      check(of, outcome, context).pipe(
        Effect.map((r) =>
          Option.isSome(r) ? Option.none() : Option.some("not: the assertion holds"),
        ),
      ),
    Error: ({ code }) =>
      Outcome.$is("Raised")(outcome)
        ? codeMatches(code, outcome.error.code)
          ? pass
          : fail(
              `expected error ${code}, got ${outcome.error.code.qualified}: ${outcome.error.description}`,
            )
        : fail(`expected error ${code}, got a result`),
    AssertSerializationError: ({ code }) =>
      Outcome.$is("Raised")(outcome)
        ? codeMatches(code, outcome.error.code)
          ? pass
          : fail(`expected serialization error ${code}, got ${outcome.error.code.qualified}`)
        : Outcome.$is("Value")(outcome)
          ? context.engine.serialize(context.request, outcome.sequence).pipe(
              Effect.map(() => Option.some(`expected serialization error ${code}, serialized`)),
              Effect.catchTags({
                XQueryError: (e) =>
                  codeMatches(code, e.code)
                    ? pass
                    : fail(`expected serialization error ${code}, got ${e.message}`),
                NotImplemented: (e) => fail(`serialization: not implemented: ${e.what}`),
              }),
            )
          : fail("no result"),
    Unknown: ({ element }) => fail(`unknown assertion <${element}>`),
    ...valueAssertions(outcome, context),
  });
};

/** A check for each assertion about a returned sequence. */
interface ValueAssertions {
  readonly AssertCount: (a: Extract<Assertion, { _tag: "AssertCount" }>) => Check;
  readonly AssertBoolean: (a: Extract<Assertion, { _tag: "AssertBoolean" }>) => Check;
  readonly AssertStringValue: (a: Extract<Assertion, { _tag: "AssertStringValue" }>) => Check;
  readonly AssertXml: (a: Extract<Assertion, { _tag: "AssertXml" }>) => Check;
  readonly Assert: (a: Extract<Assertion, { _tag: "Assert" }>) => Check;
  readonly AssertEq: (a: Extract<Assertion, { _tag: "AssertEq" }>) => Check;
  readonly AssertDeepEq: (a: Extract<Assertion, { _tag: "AssertDeepEq" }>) => Check;
  readonly AssertType: (a: Extract<Assertion, { _tag: "AssertType" }>) => Check;
  readonly AssertPermutation: (a: Extract<Assertion, { _tag: "AssertPermutation" }>) => Check;
  readonly AssertSerialization: (a: Extract<Assertion, { _tag: "AssertSerialization" }>) => Check;
  readonly SerializationMatches: (a: Extract<Assertion, { _tag: "SerializationMatches" }>) => Check;
}

type Check = Effect.Effect<Option.Option<string>>;

/** Whether a result is the single `xs:boolean` `want`. */
const singleBoolean = (sequence: XQuery.Sequence, want: boolean) => {
  const [only] = sequence;
  return sequence.length === 1 && only !== undefined && XQuery.isAtomic(only) && only.value === want
    ? pass
    : fail(`expected ${want}, got ${describeSequence(sequence)}`);
};

/** `$result` bound to a result. */
const result = (sequence: XQuery.Sequence) => [["result", sequence]] as const;

/** The assertions about a returned sequence: each fails when the query raised an error instead. */
const valueAssertions = (outcome: Outcome, context: CheckContext): ValueAssertions => {
  const onValue =
    <A>(f: (sequence: XQuery.Sequence, a: A) => Effect.Effect<Option.Option<string>>) =>
    (a: A) =>
      Outcome.$is("Value")(outcome)
        ? f(outcome.sequence, a)
        : Outcome.$is("Raised")(outcome)
          ? fail(`expected a result, got ${outcome.error.message}`)
          : fail("no result");

  return {
    AssertCount: onValue((s, { count }) =>
      s.length === count ? pass : fail(`expected ${count} items, got ${s.length}`),
    ),
    AssertBoolean: onValue((s, { expected }) => singleBoolean(s, expected)),
    AssertStringValue: onValue((s, { expected, normalizeSpace: normalize }) =>
      Result.match(stringOf(s), {
        onFailure: (reason) => fail(`assert-string-value: ${reason}`),
        onSuccess: (got) => {
          const [a, b] = normalize
            ? [normalizeSpace(got), normalizeSpace(expected)]
            : [got, expected];
          return a === b ? pass : fail(`expected string value ${show(b)}, got ${show(a)}`);
        },
      }),
    ),
    AssertXml: onValue((s, { expected, ignorePrefixes }) => assertXml(s, expected, ignorePrefixes)),
    Assert: onValue((s, { expr }) => holds(context, expr, result(s), `assert ${expr.trim()}`)),
    AssertEq: onValue((s, { expr }) =>
      holds(
        context,
        `let $expected := (${expr}) return ($result eq $expected) or ($result ne $result and $expected ne $expected)`,
        result(s),
        `assert-eq ${expr.trim()}`,
      ),
    ),
    AssertDeepEq: onValue((s, { expr }) =>
      holds(context, `deep-equal($result, (${expr}))`, result(s), `assert-deep-eq ${expr.trim()}`),
    ),
    AssertType: onValue((s, { type }) =>
      holds(context, `$result instance of ${type}`, result(s), `assert-type ${type.trim()}`),
    ),
    AssertPermutation: onValue((s, { expr }) => permutation(context, s, expr)),
    AssertSerialization: onValue((s, { expected }) =>
      serialized(context, s, (got) =>
        got === expected ? pass : fail(`serialized ${show(got)}, expected ${show(expected)}`),
      ),
    ),
    SerializationMatches: onValue((s, { regex, flags }) =>
      serialized(context, s, (got) =>
        holds(
          context,
          `matches($serialized, ${literal(regex)}, ${literal(flags)})`,
          [["serialized", [XQuery.AtomicValue.string(got)]]],
          `serialization-matches ${regex}`,
        ),
      ),
    ),
  };
};

/** A string as a JSON literal, for failure messages. */
const show = /*#__PURE__*/ Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** A short description of a sequence for failure messages. */
const describeSequence = (sequence: XQuery.Sequence): string =>
  `(${sequence
    .slice(0, 5)
    .map((item) =>
      XQuery.isAtomic(item)
        ? `${XQuery.atomicString(item)} as xs:${item.type.name}`
        : XQuery.isNode(item)
          ? `${item.kind} node`
          : item._tag,
    )
    .join(", ")}${sequence.length > 5 ? ", …" : ""})`;
