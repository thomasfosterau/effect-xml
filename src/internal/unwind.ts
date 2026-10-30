/**
 * The tree builders' one exception boundary.
 *
 * The HTML tree builders enforce `limits.maxDepth` from deep inside the
 * WHATWG algorithm (every push onto the stack of open elements), where there
 * is no result to thread a failure through: they throw the
 * {@link LimitExceeded} and this turns it back into a value, once per drive
 * loop or stream chunk. A plain `try`/`catch` costs nothing on the path that
 * doesn't throw; `Result.try` allocated per event and showed up as a third of
 * `Html.parseDocument`'s time.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { LimitExceeded } from "../Error.ts";

/**
 * Run a tree builder's whole drive loop inside one boundary: the loop's own
 * result, or the {@link LimitExceeded} the builder throws. One `try` around
 * the loop costs less than a closure per token.
 */
export const tryDrive = <A>(drive: () => A): A | LimitExceeded => {
  try {
    return drive();
  } catch (e) {
    if (e instanceof LimitExceeded) return e;
    throw e;
  }
};

/**
 * Hand every element of `events` to a tree builder's `accept`, failing at the
 * first limit it hits. A chunk at a time, inside one boundary: an `Effect` per
 * event cost the lenient fragment parse a third of its time.
 */
export const acceptAll = <A, E, R>(
  events: Stream.Stream<A, E, R>,
  accept: (event: A) => void,
): Effect.Effect<void, LimitExceeded | E, R> =>
  Stream.runForEachArray(events, (chunk) =>
    Effect.suspend(() => {
      const over = tryDrive(() => {
        Arr.forEach(chunk, (event) => accept(event));
        return null;
      });
      return over === null ? Effect.void : Effect.fail(over);
    }),
  );
