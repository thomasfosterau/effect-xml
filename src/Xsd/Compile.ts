/**
 * Compiling XML Schema documents into a {@link Model}.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import { read, type SchemaDocument } from "../internal/xsd/reader.ts";
import type { XmlElement } from "../Xml/Node.ts";
import { parse } from "../Xml/Xml.ts";
import { XsdSchemaError } from "./Error.ts";
import { XS, type Model } from "./Model.ts";

/**
 * Where {@link compile} finds the documents a schema includes and imports.
 *
 * A `schemaLocation` is resolved against the location of the document that
 * names it (as a URL when that location is one, otherwise as a `/`-separated
 * path), then looked up in `documents`, and only then passed to `resolve`.
 * Each document is read once, however often it is referred to. An `import`
 * without a `schemaLocation` loads nothing: its namespace's components must
 * come from another document.
 *
 * @since 0.3.0
 * @category options
 */
export interface CompileOptions<E = never, R = never> {
  /** The location of the schema being compiled, which relative locations are resolved against. */
  readonly location?: string | undefined;
  /** Schema documents known up front, by location. */
  readonly documents?: Readonly<Record<string, string>> | undefined;
  /** Fetch a schema document by its resolved location. */
  readonly resolve?: ((location: string) => Effect.Effect<string, E, R>) | undefined;
}

const scheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Collapse `.` and `..` segments of a `/`-separated path. */
const normalizePath = (path: string): string =>
  Arr.reduce(path.split("/"), Arr.empty<string>(), (out, segment, i) =>
    segment === "." && i > 0
      ? out
      : segment === ".." && Arr.isReadonlyArrayNonEmpty(out) && out.at(-1) !== ".."
        ? out.slice(0, -1)
        : [...out, segment],
  ).join("/");

/** Resolve a `schemaLocation` against the location of the document that names it. */
const resolveLocation = (base: string | null, relative: string): string => {
  if (base === null || scheme.test(relative)) return relative;
  if (scheme.test(base)) return new URL(relative, base).href;
  if (relative.startsWith("/")) return normalizePath(relative);
  return normalizePath(base.slice(0, base.lastIndexOf("/") + 1) + relative);
};

interface Pending {
  readonly location: string | null;
  readonly text: Option.Option<string>;
  readonly chameleon: string | undefined;
}

const ownNamespace = (root: XmlElement): string =>
  Option.getOrElse(root.attributeNS(null, "targetNamespace"), () => "");

/** The documents a schema document includes and imports. */
const referencesOf = (doc: SchemaDocument): ReadonlyArray<Pending> => {
  const own = ownNamespace(doc.root);
  const tns = own === "" ? (doc.chameleon ?? "") : own;
  return Arr.flatMap(doc.root.elements, (el): ReadonlyArray<Pending> => {
    if (el.name.namespace !== XS || (el.name.local !== "include" && el.name.local !== "import"))
      return [];
    return Arr.fromOption(
      Option.map(el.attributeNS(null, "schemaLocation"), (location) => ({
        location: resolveLocation(doc.location, location.trim()),
        text: Option.none(),
        chameleon: el.name.local === "include" && tns !== "" ? tns : undefined,
      })),
    );
  });
};

/**
 * Compile an XML Schema (XSD 1.0) into a {@link Model}, loading the documents
 * it includes and imports.
 *
 * Supported: element and attribute declarations (global and local, with
 * `form`, defaults, fixed values, `nillable` and `abstract`), simple types
 * (restriction with every facet, lists and unions), complex types (simple and
 * complex content, extension and restriction, `mixed`), `sequence` /
 * `choice` / `all` with any occurrence bounds, named model and attribute
 * groups, element and attribute wildcards, substitution groups, `block`,
 * `xsi:type`, `xsi:nil`, and identity constraints. `xs:redefine` and the
 * XSD 1.1 additions (`override`, assertions, type alternatives, open
 * content) fail with an {@link XsdSchemaError}.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xsd } from "@thomasfosterau/effect-xml"
 *
 * const schema = `
 *   <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
 *     <xs:element name="greeting" type="xs:string"/>
 *   </xs:schema>`
 *
 * const model = Effect.runSync(Xsd.compile(schema))
 * console.log(Object.keys(model.elements)) // ["greeting"]
 * ```
 *
 * @since 0.3.0
 * @category compiling
 */
export const compile = <E = never, R = never>(
  schema: string,
  options?: CompileOptions<E, R>,
): Effect.Effect<Model, XsdSchemaError | E, R> => {
  const documents = options?.documents ?? {};
  const retrieve = (location: string): Effect.Effect<string, XsdSchemaError | E, R> => {
    const known = documents[location];
    if (known !== undefined) return Effect.succeed(known);
    const resolve = options?.resolve;
    return resolve === undefined
      ? Effect.fail(
          new XsdSchemaError({
            reason: `the schema document ${location} was not given (pass it in \`documents\`, or a \`resolve\` function)`,
            location: null,
          }),
        )
      : resolve(location);
  };
  const load = (pending: Pending): Effect.Effect<SchemaDocument, XsdSchemaError | E, R> =>
    Effect.flatMap(
      Option.match(pending.text, {
        onSome: Effect.succeed,
        onNone: () => retrieve(pending.location ?? ""),
      }),
      (text) =>
        parse(text).pipe(
          Effect.mapError(
            (e) => new XsdSchemaError({ reason: e.message, location: pending.location }),
          ),
          Effect.map((doc) => ({
            location: pending.location,
            root: doc.root,
            chameleon: pending.chameleon,
          })),
        ),
    );
  const keyOf = (p: Pending) => `${p.location ?? ""}\u0000${p.chameleon ?? ""}`;
  const gather = (
    todo: ReadonlyArray<Pending>,
    done: ReadonlyArray<SchemaDocument>,
    seen: HashSet.HashSet<string>,
  ): Effect.Effect<ReadonlyArray<SchemaDocument>, XsdSchemaError | E, R> =>
    Arr.matchLeft(todo, {
      onEmpty: () => Effect.succeed(done),
      onNonEmpty: (head, tail) =>
        HashSet.has(seen, keyOf(head))
          ? gather(tail, done, seen)
          : Effect.flatMap(load(head), (doc) =>
              gather(
                [...tail, ...referencesOf(doc)],
                [...done, doc],
                HashSet.add(seen, keyOf(head)),
              ),
            ),
    });
  const entry: Pending = {
    location: options?.location ?? null,
    text: Option.some(schema),
    chameleon: undefined,
  };
  return Effect.flatMap(gather([entry], [], HashSet.empty()), (docs) =>
    Effect.fromResult(read(docs)),
  );
};
