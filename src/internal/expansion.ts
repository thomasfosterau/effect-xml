/**
 * Expansion of entities whose replacement text contains markup, and of
 * attribute-list defaults (with `dtd: "internal"`).
 *
 * A reference to such an entity reaches the SAX layer as an `EntityReference`
 * event. Its replacement text is lexed with the document's own tables and
 * spliced in, with every event given the reference's span. Each entity is
 * lexed once and its events reused, so a document with many references costs
 * linear time, while each use still counts against the expansion budget.
 */
import { InvalidEntity, LimitExceeded, type LexError } from "../Error.ts";
import type { Span } from "../Position.ts";
import { collapse, type Dtd } from "./dtd.ts";
import type { ExpansionFailure } from "./entities.ts";
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
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

  constructor(dtd: Dtd, entities: Record<string, string>) {
    this.dtd = dtd;
    this.entities = entities;
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
          position: span.start,
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
    if (!Predicate.isString(value)) return this.fail(name, span, value);
    const lexer = new Lexer({ mode: "xml", entities: this.entities, dtd: this.dtd });
    lexer.push(value);
    const outputs = lexer.end();
    const events: Array<LexEvent> = [];
    const unbalanced = () =>
      this.fail(name, span, { reason: "replacement text is not balanced markup" });
    let depth = 0;
    /** Take one output of the replacement text; a failure ends the expansion. */
    const take = (o: LexOutput): Failure | null => {
      if (isFault(o)) {
        // Positions inside replacement text mean little; report the reference.
        return Predicate.isTagged(o.error, "LimitExceeded")
          ? new LimitExceeded({ limit: o.error.limit, max: o.error.max, position: span.start })
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
        return this.fail(name, span, {
          reason: "a declaration is not allowed in entity replacement text",
        });
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
    if (depth !== 0) return unbalanced();
    const expansion = { events, charge: this.dtd.spent - before };
    MutableHashMap.set(this.cache, name, expansion);
    return expansion;
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
      : [...present, { name: d.name, value: d.value, span: ev.span }],
  );
  return { ...ev, attributes: withDefaults };
};
