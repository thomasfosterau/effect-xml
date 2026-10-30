/**
 * Schema-driven XML binding: decode XML into the type of an Effect `Schema`,
 * and encode values of that type back into XML. Annotations on the schema say
 * where each field lives (an attribute, a child element, or the element's own
 * text); where there is no annotation, the binding infers one.
 *
 * The rules:
 *
 *   - A struct (or `Schema.Class`) is an element. Each field is a child element
 *     named after its key, unless it is annotated with {@link attribute},
 *     {@link element} or {@link text}.
 *   - A field whose type is a struct is a nested element; an array is the
 *     repeated elements (wrapped in one element with `wrapper`); a union of
 *     structs is a choice, picked by element name (see {@link named}).
 *   - Leaf values travel as strings, through `Schema.toCodecStringTree`: a
 *     `Schema.Number`, `Schema.Boolean`, `Schema.NumberFromString` or a branded
 *     or checked string decodes from text with its own transformations and
 *     checks, and validation failures are `SchemaError`s with the field path.
 *   - A field named `_tag` holding a literal (from `Schema.TaggedStruct` or
 *     `Schema.TaggedClass`) is not in the XML: decoding fills it in, encoding
 *     leaves it out. Annotate it to bind it like any other field.
 *   - An element's name is matched by its local name, and by its namespace too
 *     when the annotation gives one. Unannotated attributes are in no
 *     namespace. On encode, an element without a namespace of its own takes
 *     its parent's, and the `Writer` declares the namespaces used.
 *   - Elements, attributes and text the schema doesn't mention are ignored.
 *
 * @since 0.3.0
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { memoize } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import type { SaxError } from "../Error.ts";
import { Namespaces, QName } from "../Name.ts";
import { XmlAttribute, XmlCData, XmlElement, XmlText, type XmlNode } from "./Node.ts";
import { serialize, type SerializationError, type WriterOptions } from "./Writer.ts";
import { parse, type ParseOptions } from "./Xml.ts";

// -----------------------------------------------------------------------------
// Annotations
// -----------------------------------------------------------------------------

/**
 * The annotation key under which a field's {@link FieldBinding} is stored.
 *
 * @since 0.3.0
 * @category annotations
 */
export const FieldBindingId = "@thomasfosterau/effect-xml/Xml/Bind/field";

/**
 * The annotation key under which a type's {@link ElementName} is stored.
 *
 * @since 0.3.0
 * @category annotations
 */
export const ElementNameId = "@thomasfosterau/effect-xml/Xml/Bind/name";

/**
 * Where a field lives in its element: an attribute, a child element, or the element's own text.
 *
 * @since 0.3.0
 * @category annotations
 */
export interface FieldBinding {
  readonly node: "attribute" | "element" | "text";
  /** The XML name, if not the field's key. `xml:lang`-style names are in the `xml:` namespace. */
  readonly name?: string | undefined;
  /** The namespace URI (`null` for none). Left out, see the module docs. */
  readonly namespace?: string | null | undefined;
  /** The prefix to write the name with (the `Writer` picks one if a namespaced attribute has none). */
  readonly prefix?: string | undefined;
  /** For elements: the name of one element wrapping the field's elements. */
  readonly wrapper?: string | undefined;
}

/**
 * The element name of a struct type: used when it is the document's root and to pick it out of a union.
 *
 * @since 0.3.0
 * @category annotations
 */
export interface ElementName {
  readonly name: string;
  /** The namespace URI (`null` for none). Left out, the name matches in any namespace. */
  readonly namespace?: string | null | undefined;
  /** The prefix to write the name with (default: none, declaring a default namespace). */
  readonly prefix?: string | undefined;
}

/**
 * Options naming an attribute or element: a name, a namespace and a prefix.
 *
 * @since 0.3.0
 * @category annotations
 */
export interface NameOptions {
  readonly name?: string | undefined;
  readonly namespace?: string | null | undefined;
  readonly prefix?: string | undefined;
}

/**
 * Options for {@link element}: a name, a namespace, a prefix and a wrapper element.
 *
 * @since 0.3.0
 * @category annotations
 */
export interface ElementOptions extends NameOptions {
  /** Wrap the field's elements in one element with this name (`<tags><tag/>…</tags>`). */
  readonly wrapper?: string | undefined;
}

const toOptions = (nameOrOptions: string | ElementOptions | undefined): ElementOptions =>
  Predicate.isString(nameOrOptions) ? { name: nameOrOptions } : (nameOrOptions ?? {});

const fieldBinding = (node: FieldBinding["node"], options: ElementOptions): FieldBinding => ({
  node,
  name: options.name,
  namespace: options.namespace,
  prefix: options.prefix,
  wrapper: options.wrapper,
});

