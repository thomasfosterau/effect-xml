/**
 * The `effect-xml-xsd` command: its `generate` subcommand, the flags that map
 * onto `Xsd.GenerateOptions`, and how failures reach the user.
 *
 * @since 0.1.0
 */
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Argument from "effect/cli/Argument";
import * as CliError from "effect/cli/CliError";
import * as Command from "effect/cli/Command";
import * as Flag from "effect/cli/Flag";
import { generate as run } from "./Generate.ts";

/**
 * `effect-xml-xsd generate <schema.xsd> -o <out.ts>`: compile a schema and
 * write the typed parser module `Xsd.generate` makes from it.
 */
const generate = Command.make(
  "generate",
  {
    schema: Argument.String("schema").pipe(
      Argument.withDescription("The XML Schema (.xsd) to compile"),
    ),
    out: Flag.String("out").pipe(
      Flag.withAlias("o"),
      Flag.withDescription("The TypeScript module to write"),
    ),
    importFrom: Flag.String("import-from").pipe(
      Flag.withDescription(
        'The module the generated code imports the library from (default "@thomasfosterau/effect-xml")',
      ),
      Flag.optional,
    ),
    roots: Flag.String("root").pipe(
      Flag.withDescription(
        "A global element ({namespace}local) to write a parser for; repeat for several (default: all)",
      ),
      Flag.atLeast(0),
    ),
    remote: Flag.Boolean("remote").pipe(
      Flag.withDescription("Fetch include and import locations that are http(s) URLs"),
      Flag.withDefault(false),
    ),
    check: Flag.Boolean("check").pipe(
      Flag.withDescription(
        "Don't write: exit non-zero when the file on disk differs from what would be written",
      ),
      Flag.withDefault(false),
    ),
  },
  Effect.fn(function* (input) {
    const outcome = yield* run({
      schema: input.schema,
      out: input.out,
      importFrom: input.importFrom._tag === "Some" ? input.importFrom.value : undefined,
      roots: input.roots,
      remote: input.remote,
      check: input.check,
    }).pipe(
      Effect.mapError((cause) => new CliError.UserError({ cause, userMessage: cause.message })),
    );
    yield* Console.log(outcome === "written" ? `wrote ${input.out}` : `${input.out} is up to date`);
  }),
).pipe(
  Command.withDescription("Generate a typed parser module from an XML Schema"),
  Command.withExamples([
    {
      command: "effect-xml-xsd generate schemas/order.xsd -o src/order.generated.ts",
      description: "Write a module with a type per schema type and a parser per global element",
    },
    {
      command: "effect-xml-xsd generate schemas/order.xsd -o src/order.generated.ts --check",
      description: "Fail when the committed module is stale (for CI)",
    },
  ]),
);

/**
 * The `effect-xml-xsd` command, with its subcommands.
 *
 * @since 0.1.0
 * @category commands
 */
export const xsd = Command.make("effect-xml-xsd").pipe(
  Command.withDescription("XML Schema tools for @thomasfosterau/effect-xml"),
  Command.withSubcommands([generate]),
);
