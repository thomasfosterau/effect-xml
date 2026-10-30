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
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
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
import { origin, type Position } from "../../Position.ts";
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
import { evaluate, type Tables, type Typed, type TypeOf } from "./identity.ts";
import { advance, selects, type StepLevel, type StreamStep } from "../streamPath.ts";
import type { ComplexRuntime, Runtime, TypeRuntime } from "./runtime.ts";
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
  counts: Record<string, number> | undefined = undefined;
  /** The declaration and type it is validated against; `undefined` for content that is skipped. */
  readonly decl: ElementDeclaration | undefined;
  readonly type: TypeRuntime | undefined;
  /** The type named by `xsi:type`, when it differs from the declared one. */
  readonly xsiType: string | undefined;
  readonly nil: boolean;
  readonly props: Props;
  state: Option.Option<State>;
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

  constructor(init: {
    readonly via: Frame["via"];
    readonly raw: string;
    readonly name: Expanded;
    readonly bindings: Readonly<Record<string, string>>;
    readonly index: number;
    readonly decl: ElementDeclaration | undefined;
    readonly type: TypeRuntime | undefined;
    readonly xsiType: string | undefined;
    readonly nil: boolean;
    readonly props: Props;
    readonly dom: boolean;
    readonly domAttributes: ReadonlyArray<XmlAttribute>;
    readonly tables: boolean;
  }) {
    this.via = init.via;
    this.raw = init.raw;
    this.name = init.name;
    this.key = init.name.clark;
    this.bindings = init.bindings;
    this.index = init.index;
    this.decl = init.decl;
    this.type = init.type;
    this.xsiType = init.xsiType;
    this.nil = init.nil;
    this.props = init.props;
    this.state =
      init.type !== undefined && Predicate.isTagged(init.type, "Complex")
        ? Option.map(init.type.automaton, (a) => a.start)
        : Option.none();
    this.dom = init.dom ? [] : undefined;
    this.domAttributes = init.domAttributes;
    this.tables = init.tables ? MutableHashMap.empty() : undefined;
  }
}

const ok: Result.Result<void, Failure> = Result.void;

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

/** The namespaces in scope after an element's declarations. */
const declare = (
  parent: Readonly<Record<string, string>>,
  attributes: ReadonlyArray<Attribute>,
): Readonly<Record<string, string>> =>
  Arr.reduce(attributes, parent, (scope, a) =>
    a.name === "xmlns"
      ? { ...scope, "": a.value }
      : a.name.startsWith("xmlns:")
        ? { ...scope, [a.name.slice(6)]: a.value }
        : scope,
  );

/** The `xsi:` attribute with this local name, if the start tag has one. */
const xsiAttribute = (
  attributes: ReadonlyArray<Attribute>,
  bindings: Readonly<Record<string, string>>,
  local: string,
): Option.Option<Attribute> =>
  Arr.findFirst(attributes, (a) => {
    const colon = a.name.indexOf(":");
    return (
      colon > 0 && a.name.slice(colon + 1) === local && bindings[a.name.slice(0, colon)] === XSI
    );
  });

const isNamespaceDeclaration = (a: Attribute) => a.name === "xmlns" || a.name.startsWith("xmlns:");

const matchEvent = Data.taggedEnum<SaxEvent>().$match;

type Event<Tag extends SaxEvent["_tag"]> = Extract<SaxEvent, { readonly _tag: Tag }>;

export interface ValidatorOptions {
  /** The expanded name the document element must have. */
  readonly root?: string | undefined;
  /**
   * The elements to stream out: each one matching these steps is emitted
   * (see {@link Validator.drain}) once it is complete, instead of becoming
   * part of its parent's value.
   */
  readonly select?: ReadonlyArray<StreamStep> | undefined;
}

