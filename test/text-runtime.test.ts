import { createJavaScriptFunction } from "../src/typescript-transpile.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { TextLowerer } from "../src/lowering/text-lowerer.js";
import { TextGpuLowerer } from "../src/lowering/text-gpu-lowerer.js";
import { textRecordsHeader } from "../src/lowering/text-data-update-lowerer.js";
import { textRecordModel } from "../src/lowering/text-records.js";
import { SceneLowerer } from "../src/lowering/scene-lowerer.js";
import { lowerMeshMaterialSetter } from "../src/lowering/mesh-material-setter.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { materializePinnedText } from "../src/pinned-text-data.js";
import { readAssetBytesSync } from "../src/compiler/asset-bytes-sync.js";
import { pinnedLabPublicUrl } from "../src/pinned-lab-public.js";
import { stringLiteral } from "../src/cpp-literals.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import { assertAsyncSceneBuilder } from "../src/lowering/scene-deferred.js";

test("deferred adapters require the actual async wrapper boundary", () => {
    const context = new LoweringContext();
    const source = context.functionDeclaration(
        "src/scene/scene-core.ts",
        "addDeferredSceneRenderables",
    ).declaration;
    assertAsyncSceneBuilder(context, source);
    const changed = ts.createSourceFile(
        "changed-scene.ts",
        source.getText().replace("async ()", "()"),
        ts.ScriptTarget.Latest,
        true,
    );
    const declaration = changed.statements.find(ts.isFunctionDeclaration)!;
    assert.throws(
        () => assertAsyncSceneBuilder(context, declaration),
        /Expected one async deferred scene builder/,
    );
});

interface Vector {
    x: number;
    y: number;
    z: number;
    set(x: number, y: number, z: number): void;
}
interface Quaternion extends Vector {
    w: number;
    version: number;
    set(x: number, y: number, z: number, w?: number): void;
}
interface Renderable {
    position: Vector;
    scaling: Vector;
    rotation: Vector;
    rotationQuaternion: Quaternion;
    opacity: number;
    order: number;
    ignoreDepth: boolean;
    isTransparent: boolean;
    _wmDirty: boolean;
    _version: number;
    _worldMatrix(): Float32Array;
    _gpu: object | null;
    _data: object;
}