/**
 * The annotation records behind {@link attribute}, {@link element}, {@link text} and {@link named}, for the `annotations` argument of `Schema.Class` and friends.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * class Book extends Schema.Class<Book>("Book")(
 *   { title: Schema.String },
 *   Xml.Bind.annotations.named("book")
 * ) {}
 *
 * const book = Effect.runSync(Xml.Bind.decode(Book)(`<book><title>Dune</title></book>`))
 * console.log(book.title) // "Dune"
 * ```
 *
 * @since 0.3.0
 * @category annotations
 */
export const annotations = {
  /** Bind a field to an attribute (see {@link attribute}). */
  attribute: (nameOrOptions?: string | NameOptions) => ({
    [FieldBindingId]: fieldBinding("attribute", toOptions(nameOrOptions)),
  }),
  /** Bind a field to child elements (see {@link element}). */
  element: (nameOrOptions?: string | ElementOptions) => ({
    [FieldBindingId]: fieldBinding("element", toOptions(nameOrOptions)),
  }),
  /** Bind a field to the element's text (see {@link text}). */
  text: () => ({ [FieldBindingId]: fieldBinding("text", {}) }),
  /** Name a struct type's element (see {@link named}). */
  named: (nameOrOptions: string | (NameOptions & { readonly name: string })) => {
    const options = toOptions(nameOrOptions);
    const name: ElementName = {
      name: options.name ?? "",
      namespace: options.namespace,
      prefix: options.prefix,
    };
    return { [ElementNameId]: name };
  },
};

/**
 * Bind a field to an attribute of its element, named after the field's key unless named here. An array of leaves is a whitespace-separated list.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const Item = Schema.Struct({
 *   sku: Schema.String.pipe(Xml.Bind.attribute()),
 *   quantity: Schema.NumberFromString.pipe(Xml.Bind.attribute("qty")),
 *   name: Schema.String
 * }).pipe(Xml.Bind.named("item"))
 *
 * const item = Effect.runSync(
 *   Xml.Bind.decode(Item)(`<item sku="A-1" qty="3"><name>Widget</name></item>`)
 * )
 * console.log(item) // { sku: "A-1", quantity: 3, name: "Widget" }
 * ```
 *
 * @since 0.3.0
 * @category annotations
 */
export const attribute =
  (nameOrOptions?: string | NameOptions) =>
  <S extends Schema.Top>(self: S): S["Rebuild"] =>
    self.annotate(annotations.attribute(nameOrOptions));

/**
 * Bind a field to child elements: the default, so it is needed only to rename them, give them a namespace or wrap them.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const Post = Schema.Struct({
 *   tags: Schema.Array(Schema.String).pipe(Xml.Bind.element({ name: "tag", wrapper: "tags" }))
 * }).pipe(Xml.Bind.named("post"))
 *
 * const post = Effect.runSync(
 *   Xml.Bind.decode(Post)(`<post><tags><tag>xml</tag><tag>effect</tag></tags></post>`)
 * )
 * console.log(post.tags) // ["xml", "effect"]
 * ```
 *
 * @since 0.3.0
 * @category annotations
 */
export const element =
  (nameOrOptions?: string | ElementOptions) =>
  <S extends Schema.Top>(self: S): S["Rebuild"] =>
    self.annotate(annotations.element(nameOrOptions));

/**
 * Bind a field to its element's own text: the text and CDATA directly inside it, not inside its child elements.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const Price = Schema.Struct({
 *   currency: Schema.String.pipe(Xml.Bind.attribute()),
 *   amount: Schema.NumberFromString.pipe(Xml.Bind.text())
 * }).pipe(Xml.Bind.named("price"))
 *
 * const price = Effect.runSync(Xml.Bind.decode(Price)(`<price currency="EUR">9.5</price>`))
 * console.log(price) // { currency: "EUR", amount: 9.5 }
 * ```
 *
 * @since 0.3.0
 * @category annotations
 */
export const text =
  () =>
  <S extends Schema.Top>(self: S): S["Rebuild"] =>
    self.annotate(annotations.text());

/**
 * Name a struct type's element. The name is checked on the document's root
 * and picks a member out of a union of structs; a field still names its own
 * element after its key. Without it, encoding names the element after the
 * schema's `identifier` (a `Schema.Class`'s name) or its `_tag`.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const Circle = Schema.TaggedStruct("Circle", {
 *   r: Schema.NumberFromString.pipe(Xml.Bind.attribute())
 * }).pipe(Xml.Bind.named("circle"))
 * const Square = Schema.TaggedStruct("Square", {
 *   side: Schema.NumberFromString.pipe(Xml.Bind.attribute())
 * }).pipe(Xml.Bind.named("square"))
 * const Drawing = Schema.Struct({
 *   shapes: Schema.Array(Schema.Union([Circle, Square]))
 * }).pipe(Xml.Bind.named("drawing"))
 *
 * const drawing = Effect.runSync(
 *   Xml.Bind.decode(Drawing)(`<drawing><circle r="1"/><square side="2"/></drawing>`)
 * )
 * console.log(drawing.shapes) // [{ _tag: "Circle", r: 1 }, { _tag: "Square", side: 2 }]
 * ```
 *
 * @since 0.3.0
 * @category annotations
 */
