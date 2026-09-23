import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerProceduralSkyAtmosphere } from "../src/lowering/procedural-sky-atmosphere.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface SkyOptions {
    sunDirection: [number, number, number];
    luminance: number;
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
}

test("native procedural sky matches pinned atmosphere, irradiance and cancellation yields", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const pin = await importPinnedModule<{
        computeProceduralSkySunColor(this: void, options: SkyOptions): number[];
        _computeProceduralSkyIrradiance(
            this: void,
            options: SkyOptions,
            yieldTask: () => Promise<void>,
            isCurrent: () => boolean,
        ): Promise<Float32Array | null>;
    }>("loader-env/procedural-sky-environment.js");
    const cases: SkyOptions[] = [
        {
            sunDirection: [0.2, 0.8, -0.3],
            luminance: 1,
            turbidity: 10,
            rayleigh: 2,
            mieCoefficient: 0.005,
            mieDirectionalG: 0.8,
        },
        {
            sunDirection: [0.99, 0.01, 0.02],
            luminance: 0.8,
            turbidity: 4,
            rayleigh: 3,
            mieCoefficient: 0.008,
            mieDirectionalG: 0.5,
        },
        {
            sunDirection: [0.1, -0.05, 0.8],
            luminance: 1.2,
            turbidity: 8,
            rayleigh: 1,
            mieCoefficient: 0.003,
            mieDirectionalG: 0.9,
        },
    ];
    const expected: number[][] = [];
    for (const options of cases) {
        let yields = 0;
        const irradiance = await pin._computeProceduralSkyIrradiance(
            options,
            async () => {
                yields++;
            },
            () => true,
        );
        assert.ok(irradiance);
        expected.push([
            ...pin.computeProceduralSkySunColor(options),
            ...irradiance,
            yields,
        ]);
    }
    let current = true,
        cancelledYields = 0;
    assert.equal(
        await pin._computeProceduralSkyIrradiance(
            cases[0]!,
            async () => {
                current = false;
                cancelledYields++;
            },
            () => current,
        ),
        null,
    );
    const generated = lowerProceduralSkyAtmosphere(new LoweringContext());
    const directory = resolve("artifacts/procedural-sky-atmosphere");
    mkdirSync(resolve(directory, "bblite/upstream"), { recursive: true });
    writeFileSync(
        resolve(directory, "bblite/upstream/procedural_sky_atmosphere.hpp"),
        generated.header,
    );
    writeFileSync(resolve(directory, "atmosphere.cpp"), generated.source);
    const cpp = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include "atmosphere.cpp"
#include <cassert>
#include <iomanip>
#include <iostream>
int main() {
    const std::array<bbl::ProceduralSkyOptions,${cases.length}> cases{{
${cases.map((options) => `{{${options.sunDirection.join(",")}},${options.luminance},${options.turbidity},${options.rayleigh},${options.mieCoefficient},${options.mieDirectionalG}}`).join(",\n")}
    }};
    std::cout << std::setprecision(17);
    for(const auto& options:cases) {
        bbl::pal::EventLoop loop;
        int yields=0; bool completed=false;
        loop.run([&] {
            auto yieldTask=[&] {++yields; bbl::js::Promise<bbl::js::PromiseVoid> promise;
                loop.set_timeout([promise]{promise.resolve(bbl::js::PromiseVoid{});},0); return promise;};
            bbl::compute_procedural_sky_irradiance(options,yieldTask,[]{return true;}).then([&](const auto& irradiance){
                assert(irradiance); completed=true;
                for(const auto value:bbl::compute_procedural_sky_sun_color(options)) std::cout<<value<<' ';
                for(const auto value:*irradiance) std::cout<<value<<' ';
                std::cout<<yields<<'\\n';
                loop.close();
            });
        });
        assert(completed);
    }
    bool current=true, cancelled=false; int yields=0;
    bbl::pal::EventLoop loop;
    loop.run([&] {
        auto yieldTask=[&] {++yields; current=false; return bbl::js::Promise<bbl::js::PromiseVoid>::resolved({});};
        bbl::compute_procedural_sky_irradiance(cases[0],yieldTask,[&]{return current;}).then([&](const auto& value){assert(!value);cancelled=true;loop.close();});
    });
    assert(cancelled && yields==${cancelledYields});
    auto invalid=cases[0]; invalid.sunDirection={0,0,0};
    bool threw=false;try{bbl::validate_procedural_sky_options(invalid);}catch(const std::runtime_error&){threw=true;}
    assert(threw);
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/O2",
        "/fp:precise",
        `/I${directory}`,
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    const rows = execFileSync(executable, { encoding: "utf8", timeout: 30000 })
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(/\s+/).map(Number));
    assert.equal(rows.length, expected.length);
    rows.forEach((row, index) => {
        assert.equal(row.length, expected[index]!.length);
        row.forEach((value, channel) =>
            assert.ok(
                Math.abs(value - expected[index]![channel]!) <= 2e-7,
                `case ${index}, lane ${channel}: ${value} vs ${expected[index]![channel]}`,
            ),
        );
    });
});
