/**
 * What compiled code runs against: the focus and variables of the moment
 * ({@link Ctx}), the dynamic context of one evaluation ({@link Dynamic}),
 * the resolved sequence types the evaluator checks values against
 * ({@link SeqType}), and function items it builds itself ({@link Closure}).
 *
 * Variables live in frames: each function body (and the query body) has a
 * frame layout fixed at compile time, a `let` or `for` binding owns one slot,
 * and an inline function copies the slots it uses from the enclosing frame
 * when it is created. Reading a variable is an array access.
 */
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type { QName } from "../../../Name.ts";
import type { XQueryError } from "../../../XQuery/Error.ts";
import { AtomicValue } from "../atomic.ts";
import { ArrayItem, atomize, FunctionItem, MapItem, type Item, type Sequence } from "../item.ts";
import type { NodeKind, XdmNode } from "../node.ts";
import { AtomicTypes, derivesFrom, type AtomicType } from "../types.ts";
import { attemptSync, raise, Suspend, unwrap, type ResourceRequest } from "./raise.ts";

// -----------------------------------------------------------------------------
// Sequence types, resolved
// -----------------------------------------------------------------------------

/** An item type with its names resolved, as the evaluator tests items against it. */
export type ItemTest =
  | { readonly kind: "item" }
  | { readonly kind: "atomic"; readonly type: AtomicType }
  /** `xs:numeric`, the union of `xs:double`, `xs:float` and `xs:decimal`. */
  | { readonly kind: "numeric" }
  | {
      readonly kind: "node";
      /** `None` for `node()`. */
      readonly nodeKind: NodeKind | undefined;
      /** The Clark name the test requires, if it requires one. */
      readonly name: string | undefined;
      readonly matches: (node: XdmNode) => boolean;
    }
  | {
      readonly kind: "function";
      /** `undefined` for `function(*)`. */
      readonly params: ReadonlyArray<SeqType> | undefined;
      readonly result: SeqType;
    }
  | {
      readonly kind: "map";
      /** `undefined` for `map(*)`. */
      readonly key: AtomicType | undefined;
      readonly value: SeqType;
    }
  | { readonly kind: "array"; readonly member: SeqType | undefined };

/** A sequence type: an item type and how many items; `item` is `undefined` for `empty-sequence()`. */
export interface SeqType {
  readonly item: ItemTest | undefined;
  readonly min: number;
  readonly max: number;
  /** The type as written, for messages. */
  readonly text: string;
}

/** `item()*`, the type that every sequence matches. */
export const anySequence: SeqType = {
  item: { kind: "item" },
  min: 0,
  max: Infinity,
  text: "item()*",
};

/** A function's parameter types and result type. */
export interface Signature {
  readonly params: ReadonlyArray<SeqType>;
  readonly result: SeqType;
}

// -----------------------------------------------------------------------------
// Function items the evaluator makes
// -----------------------------------------------------------------------------

/**
 * A function item made by the evaluator (an inline function, a named
 * function reference, a partial application): it has a signature, and the
 * evaluator calls it directly, raising rather than returning a `Result`.
 */
export class Closure extends FunctionItem {
  readonly signature: Signature;
  readonly call: (args: ReadonlyArray<Sequence>) => Sequence;

  constructor(
    name: Option.Option<QName>,
    signature: Signature,
    call: (args: ReadonlyArray<Sequence>) => Sequence,
  ) {
    super(name, signature.params.length, (args) => attemptSync(() => call(args)));
    this.signature = signature;
    this.call = call;
  }
}

/** Whether an item is a function, as a dynamic call needs one: function items, maps and arrays. */
export const isCallable = (item: Item): item is FunctionItem | MapItem | ArrayItem =>
  item instanceof FunctionItem || item instanceof MapItem || item instanceof ArrayItem;

/** How many arguments a function item takes (maps and arrays take one). */
export const arityOf = (f: FunctionItem | MapItem | ArrayItem): number =>
  f instanceof FunctionItem ? f.arity : 1;

/** The one atomic value of a sequence, or `err:XPTY0004`. */
export const singleAtomic = (sequence: Sequence, what: string, offset?: number): AtomicValue => {
  const atoms = unwrap(atomize(sequence), offset);
  const [only] = atoms;
  return atoms.length === 1 && only !== undefined
    ? only
    : raise("XPTY0004", `${what} must be a single atomic value, not ${atoms.length}`, offset);
};