export const named =
  (nameOrOptions: string | (NameOptions & { readonly name: string })) =>
  <S extends Schema.Top>(self: S): S["Rebuild"] =>
    self.annotate(annotations.named(nameOrOptions));

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * XML that doesn't fit the schema's shape (a root element with the wrong name, an element no union member is named for), or a schema the binding can't map to XML.
 *
 * @since 0.3.0
 * @category errors
 */
export class XmlBindError extends Schema.TaggedError<XmlBindError>()("XmlBindError", {
  /** The field keys and array indices leading to the problem. */
  path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  reason: Schema.String,
}) {
  override get message(): string {
    const at = Arr.isReadonlyArrayNonEmpty(this.path) ? ` at ${this.path.join(".")}` : "";
    return `Cannot bind XML${at}: ${this.reason}`;
  }
}

type Path = ReadonlyArray<string | number>;

const failAt = (path: Path, reason: string) => Result.fail(new XmlBindError({ path, reason }));

const under =
  (prefix: Path) =>
  (e: XmlBindError): XmlBindError =>
    new XmlBindError({ path: [...prefix, ...e.path], reason: e.reason });

// -----------------------------------------------------------------------------
// Compiling a schema into a plan
// -----------------------------------------------------------------------------

/**
 * How one value maps to XML. Plans are compiled from the encoded side of
 * `Schema.toCodecStringTree(schema)`, where every leaf is a string, so the XML
 * side only moves strings and the schema does every conversion.
 */
type Plan = Data.TaggedEnum<{
  /** A string: an attribute value, an element's text content. `literal` is a single string literal's value. */
  Leaf: { readonly literal: string | undefined };
  Struct: { readonly struct: StructPlan };
  List: { readonly item: Plan };
  /** A union of structs, told apart by element name (decoding) or by encoded shape (encoding). */
  Choice: { readonly members: ReadonlyArray<Member> };
}>;
const Plan = Data.taggedEnum<Plan>();

interface StructPlan {
  /** The {@link named} annotation, if any. */
  readonly named: ElementName | undefined;
  /** The name to write the element with when nothing else names it: {@link named}, the identifier, or the `_tag`. */
  readonly defaultName: string | undefined;
  /** The fields, compiled on first use so recursive schemas compile lazily. */
  readonly fields: () => Result.Result<ReadonlyArray<FieldPlan>, XmlBindError>;
}

interface Member {
  readonly struct: StructPlan;
  /** Is an encoded value this member's? */
  readonly is: (u: Schema.StringTree) => boolean;
}

interface FieldPlan {
  readonly key: string;
  readonly node: FieldBinding["node"];
  readonly local: string;
  /** `undefined`: an element matches in any namespace, an attribute in none. */
  readonly namespace: string | null | undefined;
  readonly prefix: string | null;
  readonly wrapper: string | undefined;
  readonly plan: Plan;
  /** A `_tag` literal filled in on decode and left out on encode. */
  readonly implicit: string | undefined;
}

/** A schema node with its encodings and suspensions followed, and the bindings found on the way. */
interface Resolved {
  readonly ast: SchemaAST.AST;
  readonly field: FieldBinding | undefined;
  readonly named: ElementName | undefined;
  readonly identifier: string | undefined;
}

/** The value each binding annotation key carries. */
interface BindingAnnotations {
  readonly [FieldBindingId]: FieldBinding;
  readonly [ElementNameId]: ElementName;
}

const annotationAt = <K extends keyof BindingAnnotations>(
  ast: SchemaAST.AST,
  key: K,
): BindingAnnotations[K] | undefined => {
  const found = ast.context?.annotations?.[key] ?? SchemaAST.resolve(ast)?.[key];
  // SAFETY: the values under the binding keys are only written by `annotations`.
  return found as BindingAnnotations[K] | undefined;
};

/** `outer`'s value unless it was left out. */
const over = <A>(outer: A | undefined, inner: A | undefined): A | undefined =>
  outer === undefined ? inner : outer;

/** Merge two field bindings member by member, the outer annotation winning. */
const mergeField = (
  outer: FieldBinding | undefined,
  inner: FieldBinding | undefined,
): FieldBinding | undefined =>
  outer === undefined || inner === undefined
    ? (outer ?? inner)
    : {
        node: outer.node,
        name: over(outer.name, inner.name),
        namespace: over(outer.namespace, inner.namespace),
        prefix: over(outer.prefix, inner.prefix),
        wrapper: over(outer.wrapper, inner.wrapper),
      };

