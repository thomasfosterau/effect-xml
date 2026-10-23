/**
 * Content models as lazily built deterministic automata.
 *
 * A complex type's particle becomes a regular expression over its terms
 * (element declarations and wildcards) with counted repetition and `xs:all`
 * interleaving. A state is such an expression; reading an element moves to its
 * Brzozowski derivative. States are interned and every transition is cached on
 * the state it leaves, so the automaton is built only as far as documents
 * exercise it, and from then on reading an element is one cache lookup.
 *
 * Which term an element matches is decided among the terms that can start the
 * current state: element terms before wildcards, then in document order. The
 * schema's Unique Particle Attribution constraint means there is never more
 * than one candidate in a valid schema; in one that breaks it, the first wins.
 */
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { MaxOccurs, Particle, Wildcard } from "../../Xsd/Model.ts";

/** A term: an element declaration or a wildcard, numbered in document order. */
export type Term =
  | {
      readonly kind: "element";
      readonly index: number;
      /** The declaration's key. */
      readonly element: string;
      /** The element's expanded name. */
      readonly name: string;
    }
  | { readonly kind: "any"; readonly index: number; readonly wildcard: Wildcard };

/** What an element matched: the term, and for an element term the declaration that applies. */
export interface Match {
  readonly term: Term;
  /** The declaration (by key) the element is validated against; for wildcards, none. */
  readonly element: Option.Option<string>;
  readonly next: State;
}

type Form =
  | { readonly kind: "empty" }
  | { readonly kind: "epsilon" }
  | { readonly kind: "term"; readonly term: number }
  | { readonly kind: "seq"; readonly first: State; readonly rest: State }
  | { readonly kind: "alt"; readonly options: ReadonlyArray<State> }
  | {
      readonly kind: "repeat";
      readonly body: State;
      readonly min: number;
      readonly max: MaxOccurs;
    }
  | {
      readonly kind: "all";
      readonly members: ReadonlyArray<AllMember>;
      readonly remaining: ReadonlyArray<number>;
    };

interface AllMember {
  readonly body: State;
  readonly required: boolean;
}

/** A state of the automaton. */
export class State {
  readonly id: number;
  readonly key: string;
  readonly form: Form;
  /** May the content end here? */
  readonly nullable: boolean;
  private firstCache: ReadonlyArray<number> | undefined = undefined;
  readonly derivatives = MutableHashMap.empty<number, State>();
  readonly transitions = MutableHashMap.empty<string, Option.Option<Match>>();

  constructor(id: number, key: string, form: Form, nullable: boolean) {
    this.id = id;
    this.key = key;
    this.form = form;
    this.nullable = nullable;
  }

  /** The terms that can start this state, ascending. */
  get firsts(): ReadonlyArray<number> {
    if (this.firstCache === undefined) this.firstCache = firstsOf(this.form);
    return this.firstCache;
  }
}

const sortedUnion = (lists: ReadonlyArray<ReadonlyArray<number>>): ReadonlyArray<number> =>
  Arr.sort(Arr.dedupe(Arr.flatten(lists)), (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0));

const firstsOf = (form: Form): ReadonlyArray<number> => {
  if (form.kind === "term") return [form.term];
  if (form.kind === "seq")
    return form.first.nullable
      ? sortedUnion([form.first.firsts, form.rest.firsts])
      : form.first.firsts;
  if (form.kind === "alt") return sortedUnion(Arr.map(form.options, (o) => o.firsts));
  if (form.kind === "repeat") return form.body.firsts;
  if (form.kind === "all")
    return sortedUnion(Arr.map(form.remaining, (i) => form.members[i]?.body.firsts ?? []));
  return [];
};

const minus1 = (max: MaxOccurs): MaxOccurs => (max === "unbounded" ? max : max - 1);

/** The automaton of one content model. */
export class Automaton {
  readonly terms: ReadonlyArray<Term>;
  readonly start: State;
  private readonly interned = MutableHashMap.empty<string, State>();
  private count = 0;
  readonly empty: State;
  readonly epsilon: State;
  /** The global elements a substitution group head stands for, by expanded name. */
  private readonly substitutes: (head: string) => ReadonlyArray<readonly [string, string]>;
  private readonly allows: (wildcard: Wildcard, namespace: string) => boolean;

