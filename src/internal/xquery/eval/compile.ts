/**
 * The evaluator: a query's syntax tree compiled, once, to closures.
 *
 * Each expression becomes a {@link Code}, a function from a {@link Ctx} (the
 * focus, the current frame, the dynamic context) to a sequence; an
 * expression's code calls its operands' code, so evaluation is direct calls
 * with no tree walk and no dispatch on node kinds. Names, types, functions
 * and frame slots are all resolved here, at compile time. Errors are raised
 * (see `raise.ts`) at the offset of the expression that fails.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { QName } from "../../../Name.ts";
import type { Query } from "../../../XQuery/Compile.ts";
import { AtomicValue, atomicString } from "../atomic.ts";
import {
  ArrayItem,
  atomize,
  effectiveBooleanValue,
  FunctionItem,
  isNode,
  MapItem,
  type Item,
  type Sequence,
} from "../item.ts";
import { compareDocumentOrder, XdmNode } from "../node.ts";
import { scopeOf, type ExpandedName } from "../parser/analyze.ts";
import type {
  BinaryOp,
  Decl as DeclT,
  EQName,
  Expr as ExprT,
  KeySpecifier as KeySpecifierT,
  Param,
  SequenceType as SequenceTypeT,
  SingleType,
} from "../parser/ast.ts";
import { Decl, Expr, KeySpecifier, Module, NodeTest } from "../parser/ast.ts";
import { accepts, builtinArities, Namespaces } from "../parser/builtins.ts";
import { atomicType, AtomicTypes, derivesFrom, type AtomicType } from "../types.ts";
import { arithmetic, unary, type ArithOp } from "./arith.ts";
import { combineNodes, documentOrder } from "./axes.ts";
import { bindFor, checkType, flwor, type Bound } from "./flwor.ts";
import {
  compAttribute,
  compComment,
  compDocument,
  compElement,
  compNamespace,
  compPI,
  compText,
  dirComment,
  dirElement,
  dirPI,
} from "./construct.ts";
import { castAtomic } from "./cast.ts";
import { compatibleArgument, numericOperand } from "./compat.ts";
import {
  generalCompare,
  generalCompareCompatible,
  generalToValue,
  valueCompare,
  atomicDeepEqual,
  type ValueOp,
} from "./compare.ts";
import type { Statics } from "./functions/define.ts";
import { lookupBuiltin, paramType, type Builtin } from "./functions/registry.ts";
import { axisStepCode, filterCode, pathCode } from "./path.ts";
import { catching, notImplemented, orElse, raise, raiseError, unwrap } from "./raise.ts";
import {
  anySequence,
  arityOf,
  arrayMember,
  callFunction,
  Closure,
  contextItem,
  Ctx,
  isCallable,
  singleAtomic,
  type Code,
  type Dynamic,
  type SeqType,
  type Signature,
} from "./runtime.ts";
import {
  bindExpanded,
  bindLocal,
  clark,
  Layout,
  resolve,
  slotIn,
  staticsOf,
  type GlobalVar,
  Program,
  type Scope,
  type UserFunction,
} from "./scope.ts";
import {
  anySingleItem,
  coerce,
  matchType,
  sequenceMatches,
  sequenceType,
  signatureOf,
  singleItemType,
} from "./seqtype.ts";
import { uriOf } from "../../qnames.ts";

const empty: Sequence = [];
const bool = (b: boolean): Sequence => [AtomicValue.boolean(b)];
const TRUE = /*#__PURE__*/ bool(true);
const FALSE = /*#__PURE__*/ bool(false);
const toBool = (b: boolean): Sequence => (b ? TRUE : FALSE);

const ebv = (s: Sequence, offset: number): boolean => unwrap(effectiveBooleanValue(s), offset);

// -----------------------------------------------------------------------------
// Literals, variables, sequences
// -----------------------------------------------------------------------------

const constant =
  (value: Sequence): Code =>
  () =>
    value;

const decimalLiteral = (text: string, offset: number): AtomicValue =>
  castAtomic(AtomicValue.string(text), AtomicTypes.decimal, undefined, offset);

/** The value of a global variable, computing it on first read; `err:XQDY0054` for a circular definition. */
const evaluating: Sequence = [];

const globalValue = (program: Program, dyn: Dynamic, index: number, offset: number): Sequence => {
  const known = dyn.globals[index];
  if (known === evaluating) return raise("XQDY0054", "a global variable depends on itself", offset);
  if (known !== undefined) return known;
  const g = program.globals[index];
  if (g === undefined) return raise("XPST0008", "an unknown global variable", offset);
  dyn.globals[index] = evaluating;
  const value = computeGlobal(g, dyn, offset);
  dyn.globals[index] = value;
  return value;
};

const computeGlobal = (g: GlobalVar, dyn: Dynamic, offset: number): Sequence => {
  const supplied = g.external
    ? Option.getOrUndefined(HashMap.get(dyn.externals, g.clark))
    : undefined;
  const value =
    supplied ??
    (g.init === undefined
      ? raise("XPDY0002", `no value was given for the external variable $${g.clark}`, offset)
      : g.init(new Ctx(dyn.initialContext, 1, 1, [], dyn)));
  if (g.type === undefined) return value;
  // A value the host supplies is converted to the declared type; an
  // initializer's value must match it as it is (XQuery 3.1 §4.16).
  return supplied === undefined
    ? matchType(g.type, value, `the variable $${g.clark}`, offset)
    : coerce(g.type, value, `the variable $${g.clark}`, offset);
};

const varRef = (e: Extract<ExprT, { readonly _tag: "VarRef" }>, scope: Scope): Code => {
  const key = clark(resolve(scope, e.name, "variable"));
  const v = HashMap.get(scope.vars, key);
  if (Option.isSome(v) && v.value.kind === "local") {
    const slot = slotIn(scope.layout, v.value.binding);
    return (ctx) => ctx.frame[slot] ?? empty;
  }
  const index =
    Option.isSome(v) && v.value.kind === "global" ? v.value.index : scope.program.globalIndex(key);
  if (index === undefined)
    return raise("XPST0008", `the variable $${key} is not declared`, e.offset);
  const program = scope.program;
  return (ctx) => globalValue(program, ctx.dyn, index, e.offset);
};

