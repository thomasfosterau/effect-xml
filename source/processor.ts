/**
 * Chunk-boundary-aware XML processor
 * Uses a unique pull-based architecture with boundary detection
 */
import * as Effect from "effect/Effect";
import * as Chunk from "effect/Chunk";
import type { StreamMessage } from "./messages";
import {
  ElementStart,
  ElementEnd,
  ContentChunk,
  MarkupNote,
  RawDataSection,
  MetaInstruction,
  TypeDeclaration,
} from "./messages";

// Processor workspace
interface ProcessorWorkspace {
  offset: number;
  collected: string;
  tagBuffer: string;
  propKey: string;
  properties: Record<string, string>;
  delimiterChar: string | null;
  phase: ProcessingPhase;
  messageCounter: number;
}

type ProcessingPhase =
  | "TEXT_MODE"
  | "OPENING_BRACKET"
  | "CLOSING_BRACKET"
  | "TAG_IDENTIFIER"
  | "PROPERTY_KEY"
  | "PROPERTY_VALUE"
  | "COMMENT_MODE"
  | "RAW_DATA_MODE"
  | "META_MODE"
  | "TYPE_DECL_MODE";

const createWorkspace = (): ProcessorWorkspace => ({
  offset: 0,
  collected: "",
  tagBuffer: "",
  propKey: "",
  properties: {},
  delimiterChar: null,
  phase: "TEXT_MODE",
  messageCounter: 0,
});

const generateMessageId = (workspace: ProcessorWorkspace): string => {
  workspace.messageCounter++;
  return `msg_${workspace.messageCounter}_${workspace.offset}`;
};

/**
 * Process markup into message stream using boundary detection
 */
