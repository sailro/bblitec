#!/usr/bin/env node
/**
 * The `bblitec` command: the compiler (`cli.js`) under its Node flags
 * (`COMPILER_NODE_FLAGS`), which V8 reads only at startup. A process
 * started with them runs the compiler in place; another starts it again
 * with them, before loading it.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
    COMPILER_NODE_FLAGS,
    startedWithCompilerNodeFlags,
} from "./compiler-node-flags.js";

if (startedWithCompilerNodeFlags()) {
    await import("./cli.js");
} else {
    const { status, signal } = spawnSync(
        process.execPath,
        [
            ...COMPILER_NODE_FLAGS,
            ...process.execArgv,
            fileURLToPath(new URL("./cli.js", import.meta.url)),
            ...process.argv.slice(2),
        ],
        { stdio: "inherit" },
    );
    process.exitCode = status ?? (signal ? 1 : 0);
}
