/**
 * The XQuery 3.1 / XPath 3.1 abstract syntax tree.
 *
 * One tree serves both languages: XPath 3.1 is the subset its grammar
 * accepts. Every expression carries the `offset` (in UTF-16 units) where it
 * starts in the query text, for error reporting. Names are kept as written
 * ({@link EQName}); the static analysis (`analyze.ts`) resolves them against
 * the static context.
 *
 * The tree stays close to the grammar of Appendix A, with these
 * simplifications:
 *
 * - a parenthesized expression is its contents, and `()` is an empty
 *   {@link Expr} `Sequence`;
 * - abbreviated steps are expanded: `..` is `parent::node()`, `@a` is
 *   `attribute::a`, and `//` between steps is a
 *   `descendant-or-self::node()` step;
 * - literal and enclosed content of direct constructors are lists of parts.
 */
import * as Data from "effect/Data";
import type * as Option from "effect/Option";

/**
 * A name as written: `local`, `prefix:local` or `Q{uri}local`.
 *
 * `uri` is `Some` only for the braced `Q{uri}local` form, `prefix` only for
 * the prefixed form.
 */
export interface EQName {
  readonly prefix: Option.Option<string>;
  readonly local: string;
  readonly uri: Option.Option<string>;
  readonly offset: number;
}

/** The axes of a step. */
export type Axis =
  | "child"
  | "descendant"
  | "attribute"
  | "self"
  | "descendant-or-self"
  | "following-sibling"
  | "following"
  | "namespace"
  | "parent"
  | "ancestor"
  | "preceding-sibling"
  | "preceding"
  | "ancestor-or-self";

/** The binary operators, by their spelling. */
export type BinaryOp =
  | "or"
  | "and"
  | "="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "is"
  | "<<"
  | ">>"
  | "||"
  | "to"
  | "+"
  | "-"
  | "*"
  | "div"
  | "idiv"
  | "mod"
  | "union"
  | "intersect"
  | "except"
  | "!";

/** `?`, `*`, `+`, or `""` for exactly one. */
export type Occurrence = "" | "?" | "*" | "+";

/** An annotation, `%name("literal", …)`, on a function or variable. */
export interface Annotation {
  readonly name: EQName;
  readonly values: ReadonlyArray<Expr>;
}

/**
 * A wildcard name test: `*`, `prefix:*`, `Q{uri}*` or `*:local`.
 *
 * `prefix` / `uri` are `Some` for the namespace-constrained forms, `local`
 * for `*:local`.
 */
export interface Wildcard {
  readonly prefix: Option.Option<string>;
  readonly uri: Option.Option<string>;
  readonly local: Option.Option<string>;
  readonly offset: number;
}

/** An item type. */
export type ItemType = Data.TaggedEnum<{
  /** `item()` */
  AnyItem: Record<never, never>;
  /** An atomic or union type name. */
  Atomic: { readonly name: EQName };
  /** `node()` */
  AnyKind: Record<never, never>;
  /** `document-node(…)` */
  Document: { readonly element: Option.Option<ItemType> };
  /** `element(name-or-*, type?)` */
  Element: {
    readonly name: Option.Option<EQName>;
    readonly type: Option.Option<EQName>;
    readonly nillable: boolean;
  };
  /** `attribute(name-or-*, type)` */
  Attribute: { readonly name: Option.Option<EQName>; readonly type: Option.Option<EQName> };
  /** `schema-element(name)` */
  SchemaElement: { readonly name: EQName };
  /** `schema-attribute(name)` */
  SchemaAttribute: { readonly name: EQName };
  /** `processing-instruction(target?)` */
  ProcessingInstruction: { readonly target: Option.Option<string> };
  /** `comment()` */
  Comment: Record<never, never>;
  /** `text()` */
  Text: Record<never, never>;
  /** `namespace-node()` */
  NamespaceNode: Record<never, never>;
  /** `function(*)` */
  AnyFunction: { readonly annotations: ReadonlyArray<Annotation> };
  /** `function(T, …) as R` */
  TypedFunction: {
    readonly annotations: ReadonlyArray<Annotation>;
    readonly parameters: ReadonlyArray<SequenceType>;
    readonly result: SequenceType;
  };
  /** `map(*)` */
  AnyMap: Record<never, never>;
  /** `map(K, V)` */
  TypedMap: { readonly key: EQName; readonly value: SequenceType };
  /** `array(*)` */
  AnyArray: Record<never, never>;
  /** `array(T)` */
  TypedArray: { readonly member: SequenceType };
}>;

