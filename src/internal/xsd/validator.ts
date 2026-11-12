/**
 * The streaming validator: SAX events in, a typed value out, the first
 * violation reported as soon as the event that commits it arrives.
 *
 * It keeps a stack of open elements, each with the declaration and type it is
 * validated against, the state of its content model, the text read so far and
 * the record its value is being built in. Elements matched by a wildcard, and
 * elements whose declarations carry identity constraints, are also built as
 * DOM elements (`XmlElement`): the former are kept that way in the value, the
 * latter are what the constraints' XPaths are evaluated over.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import {
  DuplicateAttribute,
  InvalidDocumentStructure,
  MismatchedEndTag,
  UnboundNamespacePrefix,
  UnexpectedEndTag,
  type SaxError,
} from "../../Error.ts";
import { Namespaces, type QName } from "../../Name.ts";
import { origin, type Position, type Span } from "../../Position.ts";
import type { Attribute, SaxEvent } from "../../Sax.ts";
import { type XmlAttribute, XmlElement, type XmlNode } from "../../Xml/Node.ts";
import * as Nodes from "../nodes.ts";
import { XsdValidationError, type ValidationRule, type XsdSchemaError } from "../../Xsd/Error.ts";
import { clark, XSI, type ElementDeclaration, type Wildcard } from "../../Xsd/Model.ts";
import type { Validated, XsdValue } from "../../Xsd/Value.ts";
import { derivationPath, localOf, namespaceOf, typeOf } from "./components.ts";
import type { State, Term } from "./content.ts";
import {
  decode,
  equalValues,
  type SimpleChecker,
  type SimpleValue,
  type ValueContext,
} from "./datatypes.ts";
import { evaluateConstraints, type Tables, type Typed, type TypeOf } from "./identity.ts";
import { advance, matchesAll, type StepLevel, type StreamStep } from "../streamPath.ts";
import type { AttributeRule, ComplexRuntime, Runtime, TypeRuntime } from "./runtime.ts";
import { Lookup } from "../lookup.ts";
import { isIn, tagSet } from "../tagSet.ts";

/** Anything that stops validation. */
export type Failure = XsdValidationError | XsdSchemaError | SaxError;

type Props = Record<string, XsdValue | Array<XsdValue> | Record<string, string>>;

/** An open element. */
class Frame {
  /** Where the element came from: the document, a particle of its parent's type, or a wildcard. */
  readonly via: "root" | "particle" | "wildcard";
  readonly raw: string;
  readonly name: Expanded;
  readonly key: string;
  readonly bindings: Readonly<Record<string, string>>;
  readonly index: number;
  /** How many child elements of each name have started, for paths (made on the first child). */
  counts: Lookup<string, number> | undefined = undefined;
  /** The names its children resolve to while they declare no namespaces of their own, by raw name. */
  names: Lookup<string, Expanded> | undefined = undefined;
  /** The same, for the attributes of those children. */
  attributeNames: Lookup<string, Expanded> | undefined = undefined;
  /** The declaration and type it is validated against; `undefined` for content that is skipped. */
  readonly decl: ElementDeclaration | undefined;
  readonly type: TypeRuntime | undefined;
  /** The type named by `xsi:type`, when it differs from the declared one. */
  readonly xsiType: string | undefined;
  readonly nil: boolean;
  readonly props: Props;
  /** The state of its content model, when its type has element content. */
  state: State | undefined;
  text = "";
  /** The children, when the element is being built as a DOM element. */
  readonly dom: Array<XmlNode> | undefined;
  readonly domAttributes: ReadonlyArray<XmlAttribute>;
  /** Key tables of identity constraints, when inside an element that declares some. */
  readonly tables: Tables | undefined;
  /** The path steps it matched, when selecting (see {@link ValidatorOptions.select}). */
  level: Option.Option<StepLevel> = Option.none();
  /** Whether it matched the whole selection path, so its value is emitted, not delivered. */
  selected = false;
  /** Whether it is inside a selected element, where nothing is selected again. */
  captured = false;
  /** Selected values held until this element, an identity-constraint scope, closes. */
  held: Option.Option<Array<XsdValue>> = Option.none();

  // Positional, not an options object: one is built per element.
  constructor(
    via: Frame["via"],
    opening: Opening,
    decl: ElementDeclaration | undefined,
    type: TypeRuntime | undefined,
    nil: boolean,
    props: Props,
    dom: boolean,
    domAttributes: ReadonlyArray<XmlAttribute>,
    tables: boolean,
  ) {
    this.via = via;
    this.raw = opening.ev.name;
    this.name = opening.name;
    this.key = opening.name.clark;
    this.bindings = opening.bindings;
    this.index = opening.index;
    this.decl = decl;
    this.type = type;
    this.xsiType =
      decl === undefined || type === undefined || type.key === decl.type ? undefined : type.key;
    this.nil = nil;
    this.props = props;
    this.state =
      type !== undefined && P.isTagged(type, "Complex") && Option.isSome(type.automaton)
        ? type.automaton.value.start
        : undefined;
    this.dom = dom ? [] : undefined;
    this.domAttributes = domAttributes;
    this.tables = tables ? MutableHashMap.empty() : undefined;
  }
}

/** The value of an element that is not nillable (a nillable one's is an `Option` of it). */
type Content = Exclude<XsdValue, Option.Option<unknown>>;

/** The attributes of an element that isn't built as a DOM element: none, never written to. */
const noAttributes: ReadonlyArray<XmlAttribute> = [];

