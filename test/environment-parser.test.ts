import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { sharedPinnedContext } from "../src/lowering/context.js";
import { EnvironmentLowerer } from "../src/lowering/environment-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("environment manifests use JSON structure and validate native byte ranges", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const directory = resolve("artifacts/environment-parser");
    const headers = join(directory, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const parser = new EnvironmentLowerer(sharedPinnedContext()).lowerParser();
    writeFileSync(join(headers, "env_parse.hpp"), parser.header);
    const source = join(directory, "env_parse.cpp");
    writeFileSync(source, parser.source);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        `/I${directory}`,
        `/Fo${directory}\\`,
        `/Fe${executable}`,
        source,
        resolve("test/fixtures/environment-parser-check.cpp"),
    ]);
    const manifest = (positionFirst: boolean) => ({
        width: 1,
        irradiance: Object.fromEntries(
            ["x", "y", "z", "xx", "yy", "zz", "yz", "zx", "xy"].map((key) => [
                key,
                [0, 0, 0],
            ]),
        ),
        specular: {
            mipmaps: Array.from({ length: 6 }, (_, position) =>
                positionFirst
                    ? { position, length: 1 }
                    : { length: 1, position },
            ),
        },
    });
    const run = (name: string, text: string, valid: boolean): void => {
        const path = join(directory, `${name}.env`);
        writeFileSync(
            path,
            Buffer.concat([
                Buffer.from([0x86, 0x16, 0x87, 0x96, 0xf6, 0xd6, 0x96, 0x36]),
                Buffer.from(text),
                Buffer.from([0, 11, 12, 13, 14, 15, 16]),
            ]),
        );
        const result = spawnSync(executable, [path], {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
        });
        assert.ifError(result.error);
        assert.equal(result.status, valid ? 0 : 2, `${name}: ${result.stderr}`);
        if (valid)
            assert.equal(
                result.stdout.trim(),
                "1 1 [11,] [12,] [13,] [14,] [15,] [16,]",
            );
    };
    const text = JSON.stringify(manifest(false));
    run("length-first", text, true);
    run("position-first", JSON.stringify(manifest(true)), true);
    run("escaped-key", text.replace('"width"', '"wi\\u0064th"'), true);
    for (const value of ["NaN", "Infinity", "1e400", "-1", "4294967296", "1.5"])
        run(
            `width-${value}`,
            text.replace('"width":1', `"width":${value}`),
            false,
        );
    for (const value of [
        "-1",
        "1e400",
        "18446744073709551616",
        "18446744073709549568",
        "7",
    ])
        for (const key of ["position", "length"])
            run(
                `${key}-${value}`,
                text.replace(
                    `"${key}":${key === "position" ? 0 : 1}`,
                    `"${key}":${value}`,
                ),
                false,
            );
    run(
        "truncated-coefficient",
        text.replace('"x":[0,0,0]', '"x":[0,0]'),
        false,
    );
    run("missing-comma", text.replace('"x":[0,0,0]', '"x":[0 0 0]'), false);
    run(
        "malformed-mip-array",
        text.replace('"mipmaps":[', '"mipmaps":{'),
        false,
    );
    run("missing-specular", text.replace('"specular":', '"other":'), false);
});