  constructor(
    particle: Particle,
    substitutes: (head: string) => ReadonlyArray<readonly [name: string, element: string]>,
    allows: (wildcard: Wildcard, namespace: string) => boolean,
    nameOf: (element: string) => string,
  ) {
    this.substitutes = substitutes;
    this.allows = allows;
    this.empty = this.make("0", { kind: "empty" }, false);
    this.epsilon = this.make("e", { kind: "epsilon" }, true);
    const terms: Array<Term> = [];
    this.start = this.build(particle, terms, nameOf);
    this.terms = terms;
  }

  private make(key: string, form: Form, nullable: boolean): State {
    return Option.getOrElse(MutableHashMap.get(this.interned, key), () => {
      const state = new State(this.count++, key, form, nullable);
      MutableHashMap.set(this.interned, key, state);
      return state;
    });
  }

  private term(index: number): State {
    return this.make(`t${index}`, { kind: "term", term: index }, false);
  }

  seq(first: State, rest: State): State {
    if (first === this.empty || rest === this.empty) return this.empty;
    if (first === this.epsilon) return rest;
    if (rest === this.epsilon) return first;
    // Keep sequences right-nested, so equal languages get equal keys more often.
    if (first.form.kind === "seq")
      return this.seq(first.form.first, this.seq(first.form.rest, rest));
    return this.make(
      `s${first.id},${rest.id}`,
      { kind: "seq", first, rest },
      first.nullable && rest.nullable,
    );
  }

