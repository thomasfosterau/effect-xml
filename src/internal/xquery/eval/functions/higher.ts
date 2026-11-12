/**
 * Higher-order functions (F&O 3.1 §16: `function-lookup`, `function-name`,
 * `for-each`, `filter`, `fold-left`, `fold-right`, `for-each-pair`, `sort`,
 * `apply`), and the rest of the map and array functions (§17).
 *
 * Function arguments arrive already coerced to their declared function
 * types, so calling one applies the function conversion rules to what it is
 * given and returns. `fn:sort` and `array:sort` are stable.
 */
import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import { QName } from "../../../../Name.ts";
import { AtomicValue } from "../../atomic.ts";
import {
  ArrayItem,
  atomize,
  effectiveBooleanValue,
  FunctionItem,
  MapItem,
  sameKey,
  type Sequence,
} from "../../item.ts";
import { orderAtomic } from "../compare.ts";
import { raise, unwrap } from "../raise.ts";
import { callFunction, isCallable } from "../runtime.ts";
import { collate, collationArg, collationNamed, type Collation } from "./collation.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import { arg, arrayOf, atomOf, isEmpty, mapOf, text } from "./values.ts";

/** The function of a `function(…)` argument. */
const functionOf = (s: Sequence): FunctionItem | MapItem | ArrayItem => {
  const [f] = s;
  return f !== undefined && isCallable(f)
    ? f
    : raise("XPTY0004", "an argument does not have its declared function type");
};

const call1 = (
  f: FunctionItem | MapItem | ArrayItem,
  call: Call,
  ...args: ReadonlyArray<Sequence>
) => callFunction(f, args, call.offset);

/** A predicate's result, which its type makes a single `xs:boolean`. */
const truth = (s: Sequence, call: Call): boolean => unwrap(effectiveBooleanValue(s), call.offset);

// -----------------------------------------------------------------------------
// Sorting
// -----------------------------------------------------------------------------

const isNaNValue = (a: AtomicValue): boolean => P.isNumber(a.value) && Number.isNaN(a.value);

/** Compare two sort keys item by item: NaN first, a shorter key before a longer one it starts. */
const compareKeys = (
  x: ReadonlyArray<AtomicValue>,
  y: ReadonlyArray<AtomicValue>,
  collation: Collation,
  call: Call,
): number => {
  const differing = Arr.findFirst(Arr.zip(x, y), ([a, b]) => {
    if (isNaNValue(a) || isNaNValue(b)) return isNaNValue(a) !== isNaNValue(b);
    return (
      orderAtomic(
        a,
        b,
        call.ctx.dyn.implicitTimezone,
        (s, t) => collate(collation, s, t),
        call.offset,
      ) !== 0
    );
  });
  return Option.match(differing, {
    onNone: () => x.length - y.length,
    onSome: ([a, b]) =>
      isNaNValue(a)
        ? -1
        : isNaNValue(b)
          ? 1
          : orderAtomic(
              a,
              b,
              call.ctx.dyn.implicitTimezone,
              (s, t) => collate(collation, s, t),
              call.offset,
            ),
  });
};

/** Items sorted by their keys (stable). */
const sortBy = (
  items: ReadonlyArray<Sequence>,
  key: (item: Sequence) => Sequence,
  collation: Collation,
  call: Call,
): ReadonlyArray<Sequence> => {
  const keyed = items.map((item) => [unwrap(atomize(key(item)), call.offset), item] as const);
  type Keyed = (typeof keyed)[number];
  return Arr.sort(keyed, (p: Keyed, q: Keyed) => {
    const c = compareKeys(p[0], q[0], collation, call);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  }).map(([, item]) => item);
};

/** The key function of a `sort` call's third argument, `fn:data` without one. */
const sortKey =
  (args: ReadonlyArray<Sequence>, call: Call) =>
  (item: Sequence): Sequence =>
    args.length > 2 ? call1(functionOf(arg(args, 2)), call, item) : item;