/** Constructors and matchers for {@link ItemType}. */
export const ItemType = Data.taggedEnum<ItemType>();

/** A sequence type: `empty-sequence()`, or an item type with an occurrence indicator. */
export type SequenceType = Data.TaggedEnum<{
  EmptySequence: Record<never, never>;
  Items: { readonly item: ItemType; readonly occurrence: Occurrence };
}>;

/** Constructors and matchers for {@link SequenceType}. */
export const SequenceType = Data.taggedEnum<SequenceType>();

/** A single type, for `cast as` and `castable as`: an atomic type, optionally `?`. */
export interface SingleType {
  readonly name: EQName;
  readonly optional: boolean;
}

/** What a step tests nodes against: a name, a wildcard or a kind test. */
export type NodeTest = Data.TaggedEnum<{
  Name: { readonly name: EQName };
  Wildcard: { readonly wildcard: Wildcard };
  Kind: { readonly test: ItemType };
}>;

/** Constructors and matchers for {@link NodeTest}. */
export const NodeTest = Data.taggedEnum<NodeTest>();

/** What a lookup selects: `?name`, `?3`, `?(expr)` or `?*`. */
export type KeySpecifier = Data.TaggedEnum<{
  Name: { readonly name: string };
  Integer: { readonly value: string };
  Expr: { readonly expr: Expr };
  Wildcard: Record<never, never>;
}>;

/** Constructors and matchers for {@link KeySpecifier}. */
export const KeySpecifier = Data.taggedEnum<KeySpecifier>();

/** A function parameter: `$name as type`. */
export interface Param {
  readonly name: EQName;
  readonly type: Option.Option<SequenceType>;
}

/** A variable binding of `for`, `some` or `every`: `$x as T at $i in expr`. */
export interface ForBinding {
  readonly name: EQName;
  readonly type: Option.Option<SequenceType>;
  readonly allowingEmpty: boolean;
  readonly position: Option.Option<EQName>;
  readonly in: Expr;
}

/** A `let` binding: `$x as T := expr`. */
export interface LetBinding {
  readonly name: EQName;
  readonly type: Option.Option<SequenceType>;
  readonly value: Expr;
}

/** The variables of a window condition: `$s at $p previous $prev next $next`. */
export interface WindowVars {
  readonly current: Option.Option<EQName>;
  readonly position: Option.Option<EQName>;
  readonly previous: Option.Option<EQName>;
  readonly next: Option.Option<EQName>;
}

/** A window's start or end condition. */
export interface WindowCondition {
  readonly vars: WindowVars;
  readonly when: Expr;
}

/** A grouping key of `group by`: `$k as T := expr collation "…"`. */
export interface GroupingSpec {
  readonly name: EQName;
  readonly type: Option.Option<SequenceType>;
  readonly value: Option.Option<Expr>;
  readonly collation: Option.Option<string>;
}

/** A sort key of `order by`. */
export interface OrderSpec {
  readonly expr: Expr;
  readonly descending: boolean;
  readonly emptyGreatest: Option.Option<boolean>;
  readonly collation: Option.Option<string>;
}

/** A FLWOR clause. */
export type Clause = Data.TaggedEnum<{
  For: { readonly bindings: ReadonlyArray<ForBinding>; readonly offset: number };
  Let: { readonly bindings: ReadonlyArray<LetBinding>; readonly offset: number };
  Window: {
    readonly sliding: boolean;
    readonly name: EQName;
    readonly type: Option.Option<SequenceType>;
    readonly in: Expr;
    readonly start: WindowCondition;
    readonly end: Option.Option<WindowCondition>;
    readonly onlyEnd: boolean;
    readonly offset: number;
  };
  Where: { readonly condition: Expr; readonly offset: number };
  GroupBy: { readonly specs: ReadonlyArray<GroupingSpec>; readonly offset: number };
  OrderBy: {
    readonly stable: boolean;
    readonly specs: ReadonlyArray<OrderSpec>;
    readonly offset: number;
  };
  Count: { readonly name: EQName; readonly offset: number };
}>;

/** Constructors and matchers for {@link Clause}. */
export const Clause = Data.taggedEnum<Clause>();

/** A `switch` case: one or more operands and the result. */
export interface SwitchCase {
  readonly operands: ReadonlyArray<Expr>;
  readonly result: Expr;
}