const resolve = (ast: SchemaAST.AST, outer?: Omit<Resolved, "ast">): Resolved => {
  const here = {
    field: mergeField(outer?.field, annotationAt(ast, FieldBindingId)),
    named: outer?.named ?? annotationAt(ast, ElementNameId),
    identifier: outer?.identifier ?? SchemaAST.resolveIdentifier(ast),
  };
  if (ast.encoding !== undefined) return resolve(Arr.lastNonEmpty(ast.encoding).to, here);
  if (SchemaAST.isSuspend(ast)) return resolve(ast.thunk(), here);
  return { ...here, ast };
};

/** A compiled schema node: its plan and the field binding found on it. */
interface Compiled {
  readonly plan: Plan;
  readonly field: FieldBinding | undefined;
}

const isAbsent = (ast: SchemaAST.AST): boolean => {
  const resolved = resolve(ast).ast;
  return SchemaAST.isUndefined(resolved) || SchemaAST.isVoid(resolved);
};

const isLeaf = (plan: Plan): boolean => Plan.$is("Leaf")(plan);

const tagLiteral = (ast: SchemaAST.Objects): string | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(ast.propertySignatures, (ps) => {
      if (ps.name !== "_tag") return Option.none();
      const resolved = resolve(ps.type).ast;
      return SchemaAST.isLiteral(resolved) && Predicate.isString(resolved.literal)
        ? Option.some(resolved.literal)
        : Option.none();
    }),
  );

const compile = memoize((ast: SchemaAST.AST): Result.Result<Compiled, XmlBindError> => {
  const r = resolve(ast);
  const node = r.ast;
  const done = (plan: Plan) => Result.succeed({ plan, field: r.field });
  if (SchemaAST.isUnion(node)) return compileUnion(node, r);
  if (SchemaAST.isLiteral(node))
    return done(
      Plan.Leaf({ literal: Predicate.isString(node.literal) ? node.literal : undefined }),
    );
  if (
    SchemaAST.isString(node) ||
    SchemaAST.isTemplateLiteral(node) ||
    SchemaAST.isEnum(node) ||
    SchemaAST.isUndefined(node) ||
    SchemaAST.isVoid(node)
  )
    return done(Plan.Leaf({ literal: undefined }));
  if (SchemaAST.isObjects(node)) {
    if (Arr.isReadonlyArrayNonEmpty(node.indexSignatures))
      return failAt([], "records (index signatures) have no XML mapping");
    const struct: StructPlan = {
      named: r.named,
      defaultName: r.named?.name ?? r.identifier ?? tagLiteral(node),
      fields: () => compileFields(node),
    };
    return done(Plan.Struct({ struct }));
  }
  if (SchemaAST.isArrays(node)) {
    const [item, ...more] = node.rest;
    if (
      Arr.isReadonlyArrayNonEmpty(node.elements) ||
      item === undefined ||
      Arr.isArrayNonEmpty(more)
    )
      return failAt([], "tuples have no XML mapping; use an array");
    return Result.flatMap(compile(item), (c) =>
      Plan.$is("List")(c.plan)
        ? failAt([], "an array of arrays has no XML mapping; wrap the inner array in a struct")
        : done(Plan.List({ item: c.plan })),
    );
  }
  return failAt([], `a ${node._tag} schema has no XML mapping`);
});

const compileUnion = (
  node: SchemaAST.Union,
  r: Resolved,
): Result.Result<Compiled, XmlBindError> => {
  const present = Arr.filter(node.types, (t) => !isAbsent(t));
  const [only, ...others] = present;
  // `Schema.optional(X)` is `X | undefined`: X, with the union's bindings over its own.
  if (only !== undefined && !Arr.isArrayNonEmpty(others))
    return Result.map(compile(only), (c) => ({
      plan: c.plan,
      field: mergeField(r.field, c.field),
    }));
  return Result.flatMap(
    Result.all(Arr.map(present, compile)),
    (members): Result.Result<Compiled, XmlBindError> => {
      if (Arr.every(members, (m) => isLeaf(m.plan)))
        return Result.succeed({ plan: Plan.Leaf({ literal: undefined }), field: r.field });
      const structs = Arr.filterMap(Arr.zip(present, members), ([ast, m]) =>
        Plan.$match(m.plan, {
          Struct: ({ struct }): Result.Result<Member, undefined> =>
            Result.succeed({ struct, is: Schema.is(Schema.make(SchemaAST.toEncoded(ast))) }),
          Leaf: () => Result.fail(undefined),
          List: () => Result.fail(undefined),
          Choice: () => Result.fail(undefined),
        }),
      );
      return structs.length === members.length
        ? Result.succeed({ plan: Plan.Choice({ members: structs }), field: r.field })
        : failAt([], "a union must be all structs (a choice of elements) or all leaves");
    },
  );
};