const sequence = (codes: ReadonlyArray<Code>): Code => {
  const [only] = codes;
  if (Arr.isReadonlyArrayEmpty(codes)) return constant(empty);
  if (codes.length === 1 && only !== undefined) return only;
  return (ctx) => codes.flatMap((c) => c(ctx));
};

// -----------------------------------------------------------------------------
// Operators
// -----------------------------------------------------------------------------

/** An optional single atomic operand of a value comparison or `to`. */
const optionalAtomic = (s: Sequence, what: string, offset: number): AtomicValue | undefined => {
  const atoms = unwrap(atomize(s), offset);
  const [a] = atoms;
  if (atoms.length > 1)
    return raise("XPTY0004", `${what} must be at most one atomic value`, offset);
  return a;
};

const valueComparison =
  (op: ValueOp, l: Code, r: Code, offset: number): Code =>
  (ctx) => {
    const a = optionalAtomic(l(ctx), "an operand of a value comparison", offset);
    const b = optionalAtomic(r(ctx), "an operand of a value comparison", offset);
    if (a === undefined || b === undefined) return empty;
    return toBool(valueCompare(op, a, b, ctx.dyn.implicitTimezone, offset));
  };

const optionalNode = (s: Sequence, offset: number): XdmNode | undefined => {
  const [n] = s;
  if (Arr.isReadonlyArrayEmpty(s)) return undefined;
  return s.length === 1 && n !== undefined && isNode(n)
    ? n
    : raise("XPTY0004", "an operand of a node comparison must be at most one node", offset);
};

const nodeComparison =
  (op: "is" | "<<" | ">>", l: Code, r: Code, offset: number): Code =>
  (ctx) => {
    const a = optionalNode(l(ctx), offset);
    const b = optionalNode(r(ctx), offset);
    if (a === undefined || b === undefined) return empty;
    const c = compareDocumentOrder(a, b);
    return toBool(op === "is" ? c === 0 : op === "<<" ? c < 0 : c > 0);
  };

/** The longest range `to` builds: a longer one is an implementation limit (`err:XPDY0130`). */
const MAX_RANGE = 1_000_000n;

const rangeBound = (s: Sequence, offset: number): bigint | undefined => {
  const a = optionalAtomic(s, "an operand of `to`", offset);
  if (a === undefined) return undefined;
  const v = castAtomic(a, AtomicTypes.integer, undefined, offset).value;
  return P.isBigInt(v) &&
    (a.type === AtomicTypes.untypedAtomic || derivesFrom(a.type, AtomicTypes.integer))
    ? v
    : raise(
        "XPTY0004",
        `an operand of \`to\` must be an xs:integer, not xs:${a.type.name}`,
        offset,
      );
};

const range =
  (l: Code, r: Code, offset: number): Code =>
  (ctx) => {
    const from = rangeBound(l(ctx), offset);
    const to = rangeBound(r(ctx), offset);
    if (from === undefined || to === undefined || from > to) return empty;
    if (to - from >= MAX_RANGE)
      return raise("XPDY0130", `the range ${from} to ${to} is too large`, offset);
    return Arr.makeBy(Number(to - from) + 1, (i) => AtomicValue.integer(from + BigInt(i)));
  };

/** An operand of `||` as a string: `""` for the empty sequence. */
const concatPart = (s: Sequence, offset: number): string => {
  const a = optionalAtomic(s, "an operand of `||`", offset);
  return a === undefined ? "" : atomicString(a);
};

const concatStrings =
  (l: Code, r: Code, offset: number): Code =>
  (ctx) => {
    return [AtomicValue.string(concatPart(l(ctx), offset) + concatPart(r(ctx), offset))];
  };

const nodesOnly = (s: Sequence, op: string, offset: number): ReadonlyArray<XdmNode> =>
  s.every(isNode) ? s : raise("XPTY0004", `the operands of ${op} must be nodes`, offset);

const setOperation =
  (op: "union" | "intersect" | "except", l: Code, r: Code, offset: number): Code =>
  (ctx) => {
    const a = nodesOnly(l(ctx), op, offset);
    const b = nodesOnly(r(ctx), op, offset);
    if (op === "union") return documentOrder([...a, ...b]);
    return combineNodes(documentOrder([...a]), documentOrder([...b]), op === "intersect");
  };

const simpleMap =
  (l: Code, r: Code): Code =>
  (ctx) => {
    const items = l(ctx);
    const size = items.length;
    return items.flatMap((item, i) => r(ctx.focus(item, i + 1, size)));
  };

const logical = (op: "and" | "or", l: Code, r: Code, offset: number): Code =>
  op === "and"
    ? (ctx) => toBool(ebv(l(ctx), offset) && ebv(r(ctx), offset))
    : (ctx) => toBool(ebv(l(ctx), offset) || ebv(r(ctx), offset));

const isArithOp = (op: BinaryOp): op is ArithOp =>
  op === "+" || op === "-" || op === "*" || op === "div" || op === "idiv" || op === "mod";

const isValueOp = (op: BinaryOp): op is ValueOp =>
  ["eq", "ne", "lt", "le", "gt", "ge"].includes(op);

