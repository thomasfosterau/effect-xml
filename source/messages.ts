/**
 * Message types for XML stream processing
 * Using a unique message-passing architecture
 */
import * as Schema from "@effect/schema/Schema";

// Base message trait
export const BaseMessage = Schema.Struct({
  messageId: Schema.String,
  byteOffset: Schema.Number,
});

// Element boundary messages
export class ElementStart extends Schema.Class<ElementStart>("ElementStart")({
  ...BaseMessage.fields,
  tagIdentifier: Schema.String,
  propertyBag: Schema.Record(Schema.String, Schema.String),
  standalone: Schema.Boolean,
}) {}

export class ElementEnd extends Schema.Class<ElementEnd>("ElementEnd")({
  ...BaseMessage.fields,
  tagIdentifier: Schema.String,
}) {}

// Content messages
export class ContentChunk extends Schema.Class<ContentChunk>("ContentChunk")({
  ...BaseMessage.fields,
  payload: Schema.String,
}) {}

export class MarkupNote extends Schema.Class<MarkupNote>("MarkupNote")({
  ...BaseMessage.fields,
  noteText: Schema.String,
}) {}

export class RawDataSection extends Schema.Class<RawDataSection>("RawDataSection")({
  ...BaseMessage.fields,
  rawContent: Schema.String,
}) {}

export class MetaInstruction extends Schema.Class<MetaInstruction>("MetaInstruction")({
  ...BaseMessage.fields,
  instructionTag: Schema.String,
  instructionPayload: Schema.String,
}) {}

export class TypeDeclaration extends Schema.Class<TypeDeclaration>("TypeDeclaration")({
  ...BaseMessage.fields,
  declarationBody: Schema.String,
}) {}

// All message types union
export const StreamMessage = Schema.Union(
  ElementStart,
  ElementEnd,
  ContentChunk,
  MarkupNote,
  RawDataSection,
  MetaInstruction,
  TypeDeclaration
);
export type StreamMessage = Schema.Schema.Type<typeof StreamMessage>;

// Processing configuration
export class ProcessorConfig extends Schema.Class<ProcessorConfig>("ProcessorConfig")({
  collapseWhitespace: Schema.optional(Schema.Boolean),
  preserveEmptyText: Schema.optional(Schema.Boolean),
  strictValidation: Schema.optional(Schema.Boolean),
}) {}
