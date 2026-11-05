/**
 * The compiler's view of where it is in a query: the static scope names
 * resolve in, the variables in scope and where their values live, and the
 * query's global variables and declared functions.
 *
 * A local variable is a slot in a frame {@link Layout}. Each function body
 * (and the query body, and each global's initializer) has its own layout; a
 * variable from an enclosing function is reached by capturing it: the inner
 * layout gets a slot of its own, filled from the enclosing frame when the
 * function item is made ({@link slotIn}).
 */
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type { QName } from "../../../Name.ts";
import type { EQName } from "../parser/ast.ts";
import {
  resolveName,
  type ExpandedName,
  type NameKind,
  type Scope as StaticScope,
} from "../parser/analyze.ts";
import type { Statics } from "./functions/define.ts";
import { raise } from "./raise.ts";
import type { Code, SeqType, Signature } from "./runtime.ts";

/** How many layouts have been made: each one's id. */
let layouts = 0;

/** A binding as a map key: layouts are mutable, so they are told apart by id, not by value. */
const bindingKey = (binding: Binding): string => `${binding.layout.id}:${binding.slot}`;

/** A frame layout: how many slots, and which are filled from the enclosing frame. */
export class Layout {
  size = 0;
  readonly captures: Array<{ readonly from: number; readonly to: number }> = [];
  private captured: HashMap.HashMap<string, number> = HashMap.empty();
  /** Tells layouts apart, for {@link bindingKey}. */
  readonly id: number;
  readonly parent: Layout | undefined;

  constructor(parent: Layout | undefined) {
    layouts += 1;
    this.id = layouts;
    this.parent = parent;
  }

  /** The slot a captured binding has in this layout. */
  capturedSlot(binding: Binding): number | undefined {
    return Option.getOrUndefined(HashMap.get(this.captured, bindingKey(binding)));
  }

  /** Capture `binding` from the enclosing frame's slot `from` into a new slot. */
  capture(binding: Binding, from: number): number {
    const to = this.allocate();
    this.captures.push({ from, to });
    this.captured = HashMap.set(this.captured, bindingKey(binding), to);
    return to;
  }

  allocate(): number {
    const slot = this.size;
    this.size += 1;
    return slot;
  }
}

/** A local variable: the layout it was bound in and its slot there. */
export interface Binding {
  readonly layout: Layout;
  readonly slot: number;
}

/** What a variable name refers to. */
export type Var =
  | { readonly kind: "local"; readonly binding: Binding }
  | { readonly kind: "global"; readonly index: number };

/** The slot of `binding` in a frame of `layout`, capturing it through every function in between. */
export const slotIn = (layout: Layout, binding: Binding): number => {
  if (binding.layout === layout) return binding.slot;
  const known = layout.capturedSlot(binding);
  if (known !== undefined) return known;
  const parent = layout.parent;
  if (parent === undefined) return raise("XPST0008", "a variable is out of scope");
  return layout.capture(binding, slotIn(parent, binding));
};

/** A function declared in the prolog; its body is compiled after every signature is known, so declarations can call each other. */
export interface UserFunction {
  readonly name: QName;
  readonly signature: Signature;
  readonly layout: Layout;
  readonly slots: ReadonlyArray<number>;
  body: Code | undefined;
}

/**
 * A global variable: declared in the prolog, or given by the host. Its value
 * is computed the first time it is read: the host's value for an external
 * one, else its initializer, run in a frame of its own layout.
 */
export interface GlobalVar {
  readonly clark: string;
  readonly external: boolean;
  readonly type: SeqType | undefined;
  readonly layout: Layout;
  init: Code | undefined;
}

/** The query's globals and functions, shared by every scope of one compilation. */
export class Program {
  readonly globals: Array<GlobalVar> = [];
  private indices: HashMap.HashMap<string, number> = HashMap.empty();
  private declared: HashMap.HashMap<string, UserFunction> = HashMap.empty();

  /** The index of the global variable with this Clark name. */
  globalIndex(clark: string): number | undefined {
    return Option.getOrUndefined(HashMap.get(this.indices, clark));
  }

  /** Declare a global variable, replacing an earlier one of the same name (a prolog declaration of an external variable). */
  declareGlobal(g: GlobalVar): void {
    const existing = this.globalIndex(g.clark);
    if (existing !== undefined) {
      this.globals[existing] = g;
      return;
    }
    this.indices = HashMap.set(this.indices, g.clark, this.globals.length);
    this.globals.push(g);
  }

  /** The declared function with this Clark name and arity. */
  functionOf(clark: string, arity: number): UserFunction | undefined {
    return Option.getOrUndefined(HashMap.get(this.declared, `${clark}#${arity}`));
  }

  declareFunction(clark: string, f: UserFunction): void {
    this.declared = HashMap.set(this.declared, `${clark}#${f.slots.length}`, f);
  }
}

/** Where the compiler is: the static scope, the variables in scope, the current frame layout and the program. */
export interface Scope {
  readonly statics: StaticScope;
  readonly vars: HashMap.HashMap<string, Var>;
  readonly layout: Layout;
  readonly program: Program;
}

/** Resolve a name as written, failing with its static error. */
export const resolve = (scope: Scope, name: EQName, kind: NameKind): ExpandedName =>
  Result.match(resolveName(scope.statics, name, kind), {
    onSuccess: (n) => n,
    onFailure: (e) => raise(e.code, e.description, e.offset),
  });

/** A Clark name, `{uri}local`. */
export const clark = (n: ExpandedName): string => `{${n.uri}}${n.local}`;

/** `scope` with a new local variable bound in the current layout. */
export const bindLocal = (scope: Scope, name: EQName): readonly [scope: Scope, slot: number] => {
  const slot = scope.layout.allocate();
  const binding: Binding = { layout: scope.layout, slot };
  return [
    {
      ...scope,
      vars: HashMap.set(scope.vars, clark(resolve(scope, name, "variable")), {
        kind: "local",
        binding,
      }),
    },
    slot,
  ];
};

/** `scope` with a new local variable bound by expanded name. */
export const bindExpanded = (
  scope: Scope,
  name: ExpandedName,
): readonly [scope: Scope, slot: number] => {
  const slot = scope.layout.allocate();
  const binding: Binding = { layout: scope.layout, slot };
  return [
    { ...scope, vars: HashMap.set(scope.vars, clark(name), { kind: "local", binding }) },
    slot,
  ];
};

/** The parts of the static context built-in functions use, for `scope`. */
export const staticsOf = (scope: Scope): Statics => ({
  namespace: (prefix) =>
    prefix === ""
      ? scope.statics.defaultElementNamespace === ""
        ? undefined
        : scope.statics.defaultElementNamespace
      : Option.getOrUndefined(HashMap.get(scope.statics.namespaces, prefix)),
  baseUri: scope.statics.context.baseUri,
  defaultCollation: scope.statics.context.defaultCollation,
});
