/**
 * The compiled form of an XML Schema: plain, serializable data.
 *
 * `Xsd.compile` reads schema documents into a {@link Model}; `Xsd.load` turns
 * a model into a validator. The generator (`Xsd.generate`) writes the model
 * into the module it emits as an object literal, so a generated parser never
 * reads or resolves an XSD at run time.
 *
 * Every component is referred to by a key. Global components are keyed by
 * their expanded name in Clark notation (`{namespace}local`, or just `local`
 * in no namespace); local element declarations and anonymous types get
 * synthetic keys starting with `#`. The built-in datatypes are not in the
 * model: they are referred to by their names in the XML Schema namespace
 * (`{http://www.w3.org/2001/XMLSchema}string`). An absent namespace is written
 * `""` wherever a namespace is listed.
 *
 * The model is already resolved: references are followed, attribute groups
 * and model groups are inlined, and every complex type carries its effective
 * attribute uses and content model (those it inherits included).
 */

/**
 * How often a particle may occur: a count, or `"unbounded"`.
 *
 * @since 0.1.0
 * @category models
 */
export type MaxOccurs = number | "unbounded";

/**
 * Which namespaces a wildcard admits: any, all but some, or only some (`""` is no namespace).
 *
 * @since 0.1.0
 * @category models
 */
export type NamespaceConstraint =
  | { readonly _tag: "Any" }
  | { readonly _tag: "Not"; readonly namespaces: ReadonlyArray<string> }
  | { readonly _tag: "Only"; readonly namespaces: ReadonlyArray<string> };

/**
 * An `xs:any` or `xs:anyAttribute` wildcard.
 *
 * `processContents` decides what happens to what it matches: `"strict"`
 * requires a global declaration and validates against it, `"lax"` validates
 * only when there is one, and `"skip"` accepts anything well-formed.
 *
 * @since 0.1.0
 * @category models
 */
export interface Wildcard {
  readonly namespaces: NamespaceConstraint;
  readonly process: "strict" | "lax" | "skip";
}

/**
 * An element particle: a reference to an element declaration (by key) with its occurrence bounds.
 *
 * @since 0.1.0
 * @category models
 */
export interface ElementParticle {
  readonly _tag: "Element";
  /** The key of the declaration in {@link Model.elements}. */
  readonly element: string;
  /** Defaults to 1. */
  readonly min?: number;
  /** Defaults to 1. */
  readonly max?: MaxOccurs;
}

/**
 * An `xs:any` particle.
 *
 * @since 0.1.0
 * @category models
 */
export interface AnyParticle {
  readonly _tag: "Any";
  readonly wildcard: Wildcard;
  readonly min?: number;
  readonly max?: MaxOccurs;
}

/**
 * A model group (`xs:sequence`, `xs:choice` or `xs:all`) with its occurrence bounds.
 *
 * @since 0.1.0
 * @category models
 */
export interface GroupParticle {
  readonly _tag: "Sequence" | "Choice" | "All";
  readonly particles: ReadonlyArray<Particle>;
  readonly min?: number;
  readonly max?: MaxOccurs;
}

/**
 * A term of a content model, with its occurrence bounds.
 *
 * @since 0.1.0
 * @category models
 */
export type Particle = ElementParticle | AnyParticle | GroupParticle;

/**
 * What a complex type's content may be: nothing, character data of a simple type, or elements.
 *
 * @since 0.1.0
 * @category models
 */
export type Content =
  | { readonly _tag: "Empty" }
  | { readonly _tag: "Simple"; readonly type: string }
  | { readonly _tag: "Elements"; readonly particle: Particle };

/**
 * The constraining facets of one derivation step of a simple type.
 *
 * Bounds are lexical forms of the base type. `patterns` are the step's
 * `xs:pattern`s, one of which must match; each step of a derivation chain must
 * be satisfied in turn. For `QName` types, enumerated values are written in
 * Clark notation.
 *
 * @since 0.1.0
 * @category models
 */
export interface Facets {
  readonly length?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly patterns?: ReadonlyArray<string>;
  readonly enumeration?: ReadonlyArray<string>;
  readonly whiteSpace?: "preserve" | "replace" | "collapse";
  readonly minInclusive?: string;
  readonly maxInclusive?: string;
  readonly minExclusive?: string;
  readonly maxExclusive?: string;
  readonly totalDigits?: number;
  readonly fractionDigits?: number;
}

/**
 * A simple type definition: a restriction of `base`, a list of `itemType`, or a union of `memberTypes`.
 *
 * A restriction of a list or union type keeps the variety of its base.
 *
 * @since 0.1.0
 * @category models
 */
