import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { CameraLowerer } from "../src/lowering/camera-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { RendererLowerer } from "../src/lowering/renderer-lowerer.js";
import { pinnedMatrixHeader } from "../src/lowering/pinned-matrix.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("async configurable control attachment retains tracked versions while repeated attachments refuse", () => {
    const directory = resolve("artifacts/camera-ocean-reads");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "worker.ts"), "self.close();");
    const source = `import {createEngine,createSceneContext,createFreeCamera,attachConfigurableFreeControl,onSceneDispose} from "@babylonjs/lite";
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        async function setup(){
            const canvas=document.createElement("canvas");
            const engine=await createEngine(canvas);const scene=createSceneContext(engine);
            const camera=createFreeCamera([0,1,-5],[0,0,0]);
            onSceneDispose(scene,attachConfigurableFreeControl(camera,canvas,scene,{}));
            if(camera.worldMatrixVersion<0)throw new Error("Invalid version");
        }
        await setup();`;
    const options = { fileName: join(directory, "entry.ts") };
    const result = compileSource(source, options);
    assert.ok(result.manifest.features.includes("camera:world-matrix-version"));
    assert.throws(
        () =>
            compileSource(
                source.replace(
                    "if(camera.worldMatrixVersion",
                    "attachConfigurableFreeControl(camera,canvas,scene,{});if(camera.worldMatrixVersion",
                ),
                options,
            ),
        /one startup control attachment/,
    );
});

interface PinCamera {
    position: { x: number; y: number; z: number };
    target: {
        x: number;
        y: number;
        z: number;
        set(x: number, y: number, z: number): void;
    };
    _yaw: number;
    worldMatrixVersion: number;
    worldMatrix: ArrayLike<number>;
    nearPlane: number;
    farPlane: number;
}