/** Split `prefix:local`; the `xml:` prefix brings its namespace. */
const splitName = (
  raw: string,
  namespace: string | null | undefined,
  prefix: string | undefined,
): Result.Result<
  Omit<FieldPlan, "key" | "node" | "wrapper" | "plan" | "implicit">,
  XmlBindError
> => {
  const idx = raw.indexOf(":");
  if (idx < 0) return Result.succeed({ local: raw, namespace, prefix: prefix ?? null });
  const written = raw.slice(0, idx);
  const local = raw.slice(idx + 1);
  if (written === "xml")
    return Result.succeed({ local, namespace: namespace ?? Namespaces.xml, prefix: written });
  return namespace === undefined
    ? failAt([], `the name "${raw}" has a prefix but no namespace`)
    : Result.succeed({ local, namespace, prefix: prefix ?? written });
};

const compileField = (ps: SchemaAST.PropertySignature): Result.Result<FieldPlan, XmlBindError> => {
  const key = ps.name;
  if (!Predicate.isString(key)) return failAt([], "symbol keys have no XML mapping");
  return Result.gen(function* () {
    const c = yield* compile(ps.type);
    const binding = c.field;
    const node = binding?.node ?? "element";
    const names = yield* splitName(binding?.name ?? key, binding?.namespace, binding?.prefix);
    const leaf = Plan.$is("Leaf")(c.plan) ? c.plan : undefined;
    const implicit = key === "_tag" && binding === undefined ? leaf?.literal : undefined;
    if (node === "text" && leaf === undefined)
      return yield* failAt([], "only a leaf (a string, number, …) can be an element's text");
    if (
      node === "attribute" &&
      leaf === undefined &&
      !(Plan.$is("List")(c.plan) && isLeaf(c.plan.item))
    )
      return yield* failAt([], "only a leaf or an array of leaves can be an attribute");
    return { key, node, ...names, wrapper: binding?.wrapper, plan: c.plan, implicit };
  }).pipe(Result.mapError(under([key])));
};

const compileFields = memoize(
  (ast: SchemaAST.Objects): Result.Result<ReadonlyArray<FieldPlan>, XmlBindError> =>
    Result.all(Arr.map(ast.propertySignatures, compileField)),
);

/** The plan of a document's root: a struct, or a choice of structs. */
const compileRoot = (ast: SchemaAST.AST): Result.Result<Plan, XmlBindError> =>
  Result.flatMap(compile(ast), (c) =>
    Plan.$is("Struct")(c.plan) || Plan.$is("Choice")(c.plan)
      ? Result.succeed(c.plan)
      : failAt([], "the root of a document must be a struct, a class, or a union of them"),
  );

// -----------------------------------------------------------------------------
// Decoding: XML → string tree
// -----------------------------------------------------------------------------

type Tree = Schema.StringTree;
type Read = Result.Result<Tree, XmlBindError>;

const matchesName = (el: XmlElement, local: string, namespace: string | null | undefined) =>
  el.name.local === local && (namespace === undefined || el.name.namespace === namespace);

const matchesNamed = (el: XmlElement, struct: StructPlan) =>
  struct.named === undefined
    ? struct.defaultName !== undefined && el.name.local === struct.defaultName
    : matchesName(el, struct.named.name, struct.named.namespace);

const childElements = (el: XmlElement, accept: (child: XmlElement) => boolean) =>
  Arr.filter(el.elements, accept);

const memberOf = (members: ReadonlyArray<Member>, el: XmlElement) =>
  Arr.findFirst(members, (m) => matchesNamed(el, m.struct));

const ownText = (el: XmlElement): string =>
  Arr.reduce(el.children, "", (out, node) =>
    node instanceof XmlText || node instanceof XmlCData ? out + node.data : out,
  );

const describe = (el: XmlElement) => `<${el.name.qualified}>`;

const readElement = (plan: Plan, el: XmlElement, path: Path): Read =>
  Plan.$match(plan, {
    Leaf: (): Read => Result.succeed(el.textContent),
    Struct: ({ struct }) => readStruct(struct, el, path),
    List: () => failAt(path, "an array must be a field of a struct"),
    Choice: ({ members }) =>
      Option.match(memberOf(members, el), {
        onNone: () => failAt(path, `no member of the union is named ${describe(el)}`),
        onSome: (m) => readStruct(m.struct, el, path),
      }),
  });

const readStruct = (struct: StructPlan, el: XmlElement, path: Path): Read =>
  Result.gen(function* () {
    const fields = yield* struct.fields().pipe(Result.mapError(under(path)));
    const entries = yield* Result.all(Arr.map(fields, (f) => readField(f, el, [...path, f.key])));
    return Record.fromEntries(Arr.getSomes(entries));
  });