export interface SimpleType {
  readonly _tag: "SimpleType";
  readonly name: string;
  readonly variety: "atomic" | "list" | "union";
  /** The type this one restricts (`anySimpleType` for a list or union defined directly). */
  readonly base: string;
  readonly itemType?: string;
  readonly memberTypes?: ReadonlyArray<string>;
  readonly facets?: Facets;
}

/**
 * An attribute use: an attribute a complex type allows or requires.
 *
 * @since 0.1.0
 * @category models
 */
export interface AttributeUse {
  /** The attribute's expanded name. */
  readonly name: string;
  /** The key of its simple type. */
  readonly type: string;
  readonly required?: boolean;
  readonly default?: string;
  readonly fixed?: string;
}

/**
 * The derivations a declaration or type blocks.
 *
 * @since 0.1.0
 * @category models
 */
export type Derivation = "extension" | "restriction" | "substitution";

/**
 * A complex type definition with its effective attribute uses and content model.
 *
 * @since 0.1.0
 * @category models
 */
export interface ComplexType {
  readonly _tag: "ComplexType";
  readonly name: string;
  /** The type this one derives from (`anyType` when none is given). */
  readonly base?: string;
  readonly derivation?: "extension" | "restriction";
  readonly abstract?: boolean;
  readonly block?: ReadonlyArray<Derivation>;
  /** Character data may appear between child elements. */
  readonly mixed?: boolean;
  readonly attributes: ReadonlyArray<AttributeUse>;
  readonly anyAttribute?: Wildcard;
  readonly content: Content;
}

/**
 * A type definition.
 *
 * @since 0.1.0
 * @category models
 */
export type TypeDefinition = SimpleType | ComplexType;

/**
 * An identity constraint (`xs:unique`, `xs:key` or `xs:keyref`) on an element declaration.
 *
 * `selector` and `fields` are the constraint's XPath expressions; `namespaces`
 * binds the prefixes they use.
 *
 * @since 0.1.0
 * @category models
 */
export interface IdentityConstraint {
  readonly _tag: "Unique" | "Key" | "KeyRef";
  readonly name: string;
  /** For a `KeyRef`, the name of the key or unique constraint it refers to. */
  readonly refer?: string;
  readonly selector: string;
  readonly fields: ReadonlyArray<string>;
  readonly namespaces: Readonly<Record<string, string>>;
}

/**
 * An element declaration.
 *
 * @since 0.1.0
 * @category models
 */
export interface ElementDeclaration {
  /** The element's expanded name. */
  readonly name: string;
  /** The key of its type. */
  readonly type: string;
  readonly nillable?: boolean;
  readonly abstract?: boolean;
  readonly default?: string;
  readonly fixed?: string;
  /** The head of the substitution group this (global) element belongs to. */
  readonly substitutionGroup?: string;
  readonly block?: ReadonlyArray<Derivation>;
  readonly constraints?: ReadonlyArray<IdentityConstraint>;
}

/**
 * A global attribute declaration, used by attribute wildcards that validate what they match.
 *
 * @since 0.1.0
 * @category models
 */
export interface AttributeDeclaration {
  readonly name: string;
  readonly type: string;
}

/**
 * A compiled schema: every element declaration, type definition and global attribute declaration.
 *
 * @since 0.1.0
 * @category models
 */
export interface Model {
  /** Element declarations: global ones by expanded name, local ones by `#` keys. */
  readonly elements: Readonly<Record<string, ElementDeclaration>>;
  /** Type definitions: named ones by expanded name, anonymous ones by `#` keys. */
  readonly types: Readonly<Record<string, TypeDefinition>>;
  /** Global attribute declarations by expanded name. */
  readonly attributes: Readonly<Record<string, AttributeDeclaration>>;
}

/**
 * The XML Schema namespace, which names the built-in datatypes.
 *
 * @since 0.1.0
 * @category constants
 */
export const XS = "http://www.w3.org/2001/XMLSchema";

/**
 * The XML Schema instance namespace (`xsi:type`, `xsi:nil`).
 *
 * @since 0.1.0
 * @category constants
 */
export const XSI = "http://www.w3.org/2001/XMLSchema-instance";

/**
 * The expanded name of `local` in `namespace`, in the Clark notation the model's keys use.
 *
 * @since 0.1.0
 * @category names
 */
export const clark = (namespace: string, local: string): string =>
  namespace === "" ? local : `{${namespace}}${local}`;

/**
 * The key of a built-in datatype (`builtin("string")` is `{http://www.w3.org/2001/XMLSchema}string`).
 *
 * @since 0.1.0
 * @category names
 */
export const builtin = (local: string): string => clark(XS, local);
