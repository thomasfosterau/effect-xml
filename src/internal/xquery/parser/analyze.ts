/**
 * Static analysis: builds the static context from the host's options and
 * the prolog, and checks the query against it (XQuery 3.1 §2.2.3.1, §4).
 *
 * The checks are the static errors that need no schema and no evaluation:
 *
 * - names: `XPST0081` (an unbound prefix), `XPST0008` (an undeclared
 *   variable, or an unknown type or schema declaration in a node test),
 *   `XPST0017` (no function with that name and arity), `XPST0051` /
 *   `XPST0080` (an unknown or unusable type in a sequence type or cast);
 * - direct constructors: `XQST0040` (duplicate attributes), `XQST0070` /
 *   `XQST0071` / `XQST0085` (namespace declaration attributes);
 * - FLWOR and functions: `XQST0039`, `XQST0089`, `XQST0094`, `XQST0103`;
 * - the prolog: duplicate setters and declarations (`XQST0032`, `XQST0033`,
 *   `XQST0034`, `XQST0038`, `XQST0047`, `XQST0049`, `XQST0055`,
 *   `XQST0065` … `XQST0069`, `XQST0099`, `XQST0111`, `XQST0114`), reserved
 *   namespaces (`XQST0045`, `XQST0060`, `XQST0070`), library modules
 *   (`XQST0048`), the version declaration (`XQST0031`, `XQST0087`),
 *   decimal formats (`XQST0097`) and options (`XQST0108` … `XQST0110`).
 *
 * Names in the namespaces of imported modules and schemas are not checked:
 * the analysis cannot see what those declare.
 *
 * Names are not rewritten: the evaluator resolves them with
 * {@link resolveName} against the same {@link Scope}, so the tree it gets is
 * the one the parser built.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type {
  Annotation,
  ComputedName as ComputedNameT,
  ComputedNCName as ComputedNCNameT,
  Axis,
  Clause as ClauseT,
  DirAttribute,
  DirNamespace,
  EQName,
  ForBinding,
  KeySpecifier as KeySpecifierT,
  NodeTest as NodeTestT,
  Param,
  SequenceType as SequenceTypeT,
  SingleType,
} from "./ast.ts";
import {
  Clause,
  ComputedName,
  ComputedNCName,
  Expr,
  ItemType,
  KeySpecifier,
  NodeTest,
  SequenceType,
} from "./ast.ts";
import { accepts, builtinArities, clark, Namespaces, xsType } from "./builtins.ts";
import type { StaticContext } from "./context.ts";
import { codepointCollation } from "./context.ts";
import type { StaticError } from "./errors.ts";
import { staticError } from "./errors.ts";

/** Static errors, in the order they were found. */
export type Errors = ReadonlyArray<StaticError>;

/** No errors. */
export const none: Errors = [];

/** What a name denotes, which decides its default namespace. */
export type NameKind = "element" | "type" | "function" | "attribute" | "variable" | "other";

/** An expanded name: a namespace URI (`""` for none) and a local name. */
export interface ExpandedName {
  readonly uri: string;
  readonly local: string;
}

/** The static context at a point in the query: the prolog's, plus direct constructors' namespaces and local variables. */
export interface Scope {
  readonly context: StaticContext;
  readonly namespaces: HashMap.HashMap<string, string>;
  readonly defaultElementNamespace: string;
  readonly variables: HashSet.HashSet<string>;
}

/** The scope a module's body (or an XPath expression) starts in. */
export const scopeOf = (context: StaticContext): Scope => ({
  context,
  namespaces: context.namespaces,
  defaultElementNamespace: context.defaultElementNamespace,
  variables: context.variables,
});

const defaultNamespace = (scope: Scope, kind: NameKind): string =>
  kind === "element" || kind === "type"
    ? scope.defaultElementNamespace
    : kind === "function"
      ? scope.context.defaultFunctionNamespace
      : "";

