/**
 * XQuery's node constructors (XQuery 3.1 §3.9): direct and computed element,
 * attribute, text, document, comment, processing-instruction and namespace
 * constructors.
 *
 * A constructor builds an immutable DOM value with `internal/nodes.ts` and
 * hands it out as the root of a new XDM tree, so every node it makes has a
 * fresh identity and nodes in its content are copies. In-scope namespaces
 * are carried by the DOM as XML carries them: namespace declaration
 * attributes on an element, and the bindings its own name and attributes
 * use. Each constructed element declares every binding it makes
 * (namespace fixup), and copying an element into a new parent adds what the
 * copy-namespaces mode asks of it: `xmlns=""` where an unprefixed name in no
 * namespace would otherwise inherit a default namespace, and, under
 * `no-inherit`, an undeclaration (`xmlns:p=""`) for each binding of the new
 * parent the copy does not have itself.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Iterable from "effect/Iterable";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { isValidNCName, QName } from "../../../Name.ts";
import type { XmlAttribute, XmlElement, XmlNode } from "../../../Xml/Node.ts";
import * as Nodes from "../../nodes.ts";
import { isEnter, preorder } from "../../tree.ts";
import { atomicString, type AtomicValue } from "../atomic.ts";
import { ArrayItem, atomize, isAtomic, isNode, type Sequence } from "../item.ts";
import { XdmNode, type NamespaceBinding, type NodeOptions } from "../node.ts";
import { elementScope } from "../parser/analyze.ts";
import type { DirNamespace, EQName, Expr as ExprT } from "../parser/ast.ts";
import { ComputedName, ComputedNCName, Expr } from "../parser/ast.ts";
import { Namespaces } from "../parser/builtins.ts";
import { AtomicTypes, derivesFrom } from "../types.ts";
import { raise, unwrap } from "./raise.ts";
import type { Code, Ctx } from "./runtime.ts";
import { resolve, type Scope } from "./scope.ts";
import { maybe } from "../../optional.ts";

/** The evaluator's expression compiler, passed in to avoid an import cycle. */
type CompileExpr = (e: ExprT, scope: Scope) => Code;

type DirElementT = Extract<ExprT, { readonly _tag: "DirElement" }>;

/** A prefix and the URI it is bound to (`""` for the default namespace, or an undeclaration). */
type Bindings = Array<readonly [prefix: string, uri: string]>;

/** The static context's construction settings, read once per constructor. */
interface Modes {
  /** `declare boundary-space strip` (the default): boundary whitespace is dropped. */
  readonly strip: boolean;
  /** `copy-namespaces preserve` (the default): a copied element keeps all its in-scope namespaces. */
  readonly preserve: boolean;
  /** `copy-namespaces inherit` (the default): a copied element inherits its new parent's. */
  readonly inherit: boolean;
  /** The trees constructors make: their base URI is the static base URI. */
  readonly options: NodeOptions;
}

const modesOf = (scope: Scope): Modes => {
  const c = scope.statics.context;
  return {
    strip: c.boundarySpace === "strip",
    preserve: c.copyNamespaces.preserve,
    inherit: c.copyNamespaces.inherit,
    options: maybe("baseUri", Option.getOrUndefined(c.baseUri)),
  };
};

// -----------------------------------------------------------------------------
// Namespace declarations in the DOM
// -----------------------------------------------------------------------------

const isElement = (node: XmlNode): node is XmlElement => P.isTagged(node, "XmlElement");

const isDeclaration = (a: XmlAttribute): boolean =>
  a.name.prefix === "xmlns" || (a.name.prefix === null && a.name.local === "xmlns");

/** A namespace declaration attribute, named as the XML tree builder names one. */
const declaration = (prefix: string, uri: string): XmlAttribute =>
  Nodes.attribute(
    prefix === ""
      ? Nodes.qname(null, "xmlns", null)
      : Nodes.qname("xmlns", prefix, Namespaces.xmlns),
    uri,
  );

