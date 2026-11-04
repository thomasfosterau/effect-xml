/**
 * The statically known built-in functions and types: the names and arities
 * of XPath and XQuery Functions and Operators 3.1 (`fn:`, `math:`, `map:`,
 * `array:`), the constructor functions of the built-in atomic types, and
 * the built-in schema types (XML Schema Part 2 plus the XDM additions).
 *
 * Only what static analysis needs is here: whether a name and arity denote
 * a function (`XPST0017`) and whether a type name is defined (`XPST0051`).
 * The implementations belong to the evaluator.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";

/** The namespaces of the built-in functions and types. */
export const Namespaces = {
  fn: "http://www.w3.org/2005/xpath-functions",
  math: "http://www.w3.org/2005/xpath-functions/math",
  map: "http://www.w3.org/2005/xpath-functions/map",
  array: "http://www.w3.org/2005/xpath-functions/array",
  xs: "http://www.w3.org/2001/XMLSchema",
  xsi: "http://www.w3.org/2001/XMLSchema-instance",
  xml: "http://www.w3.org/XML/1998/namespace",
  xmlns: "http://www.w3.org/2000/xmlns/",
  err: "http://www.w3.org/2005/xqt-errors",
  local: "http://www.w3.org/2005/xquery-local-functions",
  output: "http://www.w3.org/2010/xslt-xquery-serialization",
} as const;

/** The arities a function name accepts: from `min` to `max` (`Infinity` for `fn:concat`). */
export interface Arity {
  readonly min: number;
  readonly max: number;
}

// Each entry is `name:arities`, with arities `n`, `n-m` or `n+` (n or more).
const fn = `
node-name:0-1 nilled:0-1 string:0-1 data:0-1 base-uri:0-1 document-uri:0-1 error:0-3 trace:1-2
abs:1 ceiling:1 floor:1 round:1-2 round-half-to-even:1-2 number:0-1 format-integer:2-3
format-number:2-3 random-number-generator:0-1 codepoints-to-string:1 string-to-codepoints:1
compare:2-3 codepoint-equal:2 concat:2+ string-join:1-2 substring:2-3 string-length:0-1
normalize-space:0-1 normalize-unicode:1-2 upper-case:1 lower-case:1 translate:3 contains:2-3
starts-with:2-3 ends-with:2-3 substring-before:2-3 substring-after:2-3 matches:2-3 replace:3-4
tokenize:1-3 analyze-string:2-3 contains-token:2-3 resolve-uri:1-2 encode-for-uri:1
iri-to-uri:1 escape-html-uri:1 true:0 false:0 boolean:1 not:1 years-from-duration:1
months-from-duration:1 days-from-duration:1 hours-from-duration:1 minutes-from-duration:1
seconds-from-duration:1 dateTime:2 year-from-dateTime:1 month-from-dateTime:1
day-from-dateTime:1 hours-from-dateTime:1 minutes-from-dateTime:1 seconds-from-dateTime:1
timezone-from-dateTime:1 year-from-date:1 month-from-date:1 day-from-date:1
timezone-from-date:1 hours-from-time:1 minutes-from-time:1 seconds-from-time:1
timezone-from-time:1 adjust-dateTime-to-timezone:1-2 adjust-date-to-timezone:1-2
adjust-time-to-timezone:1-2 format-dateTime:2,5 format-date:2,5 format-time:2,5
parse-ietf-date:1 resolve-QName:2 QName:2 prefix-from-QName:1 local-name-from-QName:1
namespace-uri-from-QName:1 namespace-uri-for-prefix:2 in-scope-prefixes:1 name:0-1
local-name:0-1 namespace-uri:0-1 lang:1-2 root:0-1 path:0-1 has-children:0-1 innermost:1
outermost:1 generate-id:0-1 empty:1 exists:1 head:1 tail:1 insert-before:3 remove:2 reverse:1
subsequence:2-3 unordered:1 distinct-values:1-2 index-of:2-3 deep-equal:2-3 zero-or-one:1
one-or-more:1 exactly-one:1 count:1 avg:1 max:1-2 min:1-2 sum:1-2 id:1-2 element-with-id:1-2
idref:1-2 doc:1 doc-available:1 collection:0-1 uri-collection:0-1 unparsed-text:1-2
unparsed-text-lines:1-2 unparsed-text-available:1-2 environment-variable:1
available-environment-variables:0 position:0 last:0 current-dateTime:0 current-date:0
current-time:0 implicit-timezone:0 default-collation:0 default-language:0 static-base-uri:0
function-lookup:2 function-name:1 function-arity:1 for-each:2 filter:2 fold-left:3
fold-right:3 for-each-pair:3 sort:1-3 apply:2 load-xquery-module:1-2 transform:1 parse-xml:1
parse-xml-fragment:1 serialize:1-2 parse-json:1-2 json-doc:1-2 json-to-xml:1-2 xml-to-json:1-2
collation-key:1-2
`;

