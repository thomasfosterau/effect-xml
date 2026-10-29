import { assert, describe, expect, test } from "vite-plus/test";
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

const layer = Layer.mergeAll(
  NodeServices.layer,
  FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub))),
);

/** Run a program with a fresh temporary directory, its path passed in. */
const inTemp = <A, E>(f: (dir: string) => Effect.Effect<A, E, Layer.Success<typeof layer>>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* f(yield* fs.makeTempDirectoryScoped());
      }),
    ).pipe(Effect.provide(layer)),
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

describe("generate", () => {
  test("writes the module Xsd.generate makes, naming the schema relative to it", async () => {
    const [outcome, written, expected] = await inTemp((dir) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const schema = `${dir}/order.xsd`;
        yield* fs.copyFile(exampleSchema, schema);
        yield* fs.makeDirectory(`${dir}/out`);
        const outcome = yield* generate({ schema, out: `${dir}/out/order.ts` });
        const model = yield* Xsd.compile(yield* read(schema));
        const expected = yield* Xsd.generate(model, { source: "../order.xsd" });
        return [outcome, yield* read(`${dir}/out/order.ts`), expected] as const;
      }),
    );
    expect(outcome).toBe("written");
    expect(written).toBe(expected);
  });

  test("the committed example is fresh (--check)", async () => {
    const outcome = await inTemp(() =>
      generate({
        schema: exampleSchema,
        out: exampleModule,
        importFrom: "../../src/index.ts",
        check: true,
      }),
    );
    expect(outcome).toBe("unchanged");
  });

  test("--check fails on a stale or missing module", async () => {
    const failures = await inTemp((dir) =>
      Effect.gen(function* () {
        const stale = `${dir}/stale.ts`;
        yield* write(stale, "// old\n");
        const run = (out: string) =>
          Effect.flip(generate({ schema: exampleSchema, out, check: true }));
        return [yield* run(stale), yield* run(`${dir}/missing.ts`), yield* read(stale)] as const;
      }),
    );
    const [stale, missing, unchanged] = failures;
    expect(stale).toBeInstanceOf(StaleOutput);
    expect(missing).toBeInstanceOf(StaleOutput);
    expect(stale.message).toContain("stale.ts is out of date");
    // Check mode never writes.
    expect(unchanged).toBe("// old\n");
  });

  test("--root limits the parsers written", async () => {
    const written = await inTemp((dir) =>
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
  });

  test("includes resolve relative to the schema; remote ones need --remote", async () => {
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
    const [refused, fetched] = await inTemp((dir) =>
      Effect.gen(function* () {
        const main = yield* schema(dir);
        const refused = yield* Effect.flip(generate({ schema: main, out: `${dir}/a.ts` }));
        yield* generate({ schema: main, out: `${dir}/b.ts`, remote: true });
        return [refused, yield* read(`${dir}/b.ts`)] as const;
      }),
    );
    expect(refused).toBeInstanceOf(RemoteLocationRefused);
    expect(refused.message).toContain("pass --remote");
    expect(fetched).toContain("export type Code = string;");
    expect(fetched).toContain("export const local = ");
    expect(requests).toContain(REMOTE);
  });
});

describe("effect-xml-xsd", () => {
  const cli = Command.runWith(xsd, { version: "0.0.0", renderErrors: false });

  test("generate writes the module", async () => {
    const written = await inTemp((dir) =>
      Effect.gen(function* () {
        yield* cli(["generate", exampleSchema, "-o", `${dir}/order.ts`]);
        return yield* read(`${dir}/order.ts`);
      }),
    );
    expect(written).toContain("export const order = ");
  });

  test("generate --check exits with a user error when stale", async () => {
    const result = await inTemp((dir) =>
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
  });
});
