/**
 * A model ready to validate with: every type compiled on first use (simple
 * types into checkers, complex types into attribute tables, an automaton and a
 * layout) and kept.
 */
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { XsdSchemaError } from "../../Xsd/Error.ts";
import type {
  AttributeUse,
  ComplexType,
  ElementDeclaration,
  Model,
  SimpleType,
  Wildcard,
} from "../../Xsd/Model.ts";
import { Automaton } from "./content.ts";
import {
  allows,
  anySimpleType,
  anyType,
  layoutOf,
  substitutionsOf,
  typeOf,
  type AttributeSlot,
  type Layout,
} from "./components.ts";
import {
  builtinChecker,
  decode,
  listOf,
  restrict,
  unionOf,
  type SimpleChecker,
  type SimpleValue,
} from "./datatypes.ts";

type R<A> = Result.Result<A, XsdSchemaError>;

const schemaError = (reason: string) => new XsdSchemaError({ reason, location: null });

/** An attribute a complex type declares, ready to check. */
export interface AttributeRule {
  readonly use: AttributeUse;
  readonly checker: SimpleChecker;
  readonly slot: AttributeSlot;
  /** The fixed value, decoded. */
  readonly fixed: Option.Option<SimpleValue>;
}

/** A compiled complex type. */
export interface ComplexRuntime {
  readonly _tag: "Complex";
  readonly key: string;
  readonly def: ComplexType;
  readonly automaton: Option.Option<Automaton>;
  readonly simple: Option.Option<SimpleChecker>;
  readonly attributes: Readonly<Record<string, AttributeRule>>;
  /** The attributes that must be present or are filled in when absent. */
  readonly implied: ReadonlyArray<AttributeRule>;
  readonly wildcard: Option.Option<Wildcard>;
  readonly layout: Layout;
}

/** A compiled simple type, as the type of an element. */
export interface SimpleRuntime {
  readonly _tag: "Simple";
  readonly key: string;
  readonly checker: SimpleChecker;
}

export type TypeRuntime = ComplexRuntime | SimpleRuntime;

/** No prefixes are bound when decoding a default or fixed value given in the schema. */
const schemaContext = { resolve: () => undefined };

export class Runtime {
  readonly model: Model;
  readonly substitutes: (head: string) => ReadonlyArray<readonly [string, string]>;
  private readonly checkers = MutableHashMap.empty<string, R<SimpleChecker>>();
  private readonly runtimes = MutableHashMap.empty<string, R<TypeRuntime>>();
  private readonly inProgress = MutableHashSet.empty<string>();

  constructor(model: Model) {
    this.model = model;
    this.substitutes = substitutionsOf(model);
  }

  element(key: string): Option.Option<ElementDeclaration> {
    return Record.get(this.model.elements, key);
  }

  /** The checker for a simple type, compiled on first use. */
  checker(key: string): R<SimpleChecker> {
    return Option.getOrElse(MutableHashMap.get(this.checkers, key), () => {
      if (MutableHashSet.has(this.inProgress, key))
        return Result.fail(schemaError(`the simple type ${key} is defined in terms of itself`));
      MutableHashSet.add(this.inProgress, key);
      const out = this.buildChecker(key);
      MutableHashSet.remove(this.inProgress, key);
      MutableHashMap.set(this.checkers, key, out);
      return out;
    });
  }

  private buildChecker(key: string): R<SimpleChecker> {
    return Option.match(builtinChecker(key), {
      onSome: Result.succeed,
      onNone: () =>
        Option.match(Record.get(this.model.types, key), {
          onNone: () => Result.fail(schemaError(`no simple type named ${key} is defined`)),
          onSome: (def) =>
            Predicate.isTagged(def, "SimpleType")
              ? this.buildSimple(def)
              : Result.fail(
                  schemaError(`${key} is a complex type where a simple type is required`),
                ),
        }),
    });
  }

  private buildSimple(def: SimpleType): R<SimpleChecker> {
    const own = (checker: SimpleChecker): R<SimpleChecker> =>
      def.facets === undefined
        ? Result.succeed(checker)
        : Result.mapError(restrict(checker, def.facets), (reason) =>
            schemaError(`in the simple type ${def.name}: ${reason}`),
          );
    if (def.variety === "list" && def.itemType !== undefined)
      return Result.flatMap(this.checker(def.itemType), (item) => own(listOf(item)));
    if (def.variety === "union" && def.memberTypes !== undefined)
      return Result.flatMap(
        Result.all(Arr.map(def.memberTypes, (m) => this.checker(m))),
        (members) => own(unionOf(members)),
      );
    return Result.flatMap(this.checker(def.base === anyType ? anySimpleType : def.base), own);
  }

  /** The compiled form of a type, on first use. */
  type(key: string): R<TypeRuntime> {
    return Option.getOrElse(MutableHashMap.get(this.runtimes, key), () => {
      const out: R<TypeRuntime> = Option.match(typeOf(this.model, key), {
        onNone: () =>
          Result.map(this.checker(key), (checker): TypeRuntime => ({
            _tag: "Simple",
            key,
            checker,
          })),
        onSome: (def) =>
          Predicate.isTagged(def, "SimpleType")
            ? Result.map(this.checker(key), (checker): TypeRuntime => ({
                _tag: "Simple",
                key,
                checker,
              }))
            : this.complex(key, def),
      });
      MutableHashMap.set(this.runtimes, key, out);
      return out;
    });
  }

  private attributeRule(use: AttributeUse, slot: AttributeSlot): R<AttributeRule> {
    return Result.flatMap(this.checker(use.type), (checker) => {
      if (use.fixed === undefined)
        return Result.succeed({ use, checker, slot, fixed: Option.none() });
      return Result.match(decode(checker, use.fixed, schemaContext), {
        onFailure: (reason) =>
          Result.fail(
            schemaError(`the fixed value of the attribute ${use.name} is invalid: ${reason}`),
          ),
        onSuccess: (fixed) => Result.succeed({ use, checker, slot, fixed: Option.some(fixed) }),
      });
    });
  }

  private complex(key: string, def: ComplexType): R<TypeRuntime> {
    const layout = layoutOf(this.substitutes, def);
    const content = def.content;
    const simple: R<Option.Option<SimpleChecker>> = Predicate.isTagged(content, "Simple")
      ? Result.map(this.checker(content.type), Option.some)
      : Result.succeed(Option.none());
    const rules = Result.all(
      Arr.map(Arr.zip(def.attributes, layout.attributes), ([use, slot]) =>
        this.attributeRule(use, slot),
      ),
    );
    return Result.map(Result.all([simple, rules]), ([checker, attributeRules]): TypeRuntime => ({
      _tag: "Complex",
      key,
      def,
      automaton: Predicate.isTagged(content, "Elements")
        ? Option.some(
            new Automaton(content.particle, this.substitutes, allows, (element) =>
              Option.match(this.element(element), { onNone: () => element, onSome: (d) => d.name }),
            ),
          )
        : Option.none(),
      simple: checker,
      attributes: Record.fromEntries(Arr.map(attributeRules, (r) => [r.use.name, r] as const)),
      implied: Arr.filter(
        attributeRules,
        (r) => r.use.required === true || r.use.default !== undefined || r.use.fixed !== undefined,
      ),
      wildcard: Option.fromNullishOr(def.anyAttribute),
      layout,
    }));
  }
}
