/**
 * Schema definitions using Effect Schema
 */
import * as S from "@effect/schema/Schema";

// Element attribute mapping
export const AttributeMap = S.Record(S.String, S.String);
export type AttributeMap = S.Schema.Type<typeof AttributeMap>;

// Tag opening signal
export class TagOpened extends S.Class<TagOpened>("TagOpened")({
  elementName: S.String,
  attrs: AttributeMap,
  selfClosed: S.Boolean,
}) {}

// Tag closing signal
export class TagClosed extends S.Class<TagClosed>("TagClosed")({
  elementName: S.String,
}) {}

// Character data signal
export class CharData extends S.Class<CharData>("CharData")({
  content: S.String,
}) {}

// Annotation signal
export class Annotation extends S.Class<Annotation>("Annotation")({
  content: S.String,
}) {}

// CDATA block signal
export class CDataBlock extends S.Class<CDataBlock>("CDataBlock")({
  content: S.String,
}) {}

// Directive signal
export class Directive extends S.Class<Directive>("Directive")({
  targetName: S.String,
  directiveData: S.String,
}) {}

// DOCTYPE declaration
export class DocumentTypeDecl extends S.Class<DocumentTypeDecl>("DocumentTypeDecl")({
  content: S.String,
}) {}

// Parse failure signal
export class ParseFailure extends S.Class<ParseFailure>("ParseFailure")({
  reason: S.String,
  location: S.optional(S.Number),
}) {}

// Union of all signals
export const XmlSignal = S.Union(
  TagOpened,
  TagClosed,
  CharData,
  Annotation,
  CDataBlock,
  Directive,
  DocumentTypeDecl,
  ParseFailure
);
export type XmlSignal = S.Schema.Type<typeof XmlSignal>;

// Configuration for parser behavior
export class StreamConfig extends S.Class<StreamConfig>("StreamConfig")({
  trimWhitespace: S.optional(S.Boolean),
  normalizeSpaces: S.optional(S.Boolean),
  enforceStrict: S.optional(S.Boolean),
}) {}