const lookup = (bindings: Bindings, prefix: string): string | undefined =>
  bindings.find(([p]) => p === prefix)?.[1];

/**
 * The bindings an element makes itself: its declarations (undeclarations
 * included), then those its name and attributes use.
 */
const ownScope = (element: XmlElement): Bindings => {
  const out: Bindings = [];
  const add = (prefix: string, uri: string) => {
    if (lookup(out, prefix) === undefined) out.push([prefix, uri]);
  };
  element.attributes.forEach((a) => {
    if (isDeclaration(a)) add(a.name.prefix === null ? "" : a.name.local, a.value);
  });
  [element.name, ...element.attributes.map((a) => a.name)].forEach((n) => {
    if (n.namespace !== null && n.prefix !== "xml" && n.prefix !== "xmlns")
      add(n.prefix ?? "", n.namespace);
  });
  return out;
};

const withAttributes = (element: XmlElement, attributes: ReadonlyArray<XmlAttribute>) =>
  Nodes.element(element.name, attributes, element.children);

/**
 * A copy of an element for `copy-namespaces no-preserve`: no namespace
 * declarations anywhere in it, so each element keeps only the bindings its
 * name and attributes use, and `xmlns=""` where an unprefixed name in no
 * namespace would inherit a default namespace. Stack-safe.
 */
const stripNamespaces = (root: XmlElement): XmlElement => {
  interface Frame {
    readonly source: XmlElement;
    readonly children: Array<XmlNode>;
    readonly defaultNamespace: string;
    readonly undeclare: boolean;
  }
  const frames: Array<Frame> = [];
  const steps = preorder<XmlNode>([root], (n) => (isElement(n) ? n.children : undefined));
  return Iterable.reduce(steps, root, (result, step) => {
    const node = step.node;
    const parent = frames.at(-1);
    if (!isElement(node)) {
      parent?.children.push(node);
      return result;
    }
    if (isEnter(step)) {
      const inherited = parent?.defaultNamespace ?? "";
      const unprefixed = node.name.prefix === null;
      frames.push({
        source: node,
        children: [],
        defaultNamespace: unprefixed ? (node.name.namespace ?? "") : inherited,
        undeclare: unprefixed && node.name.namespace === null && inherited !== "",
      });
      return result;
    }
    const frame = frames.pop();
    if (frame === undefined) return result;
    const kept = frame.source.attributes.filter((a) => !isDeclaration(a));
    const built = Nodes.element(
      frame.source.name,
      frame.undeclare ? [declaration("", ""), ...kept] : kept,
      frame.children,
    );
    const outer = frames.at(-1);
    if (outer === undefined) return built;
    outer.children.push(built);
    return result;
  });
};

/** What a namespace node stands for. */
const bindingOf = (node: XdmNode): NamespaceBinding | undefined => {
  const dom = node.dom;
  return !P.isString(dom) && "uri" in dom ? dom : undefined;
};

/** The DOM of an element node, copied as the copy-namespaces mode says (before its new parent is known). */
const copyElement = (node: XdmNode, element: XmlElement, modes: Modes): XmlElement => {
  if (!modes.preserve) return stripNamespaces(element);
  // A root's in-scope namespaces are its own.
  if (Option.isNone(node.parent)) return element;
  const inScope = node.namespaces.flatMap((n): ReadonlyArray<XmlAttribute> => {
    const b = bindingOf(n);
    return b === undefined || b.prefix === "xml" ? [] : [declaration(b.prefix, b.uri)];
  });
  return withAttributes(element, [
    ...inScope,
    ...element.attributes.filter((a) => !isDeclaration(a)),
  ]);
};

/**
 * A copied element placed under a parent with bindings `parent`: what it must
 * declare to keep its own in-scope namespaces. `explicit` is given for a
 * direct constructor written in the parent's content: the namespaces declared
 * by the constructors enclosing it.
 */
