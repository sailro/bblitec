import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneUboLowerer } from "../src/lowering/scene-ubo-lowerer.js";
import { PinnedNumericLowerer } from "../src/lowering/pinned-numeric-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

interface Fog { mode: number; start: number; end: number; density: number; color: number[] }
interface Environment { lodGenerationScale: number; sphericalHarmonics?: Float32Array }
interface Scene {
    imageProcessing: { exposure: number; contrast: number; toneMappingEnabled: boolean };
    fog?: Fog;
    clipPlane?: number[];
    _environmentRotation?: number;
    _envTextures?: Environment;
    _sceneUboContributors?: Array<(data: Float32Array, scene: Scene) => void>;
}

// Encode the source inputs as raw doubles too: the observation includes -0
// and rounding boundaries that a JSON number round trip would conceal.
function doubleArray(values: Float64Array): string {
    const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    return `std::array<double, ${values.length}>{${Array.from(values, (_, i) =>
        `std::bit_cast<double>(std::uint64_t{0x${bytes.readBigUInt64LE(i * 8).toString(16)}})`).join(",")}}`;
}

test("whole pinned scene pack matches bytes, optional contributors and getter ordering", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const { _packSceneUniforms } = await importPinnedModule<{
        _packSceneUniforms(data: Float32Array, engine: object, scene: Scene, camera: object, aspect: number): void;
    }>("frame-graph/scene-uniforms-pack.js");
    const extras = await importPinnedModule<{
        setFog(scene: Scene, fog: Fog): void;
        setClipPlane(scene: Scene, plane: number[]): void;
        registerEnvSceneUniforms(scene: Scene): void;
    }>("scene/scene-ubo-extras.js");
    const { packMat4IntoF32 } = await importPinnedModule<{
        packMat4IntoF32(data: Float32Array, matrix: Float32Array | Float64Array, offset?: number, sourceOffset?: number): void;
    }>("math/pack-mat4-into-f32.js");
    const directory = resolve("artifacts/scene-ubo-pack-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pack.hpp"), new SceneUboLowerer(new LoweringContext()).packingHeader());

    const projection = Float64Array.from({ length: 16 }, (_, i) => i === 0 ? -0 : i / 3);
    const view = Float64Array.from({ length: 16 }, (_, i) => i === 12 ? -0 : 1 + i * 2 ** -24);
    const world = Float64Array.from({ length: 16 }, (_, i) => i === 12 ? -0 : 1e9 + i / 7);
    const originalProjection = projection.slice();
    let fail = "", mutateAlias = false;
    const events: string[] = [];
    function observe(name: string, value: Float64Array): Float64Array {
        events.push(name);
        if (fail === name) throw new Error(name);
        if (name === "view" && mutateAlias) projection[0] = 13.25;
        return value;
    }
    // Cache hits expose the actual pinned packer's three reads independently
    // of the camera math, which already has its own pin/native fixtures.
    const camera = { worldMatrixVersion: 0, _projFov: 1, fov: 1, _projNear: .1, nearPlane: .1,
        _projFar: 100, farPlane: 100, _projRev: 0, _vpVer: 0, _vpAspect: 2, _viewVer: 0,
        get _vpCache() { return observe("projection", projection); },
        get _viewCache() { return observe("view", view); },
        get worldMatrix() { return observe("world", world); } };
    const engine = { useFloatingOrigin: false, canvas: { width: 256, height: 128 } };
    const scene: Scene = { imageProcessing: { exposure: 1, contrast: 1, toneMappingEnabled: false } };
    const data = new Float32Array(92);
    const expected: Buffer[] = [], trace: string[] = [], steps: string[] = [];
    function sample(label: string, cpp: string, change: () => void = () => {}) {
        change(); events.length = 0; data.fill(9);
        if (fail) assert.throws(() => _packSceneUniforms(data, engine, scene, camera, 2), new RegExp(fail));
        else {
            _packSceneUniforms(data, engine, scene, camera, 2);
            for (const contributor of scene._sceneUboContributors ?? []) contributor(data, scene);
        }
        expected.push(Buffer.from(new Uint8Array(data.buffer)));
        trace.push(events.join(","));
        steps.push(`    // ${label}\n    ${cpp}\n    sample();`);
    }
    sample("no opt-ins: padding, absent fog and absent SH all stay zero", "");
    assert.equal(data[35], 0); assert.equal(data[40], 0); assert.equal(data[84], 0);
    assert.ok(Object.is(data[0], -0) && Object.is(data[32], -0));
    sample("retained matrix alias read before later getter mutation", "mutate_alias = true;", () => { mutateAlias = true; });
    assert.equal(data[0], 13.25);
    sample("floating origin still reads world, then zeros the eye", "engine.use_floating_origin = true;", () => { engine.useFloatingOrigin = true; });
    assert.ok(Object.is(data[32], 0));
    sample("base image values and environment without contributors", `scene.exposure = 1.25; scene.contrast = .75;
    scene.tone_mapping_enabled = true; scene.environment = Environment{.375};`, () => {
        scene.imageProcessing = { exposure: 1.25, contrast: .75, toneMappingEnabled: true };
        scene._envTextures = { lodGenerationScale: .375 };
    });
    sample("registered contributors, with source order and padding preserved", `
    scene.fog = Fog{3, .25, 7.5, .03125, {.125, .25, .375}};
    scene.clip_plane = std::array<double,4>{1, -2, .5, -0.0};
    scene.environment_rotation = -.25; scene.environment->has_harmonics = true;
    for (std::size_t i = 0; i < 36; ++i) scene.environment->harmonics[i] = static_cast<float>((static_cast<double>(i) - 18.0) / 7.0);
    contributors = true;`, () => {
        extras.setFog(scene, { mode: 3, start: .25, end: 7.5, density: .03125, color: [.125, .25, .375] });
        extras.setClipPlane(scene, [1, -2, .5, -0]);
        scene._environmentRotation = -.25;
        scene._envTextures!.sphericalHarmonics = Float32Array.from({ length: 36 }, (_, i) => (i - 18) / 7);
        extras.registerEnvSceneUniforms(scene);
    });
    sample("registered writers with cleared optional state", `scene.fog.reset(); scene.clip_plane.reset();
    scene.environment_rotation.reset(); scene.environment.reset();`, () => {
        delete scene.fog; delete scene.clipPlane; delete scene._environmentRotation; delete scene._envTextures;
    });
    for (const name of ["projection", "view", "world"]) {
        sample(`failure in ${name} after fill and before any matrix store`, `fail = "${name}";`, () => { fail = name; });
        assert.ok(data.every((value) => Object.is(value, 0)));
    }
    sample("recovery retains caller buffer", "fail.clear();", () => { fail = ""; });

    // The same generated helper handles the pin's F32 fast path and an F64
    // multi-matrix slab; the slow path must retain offsets and downcasts.
    const slab = Float64Array.from({ length: 48 }, (_, i) => i === 20 ? -0 : (i - 10) / 9);
    data.fill(7); packMat4IntoF32(data, slab, 19, 16); expected.push(Buffer.from(new Uint8Array(data.buffer)));
    data.fill(8); packMat4IntoF32(data, new Float32Array(view)); expected.push(Buffer.from(new Uint8Array(data.buffer)));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    const aliasSource = ts.createSourceFile("buffer-alias.ts", `
        const fromGetter = camera.worldMatrix;
        const fromCall = matrix();
        const temporary = freshMatrix();
        fromGetter[0] = 7;
        fromCall[1] = fromGetter[0] + 1;
        temporary[0] = fromCall[1] + 1;
        observe(temporary[0]);`, ts.ScriptTarget.Latest, true);
    const aliasLowerer = new PinnedNumericLowerer(aliasSource, {
        bindings: new Map([["camera.worldMatrix", { cpp: "borrow()", type: "f64-buffer", materializeAlias: true }]]),
        calls: new Map([["matrix", () => "borrow()"], ["freshMatrix", () => "fresh()"], ["observe", (args: readonly string[]) => `observed = ${args[0]}`]]),
        callShapes: new Map([["matrix", "f64-buffer"], ["freshMatrix", "f32"]]),
    });
    const aliasBody = aliasSource.statements.flatMap((statement) => aliasLowerer.statement(statement, "        ")).join("\n");
    writeFileSync(source, `#include "pack.hpp"
#include <array>
#include <bit>
#include <cassert>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
struct Engine { bool use_floating_origin = false; double width = 256, height = 128; };
struct Fog { double mode, start, end, density; std::array<double,3> color; };
struct Environment { double lod_generation_scale; bool has_harmonics = false; std::array<float,36> harmonics{}; };
struct Scene { double exposure = 1, contrast = 1; bool tone_mapping_enabled = false;
    std::optional<Environment> environment; std::optional<Fog> fog;
    std::optional<std::array<double,4>> clip_plane; std::optional<double> environment_rotation; };
int main(int argc, char** argv) {
    assert(argc == 2);
    std::ofstream output(argv[1], std::ios::binary);
    auto projection = ${doubleArray(originalProjection)};
    auto view = ${doubleArray(view)};
    auto world = ${doubleArray(world)};
    auto slab = ${doubleArray(slab)};
    std::vector<float> data(92);
    Engine engine; Scene scene; int camera = 0;
    std::string fail, events; bool mutate_alias = false, contributors = false;
    auto observe = [&](const char* name, const std::array<double,16>& matrix) -> const auto& {
        if (!events.empty()) events += ','; events += name;
        if (fail == name) throw std::runtime_error(name);
        if (std::string(name) == "view" && mutate_alias) projection[0] = 13.25;
        return matrix;
    };
    auto write = [&]() { output.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size() * sizeof(float))); };
    auto sample = [&]() {
        std::fill(data.begin(), data.end(), 9.0f); events.clear(); bool failed = false;
        try {
            bbl::upstream::pack_scene_uniforms(
                [&](int& owner, double aspect) -> const auto& { assert(&owner == &camera && aspect == 2); return observe("projection", projection); },
                [&](int& owner) -> const auto& { assert(&owner == &camera); return observe("view", view); },
                [&](int& owner) -> const auto& { assert(&owner == &camera); return observe("world", world); },
                data, engine, scene, camera, 2);
            if (contributors) {
                bbl::upstream::write_fog_scene_uniforms(data, scene);
                bbl::upstream::write_clip_scene_uniforms(data, scene);
                bbl::upstream::write_environment_scene_uniforms(data, scene);
            }
        } catch (const std::runtime_error&) { failed = true; }
        assert(failed == !fail.empty());
        std::cout << events << '\\n'; write();
    };
${steps.join("\n")}
    std::fill(data.begin(), data.end(), 7.0f);
    bbl::upstream::pack_scene_matrix(data, slab, 19, 16); write();
    std::array<float,16> f32_view{};
    std::transform(view.begin(), view.end(), f32_view.begin(), [](double value) { return static_cast<float>(value); });
    std::fill(data.begin(), data.end(), 8.0f);
    bbl::upstream::pack_scene_matrix(data, f32_view); write();
    // A const JavaScript buffer local permits element writes. Preserve the
    // getter/call's lvalue identity and a returned temporary's lifetime.
    {
        std::array<double,2> owner{}; int reads = 0; double observed = 0;
        auto borrow = [&]() -> auto& { ++reads; return owner; };
        auto fresh = []() { return std::array<float,2>{}; };
${aliasBody}
        assert(reads == 2 && owner[0] == 7 && owner[1] == 8 && observed == 9);
    }
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${directory}\\`, `/Fe:${executable}`, source]);
    const bytes = join(directory, "native.bin");
    assert.deepEqual(execFileSync(executable, [bytes], { encoding: "utf8" }).trim().split(/\r?\n/), trace);
    const actual = readFileSync(bytes), allExpected = Buffer.concat(expected);
    assert.equal(actual.length, allExpected.length);
    for (let offset = 0; offset < actual.length; offset += 4)
        assert.equal(actual.readUInt32LE(offset), allExpected.readUInt32LE(offset), `snapshot ${Math.floor(offset / 368)}, lane ${(offset / 4) % 92}`);
});

test("scene pack refuses newly reached unknown pin behavior", () => {
    class ChangedStore extends UpstreamSourceStore {
        override getSourceFile(module: string): ts.SourceFile {
            const file = super.getSourceFile(module);
            return module === "src/frame-graph/scene-uniforms-pack.ts"
                ? ts.createSourceFile(file.fileName, file.text.replace("data.fill(0);", "data.fill(0); unknownContributor(data);"), ts.ScriptTarget.Latest, true)
                : file;
        }
    }
    assert.throws(() => new SceneUboLowerer(new LoweringContext(new ChangedStore())).packingHeader(), /unknownContributor/);
});

test("borrowed buffer calls refuse unrepresented local rebinding", () => {
    const file = ts.createSourceFile("buffer-rebinding.ts", "let value = matrix(); value = other();", ts.ScriptTarget.Latest, true);
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map(), calls: new Map([["matrix", () => "matrix()"]]), callShapes: new Map([["matrix", "f32"]]),
    });
    assert.throws(() => lowerer.statement(file.statements[0]!, ""), /mutable buffer call binding/);
});
