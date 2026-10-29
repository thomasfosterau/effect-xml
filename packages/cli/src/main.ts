#!/usr/bin/env node
/**
 * The `effect-xml-xsd` executable.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Command from "effect/cli/Command";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { xsd } from "./Cli.ts";
import packageJson from "../package.json" with { type: "json" };

xsd.pipe(
  Command.run({ version: packageJson.version }),
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
