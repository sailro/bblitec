import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SceneUboLowerer } from "../src/lowering/scene-ubo-lowerer.js";
import { cameraChangeKeyHeader } from "../src/lowering/camera-change-key-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

interface PinCamera {
    alpha: number; fov: number; nearPlane: number; farPlane: number; worldMatrixVersion: number;
    viewport?: { x: number; y: number; width: number; height: number };
    target: { x: number; y: number; z: number; set(x: number, y: number, z: number): void };
}

test("pinned source cache preserves identity, projection polling, clean bytes and failure stores", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const { createArcRotateCamera } = await importPinnedModule<{
        createArcRotateCamera(alpha: number, beta: number, radius: number, target: object): PinCamera;
    }>("camera/arc-rotate.js");
    const { _writePassSceneUBO } = await importPinnedModule<{
        _writePassSceneUBO(task: object, engine: object, scene: object, camera: PinCamera | null): void;
    }>("frame-graph/render-task.js");
    const directory = resolve("artifacts/scene-ubo-cache-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "cache.hpp"), new SceneUboLowerer(new LoweringContext()).cacheHeader());
    writeFileSync(join(directory, "camera.hpp"), cameraChangeKeyHeader(new LoweringContext()));
    const cameraA = createArcRotateCamera(-1, 1, 10, { x: 0, y: 0, z: 0 });
    const cameraB = createArcRotateCamera(-1, 1, 10, { x: 0, y: 0, z: 0 });
    const initialProjection = { fov: cameraB.fov, near: cameraB.nearPlane, far: cameraB.farPlane };
    let camera: PinCamera | null = null;
    let packs = 0, writes = 0, failPack = false, failWrite = false;
    const target = { _width: 128, _height: 64 };
    const source = { _config: { rt: target, cs: false }, _sceneUboCacheKey: [] as unknown[],
        _suData: new Float32Array(92), _sceneUBO: new Float32Array(92) };
    const engine = { canvas: { width: 256, height: 128 }, _device: { queue: {
        writeBuffer(buffer: Float32Array, offset: number, data: Float32Array) {
            assert.equal(buffer, source._sceneUBO); assert.equal(offset, 0);
            if (failWrite) throw new Error("write failed");
            buffer.set(data); ++writes;
        },
    } } };
    const scene = { fog: null as { density: number } | null,
        imageProcessing: { exposure: 1, contrast: 1, toneMappingEnabled: true },
        _envTextures: null as { lodGenerationScale: number } | null,
        _sceneUboContributors: [(data: Float32Array) => {
            // Observe the cache/packing boundary without reproducing matrix
            // arithmetic: the actual pin invokes this after its own packer.
            data.fill(++packs);
            if (failPack) throw new Error("pack failed");
        }] };
    const expected: string[] = [];
    const bytes: Buffer[] = [];
    const steps: string[] = [];
    function sample(label: string, nativeMutation = "", pinMutation?: () => void, failure?: RegExp) {
        pinMutation?.();
        if (failure) assert.throws(() => _writePassSceneUBO(source, engine, scene, camera), failure);
        else _writePassSceneUBO(source, engine, scene, camera);
        const key = source._sceneUboCacheKey;
        expected.push([packs, writes, key[2] ?? -1, key[3] ?? -1, source._suData[0], source._sceneUBO[0]].join(" "));
        bytes.push(Buffer.from(new Uint8Array(source._suData.buffer)), Buffer.from(new Uint8Array(source._sceneUBO.buffer)));
        steps.push(`    // ${label}\n    ${nativeMutation}\n    sample(${failure ? "true" : "false"});`);
    }
    sample("absent camera");
    sample("first source pack", "camera = &camera_a;", () => { camera = cameraA; });
    sample("unchanged source");
    sample("drawn matrix mutation remains while clean scratch is unchanged", "source.drawn[0] = 99.0f;", () => { source._sceneUBO[0] = 99; });
    sample("transform away and back", "camera_a.world_matrix_version += 2;", () => { cameraA.alpha += .5; cameraA.alpha -= .5; });
    sample("projection away and back before polling", "camera_a.fov += .1; camera_a.fov -= .1;", () => { const fov = cameraA.fov; cameraA.fov += .1; cameraA.fov = fov; });
    sample("same component value", "", () => { cameraA.alpha = cameraA.alpha; cameraA.target.x = cameraA.target.x; });
    sample("bulk vector write dirties even equal values", "camera_a.world_matrix_version += 1;", () => { cameraA.target.set(0, 0, 0); });
    sample("camera replacement", "camera = &camera_b;", () => { camera = cameraB; });
    sample("same camera object projection changes", "camera_b.fov = .4;", () => { cameraB.fov = .4; });
    sample("viewport aspect", "camera_b.viewport = Viewport{.5, 1};", () => { cameraB.viewport = { x: 0, y: 0, width: .5, height: 1 }; });
    sample("viewport position alone does not invalidate", "", () => { cameraB.viewport!.x = .25; });
    sample("same effective canvas aspect", "source.canvas_size = true;", () => { source._config.cs = true; });
    sample("canvas aspect change", "engine.height = 64;", () => { engine.canvas.height = 64; });
    sample("fog replacement", "scene.fog_identity = 1;", () => { scene.fog = { density: 1 }; });
    sample("fog same object mutation", "", () => { scene.fog!.density = 2; });
    sample("fog equal value replacement", "scene.fog_identity = 2;", () => { scene.fog = { density: 2 }; });
    sample("environment replacement", "scene.environment_identity = 1;", () => { scene._envTextures = { lodGenerationScale: .8 }; });
    sample("environment same object mutation", "", () => { scene._envTextures!.lodGenerationScale = .7; });
    sample("exposure value", "scene.exposure = 2;", () => { scene.imageProcessing.exposure = 2; });
    sample("contrast value", "scene.contrast = 2;", () => { scene.imageProcessing.contrast = 2; });
    sample("untracked image setting", "", () => { scene.imageProcessing.toneMappingEnabled = false; });
    sample("pack failure after cache stores", "scene.exposure = 3; fail_pack = true;", () => { scene.imageProcessing.exposure = 3; failPack = true; }, /pack failed/);
    sample("failed pack is not retried for identical key", "fail_pack = false;", () => { failPack = false; });
    sample("upload failure after clean pack", "scene.exposure = 4; fail_write = true;", () => { scene.imageProcessing.exposure = 4; failWrite = true; }, /write failed/);
    sample("failed upload is not retried for identical key", "fail_write = false;", () => { failWrite = false; });

    const sourcePath = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(sourcePath, `#include "camera.hpp"
#include "cache.hpp"
#include "camera.hpp"
#include <array>
#include <cassert>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
struct Viewport { double width, height; };
struct Camera {
    double fov = ${initialProjection.fov}, near_plane = ${initialProjection.near}, far_plane = ${initialProjection.far};
    double projection_fov = NAN, projection_near = NAN, projection_far = NAN;
    double projection_revision = 0, world_matrix_version = 0;
    std::optional<Viewport> viewport;
};
struct Cache { const Camera* camera = nullptr; std::uint64_t fog = 0, environment = 0;
    double camera_key = -1, aspect = -1, exposure = -1, contrast = -1; };
struct Source { Cache cache; double width = 128, height = 64; bool canvas_size = false;
    std::array<float,92> clean{}, drawn{}; };
struct Engine { double width = 256, height = 128; };
struct Scene { std::uint64_t fog_identity = 0, environment_identity = 0; double exposure = 1, contrast = 1; };
int main(int argc, char** argv) {
    assert(argc == 2);
    std::ofstream bytes(argv[1], std::ios::binary);
    Camera camera_a, camera_b; Camera* camera = nullptr; Source source; Engine engine; Scene scene;
    int packs = 0, writes = 0; bool fail_pack = false, fail_write = false;
    auto sample = [&](bool failure) {
        bool failed = false;
        try {
            bbl::upstream::write_pass_scene_ubo(source, engine, scene, camera,
                [](Camera* item) { return bbl::upstream::scene_camera_change_key(*item); },
                [&](Source& item, double) {
                    item.clean.fill(static_cast<float>(++packs));
                    if (fail_pack) throw std::runtime_error("pack failed");
                    if (fail_write) throw std::runtime_error("write failed");
                    item.drawn = item.clean; ++writes;
                });
        } catch (const std::runtime_error&) { failed = true; }
        assert(failed == failure);
        std::cout << packs << ' ' << writes << ' ' << source.cache.camera_key << ' ' << source.cache.aspect
                  << ' ' << source.clean[0] << ' ' << source.drawn[0] << '\\n';
        bytes.write(reinterpret_cast<const char*>(source.clean.data()), sizeof(source.clean));
        bytes.write(reinterpret_cast<const char*>(source.drawn.data()), sizeof(source.drawn));
    };
${steps.join("\n")}
}
`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD",
        `/Fo:${directory}\\`, `/Fe:${executable}`, sourcePath]);
    const nativeBytes = join(directory, "native.bin");
    const actual = execFileSync(executable, [nativeBytes], { encoding: "utf8" });
    assert.deepEqual(actual.trim().split(/\r?\n/), expected);
    assert.ok(readFileSync(nativeBytes).equals(Buffer.concat(bytes)), "Native clean/drawn byte history differs from the pin.");
});
