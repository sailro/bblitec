import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { run } from "node:test";
import { tap } from "node:test/reporters";
import { parseArgs } from "node:util";
import { holdDistLock } from "../src/dist-lock.js";
import { testSuites } from "./test-suites.js";

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        list: { type: "boolean" },
        "test-concurrency": { type: "string" },
        "test-name-pattern": { type: "string", multiple: true },
        "test-skip-pattern": { type: "string", multiple: true },
    },
});
const suite = positionals[0];
if (
    positionals.length !== 1 ||
    (suite !== "fast" && suite !== "native" && suite !== "shaders")
)
    throw new Error(
        "Usage: run-suites fast|native|shaders [--list] [--test-concurrency N] [--test-name-pattern pattern]",
    );
const root = resolve(import.meta.dirname, "../..");
process.chdir(root);
const files = testSuites(resolve(root, "test"))[suite];
if (values.list) {
    console.log(files.join("\n"));
} else {
    const concurrency =
        values["test-concurrency"] === undefined
            ? true
            : Number(values["test-concurrency"]);
    if (
        concurrency !== true &&
        (!Number.isSafeInteger(concurrency) || concurrency < 1)
    )
        throw new Error("--test-concurrency must be a positive integer.");
    holdDistLock(`test:${suite}`);
    if (suite === "shaders") {
        const generation = spawnSync(
            process.execPath,
            ["dist/src/scene-command.js", "compile", "all"],
            {
                stdio: "inherit",
                windowsHide: true,
            },
        );
        if (generation.error) throw generation.error;
        if (generation.status !== 0) process.exit(generation.status ?? 1);
    }
    console.log(`# ${suite}: ${files.length} test files`);
    run({
        files: files.map((file) =>
            resolve(root, "dist/test", file.replace(/\.ts$/, ".js")),
        ),
        concurrency,
        ...(values["test-name-pattern"]
            ? { testNamePatterns: values["test-name-pattern"] }
            : {}),
        ...(values["test-skip-pattern"]
            ? { testSkipPatterns: values["test-skip-pattern"] }
            : {}),
    })
        .on("test:fail", () => {
            process.exitCode = 1;
        })
        .compose(tap)
        .pipe(process.stdout);
}
