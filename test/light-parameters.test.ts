import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { lightParameterHeader } from "../src/lowering/light-parameters.js";
import { LoweringContext } from "../src/lowering/context.js";
import { compileSource } from "../src/compiler.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { lightUniformsBlock } from "../src/pinned-pbr-variant-cpp.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("light parameter setters validate, preserve no-op writes and update the source light", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/light-parameters-check");
    mkdirSync(directory, { recursive: true });
    const source = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        source,
        lightParameterHeader(new LoweringContext()) +
            `
#include <cassert>
int main(){
 bbl::LightRecord light;int version=0;const auto bump=[&]{++version;};
 bbl::set_light_intensity(light,1,bump);assert(version==0);
 bbl::set_light_intensity(light,0.5,bump);assert(light.intensity==0.5f&&version==1);
 bbl::set_light_diffuse_color(light,{0.25,0.5,0.75},bump);assert(version==2&&light.diffuse_color.b==0.75f);
 bbl::set_light_diffuse_color(light,{0.25,0.5,0.75},bump);assert(version==2);
 bbl::set_light_intensity(light,0.1,bump);assert(version==3&&light.intensity==0.1);
 bbl::set_light_intensity(light,0.1,bump);assert(version==3);
 bbl::set_light_diffuse_color(light,{0.1,0.2,0.3},bump);assert(version==4&&light.diffuse_color.r==0.1&&light.diffuse_color.b==0.3);
 bbl::set_light_diffuse_color(light,{0.1,0.2,0.3},bump);assert(version==4);
 for(const auto invalid:{std::numeric_limits<double>::quiet_NaN(),std::numeric_limits<double>::infinity()}){
  bool threw=false;try{bbl::set_light_intensity(light,invalid,bump);}catch(const std::runtime_error&){threw=true;}assert(threw&&version==4&&light.intensity==0.1);
  threw=false;try{bbl::set_light_diffuse_color(light,{0.1,invalid,0.3},bump);}catch(const std::runtime_error&){threw=true;}assert(threw&&version==4&&light.diffuse_color.r==0.1);
 }
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        source,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
    const result = compileSource(
        `import {createEngine,createDirectionalLight,setLightDiffuseColor,setLightIntensity} from '@babylonjs/lite';const engine=await createEngine(document.querySelector('canvas')!);const light=createDirectionalLight([0,-1,0]);setLightIntensity(light,0.5);setLightDiffuseColor(light,[0.25,0.5,0.75]);`,
    );
    assert.ok(result.manifest.features.includes("light:parameters"));
});

test("light setters and source UBO retain doubles until the pinned Float32 stores", async (t) => {
    interface PinLight {
        intensity: number;
        diffuse: number[];
        _writeLightUbo(data: Float32Array, offset: number): void;
    }
    const factory = await importPinnedModule<{
        createDirectionalLight(
            direction: number[],
            intensity: number,
        ): PinLight;
    }>("light/directional-light.js");
    const intensitySetter = await importPinnedModule<{
        setLightIntensity(light: PinLight, value: number): void;
    }>("light/set-light-intensity.js");
    const colorSetter = await importPinnedModule<{
        setLightDiffuseColor(light: PinLight, value: number[]): void;
    }>("light/set-light-diffuse-color.js");
    const sky = await importPinnedModule<{
        computeProceduralSkySunColor(options: object): number[];
    }>("loader-env/procedural-sky-environment.js");
    const theta = Math.PI * (0.48 - 0.5),
        phi = 2 * Math.PI * (0.307 - 0.5);
    const oceanColor = sky.computeProceduralSkySunColor({
        sunDirection: [
            Math.cos(phi) * Math.cos(theta),
            Math.sin(-theta),
            Math.sin(phi) * Math.cos(theta),
        ],
        luminance: 1,
        turbidity: 10,
        rayleigh: 2,
        mieCoefficient: 0.005,
        mieDirectionalG: 0.8,
    });
    const samples = [
        { color: [0.1, 0.2, 0.3], intensity: 0.1 },
        { color: oceanColor, intensity: 0.45 },
        { color: [1e-30, 1e-40, 0.5], intensity: 1e40 },
    ].map(({ color, intensity }) => {
        const light = factory.createDirectionalLight([0, -1, 0], 1.15);
        intensitySetter.setLightIntensity(light, intensity);
        colorSetter.setLightDiffuseColor(light, color);
        const data = new Float32Array(16);
        light._writeLightUbo(data, 0);
        return {
            color,
            intensity,
            bits: [...new Uint32Array(data.buffer)].slice(4, 7),
        };
    });
    const early = Math.fround(Math.fround(oceanColor[2]!) * Math.fround(0.45));
    assert.notEqual(early, Math.fround(oceanColor[2]! * 0.45));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const directory = resolve("artifacts/light-parameters-width");
    const headers = resolve(directory, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const context = new LoweringContext(),
        lowerer = new LightLowerer(context);
    const matrix = lowerer.lowerMatrix();
    writeFileSync(resolve(headers, "light_matrix.hpp"), matrix.header);
    writeFileSync(
        resolve(headers, "pinned_world_transform.hpp"),
        pinnedWorldTransformHeader(context),
    );
    writeFileSync(
        resolve(headers, "pinned_matrix.hpp"),
        pinnedMatrixHeader(context),
    );
    writeFileSync(resolve(directory, "matrix.cpp"), matrix.source);
    writeFileSync(
        resolve(directory, "factory.cpp"),
        lowerer.lowerDirectionalFactory().source,
    );
    const file = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(
        file,
        lightParameterHeader(context) +
            `
#include <bblite/upstream/light_matrix.hpp>
#include <bit>
#include <cassert>
namespace bbl::upstream { ${lightUniformsBlock(context, 1, ["directional"])} }
int main(){
 bbl::Engine engine;
 const auto handle=bbl::create_directional_light(engine,{0,-1,0},1.15);
 auto& light=engine.lights.at(handle.value);assert(light.intensity==1.15);
 ${samples
     .map(
         ({ color, intensity, bits }) => `{
 bbl::set_light_intensity(light,${context.doubleLiteral(intensity)});
 bbl::set_light_diffuse_color(light,{${color.map((v) => context.doubleLiteral(v)).join(",")}});
 bbl::upstream::LightEntry out;bbl::upstream::write_pinned_light(light,out);
 ${bits.map((value, index) => `assert(std::bit_cast<std::uint32_t>(out.vLightDiffuse[${index}])==${value}u);`).join("\n")}
 }`,
     )
     .join("\n")}
}
`,
    );
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
        file,
        resolve(directory, "matrix.cpp"),
        resolve(directory, "factory.cpp"),
    ]);
    assert.equal(
        execFileSync(executable, { encoding: "utf8", timeout: 10000 }),
        "",
    );
});