/** Does `child` belong to a field of this plan? A choice's elements are named by its members. */
const accepts = (f: FieldPlan, plan: Plan) => (child: XmlElement) =>
  Plan.$is("Choice")(plan)
    ? Option.isSome(memberOf(plan.members, child))
    : matchesName(child, f.local, f.namespace);

const readField = (
  f: FieldPlan,
  el: XmlElement,
  path: Path,
): Result.Result<Option.Option<readonly [string, Tree]>, XmlBindError> => {
  const entry = (value: Tree) => Option.some([f.key, value] as const);
  if (f.implicit !== undefined) return Result.succeed(entry(f.implicit));
  if (f.node === "text") return Result.succeed(entry(ownText(el)));
  if (f.node === "attribute") {
    const value = el.attributeNS(f.namespace ?? null, f.local);
    return Result.succeed(
      Option.flatMap(value, (v) =>
        entry(Plan.$is("List")(f.plan) ? Arr.filter(v.split(/\s+/), (s) => s !== "") : v),
      ),
    );
  }
  const container =
    f.wrapper === undefined
      ? Option.some(el)
      : Arr.findFirst(el.elements, (c) => matchesName(c, f.wrapper ?? "", f.namespace));
  return Option.match(container, {
    onNone: () => Result.succeed(Option.none()),
    onSome: (parent) => {
      if (Plan.$is("List")(f.plan)) {
        const item = f.plan.item;
        const children = childElements(parent, accepts(f, item));
        return Result.map(
          Result.all(Arr.map(children, (child, i) => readElement(item, child, [...path, i]))),
          entry,
        );
      }
      const plan = f.plan;
      return Option.match(Arr.findFirst(parent.elements, accepts(f, plan)), {
        onNone: () => Result.succeed(Option.none()),
        onSome: (child) => Result.map(readElement(plan, child, path), entry),
      });
    },
  });
};

const readRoot = (plan: Plan, el: XmlElement): Read =>
  Plan.$is("Struct")(plan) &&
  plan.struct.named !== undefined &&
  !matchesName(el, plan.struct.named.name, plan.struct.named.namespace)
    ? failAt([], `expected the element <${plan.struct.named.name}> but found ${describe(el)}`)
    : readElement(plan, el, []);

// -----------------------------------------------------------------------------
// Encoding: string tree → XML
// -----------------------------------------------------------------------------

type Written = Result.Result<ReadonlyArray<XmlNode>, XmlBindError>;

interface Content {
  readonly attributes: ReadonlyArray<XmlAttribute>;
  readonly children: ReadonlyArray<XmlNode>;
}

const asString = (value: Tree, path: Path): Result.Result<string, XmlBindError> =>
  Predicate.isString(value) ? Result.succeed(value) : failAt(path, "expected a string leaf");

const isList = (value: Tree): value is ReadonlyArray<Tree> => Arr.isArray(value);

const asList = (value: Tree, path: Path): Result.Result<ReadonlyArray<Tree>, XmlBindError> =>
  isList(value) ? Result.succeed(value) : failAt(path, "expected an array");

const asRecord = (
  value: Tree,
  path: Path,
): Result.Result<Record.ReadonlyRecord<string, Tree>, XmlBindError> =>
  Predicate.isObject(value) && !isList(value)
    ? // SAFETY: a non-array object in a string tree is a record of string trees.
      Result.succeed(value as Record.ReadonlyRecord<string, Tree>)
    : failAt(path, "expected an object");

const elementName = (struct: StructPlan, inherited: string | null, path: Path) =>
  struct.defaultName === undefined
    ? failAt(path, "the element has no name: annotate it with Xml.Bind.named")
    : Result.succeed(
        new QName({
          prefix: struct.named?.prefix ?? null,
          local: struct.defaultName,
          namespace: struct.named?.namespace === undefined ? inherited : struct.named.namespace,
        }),
      );

const writeStruct = (
  struct: StructPlan,
  value: Tree,
  name: QName,
  path: Path,
): Result.Result<XmlElement, XmlBindError> =>
  Result.gen(function* () {
    const fields = yield* struct.fields().pipe(Result.mapError(under(path)));
    const record = yield* asRecord(value, path);
    const parts = yield* Result.all(
      Arr.map(fields, (f) => writeField(f, record[f.key], name.namespace, [...path, f.key])),
    );
    return new XmlElement({
      name,
      attributes: Arr.flatMap(parts, (p) => p.attributes),
      children: Arr.flatMap(parts, (p) => p.children),
    });
  });

const nothing: Content = { attributes: [], children: [] };

