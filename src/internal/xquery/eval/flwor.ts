/**
 * FLWOR expressions (XQuery 3.1 §3.12): `for`, `let`, `window`, `where`,
 * `group by`, `order by`, `count` and `return`.
 *
 * The clauses are compiled to a pipeline of {@link Stage}s over a stream of
 * tuples. A tuple is the values of the FLWOR's variables, which live in
 * frame slots: a stage gets each tuple with those slots set, binds its own
 * and passes the tuple on, then hears that the stream has ended. Most stages
 * are streaming; `order by` and `group by` collect the tuples (the values of
 * the slots the FLWOR has bound so far) and replay them, sorted or grouped,
 * when the stream ends. What a stage collects or counts belongs to one
 * evaluation ({@link Run}), so a FLWOR re-entered by a recursive call keeps
 * its tuples apart.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AtomicValue, atomicString } from "../atomic.ts";
import { atomize, effectiveBooleanValue, sameKey, type Item, type Sequence } from "../item.ts";
import type {
  Clause as ClauseT,
  Expr as ExprT,
  ForBinding,
  OrderSpec,
  SequenceType as SequenceTypeT,
} from "../parser/ast.ts";
import { Clause } from "../parser/ast.ts";
import { codepointCollation, type StaticContext } from "../parser/context.ts";
import { AtomicTypes } from "../types.ts";
import { orderCompare } from "./compare.ts";
import { notImplemented, raise, unwrap } from "./raise.ts";
import type { Code, Ctx, SeqType } from "./runtime.ts";
import { bindLocal, clark, resolve, slotIn, type Scope } from "./scope.ts";
import { sequenceMatches, sequenceType } from "./seqtype.ts";

/** The evaluator's expression compiler, passed in to avoid an import cycle. */
type CompileExpr = (e: ExprT, scope: Scope) => Code;

const empty: Sequence = [];

const ebv = (s: Sequence, offset: number): boolean => unwrap(effectiveBooleanValue(s), offset);

const integerValue = (n: number): Sequence => [AtomicValue.integer(BigInt(n))];

const seqTypeOf = (t: SequenceTypeT, scope: Scope): SeqType =>
  sequenceType(t, (n, k) => resolve(scope, n, k));

const optionalType = (t: Option.Option<SequenceTypeT>, scope: Scope): SeqType | undefined =>
  Option.getOrUndefined(Option.map(t, (x) => seqTypeOf(x, scope)));

/** A value checked against a variable's declared type: `err:XPTY0004` if it doesn't match. */
export const checkType = (t: SeqType | undefined, v: Sequence, offset: number): Sequence =>
  t === undefined || sequenceMatches(t, v)
    ? v
    : raise("XPTY0004", `a value does not match ${t.text}`, offset);

/** A binding of `for`, `some` or `every`: its sequence's code, its slot and its declared type. */
export interface Bound {
  readonly code: Code;
  readonly slot: number;
  readonly position: number | undefined;
  readonly type: SeqType | undefined;
  readonly allowingEmpty: boolean;
}

/** Compile a `for`, `some` or `every` binding, and bind its variables. */
export const bindFor = (
  b: ForBinding,
  scope: Scope,
  compileExpr: CompileExpr,
): readonly [Scope, Bound] => {
  const code = compileExpr(b.in, scope);
  const type = optionalType(b.type, scope);
  const [s1, slot] = bindLocal(scope, b.name);
  const [s2, position] = Option.match(b.position, {
    onNone: (): readonly [Scope, number | undefined] => [s1, undefined],
    onSome: (p) => bindLocal(s1, p),
  });
  return [s2, { code, slot, position, type, allowingEmpty: b.allowingEmpty }];
};

// -----------------------------------------------------------------------------
// Stages
// -----------------------------------------------------------------------------

/** A tuple an `order by` or `group by` has collected: the FLWOR's slots' values, and its keys. */
interface Collected {
  readonly values: ReadonlyArray<Sequence>;
  readonly keys: ReadonlyArray<AtomicValue | undefined>;
}