const fixup = (
  element: XmlElement,
  parent: Bindings,
  inherit: boolean,
  explicit: Bindings | undefined,
): XmlElement => {
  const own = ownScope(element);
  const extra = explicit
    ? // A direct constructor written in the content: only what the enclosing constructors declare is inherited.
      parent.flatMap(([prefix, uri]) =>
        uri !== "" && lookup(own, prefix) === undefined && lookup(explicit, prefix) !== uri
          ? [declaration(prefix, "")]
          : [],
      )
    : inherit
      ? element.name.prefix === null &&
        element.name.namespace === null &&
        lookup(own, "") === undefined &&
        (lookup(parent, "") ?? "") !== ""
        ? [declaration("", "")]
        : []
      : parent.flatMap(([prefix, uri]) =>
          uri !== "" && lookup(own, prefix) === undefined ? [declaration(prefix, "")] : [],
        );
  return Arr.isArrayNonEmpty(extra)
    ? withAttributes(element, [...extra, ...element.attributes])
    : element;
};

// -----------------------------------------------------------------------------
// Content
// -----------------------------------------------------------------------------

/** Arrays in content stand for their members, flattened. */
const flattenArrays = (items: Sequence): Sequence =>
  items.some((item) => item instanceof ArrayItem)
    ? items.flatMap((item) =>
        item instanceof ArrayItem ? flattenArrays(item.members.flat()) : [item],
      )
    : items;

/**
 * A part of a constructor's content: literal text, an expression's code, or
 * a direct element constructor written as content, whose namespaces are
 * those of its enclosing declarations and its own names, never those the
 * parent only has for its names (XQuery 3.1 §3.9.1.4).
 */
type Part = string | Code | DirectContent;

/** A direct element constructor written in the content of another. */
class DirectContent {
  readonly code: Code;
  constructor(code: Code) {
    this.code = code;
  }
}

/**
 * The content of an element or document constructor as it is gathered
 * (XQuery 3.1 §3.9.1.3): attributes and namespace nodes first, then
 * children, with atomic values joined into text, adjacent text merged and
 * empty text dropped. Nodes are copied.
 */
class Content {
  readonly attributes: Array<XmlAttribute> = [];
  readonly namespaces: Array<NamespaceBinding> = [];
  readonly children: Array<XmlNode> = [];
  /** The positions among the children of the direct element constructors written in the content. */
  readonly direct: Array<number> = [];
  private hasChild = false;
  private readonly modes: Modes;
  /** A document's content: attributes and namespace nodes are type errors. */
  private readonly document: boolean;
  private readonly offset: number;

  constructor(modes: Modes, document: boolean, offset: number) {
    this.modes = modes;
    this.document = document;
    this.offset = offset;
  }

  text(data: string): void {
    if (data === "") return;
    const last = this.children.length - 1;
    const prev = this.children[last];
    if (prev !== undefined && P.isTagged(prev, "XmlText"))
      this.children[last] = Nodes.text(prev.data + data);
    else this.children.push(Nodes.text(data));
    this.hasChild = true;
  }

  /** One enclosed expression's value: its adjacent atomic values make one text node, separated by spaces. */
  sequence(items: Sequence): void {
    flattenArrays(items).reduce((atomic, item) => {
      if (isAtomic(item)) {
        this.text(atomic ? ` ${atomicString(item)}` : atomicString(item));
        return true;
      }
      if (isNode(item)) this.node(item);
      else
        raise(
          "XQTY0105",
          "a function item can't be the content of an element or document",
          this.offset,
        );
      return false;
    }, false);
  }

  private leading(kind: string): void {
    if (this.document)
      raise("XPTY0004", `a document's content can't contain ${kind} node`, this.offset);
    if (this.hasChild)
      raise(
        "XQTY0024",
        `${kind} node can't follow other content of an element constructor`,
        this.offset,
      );
  }

