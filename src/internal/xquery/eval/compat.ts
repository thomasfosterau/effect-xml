/**
 * XPath 1.0 compatibility mode (XPath 3.1 §2.1.1): the conversions that make
 * an XPath 1.0 expression evaluate as XPath 1.0 did.
 *
 * Only XPath has the mode (XQuery never does), and only `Xml.XPath` turns it
 * on. Besides the general comparisons (`compare.ts`), it changes:
 *
 * - arithmetic (§3.5): each operand is atomized, all but its first item
 *   dropped, and converted to an `xs:double` with `fn:number` (an empty
 *   operand is NaN), so `@a + 1` is a number whatever `@a` holds;
 * - static function calls (§3.1.5.2): an argument that doesn't match its
 *   parameter's type is cut to its first item when the parameter takes one,
 *   then converted with `fn:string` for an `xs:string` parameter and with
 *   `fn:number` for a numeric one, so `contains(//p, 'x')` reads the first
 *   `p` and `round('2.5')` is 3.
 */
import { AtomicValue } from "../atomic.ts";
import { atomize, stringValue, type Sequence } from "../item.ts";
import { AtomicTypes } from "../types.ts";
import { numberOf } from "./compare.ts";
import { unwrap } from "./raise.ts";
import type { SeqType } from "./runtime.ts";
import { sequenceMatches } from "./seqtype.ts";

const nan: Sequence = [/*#__PURE__*/ AtomicValue.double(Number.NaN)];

/** An arithmetic operand as XPath 1.0 takes it: its first atomized item as an `xs:double`, NaN when it has none. */
export const numericOperand = (operand: Sequence, offset?: number): Sequence => {
  const [first] = operand;
  if (first === undefined) return nan;
  const [atom] = unwrap(atomize([first]), offset);
  return atom === undefined ? nan : [numberOf(atom)];
};

/** `fn:string` of a sequence of at most one item. */
const stringOf = (value: Sequence, offset?: number): Sequence => {
  const [first] = value;
  return [AtomicValue.string(first === undefined ? "" : unwrap(stringValue(first), offset))];
};

/** Whether a parameter takes `xs:string` (or `xs:string?`), the type `fn:string` converts to. */
const takesString = (t: SeqType): boolean =>
  t.max === 1 && t.item?.kind === "atomic" && t.item.type === AtomicTypes.string;

/** Whether a parameter takes one number (`xs:double`, `xs:numeric`, optional or not), which `fn:number` converts to. */
const takesNumber = (t: SeqType): boolean =>
  t.max === 1 &&
  (t.item?.kind === "numeric" || (t.item?.kind === "atomic" && t.item.type === AtomicTypes.double));

/** An argument of a static function call, converted as XPath 1.0 compatibility mode does before the usual coercion. */
export const compatibleArgument = (t: SeqType, value: Sequence, offset?: number): Sequence => {
  if (sequenceMatches(t, value)) return value;
  const one = t.max === 1 && value.length > 1 ? value.slice(0, 1) : value;
  if (takesString(t)) return stringOf(one, offset);
  if (takesNumber(t)) return numericOperand(one, offset);
  return one;
};