/** Resolve a name as written against the in-scope namespaces: `XPST0081` if its prefix is unbound. */
export const resolveName = (
  scope: Scope,
  name: EQName,
  kind: NameKind,
): Result.Result<ExpandedName, StaticError> =>
  Option.match(name.uri, {
    onSome: (uri) =>
      uri === Namespaces.xmlns
        ? Result.fail(
            staticError("XQST0070", `no name can be in the namespace "${uri}"`, name.offset),
          )
        : Result.succeed({ uri, local: name.local }),
    onNone: () =>
      Option.match(name.prefix, {
        onNone: () => Result.succeed({ uri: defaultNamespace(scope, kind), local: name.local }),
        onSome: (prefix) =>
          Option.match(HashMap.get(scope.namespaces, prefix), {
            onNone: () =>
              Result.fail(
                staticError("XPST0081", `the prefix "${prefix}" is not bound`, name.offset),
              ),
            onSome: (uri) => Result.succeed({ uri, local: name.local }),
          }),
      }),
  });

/** An expanded name's key in the static context's tables: its Clark name. */
export const keyOf = (n: ExpandedName): string => clark(n.uri, n.local);

/** A name as written, for messages. */
export const show = (n: EQName): string =>
  Option.match(n.uri, {
    onSome: (uri) => `Q{${uri}}${n.local}`,
    onNone: () =>
      Option.match(n.prefix, { onNone: () => n.local, onSome: (p) => `${p}:${n.local}` }),
  });

const isOpaque = (scope: Scope, n: ExpandedName): boolean =>
  HashSet.has(scope.context.opaqueNamespaces, n.uri);

/** Check a name: its prefix must be bound. */
export const nameErrors = (scope: Scope, name: EQName, kind: NameKind): Errors =>
  Result.match(resolveName(scope, name, kind), { onFailure: (e) => [e], onSuccess: () => none });

/** Resolve a name, then check what it names. */
const withName = (
  scope: Scope,
  name: EQName,
  kind: NameKind,
  check: (n: ExpandedName) => Errors,
): Errors =>
  Result.match(resolveName(scope, name, kind), { onFailure: (e) => [e], onSuccess: check });

/** `scope` with the variables `names` in scope. */
export const bind = (scope: Scope, names: ReadonlyArray<ExpandedName>): Scope => ({
  ...scope,
  variables: Arr.reduce(names, scope.variables, (vs, n) => HashSet.add(vs, keyOf(n))),
});

/** Resolve variable names to bind, keeping the ones that resolve. */
const resolveAll = (scope: Scope, names: ReadonlyArray<EQName>): ReadonlyArray<ExpandedName> =>
  names.flatMap((n) =>
    Result.match(resolveName(scope, n, "variable"), { onFailure: () => [], onSuccess: (x) => [x] }),
  );

/** The first name that appears twice in a list, by expanded name. */
const duplicate = (
  scope: Scope,
  names: ReadonlyArray<EQName>,
  kind: NameKind,
): Option.Option<EQName> => {
  const keys = names.map((n) =>
    Result.match(resolveName(scope, n, kind), {
      onFailure: () => `\u0000${show(n)}`,
      onSuccess: keyOf,
    }),
  );
  return Arr.findFirst(names, (_, i) => keys.indexOf(keys[i] ?? "") !== i);
};

// Types -----------------------------------------------------------------------

type TypeUse = "item" | "cast" | "declaration";

/** What a type name is: an `xs:` type of some kind, or unknown. */
type TypeKind = "atomic" | "list" | "other" | "unknown";

/** The error code and reason for using a type of `kind` as `use`, if it can't be. */
const typeProblem = (
  use: TypeUse,
  kind: TypeKind,
  local: string,
  xquery: boolean,
): Option.Option<readonly [string, string]> => {
  const castable = kind === "atomic" || kind === "list";
  const unusable = local === "NOTATION" || local === "anyAtomicType" || local === "anySimpleType";
  if (use === "declaration")
    return kind === "unknown" ? Option.some(["XPST0008", "is not a known type"]) : Option.none();
  if (use === "item")
    return kind === "atomic"
      ? Option.none()
      : Option.some(["XPST0051", "is not an atomic or union type"]);
  if (unusable && kind !== "unknown")
    return Option.some(["XPST0080", "can't be the target of a cast"]);
  return castable
    ? Option.none()
    : Option.some([xquery ? "XQST0052" : "XPST0051", "is not a known simple type"]);
};