test("retained text CPU state matches pinned transforms, Euler cache, uniform writes and disposal", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-text-runtime");
    mkdirSync(resolve(directory, "bblite"), { recursive: true });
    const context = new LoweringContext();
    writeFileSync(
        resolve(directory, "bblite/upstream_text_records.hpp"),
        textRecordsHeader(context),
    );
    for (const [name, header] of [
        ["upstream_text", new TextLowerer(context).header()],
        ["upstream_text_gpu", new TextGpuLowerer(context).header()],
        [
            "upstream_text_renderable",
            new TextLowerer(context).renderableHeader(),
        ],
    ] as const) {
        writeFileSync(resolve(directory, "bblite", `${name}.hpp`), header);
        writeFileSync(
            resolve(directory, `${name}.hpp`),
            `#include <bblite/${name}.hpp>\n`,
        );
    }
    const { createTextRenderable, disposeTextRenderable } =
        await importPinnedModule<{
            createTextRenderable(
                this: void,
                data: object,
                options?: object,
            ): Renderable;
            disposeTextRenderable(this: void, renderable: Renderable): void;
        }>("text/text-renderable.js");
    const data = {
        _groups: [],
        _instanceCount: 0,
        _version: 1,
        _dirtyStart: 0,
        _dirtyEnd: 0,
    };
    const renderable = createTextRenderable(data);
    const { file, declaration } = context.functionDeclaration(
        "src/text/text-renderable.ts",
        "updateTextRenderable",
    );
    // Execute the real function with recording resource seams. The supplied VP,
    // aspect and camera key are exactly the native adapter's input boundary.
    const js = ts.transpileModule(
        `${declaration.getText(file).replace(/^export\s+/, "")}\nreturn updateTextRenderable;`,
        {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        },
    ).outputText;
    const instantiate = createJavaScriptFunction(
        "ensureStyleGpu",
        "ensureSharedAtlasGpu",
        "ensureInstanceCapacity",
        "getEffectiveAspectRatio",
        "_cameraChangeKey",
        "getViewProjectionMatrix",
        "multiplyMat4IntoBuffer",
        "_mvpScratch",
        js,
    );
    const { multiplyMat4IntoBuffer } = await importPinnedModule<{
        multiplyMat4IntoBuffer(this: void, ...args: unknown[]): void;
    }>("math/multiply-mat4-into-buffer.js");
    const update = instantiate(
        () => false,
        () => {
            throw new Error("No atlas upload in the uniform control");
        },
        () => {},
        (camera: { aspect: number }) => camera.aspect,
        (camera: { key: number }) => camera.key,
        (camera: { vp: Float32Array }) => camera.vp,
        multiplyMat4IntoBuffer,
        new Float32Array(16),
    ) as (
        r: Renderable,
        engine: object,
        gpu: object,
        layout: object,
        context: object,
    ) => void;
    const vp = Float32Array.from([
        1.1, 0.2, 0.3, 0, 0.4, 1.3, 0.6, 0, 0.7, 0.8, 1.9, 0.2, 2, 3, 4, 1,
    ]);
    const camera = { vp, key: 4, aspect: 1.25 };
    const gpu = {
        _textU: {},
        _uploadedDataVersion: -1,
        _uploadedCameraVersion: -1,
        _uploadedAspect: -1,
        _uploadedViewportW: 0,
        _uploadedViewportH: 0,
        _uploadedOpacity: NaN,
    };
    const expected: number[] = [];
    const writes: Buffer[] = [];
    const engine = {
        _device: {
            queue: {
                writeBuffer(
                    target: unknown,
                    offset: number,
                    buffer: ArrayBuffer,
                    begin: number,
                    count: number,
                ) {
                    assert.equal(target, gpu._textU);
                    const prefix = Buffer.alloc(8);
                    prefix.writeUInt32LE(offset);
                    prefix.writeUInt32LE(count, 4);
                    writes.push(
                        prefix,
                        Buffer.from(buffer.slice(begin, begin + count)),
                    );
                },
            },
        },
    };
    const record = () =>
        expected.push(
            renderable.position.x,
            renderable.position.y,
            renderable.position.z,
            renderable.rotationQuaternion.x,
            renderable.rotationQuaternion.y,
            renderable.rotationQuaternion.z,
            renderable.rotationQuaternion.w,
            renderable.rotationQuaternion.version,
            renderable.rotation.x,
            renderable.rotation.y,
            renderable.rotation.z,
            renderable.scaling.x,
            renderable.scaling.y,
            renderable.scaling.z,
            renderable.opacity,
            renderable.order,
            +renderable.ignoreDepth,
            +renderable.isTransparent,
            +renderable._wmDirty,
            renderable._version,
            ...renderable._worldMatrix(),
        );
    // The compiler spells a transform write through the record model; so
    // does this check.
    const model = textRecordModel(context);
    const records = {
        position: "ObservableVec3",
        scaling: "ObservableVec3",
        rotationQuaternion: "ObservableQuat",
        rotation: "EulerProxy",
    } as const;
    type Transform = keyof typeof records;
    const lane = (transform: Transform, axis: string) =>
        model.memberRead(
            model.memberRead("r", "TextRenderable", transform),
            records[transform],
            axis,
        );
    const write = (transform: Transform, axis: string, value: string) =>
        `${model.memberWrite(model.memberRead("r", "TextRenderable", transform), records[transform], axis, value)};`;
    const bulk = (transform: Transform, ...args: string[]) =>
        `${model.memberCall(model.memberRead("r", "TextRenderable", transform), records[transform], "set", args)};`;
    const actions: string[] = [];
    const act = (cpp: string, apply: () => void) => {
        actions.push(cpp, "record();");
        apply();
        record();
    };
    act("", () => {});
    act(write("position", "x", "0"), () => (renderable.position.x = 0));
    act(bulk("position", "0", "0", "0"), () =>
        renderable.position.set(0, 0, 0),
    );
    act(
        write("position", "y", "2.123456789123"),
        () => (renderable.position.y = 2.123456789123),
    );
    act(bulk("scaling", "-.5", "1.2", "3.1"), () =>
        renderable.scaling.set(-0.5, 1.2, 3.1),
    );
    act(bulk("rotation", ".1", "1.5707963267948966", "-.3"), () =>
        renderable.rotation.set(0.1, Math.PI / 2, -0.3),
    );
    act(write("rotation", "x", ".4"), () => (renderable.rotation.x = 0.4));
    act(write("rotation", "y", ".6"), () => (renderable.rotation.y = 0.6));
    act(
        write("rotationQuaternion", "z", ".125"),
        () => (renderable.rotationQuaternion.z = 0.125),
    );
    act(write("rotation", "z", "-.8"), () => (renderable.rotation.z = -0.8));
    act(bulk("rotationQuaternion", ".25", "-.5", ".75", "1"), () =>
        renderable.rotationQuaternion.set(0.25, -0.5, 0.75, 1),
    );
    act(
        "r->opacity = .234567891; r->order = -4; r->ignore_depth = true;",
        () => {
            renderable.opacity = 0.234567891;
            renderable.order = -4;
            renderable.ignoreDepth = true;
        },
    );
    const uniform = (cpp: string, present = true, width = 800, height = 640) =>
        act(cpp, () =>
            update(
                renderable,
                engine,
                gpu,
                {},
                {
                    _camera: present ? camera : null,
                    targetWidth: width,
                    targetHeight: height,
                },
            ),
        );
    uniform("update(&camera, 800, 640);");
    uniform("update(&camera, 800, 640);");
    camera.key = 7;
    uniform("camera.change_key = 7; update(&camera, 800, 640);");
    camera.aspect = 0.75;
    uniform("camera.effective_aspect = .75; update(&camera, 800, 640);");
    uniform("update(nullptr, 400, 0);", false, 400, 0);
    act(write("position", "z", "-3"), () => (renderable.position.z = -3));
    uniform("update(nullptr, 400, 0);", false, 400, 0);
    uniform("update(&camera, 400, 0);", true, 400, 0);
    let destroyed = "";
    renderable._gpu = {
        _textU: { destroy: () => (destroyed += "u") },
        _instanceBuf: { destroy: () => (destroyed += "i") },
        _styleBuf: { destroy: () => (destroyed += "s") },
    };
    disposeTextRenderable(renderable);
    disposeTextRenderable(renderable);
    assert.equal(destroyed, "uis");
    assert.equal(renderable._data, data);
    assert.equal(renderable._gpu, null);
    const expectedState = Buffer.alloc(expected.length * 8);
    expected.forEach((value, index) =>
        expectedState.writeDoubleLE(value, index * 8),
    );
    writeFileSync(resolve(directory, "expected-state.bin"), expectedState);
    writeFileSync(
        resolve(directory, "expected-writes.bin"),
        Buffer.concat(writes),
    );
    const cpp = `#include "upstream_text_renderable.hpp"
#include <fstream>
#include <stdexcept>
using namespace bbl;
/** A GPU object whose destroy() leaves its mark. */
struct Marked final : TextGpuObject {
    std::string* log = nullptr;
    char mark = 0;
    void destroy() override { *log += mark; }
};
/** The device the uniform tail writes through: each write's range and bytes. */
struct UniformWrites final : TextGpuDevice {
    std::ofstream& out;
    TextGpuHandle target;
    explicit UniformWrites(std::ofstream& output) : out(output) {}
    void write_buffer(const TextGpuHandle& buffer, double offset, const js::ArrayBuffer& data,
                      double data_offset, double size) override {
        if (buffer != target) throw std::runtime_error("uniform target");
        const std::uint32_t prefix[] = {static_cast<std::uint32_t>(offset),static_cast<std::uint32_t>(size)};
        out.write(reinterpret_cast<const char*>(prefix),sizeof(prefix));
        out.write(reinterpret_cast<const char*>(data.data()) + static_cast<std::size_t>(data_offset),
                  static_cast<std::streamsize>(size));
    }
    TextGpuHandle create_buffer(const TextBufferDescriptor&) override { throw std::runtime_error("buffer"); }
    TextGpuHandle create_texture(const TextTextureDescriptor&) override { throw std::runtime_error("texture"); }
    TextGpuHandle create_bind_group(const TextBindGroupDescriptor&) override { throw std::runtime_error("group"); }
    TextGpuEncoderHandle create_render_bundle_encoder(const TextRenderBundleEncoderDescriptor&) override { throw std::runtime_error("bundle"); }
    void write_texture(const TextTexelCopyTextureInfo&, const js::ArrayBuffer&, const TextTexelCopyBufferLayout&, const TextExtent3D&) override { throw std::runtime_error("texture write"); }
    TextPipelineSet text_pipeline(const std::string&, double, const bbl::js::Nullable<std::string>&, bool, const std::shared_ptr<const void>&, const std::string&) override { throw std::runtime_error("pipeline"); }
    TextPipelineDeviceCacheHandle text_pipeline_cache() override { throw std::runtime_error("cache"); }
};
int main() {
    auto data = std::make_shared<TextDataState>();
    auto r = create_text_renderable(data);
    auto alias = r;
    auto other = create_text_renderable(data);
    if (alias != r || other == r || other->data != r->data) return 1;
    std::ofstream state("state.bin", std::ios::binary), writes("writes.bin", std::ios::binary);
    auto record = [&]() {
        const double ex = ${lane("rotation", "x")}, ey = ${lane("rotation", "y")}, ez = ${lane("rotation", "z")};
        const auto world = ${model.memberCall("r", "TextRenderable", "_worldMatrix", [])};
        const double values[] = {${lane("position", "x")},${lane("position", "y")},${lane("position", "z")},
            ${lane("rotationQuaternion", "x")},${lane("rotationQuaternion", "y")},${lane("rotationQuaternion", "z")},${lane("rotationQuaternion", "w")},
            ${lane("rotationQuaternion", "version")},ex,ey,ez,${lane("scaling", "x")},${lane("scaling", "y")},${lane("scaling", "z")},r->opacity,r->order,
            double(r->ignore_depth),double(r->is_transparent),double(r->wm_dirty),r->version};
        state.write(reinterpret_cast<const char*>(values),sizeof(values));
        for (std::size_t index = 0; index < world.size(); ++index) { const double wide=world.load(index); state.write(reinterpret_cast<const char*>(&wide),sizeof(wide)); }
    };
    TextCameraInput camera{js::TypedArray<float>{${Array.from(vp, (value) => `${Number.isInteger(value) ? value.toFixed(1) : value}f`).join(",")}},4,1.25};
    auto device = std::make_shared<UniformWrites>(writes);
    auto surface = std::make_shared<TextSurface>();
    surface->device = device;
    // The renderable's GPU record as \`ensureGpu\` creates it.
    auto gpu = std::make_shared<TextRenderableGpu>();
    gpu->device = device;
    gpu->text_u = std::make_shared<TextGpuObject>();
    device->target = gpu->text_u;
    gpu->style_buf = std::make_shared<TextGpuObject>();
    gpu->style_buf->size = 32;
    gpu->instance_cap = 8;
    gpu->uploaded_data_version = gpu->uploaded_camera_version = gpu->uploaded_aspect = -1;
    gpu->uploaded_opacity = std::numeric_limits<double>::quiet_NaN();
    const auto update = [&](TextCameraInputPointer input, double width, double height) {
        text_renderable_detail::update_text_renderable(r, surface, gpu, nullptr,
                                                       TextDrawUpdateContext{input, width, height});
    };
    ${actions.join("\n    ")}
    std::string destroyed;
    const auto marked = [&](char mark) {
        auto object = std::make_shared<Marked>();
        object->log = &destroyed;
        object->mark = mark;
        return object;
    };
    auto lease = std::make_shared<TextRenderableGpu>();
    lease->text_u = marked('u');
    lease->instance_buf = marked('i');
    lease->style_buf = marked('s');
    r->gpu = lease;
    dispose_text_renderable(r); dispose_text_renderable(r);
    if (destroyed != "uis" || r->gpu || r->data != data || other->data != data) return 2;
    data.reset(); r.reset(); alias.reset();
    if (!other->data) return 3;
    return 0;
}
`;
    const source = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/fp:strict",
        "/DBBLITE_HAS_TEXT=1",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        source,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${exe}`,
    ]);
    execFileSync(exe, [], { cwd: directory, stdio: "pipe" });
    const actual = readFileSync(resolve(directory, "state.bin"));
    assert.equal(actual.length, expectedState.length);
    for (let offset = 0; offset < actual.length; offset += 8) {
        const a = actual.readDoubleLE(offset),
            b = expectedState.readDoubleLE(offset);
        assert.ok(
            Math.abs(a - b) <= 1e-14,
            `state lane ${offset / 8}: ${a} vs ${b}`,
        );
        if (a === 0 && b === 0)
            assert.equal(
                Object.is(a, -0),
                Object.is(b, -0),
                `zero sign at ${offset / 8}`,
            );
    }
    assert.deepEqual(
        readFileSync(resolve(directory, "writes.bin")),
        Buffer.concat(writes),
    );
});

test("deferred scene registration observes snapshot order, identity guards, failure and retained text disposal", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    interface PinScene {
        _deferredBuilders: Array<() => void | Promise<void>>;
        _renderables: Renderable[];
        _disposables: Array<() => void>;
    }
    const pin = await importPinnedModule<{
        createSceneContext(
            this: void,
            surface: object,
            options: object,
        ): PinScene;
        registerScene(this: void, scene: PinScene): Promise<void>;
        disposeScene(this: void, scene: PinScene): void;
    }>("scene/scene-core.js");
    const { unregisterRenderingContext } = await importPinnedModule<{
        unregisterRenderingContext(
            this: void,
            surface: object,
            scene: PinScene,
        ): void;
    }>("engine/engine.js");
    const text = await importPinnedModule<{
        createTextRenderable(
            this: void,
            data: object,
            options?: object,
        ): Renderable;
        addTextRenderable(this: void, scene: PinScene, r: Renderable): void;
    }>("text/text-renderable.js");
    const surface = { engine: {}, _renderingContexts: [] as PinScene[] };
    const scene = pin.createSceneContext(surface, { defaultRenderTask: false });
    let order = "";
    scene._deferredBuilders.push(
        () => {
            order += "a";
            scene._deferredBuilders.push(() => {
                order += "c";
            });
        },
        () => {
            order += "b";
        },
    );
    await pin.registerScene(scene);
    assert.equal(order, "abc");
    assert.deepEqual(surface._renderingContexts, [scene]);
    scene._deferredBuilders.push(() => {
        order += "d";
    });
    await pin.registerScene(scene);
    assert.equal(order, "abc");
    assert.equal(scene._deferredBuilders.length, 1);
    unregisterRenderingContext(surface, scene);
    await pin.registerScene(scene);
    assert.equal(order, "abcd");
    assert.equal(scene._deferredBuilders.length, 0);
    unregisterRenderingContext(surface, scene);
    scene._deferredBuilders.push(
        () => {
            order += "e";
            scene._deferredBuilders.push(() => {
                order += "g";
            });
            throw new Error("builder");
        },
        () => {
            order += "f";
        },
    );
    await assert.rejects(pin.registerScene(scene), /builder/);
    assert.equal(order, "abcde");
    assert.equal(surface._renderingContexts.length, 0);
    assert.equal(scene._deferredBuilders.length, 1);
    await pin.registerScene(scene);
    assert.equal(order, "abcdeg");
    // Async wrappers reject without aborting Array.map's remaining calls.
    // The next drain still waits for a successful retry of this failed batch.
    const rejectedSurface = {
        engine: {},
        _renderingContexts: [] as PinScene[],
    };
    const rejectedScene = pin.createSceneContext(rejectedSurface, {
        defaultRenderTask: false,
    });
    let rejectedOrder = "";
    rejectedScene._deferredBuilders.push(
        async () => {
            rejectedOrder += "a";
            rejectedScene._deferredBuilders.push(() => {
                rejectedOrder += "c";
            });
            throw new Error("first rejection");
        },
        async () => {
            rejectedOrder += "b";
            throw new Error("second rejection");
        },
    );
    await assert.rejects(pin.registerScene(rejectedScene), /first rejection/);
    assert.equal(rejectedOrder, "ab");
    assert.equal(rejectedScene._deferredBuilders.length, 1);
    assert.equal(rejectedSurface._renderingContexts.length, 0);
    await pin.registerScene(rejectedScene);
    assert.equal(rejectedOrder, "abc");
    unregisterRenderingContext(rejectedSurface, rejectedScene);
    rejectedScene._deferredBuilders.push(
        async () => {
            rejectedOrder += "d";
        },
        () => {
            rejectedOrder += "e";
            throw new Error("synchronous throw");
        },
        async () => {
            rejectedOrder += "f";
        },
    );
    await assert.rejects(pin.registerScene(rejectedScene), /synchronous throw/);
    assert.equal(rejectedOrder, "abcde");
    const r = text.createTextRenderable({ _instanceCount: 1 });
    const other = text.createTextRenderable(
        { _instanceCount: 1 },
        { order: -5 },
    );
    text.addTextRenderable(scene, r);
    text.addTextRenderable(scene, r);
    text.addTextRenderable(scene, other);
    await pin.registerScene(scene);
    assert.equal(scene._renderables.length, 0);
    unregisterRenderingContext(surface, scene);
    await pin.registerScene(scene);
    assert.deepEqual(scene._renderables, [other, r, r]);
    let destroyed = "";
    r._gpu = {
        _textU: { destroy: () => (destroyed += "u") },
        _instanceBuf: { destroy: () => (destroyed += "i") },
        _styleBuf: { destroy: () => (destroyed += "s") },
    };
    pin.disposeScene(scene);
    pin.disposeScene(scene);
    assert.equal(destroyed, "uis");
    assert.equal(scene._renderables.length, 0);

    const context = new LoweringContext(),
        directory = resolve("artifacts/test-text-registration");
    mkdirSync(resolve(directory, "bblite"), { recursive: true });
    writeFileSync(
        resolve(directory, "bblite/upstream_text_records.hpp"),
        textRecordsHeader(context),
    );
    const source = new SceneLowerer(context).lowerCore({ text: true }).source;
    const ordinary = new SceneLowerer(context).lowerCore().source;
    assert.doesNotMatch(ordinary, /text_renderables|bblite\/text\.hpp/);
    for (const [name, header] of [
        ["upstream_text_gpu", new TextGpuLowerer(context).header()],
        [
            "upstream_text_renderable",
            new TextLowerer(context).renderableHeader(),
        ],
    ] as const)
        writeFileSync(resolve(directory, "bblite", `${name}.hpp`), header);
    const bodies = [
        "void require_scene_engine(",
        "std::uint32_t material_family_bit(",
        "std::uint32_t scene_material_families(",
        "void drain_scene_deferred_builders(",
        "void register_scene(",
        "void unregister_scene(",
        "void retire_scene_shadow_states(",
        "void dispose_scene(",
    ]
        .map((name) => cppFunction(source, name))
        .join("\n");
    const cpp = `#include <bblite/upstream_text_renderable.hpp>
namespace bbl {
${lowerMeshMaterialSetter(context)}
${bodies}
}
/** A GPU object whose destroy() leaves its mark. */
struct Marked final : bbl::TextGpuObject {
    std::string* log = nullptr;
    char mark = 0;
    void destroy() override { *log += mark; }
};
std::shared_ptr<Marked> marked(std::string& log, char mark) {
    auto object = std::make_shared<Marked>();
    object->log = &log;
    object->mark = mark;
    return object;
}
int main(){
    using namespace bbl;
    Engine engine; Scene scene; scene.engine=&engine;
    std::string order;
    scene.deferred_builders.push_back([&]{order+="a";scene.deferred_builders.push_back([&]{order+="c";});});
    scene.deferred_builders.push_back([&]{order+="b";});
    register_scene(scene);
    if(order!="abc" || engine.scenes().size()!=1) return 1;
    auto alias=scene;
    alias.deferred_builders.push_back([&]{order+="d";});
    register_scene(alias);
    if(order!="abc" || scene.deferred_builders.size()!=1) return 2;
    unregister_scene(scene); register_scene(alias);
    if(order!="abcd" || !scene.deferred_builders.empty()) return 3;
    unregister_scene(scene);
    scene.deferred_builders.push_back([&]{order+="e";scene.deferred_builders.push_back([&]{order+="g";});throw std::runtime_error("builder");});
    scene.deferred_builders.push_back([&]{order+="f";});
    try { register_scene(scene); return 4; } catch(const std::runtime_error&) {}
    if(order!="abcde" || !engine.scenes().empty() || scene.deferred_builders.size()!=1) return 5;
    register_scene(scene); if(order!="abcdeg") return 6;
    Scene rejected;rejected.engine=&engine;
    std::string rejected_order;
    rejected.deferred_builders.emplace_back([&]{
        rejected_order+="a";
        rejected.deferred_builders.push_back([&]{rejected_order+="c";});
        throw std::runtime_error("first rejection");
    },SceneDeferredFailure::promise_rejection);
    rejected.deferred_builders.emplace_back([&]{rejected_order+="b";throw std::runtime_error("second rejection");},SceneDeferredFailure::promise_rejection);
    try {register_scene(rejected);return 12;} catch(const std::runtime_error& error) {
        if(std::string(error.what())!="first rejection")return 13;
    }
    if(rejected_order!="ab" || rejected.deferred_builders.size()!=1 || engine.scenes().size()!=1)return 14;
    register_scene(rejected);if(rejected_order!="abc")return 15;
    unregister_scene(rejected);
    rejected.deferred_builders.emplace_back([&]{rejected_order+="d";},SceneDeferredFailure::promise_rejection);
    rejected.deferred_builders.push_back([&]{rejected_order+="e";throw std::runtime_error("synchronous throw");});
    rejected.deferred_builders.emplace_back([&]{rejected_order+="f";},SceneDeferredFailure::promise_rejection);
    try {register_scene(rejected);return 16;} catch(const std::runtime_error& error) {
        if(std::string(error.what())!="synchronous throw")return 17;
    }
    if(rejected_order!=${stringLiteral(rejectedOrder)})return 18;
    auto data=std::make_shared<TextDataState>();
    auto r=create_text_renderable(data);
    TextRenderableOptions options; options.order=-5;
    auto other=create_text_renderable(data,options);
    add_text_renderable(scene,r); add_text_renderable(alias,r); add_text_renderable(scene,other);
    register_scene(scene); if(!scene.state->text_renderables.empty()) return 7;
    unregister_scene(scene);register_scene(scene);
    if(scene.state->text_renderables!=std::vector<TextRenderable>{other,r,r}) return 8;
    std::string destroyed;
    r->gpu=std::make_shared<TextRenderableGpu>();
    r->gpu->text_u=marked(destroyed,'u');
    r->gpu->instance_buf=marked(destroyed,'i');
    r->gpu->style_buf=marked(destroyed,'s');
    dispose_scene(scene);dispose_scene(alias);
    if(destroyed!="uis" || !scene.state->text_renderables.empty() || !engine.scenes().empty()) return 9;
    try { add_text_renderable(scene,r); return 11; } catch(const std::runtime_error&) {}
    std::weak_ptr<SceneState> weak;
    { Scene abandoned;weak=abandoned.state;add_text_renderable(abandoned,r); }
    js::collect_cycles();
    if(!weak.expired()) return 10;
    return 0;
}`;
    const path = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(path, cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/DBBLITE_HAS_TEXT=1",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        path,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${exe}`,
    ]);
    execFileSync(exe, [], { cwd: directory, stdio: "pipe" });
});