/** The collation of a `sort` call's second argument, which may be empty. */
const sortCollation = (args: ReadonlyArray<Sequence>, call: Call): Collation =>
  args.length > 1 && !isEmpty(arg(args, 1))
    ? collationNamed(text(arg(args, 1)), call)
    : collationArg([], 0, call);

const sortFunctions = (name: string, wrap: boolean): ReadonlyArray<BuiltinSpec> => {
  const input = wrap ? "array(*)" : "item()*";
  const impl: BuiltinSpec["impl"] = (args, call) => {
    const members = wrap ? arrayOf(arg(args, 0)).members : arg(args, 0).map((i) => [i]);
    const sorted = sortBy(members, sortKey(args, call), sortCollation(args, call), call);
    return wrap ? [new ArrayItem(sorted)] : sorted.flat();
  };
  return [
    { name, params: [input], result: input, impl },
    { name, params: [input, "xs:string?"], result: input, impl },
    {
      name,
      params: [input, "xs:string?", "function(item()*) as xs:anyAtomicType*"],
      result: input,
      impl,
    },
  ];
};

// -----------------------------------------------------------------------------
// fn: higher-order functions
// -----------------------------------------------------------------------------

const foldLeft = (
  items: ReadonlyArray<Sequence>,
  zero: Sequence,
  f: FunctionItem | MapItem | ArrayItem,
  call: Call,
): Sequence => Arr.reduce(items, zero, (acc, item) => call1(f, call, acc, item));

const foldRight = (
  items: ReadonlyArray<Sequence>,
  zero: Sequence,
  f: FunctionItem | MapItem | ArrayItem,
  call: Call,
): Sequence => Arr.reduceRight(items, zero, (acc, item) => call1(f, call, item, acc));

/** `fn:fold-left` or `fn:fold-right`: a fold over a sequence's items, each a sequence of one. */
const sequenceFold = (name: string, type: string, fold: typeof foldLeft): BuiltinSpec => ({
  name,
  params: ["item()*", "item()*", type],
  result: "item()*",
  impl: (args, call) =>
    fold(
      arg(args, 0).map((i) => [i]),
      arg(args, 1),
      functionOf(arg(args, 2)),
      call,
    ),
});

const fnHigherOrder: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:function-lookup",
    params: ["xs:QName", "xs:integer"],
    result: "function(*)?",
    impl: (args, call) => {
      const name = atomOf(arg(args, 0)).value;
      const arity = Number(atomOf(arg(args, 1)).value);
      const lookup = call.statics.lookup;
      return lookup === undefined || !(name instanceof QName)
        ? []
        : Arr.fromOption(lookup(name, arity, call.ctx, call.offset));
    },
  },
  {
    name: "fn:function-name",
    params: ["function(*)"],
    result: "xs:QName?",
    impl: (args) => {
      const f = functionOf(arg(args, 0));
      return f instanceof FunctionItem
        ? Arr.fromOption(Option.map(f.name, (q) => AtomicValue.qname(q)))
        : [];
    },
  },
  {
    name: "fn:for-each",
    params: ["item()*", "function(item()) as item()*"],
    result: "item()*",
    impl: (args, call) => {
      const f = functionOf(arg(args, 1));
      return arg(args, 0).flatMap((item) => call1(f, call, [item]));
    },
  },
  {
    name: "fn:filter",
    params: ["item()*", "function(item()) as xs:boolean"],
    result: "item()*",
    impl: (args, call) => {
      const f = functionOf(arg(args, 1));
      return arg(args, 0).filter((item) => truth(call1(f, call, [item]), call));
    },
  },
  sequenceFold("fn:fold-left", "function(item()*, item()) as item()*", foldLeft),
  sequenceFold("fn:fold-right", "function(item(), item()*) as item()*", foldRight),
  {
    name: "fn:for-each-pair",
    params: ["item()*", "item()*", "function(item(), item()) as item()*"],
    result: "item()*",
    impl: (args, call) => {
      const f = functionOf(arg(args, 2));
      return Arr.zip(arg(args, 0), arg(args, 1)).flatMap(([a, b]) => call1(f, call, [a], [b]));
    },
  },
  ...sortFunctions("fn:sort", false),
  {
    name: "fn:apply",
    params: ["function(*)", "array(*)"],
    result: "item()*",
    impl: (args, call) => {
      const f = functionOf(arg(args, 0));
      const members = arrayOf(arg(args, 1)).members;
      const arity = f instanceof FunctionItem ? f.arity : 1;
      return arity === members.length
        ? callFunction(f, members, call.offset)
        : raise(
            "FOAP0001",
            `the function takes ${arity} arguments, and the array has ${members.length} members`,
            call.offset,
          );
    },
  },
];

