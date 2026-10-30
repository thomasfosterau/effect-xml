/**
 * The XDM 3.1 atomic type hierarchy.
 *
 * Every atomic value carries one of these types. The hierarchy is XML Schema's
 * built-in simple types (taken from `internal/xsd/datatypes.ts`, which also
 * checks their lexical forms) re-rooted at `xs:anyAtomicType`, plus the types
 * XDM adds: `xs:untypedAtomic`, `xs:yearMonthDuration`, `xs:dayTimeDuration`
 * and `xs:dateTimeStamp`.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { builtin, XS } from "../../Xsd/Model.ts";
import { builtinBase } from "../xsd/datatypes.ts";

/**
 * The local name of a built-in atomic type in the `xs:` namespace.
 *
 * @since 0.3.0
 * @category types
 */
export type AtomicTypeName =
  | "anyAtomicType"
  | "untypedAtomic"
  | "string"
  | "normalizedString"
  | "token"
  | "language"
  | "NMTOKEN"
  | "Name"
  | "NCName"
  | "ID"
  | "IDREF"
  | "ENTITY"
  | "anyURI"
  | "QName"
  | "NOTATION"
  | "boolean"
  | "decimal"
  | "integer"
  | "nonPositiveInteger"
  | "negativeInteger"
  | "long"
  | "int"
  | "short"
  | "byte"
  | "nonNegativeInteger"
  | "unsignedLong"
  | "unsignedInt"
  | "unsignedShort"
  | "unsignedByte"
  | "positiveInteger"
  | "float"
  | "double"
  | "duration"
  | "yearMonthDuration"
  | "dayTimeDuration"
  | "dateTime"
  | "dateTimeStamp"
  | "time"
  | "date"
  | "gYearMonth"
  | "gYear"
  | "gMonthDay"
  | "gDay"
  | "gMonth"
  | "hexBinary"
  | "base64Binary";

/**
 * A built-in atomic type: its name, the type it is derived from and the primitive type at the top of its chain.
 *
 * Types are compared by identity: there is one object per type, in
 * {@link AtomicTypes}.
 *
 * @since 0.3.0
 * @category types
 */
export interface AtomicType {
  /** The local name in the `xs:` namespace (`http://www.w3.org/2001/XMLSchema`). */
  readonly name: AtomicTypeName;
  /** The type this one is derived from by restriction; `None` only for `xs:anyAtomicType`. */
  readonly base: Option.Option<AtomicType>;
  /**
   * The primitive type this one derives from (`decimal` for `xs:int`, `string`
   * for `xs:token`); `xs:untypedAtomic` and the primitive types are their own.
   * `xs:anyAtomicType`'s is itself.
   */
  readonly primitive: AtomicTypeName;
}

/** The types XDM adds to XML Schema's, by the type each is derived from. */
const xdmBases: Readonly<Partial<Record<AtomicTypeName, AtomicTypeName>>> = {
  untypedAtomic: "anyAtomicType",
  yearMonthDuration: "duration",
  dayTimeDuration: "duration",
  dateTimeStamp: "dateTime",
};

const names: ReadonlyArray<AtomicTypeName> = [
  "anyAtomicType",
  "untypedAtomic",
  "string",
  "normalizedString",
  "token",
  "language",
  "NMTOKEN",
  "Name",
  "NCName",
  "ID",
  "IDREF",
  "ENTITY",
  "anyURI",
  "QName",
  "NOTATION",
  "boolean",
  "decimal",
  "integer",
  "nonPositiveInteger",
  "negativeInteger",
  "long",
  "int",
  "short",
  "byte",
  "nonNegativeInteger",
  "unsignedLong",
  "unsignedInt",
  "unsignedShort",
  "unsignedByte",
  "positiveInteger",
  "float",
  "double",
  "duration",
  "yearMonthDuration",
  "dayTimeDuration",
  "dateTime",
  "dateTimeStamp",
  "time",
  "date",
  "gYearMonth",
  "gYear",
  "gMonthDay",
  "gDay",
  "gMonth",
  "hexBinary",
  "base64Binary",
];

const isAtomicTypeName = (local: string): local is AtomicTypeName =>
  Arr.some(names, (name) => name === local);

/**
 * The base of a type by name: XDM's own, else XML Schema's, with the primitive
 * types re-rooted from `xs:anySimpleType` to `xs:anyAtomicType`.
 */
const baseName = (name: AtomicTypeName): Option.Option<AtomicTypeName> => {
  if (name === "anyAtomicType") return Option.none();
  const xdm = xdmBases[name];
  if (xdm !== undefined) return Option.some(xdm);
  return Option.some(
    Option.match(builtinBase(builtin(name)), {
      onNone: (): AtomicTypeName => "anyAtomicType",
      onSome: (key) => {
        const local = key.slice(builtin("").length);
        return isAtomicTypeName(local) ? local : "anyAtomicType";
      },
    }),
  );
};

/**
 * Build the type objects base-first (`names` lists every type after its
 * base), so every `base` is the shared object.
 */
const buildTypes = (): { readonly [K in AtomicTypeName]: AtomicType } =>
  // SAFETY: the fold sets every member of `names`, which lists every `AtomicTypeName`.
  Arr.reduce(names, {} as Record<AtomicTypeName, AtomicType>, (built, name) => {
    const base = Option.map(baseName(name), (b) => built[b]);
    const primitive = Option.match(base, {
      onNone: () => name,
      onSome: (b) => (b.name === "anyAtomicType" ? name : b.primitive),
    });
    built[name] = { name, base, primitive };
    return built;
  });

/**
 * Every built-in atomic type, by local name.
 *
 * @example
 * ```ts
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * console.log(XQuery.derivesFrom(XQuery.AtomicTypes.int, XQuery.AtomicTypes.decimal)) // true
 * console.log(XQuery.AtomicTypes.token.primitive) // "string"
 * ```
 *
 * @since 0.3.0
 * @category types
 */
export const AtomicTypes: { readonly [K in AtomicTypeName]: AtomicType } =
  /*#__PURE__*/ buildTypes();

/**
 * The built-in atomic type with this expanded name, if there is one.
 *
 * @since 0.3.0
 * @category types
 */
export const atomicType = (namespace: string | null, local: string): Option.Option<AtomicType> =>
  namespace === XS && isAtomicTypeName(local) ? Option.some(AtomicTypes[local]) : Option.none();

/**
 * Whether `type` is `ancestor` or derived from it (XPath 3.1 §2.5.6.1 `derives-from` for atomic types).
 *
 * @since 0.3.0
 * @category types
 */
export const derivesFrom = (type: AtomicType, ancestor: AtomicType): boolean =>
  // Recursive along the base chain, which is at most eight types long.
  type === ancestor ||
  Option.match(type.base, { onNone: () => false, onSome: (base) => derivesFrom(base, ancestor) });

/**
 * Whether values of `type` are numeric: `xs:decimal` (and so every integer type), `xs:float` or `xs:double`.
 *
 * @since 0.3.0
 * @category types
 */
export const isNumericType = (type: AtomicType): boolean =>
  type.primitive === "decimal" || type.primitive === "float" || type.primitive === "double";
