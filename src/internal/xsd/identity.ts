/**
 * Identity constraints (`xs:unique`, `xs:key`, `xs:keyref`), evaluated over
 * the subtree of the element that declares them once it is complete.
 *
 * Selectors and fields are compiled with `Xml.XPath` (a
 * selector's `|` alternatives one by one). Field values are compared as typed
 * values in their value spaces (XSD 1.0 §3.11.4), through the simple type the
 * validator checked the selected attribute or element against; a node with no
 * simple type (one a wildcard matched, or a nilled element) is compared by its
 * whitespace-collapsed string. The key tables an element computes travel up
 * to its ancestors, so a `keyref` can refer to a key declared on the same
 * element or a descendant of it.
 */
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import type { XmlElement } from "../../Xml/Node.ts";
import { compile, select, type Path, type XPathNode } from "../../Xml/XPath.ts";
import type { IdentityConstraint } from "../../Xsd/Model.ts";
import { identityKey, normalize, type SimpleChecker, type ValueContext } from "./datatypes.ts";

/** The simple type a node was validated against, with the namespaces in scope there. */
export interface Typed {
  readonly checker: SimpleChecker;
  readonly context: ValueContext;
}

/** Finds the simple type of a selected attribute or element, if it has one. */
export type TypeOf = (node: XPathNode) => Option.Option<Typed>;

/** One field's value: its identity in the value space, and how to show it. */
interface FieldValue {
  readonly key: string;
  readonly shown: string;
}

/** The key sequences found so far, by constraint name. */
/**
 * Key tables by constraint name. Each array belongs to its table alone: a
 * closing element's arrays are appended to (or moved into) its parent's.
 */
export type Tables = MutableHashMap.MutableHashMap<string, Array<string>>;

interface Compiled {
  readonly constraint: IdentityConstraint;
  readonly selectors: ReadonlyArray<Path>;
  readonly fields: ReadonlyArray<Path>;
}

const cache = new WeakMap<IdentityConstraint, Result.Result<Compiled, string>>();

const compileOne = (
  expression: string,
  constraint: IdentityConstraint,
): Result.Result<Path, string> =>
  Result.mapError(
    compile(expression.trim(), { namespaces: constraint.namespaces }),
    (e) => `the XPath ${expression} of ${constraint.name} is not supported: ${e.message}`,
  );

const compiled = (constraint: IdentityConstraint): Result.Result<Compiled, string> => {
  const done = cache.get(constraint);
  if (done !== undefined) return done;
  const out = Result.map(
    Result.all([
      Result.all(Arr.map(constraint.selector.split("|"), (s) => compileOne(s, constraint))),
      Result.all(Arr.map(constraint.fields, (f) => compileOne(f, constraint))),
    ]),
    ([selectors, fields]) => ({ constraint, selectors, fields }),
  );
  cache.set(constraint, out);
  return out;
};

const valueOf = (node: XPathNode): string => {
  if ("value" in node) return node.value;
  if (P.isTagged(node, "XmlElement")) return node.textContent;
  return P.hasProperty(node, "data") && P.isString(node.data) ? node.data : "";
};

const fieldValue = (node: XPathNode, typeOf: TypeOf): FieldValue => {
  const raw = valueOf(node);
  const shown = normalize(raw, "collapse");
  const typed = typeOf(node);
  const untyped = `anySimpleType:${shown}`;
  const key = Option.match(typed, {
    onNone: () => untyped,
    onSome: (t) => Result.getOrElse(identityKey(t.checker, raw, t.context), () => untyped),
  });
  return { key, shown };
};

/** The key sequence of one selected element: a value per field, `None` where a field is absent. */
const keyOf = (
  c: Compiled,
  element: XmlElement,
  typeOf: TypeOf,
): Result.Result<ReadonlyArray<Option.Option<FieldValue>>, string> =>
  Result.all(
    Arr.map(c.fields, (field) => {
      const nodes = select(field, element);
      const [first, ...more] = nodes;
      if (Arr.isReadonlyArrayNonEmpty(more))
        return Result.fail(
          `the field ${field.expression} of ${c.constraint.name} selects more than one node`,
        );
      return Result.succeed(Option.map(Option.fromNullishOr(first), (n) => fieldValue(n, typeOf)));
    }),
  );

