import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerProceduralSkyAtmosphere } from "../src/lowering/procedural-sky-atmosphere.js";
import { lowerProceduralSkyLoader } from "../src/lowering/procedural-sky-loader.js";
import { lowerProceduralSkyUpdate } from "../src/lowering/procedural-sky-update.js";
import { proceduralSkyGpuSource } from "../src/lowering/procedural-sky-gpu.js";
import { lowerComputeTextureMipmaps } from "../src/lowering/compute-texture-mipmaps-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("source sky lifecycle preserves publication, revision cancellation, resource ownership and failure cleanup", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const directory = resolve("artifacts/procedural-sky-lifecycle-check");
    mkdirSync(join(directory, "bblite/upstream"), { recursive: true });
    const context = new LoweringContext(),
        atmosphere = lowerProceduralSkyAtmosphere(context),
        gpu = proceduralSkyGpuSource(context);
    writeFileSync(
        join(directory, "bblite/upstream/procedural_sky_atmosphere.hpp"),
        atmosphere.header,
    );
    const source = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(
        source,
        [
            atmosphere.source,
            lowerProceduralSkyLoader(
                context,
                "make_procedural_sky_descriptor()",
                gpu.source,
            ).source,
            lowerProceduralSkyUpdate(context).source,
            lowerComputeTextureMipmaps(context).source,
            readFileSync(
                resolve("test/fixtures/procedural-sky-lifecycle-check.cpp"),
                "utf8",
            ),
        ].join("\n"),
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/O2",
        "/Gy",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        source,
        `/Fo${directory}/`,
        `/Fe${exe}`,
        "/link",
        "/OPT:REF",
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 30000 }), "");
});
