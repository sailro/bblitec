import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

// A pre-built view an `unknown` field holds: an entry's own, a shared shader
// material, or none, chosen by functions typed to return `unknown`. A frame
// callback adds each pending mesh to a task with the view it holds.
const program = (viewFor: string): string => `
import { createEngine, createSceneContext, createFreeCamera, createSphere, addToScene, registerScene, startEngine, createRenderTask, addTask, addMeshToTask, removeMeshFromTask, createRenderTargetTexture, createStandardMaterial, createShaderMaterial, onBeforeRender, wgsl, type SceneContext, type Mesh, type RenderTask, type ShaderMaterial } from "@babylonjs/lite";
const VERTEX = wgsl\`struct VertexOutput { @builtin(position) position: vec4<f32>, };
@vertex fn mainVertex(input: VertexInput) -> VertexOutput { var out: VertexOutput; out.position = shaderSystem.worldViewProjection * vec4<f32>(input.position, 1.0); return out; }\`;
const FRAGMENT = wgsl\`@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`;
interface Entry { mesh: Mesh; kind?: "silhouette" | "raw"; live?: boolean; view?: unknown }
interface Prepared { entry: Entry; view: unknown }
function createOutline(scene: SceneContext, task: RenderTask, other: Mesh) {
    const silhouette = createShaderMaterial({ name: "silhouette", vertexSource: VERTEX, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"] });
    const coverage = createShaderMaterial({ name: "coverage", vertexSource: VERTEX, fragmentSource: FRAGMENT, attributes: ["position"], uniforms: ["worldViewProjection"], depthWrite: false });
    const registered: Mesh[] = [];
    const viewFor = ${viewFor};
    const coverageFor = (entry: Entry, base: unknown): unknown => {
        if (!entry.live) return base;
        return coverage;
    };
    let pendingEntries: readonly Entry[] | null = null;
    let pendingViews: readonly Prepared[] = [];
    const apply = (views: readonly Prepared[]): void => {
        for (const mesh of registered) removeMeshFromTask(task, mesh);
        registered.length = 0;
        for (const { entry: e, view } of views) {
            addMeshToTask(task, e.mesh, view ? { material: view as ShaderMaterial } : undefined);
            registered.push(e.mesh);
        }
    };
    onBeforeRender(scene, () => {
        if (pendingEntries !== null) {
            pendingEntries = null;
            apply(pendingViews);
        }
    });
    return {
        select(entries: readonly Entry[]): void {
            const views: Prepared[] = [];
            for (const entry of entries) views.push({ entry, view: coverageFor(entry, viewFor(entry)) });
            pendingEntries = entries;
            pendingViews = views;
        },
    };
}
const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
const scene = createSceneContext(engine);
scene.camera = createFreeCamera([0, 0, -5], [0, 0, 0]);
const sphere = createSphere(engine, { diameter: 1 });
sphere.material = createStandardMaterial();
addToScene(scene, sphere);
const target = createRenderTargetTexture(engine, { lbl: "t", format: "rgba8unorm", dFormat: "depth24plus", samples: 1, size: { width: 8, height: 8 } });
const task = createRenderTask({ name: "mask", rt: target.rt, autoMirror: false }, engine, scene);
addTask(scene, task);
const outline = createOutline(scene, task, sphere);
await registerScene(scene);
outline.select([{ mesh: sphere, kind: Math.random() > 0.5 ? "silhouette" : "raw", live: Math.random() > 0.5 }]);
await startEngine(engine);
`;

test("an unknown field its writes fill with one handle stores that handle", () => {
    const { cpp } = compileSource(
        program(`(entry: Entry): unknown => {
        if (entry.view !== undefined) return entry.view;
        switch (entry.kind) {
            case "silhouette":
                return silhouette;
            case "raw":
            default:
                return undefined;
        }
    }`),
    );
    // Both erased fields hold the material or nothing, with its engine.
    const field =
        /bbl::js::Nullable<std::pair<bbl::StoredEngine, bbl::MaterialHandle>> view;/g;
    assert.equal(cpp.match(field)?.length, 2);
    // `view as ShaderMaterial`, read through the destructured binding, is
    // the override where the view is present; the mesh's own material else.
    assert.match(
        cpp,
        /if \([^\n]*view[^\n]*\) \{\s*bbl::add_render_task_mesh\([^;]*\(\(\*v_[\w]*view\)\)\.second, true\);\s*\} else \{\s*bbl::add_render_task_mesh\([^;]*\.material, false\);\s*\}/,
    );
    // The view function returns the entry's view, the shared material, or none.
    assert.match(cpp, /return v_\w*entry->view;/);
    assert.match(
        cpp,
        /return std::pair<bbl::StoredEngine, bbl::MaterialHandle>\{bbl::StoredEngine\{v_\w*engine\}, v_\w*silhouette\};/,
    );
    assert.match(
        cpp,
        /return bbl::js::Nullable<std::pair<bbl::StoredEngine, bbl::MaterialHandle>>\{std::nullopt\};/,
    );
});

test("an unknown field its writes fill with two handle kinds refuses", () => {
    assert.throws(
        () =>
            compileSource(
                program(`(entry: Entry): unknown => {
        if (entry.kind === "silhouette") return silhouette;
        return other;
    }`),
            ),
        /Function 'viewFor' uses early value returns but its return type is outside the native data model/,
    );
});

// A fence answering for the mesh a pick hands its stored method, whose
// `object | null` parameter takes the storage of the handle that reaches it.
const fence = (elementAt: string, query: string): string => `
import { addToScene, createBox, createEngine, createSceneContext, createStandardMaterial, type Mesh } from "@babylonjs/lite";
interface Fence { mesh: Mesh; elementAt(pickedMesh: object | null, faceId: number): number | null; direct: Array<(pickedMesh: object | null, faceId: number) => number | null> }
function createFence(engine: Parameters<typeof createBox>[0]): Fence {
    const mesh = createBox(engine);
    const hits: number[] = [7, 8, 9];
    const elementAt = ${elementAt};
    const direct: Array<typeof elementAt> = [elementAt];
    return { mesh, elementAt, direct };
}
const engine = await createEngine({});
const scene = createSceneContext(engine);
const fence = createFence(engine);
addToScene(scene, fence.mesh);
const hit = ${query};
if (hit === 5) throw new Error("never");
`;
const comparing = `(pickedMesh: object | null, faceId: number): number | null => {
        if (pickedMesh !== mesh) return null;
        return hits[faceId] ?? null;
    }`;
const meshParameter =
    "bbl::js::Callback<bbl::js::Nullable<double>(bbl::js::Nullable<std::pair<bbl::StoredEngine, bbl::MeshHandle>>, double)>";

test("an object parameter its body compares with a mesh stores that mesh", () => {
    const { cpp } = compileSource(
        fence(
            comparing,
            "fence.elementAt(Math.random() > 0.5 ? fence.mesh : null, 1)",
        ),
    );
    // The interface's signature, and the array typed by the arrow's own,
    // both pass the mesh with its engine, or nothing.
    assert.ok(cpp.includes(`${meshParameter} elementAt;`));
    assert.ok(cpp.includes(`bbl::js::Array<${meshParameter}> direct;`));
    // The comparison is the mesh's identity: its engine and its slot.
    assert.match(
        cpp,
        /\.has_value\(\) && bbl::js::detail::same_value_zero\(\(\*v_\w+\), std::pair<bbl::StoredEngine, bbl::MeshHandle>\{bbl::StoredEngine\{v_engine\}, v_\w*mesh\}\)/,
    );
});

test("an object parameter its callers pass a mesh stores that mesh", () => {
    const { cpp } = compileSource(
        fence(
            `(pickedMesh: object | null, faceId: number): number | null =>
        pickedMesh === null ? null : (hits[faceId] ?? null)`,
            "fence.elementAt(fence.mesh, 1)",
        ),
    );
    assert.ok(cpp.includes(`${meshParameter} elementAt;`));
    assert.match(cpp, /if \(!v_\w*pickedMesh\.has_value\(\)\)/);
});

test("an object parameter holding a mesh refuses other values", () => {
    for (const [argument, refusal] of [
        [
            "createStandardMaterial()",
            /Compile-time material value does not match the expected data handle/,
        ],
        ["{ x: 1 }", /Expected a mesh value, received record/],
    ] as const)
        assert.throws(
            () =>
                compileSource(
                    fence(comparing, `fence.elementAt(${argument}, 1)`),
                ),
            refusal,
        );
});