test("free camera matrix copies and transform versions follow the pinned camera", async (t) => {
    const { createFreeCamera } = await importPinnedModule<{
        createFreeCamera(
            this: void,
            position: object,
            target: object,
        ): PinCamera;
    }>("camera/free-camera.js");
    const camera = createFreeCamera(
        { x: 2.1, y: 3.2, z: -4.3 },
        { x: 1.4, y: -0.5, z: 6.7 },
    );
    const first = Array.from(camera.worldMatrix);
    camera.position.x += 2.5;
    camera.target.set(2, 1, 7);
    const yaw = camera._yaw;
    camera._yaw = yaw + 0.3;
    camera._yaw = yaw;
    const second = Array.from(camera.worldMatrix);
    const source = `import {createEngine,createFreeCamera} from "@babylonjs/lite";
const engine=await createEngine({});
const camera=createFreeCamera({x:2.1,y:3.2,z:-4.3},{x:1.4,y:-0.5,z:6.7});
const first=new Float32Array(20); first.set(camera.worldMatrix,2);
camera.position.x+=2.5; camera.target.set(2,1,7);
const yaw=camera._yaw; camera._yaw=yaw+0.3; camera._yaw=yaw;
if(camera.worldMatrixVersion!==${camera.worldMatrixVersion})throw new Error("Camera setter version");
const second=new Float32Array(camera.worldMatrix);
${first.map((value, index) => `if(first[${index + 2}]!==${value})throw new Error("Copied matrix ${index}");`).join("\n")}
${second.map((value, index) => `if(second[${index}]!==${value}||camera.worldMatrix[${index}]!==${value})throw new Error("Updated matrix ${index}");`).join("\n")}`;
    const result = compileSource(source);
    assert.ok(result.manifest.features.includes("camera:world-matrix-version"));
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/camera-ocean-reads"),
        headers = join(directory, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const context = new LoweringContext(),
        lowerer = new CameraLowerer(context, true);
    const arc = lowerer.lowerArcRotateFactory(),
        controls = lowerer.lowerControls();
    writeFileSync(join(headers, "camera_math.hpp"), arc.header);
    writeFileSync(join(headers, "camera_controls.hpp"), controls.header);
    writeFileSync(
        join(headers, "pinned_matrix.hpp"),
        pinnedMatrixHeader(context),
    );
    writeFileSync(join(directory, "arc.cpp"), arc.source);
    writeFileSync(join(directory, "controls.cpp"), controls.source);
    writeFileSync(
        join(directory, "free.cpp"),
        lowerer.lowerFreeFactory().source,
    );
    writeFileSync(join(directory, "program.hpp"), result.cpp);
    writeFileSync(
        join(directory, "check.cpp"),
        `#include <bblite/runtime.hpp>
#define main generated_main
#include "program.hpp"
#undef main
namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
int main(){return generated_main();}`,
    );
    const exe = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        `/Fo${directory}/`,
        `/Fe${exe}`,
        ...["check", "arc", "free", "controls"].map((name) =>
            join(directory, `${name}.cpp`),
        ),
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
    assert.throws(
        () =>
            compileSource(
                source + "const alias=camera.worldMatrix;alias[0]=2;",
            ),
        /Only property assignments|[Uu]nsupported|[Cc]annot/,
    );
});

test("explicit orthographic planes and null fallbacks match the pinned projection", async (t) => {
    const { createFreeCamera } = await importPinnedModule<{
        createFreeCamera(
            this: void,
            position: object,
            target: object,
        ): PinCamera;
    }>("camera/free-camera.js");
    const { enableOrthographicCamera } = await importPinnedModule<{
        enableOrthographicCamera(
            this: void,
            camera: PinCamera,
            options: object,
        ): unknown;
    }>("camera/orthographic.js");
    const { getProjectionMatrix } = await importPinnedModule<{
        getProjectionMatrix(
            this: void,
            camera: PinCamera,
            aspect: number,
        ): ArrayLike<number>;
    }>("camera/camera.js");
    const variants = [
        { halfHeight: 1.05, left: -1.85, right: 1.85 },
        { halfHeight: 2, left: -3, right: 7, bottom: -1, top: 4 },
        { halfHeight: 3, left: null, top: 0.5 },
    ];
    const expected = variants.map((options) => {
        const camera = createFreeCamera(
            { x: 0, y: 0, z: -5 },
            { x: 0, y: 0, z: 0 },
        );
        camera.nearPlane = 0.1;
        camera.farPlane = 10;
        enableOrthographicCamera(camera, options);
        return [0.5, 1, 2.7].map((aspect) =>
            Array.from(getProjectionMatrix(camera, aspect)),
        );
    });
    const compilation =
        compileSource(`import {createEngine,createFreeCamera,enableOrthographicCamera} from "@babylonjs/lite";
const engine=await createEngine({});const camera=createFreeCamera({x:0,y:0,z:-5},{x:0,y:0,z:0});
${variants.map((options) => `enableOrthographicCamera(camera,${JSON.stringify(options)});`).join("\n")}`);
    const context = new LoweringContext(),
        lowerer = new CameraLowerer(context);
    const render = new RendererLowerer(context).lowerRenderPlan({
        orthographicCamera: true,
    }).source;
    const projection = cppFunction(
        render,
        "std::array<float, 16> build_scene_projection(",
    );
    assert.match(projection, /ortho_left\.value_or/);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/camera-ocean-orthographic");
    mkdirSync(join(directory, "bblite/upstream"), { recursive: true });
    writeFileSync(
        join(directory, "bblite/upstream/camera_math.hpp"),
        lowerer.lowerArcRotateFactory().header,
    );
    writeFileSync(join(directory, "program.hpp"), compilation.cpp);
    const body = `#include <bblite/runtime.hpp>
#include <cassert>
#include <cmath>
#define main generated_main
#include "program.hpp"
#undef main
${lowerer.lowerFreeFactory().source}
${lowerer.lowerOrthographic().source}
namespace bbl { Engine create_engine(EngineOptions) { return {}; } }
namespace bbl::upstream {
${cppFunction(render, "void mat4_perspective_lh_to_ref(")}
${cppFunction(render, "void mat4_ortho_off_center_lh_to_ref(")}
${cppFunction(render, "std::array<float, 16> build_projection(")}
${projection}
}
int main(){assert(generated_main()==0);bbl::Engine engine;engine.cameras.emplace_back();
auto& camera=engine.cameras[0];camera.near_plane=.1;camera.far_plane=10;
${variants
    .map((options, index) => {
        const fields: Record<string, number | null> = options;
        return `bbl::enable_orthographic_camera(engine,bbl::CameraHandle{0},${options.halfHeight},${["left", "right", "bottom", "top"].map((key) => (fields[key] === undefined || fields[key] === null ? "std::nullopt" : `std::optional<double>{${fields[key]}}`)).join(",")});
assert(camera.projection_revision==${index + 1});
${[0.5, 1, 2.7].map((aspect, ai) => `{const auto actual=bbl::upstream::build_scene_projection(camera,${aspect});const std::array<float,16> expected{${expected[index]![ai]!.map((v) => `static_cast<float>(${v})`).join(",")}};assert(actual==expected);}`).join("\n")}`;
    })
    .join("\n")}
}`;
    const cpp = join(directory, "check.cpp"),
        exe = join(directory, "check.exe");
    writeFileSync(cpp, body);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        `/Fo${directory}/`,
        `/Fe${exe}`,
        cpp,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});

test("orthographic extent math is lowered from the source projector", () => {
    const context = doctoredContext(
        "src/camera/orthographic.ts",
        "const halfWidth = halfHeight * aspectRatio;",
        "const halfWidth = halfHeight * aspectRatio * 2;",
    );
    assert.match(
        new CameraLowerer(context).lowerOrthographicProjection(),
        /halfHeight \* aspect\) \* 2\.0/,
    );
});
