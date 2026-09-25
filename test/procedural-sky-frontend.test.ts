import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerProceduralSkyAtmosphere } from "../src/lowering/procedural-sky-atmosphere.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const sourceOptions = `{sunDirection: direction(), luminance: settings.luminance, turbidity: 10, rayleigh: 2, mieCoefficient: 0.005, mieDirectionalG: 0.8}`;
const sourceSetup = `const settings={luminance:1};let calls=0;
function direction():[number,number,number]{calls++;return [0.2,0.8,-0.3];}
function options(){return ${sourceOptions};}`;

test("procedural sun frontend preserves runtime options, tuple identity and pinned arithmetic", async (t) => {
    const pin = await importPinnedModule<{
        computeProceduralSkySunColor(options: object): number[];
    }>("loader-env/procedural-sky-environment.js");
    const expected = [1, 0.7].map((luminance) =>
        pin.computeProceduralSkySunColor({
            sunDirection: [0.2, 0.8, -0.3],
            luminance,
            turbidity: 10,
            rayleigh: 2,
            mieCoefficient: 0.005,
            mieDirectionalG: 0.8,
        }),
    );
    const source = `import {computeProceduralSkySunColor} from "@babylonjs/lite";
${sourceSetup}
const first=computeProceduralSkySunColor(options());settings.luminance=0.7;
const second=computeProceduralSkySunColor(options());
if(calls!==2)throw new Error("Options evaluated more than once");
${expected.flatMap((color, index) => color.map((value, lane) => `if(Math.abs(${index === 0 ? "first" : "second"}[${lane}]-${value})>1e-12)throw new Error("Atmosphere options ${index}/${lane}");`)).join("\n")}
first[0]=12;if(second[0]===12)throw new Error("Color tuple identity shared");`;
    const result = compileSource(source);
    assert.ok(result.manifest.features.includes("environment:sky-atmosphere"));
    assert.ok(!result.manifest.features.includes("environment:procedural-sky"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/procedural-sky-frontend");
    mkdirSync(join(directory, "bblite/upstream"), { recursive: true });
    const generated = lowerProceduralSkyAtmosphere(new LoweringContext());
    writeFileSync(
        join(directory, "bblite/upstream/procedural_sky_atmosphere.hpp"),
        generated.header,
    );
    writeFileSync(join(directory, "atmosphere.cpp"), generated.source);
    writeFileSync(join(directory, "check.cpp"), result.cpp);
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        `/Fo${directory}/`,
        `/Fe${executable}`,
        join(directory, "check.cpp"),
        join(directory, "atmosphere.cpp"),
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});

test("procedural environment frontend retains async handles, updates and a packaged BRDF", (t) => {
    const directory = resolve("artifacts/procedural-sky-frontend");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const source = `import {createEngine,createSceneContext,loadProceduralSkyEnvironment,updateProceduralSkyEnvironment,type ProceduralSkyEnvironment} from "@babylonjs/lite";
import {demoAssetUrl} from "../../corpus/babylon-lite/lab/lite/src/demos/demo-asset-url.js";
const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
const engine=await createEngine(document.createElement("canvas"));const scene=createSceneContext(engine);
${sourceSetup}
const environment=await loadProceduralSkyEnvironment(scene,{...options(),brdfUrl:demoAssetUrl("./brdf-lut.png",import.meta.url)});
async function update(value:ProceduralSkyEnvironment){return await updateProceduralSkyEnvironment(value,options());}
const holder:{environment:ProceduralSkyEnvironment}={environment};
settings.luminance=0.7;const applied=await update(holder.environment);if(!applied)throw new Error("Update not applied");`;
    const result = compileSource(source, {
        fileName: join(directory, "entry.ts"),
    });
    assert.ok(result.manifest.features.includes("environment:procedural-sky"));
    assert.equal(
        result.manifest.assets.filter((asset) =>
            asset.source.endsWith("brdf-lut.png"),
        ).length,
        1,
    );
    assert.match(result.cpp, /std::shared_ptr<bbl::ProceduralSkyEnvironment>/);
    assert.match(result.cpp, /bbl::update_procedural_sky_environment/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const generated = lowerProceduralSkyAtmosphere(new LoweringContext());
    mkdirSync(join(directory, "bblite/upstream"), { recursive: true });
    writeFileSync(
        join(directory, "bblite/upstream/procedural_sky_atmosphere.hpp"),
        generated.header,
    );
    const cpp = join(directory, "async.cpp");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/Zs",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_HAS_UI=1",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        cpp,
    ]);
});

test("procedural sky refuses missing atmosphere fields and unrepresented options", () => {
    for (const [change, expected] of [
        [
            sourceOptions.replace("luminance: settings.luminance, ", ""),
            /requires option luminance/,
        ],
        [
            sourceOptions.replace("turbidity: 10", 'turbidity: "ten"'),
            /requires a number/,
        ],
        [
            sourceOptions.replace(
                "sunDirection: direction()",
                "sunDirection: [1,2]",
            ),
            /tuple of three/,
        ],
        [
            sourceOptions.replace(
                "mieDirectionalG: 0.8",
                "mieDirectionalG: 0.8, _yield: () => Promise.resolve()",
            ),
            /Unrepresented procedural sky option _yield/,
        ],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    `import {computeProceduralSkySunColor} from "@babylonjs/lite";${sourceSetup}computeProceduralSkySunColor(${change});`,
                ),
            expected,
        );
});