/** Check a type name: an atomic type in an item type, a castable type in `cast`, any type in an element or attribute test. */
const typeName = (scope: Scope, name: EQName, use: TypeUse): Errors =>
  withName(scope, name, "type", (n) =>
    isOpaque(scope, n)
      ? none
      : Option.match(
          typeProblem(
            use,
            n.uri === Namespaces.xs ? xsType(n.local) : "unknown",
            n.local,
            scope.context.xquery,
          ),
          {
            onNone: () => none,
            onSome: ([code, why]) => [staticError(code, `${show(name)} ${why}`, name.offset)],
          },
        ),
  );

const declaredName = (scope: Scope, name: EQName, kind: NameKind): Errors =>
  withName(scope, name, kind, (n) =>
    isOpaque(scope, n)
      ? none
      : [
          staticError(
            "XPST0008",
            `${show(name)} is not declared in the in-scope schema definitions`,
            name.offset,
          ),
        ],
  );

const optionNames = (scope: Scope, name: Option.Option<EQName>, kind: NameKind): Errors =>
  Option.match(name, { onNone: () => none, onSome: (n) => nameErrors(scope, n, kind) });

/** The static errors of an item type: unbound prefixes, unknown types and declarations. */
export const itemType = (scope: Scope, t: ItemType): Errors =>
  ItemType.$match(t, {
    AnyItem: () => none,
    AnyKind: () => none,
    Comment: () => none,
    Text: () => none,
    NamespaceNode: () => none,
    AnyMap: () => none,
    AnyArray: () => none,
    ProcessingInstruction: () => none,
    Atomic: ({ name }) => typeName(scope, name, "item"),
    Document: ({ element }) =>
      Option.match(element, { onNone: () => none, onSome: (e) => itemType(scope, e) }),
    Element: ({ name, type }) => [
      ...optionNames(scope, name, "element"),
      ...Option.match(type, {
        onNone: () => none,
        onSome: (n) => typeName(scope, n, "declaration"),
      }),
    ],
    Attribute: ({ name, type }) => [
      ...optionNames(scope, name, "attribute"),
      ...Option.match(type, {
        onNone: () => none,
        onSome: (n) => typeName(scope, n, "declaration"),
      }),
    ],
    SchemaElement: ({ name }) => declaredName(scope, name, "element"),
    SchemaAttribute: ({ name }) => declaredName(scope, name, "attribute"),
    AnyFunction: ({ annotations }) => annotationErrors(scope, annotations),
    TypedFunction: ({ annotations, parameters, result }) => [
      ...annotationErrors(scope, annotations),
      ...parameters.flatMap((p) => sequenceType(scope, p)),
      ...sequenceType(scope, result),
    ],
    TypedMap: ({ key, value }) => [...typeName(scope, key, "item"), ...sequenceType(scope, value)],
    TypedArray: ({ member }) => sequenceType(scope, member),
  });

const sequenceType = (scope: Scope, t: SequenceTypeT): Errors =>
  SequenceType.$match(t, {
    EmptySequence: () => none,
    Items: ({ item }) => itemType(scope, item),
  });

/** The static errors of an optional sequence type. */
export const optionalType = (scope: Scope, t: Option.Option<SequenceTypeT>): Errors =>
  Option.match(t, { onNone: () => none, onSome: (x) => sequenceType(scope, x) });

const singleType = (scope: Scope, t: SingleType): Errors => typeName(scope, t.name, "cast");

/** The namespaces nothing may be declared in (XQST0045). */
export const reservedNamespaces: ReadonlyArray<string> = [
  Namespaces.fn,
  Namespaces.xml,
  Namespaces.xs,
  Namespaces.xsi,
  Namespaces.math,
  Namespaces.map,
  Namespaces.array,
];

/** The namespace of unprefixed annotation and option names (XQuery 3.1 §4.15, §4.19). */
const xqueryNamespace = "http://www.w3.org/2012/xquery";

/** An annotation's name: unprefixed names are in {@link xqueryNamespace}. */
export const annotationName = (
  scope: Scope,
  a: Annotation,
): Result.Result<ExpandedName, StaticError> =>
  Option.isNone(a.name.prefix) && Option.isNone(a.name.uri)
    ? Result.succeed({ uri: xqueryNamespace, local: a.name.local })
    : resolveName(scope, a.name, "other");

/** `%public` or `%private`. */
export const isVisibility = (n: ExpandedName): boolean =>
  n.uri === xqueryNamespace && (n.local === "public" || n.local === "private");

