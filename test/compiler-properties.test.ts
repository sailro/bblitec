// The declared property reads.
//
// Regenerating the whole scene registry proves the table produces the
// same native expressions the hand-written blocks did -- every generated
// byte was unchanged when they were replaced. What that proof cannot
// cover is the refusals, which emit nothing, and the record-field name
// mapping, which is only exercised by the properties a corpus scene
// happens to read. Both are pinned here.
import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { type DataType, passesByReferenceKind } from "../src/compiler/data-types.js";
import { propertyRules } from "../src/compiler/properties.js";

/** A scene with an ArcRotateCamera, which most reads hang off. */
function sceneWithCamera(
    body: string,
    extraImports: readonly string[] = [],
): string {
    const imports = [
        "createArcRotateCamera",
        "createEngine",
        "createSceneContext",
        ...extraImports,
    ].sort();
    return `
        import {
            ${imports.join(",\n            ")},
        } from "@babylonjs/lite";
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
            ${body}
        }
    `;
}

test("reads a camera field through the engine record", () => {
    const result = compileSource(
        sceneWithCamera("const near = camera.nearPlane;"),
    );

    // The source name and the native field differ, which is the whole
    // content of the table row.
    assert.match(
        result.cpp,
        /v_engine\.cameras\[v_camera\.value\]\.near_plane/,
    );
});

test("reads a scene field off its own expression", () => {
    // How the corpus reaches it: the clear colour a render task is
    // handed comes off the scene rather than being restated.
    const result = compileSource(`
        import {
            createArcRotateCamera,
            createEngine,
            createRenderTask,
            createSceneContext,
        } from "@babylonjs/lite";
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
            const task = createRenderTask(
                {
                    name: "clear-colour-read",
                    rt: engine.scRT,
                    clrColor: scene.clearColor,
                    clr: true,
                },
                engine,
                scene,
            );
        }
    `);

    assert.match(result.cpp, /v_scene\.clear_color/);
    // `engine.scRT` in the same literal is the helper form.
    assert.match(
        result.cpp,
        /bbl::swapchain_render_target\(v_engine\)/,
    );
});

test("reads a path written as a path, at any depth", () => {
    // Every link resolves through the same reading, so where the path is
    // written stops mattering: these all used to need an intermediate
    // binding, and `camera.target.x` resolved in an expression while
    // failing in a numeric context.
    const result = compileSource(
        sceneWithCamera(
            `
            enableOrthographicCamera(camera, { halfHeight: 2 });
            const a = createBox(engine, camera.ortho.halfHeight);
            const b = createBox(engine, scene.camera.alpha);
            const c = createBox(engine, scene.camera.target.y);
        `,
            ["createBox", "enableOrthographicCamera"],
        ),
    );

    assert.match(
        result.cpp,
        /v_engine\.cameras\[v_camera\.value\]\.ortho_half_height/,
    );
    assert.match(
        result.cpp,
        /v_engine\.cameras\[v_scene\.camera\.value\]\.alpha/,
    );
    assert.match(
        result.cpp,
        /v_engine\.cameras\[v_scene\.camera\.value\]\.target\.y/,
    );
});

test("names the sub-path that failed", () => {
    assert.throws(
        () =>
            compileSource(
                sceneWithCamera(
                    "const box = createBox(engine, camera.nope.halfHeight);",
                    ["createBox"],
                ),
            ),
        /camera\.nope\.halfHeight/,
    );
});

test("re-tags a handle and then reads through it", () => {
    // `camera.ortho` reads nothing -- it is the camera handle under
    // another kind -- so the read that follows it has to resolve the
    // engine through the handle it was re-tagged from.
    const result = compileSource(
        sceneWithCamera(
            `
            enableOrthographicCamera(camera, { halfHeight: 2 });
            const ortho = camera.ortho;
            const box = createBox(engine, ortho.halfHeight);
        `,
            ["createBox", "enableOrthographicCamera"],
        ),
    );

    // The re-tagged binding is the camera handle, and the bounds read
    // indexes the camera record through it.
    assert.match(result.cpp, /auto v_ortho = v_camera;/);
    assert.match(
        result.cpp,
        /v_engine\.cameras\[v_ortho\.value\]\.ortho_half_height/,
    );
});