/** One evaluation of a FLWOR: its results, and the state of its stages. */
interface Run {
  readonly out: Array<Item>;
  /** Tuples collected by each `order by` / `group by`, by its index. */
  readonly collected: Array<Array<Collected>>;
  /** How many tuples each `count` clause has numbered, by its index. */
  readonly counts: Array<number>;
}

/** The rest of a FLWOR from some clause on. */
interface Stage {
  /** Take a tuple (the FLWOR's slots set in `ctx.frame`). */
  readonly tuple: (ctx: Ctx, run: Run) => void;
  /** The tuple stream has ended. */
  readonly end: (ctx: Ctx, run: Run) => void;
}

/** What compiling the clauses from one on needs: the variables bound so far, and stage indices. */
interface Compiling {
  readonly clauses: ReadonlyArray<ClauseT>;
  readonly ret: ExprT;
  readonly compileExpr: CompileExpr;
  /** How many stages have state in a {@link Run}. */
  readonly indices: { collected: number; counts: number };
}

type Rest = (scope: Scope, slots: ReadonlyArray<number>) => Stage;

/** A stage that passes each tuple on unchanged but for `each`. */
const streaming = (next: Stage, each: (ctx: Ctx, run: Run) => void): Stage => ({
  tuple: each,
  end: next.end,
});

const forStage = (
  b: ForBinding,
  scope: Scope,
  slots: ReadonlyArray<number>,
  rest: Rest,
  c: Compiling,
  offset: number,
): Stage => {
  const [inner, bound] = bindFor(b, scope, c.compileExpr);
  const next = rest(inner, [
    ...slots,
    bound.slot,
    ...(bound.position === undefined ? [] : [bound.position]),
  ]);
  return streaming(next, (ctx, run) => {
    const items = bound.code(ctx);
    if (Arr.isReadonlyArrayEmpty(items) && bound.allowingEmpty) {
      ctx.frame[bound.slot] = checkType(bound.type, empty, offset);
      if (bound.position !== undefined) ctx.frame[bound.position] = integerValue(0);
      next.tuple(ctx, run);
      return;
    }
    items.forEach((item, i) => {
      ctx.frame[bound.slot] = checkType(bound.type, [item], offset);
      if (bound.position !== undefined) ctx.frame[bound.position] = integerValue(i + 1);
      next.tuple(ctx, run);
    });
  });
};

const letStage = (
  b: {
    readonly name: ForBinding["name"];
    readonly type: Option.Option<SequenceTypeT>;
    readonly value: ExprT;
  },
  scope: Scope,
  slots: ReadonlyArray<number>,
  rest: Rest,
  c: Compiling,
  offset: number,
): Stage => {
  const code = c.compileExpr(b.value, scope);
  const type = optionalType(b.type, scope);
  const [inner, slot] = bindLocal(scope, b.name);
  const next = rest(inner, [...slots, slot]);
  return streaming(next, (ctx, run) => {
    ctx.frame[slot] = checkType(type, code(ctx), offset);
    next.tuple(ctx, run);
  });
};

/** Several bindings of one clause, each a clause of its own. */
const chainBindings = <B>(
  bindings: ReadonlyArray<B>,
  scope: Scope,
  slots: ReadonlyArray<number>,
  rest: Rest,
  one: (b: B, s: Scope, slots: ReadonlyArray<number>, r: Rest) => Stage,
): Stage => {
  const go = (i: number, s: Scope, bound: ReadonlyArray<number>): Stage => {
    const b = bindings[i];
    return b === undefined
      ? rest(s, bound)
      : one(b, s, bound, (next, more) => go(i + 1, next, more));
  };
  return go(0, scope, slots);
};