// -----------------------------------------------------------------------------
// map:
// -----------------------------------------------------------------------------

type Duplicates = "use-first" | "use-last" | "use-any" | "combine" | "reject";

const duplicatesOption = (options: MapItem, call: Call): Duplicates => {
  const value = options.get(AtomicValue.string("duplicates"));
  if (Option.isNone(value)) return "use-first";
  const [v] = value.value;
  const s = v instanceof AtomicValue ? String(v.value) : "";
  return s === "use-first" ||
    s === "use-last" ||
    s === "use-any" ||
    s === "combine" ||
    s === "reject"
    ? s
    : raise("FOJS0005", `"${s}" is not a value of the duplicates option`, call.offset);
};

/**
 * `map:merge`: the entries of every map, built in one pass (a map from many
 * small maps, as `map:merge(for … return map:entry(…))` builds, would cost an
 * immutable update per entry otherwise).
 */
const merge = (maps: ReadonlyArray<MapItem>, duplicates: Duplicates, call: Call): MapItem => {
  const [only] = maps;
  if (maps.length === 1 && only !== undefined) return only;
  const entries = maps.flatMap((m) => m.toEntries());
  // A later entry replaces an earlier one with the same key.
  if (duplicates === "use-last" || duplicates === "use-any") return MapItem.fromEntries(entries);
  if (duplicates === "use-first") return MapItem.fromEntries(Arr.reverse(entries));
  const groups = R.values(Arr.groupBy(entries, ([k]) => sameKey(k)));
  if (duplicates === "reject" && groups.some((g) => g.length > 1))
    return raise("FOJS0003", "map:merge was given duplicate keys", call.offset);
  return MapItem.fromEntries(groups.map((g) => [g[0][0], g.flatMap(([, v]) => v)] as const));
};

const mapsOf = (s: Sequence): ReadonlyArray<MapItem> =>
  s.filter((i): i is MapItem => i instanceof MapItem);

/** Every value of `key` in the maps anywhere inside `items`, outer ones first. */
const find = (items: Sequence, key: AtomicValue): ReadonlyArray<Sequence> =>
  items.flatMap((item): ReadonlyArray<Sequence> => {
    if (item instanceof MapItem)
      return [
        ...Arr.fromOption(item.get(key)),
        ...item.toEntries().flatMap(([, v]) => find(v, key)),
      ];
    if (item instanceof ArrayItem) return item.members.flatMap((m) => find(m, key));
    return [];
  });