const writeField = (
  f: FieldPlan,
  value: Tree | undefined,
  inherited: string | null,
  path: Path,
): Result.Result<Content, XmlBindError> => {
  if (value === undefined || f.implicit !== undefined) return Result.succeed(nothing);
  if (f.node === "attribute") {
    const written = isList(value)
      ? Result.map(Result.all(Arr.map(value, (v, i) => asString(v, [...path, i]))), Arr.join(" "))
      : asString(value, path);
    return Result.map(written, (v) => ({
      attributes: [
        new XmlAttribute({
          name: new QName({ prefix: f.prefix, local: f.local, namespace: f.namespace ?? null }),
          value: v,
        }),
      ],
      children: [],
    }));
  }
  if (f.node === "text")
    return Result.map(asString(value, path), (v) => ({
      attributes: [],
      children: [new XmlText({ data: v })],
    }));
  const namespace = f.namespace === undefined ? inherited : f.namespace;
  const items = Plan.$is("List")(f.plan)
    ? Result.flatMap(asList(value, path), (list) =>
        Result.map(
          Result.all(
            Arr.map(list, (v, i) =>
              writeItem(f, Plan.$is("List")(f.plan) ? f.plan.item : f.plan, v, namespace, [
                ...path,
                i,
              ]),
            ),
          ),
          Arr.flatten,
        ),
      )
    : writeItem(f, f.plan, value, namespace, path);
  return Result.map(items, (children) => ({
    attributes: [],
    children:
      f.wrapper === undefined
        ? children
        : [
            new XmlElement({
              name: new QName({ prefix: f.prefix, local: f.wrapper, namespace }),
              attributes: [],
              children,
            }),
          ],
  }));
};

const writeItem = (
  f: FieldPlan,
  plan: Plan,
  value: Tree,
  namespace: string | null,
  path: Path,
): Written => {
  const name = (inner: string | null | undefined) =>
    new QName({
      prefix: f.prefix,
      local: f.local,
      namespace: f.namespace === undefined && inner !== undefined ? inner : namespace,
    });
  return Plan.$match(plan, {
    Leaf: (): Written =>
      Result.map(asString(value, path), (v) => [
        new XmlElement({
          name: name(undefined),
          attributes: [],
          children: [new XmlText({ data: v })],
        }),
      ]),
    Struct: ({ struct }) =>
      Result.map(writeStruct(struct, value, name(struct.named?.namespace), path), Arr.of),
    List: () => failAt(path, "an array of arrays has no XML mapping"),
    Choice: ({ members }) => Result.map(writeChoice(members, value, namespace, path), Arr.of),
  });
};

const writeChoice = (
  members: ReadonlyArray<Member>,
  value: Tree,
  inherited: string | null,
  path: Path,
): Result.Result<XmlElement, XmlBindError> =>
  Option.match(
    Arr.findFirst(members, (m) => m.is(value)),
    {
      onNone: () => failAt(path, "the value matches no member of the union"),
      onSome: (m) =>
        Result.flatMap(elementName(m.struct, inherited, path), (name) =>
          writeStruct(m.struct, value, name, path),
        ),
    },
  );

const writeRoot = (plan: Plan, value: Tree): Result.Result<XmlElement, XmlBindError> =>
  Plan.$match(plan, {
    Struct: ({ struct }) =>
      Result.flatMap(elementName(struct, null, []), (name) => writeStruct(struct, value, name, [])),
    Choice: ({ members }) => writeChoice(members, value, null, []),
    Leaf: () => failAt([], "the root of a document must be a struct"),
    List: () => failAt([], "the root of a document must be a struct"),
  });

// -----------------------------------------------------------------------------
// The public API
// -----------------------------------------------------------------------------

/**
 * Decode an element (a parsed document's root, or a subtree from `Sax.select`) into the schema's type.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import * as Stream from "effect/Stream"
 * import { Sax, Xml } from "@thomasfosterau/effect-xml"
 *
 * const Row = Schema.Struct({
 *   r: Schema.NumberFromString.pipe(Xml.Bind.attribute()),
 *   v: Schema.String
 * })
 *
 * const rows = Stream.make(`<sheet><row r="1"><v>a</v></row><row r="2"><v>b</v></row></sheet>`).pipe(
 *   Sax.tokenize(),
 *   Sax.select("/sheet/row"),
 *   Stream.mapEffect(Xml.Bind.decodeElement(Row)),
 *   Stream.runCollect
 * )
 * console.log(Effect.runSync(rows)) // [{ r: 1, v: "a" }, { r: 2, v: "b" }]
 * ```
 *
 * @since 0.3.0
 * @category decoding
 */