const countStage = (
  name: ForBinding["name"],
  scope: Scope,
  slots: ReadonlyArray<number>,
  rest: Rest,
  c: Compiling,
): Stage => {
  const [inner, slot] = bindLocal(scope, name);
  const index = c.indices.counts;
  c.indices.counts += 1;
  const next = rest(inner, [...slots, slot]);
  return streaming(next, (ctx, run) => {
    const n = (run.counts[index] ?? 0) + 1;
    run.counts[index] = n;
    ctx.frame[slot] = integerValue(n);
    next.tuple(ctx, run);
  });
};

// ---- window -------------------------------------------------------------------

type WindowT = Extract<ClauseT, { readonly _tag: "Window" }>;
type ConditionT = WindowT["start"];

/** A window condition's variables' slots, and its `when` compiled where they are bound. */
interface Condition {
  readonly current: number | undefined;
  readonly position: number | undefined;
  readonly previous: number | undefined;
  readonly next: number | undefined;
  readonly when: Code;
}

const bindOptional = (
  scope: Scope,
  name: Option.Option<ForBinding["name"]>,
): readonly [Scope, number | undefined] =>
  Option.match(name, {
    onNone: (): readonly [Scope, number | undefined] => [scope, undefined],
    onSome: (n) => bindLocal(scope, n),
  });

const condition = (cond: ConditionT, scope: Scope, c: Compiling): readonly [Scope, Condition] => {
  const [s1, current] = bindOptional(scope, cond.vars.current);
  const [s2, position] = bindOptional(s1, cond.vars.position);
  const [s3, previous] = bindOptional(s2, cond.vars.previous);
  const [s4, next] = bindOptional(s3, cond.vars.next);
  return [s4, { current, position, previous, next, when: c.compileExpr(cond.when, s4) }];
};

const conditionSlots = (cond: Condition): ReadonlyArray<number> =>
  [cond.current, cond.position, cond.previous, cond.next].filter((s) => s !== undefined);

/** Bind a condition's variables for the item at index `i`. */
const setCondition = (ctx: Ctx, cond: Condition, items: Sequence, i: number): void => {
  const at = (j: number): Sequence => {
    const item = items[j];
    return item === undefined ? empty : [item];
  };
  if (cond.current !== undefined) ctx.frame[cond.current] = at(i);
  if (cond.position !== undefined) ctx.frame[cond.position] = integerValue(i + 1);
  if (cond.previous !== undefined) ctx.frame[cond.previous] = at(i - 1);
  if (cond.next !== undefined) ctx.frame[cond.next] = at(i + 1);
};

const windowStage = (
  w: WindowT,
  scope: Scope,
  slots: ReadonlyArray<number>,
  rest: Rest,
  c: Compiling,
): Stage => {
  const code = c.compileExpr(w.in, scope);
  const type = optionalType(w.type, scope);
  const [afterStart, start] = condition(w.start, scope, c);
  const [afterEnd, end] = Option.match(w.end, {
    onNone: (): readonly [Scope, Condition | undefined] => [afterStart, undefined],
    onSome: (e) => condition(e, afterStart, c),
  });
  const [inner, slot] = bindLocal(afterEnd, w.name);
  const next = rest(inner, [
    ...slots,
    ...conditionSlots(start),
    ...(end === undefined ? [] : conditionSlots(end)),
    slot,
  ]);
  return streaming(next, (ctx, run) => {
    const items = code(ctx);
    const last = items.length - 1;
    const startsAt = (i: number): boolean => {
      setCondition(ctx, start, items, i);
      return ebv(start.when(ctx), w.offset);
    };
    const endsAt = (s: number, e: number): boolean => {
      if (end === undefined) return false;
      setCondition(ctx, start, items, s);
      setCondition(ctx, end, items, e);
      return ebv(end.when(ctx), w.offset);
    };
    const emit = (s: number, e: number): void => {
      setCondition(ctx, start, items, s);
      if (end !== undefined) setCondition(ctx, end, items, e);
      ctx.frame[slot] = checkType(type, items.slice(s, e + 1), w.offset);
      next.tuple(ctx, run);
    };
    /** The window starting at `s`: up to where its end condition first holds, or to the last item. */
    const fromStart = (s: number): number => {
      const e = items.findIndex((_, j) => j >= s && endsAt(s, j));
      if (e >= 0) emit(s, e);
      else if (!w.onlyEnd) emit(s, last);
      return e >= 0 ? e + 1 : items.length;
    };
    if (w.sliding) {
      items.forEach((_, s) => {
        if (startsAt(s)) fromStart(s);
      });
      return;
    }
    if (end !== undefined) {
      // A tumbling window: the next one may start only after this one ends.
      items.reduce((free, _, i) => (i >= free && startsAt(i) ? fromStart(i) : free), 0);
      return;
    }
    // Without an end condition, a tumbling window ends where the next one starts.
    const starts = Arr.filter(
      Arr.makeBy(items.length, (i) => i),
      startsAt,
    );
    starts.forEach((s, k) => emit(s, (starts[k + 1] ?? items.length) - 1));
  });
};