/** `XQST0045`: annotations in a reserved namespace, other than `%public` and `%private`. */
export const annotationErrors = (scope: Scope, annotations: ReadonlyArray<Annotation>): Errors =>
  annotations.flatMap((a) =>
    Result.match(annotationName(scope, a), {
      onFailure: (e) => [e],
      onSuccess: (n) =>
        (Arr.contains(reservedNamespaces, n.uri) || n.uri === xqueryNamespace) && !isVisibility(n)
          ? [
              staticError(
                "XQST0045",
                `the annotation %${show(a.name)} is in a reserved namespace`,
                a.name.offset,
              ),
            ]
          : none,
    }),
  );

// Expressions -----------------------------------------------------------------

/** The arities `scope` knows for a function: built-in, the host's, or declared in the prolog. */
const aritiesOf = (scope: Scope, key: string) =>
  Option.orElse(HashMap.get(scope.context.functions, key), () => builtinArities(key));

const call = (scope: Scope, name: EQName, arity: number): Errors =>
  withName(scope, name, "function", (n) =>
    isOpaque(scope, n) ||
    Option.exists(aritiesOf(scope, keyOf(n)), (arities) => accepts(arities, arity))
      ? none
      : [
          staticError(
            "XPST0017",
            `no function ${show(name)}#${arity} is in the static context`,
            name.offset,
          ),
        ],
  );

const variable = (scope: Scope, name: EQName, offset: number): Errors =>
  withName(scope, name, "variable", (n) =>
    HashSet.has(scope.variables, keyOf(n)) || isOpaque(scope, n)
      ? none
      : [staticError("XPST0008", `the variable $${show(name)} is not declared`, offset)],
  );

const all = (scope: Scope, es: ReadonlyArray<Expr>): Errors => es.flatMap((e) => expr(scope, e));

/** The static errors of an optional expression. */
export const optionalExpr = (scope: Scope, e: Option.Option<Expr>): Errors =>
  Option.match(e, { onNone: () => none, onSome: (x) => expr(scope, x) });

const nodeTest = (scope: Scope, test: NodeTestT, axis: Axis): Errors =>
  NodeTest.$match(test, {
    Name: ({ name }) =>
      nameErrors(
        scope,
        name,
        axis === "attribute" || axis === "namespace" ? "attribute" : "element",
      ),
    Wildcard: ({ wildcard }) =>
      Option.match(wildcard.prefix, {
        onNone: () => none,
        onSome: (prefix) =>
          HashMap.has(scope.namespaces, prefix)
            ? none
            : [staticError("XPST0081", `the prefix "${prefix}" is not bound`, wildcard.offset)],
      }),
    Kind: ({ test: t }) => itemType(scope, t),
  });

const keySpecifier = (scope: Scope, key: KeySpecifierT): Errors =>
  KeySpecifier.$match(key, {
    Name: () => none,
    Integer: () => none,
    Wildcard: () => none,
    Expr: ({ expr: e }) => expr(scope, e),
  });

/** The static errors of a parameter list: `XQST0039` for a repeated name, and the parameters' types. */
export const params = (scope: Scope, ps: ReadonlyArray<Param>): Errors => [
  ...Option.match(
    duplicate(
      scope,
      ps.map((p) => p.name),
      "variable",
    ),
    {
      onNone: () => none,
      onSome: (n) => [
        staticError("XQST0039", `the parameter $${show(n)} is declared twice`, n.offset),
      ],
    },
  ),
  ...ps.flatMap((p) => [...nameErrors(scope, p.name, "variable"), ...optionalType(scope, p.type)]),
];

/** The variables `catch` binds: `$err:code`, `$err:description`, … */
const catchVariables: ReadonlyArray<ExpandedName> = [
  "code",
  "description",
  "value",
  "module",
  "line-number",
  "column-number",
  "additional",
].map((local) => ({ uri: Namespaces.err, local }));