const isWhitespace = (s: string): boolean => /^[ \t\r\n]*$/.test(s);

const xsiAttributes = tagSet("type", "nil", "schemaLocation", "noNamespaceSchemaLocation");

/** A term, for messages; its namespace is spelled out when the element found was in another. */
const describe =
  (found: string) =>
  (term: Term): string => {
    if (term.kind === "any") return "an element the wildcard allows";
    const ns = namespaceOf(term.name);
    return ns === found
      ? `<${localOf(term.name)}>`
      : `<${localOf(term.name)}> (${ns === "" ? "in no namespace" : `in ${ns}`})`;
  };

/** The namespaces in scope after an element's declarations: `parent` itself when it declares none. */
const declare = (
  parent: Readonly<Record<string, string>>,
  attributes: ReadonlyArray<Attribute>,
): Readonly<Record<string, string>> => {
  let scope: Record<string, string> | undefined = undefined;
  for (const a of attributes) {
    if (a.name === "xmlns") {
      scope ??= { ...parent };
      scope[""] = a.value;
    } else if (a.name.startsWith("xmlns:")) {
      scope ??= { ...parent };
      scope[a.name.slice(6)] = a.value;
    }
  }
  return scope ?? parent;
};

/** The first attribute of a start tag named like an earlier one, if there is one. */
const duplicateOf = (attributes: ReadonlyArray<Attribute>): Attribute | undefined => {
  for (let i = 1; i < attributes.length; i++) {
    const name = attributes[i]?.name;
    for (let j = 0; j < i; j++) if (attributes[j]?.name === name) return attributes[i];
  }
  return undefined;
};

/** The `xsi:` attribute with this local name, if the start tag has one. */
const xsiAttribute = (
  attributes: ReadonlyArray<Attribute>,
  bindings: Readonly<Record<string, string>>,
  local: string,
): Attribute | undefined => {
  for (const a of attributes) {
    const colon = a.name.indexOf(":");
    if (
      colon > 0 &&
      a.name.length === colon + 1 + local.length &&
      a.name.endsWith(local) &&
      bindings[a.name.slice(0, colon)] === XSI
    )
      return a;
  }
  return undefined;
};

const isNamespaceDeclaration = (a: Attribute) => a.name === "xmlns" || a.name.startsWith("xmlns:");

const matchEvent = Data.taggedEnum<SaxEvent>().$match;

type Event<Tag extends SaxEvent["_tag"]> = Extract<SaxEvent, { readonly _tag: Tag }>;

export interface ValidatorOptions {
  /** The expanded name the document element must have. */
  readonly root?: string;
  /**
   * The elements to stream out: each one matching these steps is emitted
   * (see {@link Validator.drain}) once it is complete, instead of becoming
   * part of its parent's value.
   */
  readonly select?: ReadonlyArray<StreamStep>;
}

export class Validator {
  private readonly runtime: Runtime;
  private readonly root: string | undefined;
  private readonly steps: ReadonlyArray<StreamStep>;
  private readonly frames: Array<Frame> = [];
  /** Selected values completed and ready to emit. */
  private emitted: Array<XsdValue> = [];
  private readonly ids = MutableHashSet.empty<string>();
  /** The decoded defaults of attributes, for those whose default means the same everywhere. */
  private readonly defaults = new WeakMap<AttributeRule, SimpleValue>();
  /** The simple types of DOM nodes built for identity constraints, for comparing their fields. */
  private readonly types = new WeakMap<object, Typed>();
  private readonly typeOf: TypeOf = (node) => Option.fromUndefinedOr(this.types.get(node));
  private readonly refs: Array<{
    readonly id: string;
    readonly position: Position;
    readonly path: string;
  }> = [];
  private done: Option.Option<Validated> = Option.none();
  /** The element whose start tag is being checked, before it is pushed, and its index. */
  private opening: string | undefined = undefined;
  private openingIndex = 1;
  /** The last event's span: its end is where an incomplete document is reported. */
  private last: Span = { start: origin, end: origin };

  constructor(runtime: Runtime, options?: ValidatorOptions) {
    this.runtime = runtime;
    this.root = options?.root;
    this.steps = options?.select ?? [];
  }

  /** The selected values completed since the last call, in document order. */
  drain(): ReadonlyArray<XsdValue> {
    const out = this.emitted;
    this.emitted = [];
    return out;
  }

  /** The document's value, once {@link finish} has succeeded. */
  get result(): Option.Option<Validated> {
    return this.done;
  }

  /** Feed one event: `null` if it is valid so far, or why the document is not. */
  accept(ev: SaxEvent): Failure | null {
    this.last = ev.span;
    return matchEvent(ev, this.handlers);
  }

  private readonly handlers = {
    StartElement: (ev: Event<"StartElement">) => this.start(ev),
    EndElement: (ev: Event<"EndElement">) => this.end(ev.name, ev.span.start),
    Text: (ev: Event<"Text">) => this.text(ev.data, ev.span.start, false),
    CData: (ev: Event<"CData">) => this.text(ev.data, ev.span.start, true),
    Comment: (ev: Event<"Comment">) => this.capture(() => Nodes.comment(ev.data)),
    ProcessingInstruction: (ev: Event<"ProcessingInstruction">) =>
      this.capture(() => Nodes.processingInstruction(ev.target, ev.data)),
    Doctype: () => null,
    XmlDeclaration: () => null,
  };

