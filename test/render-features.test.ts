import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerDeformedVertex } from "../src/lowering/deformed-vertex.js";
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

test("computeDeformedPositionToRef morphs then skins one vertex with the pin's float stores", async (t) => {
    const { computeDeformedPositionToRef } = await importPinnedModule<{
        computeDeformedPositionToRef(
            this: void,
            mesh: object,
            vertexIndex: number,
            out: { x: number; y: number; z: number },
        ): boolean;
    }>("picking/deformed-vertex.js");
    // Three vertices, two morph targets, two bones; weights split a vertex
    // across both bones, and the third vertex names a joint past the palette.
    const positions = [0.1, 0.2, 0.3, 1.25, -2.5, 0.7, 3.3, 0.01, -1.9];
    const deltas = [
        [0.5, 0.25, -0.125, 0.3, 0.3, 0.3, 0, 0, 0],
        [-0.01, 0.02, 0.03, 0.7, -0.1, 0.2, 1, 1, 1],
    ];
    const weights = [0.35, 0.6];
    const bones = [
        [1, 0, 0, 0, 0, 0.8, 0.6, 0, 0, -0.6, 0.8, 0, 0.5, -1, 2, 1],
        [0.9, 0.1, 0, 0, -0.1, 0.9, 0, 0, 0, 0, 1.1, 0, -0.3, 0.2, 0.1, 1],
    ];
    const joints = [0, 1, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0];
    const skin = [0.25, 0.75, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0];
    const mesh = {
        _cpuPositions: new Float32Array(positions),
        morphTargets: {
            weights: new Float32Array(weights),
            count: 2,
            targets: deltas.map((delta) => ({
                positions: new Float32Array(delta),
            })),
        },
        skeleton: {
            boneMatrices: new Float32Array(bones.flat()),
            joints: new Uint16Array(joints),
            weights: new Float32Array(skin),
            joints1: null,
            weights1: null,
        },
    };
    const lines: string[] = [];
    for (const index of [0, 1, 2, 3, -1, 1 / 3, 0.5]) {
        const out = { x: 7, y: 8, z: 9 };
        const found = computeDeformedPositionToRef(mesh, index, out);
        lines.push(
            `${found ? 1 : 0} ${[out.x, out.y, out.z].map((v) => (Number.isNaN(v) ? "nan" : String(Number(v.toPrecision(9))))).join(" ")}`,
        );
    }
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const list = (values: number[]): string => values.join(", ");
    runGeneratedProgram(
        tools,
        "render-features/deformed-vertex",
        `#include <bblite/runtime.hpp>
#include <cmath>
#include <cstdio>
#include <iostream>
#include <limits>
namespace bbl {
${lowerDeformedVertex(new LoweringContext())}
}
using namespace bbl;
int main() {
    Engine engine;
    engine.geometries.resize(1);
    ModelGeometry& geometry = engine.geometries[0];
    const float positions[] = {${list(positions)}};
    const float deltas[2][9] = {{${list(deltas[0]!)}}, {${list(deltas[1]!)}}};
    const std::uint16_t joints[] = {${list(joints)}};
    const float skin[] = {${list(skin)}};
    geometry.vertices.resize(3);
    geometry.morph_positions.resize(2);
    for (std::size_t v = 0; v < 3; ++v) {
        geometry.vertices[v].position = Vec3{positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]};
        for (std::size_t j = 0; j < 4; ++j) geometry.vertices[v].joints[j] = joints[v * 4 + j];
        geometry.vertices[v].weights = Vec4{skin[v * 4], skin[v * 4 + 1], skin[v * 4 + 2], skin[v * 4 + 3]};
        for (std::size_t t = 0; t < 2; ++t)
            geometry.morph_positions[t].push_back(Vec3{deltas[t][v * 3], deltas[t][v * 3 + 1], deltas[t][v * 3 + 2]});
    }
    engine.meshes.resize(1);
    MeshRecord& mesh = engine.meshes[0];
    mesh.geometry = 0;
    mesh.skinned = true;
    mesh.morph_storage_weights = {${list(weights)}};
    mesh.bone_matrices = {{${list(bones[0]!)}}, {${list(bones[1]!)}}};
    std::string out;
    for (const double index : {0.0, 1.0, 2.0, 3.0, -1.0, 1.0 / 3.0, 0.5}) {
        const DeformedPosition result = compute_deformed_position(engine, MeshHandle{0}, index, Vec3d{7.0, 8.0, 9.0});
        out += std::string(out.empty() ? "" : "|") + (result.found ? "1" : "0");
        for (const double lane : {result.position.x, result.position.y, result.position.z}) {
            char text[32];
            if (std::isnan(lane)) std::snprintf(text, sizeof text, " nan");
            else std::snprintf(text, sizeof text, " %.9g", lane);
            out += text;
        }
    }
    std::cout << out;
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1"],
            timeoutMs: 10000,
            expectedOutput: lines.join("|"),
        },
    );
});