test("materialized text preserves byte streams, source identities, atlas ownership and factory options", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-text-storage");
    mkdirSync(resolve(directory, "bblite"), { recursive: true });
    const fontBytes = readAssetBytesSync(
        `${pinnedLabPublicUrl()}fonts/Roboto-Regular.ttf`,
        resolve(directory, "source.ts"),
    );
    const layout = { fontSizePx: 180, text: "A2C" };
    const records = textRecordModel(new LoweringContext());
    const baked = materializePinnedText(
        fontBytes,
        layout,
        records.transportSchema(),
    )!.data!;
    for (const [index, base64] of baked.buffers.entries())
        writeFileSync(
            resolve(directory, `${index}.bin`),
            Buffer.from(base64, "base64"),
        );
    interface PinData {
        width: number;
        height: number;
        _version: number;
        _styleVersion: number;
        _layoutVersion: number;
        _dirtyStart: number;
        _dirtyEnd: number;
        _instanceCount: number;
        _styleCount: number;
        _instances: Float32Array;
        _styles: Float32Array;
        _groups: Array<{
            _bindGroup: object | null;
            _slotStart: number;
            _slotCount: number;
            _liveCount: number;
        }>;
        _storage: {
            _curveSets: Map<string, { _atlas: { _gpu: object | null } }>;
        };
    }
    const fontModule = await importPinnedModule<{
        createFontFromBuffer(this: void, bytes: ArrayBuffer): unknown;
    }>("text/font.js");
    const pin = await importPinnedModule<{
        createDefaultTextData(
            this: void,
            font: unknown,
            size: number,
            text: string,
        ): PinData;
        disposeDefaultTextData(this: void, data: PinData): void;
    }>("text/default-text-data.js");
    const data = pin.createDefaultTextData(
        fontModule.createFontFromBuffer(Uint8Array.from(fontBytes).buffer),
        layout.fontSizePx,
        layout.text,
    );
    const pinned = {
        width: data.width,
        height: data.height,
        versions: [data._version, data._styleVersion, data._layoutVersion],
        dirty: [data._dirtyStart, data._dirtyEnd],
        instances: Buffer.from(
            data._instances.buffer,
            data._instances.byteOffset,
            data._instanceCount * 12,
        ),
        styles: Buffer.from(
            data._styles.buffer,
            data._styles.byteOffset,
            data._styles.byteLength,
        ),
        groups: data._groups.map((group) => [
            group._slotStart,
            group._slotCount,
            group._liveCount,
        ]),
        atlases: data._storage._curveSets.size,
    };
    let destroyed = "";
    for (const set of data._storage._curveSets.values())
        set._atlas._gpu = {
            _curveTex: { destroy: () => (destroyed += "c") },
            _bandTex: { destroy: () => (destroyed += "b") },
            _metaBuf: { destroy: () => (destroyed += "m") },
        };
    for (const group of data._groups) group._bindGroup = {};
    const { disposeTextData } = await importPinnedModule<{
        disposeTextData(this: void, data: PinData): void;
    }>("text/text-data.js");
    disposeTextData(data);
    assert.equal(data._groups.length, 0);
    assert.equal(data._instanceCount, 0);
    assert.equal(data._styleCount, 0);
    assert.equal(data._storage._curveSets.size, pinned.atlases);
    assert.equal(destroyed, "");
    pin.disposeDefaultTextData(data);
    pin.disposeDefaultTextData(data);
    assert.equal(destroyed, "cbm".repeat(pinned.atlases));
    const text = await importPinnedModule<{
        createTextRenderable(
            this: void,
            data: object,
            options: object,
        ): Renderable;
    }>("text/text-renderable.js");
    const configured = text.createTextRenderable(data, {
        position: { x: -0, y: 0, z: 0 },
        scaling: { x: 1, y: 1, z: 1 },
        rotationQuaternion: { x: 0, y: 0, z: 0, w: 1 },
        opacity: 0,
        ignoreDepth: true,
        order: 0,
    });
    assert.ok(Object.is(configured.position.x, -0));
    assert.ok(!Object.is(configured._worldMatrix()[12], -0));
    const context = new LoweringContext(),
        lowerer = new TextLowerer(context);
    writeFileSync(
        resolve(directory, "bblite/upstream_text_records.hpp"),
        textRecordsHeader(context),
    );
    for (const [name, header] of [
        ["upstream_text_gpu", new TextGpuLowerer(context).header()],
        ["upstream_text_renderable", lowerer.renderableHeader()],
    ] as const)
        writeFileSync(resolve(directory, "bblite", `${name}.hpp`), header);
    // The pin's own DefaultTextData, rebuilt from its transported records.
    const expression = records.transportCpp(
        baked,
        { kind: "record", name: "DefaultTextData" },
        (index) => `js::ArrayBuffer(read("${index}.bin"))`,
    );
    const cpp = `#include <bblite/upstream_text_renderable.hpp>
#include <fstream>
#include <iterator>
std::vector<std::uint8_t> read(const std::string& path){std::ifstream input(path,std::ios::binary);return {std::istreambuf_iterator<char>(input),{}};}
/** A GPU object whose destroy() leaves its mark. */
struct Marked final : bbl::TextGpuObject {
    std::string* log = nullptr;
    char mark = 0;
    void destroy() override { *log += mark; }
};
std::shared_ptr<Marked> marked(std::string& log, char mark) {
    auto object = std::make_shared<Marked>();
    object->log = &log;
    object->mark = mark;
    return object;
}
int main(){
    using namespace bbl;
    auto first=${expression};auto second=${expression};auto alias=first;
    if(first==second || alias!=first) return 1;
    if(first->width!=${pinned.width} || first->height!=${pinned.height} || first->version!=${pinned.versions[0]} ||
        first->style_version!=${pinned.versions[1]} || first->layout_version!=${pinned.versions[2]} || first->dirty_start!=${pinned.dirty[0]} || first->dirty_end!=${pinned.dirty[1]})return 2;
    if(first->runs!=first->runs_ || first->storage->curve_sets.size()!=${pinned.atlases}) return 3;
    std::ofstream output("bytes.bin",std::ios::binary);
    auto dump=[&](const auto& values,std::size_t count){output.write(reinterpret_cast<const char*>(values.buffer().data()+values.byte_offset()),static_cast<std::streamsize>(count));};
    dump(first->instances,static_cast<std::size_t>(first->instance_count)*12);dump(first->styles,first->styles.byte_length());
    ${pinned.groups.map(([start, count, live], index) => `if(first->groups[${index}]->slot_start!=${start} || first->groups[${index}]->slot_count!=${count} || first->groups[${index}]->live_count!=${live}) return 5;`).join("\n")}
    std::string destroyed;
    for(auto& entry:first->storage->curve_sets){auto gpu=std::make_shared<SharedAtlasGpu>();gpu->curve_tex=marked(destroyed,'c');gpu->band_tex=marked(destroyed,'b');gpu->meta_buf=marked(destroyed,'m');entry.second->atlas->gpu=gpu;}
    for(auto& group:first->groups)group->bind_group=std::make_shared<TextGpuObject>();
    auto rendered=create_text_renderable(first);first.reset();
    dispose_text_data(alias);
    if(!alias->groups.empty() || alias->instance_count!=0 || alias->style_count!=0 || !destroyed.empty() || alias->storage->curve_sets.size()!=${pinned.atlases})return 6;
    dispose_default_text_data(alias);dispose_default_text_data(rendered->data);
    if(destroyed!=${stringLiteral(destroyed)} || alias->storage->curve_sets.size()!=0 || rendered->data->width!=${pinned.width})return 7;
    if(second->groups.empty() || second->instance_count==0) return 8;
    TextRenderableOptions options;options.position=Vec3d{-0.0,0,0};options.scaling=Vec3d{1,1,1};options.rotation_quaternion=TextQuaternion{0,0,0,1};options.opacity=0;options.ignore_depth=true;options.order=0;
    auto r=create_text_renderable(second,options);
    if(!std::signbit(observable_vec3_get_x(r->position)) || std::signbit(r->world_matrix().load(12)) || r->opacity || r->order || !r->ignore_depth)return 9;
    return 0;
}`;
    const source = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        "/DBBLITE_HAS_TEXT=1",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        source,
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${exe}`,
    ]);
    execFileSync(exe, [], { cwd: directory, stdio: "pipe" });
    assert.deepEqual(
        readFileSync(resolve(directory, "bytes.bin")),
        Buffer.concat([pinned.instances, pinned.styles]),
    );
});
