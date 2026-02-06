/**
 * Character scanner for XML content
 */
import * as Eff from "effect/Effect";
import * as Ch from "effect/Chunk";
import type { XmlSignal } from "./schema";
import {
  TagOpened,
  TagClosed,
  CharData,
  Annotation,
  CDataBlock,
  Directive,
  DocumentTypeDecl,
} from "./schema";

// Scanner position tracker
interface ScanPosition {
  currentIndex: number;
  accumulated: string;
  elementIdentifier: string;
  attrKey: string;
  attrCollection: Record<string, string>;
  quoteType: string | null;
  mode: ScanMode;
}

type ScanMode =
  | "CONTENT"
  | "TAG_START"
  | "TAG_END"
  | "ELEMENT_ID"
  | "ATTR_KEY"
  | "ATTR_VAL"
  | "REMARK"
  | "CDATA_CONTENT"
  | "PI_CONTENT"
  | "DOCTYPE_CONTENT";

const initScanPosition = (): ScanPosition => ({
  currentIndex: 0,
  accumulated: "",
  elementIdentifier: "",
  attrKey: "",
  attrCollection: {},
  quoteType: null,
  mode: "CONTENT",
});

/**
 * Process raw XML into signal chunks
 */
export const scanXmlContent = (
  rawInput: string
): Eff.Effect<Ch.Chunk<XmlSignal>> => {
  return Eff.sync(() => {
    const signals: XmlSignal[] = [];
    const pos = initScanPosition();
    const inputLen = rawInput.length;

    for (let idx = 0; idx < inputLen; idx++) {
      pos.currentIndex = idx;
      const ch = rawInput[idx];
      const nextCh = rawInput[idx + 1];
      const twoChars = rawInput.slice(idx, idx + 2);
      const threeChars = rawInput.slice(idx, idx + 3);
      const fourChars = rawInput.slice(idx, idx + 4);

      switch (pos.mode) {
        case "CONTENT": {
          if (ch === "<") {
            // Emit accumulated content
            if (pos.accumulated.trim()) {
              signals.push(new CharData({ content: pos.accumulated }));
            }
            pos.accumulated = "";

            // Detect special sequences
            if (fourChars === "<!--") {
              pos.mode = "REMARK";
              idx += 3;
            } else if (rawInput.slice(idx, idx + 9) === "<![CDATA[") {
              pos.mode = "CDATA_CONTENT";
              idx += 8;
            } else if (twoChars === "<?") {
              pos.mode = "PI_CONTENT";
              idx += 1;
            } else if (
              rawInput.slice(idx, idx + 9).toUpperCase() === "<!DOCTYPE"
            ) {
              pos.mode = "DOCTYPE_CONTENT";
              idx += 8;
            } else if (twoChars === "</") {
              pos.mode = "TAG_END";
              idx += 1;
            } else {
              pos.mode = "TAG_START";
            }
          } else {
            pos.accumulated += ch;
          }
          break;
        }

        case "TAG_START": {
          if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
            if (pos.accumulated) {
              pos.elementIdentifier = pos.accumulated;
              pos.accumulated = "";
              pos.mode = "ATTR_KEY";
            }
          } else if (ch === ">") {
            if (pos.accumulated) {
              pos.elementIdentifier = pos.accumulated;
            }
            signals.push(
              new TagOpened({
                elementName: pos.elementIdentifier,
                attrs: { ...pos.attrCollection },
                selfClosed: false,
              })
            );
            pos.mode = "CONTENT";
            pos.accumulated = "";
            pos.elementIdentifier = "";
            pos.attrCollection = {};
          } else if (twoChars === "/>") {
            if (pos.accumulated) {
              pos.elementIdentifier = pos.accumulated;
            }
            signals.push(
              new TagOpened({
                elementName: pos.elementIdentifier,
                attrs: { ...pos.attrCollection },
                selfClosed: true,
              })
            );
            pos.mode = "CONTENT";
            pos.accumulated = "";
            pos.elementIdentifier = "";
            pos.attrCollection = {};
            idx += 1;
          } else {
            pos.accumulated += ch;
          }
          break;
        }

        case "TAG_END": {
          if (ch === ">") {
            signals.push(
              new TagClosed({
                elementName: pos.accumulated,
              })
            );
            pos.mode = "CONTENT";
            pos.accumulated = "";
          } else {
            pos.accumulated += ch;
          }
          break;
        }

        case "ATTR_KEY": {
          if (ch === "=") {
            pos.attrKey = pos.accumulated.trim();
            pos.accumulated = "";
          } else if (ch === '"' || ch === "'") {
            if (pos.attrKey) {
              pos.mode = "ATTR_VAL";
              pos.quoteType = ch;
            }
          } else if (ch === ">") {
            signals.push(
              new TagOpened({
                elementName: pos.elementIdentifier,
                attrs: { ...pos.attrCollection },
                selfClosed: false,
              })
            );
            pos.mode = "CONTENT";
            pos.accumulated = "";
            pos.elementIdentifier = "";
            pos.attrCollection = {};
            pos.attrKey = "";
          } else if (twoChars === "/>") {
            signals.push(
              new TagOpened({
                elementName: pos.elementIdentifier,
                attrs: { ...pos.attrCollection },
                selfClosed: true,
              })
            );
            pos.mode = "CONTENT";
            pos.accumulated = "";
            pos.elementIdentifier = "";
            pos.attrCollection = {};
            pos.attrKey = "";
            idx += 1;
          } else if (
            ch !== " " &&
            ch !== "\t" &&
            ch !== "\n" &&
            ch !== "\r"
          ) {
            pos.accumulated += ch;
          }
          break;
        }

        case "ATTR_VAL": {
          if (ch === pos.quoteType) {
            pos.attrCollection[pos.attrKey] = pos.accumulated;
            pos.accumulated = "";
            pos.attrKey = "";
            pos.quoteType = null;
            pos.mode = "ATTR_KEY";
          } else {
            pos.accumulated += ch;
          }
          break;
        }

        case "REMARK": {
          if (threeChars === "-->") {
            signals.push(
              new Annotation({
                content: pos.accumulated,
              })
            );
            pos.accumulated = "";
            pos.mode = "CONTENT";
            idx += 2;
          } else {
            pos.accumulated += ch;
          }
          break;
        }

        case "CDATA_CONTENT": {
          if (threeChars === "]]>") {
            signals.push(
              new CDataBlock({
                content: pos.accumulated,
              })
            );
            pos.accumulated = "";
            pos.mode = "CONTENT";
            idx += 2;
          } else {
            pos.accumulated += ch;
          }
          break;
        }

        case "PI_CONTENT": {
          if (twoChars === "?>") {
            const segments = pos.accumulated.split(" ", 2);
            signals.push(
              new Directive({
                targetName: segments[0] || "",
                directiveData: segments[1] || "",
              })
            );
            pos.accumulated = "";
            pos.mode = "CONTENT";
            idx += 1;
          } else {
            pos.accumulated += ch;
          }
          break;
        }

        case "DOCTYPE_CONTENT": {
          if (ch === ">") {
            signals.push(
              new DocumentTypeDecl({
                content: pos.accumulated.trim(),
              })
            );
            pos.accumulated = "";
            pos.mode = "CONTENT";
          } else {
            pos.accumulated += ch;
          }
          break;
        }
      }
    }

    // Emit remaining content
    if (pos.accumulated.trim() && pos.mode === "CONTENT") {
      signals.push(new CharData({ content: pos.accumulated }));
    }

    return Ch.fromIterable(signals);
  });
};
