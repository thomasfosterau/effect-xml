/**
 * Reactive message stream interface
 * Provides composable operations on XML message streams
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "@effect/schema/Schema";
import type { StreamMessage, ProcessorConfig } from "./messages";
import {
  ElementStart,
  ElementEnd,
  ContentChunk,
} from "./messages";
import { processMarkup } from "./processor";

/**
 * Processing failure indicator
 */
export class ProcessingFailure {
  readonly _tag = "ProcessingFailure";
  constructor(
    readonly reason: string,
    readonly location?: number
  ) {}
}

/**
 * Create reactive message stream from markup string
 */
export const createMessageStream = (
  markup: string,
  config: ProcessorConfig = {}
): Stream.Stream<StreamMessage, ProcessingFailure> => {
  const shouldCollapse = config.collapseWhitespace ?? true;
  const keepEmpty = config.preserveEmptyText ?? false;

  return Stream.mapEffect(
    Stream.fromEffect(processMarkup(markup)).pipe(
      Stream.flatMap((msgChunk) => Stream.fromChunk(msgChunk))
    ),
    (msg) =>
      Effect.sync(() => {
        // Apply transformations
        if (msg instanceof ContentChunk) {
          let transformed = msg.payload;
          if (shouldCollapse) {
            transformed = transformed.trim();
            transformed = transformed.replace(/\s+/g, " ");
          }
          return new ContentChunk({
            ...msg,
            payload: transformed,
          });
        }
        return msg;
      })
  ).pipe(
    // Filter empty content if needed
    Stream.filter((msg) => {
      if (!keepEmpty && msg instanceof ContentChunk && msg.payload.length === 0) {
        return false;
      }
      return true;
    })
  );
};

/**
 * Collect all messages into array
 */
export const collectMessages = (
  markup: string,
  config: ProcessorConfig = {}
): Effect.Effect<StreamMessage[], ProcessingFailure> => {
  return createMessageStream(markup, config).pipe(
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk))
  );
};

/**
 * Isolate element start messages
 */
export const isolateStarts = (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>
): Stream.Stream<ElementStart, ProcessingFailure> => {
  return Stream.filter(
    msgStream,
    (msg): msg is ElementStart => msg instanceof ElementStart
  );
};

/**
 * Isolate element end messages
 */
export const isolateEnds = (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>
): Stream.Stream<ElementEnd, ProcessingFailure> => {
  return Stream.filter(
    msgStream,
    (msg): msg is ElementEnd => msg instanceof ElementEnd
  );
};

/**
 * Isolate content messages
 */
export const isolateContent = (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>
): Stream.Stream<ContentChunk, ProcessingFailure> => {
  return Stream.filter(
    msgStream,
    (msg): msg is ContentChunk => msg instanceof ContentChunk
  );
};

/**
 * Select messages by tag identifier
 */
export const selectByTag = (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>,
  tagId: string
): Stream.Stream<StreamMessage, ProcessingFailure> => {
  return Stream.filter(msgStream, (msg) => {
    if (msg instanceof ElementStart || msg instanceof ElementEnd) {
      return msg.tagIdentifier === tagId;
    }
    return false;
  });
};

/**
 * Harvest text content between matching tags
 */
export const harvestTagContent = (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>,
  tagId: string
): Stream.Stream<string, ProcessingFailure> => {
  return Stream.mapAccum(
    msgStream,
    { active: false, accumulator: "" },
    (state, msg) => {
      if (msg instanceof ElementStart && msg.tagIdentifier === tagId) {
        return [{ active: true, accumulator: "" }, null];
      }
      if (msg instanceof ElementEnd && msg.tagIdentifier === tagId && state.active) {
        const harvested = state.accumulator;
        return [{ active: false, accumulator: "" }, harvested];
      }
      if (state.active && msg instanceof ContentChunk) {
        return [
          { active: true, accumulator: state.accumulator + msg.payload },
          null,
        ];
      }
      return [state, null];
    }
  ).pipe(Stream.filter((value): value is string => value !== null));
};

/**
 * Apply schema validation to messages
 */
export const applyValidation = <T>(
  validator: Schema.Schema<T, StreamMessage>
) => (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>
): Stream.Stream<T, ProcessingFailure | Schema.ParseError> => {
  return Stream.mapEffect(msgStream, (msg) => Schema.decode(validator)(msg));
};

/**
 * Quantify occurrences of specific tag
 */
export const quantifyTag = (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>,
  tagId: string
): Effect.Effect<number, ProcessingFailure> => {
  return msgStream.pipe(
    Stream.filter(
      (msg) => msg instanceof ElementStart && msg.tagIdentifier === tagId
    ),
    Stream.runCount
  );
};

/**
 * Aggregate property bags from matching tags
 */
export const aggregateProperties = (
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>,
  tagId: string
): Effect.Effect<Record<string, string>[], ProcessingFailure> => {
  return msgStream.pipe(
    Stream.filter(
      (msg): msg is ElementStart =>
        msg instanceof ElementStart && msg.tagIdentifier === tagId
    ),
    Stream.map((msg) => msg.propertyBag),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk))
  );
};

/**
 * Transform stream with custom mapper
 */
export const transformStream = <T>(
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>,
  mapper: (msg: StreamMessage) => T
): Stream.Stream<T, ProcessingFailure> => {
  return Stream.map(msgStream, mapper);
};

/**
 * Fold messages into accumulated state
 */
export const foldMessages = <S>(
  msgStream: Stream.Stream<StreamMessage, ProcessingFailure>,
  initialState: S,
  reducer: (state: S, msg: StreamMessage) => S
): Effect.Effect<S, ProcessingFailure> => {
  return Stream.runFold(msgStream, initialState, reducer);
};