/** A `typeswitch` case: an optional variable, the types and the result. */
export interface TypeswitchCase {
  readonly variable: Option.Option<EQName>;
  readonly types: ReadonlyArray<SequenceType>;
  readonly result: Expr;
}

/** A `catch` clause: the error name tests and the handler. */
export interface CatchClause {
  readonly tests: ReadonlyArray<NodeTest>;
  readonly body: Expr;
}

/** A pragma, `(# name contents #)`. */
export interface Pragma {
  readonly name: EQName;
  readonly contents: string;
}

/** An attribute of a direct element constructor; its value is literal text and enclosed expressions. */
export interface DirAttribute {
  readonly name: EQName;
  /** Literal text (`DirText`) and enclosed expressions. */
  readonly value: ReadonlyArray<Expr>;
  readonly offset: number;
}

/** A namespace declaration attribute of a direct element constructor (`xmlns` / `xmlns:p`). */
export interface DirNamespace {
  /** `None` for the default namespace, `xmlns="…"`. */
  readonly prefix: Option.Option<string>;
  readonly uri: string;
  readonly offset: number;
}

/** An entry of a map constructor. */
export interface MapEntry {
  readonly key: Expr;
  readonly value: Expr;
}

/** The name of a computed element or attribute constructor: written, or computed by an expression. */
export type ComputedName = Data.TaggedEnum<{
  Static: { readonly name: EQName };
  Dynamic: { readonly expr: Expr };
}>;

/** Constructors and matchers for {@link ComputedName}. */
export const ComputedName = Data.taggedEnum<ComputedName>();

/** The prefix or target of a computed namespace or PI constructor: written, or computed. */
export type ComputedNCName = Data.TaggedEnum<{
  Static: { readonly name: string };
  Dynamic: { readonly expr: Expr };
}>;

/** Constructors and matchers for {@link ComputedNCName}. */
export const ComputedNCName = Data.taggedEnum<ComputedNCName>();

