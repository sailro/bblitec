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
    runGeneratedProgram,
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
    runGeneratedProgram(
        tools,
        "procedural-sky-lifecycle-check",
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
        {
            flags: [
                "/O2",
                "/DBBLITE_WORKERS=1",
                "/DBBLITE_OFFSCREEN_SURFACES=1",
                `/I${directory}`,
            ],
            timeoutMs: 30000,
            expectedOutput: "",
        },
    );
});
