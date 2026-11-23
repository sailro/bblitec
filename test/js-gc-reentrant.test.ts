import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import test from "node:test";
import { runCaptured } from "../src/tooling/logged-process.js";
import {
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const tools = optionalNativeFixtureTools(false);
const asan = process.env.BBLITE_GC_ASAN === "1";
if (asan && !tools)
    throw new Error(
        "BBLITE_GC_ASAN requires the Windows clang-cl fixture compiler.",
    );
const runtimeDirectory =
    asan && tools
        ? runCaptured(
              tools.compiler,
              ["--print-runtime-dir"],
              "Find clang-cl's ASan runtime",
          ).trim()
        : undefined;

for (const [name, fixture, expected] of [
    [
        "WeakMap traces values only through reachable keys and owners",
        "js-gc-ephemeron-check",
        "gc-ephemerons: ok",
    ],
    [
        "GC shared storage preserves alignment and refuses allocation size overflow",
        "js-gc-allocation-check",
        "gc-allocation: ok",
    ],
    [
        "GC publishes complete owners and unlinks payloads before reentrant destruction",
        "js-gc-reentrant-check",
        "gc-reentrant-lifetime: ok",
    ],
    [
        "GC reclaims realm storage before late static owner destruction",
        "js-gc-shutdown-check",
        "gc-shutdown-lifetime: ok",
    ],
    [
        "GC preserves exact ownership and unwinds failed registry growth",
        "ref-gc-ownership-check",
        "ref-gc-ownership-check: ok (Ref=1 allocation, weak token=1, shared=1; untraced payloads and closures unregistered; cycle edges=2/2, collected=2; registry and allocations restored)",
    ],
] as const)
    test(name, (t) => {
        if (!tools) {
            t.skip("Native fixture compiler unavailable.");
            return;
        }
        const directory = resolve("artifacts", fixture, asan ? "asan" : ".");
        mkdirSync(directory, { recursive: true });
        const executable = join(directory, "check.exe");
        runNativeFixtureCompiler(tools, [
            ...(asan ? ["-fsanitize=address"] : []),
            `/Fo${directory}\\`,
            `/Fe${executable}`,
            resolve("test", "fixtures", `${fixture}.cpp`),
        ]);
        assert.equal(
            runFixtureExecutable(executable, {
                ...(runtimeDirectory && {
                    env: {
                        ...process.env,
                        PATH:
                            runtimeDirectory +
                            delimiter +
                            (process.env.PATH ?? ""),
                    },
                }),
                timeoutMs: 10000,
            }).trim(),
            expected,
        );
    });
