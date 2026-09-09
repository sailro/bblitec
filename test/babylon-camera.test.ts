import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { lowerBabylonCamera } from "../src/lowering/babylon-camera.js";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools();
const modulePath = "src/loader-babylon/parse-camera.ts";

test("the complete Babylon camera parser matches the pin for absent, null and populated options", { skip: !nativeTools }, async () => {
    interface Camera {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
        fov: number; nearPlane: number; farPlane: number;
    }
    const pin = await importPinnedModule<{ parseBabylonCamera(data: object): Camera }>("loader-babylon/parse-camera.js");
    const inputs = [
        { position: [1, 2, 3] },
        { position: [-1.234567890123, 0, 16777217], rotation: [], fov: null, minZ: null, maxZ: null },
        { position: [8, 3, -20], rotation: [.63, -1.12, 0], fov: 1.1, minZ: .02, maxZ: 4000 },
        { position: [0, 0, 0], rotation: null, fov: 0, minZ: 0, maxZ: 0 },
    ];
    const expected = inputs.map(input => {
        const camera = pin.parseBabylonCamera(input);
        return [camera.position.x, camera.position.y, camera.position.z,
            camera.target.x, camera.target.y, camera.target.z, camera.fov, camera.nearPlane, camera.farPlane];
    });
    const context = new LoweringContext();
    const loader = new BabylonLowerer(context).lowerLoaderAdapter().source;
    const guard = lowerBabylonCamera(doctoredContext(modulePath,
        "if (cd.fov != null) {\n        cam.fov = cd.fov;",
        "if (cd.fov == null) {\n        cam.fov = 0.75;")).replace("parse_babylon_camera(", "parse_changed_guard(");
    const fallback = lowerBabylonCamera(doctoredContext(modulePath,
        "cd.rotation?.[0] ?? 0", "cd.rotation?.[0] ?? 0.5")).replace("parse_babylon_camera(", "parse_changed_fallback(");
    const directory = resolve("artifacts/test-babylon-camera");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "inputs.json"), JSON.stringify(inputs));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `
        #include <bblite/runtime.hpp>
        #include <nlohmann/json.hpp>
        #include <fstream>
        #include <cassert>
        namespace bbl {
            using Json = nlohmann::json;
            ${cppFunction(new CameraLowerer(context).lowerFreeFactory().source, "CameraHandle create_free_camera(")}
            ${cppFunction(loader, "double double_at(")}
            ${cppFunction(loader, "CameraHandle parse_babylon_camera(")}
            ${guard}
            ${fallback}
        }
        int main() {
            bbl::Json inputs, expected;
            std::ifstream("inputs.json") >> inputs; std::ifstream("expected.json") >> expected;
            bbl::Engine engine;
            for (std::size_t i = 0; i < inputs.size(); ++i) {
                auto handle = bbl::parse_babylon_camera(engine, inputs[i]);
                const auto& camera = bbl::handle_at(engine.cameras, handle);
                const std::array<double,9> actual{camera.position.x, camera.position.y, camera.position.z,
                    camera.target.x, camera.target.y, camera.target.z, camera.fov, camera.near_plane, camera.far_plane};
                for (std::size_t lane = 0; lane < actual.size(); ++lane)
                    assert(std::abs(actual[lane] - expected[i][lane].get<double>()) < 1e-12);
            }
            auto changed = bbl::parse_changed_guard(engine, inputs[0]);
            assert(bbl::handle_at(engine.cameras, changed).fov == .75);
            changed = bbl::parse_changed_guard(engine, inputs[2]);
            assert(bbl::handle_at(engine.cameras, changed).fov == .8);
            changed = bbl::parse_changed_fallback(engine, inputs[0]);
            const auto& camera = bbl::handle_at(engine.cameras, changed);
            assert(camera.target.y == 2 - std::sin(.5));
            assert(camera.target.z == 3 + std::cos(.5));
        }
    `);
    assert.ok(nativeTools);
    runNativeFixtureCompiler(nativeTools, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc",
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"),
        `/Fo:${directory}\\`, `/Fe:${executable}`, source]);
    execFileSync(executable, { cwd: directory, stdio: "pipe" });
});

test("unknown camera record members refuse with pinned source provenance", () => {
    assert.throws(() => lowerBabylonCamera(doctoredContext(modulePath,
        "cam.fov = cd.fov;", "cam.unknown = cd.fov;")), /parse-camera.ts.*assignment target/s);
});
