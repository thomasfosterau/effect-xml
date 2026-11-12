/**
 * Generated XML documents for the differential tests: well-formed elements
 * (attributes, references, ASCII and non-ASCII names, markup around the
 * root) with near misses spliced in, from a seed so a failure reproduces.
 * The near misses include what `recover: true` reads (a stray `<`, an `&`
 * that starts no reference, unquoted and valueless attributes, `</` without
 * a name).
 */
import * as Arr from "effect/Array";

/** A deterministic generator (mulberry32), so a failure reproduces. */
const random = (seed: number) => {
  let a = seed;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Pieces that make up tags, text and their near misses. */
const pieces = [
  "<",
  ">",
  "/",
  "</",
  "/>",
  "a",
  "b:c",
  "x1",
  "_",
  "-",
  ".",
  "9",
  "é",
  "\u{1F600}",
  " ",
  "\t",
  "\n",
  "\r\n",
  "\f",
  "=",
  '"',
  "'",
  "&",
  "amp;",
  "&lt;",
  "&gt;",
  "&quot;",
  "&apos;",
  "&#65;",
  "&#x41;",
  "&#X41;",
  "&#0;",
  "&#x110000;",
  "&#99999999999;",
  "&nope;",
  "&a-b;",
  "]]>",
  "]]",
  "<!--c-->",
  "<!---->",
  "<!--->",
  "<!-- a -- b -->",
  "<!-- a --->",
  "<!--",
  "<!-",
  "<!x",
  "<?pi x?>",
  "<?pi?>",
  "<?pi\t \n x ?>",
  "<?pi\fx?>",
  "<?pix?>",
  "<?xml-stylesheet href='a'?>",
  "<?xml version='1.0'?>",
  "<?XmL x?>",
  "<?é x?>",
  "<?",
  "?>",
  "<![CDATA[x]]>",
  "<![CDATA[]]>",
  "<![CDATA[a]]b]]>",
  "<![CDATA[",
  "<![cdata[x]]>",
  "text",
  "\u0001",
  // What recovery reads (#52).
  "< ",
  "a < b",
  "<=",
  "AT&T ",
  "&nbsp;",
  "&;",
  "&#xZZ;",
  "&#65",
  "</ x>",
  "</>",
  "<a x=1>",
  "<a x=1 y z='<&'/>",
  "<a x='1'y='2' / >",
  "<a 1x=2>",
  "</a junk>",
];

const pick = <A>(next: () => number, items: ReadonlyArray<A>): A =>
  Arr.getUnsafe(items, Math.floor(next() * items.length));

/** A well-formed element, with attributes, text and references. */
const element = (next: () => number): string => {
  // ASCII names, names with non-ASCII characters, and now and then a name
  // a non-ASCII character unmakes.
  const name = (): string =>
    next() < 0.9
      ? pick(next, ["a", "row", "x:c", "v_1", "a.b-c", "日本", "é", "x·y", "a\u0300", "ü:ß"])
      : pick(next, ["\u00d7", "a\u00d7", "\u{1F600}", "\uD800"]);
  // Mostly valid values, and the ones the grammar rejects.
  const value = (): string =>
    next() < 0.85
      ? pick(next, ["", "1", "a&amp;b", "x\ty", "&#x41;", "q'q", "\n", "é"])
      : pick(next, ["a<b", "&nope;", "&#0;", "&#X41;", "&", "&amp", "]]>"]);
  const attrs = Arr.makeBy(Math.floor(next() * 3), (i) => {
    const q = next() < 0.5 ? '"' : "'";
    const v = value().replaceAll(q, "");
    return `${next() < 0.2 ? "\n" : " "}${name()}${i}${next() < 0.2 ? " = " : "="}${q}${v}${q}`;
  }).join("");
  const n = name();
  return next() < 0.3
    ? `<${n}${attrs}${next() < 0.5 ? " " : ""}/>`
    : `<${n}${attrs}>${next() < 0.5 ? "t &lt; u\r\n" : ""}</${n}${next() < 0.2 ? "  " : ""}>`;
};

/** Documents: well-formed elements with near misses spliced in now and then. */
export const documents = (seed: number, count: number): ReadonlyArray<string> => {
  const next = random(seed);
  return Arr.makeBy(count, (i) => {
    const body = Arr.makeBy(1 + Math.floor(next() * 6), () =>
      next() < 0.6 ? element(next) : pick(next, pieces),
    ).join("");
    // Every fourth one is well-formed, so the failures don't hide the rest;
    // some have markup before and after the root element.
    const prolog =
      i % 3 === 0
        ? pick(next, [
            "<?pi x?>",
            "<!-- c -->\n",
            "<![CDATA[x]]>",
            " ",
            '<?xml version="1.0"?>\n',
            "<!DOCTYPE root>\n",
            ' <?xml version="1.0"?>',
            "x",
            "&amp;",
          ])
        : "";
    const epilog =
      i % 5 === 0
        ? pick(next, ["<!-- e -->", "<?pi?>", "\n", "<![CDATA[y]]>", "<!DOCTYPE r>"])
        : "";
    return i % 4 === 0
      ? `${prolog}<root>${Arr.makeBy(4, () => element(next)).join("")}</root>${epilog}`
      : `${prolog}<root>${body}</root>${epilog}`;
  });
};
