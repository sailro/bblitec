import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerDeformedVertex } from "../src/lowering/deformed-vertex.js";
import { VatLowerer } from "../src/lowering/vat-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";
import { pinnedError } from "./pinned-errors.js";

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
    const skinned = () => ({
        skeleton: {
            jointsBuffer: { destroy },
            weightsBuffer: { destroy },
            joints1Buffer: null,
            weights1Buffer: null,
            boneTexture: { destroy },
            _skinBuffers: {},
        },
    });
    const mesh = skinned();
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
    // An attach without a clip plays the first name in property order (an
    // array index first); an empty name plays none.
    const attachedRow = (clip?: string): string => {
        block.fill(-1);
        const clips = {
            walk: { fromRow: 1, frameCount: 2, fps: 30 },
            7: { fromRow: 4, frameCount: 3, fps: 12 },
        };
        vat.attachVat(engine, skinned(), { ...baked, clips }, clip);
        return block[0] === -1 ? "none" : String(block[0]);
    };
    const defaults = [attachedRow(), attachedRow("")];
    const expected = `${lanes.map((lane) => lane.toFixed(6)).join(",")}|${refusals.join(",")}|${defaults.join(",")}`;

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
    const VatHandle handle = attach_vat(engine, MeshHandle{0}, VatBake{0}, std::string("swim"));
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
    const auto attached_row = [&](const js::Nullable<std::string>& clip) {
        engine.meshes.resize(engine.meshes.size() + 1);
        engine.meshes.back().skinned = true;
        VatBakeRecord bake;
        bake.clips = {VatClipRow{"walk", 1.0, 2.0, 30.0}, VatClipRow{"7", 4.0, 3.0, 12.0}};
        engine.vat_bakes.push_back(bake);
        attach_vat(engine, MeshHandle{static_cast<std::uint32_t>(engine.meshes.size() - 1)},
                   VatBake{static_cast<std::uint32_t>(engine.vat_bakes.size() - 1)}, clip);
        const VatData& vat = engine.meshes.back().vat;
        return vat.settings_version == 1 ? std::string("none") : js::number_to_string(vat.settings[0]);
    };
    std::cout << "|" << attached_row(std::nullopt) << "," << attached_row(std::string());
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

/**
 * A program that loads the shark, finds its skinned mesh as `mesh` and runs
 * `body` before registering the scene; `imports` are the further names
 * `body` uses.
 */
function skinnedSharkProgram(imports: readonly string[], body: string): string {
    return `
        import { ${["addToScene", "createEngine", "createSceneContext", "loadGltf", "registerScene", "startEngine", ...imports, "type Mesh", "type TransformNode"].join(", ")} } from "@babylonjs/lite";
        function findSkinned(node: TransformNode): Mesh | null {
            const m = node as unknown as Mesh;
            if (m.skeleton) return m;
            for (const c of (node.children ?? []) as TransformNode[]) { const hit = findSkinned(c); if (hit) return hit; }
            return null;
        }
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const scene = createSceneContext(engine);
        const shark = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
        addToScene(scene, shark);
        const mesh = findSkinned(shark.entities[0] as TransformNode);
        if (!mesh) throw new Error("skinned");
        ${body}
        await registerScene(scene);
        await startEngine(engine);
    `;
}