const mapFunctions: ReadonlyArray<BuiltinSpec> = [
  {
    name: "map:merge",
    params: ["map(*)*"],
    result: "map(*)",
    impl: (args, call) => [merge(mapsOf(arg(args, 0)), "use-first", call)],
  },
  {
    name: "map:merge",
    params: ["map(*)*", "map(*)"],
    result: "map(*)",
    impl: (args, call) => [
      merge(mapsOf(arg(args, 0)), duplicatesOption(mapOf(arg(args, 1)), call), call),
    ],
  },
  {
    name: "map:find",
    params: ["item()*", "xs:anyAtomicType"],
    result: "array(*)",
    impl: (args) => [new ArrayItem(find(arg(args, 0), atomOf(arg(args, 1))))],
  },
  {
    name: "map:put",
    params: ["map(*)", "xs:anyAtomicType", "item()*"],
    result: "map(*)",
    impl: (args) => [mapOf(arg(args, 0)).set(atomOf(arg(args, 1)), arg(args, 2))],
  },
  {
    name: "map:remove",
    params: ["map(*)", "xs:anyAtomicType*"],
    result: "map(*)",
    impl: (args) => [
      Arr.reduce(arg(args, 1), mapOf(arg(args, 0)), (m, k) =>
        k instanceof AtomicValue ? m.remove(k) : m,
      ),
    ],
  },
  {
    name: "map:for-each",
    params: ["map(*)", "function(xs:anyAtomicType, item()*) as item()*"],
    result: "item()*",
    impl: (args, call) => {
      const f = functionOf(arg(args, 1));
      return mapOf(arg(args, 0))
        .toEntries()
        .flatMap(([k, v]) => call1(f, call, [k], v));
    },
  },
];

// -----------------------------------------------------------------------------
// array:
// -----------------------------------------------------------------------------

const outOfBounds = (position: bigint | number, size: number, call: Call): never =>
  raise("FOAY0001", `the array has no member ${position} (its size is ${size})`, call.offset);

/** A 1-based position argument, checked to be within `1` to `max`. */
const positionIn = (s: Sequence, max: number, size: number, call: Call): number => {
  const v = atomOf(s).value;
  const n = P.isBigInt(v) ? v : 0n;
  return n >= 1n && n <= BigInt(max) ? Number(n) : outOfBounds(n, size, call);
};

const subarray = (array: ArrayItem, start: Sequence, length: Sequence | undefined, call: Call) => {
  const size = array.size;
  const from = positionIn(start, size + 1, size, call);
  const len = length === undefined ? size - from + 1 : Number(atomOf(length).value);
  if (len < 0) return raise("FOAY0002", `the length ${len} is negative`, call.offset);
  if (from + len - 1 > size) return outOfBounds(from + len - 1, size, call);
  return [new ArrayItem(array.members.slice(from - 1, from - 1 + len))];
};

/** The members of items, arrays flattened at every depth. */
const flatten = (items: Sequence): Sequence =>
  items.flatMap((item): Sequence =>
    item instanceof ArrayItem ? item.members.flatMap((m) => flatten(m)) : [item],
  );

