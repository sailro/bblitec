import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";

const tools = discoverDevelopmentTools();

test(
    "build parallel arguments splat as whole tokens",
    { skip: !tools.powershell },
    () => {
        assert.ok(tools.powershell);
        // Splatting a string passes one character per argument, so both the
        // default and an explicit job count must stay arrays.
        const script = `
        $ErrorActionPreference = 'Stop'
        Import-Module '${resolve("tools/bblite-tools.psm1").replaceAll("'", "''")}' -Force
        Remove-Item Env:CMAKE_BUILD_PARALLEL_LEVEL -ErrorAction SilentlyContinue
        $default = Get-BuildParallelArguments
        $explicit = Get-BuildParallelArguments 8
        $printer = 'console.log(JSON.stringify(process.argv.slice(1)))'
        $a = & node -e $printer -- @default
        $b = & node -e $printer -- @explicit
        "$a|$b"
    `;
        const result = spawnSync(
            tools.powershell,
            ["-NoProfile", "-NonInteractive", "-Command", script],
            { encoding: "utf8" },
        );
        assert.equal(result.status, 0, result.stderr);
        const [first, second] = result.stdout.trim().split("|");
        assert.deepEqual(JSON.parse(first ?? ""), ["--parallel"]);
        assert.deepEqual(JSON.parse(second ?? ""), ["--parallel", "8"]);
    },
);