  /** The value of a direct element constructor written as content. */
  nested(items: Sequence): void {
    items.forEach((item) => {
      if (isNode(item)) this.node(item, true);
    });
  }

  private node(node: XdmNode, direct = false): void {
    const dom = node.dom;
    const binding = bindingOf(node);
    if (!P.isString(dom) && "value" in dom && "name" in dom) {
      this.leading("an attribute");
      this.attributes.push(dom);
    } else if (binding !== undefined) {
      this.leading("a namespace");
      this.namespaces.push(binding);
    } else if (node.kind === "document") node.children.forEach((child) => this.node(child));
    else if (node.kind === "text") this.text(node.stringValue);
    else {
      this.hasChild = true;
      if (P.isTagged(dom, "XmlElement")) {
        if (direct) this.direct.push(this.children.length);
        this.children.push(copyElement(node, dom, this.modes));
      } else if (P.isTagged(dom, "XmlComment") || P.isTagged(dom, "XmlProcessingInstruction"))
        this.children.push(dom);
    }
  }
}

/** Gather content from its parts, in a context. */
const gather = (
  parts: ReadonlyArray<Part>,
  ctx: Ctx,
  modes: Modes,
  document: boolean,
  offset: number,
): Content => {
  const content = new Content(modes, document, offset);
  parts.forEach((part) => {
    if (P.isString(part)) content.text(part);
    else if (part instanceof DirectContent) content.nested(part.code(ctx));
    else content.sequence(part(ctx));
  });
  return content;
};

/** A prefix not bound in `bindings`, for an attribute whose namespace needs one. */
const freshPrefix = (bindings: Bindings): string =>
  // One of `ns0` … `nsN` is free, N being how many bindings there are.
  Arr.makeBy(bindings.length + 1, (n) => `ns${n}`).find((p) => lookup(bindings, p) === undefined) ??
  "ns";

/** Bind `prefix`, or `err:XQDY0102` if it is bound to another URI already. */
const bind = (bindings: Bindings, prefix: string, uri: string, offset: number): void => {
  const known = lookup(bindings, prefix);
  if (known === undefined) bindings.push([prefix, uri]);
  else if (known !== uri)
    raise("XQDY0102", `the prefix "${prefix}" is bound to both "${known}" and "${uri}"`, offset);
};

/** An attribute's name with a prefix its element can bind to its namespace (namespace fixup). */
const attributeName = (name: QName, bindings: Bindings): QName => {
  if (name.namespace === null || name.prefix === "xml") return name;
  if (name.prefix !== null) {
    const known = lookup(bindings, name.prefix);
    if (known === undefined) {
      bindings.push([name.prefix, name.namespace]);
      return name;
    }
    if (known === name.namespace) return name;
  }
  const existing = bindings.find(([p, uri]) => p !== "" && uri === name.namespace);
  const prefix = existing?.[0] ?? freshPrefix(bindings);
  if (existing === undefined) bindings.push([prefix, name.namespace]);
  return Nodes.qname(prefix, name.local, name.namespace);
};

/**
 * A constructed element: its name, the namespaces declared on it (a direct
 * constructor's declaration attributes) and its gathered content.
 */
