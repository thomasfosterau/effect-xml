/**
 * Expansion of entities whose replacement text contains markup, and of
 * attribute-list defaults (with `dtd: "internal"`).
 *
 * A reference to such an entity reaches the SAX layer as an `EntityReference`
 * event. Its replacement text is lexed with the document's own tables and
 * spliced in, with every event given the reference's span. Each entity is
 * lexed once and its events reused, so a document with many references costs
 * linear time, while each use still counts against the expansion budget.
 *
 * Replacement text must be balanced markup. With `recover: true` it is read
 * as recovering XML reads content and then balanced: an end tag that closes
 * nothing opened in it is dropped, one that names an element open further
 * out closes the ones inside it first, the elements still open at its end
 * are closed there, and a declaration in it is dropped. Characters XML does
 * not allow, recursion, external entities and the limits still fail.
 */
import { unsafeAttrName } from "../Name.ts";
import { InvalidEntity, LimitExceeded, type LexError } from "../Error.ts";
import type { Span } from "../Position.ts";
import { collapse, type Dtd } from "./dtd.ts";
import type { ExpansionFailure } from "./entities.ts";
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import {
  isDoctypeEvent,
  isEndElementEvent,
  isEntityReferenceEvent,
  isFault,
  isStartElementEvent,
  isXmlDeclarationEvent,
  Lexer,
  type LexEvent,
  type LexOutput,
} from "./lexer.ts";

type Failure = LexError | LimitExceeded;

interface Expansion {
  readonly events: ReadonlyArray<LexEvent>;
  /** The replacement text one use adds, nested entities included. */
  readonly charge: number;
}

const withSpan = (ev: LexEvent, span: Span): LexEvent =>
  isStartElementEvent(ev)
    ? { ...ev, span, attributes: ev.attributes.map((a) => ({ ...a, span })) }
    : { ...ev, span };

export class Expander {
  private readonly cache = MutableHashMap.empty<string, Expansion>();

  private readonly dtd: Dtd;
  private readonly entities: Record<string, string>;
  /** XML `recover: true`: repair replacement text that is not balanced markup. */
  private readonly recover: boolean;

  constructor(dtd: Dtd, entities: Record<string, string>, recover = false) {
    this.dtd = dtd;
    this.entities = entities;
    this.recover = recover;
  }

  /** The events a markup entity reference stands for, or the fault it causes. */
  expand(ref: Extract<LexEvent, { _tag: "EntityReference" }>): ReadonlyArray<LexOutput> {
    const out = this.get(ref.name, [], ref.span);
    if (!("events" in out)) return [{ _tag: "Fault", error: out }];
    return out.events.map((ev) => withSpan(ev, ref.span));
  }

  private fail(name: string, span: Span, failure: ExpansionFailure): Failure {
    return failure.limit !== undefined
      ? new LimitExceeded({
          limit: failure.limit.name,
          max: failure.limit.max,
          position: Option.some(span.start),
        })
      : new InvalidEntity({ reference: `&${name};`, position: span.start, reason: failure.reason });
  }

