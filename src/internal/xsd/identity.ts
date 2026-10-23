/**
 * Identity constraints (`xs:unique`, `xs:key`, `xs:keyref`), evaluated over
 * the subtree of the element that declares them once it is complete.
 *
 * Selectors and fields are compiled with the library's XPath subset (a
 * selector's `|` alternatives one by one). Field values are compared as their
 * whitespace-collapsed strings. The key tables an element computes travel up
 * to its ancestors, so a `keyref` can refer to a key declared on the same
 * element or a descendant of it.
 */
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { XmlAttribute, XmlElement } from "../../Xml/Node.ts";
import { compile, select, type Path, type XPathNode } from "../../Xml/XPath.ts";
import type { IdentityConstraint } from "../../Xsd/Model.ts";
import { normalize } from "./datatypes.ts";

/** The key sequences found so far, by constraint name. */
export type Tables = MutableHashMap.MutableHashMap<string, ReadonlyArray<string>>;

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

const valueOf = (node: XPathNode): string =>
  node instanceof XmlAttribute
    ? node.value
    : node instanceof XmlElement
      ? node.textContent
      : Predicate.hasProperty(node, "data") && Predicate.isString(node.data)
        ? node.data
        : "";

/** The key sequence of one selected element: a value per field, `None` where a field is absent. */
const keyOf = (
  c: Compiled,
  element: XmlElement,
): Result.Result<ReadonlyArray<Option.Option<string>>, string> =>
  Result.all(
    Arr.map(c.fields, (field) => {
      const nodes = select(field, element);
      const [first, ...more] = nodes;
      if (Arr.isReadonlyArrayNonEmpty(more))
        return Result.fail(
          `the field ${field.expression} of ${c.constraint.name} selects more than one node`,
        );
      return Result.succeed(
        Option.map(Option.fromNullishOr(first), (n) => normalize(valueOf(n), "collapse")),
      );
    }),
  );

const ok: Result.Result<void, string> = Result.void;
const noRows: Result.Result<ReadonlyArray<string>, string> = Result.succeed([]);

const encode = (values: ReadonlyArray<string>): string => values.join("\u0000");

const selected = (c: Compiled, scope: XmlElement): ReadonlyArray<XmlElement> =>
  Arr.flatMap(c.selectors, (s) =>
    Arr.filter(select(s, scope), (n): n is XmlElement => n instanceof XmlElement),
  );

/** The table of a key or unique constraint over `scope`, or why it is violated. */
const table = (c: Compiled, scope: XmlElement): Result.Result<ReadonlyArray<string>, string> =>
  Arr.reduce(selected(c, scope), noRows, (acc, element) =>
    Result.flatMap(acc, (rows) =>
      Result.flatMap(keyOf(c, element), (key) => {
        const values = Arr.getSomes(key);
        if (values.length < key.length) {
          return Predicate.isTagged(c.constraint, "Key")
            ? Result.fail(`a field of the key ${c.constraint.name} is missing`)
            : Result.succeed(rows);
        }
        const encoded = encode(values);
        return rows.includes(encoded)
          ? Result.fail(`the value ${values.join(", ")} is not unique for ${c.constraint.name}`)
          : Result.succeed([...rows, encoded]);
      }),
    ),
  );

const checkReferences = (
  c: Compiled,
  scope: XmlElement,
  tables: Tables,
): Result.Result<void, string> => {
  const refer = c.constraint.refer ?? "";
  const known = Option.getOrElse(
    MutableHashMap.get(tables, refer),
    (): ReadonlyArray<string> => [],
  );
  return Arr.reduce(selected(c, scope), ok, (acc, element) =>
    Result.flatMap(acc, () =>
      Result.flatMap(keyOf(c, element), (key) => {
        const values = Arr.getSomes(key);
        if (values.length < key.length) return ok;
        return known.includes(encode(values))
          ? ok
          : Result.fail(
              `the value ${values.join(", ")} of ${c.constraint.name} refers to no ${refer}`,
            );
      }),
    ),
  );
};

/**
 * Evaluate an element's constraints over its subtree. `tables` holds the
 * tables its descendants computed; the element's own are added to it.
 */
export const evaluate = (
  constraints: ReadonlyArray<IdentityConstraint>,
  scope: XmlElement,
  tables: Tables,
): Result.Result<void, string> =>
  Result.flatMap(Result.all(Arr.map(constraints, compiled)), (all) => {
    const refs = Arr.filter(all, (c) => Predicate.isTagged(c.constraint, "KeyRef"));
    const keys = Arr.filter(all, (c) => !Predicate.isTagged(c.constraint, "KeyRef"));
    return Result.flatMap(
      Arr.reduce(keys, ok, (acc, c) =>
        Result.flatMap(acc, () =>
          Result.map(table(c, scope), (rows) => {
            MutableHashMap.set(tables, c.constraint.name, rows);
          }),
        ),
      ),
      () =>
        Arr.reduce(refs, ok, (acc, c) =>
          Result.flatMap(acc, () => checkReferences(c, scope, tables)),
        ),
    );
  });