/** The static errors of an expression in `scope`, in the order they appear. */
export const expr = (scope: Scope, e: Expr): Errors =>
  Expr.$match(e, {
    IntegerLiteral: () => none,
    DecimalLiteral: () => none,
    DoubleLiteral: () => none,
    StringLiteral: () => none,
    ContextItem: () => none,
    Placeholder: () => none,
    DirText: () => none,
    DirComment: () => none,
    DirPI: () => none,
    VarRef: ({ name, offset }) => variable(scope, name, offset),
    Sequence: ({ items }) => all(scope, items),
    FunctionCall: ({ name, args }) => [...call(scope, name, args.length), ...all(scope, args)],
    NamedFunctionRef: ({ name, arity }) => call(scope, name, arity),
    InlineFunction: ({ annotations, params: ps, returnType, body, offset }) => [
      ...annotationErrors(scope, annotations),
      ...(annotations.some((a) =>
        Result.match(annotationName(scope, a), { onFailure: () => false, onSuccess: isVisibility }),
      )
        ? [staticError("XQST0125", "an inline function can't be %public or %private", offset)]
        : none),
      ...params(scope, ps),
      ...optionalType(scope, returnType),
      ...expr(
        bind(
          scope,
          resolveAll(
            scope,
            ps.map((p) => p.name),
          ),
        ),
        body,
      ),
    ],
    DynamicCall: ({ function: f, args }) => [...expr(scope, f), ...all(scope, args)],
    Filter: ({ base, predicate }) => [...expr(scope, base), ...expr(scope, predicate)],
    Lookup: ({ base, key }) => [...expr(scope, base), ...keySpecifier(scope, key)],
    UnaryLookup: ({ key }) => keySpecifier(scope, key),
    Map: ({ entries }) =>
      entries.flatMap((en) => [...expr(scope, en.key), ...expr(scope, en.value)]),
    SquareArray: ({ members }) => all(scope, members),
    CurlyArray: ({ body }) => expr(scope, body),
    Path: ({ steps }) => all(scope, steps),
    AxisStep: ({ axis, test, predicates, offset }) => [
      ...(axis === "namespace" && scope.context.xquery
        ? [staticError("XQST0134", "XQuery has no namespace axis", offset)]
        : none),
      ...nodeTest(scope, test, axis),
      ...all(scope, predicates),
    ],
    Binary: ({ left, right }) => [...expr(scope, left), ...expr(scope, right)],
    Unary: ({ operand }) => expr(scope, operand),
    InstanceOf: ({ expr: x, type }) => [...expr(scope, x), ...sequenceType(scope, type)],
    TreatAs: ({ expr: x, type }) => [...expr(scope, x), ...sequenceType(scope, type)],
    CastableAs: ({ expr: x, type }) => [...expr(scope, x), ...singleType(scope, type)],
    CastAs: ({ expr: x, type }) => [...expr(scope, x), ...singleType(scope, type)],
    ArrowCall: ({ base, name, args }) => [
      ...expr(scope, base),
      ...call(scope, name, args.length + 1),
      ...all(scope, args),
    ],
    ArrowDynamic: ({ base, function: f, args }) => [
      ...expr(scope, base),
      ...expr(scope, f),
      ...all(scope, args),
    ],
    If: ({ condition, thenBranch, elseBranch }) => all(scope, [condition, thenBranch, elseBranch]),
    Quantified: ({ bindings, satisfies }) => quantified(scope, bindings, satisfies),
    Flwor: ({ clauses, return: ret }) => flwor(scope, clauses, ret),
    Switch: ({ operand, cases, default: d }) => [
      ...expr(scope, operand),
      ...cases.flatMap((c) => [...all(scope, c.operands), ...expr(scope, c.result)]),
      ...expr(scope, d),
    ],
    Typeswitch: ({ operand, cases, defaultVariable, default: d }) => [
      ...expr(scope, operand),
      ...cases.flatMap((c) => [
        ...c.types.flatMap((t) => sequenceType(scope, t)),
        ...optionNames(scope, c.variable, "variable"),
        ...expr(bind(scope, resolveAll(scope, Option.toArray(c.variable))), c.result),
      ]),
      ...optionNames(scope, defaultVariable, "variable"),
      ...expr(bind(scope, resolveAll(scope, Option.toArray(defaultVariable))), d),
    ],
    TryCatch: ({ body, catches }) => [
      ...expr(scope, body),
      ...catches.flatMap((c) => [
        ...c.tests.flatMap((t) => nodeTest(scope, t, "child")),
        ...expr(bind(scope, catchVariables), c.body),
      ]),
    ],
    Validate: ({ type, body }) => [
      ...Option.match(type, {
        onNone: () => none,
        onSome: (t) => typeName(scope, t, "declaration"),
      }),
      ...expr(scope, body),
    ],
    Extension: ({ pragmas, body, offset }) => [
      ...pragmas.flatMap((p) =>
        Option.isNone(p.name.prefix) && Option.isNone(p.name.uri)
          ? none
          : nameErrors(scope, p.name, "other"),
      ),
      ...Option.match(body, {
        onNone: () => [
          staticError("XQST0079", "no pragma is recognised, and the extension has no body", offset),
        ],
        onSome: (b) => expr(scope, b),
      }),
    ],
    Ordering: ({ body }) => expr(scope, body),
    DirElement: (el) => dirElement(scope, el),
    CompDocument: ({ body }) => expr(scope, body),
    CompText: ({ body }) => expr(scope, body),
    CompComment: ({ body }) => expr(scope, body),
    CompElement: ({ name, body }) => [
      ...computedName(scope, name, "element"),
      ...expr(scope, body),
    ],
    CompAttribute: ({ name, body }) => [
      ...computedName(scope, name, "attribute"),
      ...expr(scope, body),
    ],
    CompNamespace: ({ prefix, uri }) => [...computedNCName(scope, prefix), ...expr(scope, uri)],
    CompPI: ({ target, body }) => [...computedNCName(scope, target), ...expr(scope, body)],
    StringConstructor: ({ parts }) => all(scope, parts),
  });