/** An expression. */
export type Expr = Data.TaggedEnum<{
  /** An integer literal, as written. */
  IntegerLiteral: { readonly value: string; readonly offset: number };
  /** A decimal literal, as written. */
  DecimalLiteral: { readonly value: string; readonly offset: number };
  /** A double literal, as written. */
  DoubleLiteral: { readonly value: string; readonly offset: number };
  /** A string literal, with references and doubled delimiters decoded. */
  StringLiteral: { readonly value: string; readonly offset: number };
  /** `$name` */
  VarRef: { readonly name: EQName; readonly offset: number };
  /** `.` */
  ContextItem: { readonly offset: number };
  /** `a, b, …`, or `()` when empty. */
  Sequence: { readonly items: ReadonlyArray<Expr>; readonly offset: number };
  /** `?`, an argument placeholder of a partial function application. */
  Placeholder: { readonly offset: number };
  /** `name(args)` */
  FunctionCall: {
    readonly name: EQName;
    readonly args: ReadonlyArray<Expr>;
    readonly offset: number;
  };
  /** `name#arity` */
  NamedFunctionRef: { readonly name: EQName; readonly arity: number; readonly offset: number };
  /** `function ($a as T) as R { body }` */
  InlineFunction: {
    readonly annotations: ReadonlyArray<Annotation>;
    readonly params: ReadonlyArray<Param>;
    readonly returnType: Option.Option<SequenceType>;
    readonly body: Expr;
    readonly offset: number;
  };
  /** `expr(args)` */
  DynamicCall: {
    readonly function: Expr;
    readonly args: ReadonlyArray<Expr>;
    readonly offset: number;
  };
  /** `expr[predicate]` */
  Filter: { readonly base: Expr; readonly predicate: Expr; readonly offset: number };
  /** `expr?key` */
  Lookup: { readonly base: Expr; readonly key: KeySpecifier; readonly offset: number };
  /** `?key`, a lookup on the context item. */
  UnaryLookup: { readonly key: KeySpecifier; readonly offset: number };
  /** `map { k: v, … }` */
  Map: { readonly entries: ReadonlyArray<MapEntry>; readonly offset: number };
  /** `[a, b, …]` */
  SquareArray: { readonly members: ReadonlyArray<Expr>; readonly offset: number };
  /** `array { expr }` */
  CurlyArray: { readonly body: Expr; readonly offset: number };
  /** A path: steps separated by `/`, from the root (`/`), from its descendants (`//`), or relative. */
  Path: {
    readonly root: "relative" | "root" | "descendants";
    readonly steps: ReadonlyArray<Expr>;
    readonly offset: number;
  };
  /** An axis step: `axis::test[predicate]…` */
  AxisStep: {
    readonly axis: Axis;
    readonly test: NodeTest;
    readonly predicates: ReadonlyArray<Expr>;
    readonly offset: number;
  };
  /** A binary operator. */
  Binary: {
    readonly op: BinaryOp;
    readonly left: Expr;
    readonly right: Expr;
    readonly offset: number;
  };
  /** Unary `-` or `+`. */
  Unary: { readonly op: "+" | "-"; readonly operand: Expr; readonly offset: number };
  /** `expr instance of type` */
  InstanceOf: { readonly expr: Expr; readonly type: SequenceType; readonly offset: number };
  /** `expr treat as type` */
  TreatAs: { readonly expr: Expr; readonly type: SequenceType; readonly offset: number };
  /** `expr castable as type` */
  CastableAs: { readonly expr: Expr; readonly type: SingleType; readonly offset: number };
  /** `expr cast as type` */
  CastAs: { readonly expr: Expr; readonly type: SingleType; readonly offset: number };
  /** `expr => name(args)` */
  ArrowCall: {
    readonly base: Expr;
    readonly name: EQName;
    readonly args: ReadonlyArray<Expr>;
    readonly offset: number;
  };
  /** `expr => $f(args)` or `expr => (f)(args)` */
  ArrowDynamic: {
    readonly base: Expr;
    readonly function: Expr;
    readonly args: ReadonlyArray<Expr>;
    readonly offset: number;
  };
  /** `if (c) then a else b` */
  If: {
    readonly condition: Expr;
    readonly thenBranch: Expr;
    readonly elseBranch: Expr;
    readonly offset: number;
  };
  /** `some` / `every $x in … satisfies …` */
  Quantified: {
    readonly every: boolean;
    readonly bindings: ReadonlyArray<ForBinding>;
    readonly satisfies: Expr;
    readonly offset: number;
  };
  /** A FLWOR expression (also XPath's `for` and `let`). */
  Flwor: {
    readonly clauses: ReadonlyArray<Clause>;
    readonly return: Expr;
    readonly offset: number;
  };
  /** `switch (operand) case … default return …` */
  Switch: {
    readonly operand: Expr;
    readonly cases: ReadonlyArray<SwitchCase>;
    readonly default: Expr;
    readonly offset: number;
  };
  /** `typeswitch (operand) case … default $v return …` */
  Typeswitch: {
    readonly operand: Expr;
    readonly cases: ReadonlyArray<TypeswitchCase>;
    readonly defaultVariable: Option.Option<EQName>;
    readonly default: Expr;
    readonly offset: number;
  };
  /** `try { … } catch … { … }` */
  TryCatch: {
    readonly body: Expr;
    readonly catches: ReadonlyArray<CatchClause>;
    readonly offset: number;
  };
  /** `validate lax|strict|type T { … }` */
  Validate: {
    readonly mode: Option.Option<"lax" | "strict">;
    readonly type: Option.Option<EQName>;
    readonly body: Expr;
    readonly offset: number;
  };
  /** `(# pragma #)… { … }`; the body is `None` when it is empty. */
  Extension: {
    readonly pragmas: ReadonlyArray<Pragma>;
    readonly body: Option.Option<Expr>;
    readonly offset: number;
  };
  /** `ordered { … }` / `unordered { … }` */
  Ordering: { readonly ordered: boolean; readonly body: Expr; readonly offset: number };
  /** A direct element constructor. */
  DirElement: {
    readonly name: EQName;
    readonly attributes: ReadonlyArray<DirAttribute>;
    readonly namespaces: ReadonlyArray<DirNamespace>;
    readonly content: ReadonlyArray<Expr>;
    readonly offset: number;
  };
  /**
   * Literal character content of a direct element constructor. `boundary`
   * marks boundary whitespace: whitespace written as such (no references or
   * CDATA), between tags and enclosed expressions.
   */
  DirText: { readonly value: string; readonly boundary: boolean; readonly offset: number };
  /** `<!-- … -->` */
  DirComment: { readonly value: string; readonly offset: number };
  /** `<?target … ?>` */
  DirPI: { readonly target: string; readonly value: string; readonly offset: number };
  /** `document { … }` */
  CompDocument: { readonly body: Expr; readonly offset: number };
  /** `element name { … }` or `element { name-expr } { … }` */
  CompElement: {
    readonly name: ComputedName;
    readonly body: Expr;
    readonly offset: number;
  };
  /** `attribute name { … }` or `attribute { name-expr } { … }` */
  CompAttribute: {
    readonly name: ComputedName;
    readonly body: Expr;
    readonly offset: number;
  };
  /** `namespace prefix { uri }` or `namespace { prefix-expr } { uri }` */
  CompNamespace: {
    readonly prefix: ComputedNCName;
    readonly uri: Expr;
    readonly offset: number;
  };
  /** `text { … }` */
  CompText: { readonly body: Expr; readonly offset: number };
  /** `comment { … }` */
  CompComment: { readonly body: Expr; readonly offset: number };
  /** `processing-instruction target { … }` or `processing-instruction { target-expr } { … }` */
  CompPI: {
    readonly target: ComputedNCName;
    readonly body: Expr;
    readonly offset: number;
  };
  /** ``` ``[ … `{ expr }` … ]`` ``` */
  StringConstructor: {
    /** Literal text (`StringLiteral`) and interpolations. */
    readonly parts: ReadonlyArray<Expr>;
    readonly offset: number;
  };
}>;