export const processMarkup = (
  input: string
): Effect.Effect<Chunk.Chunk<StreamMessage>> => {
  return Effect.sync(() => {
    const messages: StreamMessage[] = [];
    const ws = createWorkspace();
    const totalLen = input.length;

    let cursor = 0;
    while (cursor < totalLen) {
      ws.offset = cursor;
      const currentChar = input[cursor];
      const lookahead1 = input[cursor + 1];
      const segment2 = input.substring(cursor, cursor + 2);
      const segment3 = input.substring(cursor, cursor + 3);
      const segment4 = input.substring(cursor, cursor + 4);
      const segment9 = input.substring(cursor, cursor + 9);

      switch (ws.phase) {
        case "TEXT_MODE": {
          if (currentChar === "<") {
            // Emit text if exists
            if (ws.collected.length > 0) {
              messages.push(
                new ContentChunk({
                  messageId: generateMessageId(ws),
                  byteOffset: ws.offset,
                  payload: ws.collected,
                })
              );
            }
            ws.collected = "";

            // Detect special sequences
            if (segment4 === "<!--") {
              ws.phase = "COMMENT_MODE";
              cursor += 3;
            } else if (segment9 === "<![CDATA[") {
              ws.phase = "RAW_DATA_MODE";
              cursor += 8;
            } else if (segment2 === "<?") {
              ws.phase = "META_MODE";
              cursor += 1;
            } else if (segment9.toUpperCase() === "<!DOCTYPE") {
              ws.phase = "TYPE_DECL_MODE";
              cursor += 8;
            } else if (segment2 === "</") {
              ws.phase = "CLOSING_BRACKET";
              cursor += 1;
            } else {
              ws.phase = "OPENING_BRACKET";
            }
          } else {
            ws.collected += currentChar;
          }
          break;
        }

        case "OPENING_BRACKET": {
          const isWhitespace = /\s/.test(currentChar);
          
          if (isWhitespace && ws.collected.length > 0) {
            ws.tagBuffer = ws.collected;
            ws.collected = "";
            ws.phase = "PROPERTY_KEY";
          } else if (currentChar === ">") {
            if (ws.collected.length > 0) {
              ws.tagBuffer = ws.collected;
            }
            messages.push(
              new ElementStart({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                tagIdentifier: ws.tagBuffer,
                propertyBag: { ...ws.properties },
                standalone: false,
              })
            );
            ws.phase = "TEXT_MODE";
            ws.collected = "";
            ws.tagBuffer = "";
            ws.properties = {};
          } else if (segment2 === "/>") {
            if (ws.collected.length > 0) {
              ws.tagBuffer = ws.collected;
            }
            messages.push(
              new ElementStart({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                tagIdentifier: ws.tagBuffer,
                propertyBag: { ...ws.properties },
                standalone: true,
              })
            );
            ws.phase = "TEXT_MODE";
            ws.collected = "";
            ws.tagBuffer = "";
            ws.properties = {};
            cursor += 1;
          } else {
            ws.collected += currentChar;
          }
          break;
        }

        case "CLOSING_BRACKET": {
          if (currentChar === ">") {
            messages.push(
              new ElementEnd({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                tagIdentifier: ws.collected,
              })
            );
            ws.phase = "TEXT_MODE";
            ws.collected = "";
          } else {
            ws.collected += currentChar;
          }
          break;
        }

        case "PROPERTY_KEY": {
          const isWhitespace = /\s/.test(currentChar);
          
          if (currentChar === "=") {
            ws.propKey = ws.collected.trim();
            ws.collected = "";
          } else if (currentChar === '"' || currentChar === "'") {
            if (ws.propKey.length > 0) {
              ws.phase = "PROPERTY_VALUE";
              ws.delimiterChar = currentChar;
            }
          } else if (currentChar === ">") {
            messages.push(
              new ElementStart({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                tagIdentifier: ws.tagBuffer,
                propertyBag: { ...ws.properties },
                standalone: false,
              })
            );
            ws.phase = "TEXT_MODE";
            ws.collected = "";
            ws.tagBuffer = "";
            ws.properties = {};
            ws.propKey = "";
          } else if (segment2 === "/>") {
            messages.push(
              new ElementStart({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                tagIdentifier: ws.tagBuffer,
                propertyBag: { ...ws.properties },
                standalone: true,
              })
            );
            ws.phase = "TEXT_MODE";
            ws.collected = "";
            ws.tagBuffer = "";
            ws.properties = {};
            ws.propKey = "";
            cursor += 1;
          } else if (!isWhitespace) {
            ws.collected += currentChar;
          }
          break;
        }

        case "PROPERTY_VALUE": {
          if (currentChar === ws.delimiterChar) {
            ws.properties[ws.propKey] = ws.collected;
            ws.collected = "";
            ws.propKey = "";
            ws.delimiterChar = null;
            ws.phase = "PROPERTY_KEY";
          } else {
            ws.collected += currentChar;
          }
          break;
        }

        case "COMMENT_MODE": {
          if (segment3 === "-->") {
            messages.push(
              new MarkupNote({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                noteText: ws.collected,
              })
            );
            ws.collected = "";
            ws.phase = "TEXT_MODE";
            cursor += 2;
          } else {
            ws.collected += currentChar;
          }
          break;
        }

        case "RAW_DATA_MODE": {
          if (segment3 === "]]>") {
            messages.push(
              new RawDataSection({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                rawContent: ws.collected,
              })
            );
            ws.collected = "";
            ws.phase = "TEXT_MODE";
            cursor += 2;
          } else {
            ws.collected += currentChar;
          }
          break;
        }

        case "META_MODE": {
          if (segment2 === "?>") {
            const fragments = ws.collected.split(/\s+/, 2);
            messages.push(
              new MetaInstruction({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                instructionTag: fragments[0] || "",
                instructionPayload: fragments.slice(1).join(" "),
              })
            );
            ws.collected = "";
            ws.phase = "TEXT_MODE";
            cursor += 1;
          } else {
            ws.collected += currentChar;
          }
          break;
        }

        case "TYPE_DECL_MODE": {
          if (currentChar === ">") {
            messages.push(
              new TypeDeclaration({
                messageId: generateMessageId(ws),
                byteOffset: ws.offset,
                declarationBody: ws.collected.trim(),
              })
            );
            ws.collected = "";
            ws.phase = "TEXT_MODE";
          } else {
            ws.collected += currentChar;
          }
          break;
        }
      }

      cursor++;
    }

    // Emit remaining text
    if (ws.collected.length > 0 && ws.phase === "TEXT_MODE") {
      messages.push(
        new ContentChunk({
          messageId: generateMessageId(ws),
          byteOffset: ws.offset,
          payload: ws.collected,
        })
      );
    }

    return Chunk.fromIterable(messages);
  });
};
