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
import { InvalidEntity, LimitExceeded, type LexError } from "../Error.ts"
import type { Span } from "../Position.ts"
import { collapse, type Dtd } from "./dtd.ts"
import type { ExpansionFailure } from "./entities.ts"
import { Lexer, type LexEvent, type LexOutput } from "./lexer.ts"

type Failure = LexError | LimitExceeded

interface Expansion {
  readonly events: ReadonlyArray<LexEvent>
  /** The replacement text one use adds, nested entities included. */
  readonly charge: number
}

const withSpan = (ev: LexEvent, span: Span): LexEvent =>
  ev._tag === "StartElement"
    ? { ...ev, span, attributes: ev.attributes.map((a) => ({ ...a, span })) }
    : { ...ev, span }

export class Expander {
  private readonly cache = new Map<string, Expansion>()

  constructor(
    private readonly dtd: Dtd,
    private readonly entities: Record<string, string>
  ) {}

  /** The events a markup entity reference stands for, or the fault it causes. */
  expand(ref: Extract<LexEvent, { _tag: "EntityReference" }>): ReadonlyArray<LexOutput> {
    const out = this.get(ref.name, [], ref.span)
    if (!("events" in out)) return [{ _tag: "Fault", error: out }]
    return out.events.map((ev) => withSpan(ev, ref.span))
  }

  private fail(name: string, span: Span, failure: ExpansionFailure): Failure {
    return failure.limit !== undefined
      ? new LimitExceeded({ limit: failure.limit.name, max: failure.limit.max, position: span.start })
      : new InvalidEntity({ reference: `&${name};`, position: span.start, reason: failure.reason })
  }

  private get(name: string, stack: ReadonlyArray<string>, span: Span): Expansion | Failure {
    const cached = this.cache.get(name)
    if (cached !== undefined) {
      const over = this.dtd.charge(cached.charge)
      return over === null ? cached : this.fail(name, span, over)
    }
    const before = this.dtd.spent
    const value = this.dtd.replacement(name, stack)
    if (typeof value !== "string") return this.fail(name, span, value)
    const lexer = new Lexer({ mode: "xml", entities: this.entities, dtd: this.dtd })
    lexer.push(value)
    lexer.close()
    const events: Array<LexEvent> = []
    const unbalanced = () => this.fail(name, span, { reason: "replacement text is not balanced markup" })
    let depth = 0
    for (let outs = lexer.pull(); outs !== null; outs = lexer.pull()) {
      for (const o of outs) {
        switch (o._tag) {
          case "Fault":
            // Positions inside replacement text mean little; report the reference.
            return o.error instanceof LimitExceeded
              ? new LimitExceeded({ limit: o.error.limit, max: o.error.max, position: span.start })
              : new InvalidEntity({ reference: `&${name};`, position: span.start, reason: o.error.message })
          case "EntityReference": {
            const inner = this.get(o.name, [...stack, name], span)
            if (!("events" in inner)) return inner
            for (const ev of inner.events) events.push(ev)
            continue
          }
          case "Doctype":
          case "XmlDeclaration":
            return this.fail(name, span, { reason: "a declaration is not allowed in entity replacement text" })
          case "StartElement":
            if (!o.selfClosing) depth++
            break
          case "EndElement":
            if (--depth < 0) return unbalanced()
            break
        }
        events.push(o)
      }
    }
    if (depth !== 0) return unbalanced()
    const expansion = { events, charge: this.dtd.spent - before }
    this.cache.set(name, expansion)
    return expansion
  }
}

/** Apply an element's declared attribute defaults and the normalization of tokenized types. */
export const applyDefaults = (dtd: Dtd, ev: Extract<LexEvent, { _tag: "StartElement" }>): LexEvent => {
  const decls = dtd.attributes(ev.name)
  if (decls === undefined) return ev
  const attributes = ev.attributes.map((a) => {
    const decl = decls.find((d) => d.name === a.name)
    return decl?.tokenized === true ? { ...a, value: collapse(a.value) } : a
  })
  for (const d of decls) {
    if (d.value !== null && !attributes.some((a) => a.name === d.name)) {
      attributes.push({ name: d.name, value: d.value, span: ev.span })
    }
  }
  return { ...ev, attributes }
}