export const decodeElement = <S extends Schema.Top>(
  schema: S,
  options?: SchemaAST.ParseOptions,
): ((
  element: XmlElement,
) => Effect.Effect<S["Type"], XmlBindError | Schema.SchemaError, S["DecodingServices"]>) => {
  const codec = Schema.toCodecStringTree(schema);
  const decodeTree = Schema.decodeUnknownEffect(codec, options);
  return (element) =>
    Effect.suspend(() =>
      Result.match(
        Result.flatMap(compileRoot(codec.ast), (plan) => readRoot(plan, element)),
        {
          onFailure: (
            e,
          ): Effect.Effect<S["Type"], XmlBindError | Schema.SchemaError, S["DecodingServices"]> =>
            Effect.fail(e),
          onSuccess: (tree) => decodeTree(tree),
        },
      ),
    );
};

/**
 * Options for {@link decode}: the XML parse options, plus the schema's parse options.
 *
 * @since 0.3.0
 * @category options
 */
export interface DecodeOptions extends ParseOptions {
  /** Options for the schema decode (`errors: "all"`, `onExcessProperty`, …). */
  readonly schemaOptions?: SchemaAST.ParseOptions | undefined;
}

/**
 * Parse an XML string and decode its root element into the schema's type.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * class Author extends Schema.Class<Author>("Author")({
 *   id: Schema.String.pipe(Xml.Bind.attribute()),
 *   name: Schema.String
 * }) {}
 *
 * class Book extends Schema.Class<Book>("Book")(
 *   {
 *     isbn: Schema.String.pipe(Xml.Bind.attribute()),
 *     title: Schema.String,
 *     year: Schema.NumberFromString,
 *     authors: Schema.Array(Author).pipe(Xml.Bind.element("author")),
 *     subtitle: Schema.optional(Schema.String)
 *   },
 *   Xml.Bind.annotations.named("book")
 * ) {}
 *
 * const book = Effect.runSync(
 *   Xml.Bind.decode(Book)(
 *     `<book isbn="978-0441013593">
 *        <title>Dune</title>
 *        <year>1965</year>
 *        <author id="fh"><name>Frank Herbert</name></author>
 *      </book>`
 *   )
 * )
 * console.log(book.year, book.authors[0]?.name) // 1965 "Frank Herbert"
 * ```
 *
 * @since 0.3.0
 * @category decoding
 */
export const decode = <S extends Schema.Top>(
  schema: S,
  options?: DecodeOptions,
): ((
  input: string,
) => Effect.Effect<
  S["Type"],
  SaxError | XmlBindError | Schema.SchemaError,
  S["DecodingServices"]
>) => {
  const decodeRoot = decodeElement(schema, options?.schemaOptions);
  return (input) => Effect.flatMap(parse(input, options), (doc) => decodeRoot(doc.root));
};

/**
 * Encode a value of the schema's type into an element.
 *
 * @since 0.3.0
 * @category encoding
 */
export const encodeElement = <S extends Schema.Top>(
  schema: S,
  options?: SchemaAST.ParseOptions,
): ((
  value: S["Type"],
) => Effect.Effect<XmlElement, XmlBindError | Schema.SchemaError, S["EncodingServices"]>) => {
  const codec = Schema.toCodecStringTree(schema);
  const encodeTree = Schema.encodeUnknownEffect(codec, options);
  return (value) =>
    Effect.flatMap(encodeTree(value), (tree) =>
      Effect.fromResult(Result.flatMap(compileRoot(codec.ast), (plan) => writeRoot(plan, tree))),
    );
};

/**
 * Options for {@link encode}: the writer's options, plus the schema's parse options.
 *
 * @since 0.3.0
 * @category options
 */
export interface EncodeOptions extends WriterOptions {
  /** Options for the schema encode. */
  readonly schemaOptions?: SchemaAST.ParseOptions | undefined;
}

/**
 * Encode a value of the schema's type as an XML string, declaring the namespaces it uses.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const Note = Schema.Struct({
 *   id: Schema.Number.pipe(Xml.Bind.attribute()),
 *   to: Schema.String,
 *   body: Schema.String
 * }).pipe(Xml.Bind.named({ name: "note", namespace: "urn:notes" }))
 *
 * const xml = Effect.runSync(Xml.Bind.encode(Note)({ id: 1, to: "Tove", body: "Hi" }))
 * console.log(xml) // <note xmlns="urn:notes" id="1"><to>Tove</to><body>Hi</body></note>
 * ```
 *
 * @since 0.3.0
 * @category encoding
 */
export const encode = <S extends Schema.Top>(
  schema: S,
  options?: EncodeOptions,
): ((
  value: S["Type"],
) => Effect.Effect<
  string,
  XmlBindError | Schema.SchemaError | SerializationError,
  S["EncodingServices"]
>) => {
  const toElement = encodeElement(schema, options?.schemaOptions);
  return (value) => Effect.flatMap(toElement(value), (el) => serialize(el, options));
};