// ---- order by -------------------------------------------------------------------

const htmlCaseInsensitive =
  "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive";

/** Fold a string for a collation (HTML ASCII case-insensitive folds A–Z), `undefined` for one this engine can't use. */
const collationFold = (
  written: Option.Option<string>,
  context: StaticContext,
  offset: number,
): ((s: string) => string) => {
  const uri = Option.match(written, {
    onNone: () => context.defaultCollation,
    onSome: (u) =>
      Option.match(context.baseUri, {
        onNone: () => u,
        onSome: (base) => (URL.canParse(u, base) ? new URL(u, base).href : u),
      }),
  });
  if (uri === codepointCollation) return (x) => x;
  if (uri === htmlCaseInsensitive) return (x) => x.replace(/[A-Z]/g, (ch) => ch.toLowerCase());
  return notImplemented(`the collation ${uri}`, offset);
};

/** A key of `order by` or `group by`: at most one atomic value, `xs:untypedAtomic` as `xs:string`. */
const keyOf = (value: Sequence, what: string, offset: number): AtomicValue | undefined => {
  const atoms = unwrap(atomize(value), offset);
  const [a] = atoms;
  if (atoms.length > 1)
    return raise("XPTY0004", `${what} must be at most one atomic value`, offset);
  if (a === undefined) return undefined;
  return a.type === AtomicTypes.untypedAtomic ? AtomicValue.string(atomicString(a)) : a;
};

/** A key as a collation compares it: strings folded. */
const folded = (
  a: AtomicValue | undefined,
  fold: (s: string) => string,
): AtomicValue | undefined =>
  a !== undefined && a.type.primitive === "string"
    ? new AtomicValue(a.type, fold(atomicString(a)))
    : a;

const isNaNKey = (a: AtomicValue): boolean => Predicate.isNumber(a.value) && Number.isNaN(a.value);

interface OrderKey {
  readonly code: Code;
  readonly descending: boolean;
  readonly emptyGreatest: boolean;
  readonly fold: (s: string) => string;
}

/** Where a key sorts by kind: the empty sequence first or last, NaN next to it. */
const rank = (a: AtomicValue | undefined, emptyGreatest: boolean): number => {
  if (a === undefined) return emptyGreatest ? 3 : 0;
  if (isNaNKey(a)) return emptyGreatest ? 2 : 1;
  return emptyGreatest ? 1 : 2;
};

const compareKeys = (
  keys: ReadonlyArray<OrderKey>,
  x: Collected,
  y: Collected,
  tz: number,
  offset: number,
): number =>
  keys.reduce((c, key, i) => {
    if (c !== 0) return c;
    const a = x.keys[i];
    const b = y.keys[i];
    const ra = rank(a, key.emptyGreatest);
    const rb = rank(b, key.emptyGreatest);
    const d =
      ra !== rb || a === undefined || b === undefined || isNaNKey(a) || isNaNKey(b)
        ? ra - rb
        : orderCompare(a, b, tz, offset);
    return key.descending ? -d : d;
  }, 0);

