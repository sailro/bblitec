import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerEngineDisposal } from "../src/lowering/engine-dispose-lowerer.js";
import { EngineLowerer } from "../src/lowering/engine-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

function loweredStopEngine(): string {
    const source = new EngineLowerer(new LoweringContext()).lowerCore().source;
    return `namespace bbl { ${cppFunction(source, "void stop_engine(Engine& engine)")} }`;
}

test("realm engine disposal is independent of device recovery", () => {
    const directory = resolve("artifacts/engine-dispose-native");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `import {createEngine,disposeEngine} from "@babylonjs/lite";
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        const engine=await createEngine(document.createElement("canvas"));
        disposeEngine(engine);`,
        { fileName: join(directory, "entry.ts") },
    );
    assert.ok(result.manifest.features.includes("engine:dispose"));
    assert.ok(result.manifest.features.includes("platform:workers"));
    assert.ok(!result.manifest.features.includes("engine:device-recovery"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/engine_dispose.cpp",
        ),
    );
});

test("engine disposal follows pinned finally completion and isolates the shared device lease", async (t) => {
    const { disposeEngine } = await importPinnedModule<{
        disposeEngine(this: void, engine: object): void;
    }>("engine/engine-dispose.js");
    const expected: string[] = [];
    for (const failure of ["", "managed", "storage"]) {
        const events: string[] = [];
        const engine = {
            _animFrameId: 0,
            _renderFn: null,
            _surfaces: [
                {
                    _renderingContexts: [1],
                    _context: {
                        unconfigure() {
                            events.push("surface");
                        },
                    },
                },
            ],
            _flushGpuRetirements() {
                events.push("flush");
            },
            _disposeManagedResources() {
                events.push("managed");
                if (failure === "managed") throw new Error(failure);
            },
            _disposeStorageBuffers() {
                events.push("storage");
                if (failure === "storage") throw new Error(failure);
            },
            _device: {
                destroy() {
                    events.push("destroy");
                },
            },
        };
        try {
            disposeEngine(engine);
        } catch (error) {
            assert.equal((error as Error).message, failure);
        }
        assert.equal(engine._surfaces.length, 0);
        expected.push(events.join(","));
    }
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const output = resolve("artifacts/engine-dispose-native");
    mkdirSync(output, { recursive: true });
    writeFileSync(
        join(output, "disposal.hpp"),
        lowerEngineDisposal(new LoweringContext()).source + loweredStopEngine(),
    );
    writeFileSync(
        join(output, "check.cpp"),
        `#include "disposal.hpp"
#include <cassert>
#include <iostream>
#include <string>
template<class F> void must_throw(F fn) {bool threw=false;try{fn();}catch(const std::runtime_error&){threw=true;}assert(threw);}
int main(){
    auto device=std::make_shared<bbl::pal::OffscreenDevice>();
    auto other_surface=std::make_shared<bbl::pal::OffscreenSurface>(16,16);
    auto other_run=std::make_shared<bbl::pal::OffscreenRun>(other_surface,device);
    for(int failure=0;failure<3;++failure){
        bbl::Engine engine;
        auto surface=std::make_shared<bbl::pal::OffscreenSurface>(16,16);
        auto run=std::make_shared<bbl::pal::OffscreenRun>(surface,device);
        engine.offscreen_run=run;
        run->publish(16,16,std::make_shared<bbl::pal::OffscreenImage>());
        std::string events;
        engine.dispose_gpu_retirements=[&]{assert(!engine.stopped);events="retire,";};
        engine.flush_gpu_retirements=[&]{assert(engine.stopped);events+="flush,";};
        engine.dispose_managed_resources=[&]{assert(!surface->take_frame());events+="surface,managed,";if(failure==1)throw std::runtime_error("managed");};
        engine.dispose_storage_buffers=[&](bbl::Engine&){events+="storage,";if(failure==2)throw std::runtime_error("storage");};
        bool threw=false;
        try{bbl::dispose_engine(engine);}catch(const std::runtime_error& error){threw=true;assert(std::string(error.what())==(failure==1?"managed":"storage"));}
        assert(threw==(failure!=0));
        assert(engine.device_disposed&&engine.stopped&&!engine.offscreen_run&&run->closed());
        assert(!other_run->closed()&&&other_run->device()==device.get());
        must_throw([&]{run->device();});
        must_throw([&]{run->publish(16,16,std::make_shared<bbl::pal::OffscreenImage>());});
        assert(events.starts_with("retire,"));
        std::cout<<events.substr(7)<<"destroy\\n";
    }
}`,
    );
    const exe = join(output, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        `/Fo${output}/`,
        `/Fe${exe}`,
        join(output, "check.cpp"),
    ]);
    assert.deepEqual(
        execFileSync(exe, { encoding: "utf8", timeout: 10000 })
            .trim()
            .split(/\r?\n/),
        expected,
    );
});