const computedName = (scope: Scope, name: ComputedNameT, kind: NameKind): Errors =>
  ComputedName.$match(name, {
    Static: ({ name: n }) => nameErrors(scope, n, kind),
    Dynamic: ({ expr: x }) => expr(scope, x),
  });

const computedNCName = (scope: Scope, name: ComputedNCNameT): Errors =>
  ComputedNCName.$match(name, {
    Static: () => none,
    Dynamic: ({ expr: x }) => expr(scope, x),
  });

/** `some` / `every`: each binding's expression sees the variables bound before it. */
const quantified = (scope: Scope, bindings: ReadonlyArray<ForBinding>, satisfies: Expr): Errors => {
  const { errors, scope: inner } = Arr.reduce(bindings, { errors: none, scope }, (acc, b) => ({
    errors: [
      ...acc.errors,
      ...expr(acc.scope, b.in),
      ...optionalType(acc.scope, b.type),
      ...nameErrors(acc.scope, b.name, "variable"),
    ],
    scope: bind(acc.scope, resolveAll(acc.scope, [b.name])),
  }));
  return [...errors, ...expr(inner, satisfies)];
};

interface Flow {
  readonly errors: Errors;
  readonly scope: Scope;
  /** The variables the FLWOR's own clauses have bound so far (`group by` may only name these). */
  readonly bound: HashSet.HashSet<string>;
}

/** Bind variables in a FLWOR clause: in scope, and bound by the FLWOR. */
const flowBind = (flow: Flow, errors: Errors, scope: Scope, names: ReadonlyArray<EQName>): Flow => {
  const resolvedNames = resolveAll(scope, names);
  return {
    errors: [...flow.errors, ...errors],
    scope: bind(scope, resolvedNames),
    bound: Arr.reduce(resolvedNames, flow.bound, (b, n) => HashSet.add(b, keyOf(n))),
  };
};

const sameVariable = (scope: Scope, a: EQName, b: EQName): boolean =>
  Result.match(Result.all([resolveName(scope, a, "variable"), resolveName(scope, b, "variable")]), {
    onFailure: () => false,
    onSuccess: ([x, y]) => keyOf(x) === keyOf(y),
  });

const forBinding = (flow: Flow, b: ForBinding): Flow => {
  const { scope } = flow;
  const position = Option.toArray(b.position);
  return flowBind(
    flow,
    [
      ...expr(scope, b.in),
      ...optionalType(scope, b.type),
      ...nameErrors(scope, b.name, "variable"),
      ...position.flatMap((p) => [
        ...nameErrors(scope, p, "variable"),
        ...(sameVariable(scope, b.name, p)
          ? [
              staticError(
                "XQST0089",
                `$${show(p)} is both the range and the positional variable`,
                p.offset,
              ),
            ]
          : none),
      ]),
    ],
    scope,
    [b.name, ...position],
  );
};

