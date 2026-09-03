import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";

test("scene camera bindings preserve nullable-handle presence", () => {
    const result = compileSource(`
        import type { SceneContext } from "@babylonjs/lite";
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";

        function guardedAlpha(scene: SceneContext): number | null {
            const cam = scene.camera;
            if (!cam) {
                return null;
            }
            return cam.alpha;
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(
                0,
                1,
                3,
                { x: 0, y: 0, z: 0 },
            );

            const missing = scene.camera;
            const missingByComparison = missing === null;
            const selected = missing ?? camera;
            scene.camera = camera;
            const present = scene.camera;
            const presentByComparison = present !== null;
            const alpha = guardedAlpha(scene);
        }
    `);

    assert.match(
        result.cpp,
        /auto v_missing = v_scene\.camera;\s*\[\[maybe_unused\]\] const bool (v_[A-Za-z0-9_]*element_found[A-Za-z0-9_]*) = \(v_missing\.value != bbl::invalid_handle\);/,
    );
    assert.match(
        result.cpp,
        /auto v_selected = \(v_[A-Za-z0-9_]*element_found[A-Za-z0-9_]* \? v_missing : v_camera\);/,
    );
    assert.match(
        result.cpp,
        /auto v_present = v_scene\.camera;\s*\[\[maybe_unused\]\] const bool (v_[A-Za-z0-9_]*element_found[A-Za-z0-9_]*) = \(v_present\.value != bbl::invalid_handle\);/,
    );
    assert.match(result.cpp, /missingByComparison = !\(v_[A-Za-z0-9_]*element_found/);
    assert.match(result.cpp, /presentByComparison = v_[A-Za-z0-9_]*element_found/);

    const guardedCamera = result.cpp.match(
        /auto (v_[A-Za-z0-9_]*cam) = v_[A-Za-z0-9_]*scene\.camera;\s*\[\[maybe_unused\]\] const bool (v_[A-Za-z0-9_]*element_found[A-Za-z0-9_]*) = \(\1\.value != bbl::invalid_handle\);/,
    );
    assert.ok(guardedCamera);
    const guard = result.cpp.indexOf(
        `if (!(${guardedCamera[2]}))`,
        result.cpp.indexOf(guardedCamera[0]),
    );
    const cameraRead = result.cpp.indexOf(
        `.cameras[${guardedCamera[1]}.value].alpha`,
        guard,
    );
    assert.ok(guard >= 0);
    assert.ok(cameraRead > guard);
});

test("optional handle bindings snapshot presence from the bound handle", () => {
    const result = compileSource(`
        import type { Mesh } from "@babylonjs/lite";
        import {
            createBox,
            createEngine,
        } from "@babylonjs/lite";

        function hasMaterial(mesh: Mesh): boolean {
            const material = mesh.material;
            if (!material) {
                return false;
            }
            return true;
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const mesh = createBox(engine, 1);
            const present = hasMaterial(mesh);
        }
    `);

    const material = result.cpp.match(
        /auto (v_[A-Za-z0-9_]*material) = [^;]+\.material;\s*\[\[maybe_unused\]\] const bool (v_[A-Za-z0-9_]*element_found[A-Za-z0-9_]*) = \(\1\.value != bbl::invalid_handle\);/,
    );
    assert.ok(material);
    assert.match(result.cpp, new RegExp(`if \\(!\\(${material[2]}\\)\\)`));
});

test("an unguarded nullable camera cannot reach the matrix intrinsic", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createSceneContext,
                    getViewProjectionMatrix,
                } from "@babylonjs/lite";

                async function main(): Promise<void> {
                    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                    const engine = await createEngine(canvas);
                    const scene = createSceneContext(engine);
                    const camera = scene.camera;
                    const matrix = getViewProjectionMatrix(camera, 2);
                }
            `),
        /getViewProjectionMatrix camera may be absent; guard it before the call/,
    );
});

test("a class-held scene camera narrows through the Handles-style guard", () => {
    const result = compileSource(`
        import type { SceneContext } from "@babylonjs/lite";
        import {
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            getViewProjectionMatrix,
        } from "@babylonjs/lite";

        class HandlesProjection {
            private readonly scene: SceneContext;
            private hidden = false;

            constructor(scene: SceneContext) {
                this.scene = scene;
            }

            update(): number | null {
                const cam = this.scene.camera;
                if (this.hidden || !cam) {
                    return null;
                }
                const vp = getViewProjectionMatrix(cam, 2);
                return vp[3]!;
            }
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            scene.camera = createArcRotateCamera(
                0,
                1,
                3,
                { x: 0, y: 0, z: 0 },
            );
            const handles = new HandlesProjection(scene);
            const projected = handles.update();
        }
    `);

    const presence = result.cpp.match(
        /\[\[maybe_unused\]\] const bool (v_[A-Za-z0-9_]*element_found[A-Za-z0-9_]*) = \(v_[A-Za-z0-9_]*cam\.value != bbl::invalid_handle\);/,
    );
    assert.ok(presence);
    const guard = result.cpp.indexOf(`|| !(${presence[1]})`);
    const projection = result.cpp.indexOf(
        "bbl::upstream::build_view_projection(",
        guard,
    );
    const handleValidation = result.cpp.indexOf(
        ".cameras.at(",
        projection,
    );
    assert.ok(guard >= 0);
    assert.ok(projection > guard);
    assert.ok(handleValidation > projection);
});

test("a guarded scene camera emits its matrix sources without a constructor", () => {
    const result = compileSource(`
        import type { SceneContext } from "@babylonjs/lite";
        import {
            createEngine,
            createSceneContext,
            getViewProjectionMatrix,
        } from "@babylonjs/lite";

        function projectIfPresent(scene: SceneContext): number | null {
            const cam = scene.camera;
            if (!cam) {
                return null;
            }
            return getViewProjectionMatrix(cam, 2)[0]!;
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const projected = projectIfPresent(scene);
        }
    `);

    assert.ok(!result.manifest.features.includes("camera:arc-rotate"));
    assert.ok(result.manifest.features.includes("camera:view-projection"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/camera_arc_rotate.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/renderer_plan.cpp",
        ),
    );
    assert.ok(
        !result.manifest.generatedSources.includes(
            "upstream/src/camera_controls.cpp",
        ),
    );
});

test("projection intrinsic keeps f32 lanes and widens ArrayLike calls once", () => {
    const result = compileSource(`
        import {
            addToScene,
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            getViewProjectionMatrix as projectCamera,
            registerScene,
        } from "@babylonjs/lite";

        function matrixEdges(matrix: ArrayLike<number>): number {
            return matrix[0]! + matrix[15]!;
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const camera = createArcRotateCamera(
                0,
                1,
                3,
                { x: 0, y: 0, z: 0 },
            );
            scene.camera = camera;
            addToScene(scene, camera);
            const vp = projectCamera(camera, camera.radius / 3);
            const last = vp[15]!;
            const edges = matrixEdges(vp);
            await registerScene(scene);
        }
    `);

    assert.match(
        result.cpp,
        /const double aspect = \(v_engine\.cameras\[v_camera\.value\]\.radius \/ 3\.0\); const auto matrix = bbl::upstream::build_view_projection\(\s*v_engine\.cameras\.at\(v_camera\.value\),\s*aspect\)/,
    );
    assert.equal(
        result.cpp.match(/\.cameras\[v_camera\.value\]\.radius \/ 3\.0/g)
            ?.length,
        1,
    );
    const projectionStorage = result.cpp.match(
        /bbl::js::F32Array (v_[A-Za-z0-9_]*view_projection[A-Za-z0-9_]*) = \(\[&\]\(\) \{ const double aspect =/,
    );
    assert.ok(projectionStorage);
    assert.match(
        result.cpp,
        new RegExp(`bbl::js::F32Array v_vp = ${projectionStorage[1]};`),
    );
    assert.match(
        result.cpp,
        /static_cast<double>\(bbl::js::array_index_checked\(v_vp, 15\.0,/,
    );
    assert.match(
        result.cpp,
        /const bbl::js::F64Array v_[A-Za-z0-9_]*array_like_numbers[A-Za-z0-9_]*\(v_vp\.begin\(\), v_vp\.end\(\)\);/,
    );
    assert.match(
        result.cpp,
        /#include <bblite\/upstream\/camera_math\.hpp>[\s\S]*#include <bblite\/upstream\/renderer_plan\.hpp>/,
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/renderer_plan.cpp",
        ),
    );
});

test("Sandblox-shaped camera construction stays live and reaches its sources", () => {
    const result = compileSource(`
        import type { ArcRotateCamera, SceneContext } from "babylon-lite";
        import {
            addToScene,
            createArcRotateCamera,
            createEngine,
            createSceneContext,
            getViewProjectionMatrix,
            onBeforeRender,
            registerScene,
            startEngine,
        } from "babylon-lite";

        class CameraController {
            private readonly _camera: ArcRotateCamera;

            constructor(scene: SceneContext) {
                const camera = createArcRotateCamera(
                    -Math.PI / 2,
                    1.3,
                    15,
                    { x: 0, y: 3, z: 0 },
                );
                scene.camera = camera;
                addToScene(scene, camera);
                this._camera = camera;
                camera.farPlane = 10000;
            }

            tick(): number {
                const camera = this._camera;
                camera.alpha += 0.25;
                camera.beta = 1.1;
                camera.radius += 0.5;
                camera.target.x = 2;
                return getViewProjectionMatrix(camera, 2)[0]!;
            }
        }

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
            const controller = new CameraController(scene);
            onBeforeRender(scene, () => {
                controller.tick();
            });
            await registerScene(scene);
            await startEngine(engine);
        }
    `);

    assert.ok(result.manifest.features.includes("camera:arc-rotate"));
    assert.ok(result.manifest.features.includes("camera:view-projection"));
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/camera_arc_rotate.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/camera_controls.cpp",
        ),
    );
    assert.ok(
        result.manifest.generatedSources.includes(
            "upstream/src/renderer_plan.cpp",
        ),
    );
    assert.match(
        result.cpp,
        /#include <bblite\/upstream\/camera_math\.hpp>[\s\S]*#include <bblite\/upstream\/renderer_plan\.hpp>/,
    );
    assert.match(result.cmake, /upstream\/src\/camera_arc_rotate\.cpp/);
    assert.match(result.cmake, /upstream\/src\/camera_controls\.cpp/);
    assert.match(result.cmake, /upstream\/src\/renderer_plan\.cpp/);
    assert.match(result.cpp, /\.far_plane = 10000\.0;/);
    assert.match(result.cpp, /\.alpha \+= 0\.25;/);
    assert.match(result.cpp, /\.beta = 1\.1;/);
    assert.match(result.cpp, /\.radius \+= 0\.5;/);
    assert.match(result.cpp, /\.target\.x = 2\.0;/);
    assert.match(
        result.cpp,
        /\.alpha \+= 0\.25;[\s\S]*bbl::upstream::build_view_projection\(/,
    );
});

test("a program with no camera keeps camera projection output absent", () => {
    const result = compileSource(`
        import {
            createEngine,
            createSceneContext,
        } from "@babylonjs/lite";

        async function main(): Promise<void> {
            const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
            const engine = await createEngine(canvas);
            const scene = createSceneContext(engine);
        }
    `);

    assert.ok(!result.manifest.features.some((feature) =>
        feature.startsWith("camera:"),
    ));
    assert.ok(!result.manifest.generatedSources.some((source) =>
        source.includes("camera_"),
    ));
    assert.doesNotMatch(result.cpp, /camera_math\.hpp|renderer_plan\.hpp/);
});