export class Validator {
  private readonly runtime: Runtime;
  private readonly root: string | undefined;
  private readonly steps: ReadonlyArray<StreamStep>;
  private readonly frames: Array<Frame> = [];
  /** Selected values completed and ready to emit. */
  private emitted: Array<XsdValue> = [];
  private readonly ids = MutableHashSet.empty<string>();
  /** The simple types of DOM nodes built for identity constraints, for comparing their fields. */
  private readonly types = new WeakMap<object, Typed>();
  private readonly typeOf: TypeOf = (node) => Option.fromUndefinedOr(this.types.get(node));
  private readonly refs: Array<{
    readonly id: string;
    readonly position: Position;
    readonly path: string;
  }> = [];
  private done: Option.Option<Validated> = Option.none();
  /** The element whose start tag is being checked, before it is pushed. */
  private opening: string | undefined = undefined;
  private last: Position = origin;

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
    this.last = ev.span.end;
    return matchEvent(ev, this.handlers);
  }

  private readonly handlers = {
    StartElement: (ev: Event<"StartElement">) => this.start(ev),
    EndElement: (ev: Event<"EndElement">) => this.end(ev.name, ev.span.start),
    Text: (ev: Event<"Text">) => this.text(ev.data, ev.span.start, false),
    CData: (ev: Event<"CData">) => this.text(ev.data, ev.span.start, true),
    Comment: (ev: Event<"Comment">) => this.capture(Nodes.comment(ev.data)),
    ProcessingInstruction: (ev: Event<"ProcessingInstruction">) =>
      this.capture(Nodes.processingInstruction(ev.target, ev.data)),
    Doctype: () => null,
    XmlDeclaration: () => null,
  };

  /** The end of the input: anything left open or unresolved is an error. */
  finish(): Failure | null {
    const open = this.frames.at(-1);
    if (open !== undefined)
      return new InvalidDocumentStructure({
        position: this.last,
        reason: `unexpected end of input: <${open.raw}> was never closed`,
      });
    if (Option.isNone(this.done))
      return new InvalidDocumentStructure({
        position: this.last,
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
    const own = this.opening === undefined ? "" : `/${this.opening}`;
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
      return new UnboundNamespacePrefix({ prefix, name: raw, position });
    return expanded(prefix, local, ns === undefined || ns === "" ? null : ns);
  }

  private contextOf(bindings: Readonly<Record<string, string>>): ValueContext {
    return {
      resolve: (prefix) => (prefix === "xml" ? Namespaces.xml : bindings[prefix]),
    };
  }

  /** Decode a value, recording IDs and references; the reason when it is invalid. */
  private value(
    checker: SimpleChecker,
    raw: string,
    bindings: Readonly<Record<string, string>>,
    position: Position,
  ): Result.Result<SimpleValue, string> {
    return Result.flatMap(decode(checker, raw, this.contextOf(bindings)), (v) => {
      if (checker.identity === "ID" && Predicate.isString(v)) {
        if (MutableHashSet.has(this.ids, v)) return Result.fail(`the ID "${v}" is used twice`);
        MutableHashSet.add(this.ids, v);
      }
      if (checker.identity === "IDREF" && Predicate.isString(v))
        this.refs.push({ id: v, position, path: this.path() });
      if (checker.identity === "IDREFS" && Arr.isArray(v))
        Arr.forEach(Arr.filter(v, Predicate.isString), (id) =>
          this.refs.push({ id, position, path: this.path() }),
        );
      return Result.succeed(v);
    });
  }

  private capture(node: XmlNode): null {
    this.frames.at(-1)?.dom?.push(node);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Start tags
  // ---------------------------------------------------------------------------

  private start(ev: Event<"StartElement">): Failure | null {
    const duplicate = Arr.findFirst(ev.attributes, (a, i) =>
      ev.attributes.some((b, j) => j < i && b.name === a.name),
    );
    if (Option.isSome(duplicate))
      return new DuplicateAttribute({
        element: ev.name,
        attribute: duplicate.value.name,
        position: duplicate.value.span.start,
      });
    const parent = this.frames.at(-1);
    const bindings = declare(parent?.bindings ?? {}, ev.attributes);
    const name = this.resolve(ev.name, false, bindings, ev.span.start);
    if (name instanceof UnboundNamespacePrefix) return name;
    const index = parent === undefined ? 1 : count(parent, ev.name);
    const opening = { ev, name, bindings, index } as const;
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
      opening.name,
      () =>
        Nodes.element(
          toQName(opening.name),
          Result.getOrElse(this.domAttributes(opening.ev, opening.bindings), () => []),
          [],
        ),
    );
    frame.level = Option.some(level);
    frame.selected = selects(this.steps, level);
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
    if (
      Predicate.isTagged(type, "Simple") ||
      Option.isNone(type.automaton) ||
      Option.isNone(parent.state)
    )
      return this.invalid(
        "UnexpectedElement",
        `<${parent.raw}> can't contain elements, but contains <${ev.name}>`,
        ev.span.start,
      );
    const automaton = type.automaton.value;
    const state = parent.state.value;
    return Option.match(automaton.step(state, name.clark, name.namespace ?? ""), {
      onNone: () => {
        const expected = Arr.map(automaton.expected(state), describe(name.namespace ?? ""));
        return this.invalid(
          "UnexpectedElement",
          Arr.isReadonlyArrayEmpty(expected)
            ? `<${ev.name}> is not allowed here: <${parent.raw}> is already complete`
            : `<${ev.name}> is not allowed here; expected ${expected.join(" or ")}`,
          ev.span.start,
        );
      },
      onSome: (match) => {
        parent.state = Option.some(match.next);
        const capture = parent.dom !== undefined;
        if (match.term.kind === "element")
          return Option.match(
            Option.flatMap(match.element, (k) => this.runtime.element(k)),
            {
              onNone: () => this.open(opening, "wildcard", undefined, true),
              onSome: (decl) => this.open(opening, "particle", decl, capture),
            },
          );
        return this.startWildcard(opening, match.term.wildcard.process);
      },
    });
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
  private typeFor(
    opening: Opening,
    decl: ElementDeclaration,
  ): Result.Result<readonly [TypeRuntime, string | undefined], Failure> {
    const { ev, bindings } = opening;
    const raw = xsiAttribute(ev.attributes, bindings, "type");
    const named = Option.match(raw, {
      onNone: () => Result.succeed(Option.none<string>()),
      onSome: (a) =>
        Result.mapBoth(decode(this.qnameChecker, a.value, this.contextOf(bindings)), {
          onFailure: (reason) => this.invalid("InvalidType", `xsi:type: ${reason}`, a.span.start),
          onSuccess: (v) => Option.some(String(v)),
        }),
    });
    return Result.flatMap(named, (xsiType) => {
      const key = Option.getOrElse(xsiType, () => decl.type);
      const blocked = this.blockedFor(decl, key);
      if (Option.isSome(blocked))
        return Result.fail(this.invalid("InvalidType", blocked.value, ev.span.start));
      return Result.flatMap(
        this.runtime.type(key),
        (type): Result.Result<readonly [TypeRuntime, string | undefined], Failure> =>
          Predicate.isTagged(type, "Complex") && type.def.abstract === true
            ? Result.fail(this.invalid("InvalidType", `the type ${key} is abstract`, ev.span.start))
            : Result.succeed([type, key === decl.type ? undefined : key] as const),
      );
    });
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
            onSome: (t) => (Predicate.isTagged(t, "ComplexType") ? (t.block ?? []) : []),
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

  private nilOf(opening: Opening, decl: ElementDeclaration): Result.Result<boolean, Failure> {
    const { ev, bindings } = opening;
    const raw = xsiAttribute(ev.attributes, bindings, "nil");
    return Option.match(raw, {
      onNone: () => Result.succeed(false),
      onSome: (a) => {
        const v = a.value.trim();
        const nil = v === "true" || v === "1";
        if (!nil && v !== "false" && v !== "0")
          return Result.fail(
            this.invalid("Nil", `xsi:nil="${a.value}" is not a boolean`, a.span.start),
          );
        if (nil && decl.nillable !== true)
          return Result.fail(this.invalid("Nil", `<${ev.name}> is not nillable`, a.span.start));
        if (nil && decl.fixed !== undefined)
          return Result.fail(
            this.invalid("Nil", `<${ev.name}> has a fixed value, so it can't be nil`, a.span.start),
          );
        return Result.succeed(nil);
      },
    });
  }

  /** Push an element: validated against `decl` if there is one, skipped (and kept as DOM) otherwise. */
  private open(
    opening: Opening,
    via: Frame["via"],
    decl: ElementDeclaration | undefined,
    dom: boolean,
  ): Failure | null {
    const { ev, name, bindings, index } = opening;
    const parent = this.frames.at(-1);
    const domAttributes = dom ? this.domAttributes(ev, bindings) : Result.succeed([]);
    if (Result.isFailure(domAttributes)) return domAttributes.failure;
    if (decl === undefined) {
      this.frames.push(
        new Frame({
          via,
          raw: ev.name,
          name,
          bindings,
          index,
          decl,
          type: undefined,
          xsiType: undefined,
          nil: false,
          props: {},
          dom: true,
          domAttributes: domAttributes.success,
          tables: parent?.tables !== undefined,
        }),
      );
      return null;
    }
    // The element isn't on the stack yet: its errors name it in their path.
    this.opening = `${ev.name}${index > 1 ? `[${index}]` : ""}`;
    const checked = this.checkStart(opening, decl);
    this.opening = undefined;
    if (Result.isFailure(checked)) return checked.failure;
    const [type, xsiType, nil, props] = checked.success;
    const scoped = decl.constraints !== undefined || parent?.tables !== undefined;
    this.frames.push(
      new Frame({
        via,
        raw: ev.name,
        name,
        bindings,
        index,
        decl,
        type,
        xsiType,
        nil,
        props,
        dom: dom || decl.constraints !== undefined,
        domAttributes:
          dom || decl.constraints === undefined
            ? domAttributes.success
            : Result.getOrElse(this.domAttributes(ev, bindings), () => []),
        tables: scoped,
      }),
    );
    return null;
  }

  private checkStart(
    opening: Opening,
    decl: ElementDeclaration,
  ): Result.Result<readonly [TypeRuntime, string | undefined, boolean, Props], Failure> {
    const { ev } = opening;
    if (decl.abstract === true)
      return Result.fail(
        this.invalid("InvalidType", `the element <${ev.name}> is abstract`, ev.span.start),
      );
    return Result.flatMap(this.typeFor(opening, decl), ([type, xsiType]) =>
      Result.flatMap(this.nilOf(opening, decl), (nil) =>
        Result.map(this.attributes(opening, type), (props) => [type, xsiType, nil, props] as const),
      ),
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
        return name instanceof UnboundNamespacePrefix
          ? Result.fail(name)
          : Result.succeed(Nodes.attribute(toQName(name), a.value));
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Attributes
  // ---------------------------------------------------------------------------

  private attributes(opening: Opening, type: TypeRuntime): Result.Result<Props, Failure> {
    const { ev, bindings } = opening;
    const props: Props = {};
    const seen: Array<string> = [];
    const each = Arr.reduce(
      Arr.filter(ev.attributes, (a) => !isNamespaceDeclaration(a)),
      ok,
      (acc, a) =>
        Result.flatMap(acc, () => this.attribute(a, type, bindings, props, seen, ev.name)),
    );
    return Result.flatMap(each, () =>
      Predicate.isTagged(type, "Complex")
        ? Result.map(this.implied(type, props, seen, ev.span.start, bindings), withLists(type))
        : Result.succeed(props),
    );
  }

  private attribute(
    a: Attribute,
    type: TypeRuntime,
    bindings: Readonly<Record<string, string>>,
    props: Props,
    seen: Array<string>,
    element: string,
  ): Result.Result<void, Failure> {
    const qname = this.resolve(a.name, true, bindings, a.span.start);
    if (qname instanceof UnboundNamespacePrefix) return Result.fail(qname);
    const key = qname.clark;
    if (seen.includes(key))
      return Result.fail(
        new DuplicateAttribute({ element, attribute: a.name, position: a.span.start }),
      );
    seen.push(key);
    if (qname.namespace === XSI && isIn(xsiAttributes, qname.local)) return Result.void;
    if (Predicate.isTagged(type, "Simple"))
      return Result.fail(
        this.invalid(
          "UnexpectedAttribute",
          `<${element}> has a simple type, so it can't have the attribute ${a.name}`,
          a.span.start,
        ),
      );
    return Option.match(Record.get(type.attributes, key), {
      onSome: (rule) =>
        Result.flatMap(
          Result.mapError(
            this.value(rule.checker, a.value, bindings, a.span.start),
            (reason): Failure =>
              this.invalid("InvalidValue", `the attribute ${a.name}: ${reason}`, a.span.start),
          ),
          (v) => {
            if (Option.isSome(rule.fixed) && !equalValues(rule.fixed.value, v))
              return Result.fail(
                this.invalid(
                  "InvalidValue",
                  `the attribute ${a.name} must be "${rule.use.fixed}"`,
                  a.span.start,
                ),
              );
            props[rule.slot.property] = v;
            return ok;
          },
        ),
      onNone: () => this.wildcardAttribute(a, qname, type, bindings, props),
    });
  }

  private wildcardAttribute(
    a: Attribute,
    qname: Expanded,
    type: ComplexRuntime,
    bindings: Readonly<Record<string, string>>,
    props: Props,
  ): Result.Result<void, Failure> {
    const key = qname.clark;
    const unexpected = () =>
      Result.fail(
        this.invalid(
          "UnexpectedAttribute",
          `the attribute ${a.name} is not allowed here`,
          a.span.start,
        ),
      );
    if (Option.isNone(type.wildcard) || !allowsName(type.wildcard.value, qname))
      return unexpected();
    const process = type.wildcard.value.process;
    const declared =
      process === "skip" ? Option.none() : Record.get(this.runtime.model.attributes, key);
    if (process === "strict" && Option.isNone(declared)) return unexpected();
    const checked = Option.match(declared, {
      onNone: () => Result.void,
      onSome: (decl) =>
        Result.flatMap(this.runtime.checker(decl.type), (checker) =>
          Result.mapBoth(this.value(checker, a.value, bindings, a.span.start), {
            onFailure: (reason): Failure =>
              this.invalid("InvalidValue", `the attribute ${a.name}: ${reason}`, a.span.start),
            onSuccess: () => undefined,
          }),
        ),
    });
    return Result.map(checked, () => {
      const bag = props["$attributes"];
      const attributes: Record<string, string> = bag !== undefined && isBag(bag) ? bag : {};
      attributes[key] = a.value;
      props["$attributes"] = attributes;
    });
  }

  /** Required attributes that are missing, and defaults for those that are absent. */
  private implied(
    type: ComplexRuntime,
    props: Props,
    seen: Array<string>,
    position: Position,
    bindings: Readonly<Record<string, string>>,
  ): Result.Result<Props, Failure> {
    return Result.map(
      Result.all(
        Arr.map(
          Arr.filter(type.implied, (r) => !seen.includes(r.use.name)),
          (rule): Result.Result<void, Failure> => {
            if (rule.use.required === true)
              return Result.fail(
                this.invalid(
                  "MissingAttribute",
                  `the attribute ${localOf(rule.use.name)} is required`,
                  position,
                ),
              );
            const given = rule.use.fixed ?? rule.use.default ?? "";
            return Result.mapBoth(this.value(rule.checker, given, bindings, position), {
              onFailure: (reason): Failure =>
                this.invalid(
                  "InvalidValue",
                  `the default of ${localOf(rule.use.name)}: ${reason}`,
                  position,
                ),
              onSuccess: (v) => {
                props[rule.slot.property] = v;
              },
            });
          },
        ),
      ),
      () => props,
    );
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
    if (
      Predicate.isTagged(type, "Simple") ||
      Option.isSome(type.simple) ||
      type.def.mixed === true
    ) {
      frame.text += data;
      return null;
    }
    if (Predicate.isTagged(type.def.content, "Empty"))
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
    if (frame === undefined) return new UnexpectedEndTag({ name: raw, position });
    if (frame.raw !== raw)
      return new MismatchedEndTag({ expected: frame.raw, actual: raw, position });
    const value = frame.type === undefined ? Result.succeed(null) : this.complete(frame, position);
    if (Result.isFailure(value)) return value.failure;
    const element = Option.map(Option.fromNullishOr(frame.dom), (children) =>
      Nodes.element(toQName(frame.name), frame.domAttributes, children),
    );
    Option.map(element, (el) => this.recordTypes(frame, el));
    const violated = this.constraints(frame, element, position);
    if (violated !== null) return violated;
    this.frames.pop();
    this.close(frame, element, value.success);
    return null;
  }

  /** Remember the simple types of a DOM element and its attributes, for identity constraints. */
  private recordTypes(frame: Frame, element: XmlElement): void {
    const type = frame.type;
    if (type === undefined) return;
    const context = this.contextOf(frame.bindings);
    const content = Predicate.isTagged(type, "Simple") ? Option.some(type.checker) : type.simple;
    if (!frame.nil) Option.map(content, (checker) => this.types.set(element, { checker, context }));
    if (Predicate.isTagged(type, "Simple")) return;
    Arr.forEach(element.attributes, (attribute) => {
      const key = clark(attribute.name.namespace ?? "", attribute.name.local);
      const checker = Option.orElse(
        Option.map(Record.get(type.attributes, key), (rule) => rule.checker),
        () =>
          Option.flatMap(
            Option.filter(type.wildcard, (w) => w.process !== "skip"),
            () =>
              Option.flatMap(Record.get(this.runtime.model.attributes, key), (decl) =>
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
    element: Option.Option<XmlElement>,
    position: Position,
  ): Failure | null {
    const constraints = frame.decl?.constraints;
    if (constraints === undefined || Option.isNone(element) || frame.tables === undefined)
      return null;
    return Result.match(evaluate(constraints, element.value, frame.tables, this.typeOf), {
      onFailure: (reason) => this.invalid("IdentityConstraint", reason, position),
      onSuccess: () => null,
    });
  }

  /** Hand a completed element to its parent (or make it the document's value). */
  private close(frame: Frame, element: Option.Option<XmlElement>, value: XsdValue): void {
    const parent = this.frames.at(-1);
    // Skipped content, and content a wildcard matched, is kept as DOM.
    const kept = Option.getOrElse(
      Option.filter(element, () => frame.type === undefined || frame.via === "wildcard"),
      () => value,
    );
    Option.map(frame.held, (held) => this.emit(held));
    if (parent === undefined) {
      if (frame.selected) this.emit([kept]);
      this.done = Option.some({ name: frame.key, value: kept });
      return;
    }
    if (parent.tables !== undefined && frame.tables !== undefined)
      merge(parent.tables, frame.tables);
    Option.map(element, (el) => parent.dom?.push(el));
    if (frame.selected) this.emit([kept]);
    else deliver(parent, frame, kept);
  }

  /** Check that an element's content is complete, and build its value. */
  private complete(frame: Frame, position: Position): Result.Result<XsdValue, Failure> {
    const type = frame.type;
    const decl = frame.decl;
    if (type === undefined || decl === undefined) return Result.succeed(null);
    if (Predicate.isTagged(type, "Complex")) {
      const missing = Option.flatMap(
        Option.all([type.automaton, frame.state]),
        ([automaton, state]) =>
          state.nullable ? Option.none() : Option.some(automaton.expected(state)),
      );
      if (Option.isSome(missing))
        return Result.fail(
          this.invalid(
            "MissingElement",
            `<${frame.raw}> is incomplete; expected ${Arr.map(missing.value, describe(frame.name.namespace ?? "")).join(" or ")}`,
            position,
          ),
        );
    }
    if (frame.nil) return Result.succeed(null);
    if (Predicate.isTagged(type, "Simple"))
      return this.simpleContent(frame, decl, type.checker, position);
    const props = frame.props;
    if (frame.xsiType !== undefined) props["$type"] = frame.xsiType;
    if (type.layout.text === "mixed") props["$text"] = frame.text;
    return Option.match(type.simple, {
      onNone: () => Result.succeed<XsdValue>(props),
      onSome: (checker) =>
        Result.map(this.simpleContent(frame, decl, checker, position), (v) => {
          props["$value"] = v;
          return props;
        }),
    });
  }

  private simpleContent(
    frame: Frame,
    decl: ElementDeclaration,
    checker: SimpleChecker,
    position: Position,
  ): Result.Result<XsdValue, Failure> {
    const text = frame.text === "" ? (decl.fixed ?? decl.default ?? "") : frame.text;
    return Result.flatMap(
      Result.mapError(this.value(checker, text, frame.bindings, position), (reason) =>
        this.invalid("InvalidValue", reason, position),
      ),
      (v) =>
        decl.fixed === undefined
          ? Result.succeed(v)
          : Result.flatMap(
              Result.mapError(
                decode(checker, decl.fixed, this.contextOf(frame.bindings)),
                (reason) =>
                  this.invalid("InvalidValue", `the fixed value is invalid: ${reason}`, position),
              ),
              (fixed) =>
                equalValues(fixed, v)
                  ? Result.succeed(v)
                  : Result.fail(
                      this.invalid(
                        "InvalidValue",
                        `<${frame.raw}> must be "${decl.fixed}"`,
                        position,
                      ),
                    ),
            ),
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
}

/** Start a record's repeated children (and wildcard matches) as empty arrays, after its attributes. */
const withLists =
  (type: ComplexRuntime) =>
  (props: Props): Props => {
    Arr.forEach(type.layout.elements, (slot) => {
      if (slot.cardinality === "many") props[slot.property] = [];
    });
    if (type.layout.any) props["$any"] = [];
    return props;
  };

/** Count a child element of `parent` named `raw`: its position among same-named siblings. */
const count = (parent: Frame, raw: string): number => {
  const counts = parent.counts ?? {};
  parent.counts = counts;
  const n = (counts[raw] ?? 0) + 1;
  counts[raw] = n;
  return n;
};

const isBag = (
  v: XsdValue | Array<XsdValue> | Record<string, string>,
): v is Record<string, string> =>
  Predicate.isObject(v) &&
  !Arr.isArray(v) &&
  !(v instanceof XmlElement) &&
  !(v instanceof Uint8Array);

const allowsName = (wildcard: Wildcard, name: Expanded): boolean =>
  Predicate.isTagged(wildcard.namespaces, "Any") ||
  (Predicate.isTagged(wildcard.namespaces, "Only")
    ? wildcard.namespaces.namespaces.includes(name.namespace ?? "")
    : Predicate.isTagged(wildcard.namespaces, "Not") &&
      !wildcard.namespaces.namespaces.includes(name.namespace ?? ""));

const merge = (into: Tables, from: Tables): void =>
  MutableHashMap.forEach(from, (rows, name) => {
    MutableHashMap.set(into, name, [
      ...Option.getOrElse(MutableHashMap.get(into, name), () => []),
      ...rows,
    ]);
  });

/** Put a child's value where its parent's layout says it goes. */
const deliver = (parent: Frame, child: Frame, value: XsdValue): void => {
  const type = parent.type;
  if (type === undefined || Predicate.isTagged(type, "Simple")) return;
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