const math = `
pi:0 exp:1 exp10:1 log:1 log10:1 pow:2 sqrt:1 sin:1 cos:1 tan:1 asin:1 acos:1 atan:1 atan2:2
`;

const map = `
merge:1-2 size:1 keys:1 contains:2 get:2 find:2 put:3 entry:2 remove:2 for-each:2
`;

const array = `
size:1 get:2 put:3 append:2 subarray:2-3 remove:2 insert-before:3 head:1 tail:1 reverse:1
join:1 for-each:2 filter:2 fold-left:3 fold-right:3 for-each-pair:3 sort:1-3 flatten:1
`;

/** The built-in atomic types (and `xs:numeric`, `xs:error`), each with a one-argument constructor function. */
const atomicTypes = `
anyAtomicType untypedAtomic string boolean decimal float double duration dateTime time date
gYearMonth gYear gMonthDay gDay gMonth hexBinary base64Binary anyURI QName NOTATION
normalizedString token language NMTOKEN Name NCName ID IDREF ENTITY integer
nonPositiveInteger negativeInteger long int short byte nonNegativeInteger unsignedLong
unsignedInt unsignedShort unsignedByte positiveInteger yearMonthDuration dayTimeDuration
dateTimeStamp numeric error
`;

/** The built-in list types: constructor functions and cast targets, but not item types. */
const listTypes = "NMTOKENS IDREFS ENTITIES";

/** The built-in non-atomic types. */
const otherTypes = "anyType untyped anySimpleType";

const words = (s: string): ReadonlyArray<string> => s.split(/\s+/).filter((w) => w !== "");

const parseArity = (spec: string): Arity => {
  if (spec.endsWith("+")) return { min: Number(spec.slice(0, -1)), max: Infinity };
  const [min = "0", max = min] = spec.split(/[-,]/);
  return { min: Number(min), max: Number(max) };
};

/** Arities given as `2,5` accept exactly those two; others are ranges. */
const arities = (spec: string): ReadonlyArray<Arity> =>
  spec.includes(",")
    ? spec.split(",").map((n) => ({ min: Number(n), max: Number(n) }))
    : [parseArity(spec)];

/** A Clark name, `{uri}local`: the key of the tables. */
export const clark = (uri: string, local: string): string => `{${uri}}${local}`;

const table = (
  uri: string,
  entries: string,
): ReadonlyArray<readonly [string, ReadonlyArray<Arity>]> =>
  words(entries).map((entry) => {
    const colon = entry.lastIndexOf(":");
    return [clark(uri, entry.slice(0, colon)), arities(entry.slice(colon + 1))] as const;
  });

interface Tables {
  readonly functions: HashMap.HashMap<string, ReadonlyArray<Arity>>;
  readonly atomic: HashSet.HashSet<string>;
  readonly lists: HashSet.HashSet<string>;
  readonly others: HashSet.HashSet<string>;
}

let tables: Tables | undefined;

const build = (): Tables => {
  const atomic = words(atomicTypes);
  const lists = words(listTypes);
  const constructors = [...atomic, ...lists]
    .filter((t) => t !== "anyAtomicType" && t !== "NOTATION")
    .map((t) => [clark(Namespaces.xs, t), [{ min: 1, max: 1 }]] as const);
  return {
    functions: HashMap.fromIterable([
      ...table(Namespaces.fn, fn),
      ...table(Namespaces.math, math),
      ...table(Namespaces.map, map),
      ...table(Namespaces.array, array),
      ...constructors,
    ]),
    atomic: HashSet.fromIterable(atomic),
    lists: HashSet.fromIterable(lists),
    others: HashSet.fromIterable(words(otherTypes)),
  };
};

const get = (): Tables => {
  tables ??= build();
  return tables;
};

/** The arities of the built-in function `{uri}local`, if there is one. */
export const builtinArities = (key: string): Option.Option<ReadonlyArray<Arity>> =>
  HashMap.get(get().functions, key);

/** Whether `n` arguments fit one of `arities`. */
export const accepts = (arityList: ReadonlyArray<Arity>, n: number): boolean =>
  Arr.some(arityList, (a) => n >= a.min && n <= a.max);

/** What a name in the `xs:` namespace denotes as a type. */
export type XsType = "atomic" | "list" | "other" | "unknown";

/** The kind of the built-in type `xs:local`. */
export const xsType = (local: string): XsType => {
  const t = get();
  return HashSet.has(t.atomic, local)
    ? "atomic"
    : HashSet.has(t.lists, local)
      ? "list"
      : HashSet.has(t.others, local)
        ? "other"
        : "unknown";
};