const binary = (e: Extract<ExprT, { readonly _tag: "Binary" }>, scope: Scope): Code => {
  const l = compileExpr(e.left, scope);
  const r = compileExpr(e.right, scope);
  const { op, offset } = e;
  const general = generalToValue(op);
  const compatible = scope.statics.context.xpath1Compatibility;
  if (general !== undefined && compatible)
    return (ctx) =>
      toBool(generalCompareCompatible(general, l(ctx), r(ctx), ctx.dyn.implicitTimezone, offset));
  if (general !== undefined)
    return (ctx) =>
      toBool(generalCompare(general, l(ctx), r(ctx), ctx.dyn.implicitTimezone, offset));
  if (isValueOp(op)) return valueComparison(op, l, r, offset);
  if (isArithOp(op) && compatible)
    return (ctx) =>
      arithmetic(
        op,
        numericOperand(l(ctx), offset),
        numericOperand(r(ctx), offset),
        ctx.dyn.implicitTimezone,
        offset,
      );
  if (isArithOp(op))
    return (ctx) => arithmetic(op, l(ctx), r(ctx), ctx.dyn.implicitTimezone, offset);
  if (op === "and" || op === "or") return logical(op, l, r, offset);
  if (op === "is" || op === "<<" || op === ">>") return nodeComparison(op, l, r, offset);
  if (op === "union" || op === "intersect" || op === "except")
    return setOperation(op, l, r, offset);
  if (op === "to") return range(l, r, offset);
  if (op === "||") return concatStrings(l, r, offset);
  return simpleMap(l, r);
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

const seqTypeOf = (t: SequenceTypeT, scope: Scope): SeqType =>
  sequenceType(t, (n, k) => resolve(scope, n, k));

const optionalSeqType = (t: Option.Option<SequenceTypeT>, scope: Scope): SeqType =>
  Option.match(t, { onNone: () => anySequence, onSome: (x) => seqTypeOf(x, scope) });

/** What `cast as` and `castable as` target: an atomic type, `xs:numeric`, or a list type. */
type CastTarget =
  | { readonly kind: "atomic"; readonly type: AtomicType }
  | { readonly kind: "numeric" }
  | { readonly kind: "list"; readonly item: AtomicType };

/** The item type of a built-in list type. */
const listItem = (local: string): AtomicType | undefined =>
  local === "NMTOKENS"
    ? AtomicTypes.NMTOKEN
    : local === "IDREFS"
      ? AtomicTypes.IDREF
      : local === "ENTITIES"
        ? AtomicTypes.ENTITY
        : undefined;

const castTarget = (t: SingleType, scope: Scope): CastTarget => {
  const n = resolve(scope, t.name, "type");
  const list = n.uri === Namespaces.xs ? listItem(n.local) : undefined;
  if (list !== undefined) return { kind: "list", item: list };
  if (n.uri === Namespaces.xs && n.local === "numeric") return { kind: "numeric" };
  return Option.match(atomicType(n.uri, n.local), {
    onNone: () =>
      raise("XPST0080", `${n.local} is not a type a value can be cast to`, t.name.offset),
    onSome: (type): CastTarget => ({ kind: "atomic", type }),
  });
};

const castOne = (
  a: AtomicValue,
  target: CastTarget,
  statics: Statics,
  offset: number,
): Sequence => {
  if (target.kind === "numeric")
    return [
      a.type.primitive === "double" ||
      a.type.primitive === "float" ||
      a.type.primitive === "decimal"
        ? a
        : castAtomic(a, AtomicTypes.double, statics.namespace, offset),
    ];
  if (target.kind === "atomic") return [castAtomic(a, target.type, statics.namespace, offset)];
  const tokens = atomicString(a)
    .split(/[ \t\r\n]+/)
    .filter((s) => s !== "");
  if (Arr.isReadonlyArrayEmpty(tokens))
    return raise("FORG0001", "a list value cannot be empty", offset);
  return tokens.map((s) =>
    castAtomic(AtomicValue.string(s), target.item, statics.namespace, offset),
  );
};

/** The value of `cast as`. */
const castValue = (
  s: Sequence,
  t: SingleType,
  target: CastTarget,
  statics: Statics,
  offset: number,
): Sequence => {
  const atoms = unwrap(atomize(s), offset);
  const [a] = atoms;
  if (a === undefined)
    return t.optional ? empty : raise("XPTY0004", "an empty sequence cannot be cast", offset);
  if (atoms.length > 1)
    return raise("XPTY0004", "a sequence of more than one item cannot be cast", offset);
  return castOne(a, target, statics, offset);
};

const castAs = (e: Extract<ExprT, { readonly _tag: "CastAs" }>, scope: Scope): Code => {
  const code = compileExpr(e.expr, scope);
  const target = castTarget(e.type, scope);
  const statics = staticsOf(scope);
  return (ctx) => castValue(code(ctx), e.type, target, statics, e.offset);
};

const castableAs = (e: Extract<ExprT, { readonly _tag: "CastableAs" }>, scope: Scope): Code => {
  const code = compileExpr(e.expr, scope);
  const target = castTarget(e.type, scope);
  const statics = staticsOf(scope);
  return (ctx) => {
    const value = code(ctx);
    return toBool(orElse(() => (castValue(value, e.type, target, statics, e.offset), true), false));
  };
};

const instanceOf = (e: Extract<ExprT, { readonly _tag: "InstanceOf" }>, scope: Scope): Code => {
  const code = compileExpr(e.expr, scope);
  const t = seqTypeOf(e.type, scope);
  return (ctx) => toBool(sequenceMatches(t, code(ctx)));
};

const treatAs = (e: Extract<ExprT, { readonly _tag: "TreatAs" }>, scope: Scope): Code => {
  const code = compileExpr(e.expr, scope);
  const t = seqTypeOf(e.type, scope);
  return (ctx) => {
    const v = code(ctx);
    return sequenceMatches(t, v)
      ? v
      : raise("XPDY0050", "the value does not match the type of `treat as`", e.offset);
  };
};

// -----------------------------------------------------------------------------
// Functions
// -----------------------------------------------------------------------------

/** Call a function declared in the prolog. */
const callUser = (
  f: UserFunction,
  args: ReadonlyArray<Sequence>,
  dyn: Dynamic,
  offset: number,
): Sequence => {
  const frame: Array<Sequence> = [];
  f.slots.forEach((slot, i) => {
    frame[slot] = coerce(
      f.signature.params[i] ?? anySequence,
      args[i] ?? empty,
      `argument ${i + 1} of ${f.name.qualified}`,
      offset,
    );
  });
  const body = f.body ?? raise("XPST0017", `${f.name.qualified} has no body`, offset);
  return coerce(
    f.signature.result,
    body(new Ctx(undefined, 0, 0, frame, dyn)),
    `the result of ${f.name.qualified}`,
    offset,
  );
};

const qnameOf = (n: ExpandedName, written: EQName): QName =>
  new QName({
    prefix: written.prefix,
    local: n.local,
    namespace: n.uri === "" ? Option.none() : Option.some(n.uri),
  });

/** Call a built-in with arguments converted to its parameter types. */
const callBuiltin = (
  b: Builtin,
  args: ReadonlyArray<Sequence>,
  ctx: Ctx,
  statics: Statics,
  offset: number,
): Sequence =>
  b.spec.impl(
    args.map((a, i) => coerce(paramType(b, i), a, `argument ${i + 1} of ${b.spec.name}`, offset)),
    { ctx, offset, statics },
  );

/** What a function name and arity denote: a declared function, a built-in, or a constructor function. */
type Target =
  | { readonly kind: "user"; readonly f: UserFunction }
  | { readonly kind: "builtin"; readonly b: Builtin }
  | { readonly kind: "constructor"; readonly target: CastTarget; readonly type: SingleType };

const findFunction = (scope: Scope, name: EQName, arity: number, offset: number): Target => {
  const n = resolve(scope, name, "function");
  const user = scope.program.functionOf(clark(n), arity);
  if (user !== undefined) return { kind: "user", f: user };
  if (n.uri === Namespaces.xs && arity === 1) {
    const type: SingleType = {
      name: { ...name, uri: Option.some(Namespaces.xs), prefix: Option.none() },
      optional: true,
    };
    return { kind: "constructor", target: castTarget(type, scope), type };
  }
  const builtin = lookupBuiltin(n.uri, n.local, arity);
  if (Option.isSome(builtin)) return { kind: "builtin", b: builtin.value };
  if (Option.exists(builtinArities(clark(n)), (arities) => accepts(arities, arity)))
    return notImplemented(`the function ${name.local}#${arity}`, offset);
  return raise("XPST0017", `there is no function ${clark(n)}#${arity}`, offset);
};

/** The signature of what a function name denotes, at an arity (a variadic built-in's last parameter repeats). */
const targetSignature = (t: Target, arity: number): Signature => {
  if (t.kind === "user") return t.f.signature;
  if (t.kind === "builtin")
    return {
      params: Array.from({ length: arity }, (_, i) => paramType(t.b, i)),
      result: t.b.signature.result,
    };
  return {
    params: [
      {
        item: { kind: "atomic", type: AtomicTypes.anyAtomicType },
        min: 0,
        max: 1,
        text: "xs:anyAtomicType?",
      },
    ],
    result: anySequence,
  };
};

/** Run what a function name denotes on arguments. */
const invokeTarget = (
  t: Target,
  args: ReadonlyArray<Sequence>,
  ctx: Ctx,
  statics: Statics,
  offset: number,
): Sequence => {
  if (t.kind === "user") return callUser(t.f, args, ctx.dyn, offset);
  if (t.kind === "builtin") return callBuiltin(t.b, args, ctx, statics, offset);
  return castValue(args[0] ?? empty, t.type, t.target, statics, offset);
};

const isPlaceholder = (e: ExprT): boolean => Expr.$is("Placeholder")(e);

/**
 * A function item that calls `call` with the placeholders filled by its
 * arguments. It is anonymous whatever it partially applies (XPath 3.1
 * §3.1.5.2), so `fn:function-name` of it is the empty sequence.
 */
const partial = (
  signature: Signature,
  args: ReadonlyArray<Code | undefined>,
  ctx: Ctx,
  call: (full: ReadonlyArray<Sequence>) => Sequence,
): Closure => {
  const fixed = args.map((c) => (c === undefined ? undefined : c(ctx)));
  const holes = fixed.flatMap((v, i) => (v === undefined ? [i] : []));
  const sig: Signature = {
    params: holes.map((i) => signature.params[i] ?? anySequence),
    result: signature.result,
  };
  return new Closure(Option.none(), sig, (given) => {
    const full = fixed.map((v, i) => v ?? given[holes.indexOf(i)] ?? empty);
    return call(full);
  });
};

/** A call's arguments compiled: `undefined` for each `?` placeholder, and the codes when there is none. */
interface Args {
  readonly all: ReadonlyArray<Code | undefined>;
  readonly codes: ReadonlyArray<Code> | undefined;
}

const compileArgs = (argExprs: ReadonlyArray<ExprT>, scope: Scope): Args => {
  const all = argExprs.map((a) => (isPlaceholder(a) ? undefined : compileExpr(a, scope)));
  const codes = all.filter(P.isNotUndefined);
  return { all, codes: codes.length === all.length ? codes : undefined };
};

const functionCall = (
  name: EQName,
  argExprs: ReadonlyArray<ExprT>,
  offset: number,
  scope: Scope,
): Code => {
  const target = findFunction(scope, name, argExprs.length, offset);
  const statics = functionStatics(scope);
  const { all, codes } = compileArgs(argExprs, scope);
  if (codes === undefined) {
    const sig = targetSignature(target, argExprs.length);
    return (ctx) => [
      partial(sig, all, ctx, (full) => invokeTarget(target, full, ctx, statics, offset)),
    ];
  }
  if (target.kind === "user")
    return (ctx) =>
      callUser(
        target.f,
        codes.map((c) => c(ctx)),
        ctx.dyn,
        offset,
      );
  if (target.kind === "builtin" && scope.statics.context.xpath1Compatibility) {
    const b = target.b;
    return (ctx) =>
      callBuiltin(
        b,
        codes.map((c, i) => compatibleArgument(paramType(b, i), c(ctx), offset)),
        ctx,
        statics,
        offset,
      );
  }
  return (ctx) =>
    invokeTarget(
      target,
      codes.map((c) => c(ctx)),
      ctx,
      statics,
      offset,
    );
};

/** The largest arity a function reference may have (`fn:concat#n`): an implementation limit. */
const MAX_ARITY = 65_536;

const namedFunctionRef = (
  e: Extract<ExprT, { readonly _tag: "NamedFunctionRef" }>,
  scope: Scope,
): Code => {
  if (e.arity > MAX_ARITY)
    return raise("XPDY0130", `a function reference of arity ${e.arity} is too large`, e.offset);
  const target = findFunction(scope, e.name, e.arity, e.offset);
  const statics = functionStatics(scope);
  const qname = qnameOf(resolve(scope, e.name, "function"), e.name);
  const sig = targetSignature(target, e.arity);
  return (ctx) => [
    new Closure(Option.some(qname), sig, (args) =>
      invokeTarget(target, args, ctx, statics, e.offset),
    ),
  ];
};

/**
 * The function item a name and arity denote in `scope`, made in `ctx`, as
 * `fn:function-lookup` finds it: `None` when the name and arity denote no
 * function (or a constructor of an unknown or abstract type).
 */
const lookupFunction = (
  scope: Scope,
  name: QName,
  arity: number,
  ctx: Ctx,
  offset: number,
): Option.Option<Closure> => {
  if (arity < 0 || arity > MAX_ARITY) return Option.none();
  const written: EQName = {
    prefix: name.prefix,
    local: name.local,
    uri: Option.orElseSome(name.namespace, () => ""),
    offset,
  };
  const statics = functionStatics(scope);
  return catching(
    () => {
      const target = findFunction(scope, written, arity, offset);
      const sig = targetSignature(target, arity);
      return Option.some(
        new Closure(Option.some(name), sig, (args) =>
          invokeTarget(target, args, ctx, statics, offset),
        ),
      );
    },
    (e) =>
      ["XPST0017", "XPST0051", "XPST0080", "XQST0052"].includes(e.code.local) &&
      Option.contains(e.code.namespace, Namespaces.err)
        ? Option.none()
        : raiseError(e),
  );
};

/** The static context built-ins are called in: {@link staticsOf}, and `fn:function-lookup`'s view of the functions in scope. */
const functionStatics = (scope: Scope): Statics => ({
  ...staticsOf(scope),
  lookup: (name, arity, ctx, offset) => lookupFunction(scope, name, arity, ctx, offset),
});

/** The parameter slots and signature of a function's parameters, bound in `scope`. */
const bindParams = (
  params: ReadonlyArray<Param>,
  scope: Scope,
): readonly [Scope, ReadonlyArray<number>, ReadonlyArray<SeqType>] =>
  params.reduce<readonly [Scope, ReadonlyArray<number>, ReadonlyArray<SeqType>]>(
    ([s, slots, types], p) => {
      const t = optionalSeqType(p.type, s);
      const [next, slot] = bindLocal(s, p.name);
      return [next, [...slots, slot], [...types, t]];
    },
    [scope, [], []],
  );

const inlineFunction = (
  e: Extract<ExprT, { readonly _tag: "InlineFunction" }>,
  scope: Scope,
): Code => {
  const layout = new Layout(scope.layout);
  const [inner, slots, types] = bindParams(e.params, { ...scope, layout });
  const sig: Signature = { params: types, result: optionalSeqType(e.returnType, scope) };
  const body = compileExpr(e.body, inner);
  return (ctx) => {
    const captured = layout.captures.map((c) => ctx.frame[c.from] ?? empty);
    const dyn = ctx.dyn;
    return [
      new Closure(Option.none(), sig, (args) => {
        const frame: Array<Sequence> = [];
        layout.captures.forEach((c, i) => {
          frame[c.to] = captured[i] ?? empty;
        });
        slots.forEach((slot, i) => {
          frame[slot] = coerce(
            sig.params[i] ?? anySequence,
            args[i] ?? empty,
            `argument ${i + 1}`,
            e.offset,
          );
        });
        return coerce(
          sig.result,
          body(new Ctx(undefined, 0, 0, frame, dyn)),
          "the result",
          e.offset,
        );
      }),
    ];
  };
};

const theFunction = (
  s: Sequence,
  arity: number,
  offset: number,
): FunctionItem | MapItem | ArrayItem => {
  const [f] = s;
  if (s.length !== 1 || f === undefined || !isCallable(f))
    return raise("XPTY0004", "a dynamic call needs a single function item", offset);
  if (arityOf(f) !== arity)
    return raise("XPTY0004", `the function takes ${arityOf(f)} arguments, not ${arity}`, offset);
  return f;
};

const dynamicCall = (
  fn: ExprT,
  argExprs: ReadonlyArray<ExprT>,
  offset: number,
  scope: Scope,
): Code => {
  const f = compileExpr(fn, scope);
  const { all, codes } = compileArgs(argExprs, scope);
  if (codes === undefined)
    return (ctx) => {
      const item = theFunction(f(ctx), all.length, offset);
      return [partial(signatureOf(item), all, ctx, (full) => callFunction(item, full, offset))];
    };
  return (ctx) => {
    const item = theFunction(f(ctx), codes.length, offset);
    const values = codes.map((c) => c(ctx));
    return callFunction(item, values, offset);
  };
};

// -----------------------------------------------------------------------------
// Maps, arrays and lookup
// -----------------------------------------------------------------------------

const mapConstructor = (e: Extract<ExprT, { readonly _tag: "Map" }>, scope: Scope): Code => {
  const entries = e.entries.map(
    (entry) => [compileExpr(entry.key, scope), compileExpr(entry.value, scope)] as const,
  );
  return (ctx) => [
    entries.reduce((map, [k, v]) => {
      const key = singleAtomic(k(ctx), "a map key", e.offset);
      return map.has(key)
        ? raise("XQDY0137", `the map constructor has the key ${atomicString(key)} twice`, e.offset)
        : map.set(key, v(ctx));
    }, MapItem.empty),
  ];
};

const lookupIn = (
  item: Item,
  keys: ReadonlyArray<AtomicValue> | undefined,
  offset: number,
): Sequence => {
  if (item instanceof MapItem)
    return keys === undefined
      ? item.toEntries().flatMap(([, v]) => v)
      : keys.flatMap((k) => Option.getOrElse(item.get(k), () => empty));
  if (item instanceof ArrayItem)
    return keys === undefined
      ? item.members.flat()
      : keys.flatMap((k) => arrayMember(item, k, offset));
  return raise("XPTY0004", "a lookup needs a map or an array", offset);
};

/** The keys a key specifier selects, `undefined` for `*`. */
const keyCode = (
  key: KeySpecifierT,
  scope: Scope,
  offset: number,
): ((ctx: Ctx) => ReadonlyArray<AtomicValue> | undefined) =>
  KeySpecifier.$match(key, {
    Wildcard: () => () => undefined,
    Name: ({ name }) => {
      const k = [AtomicValue.string(name)];
      return () => k;
    },
    Integer: ({ value }) => {
      const k = [AtomicValue.integer(BigInt(value))];
      return () => k;
    },
    Expr: ({ expr }) => {
      const code = compileExpr(expr, scope);
      return (ctx: Ctx) => unwrap(atomize(code(ctx)), offset);
    },
  });

const lookup = (base: Code, key: KeySpecifierT, offset: number, scope: Scope): Code => {
  const keys = keyCode(key, scope, offset);
  return (ctx) => {
    const items = base(ctx);
    const ks = keys(ctx);
    return items.flatMap((item) => lookupIn(item, ks, offset));
  };
};

// -----------------------------------------------------------------------------
// Conditionals, quantifiers, FLWOR, switch, typeswitch, try
// -----------------------------------------------------------------------------

const ifExpr = (e: Extract<ExprT, { readonly _tag: "If" }>, scope: Scope): Code => {
  const c = compileExpr(e.condition, scope);
  const t = compileExpr(e.thenBranch, scope);
  const f = compileExpr(e.elseBranch, scope);
  return (ctx) => (ebv(c(ctx), e.offset) ? t(ctx) : f(ctx));
};

const quantified = (e: Extract<ExprT, { readonly _tag: "Quantified" }>, scope: Scope): Code => {
  const [inner, bound] = e.bindings.reduce<readonly [Scope, ReadonlyArray<Bound>]>(
    ([s, bs], b) => {
      const [next, x] = bindFor(b, s, compileExpr);
      return [next, [...bs, x]];
    },
    [scope, []],
  );
  const test = compileExpr(e.satisfies, inner);
  const run = (ctx: Ctx, i: number): boolean => {
    const b = bound[i];
    if (b === undefined) return ebv(test(ctx), e.offset);
    const items = b.code(ctx);
    const each = (item: Item) => {
      ctx.frame[b.slot] = checkType(b.type, [item], e.offset);
      return run(ctx, i + 1);
    };
    return e.every ? items.every(each) : items.some(each);
  };
  return (ctx) => toBool(run(ctx, 0));
};

const integerValue = (n: number): Sequence => [AtomicValue.integer(BigInt(n))];

const switchExpr = (e: Extract<ExprT, { readonly _tag: "Switch" }>, scope: Scope): Code => {
  const operand = compileExpr(e.operand, scope);
  const cases = e.cases.map((c) => ({
    operands: c.operands.map((o) => compileExpr(o, scope)),
    result: compileExpr(c.result, scope),
  }));
  const fallback = compileExpr(e.default, scope);
  return (ctx) => {
    const v = optionalAtomic(operand(ctx), "the switch operand", e.offset);
    const same = (o: Code) => {
      const w = optionalAtomic(o(ctx), "a switch case", e.offset);
      return v === undefined || w === undefined
        ? v === w
        : atomicDeepEqual(v, w, ctx.dyn.implicitTimezone);
    };
    const hit = cases.find((c) => c.operands.some(same));
    return hit === undefined ? fallback(ctx) : hit.result(ctx);
  };
};

const typeswitch = (e: Extract<ExprT, { readonly _tag: "Typeswitch" }>, scope: Scope): Code => {
  const operand = compileExpr(e.operand, scope);
  const branch = (variable: Option.Option<EQName>, result: ExprT) => {
    const [inner, slot] = Option.match(variable, {
      onNone: (): readonly [Scope, number | undefined] => [scope, undefined],
      onSome: (v) => bindLocal(scope, v),
    });
    return { slot, code: compileExpr(result, inner) };
  };
  const cases = e.cases.map((c) => ({
    types: c.types.map((t) => seqTypeOf(t, scope)),
    ...branch(c.variable, c.result),
  }));
  const fallback = branch(e.defaultVariable, e.default);
  return (ctx) => {
    const v = operand(ctx);
    const hit = cases.find((c) => c.types.some((t) => sequenceMatches(t, v))) ?? fallback;
    if (hit.slot !== undefined) ctx.frame[hit.slot] = v;
    return hit.code(ctx);
  };
};

const errorTest = (
  t: Parameters<typeof NodeTest.$match>[0],
  scope: Scope,
): ((code: QName) => boolean) =>
  NodeTest.$match(t, {
    Name: ({ name }) => {
      const n = resolve(scope, name, "other");
      return (code: QName) => code.local === n.local && (uriOf(code) ?? "") === n.uri;
    },
    Wildcard: ({ wildcard }) => {
      const local = Option.getOrUndefined(wildcard.local);
      const uri = Option.getOrUndefined(
        Option.orElse(wildcard.uri, () =>
          Option.map(
            wildcard.prefix,
            (p) =>
              resolve(
                scope,
                { prefix: Option.some(p), local: "x", uri: Option.none(), offset: wildcard.offset },
                "other",
              ).uri,
          ),
        ),
      );
      return (code: QName) =>
        (local === undefined || code.local === local) &&
        (uri === undefined || (uriOf(code) ?? "") === uri);
    },
    Kind: () => () => false,
  });

const errVariables = [
  "code",
  "description",
  "value",
  "module",
  "line-number",
  "column-number",
  "additional",
];

const tryCatch = (e: Extract<ExprT, { readonly _tag: "TryCatch" }>, scope: Scope): Code => {
  const body = compileExpr(e.body, scope);
  const catches = e.catches.map((c) => {
    const [inner, slots] = errVariables.reduce<readonly [Scope, ReadonlyArray<number>]>(
      ([s, acc], local) => {
        const [next, slot] = bindExpanded(s, { uri: Namespaces.err, local });
        return [next, [...acc, slot]];
      },
      [scope, []],
    );
    return {
      tests: c.tests.map((t) => errorTest(t, scope)),
      slots,
      code: compileExpr(c.body, inner),
    };
  });
  return (ctx) =>
    catching(
      () => body(ctx),
      (error) => {
        const hit = catches.find((c) => c.tests.some((t) => t(error.code)));
        if (hit === undefined) throw error;
        const values: ReadonlyArray<Sequence> = [
          [AtomicValue.qname(error.code)],
          [AtomicValue.string(error.description)],
          error.value ?? empty,
          empty,
          empty,
          error.offset === undefined ? empty : integerValue(error.offset),
          empty,
        ];
        hit.slots.forEach((slot, i) => {
          ctx.frame[slot] = values[i] ?? empty;
        });
        return hit.code(ctx);
      },
    );
};

const stringConstructor = (
  e: Extract<ExprT, { readonly _tag: "StringConstructor" }>,
  scope: Scope,
): Code => {
  const parts = e.parts.map((p): Code | string =>
    Expr.$is("StringLiteral")(p) ? p.value : compileExpr(p, scope),
  );
  return (ctx) => [
    AtomicValue.string(
      parts
        .map((p) =>
          P.isString(p)
            ? p
            : unwrap(atomize(p(ctx)), e.offset)
                .map(atomicString)
                .join(" "),
        )
        .join(""),
    ),
  ];
};

// -----------------------------------------------------------------------------
// The dispatch
// -----------------------------------------------------------------------------

/** Compile an expression in a scope. */
const compileExpr = (e: ExprT, scope: Scope): Code =>
  Expr.$match(e, {
    IntegerLiteral: ({ value }) => constant([AtomicValue.integer(BigInt(value))]),
    DecimalLiteral: ({ value, offset }) => constant([decimalLiteral(value, offset)]),
    DoubleLiteral: ({ value }) => constant([AtomicValue.double(Number(value))]),
    StringLiteral: ({ value }) => constant([AtomicValue.string(value)]),
    VarRef: (v) => varRef(v, scope),
    ContextItem:
      ({ offset }) =>
      (ctx: Ctx) => [contextItem(ctx, offset)],
    Sequence: ({ items }) => sequence(items.map((i) => compileExpr(i, scope))),
    Placeholder: ({ offset }) =>
      raise("XPST0003", "an argument placeholder outside a function call", offset),
    FunctionCall: ({ name, args, offset }) => functionCall(name, args, offset, scope),
    NamedFunctionRef: (r) => namedFunctionRef(r, scope),
    InlineFunction: (f) => inlineFunction(f, scope),
    DynamicCall: (c) => dynamicCall(c.function, c.args, c.offset, scope),
    Filter: (f) => filterCode(f, scope, compileExpr),
    Lookup: ({ base, key, offset }) => lookup(compileExpr(base, scope), key, offset, scope),
    UnaryLookup: ({ key, offset }) =>
      lookup((ctx: Ctx) => [contextItem(ctx, offset)], key, offset, scope),
    Map: (m) => mapConstructor(m, scope),
    SquareArray: ({ members }) => {
      const codes = members.map((m) => compileExpr(m, scope));
      return (ctx: Ctx) => [new ArrayItem(codes.map((c) => c(ctx)))];
    },
    CurlyArray: ({ body }) => {
      const code = compileExpr(body, scope);
      return (ctx: Ctx) => [new ArrayItem(code(ctx).map((item) => [item]))];
    },
    Path: (p) => pathCode(p, scope, compileExpr),
    AxisStep: (s) => axisStepCode(s, scope, compileExpr),
    Binary: (b) => binary(b, scope),
    Unary: ({ op, operand, offset }) => {
      const code = compileExpr(operand, scope);
      return scope.statics.context.xpath1Compatibility
        ? (ctx: Ctx) => unary(op, numericOperand(code(ctx), offset), offset)
        : (ctx: Ctx) => unary(op, code(ctx), offset);
    },
    InstanceOf: (x) => instanceOf(x, scope),
    TreatAs: (x) => treatAs(x, scope),
    CastableAs: (x) => castableAs(x, scope),
    CastAs: (x) => castAs(x, scope),
    ArrowCall: ({ base, name, args, offset }) => functionCall(name, [base, ...args], offset, scope),
    ArrowDynamic: (a) => dynamicCall(a.function, [a.base, ...a.args], a.offset, scope),
    If: (x) => ifExpr(x, scope),
    Quantified: (q) => quantified(q, scope),
    Flwor: (f) => flwor(f, scope, compileExpr),
    Switch: (s) => switchExpr(s, scope),
    Typeswitch: (t) => typeswitch(t, scope),
    TryCatch: (t) => tryCatch(t, scope),
    Validate: ({ offset }) => raise("XQST0075", "schema validation is not supported", offset),
    Extension: ({ body, offset }) =>
      Option.match(body, {
        onNone: () =>
          raise("XQST0079", "no pragma is supported and the extension has no body", offset),
        onSome: (b) => compileExpr(b, scope),
      }),
    Ordering: ({ body }) => compileExpr(body, scope),
    StringConstructor: (s) => stringConstructor(s, scope),
    DirElement: (x) => dirElement(x, scope, compileExpr),
    DirText: ({ value }) => constant([XdmNode.fromText(value)]),
    DirComment: (x) => dirComment(x, scope),
    DirPI: (x) => dirPI(x, scope),
    CompDocument: (x) => compDocument(x, scope, compileExpr),
    CompElement: (x) => compElement(x, scope, compileExpr),
    CompAttribute: (x) => compAttribute(x, scope, compileExpr),
    CompNamespace: (x) => compNamespace(x, scope, compileExpr),
    CompText: (x) => compText(x, scope, compileExpr),
    CompComment: (x) => compComment(x, scope, compileExpr),
    CompPI: (x) => compPI(x, scope, compileExpr),
  });

// -----------------------------------------------------------------------------
// Programs: the prolog and the body
// -----------------------------------------------------------------------------

/** A compiled query, ready to run against a dynamic context. */
export interface Compiled {
  /** The query body's code; it runs with the context item as its focus. */
  readonly body: Code;
  readonly layout: Layout;
  readonly program: Program;
  /** The context item's declared default, from `declare context item`. */
  readonly contextDefault: Code | undefined;
  /**
   * The context item's declared types (each exactly one item), from the
   * `declare context item` of the main module and of every library module
   * it imports: the context item must match them all.
   */
  readonly contextTypes: ReadonlyArray<SeqType>;
}

const declaredFunction = (
  d: Extract<DeclT, { readonly _tag: "Function" }>,
  scope: Scope,
): UserFunction => {
  const n = resolve(scope, d.name, "function");
  const layout = new Layout(undefined);
  const [, slots, types] = bindParams(d.params, { ...scope, layout });
  return {
    name: qnameOf(n, d.name),
    signature: { params: types, result: optionalSeqType(d.returnType, scope) },
    layout,
    slots,
    body: undefined,
  };
};

const global = (name: string, external: boolean, type: SeqType | undefined): GlobalVar => ({
  clark: name,
  external,
  type,
  layout: new Layout(undefined),
  init: undefined,
});

const declareGlobals = (
  decls: ReadonlyArray<DeclT>,
  scope: Scope,
  externals: ReadonlyArray<string>,
): void => {
  const { program } = scope;
  externals.forEach((name) => program.declareGlobal(global(name, true, undefined)));
  decls.forEach((d) => {
    if (Decl.$is("Variable")(d)) {
      const type = Option.getOrUndefined(Option.map(d.type, (t) => seqTypeOf(t, scope)));
      program.declareGlobal(global(clark(resolve(scope, d.name, "variable")), d.external, type));
    }
    if (Decl.$is("Function")(d))
      program.declareFunction(
        clark(resolve(scope, d.name, "function")),
        declaredFunction(d, scope),
      );
    if (Decl.$is("SchemaImport")(d)) raise("XQST0009", "schema import is not supported", d.offset);
  });
};

/** Compile a global variable's initializer, in a frame layout of its own. */
const compileGlobal = (d: Extract<DeclT, { readonly _tag: "Variable" }>, scope: Scope): void => {
  const index = scope.program.globalIndex(clark(resolve(scope, d.name, "variable")));
  const g = index === undefined ? undefined : scope.program.globals[index];
  if (g !== undefined)
    g.init = Option.getOrUndefined(
      Option.map(d.value, (v) => compileExpr(v, { ...scope, layout: g.layout })),
    );
};

/** Compile a declared function's body, now that every declaration's signature is known. */
const compileFunction = (d: Extract<DeclT, { readonly _tag: "Function" }>, scope: Scope): void => {
  const f = scope.program.functionOf(clark(resolve(scope, d.name, "function")), d.params.length);
  if (f !== undefined)
    f.body = Option.match(d.body, {
      onNone: () => () => notImplemented(`the external function ${f.name.qualified}`, d.offset),
      onSome: (b) => compileExpr(b, withParams(d, f, scope)),
    });
};

/** Compile the prolog's initializers and function bodies; the context item's default, if it declares one. */
const compileBodies = (decls: ReadonlyArray<DeclT>, scope: Scope): Code | undefined =>
  decls.reduce<Code | undefined>((contextDefault, d) => {
    if (Decl.$is("Variable")(d)) compileGlobal(d, scope);
    if (Decl.$is("Function")(d)) compileFunction(d, scope);
    if (Decl.$is("ContextItem")(d))
      return Option.getOrUndefined(Option.map(d.value, (v) => compileExpr(v, scope)));
    return contextDefault;
  }, undefined);

/** The type a prolog's `declare context item` gives the context item: none, or one. */
const contextTypesOf = (decls: ReadonlyArray<DeclT>, scope: Scope): ReadonlyArray<SeqType> =>
  decls.flatMap((d) =>
    Decl.$is("ContextItem")(d)
      ? [
          Option.match(d.type, {
            onNone: () => anySingleItem,
            onSome: (t) => singleItemType(t, (n, k) => resolve(scope, n, k)),
          }),
        ]
      : [],
  );

/** The scope of a declared function's body: its parameters bound to its own slots. */
const withParams = (
  d: Extract<DeclT, { readonly _tag: "Function" }>,
  f: UserFunction,
  scope: Scope,
): Scope =>
  d.params.reduce<Scope>(
    (s, p, i) => ({
      ...s,
      vars: HashMap.set(s.vars, clark(resolve(s, p.name, "variable")), {
        kind: "local",
        binding: { layout: f.layout, slot: f.slots[i] ?? 0 },
      }),
    }),
    { ...scope, layout: f.layout },
  );

/** Compile a query: its prolog's globals and functions, and its body. */
export const compileQuery = (query: Query, externals: ReadonlyArray<string>): Compiled => {
  const program = new Program();
  const layout = new Layout(undefined);
  const scope: Scope = { statics: scopeOf(query.context), vars: HashMap.empty(), layout, program };
  if (query.language === "XPath") {
    declareGlobals([], scope, externals);
    return {
      body: compileExpr(query.expr, scope),
      layout,
      program,
      contextDefault: undefined,
      contextTypes: [],
    };
  }
  // Every library module's globals and functions go in the one program, so
  // modules (even ones that import each other) reach each other's by name.
  const libraries = query.libraries.map((l): readonly [ReadonlyArray<DeclT>, Scope] => [
    l.module.prolog,
    { statics: scopeOf(l.context), vars: HashMap.empty(), layout: new Layout(undefined), program },
  ]);
  return Module.$match(query.module, {
    Library: (l) => notImplemented("evaluating a library module", l.offset),
    Main: (m) => {
      // The host's variables first: a module's declaration of one replaces it.
      declareGlobals([], scope, externals);
      libraries.forEach(([decls, s]) => declareGlobals(decls, s, []));
      declareGlobals(m.prolog, scope, []);
      libraries.forEach(([decls, s]) => compileBodies(decls, s));
      const contextDefault = compileBodies(m.prolog, scope);
      const contextTypes = [
        ...contextTypesOf(m.prolog, scope),
        ...libraries.flatMap(([decls, s]) => contextTypesOf(decls, s)),
      ];
      return { body: compileExpr(m.body, scope), layout, program, contextDefault, contextTypes };
    },
  });
};

/**
 * Compile parts of a query's body on their own, in its static context: the
 * prolog's globals and functions, then each expression of `parts` (each in
 * the body's scope), as a streamed query compiles its predicates and the
 * operations on each match.
 */
export const compileParts = (
  query: Query,
  externals: ReadonlyArray<string>,
  parts: ReadonlyArray<ExprT>,
): ReadonlyArray<Code> => {
  const program = new Program();
  const scope: Scope = {
    statics: scopeOf(query.context),
    vars: HashMap.empty(),
    layout: new Layout(undefined),
    program,
  };
  declareGlobals([], scope, externals);
  if (query.language === "XQuery" && Module.$is("Main")(query.module)) {
    declareGlobals(query.module.prolog, scope, []);
    compileBodies(query.module.prolog, scope);
  }
  return parts.map((part) => compileExpr(part, scope));
};

/** Run a compiled query; a query that declares a default context item uses it when the host gives none. */
export const runCompiled = (compiled: Compiled, dyn: Dynamic): Sequence => {
  const { contextDefault, contextTypes } = compiled;
  // The context item, the host's or the declared default, must be exactly
  // one item of every declared type (XQuery 3.1 §4.17).
  const given =
    dyn.initialContext === undefined
      ? contextDefault === undefined
        ? undefined
        : matchType(
            anySingleItem,
            contextDefault(new Ctx(undefined, 0, 0, [], dyn)),
            "the context item",
          )
      : [dyn.initialContext];
  const initial =
    given === undefined
      ? undefined
      : contextTypes.reduce((v, t) => matchType(t, v, "the context item"), given)[0];
  const run = initial === dyn.initialContext ? dyn : { ...dyn, initialContext: initial };
  return compiled.body(new Ctx(initial, 1, 1, [], run));
};