const ok: Result.Result<void, string> = Result.void;

const encode = (values: ReadonlyArray<FieldValue>): string =>
  Arr.map(values, (v) => v.key).join("\u0000");

const show = (values: ReadonlyArray<FieldValue>): string =>
  Arr.map(values, (v) => v.shown).join(", ");

const selected = (c: Compiled, scope: XmlElement): ReadonlyArray<XmlElement> =>
  Arr.flatMap(c.selectors, (s) =>
    Arr.filter(select(s, scope), (n): n is XmlElement => P.isTagged(n, "XmlElement")),
  );

/**
 * Each element `c` selects in `scope`, in order: `complete` with its field
 * values, or `missing` when a field selects nothing. Stops at the first failure.
 */
const eachKey = (
  c: Compiled,
  scope: XmlElement,
  typeOf: TypeOf,
  missing: () => Result.Result<void, string>,
  complete: (values: ReadonlyArray<FieldValue>) => Result.Result<void, string>,
): Result.Result<void, string> =>
  Arr.reduce(selected(c, scope), ok, (acc, element) =>
    Result.flatMap(acc, () =>
      Result.flatMap(keyOf(c, element, typeOf), (key) => {
        const values = Arr.getSomes(key);
        return values.length < key.length ? missing() : complete(values);
      }),
    ),
  );

/**
 * The table of a key or unique constraint over `scope`, or why it is violated.
 * Built in place, with a set for the uniqueness check: one step per selected
 * element, not a copy of the table so far (#130).
 */
const table = (
  c: Compiled,
  scope: XmlElement,
  typeOf: TypeOf,
): Result.Result<Array<string>, string> => {
  const rows: Array<string> = [];
  const seen = MutableHashSet.empty<string>();
  const filled = eachKey(
    c,
    scope,
    typeOf,
    () =>
      P.isTagged(c.constraint, "Key")
        ? Result.fail(`a field of the key ${c.constraint.name} is missing`)
        : ok,
    (values) => {
      const encoded = encode(values);
      if (MutableHashSet.has(seen, encoded))
        return Result.fail(`the value ${show(values)} is not unique for ${c.constraint.name}`);
      MutableHashSet.add(seen, encoded);
      rows.push(encoded);
      return ok;
    },
  );
  return Result.map(filled, () => rows);
};

const checkReferences = (
  c: Compiled,
  scope: XmlElement,
  tables: Tables,
  typeOf: TypeOf,
): Result.Result<void, string> => {
  const refer = c.constraint.refer ?? "";
  const known = MutableHashSet.fromIterable(
    Option.getOrElse(MutableHashMap.get(tables, refer), (): ReadonlyArray<string> => []),
  );
  return eachKey(
    c,
    scope,
    typeOf,
    () => ok,
    (values) =>
      MutableHashSet.has(known, encode(values))
        ? ok
        : Result.fail(`the value ${show(values)} of ${c.constraint.name} refers to no ${refer}`),
  );
};

/**
 * Evaluate an element's constraints over its subtree. `tables` holds the
 * tables its descendants computed; the element's own are added to it.
 * `typeOf` gives the simple type of a selected node, so fields compare as
 * typed values.
 */
export const evaluateConstraints = (
  constraints: ReadonlyArray<IdentityConstraint>,
  scope: XmlElement,
  tables: Tables,
  typeOf: TypeOf,
): Result.Result<void, string> =>
  Result.flatMap(Result.all(Arr.map(constraints, compiled)), (all) => {
    const refs = Arr.filter(all, (c) => P.isTagged(c.constraint, "KeyRef"));
    const keys = Arr.filter(all, (c) => !P.isTagged(c.constraint, "KeyRef"));
    return Result.flatMap(
      Arr.reduce(keys, ok, (acc, c) =>
        Result.flatMap(acc, () =>
          Result.map(table(c, scope, typeOf), (rows) => {
            MutableHashMap.set(tables, c.constraint.name, rows);
          }),
        ),
      ),
      () =>
        Arr.reduce(refs, ok, (acc, c) =>
          Result.flatMap(acc, () => checkReferences(c, scope, tables, typeOf)),
        ),
    );
  });