/** An array's member at a 1-based position: `err:FOAY0001` when there is none. */
export const arrayMember = (array: ArrayItem, position: AtomicValue, offset?: number): Sequence => {
  const v = position.value;
  if (!Predicate.isBigInt(v) || !derivesFrom(position.type, AtomicTypes.integer))
    return raise(
      "XPTY0004",
      `an array is indexed by an xs:integer, not xs:${position.type.name}`,
      offset,
    );
  return Option.getOrElse(
    v >= 1n && v <= BigInt(array.size) ? array.get(Number(v)) : Option.none(),
    () => raise("FOAY0001", `the array has no member ${v} (its size is ${array.size})`, offset),
  );
};

/** Call a function item with arguments its arity already matched. */
export const callFunction = (
  f: FunctionItem | MapItem | ArrayItem,
  args: ReadonlyArray<Sequence>,
  offset?: number,
): Sequence => {
  if (f instanceof Closure) return f.call(args);
  if (f instanceof FunctionItem) return unwrap(f.invoke(args), offset);
  const key = singleAtomic(args[0] ?? [], "the key", offset);
  if (f instanceof MapItem) return Option.getOrElse(f.get(key), () => []);
  return arrayMember(f, key, offset);
};

// -----------------------------------------------------------------------------
// The dynamic context
// -----------------------------------------------------------------------------

/** Resources fetched so far, by {@link resourceKey}, and whether the host can fetch more. */
export class Resources {
  private cache: HashMap.HashMap<string, Result.Result<Sequence | string, XQueryError>> =
    HashMap.empty();
  readonly canFetch: boolean;

  constructor(canFetch: boolean) {
    this.canFetch = canFetch;
  }

  /** A fetched resource (or why it couldn't be fetched). */
  get(key: string): Option.Option<Result.Result<Sequence | string, XQueryError>> {
    return HashMap.get(this.cache, key);
  }

  /** Record what fetching a resource gave. */
  set(key: string, value: Result.Result<Sequence | string, XQueryError>): void {
    this.cache = HashMap.set(this.cache, key, value);
  }
}

/** Where a resource is cached. */
export const resourceKey = (request: ResourceRequest): string =>
  `${request.kind} ${request.encoding ?? ""} ${request.uri}`;

/** The dynamic context of one evaluation. */
export interface Dynamic {
  /** The values of global variables, filled as they are first read. */
  readonly globals: Array<Sequence | undefined>;
  /** The initial context item: the focus of the query body and of global initializers. */
  readonly initialContext: Item | undefined;
  /** The host's values of external variables, by Clark name. */
  readonly externals: HashMap.HashMap<string, Sequence>;
  readonly resources: Resources;
  /** The current dateTime, fixed for the evaluation, as an `xs:dateTimeStamp` lexical form. */
  readonly currentDateTime: string;
  /** The implicit timezone, in minutes east of UTC. */
  readonly implicitTimezone: number;
}

/** A resource from the cache; otherwise evaluation stops to have the host fetch it, or fails if it can't. */
export const fetchResource = (
  dyn: Dynamic,
  request: ResourceRequest,
  offset: number,
): Sequence | string => {
  const cached = dyn.resources.get(resourceKey(request));
  if (Option.isSome(cached)) return unwrap(cached.value, offset);
  if (dyn.resources.canFetch) throw new Suspend(request);
  return request.kind === "text"
    ? raise("FOUT1170", `the resource ${request.uri} is not available`, offset)
    : raise(
        request.kind === "document" ? "FODC0002" : "FODC0004",
        `${request.uri === "" ? "the default collection" : request.uri} is not available`,
        offset,
      );
};

/**
 * The focus and the variables at a point of evaluation: the context item,
 * position and size (`item` is `undefined` when the focus is absent), the
 * current frame, and the evaluation's dynamic context.
 */
export class Ctx {
  readonly item: Item | undefined;
  readonly position: number;
  readonly size: number;
  readonly frame: Array<Sequence>;
  readonly dyn: Dynamic;

  constructor(
    item: Item | undefined,
    position: number,
    size: number,
    frame: Array<Sequence>,
    dyn: Dynamic,
  ) {
    this.item = item;
    this.position = position;
    this.size = size;
    this.frame = frame;
    this.dyn = dyn;
  }

  /** The same variables with a new focus. */
  focus(item: Item, position: number, size: number): Ctx {
    return new Ctx(item, position, size, this.frame, this.dyn);
  }
}

/** Compiled code: an expression's value in a context. */
export type Code = (ctx: Ctx) => Sequence;

/** The context item, or `err:XPDY0002` when the focus is absent. */
export const contextItem = (ctx: Ctx, offset: number): Item =>
  ctx.item ?? raise("XPDY0002", "the context item is absent", offset);