  alt(options: ReadonlyArray<State>): State {
    const flat = Arr.flatMap(options, (o) => (o.form.kind === "alt" ? o.form.options : [o]));
    const kept = Arr.sort(
      Arr.dedupeWith(
        Arr.filter(flat, (o) => o !== this.empty),
        (a, b) => a === b,
      ),
      (a: State, b: State) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    if (Arr.isReadonlyArrayEmpty(kept)) return this.empty;
    const [only, ...more] = kept;
    if (only === undefined) return this.empty;
    if (Arr.isReadonlyArrayEmpty(more)) return only;
    return this.make(
      `a${Arr.map(kept, (o) => o.id).join(",")}`,
      { kind: "alt", options: kept },
      kept.some((o) => o.nullable),
    );
  }

  repeat(body: State, min: number, max: MaxOccurs): State {
    if (max === 0 || body === this.epsilon) return this.epsilon;
    if (body === this.empty) return min === 0 ? this.epsilon : this.empty;
    if (min === 1 && max === 1) return body;
    return this.make(
      `r${body.id},${min},${max}`,
      { kind: "repeat", body, min, max },
      min === 0 || body.nullable,
    );
  }

  all(members: ReadonlyArray<AllMember>, remaining: ReadonlyArray<number>): State {
    if (Arr.isReadonlyArrayEmpty(remaining)) return this.epsilon;
    return this.make(
      `l${Arr.map(members, (m) => `${m.body.id}${m.required ? "!" : "?"}`).join(",")}|${remaining.join(",")}`,
      { kind: "all", members, remaining },
      remaining.every((i) => members[i]?.required !== true),
    );
  }

  private build(
    particle: Particle,
    terms: Array<Term>,
    nameOf: (element: string) => string,
  ): State {
    const min = particle.min ?? 1;
    const max = particle.max ?? 1;
    if (Predicate.isTagged(particle, "Element") || Predicate.isTagged(particle, "Any")) {
      const index = terms.length;
      terms.push(
        Predicate.isTagged(particle, "Element")
          ? { kind: "element", index, element: particle.element, name: nameOf(particle.element) }
          : { kind: "any", index, wildcard: particle.wildcard },
      );
      return this.repeat(this.term(index), min, max);
    }
    const parts = Arr.map(particle.particles, (p) => this.build(p, terms, nameOf));
    if (Predicate.isTagged(particle, "All")) {
      // An `all` member occurs at most once; whether it must is the member's own bound.
      const members = Arr.map(particle.particles, (p, i) => ({
        body: this.unbound(parts[i] ?? this.empty),
        required: (p.min ?? 1) > 0,
      }));
      return this.repeat(
        this.all(
          members,
          Arr.map(members, (_, i) => i),
        ),
        min,
        max,
      );
    }
    const body = Predicate.isTagged(particle, "Sequence")
      ? Arr.reduceRight(parts, this.epsilon, (rest, p) => this.seq(p, rest))
      : this.alt(parts);
    return this.repeat(body, min, max);
  }

  /** A repetition of at most one occurrence, as its body (an `all` member's optionality is the member's). */
  private unbound(state: State): State {
    return state.form.kind === "repeat" && state.form.max === 1 ? state.form.body : state;
  }

  /** The state after reading term `term`. */
  derive(state: State, term: number): State {
    return Option.getOrElse(MutableHashMap.get(state.derivatives, term), () => {
      const next = this.derivative(state, term);
      MutableHashMap.set(state.derivatives, term, next);
      return next;
    });
  }

  private derivative(state: State, term: number): State {
    const form = state.form;
    if (form.kind === "term") return form.term === term ? this.epsilon : this.empty;
    if (form.kind === "seq") {
      const head = this.seq(this.derive(form.first, term), form.rest);
      return form.first.nullable ? this.alt([head, this.derive(form.rest, term)]) : head;
    }
    if (form.kind === "alt") return this.alt(Arr.map(form.options, (o) => this.derive(o, term)));
    if (form.kind === "repeat")
      return this.seq(
        this.derive(form.body, term),
        this.repeat(form.body, Math.max(form.min - 1, 0), minus1(form.max)),
      );
    if (form.kind === "all")
      return this.alt(
        Arr.map(form.remaining, (i) => {
          const member = form.members[i];
          if (member === undefined || !member.body.firsts.includes(term)) return this.empty;
          return this.seq(
            this.derive(member.body, term),
            this.all(
              form.members,
              Arr.filter(form.remaining, (j) => j !== i),
            ),
          );
        }),
      );
    return this.empty;
  }

  /** Which declaration a term stands for when it reads an element named `name`, if it does. */
  private matchTerm(
    term: Term,
    name: string,
    namespace: string,
  ): Option.Option<Option.Option<string>> {
    if (term.kind === "any")
      return this.allows(term.wildcard, namespace) ? Option.some(Option.none()) : Option.none();
    // A substitution group head stands for its members, and itself only if it isn't abstract.
    return Option.map(
      Arr.findFirst(this.substitutes(term.element), ([member]) => member === name),
      ([, element]) => Option.some(element),
    );
  }

  /** Read an element: the term it matches and the state after it, or nothing when it isn't allowed. */
  step(state: State, name: string, namespace: string): Option.Option<Match> {
    return Option.getOrElse(MutableHashMap.get(state.transitions, name), () => {
      const candidates = Arr.getSomes(
        Arr.map(state.firsts, (i) =>
          Option.flatMap(Option.fromNullishOr(this.terms[i]), (term) =>
            Option.map(this.matchTerm(term, name, namespace), (element) => ({ term, element })),
          ),
        ),
      );
      const chosen = Option.orElse(
        Arr.findFirst(candidates, (c) => c.term.kind === "element"),
        () => Arr.head(candidates),
      );
      const out = Option.map(chosen, ({ term, element }) => ({
        term,
        element,
        next: this.derive(state, term.index),
      }));
      // Bound the cache: wildcards can see any number of distinct names.
      if (MutableHashMap.size(state.transitions) < 256)
        MutableHashMap.set(state.transitions, name, out);
      return out;
    });
  }

  /** The terms that could come next, for messages. */
  expected(state: State): ReadonlyArray<Term> {
    return Arr.getSomes(Arr.map(state.firsts, (i) => Option.fromNullishOr(this.terms[i])));
  }
}
