/**
 * How a built-in function is defined: its name, its signature as written in
 * F&O 3.1 (parsed once, when the registry is first used), and its
 * implementation. A library of built-ins is an array of these; the registry
 * (`registry.ts`) indexes every library by expanded name and arity.
 *
 * An implementation receives its arguments already converted by the
 * function conversion rules to the declared parameter types, and the call's
 * context (the focus, for a function that reads it; the static context, for
 * one that resolves names or URIs). It raises, as all evaluation code does.
 */
import type * as HashMap from "effect/HashMap";
import type * as Option from "effect/Option";
import type { QName } from "../../../../Name.ts";
import type { FunctionItem, Sequence } from "../../item.ts";
import type { Ctx } from "../runtime.ts";

/** The parts of the static context a built-in can use. */
export interface Statics {
  /** Resolves an in-scope namespace prefix (`""` for the default element namespace). */
  readonly namespace: (prefix: string) => string | undefined;
  readonly baseUri: Option.Option<string>;
  /** The default collation's URI. */
  readonly defaultCollation: string;
  /** The statically known decimal formats' properties, by Clark name (`""` for the unnamed one). */
  readonly decimalFormats: HashMap.HashMap<string, Readonly<Record<string, string>>>;
  /**
   * The function a name and arity denote in the static context, as a
   * function item made in `ctx` (`fn:function-lookup`); `None` when there is
   * none.
   */
  readonly lookup?:
    | ((name: QName, arity: number, ctx: Ctx, offset: number) => Option.Option<FunctionItem>)
    | undefined;
}

/** What a built-in is called with besides its arguments. */
export interface Call {
  /** The dynamic context and, for a focus-dependent function, the focus. */
  readonly ctx: Ctx;
  /** Where the call is in the query, for errors. */
  readonly offset: number;
  readonly statics: Statics;
}

/** A built-in function, one arity of it. */
export interface BuiltinSpec {
  /** The name with its standard prefix: `fn:count`, `map:get`, `math:pi`, `array:size`. */
  readonly name: string;
  /** The parameter types, as F&O writes them (`item()*`, `xs:string?`). */
  readonly params: ReadonlyArray<string>;
  /** The result type. */
  readonly result: string;
  /** The last parameter repeats (`fn:concat`): any arity from `params.length` up is accepted. */
  readonly variadic?: boolean | undefined;
  /**
   * The function reads the focus (`fn:position`, the zero-argument forms):
   * a reference to it (`fn:position#0`) captures the focus it was made in.
   */
  readonly focus?: boolean | undefined;
  readonly impl: (args: ReadonlyArray<Sequence>, call: Call) => Sequence;
}