  private get(name: string, stack: ReadonlyArray<string>, span: Span): Expansion | Failure {
    const cached = MutableHashMap.get(this.cache, name);
    if (Option.isSome(cached)) {
      const over = this.dtd.charge(cached.value.charge);
      return over === null ? cached.value : this.fail(name, span, over);
    }
    const before = this.dtd.spent;
    const value = this.dtd.replacement(name, stack);
    if (!P.isString(value)) return this.fail(name, span, value);
    const lexer = new Lexer({
      mode: "xml",
      entities: this.entities,
      dtd: this.dtd,
      content: true,
      recover: this.recover,
    });
    lexer.push(value);
    const outputs = lexer.end();
    const events: Array<LexEvent> = [];
    const unbalanced = () =>
      this.fail(name, span, { reason: "replacement text is not balanced markup" });
    let depth = 0;
    const balanced = new Balanced(events);
    /** Take one output of the replacement text; a failure ends the expansion. */
    const take = (o: LexOutput): Failure | null => {
      if (isFault(o)) {
        // Positions inside replacement text mean little; report the reference.
        return P.isTagged(o.error, "LimitExceeded")
          ? new LimitExceeded({
              limit: o.error.limit,
              max: o.error.max,
              position: Option.some(span.start),
            })
          : new InvalidEntity({
              reference: `&${name};`,
              position: span.start,
              reason: o.error.message,
            });
      }
      if (isEntityReferenceEvent(o)) {
        const inner = this.get(o.name, [...stack, name], span);
        if (!("events" in inner)) return inner;
        events.push(...inner.events);
        return null;
      }
      if (isDoctypeEvent(o) || isXmlDeclarationEvent(o)) {
        return this.recover
          ? null
          : this.fail(name, span, {
              reason: "a declaration is not allowed in entity replacement text",
            });
      }
      if (this.recover) {
        balanced.take(o);
        return null;
      }
      if (isStartElementEvent(o) && !o.selfClosing) depth++;
      else if (isEndElementEvent(o) && --depth < 0) return unbalanced();
      events.push(o);
      return null;
    };
    // The replacement text is lexed in full first (its tokens don't depend on
    // how they are taken), and `take` recurses into nested entities directly:
    // few stack frames per nesting level, so deep chains reach their depth
    // limit rather than overflow the stack.
    let failure: Failure | null = null;
    outputs.every((o) => {
      failure = take(o);
      return failure === null;
    });
    if (failure !== null) return failure;
    if (this.recover) balanced.end();
    else if (depth !== 0) return unbalanced();
    const expansion = { events, charge: this.dtd.spent - before };
    MutableHashMap.set(this.cache, name, expansion);
    return expansion;
  }
}

/**
 * Recovery: the events of replacement text, kept balanced in `out` (see
 * {@link Expander}). Each end tag it adds has the span of its start tag:
 * every event of an expansion is given the reference's span anyway.
 */
class Balanced {
  private readonly out: Array<LexEvent>;
  /** The start tags open, innermost last. */
  private readonly open: Array<Extract<LexEvent, { _tag: "StartElement" }>> = [];

  constructor(out: Array<LexEvent>) {
    this.out = out;
  }

  take(ev: LexEvent): void {
    if (isStartElementEvent(ev)) {
      if (!ev.selfClosing) this.open.push(ev);
    } else if (isEndElementEvent(ev)) {
      const at = Arr.findLastIndex(this.open, (s) => s.name === ev.name);
      if (Option.isNone(at)) return;
      this.closeTo(at.value + 1);
      this.open.pop();
    }
    this.out.push(ev);
  }

  /** The end of the replacement text: close what is still open. */
  end(): void {
    this.closeTo(0);
  }

  /** Close the open elements above the first `depth`, innermost first. */
  private closeTo(depth: number): void {
    Arr.forEach(Arr.reverse(this.open.splice(depth)), (start) =>
      this.out.push({ name: start.name, span: start.span, _tag: "EndElement" }),
    );
  }
}

/** Apply an element's declared attribute defaults and the normalization of tokenized types. */
export const applyDefaults = (
  dtd: Dtd,
  ev: Extract<LexEvent, { _tag: "StartElement" }>,
): LexEvent => {
  const decls = dtd.attributes(ev.name);
  if (decls === undefined) return ev;
  const attributes = ev.attributes.map((a) => {
    const decl = decls.find((d) => d.name === a.name);
    return decl?.tokenized === true ? { ...a, value: collapse(a.value) } : a;
  });
  // Each declared default the element lacks, in declaration order (the first
  // declaration of a name wins).
  const withDefaults = Arr.reduce(decls, attributes, (present, d) =>
    d.value === null || present.some((a) => a.name === d.name)
      ? present
      : [...present, { name: unsafeAttrName(d.name), value: d.value, span: ev.span }],
  );
  return { ...ev, attributes: withDefaults };
};
