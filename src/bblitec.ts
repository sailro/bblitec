#!/usr/bin/env node
/**
 * The `bblitec` command: the compiler (`cli.js`) under its Node flags
 * (`COMPILER_NODE_FLAGS`), which V8 reads only at startup, and the
 * conditions its `--condition`s name, which Node's loader reads only at
 * startup. A process started with both runs the compiler in place; another
 * starts it again with them, before loading it.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArguments } from "./cli-arguments.js";
import {
    buildConditionsEnvironment,
    buildsUnderConditions,
    COMPILER_NODE_FLAGS,
    execArgvWithoutConditions,
    startedWithCompilerNodeFlags,
} from "./compiler-node-flags.js";

let conditions: readonly string[] = [];
try {
    ({ conditions } = parseArguments(process.argv.slice(2)));
} catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
}
if (startedWithCompilerNodeFlags() && buildsUnderConditions(conditions)) {
    await import("./cli.js");
} else {
    const { status, signal } = spawnSync(
        process.execPath,
        [
            ...COMPILER_NODE_FLAGS,
            ...execArgvWithoutConditions(),
            fileURLToPath(new URL("./cli.js", import.meta.url)),
            ...process.argv.slice(2),
        ],
        { stdio: "inherit", env: buildConditionsEnvironment(conditions) },
    );
    process.exitCode = status ?? (signal ? 1 : 0);
}