type ClauseWindow = Extract<ClauseT, { readonly _tag: "Window" }>;

/** The variables a window condition binds. */
const conditionVars = (cond: ClauseWindow["start"]): ReadonlyArray<EQName> =>
  [cond.vars.current, cond.vars.position, cond.vars.previous, cond.vars.next].flatMap((v) =>
    Option.toArray(v),
  );

/** A window clause: the start condition sees its own variables, the end condition the start's and its own. */
const windowClause = (flow: Flow, c: ClauseWindow): Flow => {
  const { scope } = flow;
  const startScope = bind(scope, resolveAll(scope, conditionVars(c.start)));
  const names = [
    c.name,
    ...conditionVars(c.start),
    ...Option.toArray(c.end).flatMap(conditionVars),
  ];
  return flowBind(
    flow,
    [
      ...expr(scope, c.in),
      ...optionalType(scope, c.type),
      ...names.flatMap((n) => nameErrors(scope, n, "variable")),
      ...Option.match(duplicate(scope, names, "variable"), {
        onNone: () => none,
        onSome: (n) => [
          staticError("XQST0103", `the window variable $${show(n)} is bound twice`, n.offset),
        ],
      }),
      ...expr(startScope, c.start.when),
      ...Option.match(c.end, {
        onNone: () => none,
        onSome: (end) => expr(bind(startScope, resolveAll(scope, conditionVars(end))), end.when),
      }),
    ],
    scope,
    names,
  );
};

/** `XQST0094`: a grouping variable without a value must name a variable the FLWOR bound. */
const unboundGroupingVariable = (flow: Flow, name: EQName): Errors =>
  Result.match(resolveName(flow.scope, name, "variable"), {
    onFailure: () => none,
    onSuccess: (n) =>
      HashSet.has(flow.bound, keyOf(n))
        ? none
        : [
            staticError(
              "XQST0094",
              `the grouping variable $${show(name)} is not bound by the FLWOR`,
              name.offset,
            ),
          ],
  });

const groupBy = (flow: Flow, c: Extract<ClauseT, { readonly _tag: "GroupBy" }>): Flow =>
  Arr.reduce(c.specs, flow, (acc, spec) =>
    flowBind(
      acc,
      [
        ...nameErrors(acc.scope, spec.name, "variable"),
        ...optionalType(acc.scope, spec.type),
        ...Option.match(spec.value, {
          onSome: (v) => expr(flow.scope, v),
          onNone: () => unboundGroupingVariable(acc, spec.name),
        }),
        ...Option.match(spec.collation, {
          onNone: () => none,
          onSome: (uri) => collationErrors(acc.scope, uri, "XQST0076", spec.name.offset),
        }),
      ],
      acc.scope,
      [spec.name],
    ),
  );

const clause = (flow: Flow, c: ClauseT): Flow =>
  Clause.$match(c, {
    For: ({ bindings }) => Arr.reduce(bindings, flow, forBinding),
    Let: ({ bindings }) =>
      Arr.reduce(bindings, flow, (acc, b) =>
        flowBind(
          acc,
          [
            ...expr(acc.scope, b.value),
            ...optionalType(acc.scope, b.type),
            ...nameErrors(acc.scope, b.name, "variable"),
          ],
          acc.scope,
          [b.name],
        ),
      ),
    Window: (w) => windowClause(flow, w),
    Where: ({ condition }) => ({
      ...flow,
      errors: [...flow.errors, ...expr(flow.scope, condition)],
    }),
    GroupBy: (g) => groupBy(flow, g),
    OrderBy: ({ specs, offset }) => ({
      ...flow,
      errors: [
        ...flow.errors,
        ...specs.flatMap((s) => [
          ...expr(flow.scope, s.expr),
          ...Option.match(s.collation, {
            onNone: () => none,
            onSome: (uri) => collationErrors(flow.scope, uri, "XQST0076", offset),
          }),
        ]),
      ],
    }),
    Count: ({ name }) =>
      flowBind(flow, nameErrors(flow.scope, name, "variable"), flow.scope, [name]),
  });