const buildElement = (
  name: QName,
  declared: Bindings,
  attributes: ReadonlyArray<XmlAttribute>,
  content: Content,
  modes: Modes,
  offset: number,
  explicit: Bindings = declared,
): XdmNode => {
  const bindings: Bindings = [...declared];
  content.namespaces.forEach((n) => bind(bindings, n.prefix, n.uri, offset));
  if (name.namespace === null) {
    if (name.prefix === null && (lookup(bindings, "") ?? "") !== "")
      raise(
        "XQDY0102",
        `the element ${name.local} is in no namespace but a default namespace is bound`,
        offset,
      );
  } else if (name.prefix !== "xml") bind(bindings, name.prefix ?? "", name.namespace, offset);
  const all = [...attributes, ...content.attributes];
  const keys = all.map((a) => `{${a.name.namespace ?? ""}}${a.name.local}`);
  const named = all.map((a, i) => {
    if (keys.indexOf(keys[i] ?? "") !== i)
      raise("XQDY0025", `the attribute ${a.name.qualified} is given twice`, offset);
    const n = attributeName(a.name, bindings);
    return n === a.name ? a : Nodes.attribute(n, a.value);
  });
  const children = content.children.map((child, i) =>
    isElement(child)
      ? fixup(child, bindings, modes.inherit, content.direct.includes(i) ? explicit : undefined)
      : child,
  );
  const element = Nodes.element(
    name,
    [...bindings.map(([prefix, uri]) => declaration(prefix, uri)), ...named],
    children,
  );
  return XdmNode.fromElement(element, modes.options);
};

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

const qnameOf = (uri: string, local: string, prefix: Option.Option<string>): QName =>
  Nodes.qname(Option.getOrNull(prefix), local, uri === "" ? null : uri);

/** A computed constructor's name, from its expression's value (`err:XQDY0074` if it is not a QName). */
const dynamicName = (
  value: Sequence,
  scope: Scope,
  kind: "element" | "attribute",
  offset: number,
): QName => {
  const atoms = unwrap(atomize(value), offset);
  const [a] = atoms;
  if (atoms.length !== 1 || a === undefined)
    return raise("XPTY0004", `the name of a computed ${kind} must be one atomic value`, offset);
  if (isQName(a.value)) return a.value;
  if (a.type !== AtomicTypes.untypedAtomic && !derivesFrom(a.type, AtomicTypes.string))
    return raise(
      "XPTY0004",
      `the name of a computed ${kind} can't be an xs:${a.type.name}`,
      offset,
    );
  return lexicalName(atomicString(a).trim(), scope, kind, offset);
};

const isQName = /*#__PURE__*/ Schema.is(QName);

const invalidName = (s: string, offset: number): never =>
  raise("XQDY0074", `"${s}" is not a valid QName here`, offset);

/** A QName from a string: `local`, `prefix:local` or `Q{uri}local`, prefixes resolved statically. */
const lexicalName = (
  s: string,
  scope: Scope,
  kind: "element" | "attribute",
  offset: number,
): QName => {
  const braced = /^Q\{([^{}]*)\}(.*)$/.exec(s);
  if (braced !== null) {
    const [, uri = "", local = ""] = braced;
    return isValidNCName(local)
      ? qnameOf(uri.replace(/[ \t\r\n]+/g, " ").trim(), local, Option.none())
      : invalidName(s, offset);
  }
  const colon = s.indexOf(":");
  const prefix = colon < 0 ? undefined : s.slice(0, colon);
  const local = colon < 0 ? s : s.slice(colon + 1);
  if (!isValidNCName(local) || (prefix !== undefined && !isValidNCName(prefix)))
    return invalidName(s, offset);
  const name: EQName = {
    prefix: Option.fromUndefinedOr(prefix),
    local,
    uri: Option.none(),
    offset,
  };
  if (prefix !== undefined && lookupPrefix(scope, prefix) === undefined)
    return invalidName(s, offset);
  const n = resolve(scope, name, kind);
  return qnameOf(n.uri, n.local, name.prefix);
};

const lookupPrefix = (scope: Scope, prefix: string): string | undefined =>
  prefix === "xml"
    ? Namespaces.xml
    : Option.getOrUndefined(HashMap.get(scope.statics.namespaces, prefix));

/** `err:XQDY0096` for an element name no element may have. */
const checkElementName = (name: QName, offset: number): QName => {
  const ns = name.namespace;
  const bad =
    ns === Namespaces.xmlns ||
    name.prefix === "xmlns" ||
    (name.prefix === "xml" && ns !== Namespaces.xml) ||
    (ns === Namespaces.xml && name.prefix !== "xml" && name.prefix !== null) ||
    (ns === Namespaces.xml && name.prefix === null);
  return bad ? raise("XQDY0096", `an element can't be named ${name.qualified}`, offset) : name;
};

