/**
 * effect-sax Public API
 * Message-based reactive XML processing with Effect
 */

// Message type exports
export type {
  StreamMessage,
  ProcessorConfig,
} from "./messages";

export {
  ElementStart,
  ElementEnd,
  ContentChunk,
  MarkupNote,
  RawDataSection,
  MetaInstruction,
  TypeDeclaration,
  StreamMessage as StreamMessageSchema,
  ProcessorConfig as ProcessorConfigSchema,
} from "./messages";

// Reactive stream exports
export {
  ProcessingFailure,
  createMessageStream,
  collectMessages,
  isolateStarts,
  isolateEnds,
  isolateContent,
  selectByTag,
  harvestTagContent,
  applyValidation,
  quantifyTag,
  aggregateProperties,
  transformStream,
  foldMessages,
} from "./reactive";

// Processor exports
export { processMarkup } from "./processor";