const arrayFunctions: ReadonlyArray<BuiltinSpec> = [
  {
    name: "array:put",
    params: ["array(*)", "xs:integer", "item()*"],
    result: "array(*)",
    impl: (args, call) => {
      const array = arrayOf(arg(args, 0));
      const at = positionIn(arg(args, 1), array.size, array.size, call);
      return [new ArrayItem(array.members.map((m, i) => (i + 1 === at ? arg(args, 2) : m)))];
    },
  },
  {
    name: "array:append",
    params: ["array(*)", "item()*"],
    result: "array(*)",
    impl: (args) => [new ArrayItem([...arrayOf(arg(args, 0)).members, arg(args, 1)])],
  },
  {
    name: "array:subarray",
    params: ["array(*)", "xs:integer"],
    result: "array(*)",
    impl: (args, call) => subarray(arrayOf(arg(args, 0)), arg(args, 1), undefined, call),
  },
  {
    name: "array:subarray",
    params: ["array(*)", "xs:integer", "xs:integer"],
    result: "array(*)",
    impl: (args, call) => subarray(arrayOf(arg(args, 0)), arg(args, 1), arg(args, 2), call),
  },
  {
    name: "array:remove",
    params: ["array(*)", "xs:integer*"],
    result: "array(*)",
    impl: (args, call) => {
      const array = arrayOf(arg(args, 0));
      const positions = HashSet.fromIterable(
        arg(args, 1).map((p) => positionIn([p], array.size, array.size, call)),
      );
      return [new ArrayItem(array.members.filter((_, i) => !HashSet.has(positions, i + 1)))];
    },
  },
  {
    name: "array:insert-before",
    params: ["array(*)", "xs:integer", "item()*"],
    result: "array(*)",
    impl: (args, call) => {
      const array = arrayOf(arg(args, 0));
      const at = positionIn(arg(args, 1), array.size + 1, array.size, call) - 1;
      const m = array.members;
      return [new ArrayItem([...m.slice(0, at), arg(args, 2), ...m.slice(at)])];
    },
  },
  {
    name: "array:head",
    params: ["array(*)"],
    result: "item()*",
    impl: (args, call) => {
      const array = arrayOf(arg(args, 0));
      return array.members[0] ?? outOfBounds(1, 0, call);
    },
  },
  {
    name: "array:tail",
    params: ["array(*)"],
    result: "array(*)",
    impl: (args, call) => {
      const array = arrayOf(arg(args, 0));
      return array.size === 0 ? outOfBounds(1, 0, call) : [new ArrayItem(array.members.slice(1))];
    },
  },
  {
    name: "array:reverse",
    params: ["array(*)"],
    result: "array(*)",
    impl: (args) => [new ArrayItem(Arr.reverse(arrayOf(arg(args, 0)).members))],
  },
  {
    name: "array:join",
    params: ["array(*)*"],
    result: "array(*)",
    impl: (args) => [
      new ArrayItem(arg(args, 0).flatMap((a) => (a instanceof ArrayItem ? a.members : []))),
    ],
  },
  {
    name: "array:for-each",
    params: ["array(*)", "function(item()*) as item()*"],
    result: "array(*)",
    impl: (args, call) => {
      const f = functionOf(arg(args, 1));
      return [new ArrayItem(arrayOf(arg(args, 0)).members.map((m) => call1(f, call, m)))];
    },
  },
  {
    name: "array:filter",
    params: ["array(*)", "function(item()*) as xs:boolean"],
    result: "array(*)",
    impl: (args, call) => {
      const f = functionOf(arg(args, 1));
      return [
        new ArrayItem(arrayOf(arg(args, 0)).members.filter((m) => truth(call1(f, call, m), call))),
      ];
    },
  },
  {
    name: "array:fold-left",
    params: ["array(*)", "item()*", "function(item()*, item()*) as item()*"],
    result: "item()*",
    impl: (args, call) =>
      foldLeft(arrayOf(arg(args, 0)).members, arg(args, 1), functionOf(arg(args, 2)), call),
  },
  {
    name: "array:fold-right",
    params: ["array(*)", "item()*", "function(item()*, item()*) as item()*"],
    result: "item()*",
    impl: (args, call) =>
      foldRight(arrayOf(arg(args, 0)).members, arg(args, 1), functionOf(arg(args, 2)), call),
  },
  {
    name: "array:for-each-pair",
    params: ["array(*)", "array(*)", "function(item()*, item()*) as item()*"],
    result: "array(*)",
    impl: (args, call) => {
      const f = functionOf(arg(args, 2));
      return [
        new ArrayItem(
          Arr.zip(arrayOf(arg(args, 0)).members, arrayOf(arg(args, 1)).members).map(([a, b]) =>
            call1(f, call, a, b),
          ),
        ),
      ];
    },
  },
  ...sortFunctions("array:sort", true),
  {
    name: "array:flatten",
    params: ["item()*"],
    result: "item()*",
    impl: (args) => flatten(arg(args, 0)),
  },
];

/** The array and map functions beyond the core accessors, and the higher-order functions. */
export const higherOrder: ReadonlyArray<BuiltinSpec> = [
  ...fnHigherOrder,
  ...mapFunctions,
  ...arrayFunctions,
];