/** `err:XQDY0044` for an attribute name no attribute may have. */
const checkAttributeName = (name: QName, offset: number): QName => {
  const ns = name.namespace;
  const bad =
    ns === Namespaces.xmlns ||
    name.prefix === "xmlns" ||
    (name.prefix === null && ns === null && name.local === "xmlns") ||
    (name.prefix === "xml" && ns !== Namespaces.xml) ||
    (ns === Namespaces.xml && name.prefix !== "xml" && name.prefix !== null);
  if (bad) return raise("XQDY0044", `an attribute can't be named ${name.qualified}`, offset);
  return ns === Namespaces.xml && name.prefix === null ? Nodes.qname("xml", name.local, ns) : name;
};

/** A computed constructor's name: written, resolved now, or computed each time. */
const nameCode = (
  name: ComputedName,
  scope: Scope,
  kind: "element" | "attribute",
  compileExpr: CompileExpr,
  offset: number,
): ((ctx: Ctx) => QName) => {
  const check = kind === "element" ? checkElementName : checkAttributeName;
  return ComputedName.$match(name, {
    Static: ({ name: written }) => {
      const n = resolve(scope, written, kind);
      const q = qnameOf(n.uri, n.local, written.prefix);
      return () => check(q, offset);
    },
    Dynamic: ({ expr }) => {
      const code = compileExpr(expr, scope);
      return (ctx: Ctx) => check(dynamicName(code(ctx), scope, kind, offset), offset);
    },
  });
};

/** A computed namespace or PI constructor's NCName: written, or computed (`""` allowed when `empty`). */
const ncnameCode = (
  name: ComputedNCName,
  scope: Scope,
  compileExpr: CompileExpr,
  what: "prefix" | "target",
  offset: number,
): ((ctx: Ctx) => string) =>
  ComputedNCName.$match(name, {
    Static:
      ({ name: n }) =>
      () =>
        n,
    Dynamic: ({ expr }) => {
      const code = compileExpr(expr, scope);
      return (ctx: Ctx) => {
        const atoms = unwrap(atomize(code(ctx)), offset);
        const [a] = atoms;
        if (Arr.isReadonlyArrayEmpty(atoms) && what === "prefix") return "";
        if (atoms.length !== 1 || a === undefined)
          return raise("XPTY0004", `a computed ${what} must be one atomic value`, offset);
        if (a.type !== AtomicTypes.untypedAtomic && !derivesFrom(a.type, AtomicTypes.string))
          return raise("XPTY0004", `a computed ${what} can't be an xs:${a.type.name}`, offset);
        const s = atomicString(a).trim();
        if (s === "" && what === "prefix") return "";
        return isValidNCName(s)
          ? s
          : raise(
              what === "prefix" ? "XQDY0074" : "XQDY0041",
              `"${s}" is not a valid NCName`,
              offset,
            );
      };
    },
  });

// -----------------------------------------------------------------------------
// The constructors
// -----------------------------------------------------------------------------

/** An attribute with a value; `xml:id`'s value is whitespace-normalized, as `xml:id` processing does. */
const attributeNode = (name: QName, value: string): XmlAttribute =>
  Nodes.attribute(
    name,
    name.namespace === Namespaces.xml && name.local === "id"
      ? value.replace(/[ \t\r\n]+/g, " ").trim()
      : value,
  );

/** Atomized and joined by spaces, as attribute, text, comment and PI content is. */
const joined = (value: Sequence, offset: number): string =>
  unwrap(atomize(value), offset).map(atomicString).join(" ");

