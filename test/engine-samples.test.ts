import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { pinnedSurfaceHeader } from "../src/lowering/pinned-surface.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("runtime engine samples preserve strict selection, one evaluation and scene defaults", (t) => {
    const result = compileSource(`
        import {createEngine,createSceneContext,stopEngine} from "@babylonjs/lite";
        async function main(){
            const values=JSON.parse('[1,4,0,"1",true,null]');
            for(let index=0;index<=values.length;index++){
                let reads=0;
                function choose():unknown {reads++;return values[index];}
                const engine=await createEngine({}, {msaaSamples:choose() as 1|4});
                if(reads!==1||engine.msaaSamples!==(index===0?1:4))throw new Error("sample choice or evaluation");
                createSceneContext(engine);
                stopEngine(engine);
            }
        }
        void main();
    `);
    assert.equal(
        result.manifest.engineMsaaSamples,
        undefined,
        "runtime choice must not fold to a global sample count",
    );
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/engine-samples");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "main.cpp"), result.cpp);
    writeFileSync(
        resolve(directory, "pinned_surface.hpp"),
        pinnedSurfaceHeader(new LoweringContext()),
    );
    writeFileSync(
        resolve(directory, "factories.cpp"),
        `
        #include <bblite/runtime.hpp>
        #include "pinned_surface.hpp"
        #include <stdexcept>
        namespace {std::shared_ptr<bbl::SceneState> latest;}
        namespace bbl {
        Engine create_engine(EngineOptions options){Engine engine;engine.options=std::move(options);return engine;}
        Scene create_scene_context(Engine&){Scene scene;latest=scene.state;return scene;}
        void stop_engine(Engine& engine){
            if(latest->default_render_task_samples!=upstream::preferred_sample_count(engine.options.msaa_samples))
                throw std::runtime_error("scene and engine samples disagree");
            if(upstream::preferred_sample_count()!=4||upstream::preferred_sample_count(0)!=4)
                throw std::runtime_error("generated default changed");
        }
        }
    `,
    );
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/MD",
        "/I",
        "native/include",
        `/I${nativeFixtureVcpkgRoot}/include`,
        resolve(directory, "main.cpp"),
        resolve(directory, "factories.cpp"),
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
    ]);
    execFileSync(executable, { stdio: "pipe", timeout: 10000 });
});
