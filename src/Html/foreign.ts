/**
 * Foreign-content (SVG / MathML) support for HTML tree construction.
 *
 * The WHATWG algorithm keeps SVG and MathML subtrees in their own namespaces and
 * applies a set of fix-ups while parsing: SVG tag and attribute names are
 * case-corrected (the tokenizer has already lowercased them), a handful of
 * MathML/foreign attributes are placed in the XLink / XML / XMLNS namespaces, and
 * certain HTML tags "break out" of foreign content entirely. This module holds
 * those tables and the small pure helpers that operate on them.
 */

export const SVG_NS = "http://www.w3.org/2000/svg"
export const MATHML_NS = "http://www.w3.org/1998/Math/MathML"
export const XLINK_NS = "http://www.w3.org/1999/xlink"
export const XML_NS = "http://www.w3.org/XML/1998/namespace"
export const XMLNS_NS = "http://www.w3.org/2000/xmlns/"

/** A working-DOM attribute, optionally carrying a namespace/prefix after adjustment. */
export interface Attr {
  name: string
  value: string
  prefix?: string | null
  ns?: string | null
}

/** MathML text integration points (start tags/characters inside them use HTML rules). */
export const MATHML_TEXT_IP = new Set(["mi", "mo", "mn", "ms", "mtext"])

/**
 * HTML start tags that force the parser out of foreign content. (`font` is a
 * conditional member — only with a color/face/size attribute — handled in the
 * tree builder.)
 */
export const FOREIGN_BREAKOUT = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl",
  "dt", "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i",
  "img", "li", "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s",
  "small", "span", "strong", "strike", "sub", "sup", "table", "tt", "u", "ul",
  "var",
])

/** SVG tag names that are case-corrected from their lowercased form. */
const SVG_TAG_NAMES: Record<string, string> = {
  altglyph: "altGlyph",
  altglyphdef: "altGlyphDef",
  altglyphitem: "altGlyphItem",
  animatecolor: "animateColor",
  animatemotion: "animateMotion",
  animatetransform: "animateTransform",
  clippath: "clipPath",
  feblend: "feBlend",
  fecolormatrix: "feColorMatrix",
  fecomponenttransfer: "feComponentTransfer",
  fecomposite: "feComposite",
  feconvolvematrix: "feConvolveMatrix",
  fediffuselighting: "feDiffuseLighting",
  fedisplacementmap: "feDisplacementMap",
  fedistantlight: "feDistantLight",
  fedropshadow: "feDropShadow",
  feflood: "feFlood",
  fefunca: "feFuncA",
  fefuncb: "feFuncB",
  fefuncg: "feFuncG",
  fefuncr: "feFuncR",
  fegaussianblur: "feGaussianBlur",
  feimage: "feImage",
  femerge: "feMerge",
  femergenode: "feMergeNode",
  femorphology: "feMorphology",
  feoffset: "feOffset",
  fepointlight: "fePointLight",
  fespecularlighting: "feSpecularLighting",
  fespotlight: "feSpotLight",
  fetile: "feTile",
  feturbulence: "feTurbulence",
  foreignobject: "foreignObject",
  glyphref: "glyphRef",
  lineargradient: "linearGradient",
  radialgradient: "radialGradient",
  textpath: "textPath",
}

export const svgTagName = (name: string): string => SVG_TAG_NAMES[name] ?? name