const joinedOrNone = (value: Sequence, offset: number): Option.Option<string> => {
  const atoms: ReadonlyArray<AtomicValue> = unwrap(atomize(value), offset);
  return Arr.isReadonlyArrayEmpty(atoms)
    ? Option.none()
    : Option.some(atoms.map(atomicString).join(" "));
};

/** An attribute value written in a direct constructor: literal text and enclosed expressions. */
const attributeValue = (
  parts: ReadonlyArray<ExprT>,
  scope: Scope,
  compileExpr: CompileExpr,
  offset: number,
): ((ctx: Ctx) => string) => {
  const codes = parts.map((p): string | Code => (isDirText(p) ? p.value : compileExpr(p, scope)));
  if (codes.every(P.isString)) {
    const text = codes.join("");
    return () => text;
  }
  return (ctx) => codes.map((c) => (P.isString(c) ? c : joined(c(ctx), offset))).join("");
};

const isDirText = Expr.$is("DirText");

const isDirElement = Expr.$is("DirElement");

/** The content of a direct element: literal text (boundary whitespace dropped unless preserved) and expressions. */
const contentParts = (
  content: ReadonlyArray<ExprT>,
  scope: Scope,
  modes: Modes,
  compileExpr: CompileExpr,
  explicit: Bindings,
): ReadonlyArray<Part> =>
  content.flatMap((p): ReadonlyArray<Part> => {
    if (isDirElement(p)) return [new DirectContent(dirElement(p, scope, compileExpr, explicit))];
    if (!isDirText(p)) return [compileExpr(p, scope)];
    return p.boundary && modes.strip ? [] : [p.value];
  });

const declarations = (namespaces: ReadonlyArray<DirNamespace>): Bindings =>
  namespaces.map((n) => [Option.getOrElse(n.prefix, () => ""), n.uri] as const);

/** A direct element constructor, `<name attr="…">content</name>`. */
export const dirElement = (
  e: DirElementT,
  outer: Scope,
  compileExpr: CompileExpr,
  enclosing: Bindings = [],
): Code => {
  const scope: Scope = { ...outer, statics: elementScope(outer.statics, e.namespaces) };
  const modes = modesOf(scope);
  const written = resolve(scope, e.name, "element");
  const name = qnameOf(written.uri, written.local, e.name.prefix);
  const attributes = e.attributes.map((a) => {
    const n = resolve(scope, a.name, "attribute");
    return {
      name: checkAttributeName(qnameOf(n.uri, n.local, a.name.prefix), a.offset),
      value: attributeValue(a.value, scope, compileExpr, a.offset),
    };
  });
  const declared = declarations(e.namespaces);
  // What the constructors around this one declare, this one's own declarations first.
  const explicit: Bindings = [
    ...declared,
    ...enclosing.filter(([p]) => lookup(declared, p) === undefined),
  ];
  const parts = contentParts(e.content, scope, modes, compileExpr, explicit);
  return (ctx) => {
    const attrs = attributes.map((a) => attributeNode(a.name, a.value(ctx)));
    const content = gather(parts, ctx, modes, false, e.offset);
    return [buildElement(name, declared, attrs, content, modes, e.offset, explicit)];
  };
};