test("a baked VAT is an engine handle a program stores and attaches later", () => {
    const program = (body: string): string =>
        skinnedSharkProgram(
            ["attachVat", "bakeVat", "type VatBakeResult"],
            body,
        );
    const stored = compileSource(
        program(`const bakes: VatBakeResult[] = [];
        bakes.push(bakeVat(engine, mesh, shark.animationGroups ?? []));
        attachVat(engine, mesh, bakes[0]!, "swimming");`),
    );
    assert.match(stored.cpp, /bbl::js::Array<bbl::VatBake>/);
    const mapped = compileSource(
        program(`const byKey = new Map<string, VatBakeResult>();
        byKey.set("shark", bakeVat(engine, mesh, shark.animationGroups ?? []));
        const kept = byKey.get("shark");
        if (kept) attachVat(engine, mesh, kept, "swimming");`),
    );
    assert.match(mapped.cpp, /bbl::VatBake/);
    assert.match(mapped.cpp, /bbl::attach_vat\(/);
});

/** The prepared payloads' one clip, as the pin reads it and as the native row. */
const walkClips = { walk: { fromRow: 0, frameCount: 2, fps: 30 } };
const walkClipRow = 'VatClipRow{"walk", 0.0, 2.0, 30.0}';

/** The pin's createVatBakeResults over an engine whose device takes every upload. */
async function pinnedVatBaker<Result>(): Promise<
    (prepared: readonly unknown[]) => Result[]
> {
    const vat = await importPinnedModule<{
        createVatBakeResults(
            this: void,
            engine: object,
            prepared: readonly unknown[],
        ): Result[];
    }>("vat/vat-baker.js");
    const engine = {
        _device: {
            createTexture: () => ({ destroy: () => {} }),
            queue: { writeTexture: () => {} },
        },
    };
    return (prepared) => vat.createVatBakeResults(engine, prepared);
}

/** Runs `program` over the lowered prepared-VAT upload; it must print `expected`. */
function runPreparedVatProgram(
    t: TestContext,
    name: string,
    program: string,
    expected: string,
): void {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const lowered = new VatLowerer(new LoweringContext()).lower({
        instances: false,
        prepared: true,
    });
    runGeneratedProgram(
        tools,
        `render-features/${name}`,
        `${lowered.source}
#include <iostream>
namespace bbl { void stop_animation(Engine&, AnimationGroupHandle) {} }
using namespace bbl;
${program}`,
        { timeoutMs: 10000, expectedOutput: expected },
    );
}

test("createVatBakeResults validates prepared payloads in the pin's order and keeps their captures", async (t) => {
    const createVatBakeResults = await pinnedVatBaker<{
        boneCount: number;
        frameCount: number;
        clips: Record<
            string,
            { fromRow: number; frameCount: number; fps: number }
        >;
        boneOrigins?: Record<number, Float32Array>;
        boneMatrices?: Record<number, Float32Array>;
    }>();
    const payload = (patch: object): object => ({
        boneCount: 2,
        frameCount: 3,
        data: new Float32Array(96),
        clips: walkClips,
        ...patch,
    });
    // Each case as the pin answers it, then as the native call is fed it.
    const cases: [object | undefined, string][] = [
        [
            payload({ boneOrigins: { 1: new Float32Array(9) } }),
            "payload.bone_origins = js::Map<double, js::F32Array>{{1.0, js::F32Array(std::size_t{9})}};",
        ],
        [payload({ boneCount: 0 }), "payload.bone_count = 0.0;"],
        [payload({ frameCount: 1.5 }), "payload.frame_count = 1.5;"],
        [
            payload({ data: new Float32Array(95) }),
            "payload.data = js::F32Array(std::size_t{95});",
        ],
        [
            payload({
                clips: { walk: { fromRow: 2, frameCount: 2, fps: 30 } },
            }),
            'payload.clips = {VatClipRow{"walk", 2.0, 2.0, 30.0}};',
        ],
        [
            payload({ clips: { walk: { fromRow: 0, frameCount: 2, fps: 0 } } }),
            'payload.clips = {VatClipRow{"walk", 0.0, 2.0, 0.0}};',
        ],
        [
            payload({ clips: { "": { fromRow: 0, frameCount: 2, fps: 30 } } }),
            'payload.clips = {VatClipRow{"", 0.0, 2.0, 30.0}};',
        ],
        [
            payload({ boneOrigins: { 2: new Float32Array(9) } }),
            "payload.bone_origins = js::Map<double, js::F32Array>{{2.0, js::F32Array(std::size_t{9})}};",
        ],
        [
            payload({ boneMatrices: { 0: new Float32Array(47) } }),
            "payload.bone_matrices = js::Map<double, js::F32Array>{{0.0, js::F32Array(std::size_t{47})}};",
        ],
        [undefined, "payload = PreparedVatPayload{};"],
    ];
    const answer = (prepared: unknown): string => {
        try {
            const [result] = createVatBakeResults([prepared]);
            const origins = Object.entries(result!.boneOrigins ?? {});
            return `${result!.boneCount}x${result!.frameCount} ${Object.entries(
                result!.clips,
            )
                .map(
                    ([name, clip]) =>
                        `${name}:${clip.fromRow},${clip.frameCount},${clip.fps}`,
                )
                .join(
                    " ",
                )} ${origins.map(([bone, values]) => `${bone}=${values.length}`).join(" ")}`;
        } catch (error) {
            return (error as Error).message;
        }
    };
    const expected = cases.map(([prepared]) => answer(prepared)).join("|");
    const positive = pinnedError(
        "VAT prepared payload: ${a0} must be a positive integer.",
    );
    const dataLength = pinnedError(
        "VAT prepared payload: data length must equal boneCount * frameCount * 16.",
    );
    const clip = pinnedError('VAT prepared payload: clip "${a0}" is invalid.');
    assert.equal(
        expected,
        [
            "2x3 walk:0,2,30 1=9",
            positive,
            positive,
            dataLength,
            clip,
            clip,
            clip,
            pinnedError(
                'VAT prepared payload: ${a0} contains invalid bone index "${a1}".',
            ),
            pinnedError(
                "VAT prepared payload: ${a0}[${a1}] has an invalid length.",
            ),
            positive,
        ].join("|"),
    );

    const feed = cases.map(
        ([, patch]) =>
            `answers.push_back(answer([&](PreparedVatPayload& payload) { ${patch} }));`,
    );
    runPreparedVatProgram(
        t,
        "vat-prepared",
        `template <class Patch> std::string answer(Patch patch) {
    Engine engine;
    PreparedVatPayload payload;
    payload.bone_count = 2.0;
    payload.frame_count = 3.0;
    payload.data = js::F32Array(std::size_t{96});
    payload.clips = {${walkClipRow}};
    patch(payload);
    try {
        const auto bakes = create_vat_bakes(engine, {payload});
        const VatBakeRecord& bake = engine.vat_bakes.at(bakes.at(0).value);
        std::string text = std::to_string(bake.bone_count) + "x" + std::to_string(bake.frame_count);
        for (const VatClipRow& clip : bake.clips)
            text += " " + clip.name + ":" + js::number_to_string(clip.from_row) + "," +
                js::number_to_string(clip.frame_count) + "," + js::number_to_string(clip.fps);
        text += " ";
        if (bake.bone_origins)
            for (const auto& [bone, values] : *bake.bone_origins)
                text += js::number_to_string(bone) + "=" + std::to_string(values.size());
        return text;
    } catch (const std::runtime_error& error) {
        return error.what();
    }
}
int main() {
    std::vector<std::string> answers;
    ${feed.join("\n    ")}
    for (std::size_t index = 0; index < answers.size(); ++index)
        std::cout << (index ? "|" : "") << answers[index];
}
`,
        expected,
    );
});

test("prepared VAT payloads share a texture exactly when the pin's upload shares one", async (t) => {
    const createVatBakeResults = await pinnedVatBaker<{ texture: object }>();
    const zeros = new Float32Array(96);
    const negativeZero = new Float32Array(96);
    negativeZero[5] = -0;
    // One data object twice, a bit-equal copy, a -0 lane, then the same
    // length under another bone count, twice.
    const payloads: [number, number, Float32Array][] = [
        [2, 3, zeros],
        [2, 3, zeros],
        [2, 3, new Float32Array(96)],
        [2, 3, negativeZero],
        [1, 6, new Float32Array(96)],
        [1, 6, new Float32Array(96)],
    ];
    const results = createVatBakeResults(
        payloads.map(([boneCount, frameCount, data]) => ({
            boneCount,
            frameCount,
            data,
            clips: walkClips,
        })),
    );
    const expected = results
        .map((result) =>
            results.findIndex(
                (candidate) => candidate.texture === result.texture,
            ),
        )
        .join(" ");
    assert.equal(expected, "0 0 0 3 4 4");

    const feed = payloads.map(
        ([boneCount, frameCount, data]) =>
            `payloads.push_back(payload(${boneCount}.0, ${frameCount}.0, ${Object.is(data[5], -0) ? "true" : "false"}));`,
    );
    runPreparedVatProgram(
        t,
        "vat-prepared-sharing",
        `PreparedVatPayload payload(double bones, double frames, bool negative_zero) {
    PreparedVatPayload result;
    result.bone_count = bones;
    result.frame_count = frames;
    result.data = js::F32Array(std::size_t{96});
    if (negative_zero) result.data.store(5, -0.0f);
    result.clips = {${walkClipRow}};
    return result;
}
int main() {
    Engine engine;
    std::vector<PreparedVatPayload> payloads;
    ${feed.join("\n    ")}
    const auto bakes = create_vat_bakes(engine, payloads);
    for (std::size_t index = 0; index < bakes.size(); ++index) {
        const GpuTextureIdentity& texture = engine.vat_bakes.at(bakes.at(index).value).texture;
        std::size_t first = 0;
        while (!(engine.vat_bakes.at(bakes.at(first).value).texture == texture)) ++first;
        std::cout << (index ? " " : "") << first;
    }
}
`,
        expected,
    );
});

test("inline prepared VAT payloads store as the parameter's records", () => {
    // A literal's own type names its clips as fields; the payload stores as
    // the declared PreparedVatBakeResult, whose clips are a named map.
    const result = compileSource(`
        import { createEngine, createVatBakeResult, createVatBakeResults } from "@babylonjs/lite";
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const one = createVatBakeResult(engine, { boneCount: 1, frameCount: 2, data: new Float32Array(32), clips: { idle: { fromRow: 0, frameCount: 2, fps: 30 } } });
        const many = createVatBakeResults(engine, [{ boneCount: 1, frameCount: 1, data: new Float32Array(16), clips: { walk: { fromRow: 0, frameCount: 1, fps: 24 } } }]);
        console.log(one.clips.idle!.fps, many[0]!.clips.walk!.fps);
    `);
    assert.equal(result.cpp.match(/bbl::create_vat_bakes\(/g)?.length, 2);
    assert.match(result.cpp, /"idle"/);
    assert.match(result.cpp, /"walk"/);
});

test("a program's prepared VAT records lower to the native upload and attach", () => {
    const result = compileSource(
        skinnedSharkProgram(
            ["attachVat", "createVatBakeResults", "type PreparedVatBakeResult"],
            `const prepared: PreparedVatBakeResult[] = [{
            boneCount: 2,
            frameCount: 2,
            data: new Float32Array(64),
            clips: { swim: { fromRow: 0, frameCount: 2, fps: 30 } },
            boneOrigins: { 1: new Float32Array(6) },
        }];
        const bakes = createVatBakeResults(engine, prepared);
        // A computed clip name, the counts and a capture, read off the bake.
        const pick = ["swim", "idle"][Math.floor(Math.random() * 2)]!;
        const clip = bakes[0]!.clips[pick];
        const last = clip ? clip.fromRow + clip.frameCount - 1 : -1;
        const origins = bakes[0]!.boneOrigins;
        mesh.position.x = bakes[0]!.boneCount * bakes[0]!.frameCount + last + (origins ? Object.keys(origins).length : 0);
        attachVat(engine, mesh, bakes[0]!, pick);`,
        ),
    );
    for (const feature of ["mesh:vat", "mesh:vat-prepared", "data:json"])
        assert.ok(result.manifest.features.includes(feature), feature);
    assert.match(result.cpp, /bbl::js::for_each_property_entry\(/);
    assert.match(result.cpp, /\.bone_origins = [^;]*->boneOrigins;/);
    assert.match(
        result.cpp,
        /bbl::js::Array<bbl::VatBake> \w+ = bbl::create_vat_bakes\(v_engine, \w+\);/,
    );
    assert.match(result.cpp, /bbl::vat_clip_row\(v_engine, [^,]+, (?!")/);
    assert.match(
        result.cpp,
        /static_cast<double>\(bbl::handle_at\(v_engine\.vat_bakes, .+?\)\.bone_count\)/,
    );
    assert.match(
        result.cpp,
        /bbl::handle_at\(v_engine\.vat_bakes, .+?\)\.bone_origins/,
    );
    assert.match(result.cpp, /bbl::attach_vat\([^;]*v_pick/);
});

test("a skeleton presence test reads the mesh record through a loose null test and a cast", () => {
    const result = compileSource(`
        import { addToScene, createEngine, createSceneContext, loadGltf, registerScene, startEngine, type Mesh, type TransformNode } from "@babylonjs/lite";
        function collect(node: TransformNode, out: Mesh[]): Mesh[] {
            out.push(node as unknown as Mesh);
            for (const child of (node.children ?? []) as TransformNode[]) collect(child, out);
            return out;
        }
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        const shark = await loadGltf(engine, "https://models.babylonjs.com/shark.glb");
        addToScene(scene, shark);
        const meshes = collect(shark.entities[0] as TransformNode, []);
        const cast = meshes.filter((m) => (m as unknown as { skeleton?: unknown }).skeleton != null);
        const rigid = meshes.filter((m) => m.skeleton == null);
        if (cast.length + rigid.length !== meshes.length) throw new Error("partition");
        await registerScene(scene);
        await startEngine(engine);
    `);
    assert.match(
        result.cpp,
        /return bbl::handle_at\(v_engine\.meshes, \w+\)\.skeleton_attached;/,
    );
    assert.match(
        result.cpp,
        /return !\(bbl::handle_at\(v_engine\.meshes, \w+\)\.skeleton_attached\);/,
    );
});

test("mesh.vat tests the attach record and its second influence pair is absent", () => {
    const result = compileSource(
        skinnedSharkProgram(
            ["attachVat", "bakeVat"],
            `attachVat(engine, mesh, bakeVat(engine, mesh, shark.animationGroups ?? []), "swimming");
        // Native vertices carry four influences (four-influence-skinning).
        const has8Bones = (mesh as unknown as { vat?: { joints1Buffer?: unknown } }).vat?.joints1Buffer != null;
        const hasVat = (mesh as unknown as { vat?: unknown }).vat != null;
        mesh.position.x = (has8Bones ? 1 : 0) + (hasVat ? 2 : 0);`,
        ),
    );
    assert.match(result.cpp, /\.has_vat/);
    assert.match(result.cpp, /position\.x = \(0\.0 \+ /);
});

test("a bake's clip stored as a record copies the row, and an absent clip stores none", () => {
    const result = compileSource(
        skinnedSharkProgram(
            [
                "attachVat",
                "createVatBakeResults",
                "type PreparedVatBakeResult",
                "type VatClip",
            ],
            `const prepared: PreparedVatBakeResult[] = [{ boneCount: 2, frameCount: 2, data: new Float32Array(64), clips: { swim: { fromRow: 0, frameCount: 2, fps: 30 } } }];
        const baked = createVatBakeResults(engine, prepared)[0]!;
        const slots: (string | undefined)[] = ["swim", undefined, "idle"];
        let gait: (VatClip | undefined)[] = [];
        gait = slots.map((n) => (n ? baked.clips[n] : undefined));
        attachVat(engine, mesh, baked, "swim");
        mesh.position.x = gait[2] ? 1 : gait[0] ? gait[0].fromRow + gait[0].frameCount : -1;`,
        ),
    );
    assert.match(
        result.cpp,
        /if \(!\(\(\w+\.frame_count != 0\.0\)\)\) return \{\};\s+return bbl::js::make_ref<bblscene::VatClipData>/,
    );
});
