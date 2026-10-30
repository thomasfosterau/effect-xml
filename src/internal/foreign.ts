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

import { tagSet } from "./tagSet.ts";
import { MATHML_NS, SVG_NS } from "../Html/Namespaces.ts";
import type { HtmlAttribute, HtmlAttributeNamespace } from "../Html/Node.ts";
import * as Nodes from "./nodes.ts";

/** MathML text integration points (start tags/characters inside them use HTML rules). */
export const MATHML_TEXT_IP = tagSet("mi", "mo", "mn", "ms", "mtext");

/**
 * HTML start tags that force the parser out of foreign content. (`font` is a
 * conditional member — only with a color/face/size attribute — handled in the
 * tree builder.)
 */
export const FOREIGN_BREAKOUT = tagSet(
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
);

/** Case corrections: the lowercased name a tokenizer sees to the name the spec spells. */
interface NameCorrections {
  readonly [lowercased: string]: string;
}

/** SVG tag names that are case-corrected from their lowercased form. */
const SVG_TAG_NAMES: NameCorrections = {
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
};

export const svgTagName = (name: string): string => SVG_TAG_NAMES[name] ?? name;

/** SVG attribute names that are case-corrected from their lowercased form. */
const SVG_ATTRS: NameCorrections = {
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
};

/** Foreign attributes placed into the XLink / XML / XMLNS namespaces. */
interface ForeignAttributes {
  readonly [name: string]: {
    readonly prefix: string | null;
    readonly local: string;
    readonly ns: HtmlAttributeNamespace;
  };
}
const FOREIGN_ATTRS: ForeignAttributes = {
  "xlink:actuate": { prefix: "xlink", local: "actuate", ns: "xlink" },
  "xlink:arcrole": { prefix: "xlink", local: "arcrole", ns: "xlink" },
  "xlink:href": { prefix: "xlink", local: "href", ns: "xlink" },
  "xlink:role": { prefix: "xlink", local: "role", ns: "xlink" },
  "xlink:show": { prefix: "xlink", local: "show", ns: "xlink" },
  "xlink:title": { prefix: "xlink", local: "title", ns: "xlink" },
  "xlink:type": { prefix: "xlink", local: "type", ns: "xlink" },
  "xml:lang": { prefix: "xml", local: "lang", ns: "xml" },
  "xml:space": { prefix: "xml", local: "space", ns: "xml" },
  xmlns: { prefix: null, local: "xmlns", ns: "xmlns" },
  "xmlns:xlink": { prefix: "xmlns", local: "xlink", ns: "xmlns" },
};

/**
 * Apply the per-namespace attribute fix-ups to a token's attributes (all in
 * no namespace): SVG/MathML name case-correction followed by the foreign
 * (XLink/XML/XMLNS) namespace placement. `ns` is the element's namespace URI.
 */
export const adjustForeignAttrs = (
  attrs: ReadonlyArray<HtmlAttribute>,
  ns: string,
): Array<HtmlAttribute> =>
  attrs.map((a): HtmlAttribute => {
    const foreign = FOREIGN_ATTRS[a.name];
    if (foreign) return Nodes.htmlAttribute(foreign.local, a.value, foreign.ns, foreign.prefix);
    if (ns === SVG_NS) {
      const fixed = SVG_ATTRS[a.name];
      if (fixed) return Nodes.htmlAttribute(fixed, a.value, null, null);
    } else if (ns === MATHML_NS) {
      if (a.name === "definitionurl")
        return Nodes.htmlAttribute("definitionURL", a.value, null, null);
    }
    return a;
  });