/** `element name { … }` */
export const compElement = (
  e: Extract<ExprT, { readonly _tag: "CompElement" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const modes = modesOf(scope);
  const name = nameCode(e.name, scope, "element", compileExpr, e.offset);
  const body = compileExpr(e.body, scope);
  return (ctx) => {
    const n = name(ctx);
    const content = gather([body], ctx, modes, false, e.offset);
    return [buildElement(n, [], [], content, modes, e.offset)];
  };
};

/** `attribute name { … }` */
export const compAttribute = (
  e: Extract<ExprT, { readonly _tag: "CompAttribute" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const modes = modesOf(scope);
  const name = nameCode(e.name, scope, "attribute", compileExpr, e.offset);
  const body = compileExpr(e.body, scope);
  return (ctx) => {
    const n = name(ctx);
    return [XdmNode.fromAttribute(attributeNode(n, joined(body(ctx), e.offset)), modes.options)];
  };
};

/** `document { … }` */
export const compDocument = (
  e: Extract<ExprT, { readonly _tag: "CompDocument" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const modes = modesOf(scope);
  const body = compileExpr(e.body, scope);
  return (ctx) => {
    const content = gather([body], ctx, modes, true, e.offset);
    return [XdmNode.fromDocument(Nodes.document(null, null, content.children), modes.options)];
  };
};

/** `text { … }`: no node for an empty sequence. */
export const compText = (
  e: Extract<ExprT, { readonly _tag: "CompText" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const modes = modesOf(scope);
  const body = compileExpr(e.body, scope);
  return (ctx) => {
    return Arr.fromOption(
      Option.map(joinedOrNone(body(ctx), e.offset), (text) =>
        XdmNode.fromText(text, modes.options),
      ),
    );
  };
};

const commentNode = (data: string, modes: Modes, offset: number): XdmNode =>
  data.includes("--") || data.endsWith("-")
    ? raise("XQDY0072", `a comment can't contain "--" or end with "-"`, offset)
    : XdmNode.fromComment(Nodes.comment(data), modes.options);

/** `comment { … }` */
export const compComment = (
  e: Extract<ExprT, { readonly _tag: "CompComment" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const modes = modesOf(scope);
  const body = compileExpr(e.body, scope);
  return (ctx) => [commentNode(joined(body(ctx), e.offset), modes, e.offset)];
};

/** `<!-- … -->` */
export const dirComment = (
  e: Extract<ExprT, { readonly _tag: "DirComment" }>,
  scope: Scope,
): Code => {
  const modes = modesOf(scope);
  return () => [commentNode(e.value, modes, e.offset)];
};

const piNode = (target: string, data: string, modes: Modes, offset: number): XdmNode => {
  if (target.toLowerCase() === "xml")
    return raise("XQDY0064", `a processing instruction can't be named "${target}"`, offset);
  const content = data.replace(/^[ \t\r\n]+/, "");
  return content.includes("?>")
    ? raise("XQDY0026", `a processing instruction can't contain "?>"`, offset)
    : XdmNode.fromProcessingInstruction(
        Nodes.processingInstruction(target, content),
        modes.options,
      );
};

/** `processing-instruction target { … }` */
export const compPI = (
  e: Extract<ExprT, { readonly _tag: "CompPI" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const modes = modesOf(scope);
  const target = ncnameCode(e.target, scope, compileExpr, "target", e.offset);
  const body = compileExpr(e.body, scope);
  return (ctx) => {
    const t = target(ctx);
    return [piNode(t, joined(body(ctx), e.offset), modes, e.offset)];
  };
};

/** `<?target … ?>` */
export const dirPI = (e: Extract<ExprT, { readonly _tag: "DirPI" }>, scope: Scope): Code => {
  const modes = modesOf(scope);
  return () => [piNode(e.target, e.value, modes, e.offset)];
};

/** `namespace prefix { uri }` */
export const compNamespace = (
  e: Extract<ExprT, { readonly _tag: "CompNamespace" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const modes = modesOf(scope);
  const prefix = ncnameCode(e.prefix, scope, compileExpr, "prefix", e.offset);
  const uri = compileExpr(e.uri, scope);
  return (ctx) => {
    const p = prefix(ctx);
    const u = joined(uri(ctx), e.offset);
    const bad =
      p === "xmlns" ||
      u === Namespaces.xmlns ||
      (p === "xml") !== (u === Namespaces.xml) ||
      u === "";
    return bad
      ? raise("XQDY0101", `the prefix "${p}" can't be bound to "${u}"`, e.offset)
      : [XdmNode.fromNamespace({ prefix: p, uri: u }, modes.options)];
  };
};
