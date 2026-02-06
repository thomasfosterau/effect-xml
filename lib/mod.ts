/**
 * effect-sax - Type-safe XML streaming with Effect
 * 
 * Main entry point providing all public APIs
 */

// Export schema definitions
export type {
  XmlSignal,
  AttributeMap,
  StreamConfig,
} from "./schema";

export {
  TagOpened,
  TagClosed,
  CharData,
  Annotation,
  CDataBlock,
  Directive,
  DocumentTypeDecl,
  ParseFailure,
  XmlSignal as XmlSignalSchema,
  StreamConfig as StreamConfigSchema,
} from "./schema";

// Export streaming functions
export {
  StreamProcessError,
  generateSignalStream,
  gatherSignals,
  keepOpenings,
  keepClosings,
  keepCharData,
  selectByElement,
  captureElementText,
  validateWithSchema,
  countElement,
  gatherElementAttrs,
} from "./streaming";

// Export scanner
export { scanXmlContent } from "./scanner";