/** SVG attribute names that are case-corrected from their lowercased form. */
const SVG_ATTRS: Record<string, string> = {
  attributename: "attributeName",
  attributetype: "attributeType",
  basefrequency: "baseFrequency",
  baseprofile: "baseProfile",
  calcmode: "calcMode",
  clippathunits: "clipPathUnits",
  diffuseconstant: "diffuseConstant",
  edgemode: "edgeMode",
  filterunits: "filterUnits",
  glyphref: "glyphRef",
  gradienttransform: "gradientTransform",
  gradientunits: "gradientUnits",
  kernelmatrix: "kernelMatrix",
  kernelunitlength: "kernelUnitLength",
  keypoints: "keyPoints",
  keysplines: "keySplines",
  keytimes: "keyTimes",
  lengthadjust: "lengthAdjust",
  limitingconeangle: "limitingConeAngle",
  markerheight: "markerHeight",
  markerunits: "markerUnits",
  markerwidth: "markerWidth",
  maskcontentunits: "maskContentUnits",
  maskunits: "maskUnits",
  numoctaves: "numOctaves",
  pathlength: "pathLength",
  patterncontentunits: "patternContentUnits",
  patterntransform: "patternTransform",
  patternunits: "patternUnits",
  pointsatx: "pointsAtX",
  pointsaty: "pointsAtY",
  pointsatz: "pointsAtZ",
  preservealpha: "preserveAlpha",
  preserveaspectratio: "preserveAspectRatio",
  primitiveunits: "primitiveUnits",
  refx: "refX",
  refy: "refY",
  repeatcount: "repeatCount",
  repeatdur: "repeatDur",
  requiredextensions: "requiredExtensions",
  requiredfeatures: "requiredFeatures",
  specularconstant: "specularConstant",
  specularexponent: "specularExponent",
  spreadmethod: "spreadMethod",
  startoffset: "startOffset",
  stddeviation: "stdDeviation",
  stitchtiles: "stitchTiles",
  surfacescale: "surfaceScale",
  systemlanguage: "systemLanguage",
  tablevalues: "tableValues",
  targetx: "targetX",
  targety: "targetY",
  textlength: "textLength",
  viewbox: "viewBox",
  viewtarget: "viewTarget",
  xchannelselector: "xChannelSelector",
  ychannelselector: "yChannelSelector",
  zoomandpan: "zoomAndPan",
}

/** Foreign attributes placed into the XLink / XML / XMLNS namespaces. */
const FOREIGN_ATTRS: Record<string, { prefix: string | null; local: string; ns: string }> = {
  "xlink:actuate": { prefix: "xlink", local: "actuate", ns: XLINK_NS },
  "xlink:arcrole": { prefix: "xlink", local: "arcrole", ns: XLINK_NS },
  "xlink:href": { prefix: "xlink", local: "href", ns: XLINK_NS },
  "xlink:role": { prefix: "xlink", local: "role", ns: XLINK_NS },
  "xlink:show": { prefix: "xlink", local: "show", ns: XLINK_NS },
  "xlink:title": { prefix: "xlink", local: "title", ns: XLINK_NS },
  "xlink:type": { prefix: "xlink", local: "type", ns: XLINK_NS },
  "xml:lang": { prefix: "xml", local: "lang", ns: XML_NS },
  "xml:space": { prefix: "xml", local: "space", ns: XML_NS },
  "xmlns": { prefix: null, local: "xmlns", ns: XMLNS_NS },
  "xmlns:xlink": { prefix: "xmlns", local: "xlink", ns: XMLNS_NS },
}

/**
 * Apply the per-namespace attribute fix-ups to a token's attributes: SVG/MathML
 * name case-correction followed by the foreign (XLink/XML/XMLNS) namespace
 * placement.
 */
export const adjustForeignAttrs = (attrs: ReadonlyArray<Attr>, ns: string): Array<Attr> =>
  attrs.map((a): Attr => {
    const foreign = FOREIGN_ATTRS[a.name]
    if (foreign) {
      return { name: foreign.local, value: a.value, prefix: foreign.prefix, ns: foreign.ns }
    }
    if (ns === SVG_NS) {
      const fixed = SVG_ATTRS[a.name]
      if (fixed) return { name: fixed, value: a.value }
    } else if (ns === MATHML_NS) {
      if (a.name === "definitionurl") return { name: "definitionURL", value: a.value }
    }
    return { name: a.name, value: a.value }
  })
