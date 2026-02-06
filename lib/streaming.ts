/**
 * Main streaming interface for XML processing
 */
import * as Eff from "effect/Effect";
import * as Str from "effect/Stream";
import * as S from "@effect/schema/Schema";
import type { XmlSignal, StreamConfig } from "./schema";
import {
  TagOpened,
  TagClosed,
  CharData,
  ParseFailure,
} from "./schema";
import { scanXmlContent } from "./scanner";

/**
 * Failure during stream processing
 */
export class StreamProcessError {
  readonly _tag = "StreamProcessError";
  constructor(
    readonly details: string,
    readonly pos?: number
  ) {}
}

/**
 * Generate signal stream from XML string input
 */
export const generateSignalStream = (
  xmlInput: string,
  cfg: StreamConfig = {}
): Str.Stream<XmlSignal, StreamProcessError> => {
  const shouldTrim = cfg.trimWhitespace ?? true;
  const shouldNormalize = cfg.normalizeSpaces ?? true;

  return Str.mapEffect(
    Str.fromEffect(
      Eff.map(scanXmlContent(xmlInput), (signalChunk) => Str.fromChunk(signalChunk))
    ).pipe(Str.flattenChunks),
    (signal) =>
      Eff.sync(() => {
        // Apply content transformations
        if (signal instanceof CharData) {
          let processedContent = signal.content;
          if (shouldTrim) {
            processedContent = processedContent.trim();
          }
          if (shouldNormalize) {
            processedContent = processedContent.replace(/\s+/g, " ");
          }
          return new CharData({ content: processedContent });
        }
        return signal;
      })
  ).pipe(
    // Remove empty character data if trimming enabled
    Str.filter((signal) => {
      if (shouldTrim && signal instanceof CharData && !signal.content) {
        return false;
      }
      return true;
    })
  );
};

/**
 * Parse XML and accumulate signals into array
 */
export const gatherSignals = (
  xmlInput: string,
  cfg: StreamConfig = {}
): Eff.Effect<XmlSignal[], StreamProcessError> => {
  return generateSignalStream(xmlInput, cfg).pipe(
    Str.runCollect,
    Eff.map((chunk) => Array.from(chunk))
  );
};

/**
 * Keep only tag opening signals
 */
export const keepOpenings = (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>
): Str.Stream<TagOpened, StreamProcessError> => {
  return Str.filter(signalFlow, (sig): sig is TagOpened => sig instanceof TagOpened);
};

/**
 * Keep only tag closing signals
 */
export const keepClosings = (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>
): Str.Stream<TagClosed, StreamProcessError> => {
  return Str.filter(signalFlow, (sig): sig is TagClosed => sig instanceof TagClosed);
};

/**
 * Keep only character data signals
 */
export const keepCharData = (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>
): Str.Stream<CharData, StreamProcessError> => {
  return Str.filter(signalFlow, (sig): sig is CharData => sig instanceof CharData);
};

/**
 * Select signals matching element identifier
 */
export const selectByElement = (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>,
  elemId: string
): Str.Stream<XmlSignal, StreamProcessError> => {
  return Str.filter(signalFlow, (sig) => {
    if (sig instanceof TagOpened || sig instanceof TagClosed) {
      return sig.elementName === elemId;
    }
    return false;
  });
};

/**
 * Capture text between matching element tags
 */
export const captureElementText = (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>,
  elemId: string
): Str.Stream<string, StreamProcessError> => {
  return Str.mapAccum(
    signalFlow,
    { capturing: false, textBuffer: "" },
    (state, sig) => {
      if (sig instanceof TagOpened && sig.elementName === elemId) {
        return [{ capturing: true, textBuffer: "" }, null];
      }
      if (sig instanceof TagClosed && sig.elementName === elemId && state.capturing) {
        const captured = state.textBuffer;
        return [{ capturing: false, textBuffer: "" }, captured];
      }
      if (state.capturing && sig instanceof CharData) {
        return [
          { capturing: true, textBuffer: state.textBuffer + sig.content },
          null,
        ];
      }
      return [state, null];
    }
  ).pipe(Str.filter((val): val is string => val !== null));
};

/**
 * Validate signals using schema
 */
export const validateWithSchema = <A>(
  schemaValidator: S.Schema<A, XmlSignal>
) => (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>
): Str.Stream<A, StreamProcessError | S.ParseError> => {
  return Str.mapEffect(signalFlow, (sig) => S.decode(schemaValidator)(sig));
};

/**
 * Count occurrences of specific element
 */
export const countElement = (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>,
  elemId: string
): Eff.Effect<number, StreamProcessError> => {
  return signalFlow.pipe(
    Str.filter((sig) => sig instanceof TagOpened && sig.elementName === elemId),
    Str.runCount
  );
};

/**
 * Collect all element attributes
 */
export const gatherElementAttrs = (
  signalFlow: Str.Stream<XmlSignal, StreamProcessError>,
  elemId: string
): Eff.Effect<Record<string, string>[], StreamProcessError> => {
  return signalFlow.pipe(
    Str.filter(
      (sig): sig is TagOpened =>
        sig instanceof TagOpened && sig.elementName === elemId
    ),
    Str.map((sig) => sig.attrs),
    Str.runCollect,
    Eff.map((chunk) => Array.from(chunk))
  );
};