test("names the same camera fields for reads and both write paths", () => {
    // `camera.speed` compiled while `scene.camera.speed` was refused,
    // and `angularSensitivity` could be written but not read: three
    // copies of one map, each missing something the others had.
    const result = compileSource(
        sceneWithCamera(`
            camera.speed = 2;
            scene.camera.speed = 3;
            camera.angularSensitivity = 500;
            const box = createBox(engine, camera.angularSensitivity);
        `,
            ["createBox"],
        ),
    );

    const cameraRecord = /v_engine\.cameras\[v_camera\.value\]/;
    assert.match(result.cpp, /\.speed = 2\.0;/);
    assert.match(
        result.cpp,
        /v_engine\.cameras\[v_scene\.camera\.value\]\.speed = 3\.0;/,
    );
    assert.match(result.cpp, /\.angular_sensibility = 500\.0;/);
    assert.match(result.cpp, cameraRecord);
    assert.match(
        result.cpp,
        /bbl::create_box\([^)]*angular_sensibility/,
    );
});

test("keeps the raw GPU device closed outside the matrix upload helper", () => {
    assert.throws(
        () =>
            compileSource(
                sceneWithCamera(
                    "const device = engine._device; const queue = device.queue;",
                ),
            ),
        /only inside the recognized thin-instance matrix upload helper/,
    );
});

test("refuses a camera world matrix on a non-arc-rotate camera", () => {
    assert.throws(
        () =>
            compileSource(`
                import {
                    createEngine,
                    createFreeCamera,
                    createSceneContext,
                } from "@babylonjs/lite";
                async function main(): Promise<void> {
                    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
                    const scene = createSceneContext(await createEngine(canvas));
                    const camera = createFreeCamera(
                        { x: 0, y: 5, z: -10 },
                        { x: 0, y: 0, z: 0 },
                    );
                    scene.camera = camera;
                    const world = camera.worldMatrix;
                }
            `),
        /requires an ArcRotateCamera/,
    );
});

test("rejects an undeclared property on a known owner", () => {
    // The table returning nothing has to fall through to the general
    // failure rather than resolving to something adjacent.
    assert.throws(
        () =>
            compileSource(
                sceneWithCamera("const gamma = camera.delta;"),
            ),
        /Unsupported property value 'camera\.delta'/,
    );
});

// A `helper:` rule is a function CALL, so its answer is a prvalue. Where
// the answer is a container -- one the declaration path would otherwise
// bind by reference, because a JavaScript `const` aliases the same array
// -- that reference points into the helper's returned temporary and is
// dangling by the next statement. `helperReturnsFreshData` is what tells
// the declaration path to copy instead, and scene 113 is the scene that
// found the missing one the expensive way: a picked point that alternated
// between two values run to run while every input to it stayed
// bit-identical. Asserted over the whole table so the next
// container-returning helper cannot be added without it.
test("every container-returning property helper declares fresh data", () => {
    // Asked of the type the aliasing decision actually runs on: a scene
    // reads `info.pickedPoint` through the pin's own null guard, so the
    // binding is made from the NARROWED type and an optional's own kind
    // never reaches that decision. Testing the wrapper would have filtered
    // out the one rule this test exists for -- `picked_point` is
    // `optional<tuple3>` -- and stayed green with the defect restored.
    const decided = (dataType: DataType): DataType =>
        dataType.kind === "optional" ? dataType.inner : dataType;
    const missing = propertyRules
        .filter(
            (rule) =>
                "helper" in rule &&
                rule.helper !== undefined &&
                rule.dataType !== undefined &&
                passesByReferenceKind(decided(rule.dataType)) &&
                !rule.helperReturnsFreshData,
        )
        .map((rule) => `${rule.owner}.${rule.property}`);
    assert.deepEqual(missing, []);
});