const flwor = (scope: Scope, clauses: ReadonlyArray<ClauseT>, ret: Expr): Errors => {
  const end = Arr.reduce(clauses, { errors: none, scope, bound: HashSet.empty<string>() }, clause);
  return [...end.errors, ...expr(end.scope, ret)];
};

// Collations ------------------------------------------------------------------

/** The collations every query has: the codepoint collation, HTML ASCII case-insensitive, and UCA with parameters. */
const isKnownCollation = (scope: Scope, uri: string): boolean =>
  uri === codepointCollation ||
  uri === "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive" ||
  uri.startsWith("http://www.w3.org/2013/collation/UCA") ||
  HashSet.has(scope.context.collations, uri);

/** Resolve a collation URI against the base URI; `undefined` if it can't be. */
const absoluteCollation = (scope: Scope, uri: string): Option.Option<string> =>
  URL.canParse(uri)
    ? Option.some(uri)
    : Option.flatMap(scope.context.baseUri, (base) =>
        URL.canParse(uri, base) ? Option.some(new URL(uri, base).href) : Option.none(),
      );

/** `code` (`XQST0038` in a declaration, `XQST0076` in `order by` / `group by`) if the collation is not known. */
export const collationErrors = (
  scope: Scope,
  uri: string,
  code: string,
  offset: number,
): Errors => {
  return Option.exists(absoluteCollation(scope, uri), (absolute) =>
    isKnownCollation(scope, absolute),
  )
    ? none
    : [staticError(code, `the collation "${uri}" is not supported`, offset)];
};

// Direct element constructors ------------------------------------------------

/** The problem with one namespace declaration attribute, if any. */
const namespaceDeclProblem = (n: DirNamespace): Option.Option<readonly [string, string]> => {
  const prefix = Option.getOrUndefined(n.prefix);
  if (prefix === "xmlns" || (prefix === "xml" && n.uri !== Namespaces.xml))
    return Option.some(["XQST0070", `the prefix "${prefix}" can't be declared`]);
  if (prefix !== "xml" && (n.uri === Namespaces.xml || n.uri === Namespaces.xmlns))
    return Option.some(["XQST0070", `"${n.uri}" can't be bound to a prefix`]);
  return prefix !== undefined && n.uri === ""
    ? Option.some(["XQST0085", `the prefix "${prefix}" can't be undeclared`])
    : Option.none();
};

const namespaceDeclErrors = (namespaces: ReadonlyArray<DirNamespace>): Errors => {
  const prefixes = namespaces.map((n) => Option.getOrElse(n.prefix, () => ""));
  return namespaces.flatMap((n, i): Errors => {
    const problem =
      prefixes.indexOf(prefixes[i] ?? "") !== i
        ? Option.some([
            "XQST0071",
            `the namespace ${prefixes[i] || "default"} is declared twice`,
          ] as const)
        : namespaceDeclProblem(n);
    return Option.match(problem, {
      onNone: () => none,
      onSome: ([code, why]) => [staticError(code, why, n.offset)],
    });
  });
};

const elementScope = (scope: Scope, namespaces: ReadonlyArray<DirNamespace>): Scope =>
  Arr.reduce(namespaces, scope, (s, n) =>
    Option.match(n.prefix, {
      onNone: () => ({ ...s, defaultElementNamespace: n.uri }),
      onSome: (p) => ({ ...s, namespaces: HashMap.set(s.namespaces, p, n.uri) }),
    }),
  );

const attributeErrors = (scope: Scope, attributes: ReadonlyArray<DirAttribute>): Errors => [
  ...attributes.flatMap((a) => [...nameErrors(scope, a.name, "attribute"), ...all(scope, a.value)]),
  ...Option.match(
    duplicate(
      scope,
      attributes.map((a) => a.name),
      "attribute",
    ),
    {
      onNone: () => none,
      onSome: (n) => [staticError("XQST0040", `the attribute ${show(n)} is given twice`, n.offset)],
    },
  ),
];

const dirElement = (scope: Scope, el: Extract<Expr, { readonly _tag: "DirElement" }>): Errors => {
  const inner = elementScope(scope, el.namespaces);
  return [
    ...namespaceDeclErrors(el.namespaces),
    ...nameErrors(inner, el.name, "element"),
    ...attributeErrors(inner, el.attributes),
    ...all(inner, el.content),
  ];
};