  /** The end of the input: anything left open or unresolved is an error. */
  finish(): Failure | null {
    const open = this.frames.at(-1);
    if (open !== undefined)
      return new InvalidDocumentStructure({
        position: this.last.end,
        reason: `unexpected end of input: <${open.raw}> was never closed`,
      });
    if (Option.isNone(this.done))
      return new InvalidDocumentStructure({
        position: this.last.end,
        reason: "the document has no root element",
      });
    const dangling = Arr.findFirst(this.refs, (r) => !MutableHashSet.has(this.ids, r.id));
    return Option.match(dangling, {
      onNone: () => null,
      onSome: (r) =>
        new XsdValidationError({
          rule: "IdentityConstraint",
          reason: `the IDREF "${r.id}" refers to no ID in the document`,
          path: r.path,
          position: r.position,
        }),
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private path(): string {
    const steps = Arr.map(this.frames, (f) => `/${f.raw}${f.index > 1 ? `[${f.index}]` : ""}`);
    const own =
      this.opening === undefined
        ? ""
        : `/${this.opening}${this.openingIndex > 1 ? `[${this.openingIndex}]` : ""}`;
    return steps.join("") + own || "/";
  }

  private invalid(
    rule: ValidationRule,
    reason: string,
    position: Position,
    path?: string,
  ): XsdValidationError {
    return new XsdValidationError({ rule, reason, path: path ?? this.path(), position });
  }

  private resolve(
    raw: string,
    isAttribute: boolean,
    bindings: Readonly<Record<string, string>>,
    position: Position,
  ): Expanded | UnboundNamespacePrefix {
    const colon = raw.indexOf(":");
    const prefix = colon < 0 ? null : raw.slice(0, colon);
    const local = colon < 0 ? raw : raw.slice(colon + 1);
    if (prefix === "xml") return expanded(prefix, local, Namespaces.xml);
    if (prefix === null && isAttribute) return expanded(prefix, local, null);
    const ns = bindings[prefix ?? ""];
    if (ns === undefined && prefix !== null)
      return new UnboundNamespacePrefix({ prefix, qualifiedName: raw, position });
    return expanded(prefix, local, ns === undefined || ns === "" ? null : ns);
  }

  /**
   * {@link resolve}, remembered in `names` (the parent's table, when the
   * element declares no namespaces of its own): the elements and attributes
   * of a document repeat a few names, and a name resolved once is also one
   * string for the lookups keyed by it.
   */
  private resolveIn(
    names: Lookup<string, Expanded> | undefined,
    raw: string,
    isAttribute: boolean,
    bindings: Readonly<Record<string, string>>,
    position: Position,
  ): Expanded | UnboundNamespacePrefix {
    const known = names?.get(raw);
    if (known !== undefined) return known;
    const name = this.resolve(raw, isAttribute, bindings, position);
    if (names !== undefined && !P.isTagged(name, "UnboundNamespacePrefix")) names.set(raw, name);
    return name;
  }

  private contextOf(bindings: Readonly<Record<string, string>>): ValueContext {
    return new BindingsContext(bindings);
  }

  /** Decode a value, recording IDs and references; the reason when it is invalid. */
  private value(
    checker: SimpleChecker,
    raw: string,
    bindings: Readonly<Record<string, string>>,
    position: Position,
  ): Result.Result<SimpleValue, string> {
    const decoded = decode(checker, raw, this.contextOf(bindings));
    if (Result.isFailure(decoded) || checker.identity === "none") return decoded;
    const v = decoded.success;
    if (checker.identity === "ID" && P.isString(v)) {
      if (MutableHashSet.has(this.ids, v)) return Result.fail(`the ID "${v}" is used twice`);
      MutableHashSet.add(this.ids, v);
    }
    if (checker.identity === "IDREF" && P.isString(v))
      this.refs.push({ id: v, position, path: this.path() });
    if (checker.identity === "IDREFS" && Arr.isArray(v))
      Arr.forEach(Arr.filter(v, P.isString), (id) =>
        this.refs.push({ id, position, path: this.path() }),
      );
    return decoded;
  }

  private capture(node: () => XmlNode): null {
    const dom = this.frames.at(-1)?.dom;
    if (dom !== undefined) dom.push(node());
    return null;
  }

  // ---------------------------------------------------------------------------
  // Start tags
  // ---------------------------------------------------------------------------

  private start(ev: Event<"StartElement">): Failure | null {
    const duplicate = duplicateOf(ev.attributes);
    if (duplicate !== undefined)
      return new DuplicateAttribute({
        element: ev.name,
        attribute: duplicate.name,
        position: duplicate.span.start,
      });
    const parent = this.frames.at(-1);
    const bindings = declare(parent?.bindings ?? {}, ev.attributes);
    // Names resolve as the parent's children's do unless the element declares namespaces.
    const shared = parent !== undefined && bindings === parent.bindings;
    if (shared && parent.names === undefined) {
      parent.names = new Lookup();
      parent.attributeNames = new Lookup();
    }
    const name = this.resolveIn(
      shared ? parent.names : undefined,
      ev.name,
      false,
      bindings,
      ev.span.start,
    );
    if (P.isTagged(name, "UnboundNamespacePrefix")) return name;
    const index = parent === undefined ? 1 : count(parent, ev.name);
    const opening: Opening = {
      ev,
      name,
      bindings,
      index,
      attributeNames: shared ? parent.attributeNames : undefined,
    };
    const out =
      parent === undefined
        ? this.startRoot(opening)
        : parent.type === undefined
          ? this.open(opening, "wildcard", undefined, true)
          : this.startChild(opening, parent, parent.type);
    if (out !== null) return out;
    this.track(opening, parent);
    return ev.selfClosing ? this.end(ev.name, ev.span.start) : null;
  }

  /** Match the element just opened against the selection path. */
  private track(opening: Opening, parent: Frame | undefined): void {
    const frame = this.frames.at(-1);
    if (frame === undefined || Arr.isReadonlyArrayEmpty(this.steps)) return;
    if (parent !== undefined && (parent.selected || parent.captured)) {
      frame.captured = true;
      return;
    }
    const level = advance(
      this.steps,
      Option.flatMap(Option.fromUndefinedOr(parent), (p) => p.level),
      { local: opening.name.local, namespace: Option.fromNullOr(opening.name.namespace) },
      () =>
        Nodes.element(
          toQName(opening.name),
          Result.getOrElse(this.domAttributes(opening.ev, opening.bindings), () => []),
          [],
        ),
    );
    frame.level = Option.some(level);
    frame.selected = matchesAll(this.steps, level);
  }

  /**
   * Emit a selected value, or hold it while it is inside an element that
   * declares identity constraints: a later violation in that scope would make
   * the value part of an invalid document.
   */
  private emit(values: ReadonlyArray<XsdValue>): void {
    if (Arr.isReadonlyArrayEmpty(values)) return;
    const scope = Arr.findLast(this.frames, (f) => f.decl?.constraints !== undefined);
    if (Option.isNone(scope)) {
      this.emitted.push(...values);
      return;
    }
    const frame = scope.value;
    Option.match(frame.held, {
      onNone: () => {
        frame.held = Option.some([...values]);
      },
      onSome: (held) => {
        held.push(...values);
      },
    });
  }

  private startRoot(opening: Opening): Failure | null {
    const { ev, name } = opening;
    if (Option.isSome(this.done))
      return new InvalidDocumentStructure({
        position: ev.span.start,
        reason: "a document has only one root element",
      });
    const key = name.clark;
    const path = `/${ev.name}`;
    if (this.root !== undefined && key !== this.root)
      return this.invalid(
        "UnexpectedElement",
        `the document element is <${ev.name}>, not <${localOf(this.root)}>`,
        ev.span.start,
        path,
      );
    return Option.match(this.runtime.element(key), {
      onNone: () =>
        this.invalid(
          "UnexpectedElement",
          `no global element <${ev.name}> is declared`,
          ev.span.start,
          path,
        ),
      onSome: (decl) => this.open(opening, "root", decl, false),
    });
  }

  private startChild(opening: Opening, parent: Frame, type: TypeRuntime): Failure | null {
    const { ev, name } = opening;
    if (parent.nil)
      return this.invalid(
        "Nil",
        `<${parent.raw}> is nil, so it can't contain <${ev.name}>`,
        ev.span.start,
      );
    const state = parent.state;
    if (P.isTagged(type, "Simple") || Option.isNone(type.automaton) || state === undefined)
      return this.invalid(
        "UnexpectedElement",
        `<${parent.raw}> can't contain elements, but contains <${ev.name}>`,
        ev.span.start,
      );
    const automaton = type.automaton.value;
    const step = automaton.step(state, name.clark, name.namespace ?? "");
    if (Option.isNone(step)) {
      const expected = Arr.map(automaton.expected(state), describe(name.namespace ?? ""));
      return this.invalid(
        "UnexpectedElement",
        Arr.isReadonlyArrayEmpty(expected)
          ? `<${ev.name}> is not allowed here: <${parent.raw}> is already complete`
          : `<${ev.name}> is not allowed here; expected ${expected.join(" or ")}`,
        ev.span.start,
      );
    }
    const match = step.value;
    parent.state = match.next;
    if (match.term.kind !== "element")
      return this.startWildcard(opening, match.term.wildcard.process);
    const decl = Option.isSome(match.element)
      ? this.runtime.element(match.element.value)
      : Option.none<ElementDeclaration>();
    return Option.isSome(decl)
      ? this.open(opening, "particle", decl.value, parent.dom !== undefined)
      : this.open(opening, "wildcard", undefined, true);
  }

  private startWildcard(opening: Opening, process: "strict" | "lax" | "skip"): Failure | null {
    const { ev, name } = opening;
    const decl = process === "skip" ? Option.none() : this.runtime.element(name.clark);
    if (process === "strict" && Option.isNone(decl))
      return this.invalid(
        "UnexpectedElement",
        `<${ev.name}> matches a strict wildcard but no global element declares it`,
        ev.span.start,
      );
    return this.open(opening, "wildcard", Option.getOrUndefined(decl), true);
  }

  /** The type an element is validated against: its declared type, or the one `xsi:type` names. */
  private typeFor(opening: Opening, decl: ElementDeclaration): Result.Result<TypeRuntime, Failure> {
    const { ev, bindings } = opening;
    const raw = xsiAttribute(ev.attributes, bindings, "type");
    let key = decl.type;
    if (raw !== undefined) {
      const named = decode(this.qnameChecker, raw.value, this.contextOf(bindings));
      if (Result.isFailure(named))
        return Result.fail(
          this.invalid("InvalidType", `xsi:type: ${named.failure}`, raw.span.start),
        );
      key = String(named.success);
      const blocked = this.blockedFor(decl, key);
      if (Option.isSome(blocked))
        return Result.fail(this.invalid("InvalidType", blocked.value, ev.span.start));
    }
    const type = this.runtime.type(key);
    if (Result.isFailure(type)) return type;
    return P.isTagged(type.success, "Complex") && type.success.def.abstract === true
      ? Result.fail(this.invalid("InvalidType", `the type ${key} is abstract`, ev.span.start))
      : type;
  }

  private readonly qnameChecker: SimpleChecker = {
    kind: "qname",
    primitive: "QName",
    whiteSpace: "collapse",
    identity: "none",
    check: (s, context) => {
      const colon = s.indexOf(":");
      const ns = context.resolve(colon < 0 ? "" : s.slice(0, colon));
      return colon > 0 && ns === undefined
        ? Result.fail(`the prefix of "${s}" is not bound`)
        : Result.succeed(clark(ns ?? "", s.slice(colon + 1)));
    },
    compare: () => Option.none(),
  };

  /** Why `xsi:type` can't name `key` for `decl`, if it can't. */
  private blockedFor(decl: ElementDeclaration, key: string): Option.Option<string> {
    if (key === decl.type) return Option.none();
    if (Option.isNone(typeOf(this.runtime.model, key)) && !this.isSimpleKey(key))
      return Option.some(`xsi:type names ${key}, which is not defined`);
    return Option.match(derivationPath(this.runtime.model, key, decl.type), {
      onNone: () => Option.some(`the type ${key} is not derived from ${decl.type}`),
      onSome: (path) => {
        const declared = typeOf(this.runtime.model, decl.type);
        const blocks = tagSet(
          ...(decl.block ?? []),
          ...Option.match(declared, {
            onNone: () => [],
            onSome: (t) => (P.isTagged(t, "ComplexType") ? (t.block ?? []) : []),
          }),
        );
        return Option.map(
          Arr.findFirst(path, (how) => isIn(blocks, how)),
          (how) => `the declaration blocks types derived by ${how}, like ${key}`,
        );
      },
    });
  }

  private isSimpleKey(key: string): boolean {
    return Result.isSuccess(this.runtime.checker(key));
  }

  /** Whether `xsi:nil` makes the element nil, or why it can't. */
  private nilOf(opening: Opening, decl: ElementDeclaration): boolean | Failure {
    const { ev, bindings } = opening;
    const a = xsiAttribute(ev.attributes, bindings, "nil");
    if (a === undefined) return false;
    const v = a.value.trim();
    const nil = v === "true" || v === "1";
    if (!nil && v !== "false" && v !== "0")
      return this.invalid("Nil", `xsi:nil="${a.value}" is not a boolean`, a.span.start);
    if (nil && decl.nillable !== true)
      return this.invalid("Nil", `<${ev.name}> is not nillable`, a.span.start);
    if (nil && decl.fixed !== undefined)
      return this.invalid(
        "Nil",
        `<${ev.name}> has a fixed value, so it can't be nil`,
        a.span.start,
      );
    return nil;
  }

  /** Push an element: validated against `decl` if there is one, skipped (and kept as DOM) otherwise. */
  private open(
    opening: Opening,
    via: Frame["via"],
    decl: ElementDeclaration | undefined,
    dom: boolean,
  ): Failure | null {
    const { ev, bindings, index } = opening;
    const parent = this.frames.at(-1);
    let domAttributes = noAttributes;
    if (dom) {
      const built = this.domAttributes(ev, bindings);
      if (Result.isFailure(built)) return built.failure;
      domAttributes = built.success;
    }
    if (decl === undefined) {
      this.frames.push(
        new Frame(
          via,
          opening,
          decl,
          undefined,
          false,
          {},
          true,
          domAttributes,
          parent?.tables !== undefined,
        ),
      );
      return null;
    }
    // The element isn't on the stack yet: its errors name it in their path.
    this.opening = ev.name;
    this.openingIndex = index;
    const frame = this.checkStart(opening, via, decl, dom, domAttributes, parent);
    this.opening = undefined;
    if (!(frame instanceof Frame)) return frame;
    this.frames.push(frame);
    return null;
  }

  private checkStart(
    opening: Opening,
    via: Frame["via"],
    decl: ElementDeclaration,
    dom: boolean,
    domAttributes: ReadonlyArray<XmlAttribute>,
    parent: Frame | undefined,
  ): Frame | Failure {
    const { ev, bindings } = opening;
    if (decl.abstract === true)
      return this.invalid("InvalidType", `the element <${ev.name}> is abstract`, ev.span.start);
    const typed = this.typeFor(opening, decl);
    if (Result.isFailure(typed)) return typed.failure;
    const type = typed.success;
    const nil = this.nilOf(opening, decl);
    if (!P.isBoolean(nil)) return nil;
    const props: Props = {};
    const failure = this.attributes(opening, type, props);
    if (failure !== null) return failure;
    const constrained = decl.constraints !== undefined;
    return new Frame(
      via,
      opening,
      decl,
      type,
      nil,
      props,
      dom || constrained,
      dom || !constrained
        ? domAttributes
        : Result.getOrElse(this.domAttributes(ev, bindings), () => []),
      constrained || parent?.tables !== undefined,
    );
  }

  /** The DOM attributes of a start tag (namespace declarations included, as in `Xml.parse`). */
  private domAttributes(
    ev: Event<"StartElement">,
    bindings: Readonly<Record<string, string>>,
  ): Result.Result<ReadonlyArray<XmlAttribute>, Failure> {
    return Result.all(
      Arr.map(ev.attributes, (a) => {
        const name =
          a.name === "xmlns"
            ? expanded(null, "xmlns", Namespaces.xmlns)
            : a.name.startsWith("xmlns:")
              ? expanded("xmlns", a.name.slice(6), Namespaces.xmlns)
              : this.resolve(a.name, true, bindings, a.span.start);
        return P.isTagged(name, "UnboundNamespacePrefix")
          ? Result.fail(name)
          : Result.succeed(Nodes.attribute(toQName(name), a.value));
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Attributes
  // ---------------------------------------------------------------------------

  /** Check a start tag's attributes into `props`: `null`, or the first violation. */
  private attributes(opening: Opening, type: TypeRuntime, props: Props): Failure | null {
    const { ev, bindings } = opening;
    const seen: Array<string> = [];
    for (const a of ev.attributes) {
      if (isNamespaceDeclaration(a)) continue;
      const failure = this.attribute(a, opening, type, props, seen);
      if (failure !== null) return failure;
    }
    if (!P.isTagged(type, "Complex")) return null;
    const failure = this.implied(type, props, seen, ev.span.start, bindings);
    if (failure !== null) return failure;
    startLists(type, props);
    return null;
  }

  private attribute(
    a: Attribute,
    opening: Opening,
    type: TypeRuntime,
    props: Props,
    seen: Array<string>,
  ): Failure | null {
    const { ev, bindings } = opening;
    const qname = this.resolveIn(opening.attributeNames, a.name, true, bindings, a.span.start);
    if (P.isTagged(qname, "UnboundNamespacePrefix")) return qname;
    const key = qname.clark;
    if (seen.includes(key))
      return new DuplicateAttribute({
        element: ev.name,
        attribute: a.name,
        position: a.span.start,
      });
    seen.push(key);
    if (qname.namespace === XSI && isIn(xsiAttributes, qname.local)) return null;
    if (P.isTagged(type, "Simple"))
      return this.invalid(
        "UnexpectedAttribute",
        `<${ev.name}> has a simple type, so it can't have the attribute ${a.name}`,
        a.span.start,
      );
    const found = R.get(type.attributes, key);
    if (Option.isNone(found)) return this.wildcardAttribute(a, qname, type, bindings, props);
    const rule = found.value;
    const v = this.value(rule.checker, a.value, bindings, a.span.start);
    if (Result.isFailure(v))
      return this.invalid("InvalidValue", `the attribute ${a.name}: ${v.failure}`, a.span.start);
    if (Option.isSome(rule.fixed) && !equalValues(rule.fixed.value, v.success))
      return this.invalid(
        "InvalidValue",
        `the attribute ${a.name} must be "${rule.use.fixed}"`,
        a.span.start,
      );
    props[rule.slot.property] = v.success;
    return null;
  }

  private wildcardAttribute(
    a: Attribute,
    qname: Expanded,
    type: ComplexRuntime,
    bindings: Readonly<Record<string, string>>,
    props: Props,
  ): Failure | null {
    const key = qname.clark;
    const unexpected = () =>
      this.invalid(
        "UnexpectedAttribute",
        `the attribute ${a.name} is not allowed here`,
        a.span.start,
      );
    if (Option.isNone(type.wildcard) || !allowsName(type.wildcard.value, qname))
      return unexpected();
    const process = type.wildcard.value.process;
    const declared = process === "skip" ? Option.none() : R.get(this.runtime.model.attributes, key);
    if (process === "strict" && Option.isNone(declared)) return unexpected();
    if (Option.isSome(declared)) {
      const checker = this.runtime.checker(declared.value.type);
      if (Result.isFailure(checker)) return checker.failure;
      const v = this.value(checker.success, a.value, bindings, a.span.start);
      if (Result.isFailure(v))
        return this.invalid("InvalidValue", `the attribute ${a.name}: ${v.failure}`, a.span.start);
    }
    const bag = props["$attributes"];
    const attributes: Record<string, string> = bag !== undefined && isBag(bag) ? bag : {};
    attributes[key] = a.value;
    props["$attributes"] = attributes;
    return null;
  }

  /** Required attributes that are missing, and defaults for those that are absent. */
  private implied(
    type: ComplexRuntime,
    props: Props,
    seen: Array<string>,
    position: Position,
    bindings: Readonly<Record<string, string>>,
  ): Failure | null {
    for (const rule of type.implied) {
      if (seen.includes(rule.use.name)) continue;
      if (rule.use.required === true)
        return this.invalid(
          "MissingAttribute",
          `the attribute ${localOf(rule.use.name)} is required`,
          position,
        );
      const known = this.defaults.get(rule);
      if (known !== undefined) {
        props[rule.slot.property] = known;
        continue;
      }
      const given = rule.use.fixed ?? rule.use.default ?? "";
      const v = this.value(rule.checker, given, bindings, position);
      if (Result.isFailure(v))
        return this.invalid(
          "InvalidValue",
          `the default of ${localOf(rule.use.name)}: ${v.failure}`,
          position,
        );
      props[rule.slot.property] = v.success;
      // A default decodes the same way every time, unless it is an ID or reference
      // (recorded per use), a QName (resolved in each element's scope) or a list or union.
      if (
        rule.checker.identity === "none" &&
        rule.checker.kind !== "qname" &&
        rule.checker.kind !== "list" &&
        rule.checker.kind !== "union" &&
        !P.isObject(v.success)
      )
        this.defaults.set(rule, v.success);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Character data
  // ---------------------------------------------------------------------------

  private text(data: string, position: Position, cdata: boolean): Failure | null {
    const frame = this.frames.at(-1);
    if (frame === undefined)
      return isWhitespace(data)
        ? null
        : new InvalidDocumentStructure({ position, reason: "text outside the root element" });
    frame.dom?.push(cdata ? Nodes.cdata(data) : Nodes.text(data));
    const type = frame.type;
    if (type === undefined) return null;
    if (frame.nil)
      return this.invalid("Nil", `<${frame.raw}> is nil, so it can't contain text`, position);
    if (P.isTagged(type, "Simple") || Option.isSome(type.simple) || type.def.mixed === true) {
      frame.text += data;
      return null;
    }
    if (P.isTagged(type.def.content, "Empty"))
      return this.invalid(
        "UnexpectedText",
        `<${frame.raw}> must be empty, but contains text`,
        position,
      );
    return isWhitespace(data)
      ? null
      : this.invalid(
          "UnexpectedText",
          `<${frame.raw}> can only contain elements, but contains text`,
          position,
        );
  }

  // ---------------------------------------------------------------------------
  // End tags
  // ---------------------------------------------------------------------------

  private end(raw: string, position: Position): Failure | null {
    const frame = this.frames.at(-1);
    if (frame === undefined) return new UnexpectedEndTag({ tagName: raw, position });
    if (frame.raw !== raw)
      return new MismatchedEndTag({ expected: frame.raw, actual: raw, position });
    // A skipped element's DOM is kept instead (see `close`).
    let value: XsdValue = Option.none();
    if (frame.type !== undefined) {
      const completed = this.complete(frame, position);
      if (Result.isFailure(completed)) return completed.failure;
      value = completed.success;
    }
    const element =
      frame.dom === undefined
        ? undefined
        : Nodes.element(toQName(frame.name), frame.domAttributes, frame.dom);
    if (element !== undefined) this.recordTypes(frame, element);
    const violated = this.constraints(frame, element, position);
    if (violated !== null) return violated;
    this.frames.pop();
    this.close(frame, element, value);
    return null;
  }

  /** Remember the simple types of a DOM element and its attributes, for identity constraints. */
  private recordTypes(frame: Frame, element: XmlElement): void {
    const type = frame.type;
    if (type === undefined) return;
    const context = this.contextOf(frame.bindings);
    const content = P.isTagged(type, "Simple") ? Option.some(type.checker) : type.simple;
    if (!frame.nil) Option.map(content, (checker) => this.types.set(element, { checker, context }));
    if (P.isTagged(type, "Simple")) return;
    Arr.forEach(element.attributes, (attribute) => {
      const key = clark(
        Option.getOrElse(attribute.name.namespace, () => ""),
        attribute.name.local,
      );
      const checker = Option.orElse(
        Option.map(R.get(type.attributes, key), (rule) => rule.checker),
        () =>
          Option.flatMap(
            Option.filter(type.wildcard, (w) => w.process !== "skip"),
            () =>
              Option.flatMap(R.get(this.runtime.model.attributes, key), (decl) =>
                Result.getSuccess(this.runtime.checker(decl.type)),
              ),
          ),
      );
      Option.map(checker, (c) => this.types.set(attribute, { checker: c, context }));
    });
  }

  /** Evaluate the identity constraints an element declares, over its subtree. */
  private constraints(
    frame: Frame,
    element: XmlElement | undefined,
    position: Position,
  ): Failure | null {
    const constraints = frame.decl?.constraints;
    if (constraints === undefined || element === undefined || frame.tables === undefined)
      return null;
    return Result.match(evaluateConstraints(constraints, element, frame.tables, this.typeOf), {
      onFailure: (reason) => this.invalid("IdentityConstraint", reason, position),
      onSuccess: () => null,
    });
  }

  /** Hand a completed element to its parent (or make it the document's value). */
  private close(frame: Frame, element: XmlElement | undefined, value: XsdValue): void {
    const parent = this.frames.at(-1);
    // Skipped content, and content a wildcard matched, is kept as DOM.
    const kept =
      element !== undefined && (frame.type === undefined || frame.via === "wildcard")
        ? element
        : value;
    if (Option.isSome(frame.held)) this.emit(frame.held.value);
    if (parent === undefined) {
      if (frame.selected) this.emit([kept]);
      this.done = Option.some({ name: frame.key, value: kept });
      return;
    }
    if (parent.tables !== undefined && frame.tables !== undefined)
      merge(parent.tables, frame.tables);
    if (element !== undefined) parent.dom?.push(element);
    if (frame.selected) this.emit([kept]);
    else deliver(parent, frame, kept);
  }

  /**
   * Check that an element's content is complete, and build its value: a
   * nillable element's is an `Option`, none when it is nil.
   */
  private complete(frame: Frame, position: Position): Result.Result<XsdValue, Failure> {
    const decl = frame.decl;
    // Skipped content has no value: `close` keeps its DOM element instead.
    if (frame.type === undefined || decl === undefined) return Result.succeed(Option.none());
    if (decl.nillable !== true) return this.contentValue(frame, frame.type, decl, position);
    return frame.nil
      ? Result.succeed(Option.none())
      : Result.map(this.contentValue(frame, frame.type, decl, position), Option.some);
  }

  /** The value of a complete element that is not nil. */
  private contentValue(
    frame: Frame,
    type: TypeRuntime,
    decl: ElementDeclaration,
    position: Position,
  ): Result.Result<Content, Failure> {
    if (P.isTagged(type, "Complex")) {
      const state = frame.state;
      if (Option.isSome(type.automaton) && state !== undefined && !state.nullable)
        return Result.fail(
          this.invalid(
            "MissingElement",
            `<${frame.raw}> is incomplete; expected ${Arr.map(type.automaton.value.expected(state), describe(frame.name.namespace ?? "")).join(" or ")}`,
            position,
          ),
        );
    }
    if (P.isTagged(type, "Simple")) return this.simpleContent(frame, decl, type.checker, position);
    const props = frame.props;
    if (frame.xsiType !== undefined) props["$type"] = frame.xsiType;
    if (type.layout.text === "mixed") props["$text"] = frame.text;
    if (Option.isNone(type.simple)) return Result.succeed(props);
    const content = this.simpleContent(frame, decl, type.simple.value, position);
    if (Result.isFailure(content)) return content;
    props["$value"] = content.success;
    return Result.succeed(props);
  }

  private simpleContent(
    frame: Frame,
    decl: ElementDeclaration,
    checker: SimpleChecker,
    position: Position,
  ): Result.Result<SimpleValue, Failure> {
    const text = frame.text === "" ? (decl.fixed ?? decl.default ?? "") : frame.text;
    const v = this.value(checker, text, frame.bindings, position);
    if (Result.isFailure(v)) return Result.fail(this.invalid("InvalidValue", v.failure, position));
    if (decl.fixed === undefined) return Result.succeed(v.success);
    const fixed = decode(checker, decl.fixed, this.contextOf(frame.bindings));
    if (Result.isFailure(fixed))
      return Result.fail(
        this.invalid("InvalidValue", `the fixed value is invalid: ${fixed.failure}`, position),
      );
    return equalValues(fixed.success, v.success)
      ? Result.succeed(v.success)
      : Result.fail(
          this.invalid("InvalidValue", `<${frame.raw}> must be "${decl.fixed}"`, position),
        );
  }
}

/** A resolved name: what a `QName` holds, without constructing (and validating) one per element. */
interface Expanded {
  readonly prefix: string | null;
  readonly local: string;
  readonly namespace: string | null;
  readonly clark: string;
}

const expanded = (prefix: string | null, local: string, namespace: string | null): Expanded => ({
  prefix,
  local,
  namespace,
  clark: namespace === null ? local : `{${namespace}}${local}`,
});

/** The `QName` of a resolved name, for the DOM; it was resolved from a well-formed start tag. */
const toQName = (name: Expanded): QName => Nodes.qname(name.prefix, name.local, name.namespace);

interface Opening {
  readonly ev: Event<"StartElement">;
  readonly name: Expanded;
  readonly bindings: Readonly<Record<string, string>>;
  readonly index: number;
  /** Where its attributes' resolved names are remembered, when it declares no namespaces. */
  readonly attributeNames: Lookup<string, Expanded> | undefined;
}

/** The prefixes in scope for a value, as a QName-valued type resolves them. */
class BindingsContext implements ValueContext {
  private readonly bindings: Readonly<Record<string, string>>;

  constructor(bindings: Readonly<Record<string, string>>) {
    this.bindings = bindings;
  }

  resolve(prefix: string): string | undefined {
    return prefix === "xml" ? Namespaces.xml : this.bindings[prefix];
  }
}

/** Start a record's repeated children (and wildcard matches) as empty arrays, after its attributes. */
const startLists = (type: ComplexRuntime, props: Props): void => {
  for (const slot of type.layout.elements)
    if (slot.cardinality === "many") props[slot.property] = [];
  if (type.layout.any) props["$any"] = [];
};

/** Count a child element of `parent` named `raw`: its position among same-named siblings. */
const count = (parent: Frame, raw: string): number => {
  const counts = parent.counts ?? new Lookup<string, number>();
  parent.counts = counts;
  const n = (counts.get(raw) ?? 0) + 1;
  counts.set(raw, n);
  return n;
};

const isBag = (
  v: XsdValue | Array<XsdValue> | Record<string, string>,
): v is Record<string, string> =>
  P.isObject(v) && !Arr.isArray(v) && !P.isTagged(v, "XmlElement") && !(v instanceof Uint8Array);

const allowsName = (wildcard: Wildcard, name: Expanded): boolean =>
  P.isTagged(wildcard.namespaces, "Any") ||
  (P.isTagged(wildcard.namespaces, "Only")
    ? wildcard.namespaces.namespaces.includes(name.namespace ?? "")
    : P.isTagged(wildcard.namespaces, "Not") &&
      !wildcard.namespaces.namespaces.includes(name.namespace ?? ""));

/**
 * Add a closing element's key tables to its parent's: appended in place, or
 * moved when the parent has none by that name (the child's frame is done
 * with them). Copying the parent's table for every child that closed made a
 * repeated constrained element quadratic (#130).
 */
const merge = (into: Tables, from: Tables): void =>
  MutableHashMap.forEach(from, (rows, name) => {
    const existing = MutableHashMap.get(into, name);
    if (Option.isSome(existing)) existing.value.push(...rows);
    else MutableHashMap.set(into, name, rows);
  });

/** Put a child's value where its parent's layout says it goes. */
const deliver = (parent: Frame, child: Frame, value: XsdValue): void => {
  const type = parent.type;
  if (type === undefined || P.isTagged(type, "Simple")) return;
  const slot = child.via === "wildcard" ? undefined : type.layout.byName[child.key];
  const property = slot?.property ?? "$any";
  if (slot !== undefined && slot.cardinality !== "many") {
    parent.props[property] = value;
    return;
  }
  const list = parent.props[property];
  if (Arr.isArray(list)) list.push(value);
  else parent.props[property] = [value];
};
