/**
 * The tree builders' one exception boundary.
 *
 * The HTML tree builders enforce `limits.maxDepth` from deep inside the
 * WHATWG algorithm (every push onto the stack of open elements), where there
 * is no result to thread a failure through: they throw the
 * {@link LimitExceeded} and this turns it back into a value, once per event.
 * A plain `try`/`catch` costs nothing on the path that doesn't throw;
 * `Result.try` allocated per event and showed up as a third of
 * `Html.parseDocument`'s time.
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { LimitExceeded } from "../Error.ts";

/** Run a tree-builder step, returning the {@link LimitExceeded} it throws, if any. */
export const tryAccept = (accept: () => void): LimitExceeded | null => {
  try {
    accept();
    return null;
  } catch (e) {
    // Anything else a builder throws is a defect, and stays one.
    if (e instanceof LimitExceeded) return e;
    throw e;
  }
};

/** Hand every element of `events` to a tree builder's `accept`, failing at the first limit it hits. */
export const acceptAll = <A, E, R>(
  events: Stream.Stream<A, E, R>,
  accept: (event: A) => void,
): Effect.Effect<void, LimitExceeded | E, R> =>
  Stream.runForEach(events, (event) =>
    Effect.suspend(() => {
      const over = tryAccept(() => accept(event));
      return over === null ? Effect.void : Effect.fail(over);
    }),
  );
