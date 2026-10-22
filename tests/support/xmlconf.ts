/**
 * Support for the W3C XML Conformance Test Suite (vendored selection under
 * `tests/fixtures/xmlconf/`): the manifest, and the "canonical XML" format
 * James Clark's tests give expected outputs in.
 */
import type { Xml } from "../../src/index.ts";

export interface XmlconfTest {
  readonly id: string;
  readonly type: "not-wf" | "valid" | "invalid";
  readonly uri: string;
  readonly sections: string;
  readonly description: string;
  readonly output?: string;
  /** `false` for tests of documents that are well-formed but not namespace-well-formed. */
  readonly namespaces?: boolean;
  readonly recommendation?: string;
}

const escape = (s: string): string =>
  s.replace(/[&<>"\t\n\r]/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : `&#${c.charCodeAt(0)};`,
  );

/**
 * James Clark's canonical form: no declaration or DOCTYPE, comments dropped,
 * attributes sorted by name, empty elements as start/end pairs, and `&<>"`
 * and tab/LF/CR as references.
 */
export const canonical = (doc: Xml.XmlDocument): string => {
  let out = "";
  const stack: Array<Xml.XmlNode | string> = [...doc.children].reverse();
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    if (typeof n === "string") {
      out += n;
      continue;
    }
    switch (n._tag) {
      case "XmlText":
      case "XmlCData":
        out += escape(n.data);
        break;
      case "XmlComment":
        break;
      case "XmlProcessingInstruction":
        out += `<?${n.target} ${n.data}?>`;
        break;
      case "XmlElement": {
        const name = n.name.qualified;
        const attrs = [...n.attributes]
          .map((a) => [a.name.qualified, a.value] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        out += `<${name}${attrs.map(([k, v]) => ` ${k}="${escape(v)}"`).join("")}>`;
        stack.push(`</${name}>`);
        for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]!);
      }
    }
  }
  return out;
};
