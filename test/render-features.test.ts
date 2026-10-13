import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { VatLowerer } from "../src/lowering/vat-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

interface PinVatHandle {
    play(name: string): void;
    update(dt: number): void;
}

test("setVatTime writes the block's clock lane until the handle writes its own, as the pin does", async (t) => {
    const vat = await importPinnedModule<{
        attachVat(
            this: void,
            engine: object,
            mesh: object,
            baked: object,
            clip?: string,
        ): PinVatHandle;
        setVatTime(
            this: void,
            engine: object,
            mesh: object,
            seconds: number,
        ): void;
        setVatInstanceStorage(
            this: void,
            engine: object,
            mesh: object,
            buffer: object | null,
        ): void;
    }>("vat/vat-baker.js");
    // The settings block as the GPU holds it: every write lands at its offset.
    const block = new Float32Array(8);
    const engine = {
        _device: {
            createBuffer: () => ({}),
            queue: {
                writeBuffer(
                    _buffer: object,
                    offset: number,
                    data: ArrayBuffer | Float32Array,
                    dataOffset = 0,
                    size?: number,
                ) {
                    const source =
                        data instanceof Float32Array
                            ? data
                            : new Float32Array(
                                  data,
                                  dataOffset,
                                  (size ?? data.byteLength) / 4,
                              );
                    block.set(source, offset / 4);
                },
            },
        },
        _storageBuffers: new Set<object>(),
    };
    const destroy = (): void => {};
    const mesh = {
        skeleton: {
            jointsBuffer: { destroy },
            weightsBuffer: { destroy },
            joints1Buffer: null,
            weights1Buffer: null,
            boneTexture: { destroy },
            _skinBuffers: {},
        },
    };
    const baked = {
        boneCount: 1,
        texture: {},
        frameCount: 10,
        clips: { swim: { fromRow: 2, frameCount: 5, fps: 30 } },
        _textureResource: {},
    };
    const handle = vat.attachVat(engine, mesh, baked, "swim");
    const lanes: number[] = [];
    vat.setVatTime(engine, mesh, 2.5);
    lanes.push(block[4]!);
    handle.update(0.25);
    lanes.push(block[4]!);
    vat.setVatTime(engine, mesh, 1 / 3);
    lanes.push(block[4]!);
    handle.play("swim");
    lanes.push(block[4]!);
    const refusal = (run: () => void): string => {
        try {
            run();
        } catch (error) {
            return (error as Error).message;
        }
        return "";
    };
    const live = { _engine: engine };
    engine._storageBuffers.add(live);
    vat.setVatInstanceStorage(engine, mesh, live);
    const refusals = [
        refusal(() => vat.setVatTime(engine, {}, 1)),
        refusal(() => vat.setVatInstanceStorage(engine, {}, null)),
        refusal(() =>
            vat.setVatInstanceStorage(engine, mesh, {
                _engine: engine,
                _destroyed: true,
            }),
        ),
    ];
    const expected = `${lanes.map((lane) => lane.toFixed(6)).join(",")}|${refusals.join(",")}`;

    // Strict mode lowers both calls where a VAT is reached.
    const result =
        compileSource(`import {createEngine,createSphere,setVatTime,setVatInstanceStorage,createStorageBuffer} from "@babylonjs/lite";
        const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const mesh=createSphere(engine,{diameter:1});
        const buffer=createStorageBuffer(engine,new Float32Array(4),"vat");
        try{setVatTime(engine,mesh,1);}catch{}
        try{setVatInstanceStorage(engine,mesh,buffer);}catch{}
        try{setVatInstanceStorage(engine,mesh,null);}catch{}`);
    assert.equal(result.manifest.deferredCapabilities?.length ?? 0, 0);
    for (const feature of ["mesh:vat-time", "mesh:vat-instance-storage"])
        assert.ok(result.manifest.features.includes(feature), feature);
    assert.match(result.cpp, /bbl::set_vat_time\(v_engine, v_mesh, 1\.0\)/);
    assert.match(
        result.cpp,
        /bbl::set_vat_instance_storage\(v_engine, v_mesh, std::nullopt\)/,
    );

    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const lowered = new VatLowerer(new LoweringContext()).lower({
        instances: false,
        time: true,
        instanceStorage: true,
    });
    runGeneratedProgram(
        tools,
        "render-features/vat-time",
        `${lowered.source}
#include <cstdio>
#include <iostream>
namespace bbl { void stop_animation(Engine&, AnimationGroupHandle) {} }
using namespace bbl;
template <class F> std::string refusal(F function) {
    try { function(); } catch (const std::runtime_error& error) { return error.what(); }
    return "";
}
int main() {
    Engine engine;
    engine.meshes.resize(2);
    engine.vat_bakes.push_back(VatBakeRecord{});
    engine.vat_bakes[0].clips.push_back(VatClipRow{"swim", 2.0, 5.0, 30.0});
    engine.meshes[0].skinned = true;
    const VatHandle handle = attach_vat(engine, MeshHandle{0}, VatBake{0}, "swim");
    const auto& block = engine.meshes[0].vat.settings;
    std::string lanes;
    const auto lane = [&] {
        char text[32];
        std::snprintf(text, sizeof text, "%.6f", static_cast<double>(block[4]));
        lanes += std::string(lanes.empty() ? "" : ",") + text;
    };
    set_vat_time(engine, MeshHandle{0}, 2.5); lane();
    vat_update(engine, handle, 0.25); lane();
    set_vat_time(engine, MeshHandle{0}, 1.0 / 3.0); lane();
    vat_play(engine, handle, "swim", std::nullopt, std::nullopt); lane();
    engine.storage_buffers.resize(2);
    engine.storage_buffers[1].disposed = true;
    set_vat_instance_storage(engine, MeshHandle{0}, StorageBufferHandle{0});
    if (!engine.meshes[0].vat.instance_storage) return 1;
    std::cout << lanes << "|" << refusal([&] { set_vat_time(engine, MeshHandle{1}, 1.0); }) << ","
              << refusal([&] { set_vat_instance_storage(engine, MeshHandle{1}, std::nullopt); }) << ","
              << refusal([&] { set_vat_instance_storage(engine, MeshHandle{0}, StorageBufferHandle{1}); });
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: expected,
        },
    );
});
