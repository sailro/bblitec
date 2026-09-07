import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

// A gizmo is an engine value with a native record that the plain-data model
// does not carry: it cannot go in a struct or a vector. One nullable NAME
// holding one of them is a narrower question, and it is the shape an editor
// scene is written in -- the widget is built on the first click so the static
// capture frame contains none.
const preamble = `
    import {
        addToScene, attachRotationGizmoToNode, createBox, createEngine,
        createPositionGizmo, createRotationGizmo, createSceneContext,
        createUtilityLayer, setRotationGizmoLocalCoordinates,
        type PositionGizmo, type RotationGizmo,
    } from "@babylonjs/lite";
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const cube = createBox(engine, 1);
    addToScene(scene, cube);
    const layer = createUtilityLayer(engine, scene);
`;

test("a lazily created gizmo held by a stored listener shares one cell", () => {
    const result = compileSource(`${preamble}
        let gizmo: RotationGizmo | null = null;
        canvas.addEventListener("mousedown", () => {
            if (!gizmo) {
                gizmo = createRotationGizmo(engine, layer);
                setRotationGizmoLocalCoordinates(gizmo, true);
            }
            attachRotationGizmoToNode(gizmo, cube);
        });
    `);

    // The declaration is storage, not a value: the widget does not exist yet.
    assert.match(
        result.cpp,
        /auto v_gizmo = bbl::js::make_gc_shared<std::optional<bbl::CompositeGizmoHandle>>\(\);/,
        "the nullable gizmo declares empty optional storage in a shared cell",
    );
    // A stored listener owns its environment by value, so the cell -- not the
    // widget -- is what the closure copies. Writing through a copied handle
    // would leave the second click attaching a gizmo the first never built.
    assert.match(
        result.cpp,
        /std::tuple\{[^}\n]*\bv_gizmo\b/,
        "the listener retains the cell rather than a copy of the handle",
    );
    assert.doesNotMatch(result.cpp, /std::ref\(v_gizmo\)/);
    assert.match(
        result.cpp,
        /if \(!\(v_gizmo->has_value\(\)\)\) \{/,
        "the source's own guard reads the storage's presence",
    );
    assert.match(
        result.cpp,
        /\(\*v_gizmo\) = bbl::create_rotation_gizmo\(v_engine, v_layer,/,
        "the factory result lands in the storage",
    );
    assert.match(
        result.cpp,
        /bbl::set_composite_gizmo_local_coordinates\(v_engine, \(\*\*v_gizmo\)/,
        "a narrowed read dereferences the cell",
    );
    assert.match(
        result.cpp,
        /bbl::attach_composite_gizmo_to_node\(v_engine, \(\*\*v_gizmo\), v_cube\)/,
        "the engine the assignment carried reaches the later attach call",
    );
});

test("an uncaptured lazily created gizmo is a plain optional local", () => {
    const result = compileSource(`${preamble}
        let gizmo: RotationGizmo | null = null;
        gizmo = createRotationGizmo(engine, layer);
        if (gizmo) {
            attachRotationGizmoToNode(gizmo, cube);
        }
        gizmo = null;
    `);

    assert.match(
        result.cpp,
        /std::optional<bbl::CompositeGizmoHandle> v_gizmo;/,
        "nothing stores the name, so it needs no shared cell",
    );
    assert.doesNotMatch(
        result.cpp,
        /make_gc_shared<std::optional<bbl::CompositeGizmoHandle>>/,
    );
    assert.match(result.cpp, /v_gizmo = bbl::create_rotation_gizmo\(v_engine, v_layer,/);
    assert.match(result.cpp, /if \(v_gizmo\.has_value\(\)\) \{/);
    assert.match(result.cpp, /v_gizmo\.reset\(\);/, "assigning null empties the storage");
});

test("one widget's storage refuses another widget's handle", () => {
    assert.throws(
        () =>
            compileSource(`${preamble}
                let gizmo: RotationGizmo | null = null;
                gizmo = createPositionGizmo(engine, layer);
                attachRotationGizmoToNode(gizmo, cube);
            `),
        /Nullable rotation-gizmo assignment received position-gizmo\./,
    );
});

test("a scene's own type of the same name is not an engine value", () => {
    // The table is keyed by the pinned typings, not by a name: a source
    // interface that happens to be called PositionGizmo stays plain data and
    // must not claim a native gizmo record.
    const result = compileSource(`${preamble}
        interface PositionGizmo { readonly tag: number; }
        let local: PositionGizmo | null = null;
        canvas.addEventListener("mousedown", () => {
            local = { tag: 1 };
        });
    `);
    assert.doesNotMatch(result.cpp, /CompositeGizmoHandle/);
    assert.doesNotMatch(result.cpp, /EditGizmoHandle/);
});

test("attaching a maybe-absent node detaches instead of dereferencing", () => {
    // The pin assigns `gizmo.attachedNode = node` for a null node too and
    // its follow returns early on it, which the generated follow already
    // implements as `attached_node.value >= meshes.size()`. Emitting the
    // optional's `operator*` instead threw `std::bad_optional_access` from
    // inside the scene's own pointer callback -- and no static capture pose
    // reaches it, because the parity run never clicks.
    const result = compileSource(`${preamble}
        const picker = createGpuPicker(scene);
        const targets = [cube];
        let gizmo: RotationGizmo | null = null;
        canvas.addEventListener("mousedown", async (e) => {
            const info = await pickAsync(picker, e.offsetX, e.offsetY);
            const picked = info.hit ? info.pickedMesh : null;
            const target =
                picked && targets.includes(picked as Mesh)
                    ? (picked as Mesh)
                    : null;
            if (!gizmo) {
                gizmo = createRotationGizmo(engine, layer);
                setRotationGizmoLocalCoordinates(gizmo, true);
            }
            attachRotationGizmoToNode(gizmo, target);
        });
    `.replace(
        "createPositionGizmo, createRotationGizmo",
        "createGpuPicker, createPositionGizmo, createRotationGizmo, pickAsync, type Mesh,",
    ));
    const attach = result.cpp
        .split("\n")
        .find((line) => line.includes("attach_composite_gizmo_to_node"));
    assert.ok(attach, "the attach call is emitted");
    // The absent arm is the empty handle, whose `invalid_handle` value is
    // what the follow's bounds guard reads as "detached".
    assert.match(attach, /has_value\(\) \? .* : bbl::MeshHandle\{\}/);
});
