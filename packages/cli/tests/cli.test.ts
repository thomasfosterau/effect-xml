import { assert, expect } from "vite-plus/test";
import { layer } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Command from "effect/cli/Command";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Xsd } from "@thomasfosterau/effect-xml";
import { xsd } from "../src/Cli.ts";
import { generate, RemoteLocationRefused, StaleOutput } from "../src/Generate.ts";

const XS = `xmlns:xs="http://www.w3.org/2001/XMLSchema"`;
const REMOTE = "https://schemas.example/common.xsd";
const common = `<xs:schema ${XS}><xs:simpleType name="Code"><xs:restriction base="xs:token"/></xs:simpleType></xs:schema>`;

/** A `fetch` that serves the one remote document, counting the requests. */
const requests: Array<string> = [];
const fetchStub: typeof globalThis.fetch = (input) => {
  const url = input instanceof Request ? input.url : String(input);
  requests.push(url);
  return Promise.resolve(
    url === REMOTE ? new Response(common) : new Response("not found", { status: 404 }),
  );
};

/** The services every test uses, built once per block. */
const services = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub))),
);

/** Run a program with a fresh temporary directory, its path passed in. */
const inTemp = <A, E, R>(f: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* f(yield* fs.makeTempDirectoryScoped());
    }),
  );

const write = Effect.fnUntraced(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, text);
});
const read = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path);
});

const exampleSchema = new URL("../../../examples/xsd/order.xsd", import.meta.url).pathname;
const exampleModule = new URL("../../../examples/xsd/order.generated.ts", import.meta.url).pathname;

/** How `--check` fails against the example schema with `out` as the module. */
const checkFailure = (out: string) =>
  Effect.flip(generate({ schema: exampleSchema, out, check: true }));

layer(services)("generate", (it) => {
  it.effect("writes the module Xsd.generate makes, naming the schema relative to it", () =>
    Effect.gen(function* () {
      const [outcome, written, expected] = yield* inTemp((dir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const schema = `${dir}/order.xsd`;
          yield* fs.copyFile(exampleSchema, schema);
          yield* fs.makeDirectory(`${dir}/out`);
          const result = yield* generate({ schema, out: `${dir}/out/order.ts` });
          const model = yield* Xsd.compile(yield* read(schema));
          const generated = yield* Xsd.generate(model, { source: "../order.xsd" });
          return [result, yield* read(`${dir}/out/order.ts`), generated] as const;
        }),
      );
      expect(outcome).toBe("written");
      expect(written).toBe(expected);
    }),
  );

  it.effect("the committed example is fresh (--check)", () =>
    Effect.gen(function* () {
      const outcome = yield* inTemp(() =>
        generate({
          schema: exampleSchema,
          out: exampleModule,
          importFrom: "../../src/index.ts",
          check: true,
        }),
      );
      expect(outcome).toBe("unchanged");
    }),
  );

  it.effect("--check fails on a stale or missing module", () =>
    Effect.gen(function* () {
      const failures = yield* inTemp((dir) =>
        Effect.gen(function* () {
          const stale = `${dir}/stale.ts`;
          yield* write(stale, "// old\n");
          return [
            yield* checkFailure(stale),
            yield* checkFailure(`${dir}/missing.ts`),
            yield* read(stale),
          ] as const;
        }),
      );
      const [stale, missing, unchanged] = failures;
      expect(stale).toBeInstanceOf(StaleOutput);
      expect(missing).toBeInstanceOf(StaleOutput);
      expect(stale.message).toContain("stale.ts is out of date");
      // Check mode never writes.
      expect(unchanged).toBe("// old\n");
    }),
  );

  it.effect("--root limits the parsers written", () =>
    Effect.gen(function* () {
      const written = yield* inTemp((dir) =>
        Effect.gen(function* () {
          yield* write(
            `${dir}/two.xsd`,
            `<xs:schema ${XS}><xs:element name="a" type="xs:string"/><xs:element name="b" type="xs:int"/></xs:schema>`,
          );
          yield* generate({ schema: `${dir}/two.xsd`, out: `${dir}/two.ts`, roots: ["b"] });
          return yield* read(`${dir}/two.ts`);
        }),
      );
      expect(written).toContain("export const b = ");
      expect(written).not.toContain("export const a = ");
    }),
  );

  it.effect("includes resolve relative to the schema; remote ones need --remote", () =>
    Effect.gen(function* () {
      const schema = (dir: string) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${dir}/sub`);
          yield* write(
            `${dir}/sub/local.xsd`,
            `<xs:schema ${XS}><xs:element name="local" type="xs:string"/></xs:schema>`,
          );
          yield* write(
            `${dir}/main.xsd`,
            `<xs:schema ${XS}><xs:include schemaLocation="sub/local.xsd"/><xs:include schemaLocation="${REMOTE}"/>` +
              `<xs:element name="code" type="Code"/></xs:schema>`,
          );
          return `${dir}/main.xsd`;
        });
      const [refused, fetched] = yield* inTemp((dir) =>
        Effect.gen(function* () {
          const main = yield* schema(dir);
          const failure = yield* Effect.flip(generate({ schema: main, out: `${dir}/a.ts` }));
          yield* generate({ schema: main, out: `${dir}/b.ts`, remote: true });
          return [failure, yield* read(`${dir}/b.ts`)] as const;
        }),
      );
      expect(refused).toBeInstanceOf(RemoteLocationRefused);
      expect(refused.message).toContain("pass --remote");
      expect(fetched).toContain("export const Code = Schema.String;");
      expect(fetched).toContain("export const local = ");
      expect(requests).toContain(REMOTE);
    }),
  );
});

layer(services)("effect-xml-xsd", (it) => {
  const cli = Command.runWith(xsd, { version: "0.0.0", renderErrors: false });

  it.effect("generate writes the module", () =>
    Effect.gen(function* () {
      const written = yield* inTemp((dir) =>
        Effect.gen(function* () {
          yield* cli(["generate", exampleSchema, "-o", `${dir}/order.ts`]);
          return yield* read(`${dir}/order.ts`);
        }),
      );
      expect(written).toContain("export const order = ");
    }),
  );

  it.effect("generate --check exits with a user error when stale", () =>
    Effect.gen(function* () {
      const result = yield* inTemp((dir) =>
        Effect.gen(function* () {
          yield* write(`${dir}/order.ts`, "");
          return yield* Effect.result(
            cli(["generate", exampleSchema, "--out", `${dir}/order.ts`, "--check"]),
          );
        }),
      );
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("UserError");
      expect(result.failure.message).toContain("is out of date");
    }),
  );
});
