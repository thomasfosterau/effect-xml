/**
 * The conformance gates' opt-in failure reports (`HTML5LIB_REPORT=1`,
 * `XMLCONF_REPORT=1`, `QT3_REPORT=1`), read through `Config` from the
 * environment.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

/** Whether the environment variable `name` is set to a non-empty value. */
export const reportRequested = (name: string): Effect.Effect<boolean> =>
  Config.String(name).pipe(
    Config.withDefault(""),
    Effect.map((value) => value !== ""),
    Effect.orElseSucceed(() => false),
  );
