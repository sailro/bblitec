import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools();

test(
    "source profiling preserves startup attribution and allocations before each thread's first frame",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/source-profile-check");
        mkdirSync(output, { recursive: true });
        const executable = join(output, "source-profile-check.exe");
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/O2",
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            "/I",
            "native/include",
            "test/fixtures/source-profile-check.cpp",
            "native/src/pal_source_profile.cpp",
        ]);
        const result = spawnSync(executable, [], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10_000,
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /source-profile-check: ok/);
        const lines = result.stderr.split(/\r?\n/);
        const startup = lines.filter((line) =>
            line.startsWith("[cpu][source-startup]"),
        );
        assert.equal(startup.length, 3);
        for (const name of ["startup", "nested", "worker-startup"])
            assert.equal(
                startup.filter((line) =>
                    line.includes(`function=${name} calls=1 `),
                ).length,
                1,
            );
        assert.equal(
            lines.filter((line) => line.startsWith("[cpu][alloc-startup]"))
                .length,
            2,
        );
        const frame = lines.filter((line) => line.startsWith("[cpu][source]"));
        assert.equal(frame.length, 1);
        assert.match(frame[0]!, /frame=0 function=frame calls=1 /);
        assert.equal(
            lines.filter((line) => line.startsWith("[cpu][alloc] frame=0 "))
                .length,
            1,
        );
        assert.doesNotMatch(result.stderr, /(?:nan|inf)(?:\s|$)/i);
    },
);