const orderStage = (
  o: Extract<ClauseT, { readonly _tag: "OrderBy" }>,
  scope: Scope,
  slots: ReadonlyArray<number>,
  rest: Rest,
  c: Compiling,
): Stage => {
  const context = scope.statics.context;
  const keys = o.specs.map((s: OrderSpec): OrderKey => ({
    code: c.compileExpr(s.expr, scope),
    descending: s.descending,
    emptyGreatest: Option.getOrElse(s.emptyGreatest, () => context.emptyOrder === "greatest"),
    fold: collationFold(s.collation, context, o.offset),
  }));
  const index = c.indices.collected;
  c.indices.collected += 1;
  const next = rest(scope, slots);
  return {
    tuple: (ctx, run) => {
      const collected = (run.collected[index] ??= []);
      collected.push({
        values: slots.map((s) => ctx.frame[s] ?? empty),
        keys: keys.map((k) => folded(keyOf(k.code(ctx), "an order by key", o.offset), k.fold)),
      });
    },
    end: (ctx, run) => {
      const collected = run.collected[index] ?? [];
      run.collected[index] = [];
      const tz = ctx.dyn.implicitTimezone;
      // `Array.prototype.sort` is stable, so `stable order by` needs nothing more.
      collected
        .toSorted((x, y) => compareKeys(keys, x, y, tz, o.offset))
        .forEach((t) => {
          slots.forEach((s, i) => {
            ctx.frame[s] = t.values[i] ?? empty;
          });
          next.tuple(ctx, run);
        });
      next.end(ctx, run);
    },
  };
};

// ---- group by -------------------------------------------------------------------

/** A grouping key's identity: equal keys (`fn:deep-equal`, NaN equal to NaN) have the same string. */
const groupingKey = (a: AtomicValue | undefined, fold: (s: string) => string): string => {
  const f = folded(a, fold);
  return f === undefined ? "()" : sameKey(f);
};

/** A `$k := expr` grouping spec's binding, computed before the grouping. */
interface GroupingLet {
  readonly slot: number;
  readonly value: Code;
}

interface GroupingVar {
  readonly slot: number;
  readonly type: SeqType | undefined;
  readonly fold: (s: string) => string;
}

