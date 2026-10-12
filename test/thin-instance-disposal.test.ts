import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import {
    lowerThinInstanceDisposal,
    lowerThinInstanceOwnership,
} from "../src/lowering/thin-instance-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("scene cleanup reaches source thin disposal only with thin pools", () => {
    const lowerer = new SceneLowerer(new LoweringContext());
    const plain = lowerer.lowerCore().source;
    assert.match(plain, /retire_mesh_record\(engine, mesh\);/);
    assert.doesNotMatch(plain, /dispose_thin_instance_gpu/);
    assert.match(
        lowerer.lowerCore({ thinBindings: true }).source,
        /retire_mesh_record\(engine, mesh, dispose_thin_instance_gpu\);/,
    );
});

test("thin GPU disposal waits for the last clone and preserves source handles", async (t) => {
    interface Resource {
        destroy(): void;
    }
    interface Pool {
        _refCount?: number;
        _gpuBuffer?: Resource;
        _colorGpuBuffer?: Resource;
        _drawArgsBuffer?: Resource;
    }
    interface Mesh {
        _disposed?: boolean;
        _gpu: { _refCount: number };
        thinInstances?: Pool;
    }
    const { disposeMeshGpu } = await importPinnedModule<{
        disposeMeshGpu: (mesh: Mesh) => void;
    }>("mesh/mesh-dispose.js");
    const { retain } = await importPinnedModule<{
        retain: (pool: Pool) => void;
    }>("resource/ref-count.js");
    const destroyed: string[] = [];
    const buffer = (name: string): Resource => ({
        destroy() {
            destroyed.push(name);
        },
    });
    const pool: Pool = {
        _gpuBuffer: buffer("matrix"),
        _colorGpuBuffer: buffer("color"),
        _drawArgsBuffer: buffer("args"),
    };
    const geometry = { _refCount: 100 };
    const first: Mesh = { _gpu: geometry, thinInstances: pool },
        second: Mesh = { _gpu: geometry, thinInstances: pool };
    retain(pool);
    disposeMeshGpu(first);
    assert.deepEqual(destroyed, []);
    disposeMeshGpu(second);
    disposeMeshGpu(second);
    disposeMeshGpu({ _gpu: geometry });
    disposeMeshGpu({ _gpu: geometry, thinInstances: {} });
    assert.deepEqual(destroyed, ["matrix", "color", "args"]);
    assert.ok(pool._gpuBuffer && pool._colorGpuBuffer && pool._drawArgsBuffer);
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required for the source disposal comparison.");
        return;
    }
    const context = new LoweringContext();
    runGeneratedProgram(
        native,
        "thin-instance-disposal",
        `
#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
#include <cassert>
#include <string>
#include <vector>
namespace bbl {
${lowerThinInstanceOwnership(context)}
${lowerThinInstanceDisposal(context)}
}
struct Buffer final : bbl::GpuObject {
    std::vector<std::string>& destroyed;
    std::string name;
    Buffer(std::vector<std::string>& log,std::string label):destroyed(log),name(std::move(label)){}
    void destroy() override {destroyed.push_back(name);}
};
int main(){
    std::vector<std::string> destroyed;
    auto pool=std::make_shared<bbl::ThinInstancePoolData>();
    pool->gpu_buffer=std::make_shared<Buffer>(destroyed,"matrix");
    pool->color_gpu_buffer=std::make_shared<Buffer>(destroyed,"color");
    pool->draw_args_buffer=std::make_shared<Buffer>(destroyed,"args");
    bbl::Engine engine;
    engine.meshes.resize(4);
    for(auto& mesh:engine.meshes)mesh.geometry=bbl::invalid_handle;
    engine.meshes[0].thin_instances=pool;
    engine.meshes[1].thin_instances=pool;
    engine.meshes[3].thin_instances=std::make_shared<bbl::ThinInstancePoolData>();
    bbl::retain_thin_instance_pool(pool);
    bbl::retire_mesh_record(engine,{0},bbl::dispose_thin_instance_gpu);
    assert(destroyed.empty());
    bbl::retire_mesh_record(engine,{1},bbl::dispose_thin_instance_gpu);
    bbl::retire_mesh_record(engine,{1},bbl::dispose_thin_instance_gpu);
    bbl::retire_mesh_record(engine,{2},bbl::dispose_thin_instance_gpu);
    bbl::retire_mesh_record(engine,{3},bbl::dispose_thin_instance_gpu);
    assert((destroyed==std::vector<std::string>{"matrix","color","args"}));
    assert(pool->gpu_buffer&&pool->color_gpu_buffer&&pool->draw_args_buffer);
}
`,
    );
});