/** Constructors and matchers for {@link Expr}. */
export const Expr = Data.taggedEnum<Expr>();

/** A prolog declaration. */
export type Decl = Data.TaggedEnum<{
  DefaultNamespace: {
    readonly kind: "element" | "function";
    readonly uri: string;
    readonly offset: number;
  };
  BoundarySpace: { readonly preserve: boolean; readonly offset: number };
  DefaultCollation: { readonly uri: string; readonly offset: number };
  BaseURI: { readonly uri: string; readonly offset: number };
  Construction: { readonly preserve: boolean; readonly offset: number };
  OrderingMode: { readonly ordered: boolean; readonly offset: number };
  EmptyOrder: { readonly greatest: boolean; readonly offset: number };
  CopyNamespaces: {
    readonly preserve: boolean;
    readonly inherit: boolean;
    readonly offset: number;
  };
  DecimalFormat: {
    /** `None` for `declare default decimal-format`. */
    readonly name: Option.Option<EQName>;
    readonly properties: ReadonlyArray<readonly [string, string]>;
    readonly offset: number;
  };
  Namespace: { readonly prefix: string; readonly uri: string; readonly offset: number };
  SchemaImport: {
    readonly prefix: Option.Option<string>;
    readonly defaultElement: boolean;
    readonly uri: string;
    readonly at: ReadonlyArray<string>;
    readonly offset: number;
  };
  ModuleImport: {
    readonly prefix: Option.Option<string>;
    readonly uri: string;
    readonly at: ReadonlyArray<string>;
    readonly offset: number;
  };
  ContextItem: {
    readonly type: Option.Option<ItemType>;
    readonly value: Option.Option<Expr>;
    readonly external: boolean;
    readonly offset: number;
  };
  Variable: {
    readonly annotations: ReadonlyArray<Annotation>;
    readonly name: EQName;
    readonly type: Option.Option<SequenceType>;
    readonly value: Option.Option<Expr>;
    readonly external: boolean;
    readonly offset: number;
  };
  Function: {
    readonly annotations: ReadonlyArray<Annotation>;
    readonly name: EQName;
    readonly params: ReadonlyArray<Param>;
    readonly returnType: Option.Option<SequenceType>;
    /** `None` for an `external` function. */
    readonly body: Option.Option<Expr>;
    readonly offset: number;
  };
  Option: { readonly name: EQName; readonly value: string; readonly offset: number };
}>;

/** Constructors and matchers for {@link Decl}. */
export const Decl = Data.taggedEnum<Decl>();

/** `xquery version "3.1" encoding "…";` */
export interface VersionDecl {
  readonly version: Option.Option<string>;
  readonly encoding: Option.Option<string>;
  readonly offset: number;
}

/** A parsed query: a main module (prolog and body) or a library module. */
export type Module = Data.TaggedEnum<{
  Main: {
    readonly version: Option.Option<VersionDecl>;
    readonly prolog: ReadonlyArray<Decl>;
    readonly body: Expr;
  };
  Library: {
    readonly version: Option.Option<VersionDecl>;
    readonly prefix: string;
    readonly uri: string;
    readonly prolog: ReadonlyArray<Decl>;
    readonly offset: number;
  };
}>;

/** Constructors and matchers for {@link Module}. */
export const Module = Data.taggedEnum<Module>();