const groupStage = (
  g: Extract<ClauseT, { readonly _tag: "GroupBy" }>,
  scope: Scope,
  slots: ReadonlyArray<number>,
  rest: Rest,
  c: Compiling,
): Stage => {
  const context = scope.statics.context;
  // `group by $k := e` is `let $k := e` before the grouping: every value first, then the names.
  const [inner, lets] = g.specs.reduce<readonly [Scope, ReadonlyArray<GroupingLet>]>(
    ([sc, acc], spec) =>
      Option.match(spec.value, {
        onNone: () => [sc, acc],
        onSome: (v) => {
          const value = c.compileExpr(v, sc);
          const [next, slot] = bindLocal(sc, spec.name);
          return [next, [...acc, { slot, value }]];
        },
      }),
    [scope, []],
  );
  const vars = g.specs.map((spec): GroupingVar => {
    const bound = HashMap.get(inner.vars, clark(resolve(inner, spec.name, "variable")));
    const slot =
      Option.isSome(bound) && bound.value.kind === "local"
        ? slotIn(inner.layout, bound.value.binding)
        : raise("XQST0094", "a grouping variable is not bound by the FLWOR", spec.name.offset);
    return {
      slot,
      type: optionalType(spec.type, inner),
      fold: collationFold(spec.collation, context, g.offset),
    };
  });
  const all = Arr.dedupe([...slots, ...lets.map((l) => l.slot), ...vars.map((v) => v.slot)]);
  const grouping = vars.map((v) => v.slot);
  const index = c.indices.collected;
  c.indices.collected += 1;
  const next = rest(inner, all);
  return {
    tuple: (ctx, run) => {
      lets.forEach((l) => {
        ctx.frame[l.slot] = l.value(ctx);
      });
      const keys = vars.map((v) => {
        const atoms = unwrap(atomize(ctx.frame[v.slot] ?? empty), g.offset);
        checkType(v.type, atoms, g.offset);
        return keyOf(atoms, "a grouping key", g.offset);
      });
      (run.collected[index] ??= []).push({ values: all.map((s) => ctx.frame[s] ?? empty), keys });
    },
    end: (ctx, run) => {
      const collected = run.collected[index] ?? [];
      run.collected[index] = [];
      const groups = collected.reduce(
        (acc, t) => {
          const id = t.keys
            .map((k, i) => groupingKey(k, vars[i]?.fold ?? ((x) => x)))
            .join("\u0000");
          const known = HashMap.get(acc.byKey, id);
          if (Option.isSome(known)) known.value.push(t);
          else {
            const members = [t];
            acc.order.push(members);
            acc.byKey = HashMap.set(acc.byKey, id, members);
          }
          return acc;
        },
        { order: Arr.empty<Array<Collected>>(), byKey: HashMap.empty<string, Array<Collected>>() },
      ).order;
      groups.forEach((members) => {
        const [first] = members;
        all.forEach((s, i) => {
          const k = grouping.indexOf(s);
          const key = k >= 0 ? first?.keys[k] : undefined;
          ctx.frame[s] =
            k >= 0
              ? key === undefined
                ? empty
                : [key]
              : members.flatMap((m) => m.values[i] ?? empty);
        });
        next.tuple(ctx, run);
      });
      next.end(ctx, run);
    },
  };
};

// -----------------------------------------------------------------------------
// The pipeline
// -----------------------------------------------------------------------------

const stageAt = (i: number, scope: Scope, slots: ReadonlyArray<number>, c: Compiling): Stage => {
  const clause = c.clauses[i];
  if (clause === undefined) {
    const code = c.compileExpr(c.ret, scope);
    return {
      tuple: (ctx, run) => {
        run.out.push(...code(ctx));
      },
      end: () => {},
    };
  }
  const rest: Rest = (s, more) => stageAt(i + 1, s, more, c);
  return Clause.$match(clause, {
    For: ({ bindings, offset }) =>
      chainBindings(bindings, scope, slots, rest, (b, s, bound, r) =>
        forStage(b, s, bound, r, c, offset),
      ),
    Let: ({ bindings, offset }) =>
      chainBindings(bindings, scope, slots, rest, (b, s, bound, r) =>
        letStage(b, s, bound, r, c, offset),
      ),
    Where: ({ condition: cond, offset }) => {
      const test = c.compileExpr(cond, scope);
      const next = rest(scope, slots);
      return streaming(next, (ctx, run) => {
        if (ebv(test(ctx), offset)) next.tuple(ctx, run);
      });
    },
    Count: ({ name }) => countStage(name, scope, slots, rest, c),
    Window: (w) => windowStage(w, scope, slots, rest, c),
    GroupBy: (g) => groupStage(g, scope, slots, rest, c),
    OrderBy: (o) => orderStage(o, scope, slots, rest, c),
  });
};

/** Compile a FLWOR expression. */
export const flwor = (
  e: Extract<ExprT, { readonly _tag: "Flwor" }>,
  scope: Scope,
  compileExpr: CompileExpr,
): Code => {
  const c: Compiling = {
    clauses: e.clauses,
    ret: e.return,
    compileExpr,
    indices: { collected: 0, counts: 0 },
  };
  const first = stageAt(0, scope, [], c);
  return (ctx) => {
    const run: Run = { out: [], collected: [], counts: [] };
    first.tuple(ctx, run);
    first.end(ctx, run);
    return run.out;
  };
};
