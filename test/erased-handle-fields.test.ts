import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

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

// Materials held as `unknown` and read back through a view the pin does not
// declare, collected by identity into a Set and a Map with erased keys.
const identityProgram = `
import { createEngine, createStandardMaterial } from "@babylonjs/lite";
type Held = { material?: unknown };
function collect(held: readonly Held[], other: object): string {
    const seen = new Set<object>();
    const uses = new Map<unknown, number>();
    let added = 0;
    for (const entry of held) {
        const material = entry.material as { tint?: number } | undefined;
        if (material && typeof material === "object") {
            uses.set(material, (uses.get(material) ?? 0) + 1);
            if (!seen.has(material)) {
                seen.add(material);
                added++;
            }
        }
    }
    const first = held[1]?.material as { tint?: number } | undefined;
    const dropped = first ? seen.delete(first) : false;
    const again = first ? seen.delete(first) : false;
    return [added, seen.size, seen.has(other), dropped, again, uses.size, uses.get(other) ?? 0].join();
}
async function main(): Promise<void> {
    await createEngine({});
    const a = createStandardMaterial();
    const b = createStandardMaterial();
    const c = createStandardMaterial();
    const result = collect([{ material: a }, { material: b }, { material: a }, {}], a) + ";" + collect([{ material: c }, { material: b }], a);
    if (result !== "2,1,true,true,false,2,2;2,1,false,true,false,2,0") throw new Error("identity " + result);
}
void main();
`;

/**
 * Runs a program over materials as JavaScript runs it, each factory making a
 * fresh object, then natively where a native compiler is installed; each
 * run checks its own results. Returns the generated C++.
 */
async function checkMaterialIdentity(
    t: TestContext,
    name: string,
    program: string,
): Promise<string> {
    const realm: { finished?: Promise<void> } = {};
    runInNewContext(
        ts.transpileModule(
            program.replace("void main();", "realm.finished = main();"),
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.CommonJS,
                },
            },
        ).outputText,
        {
            exports: {},
            realm,
            require: () => ({
                createEngine: async () => ({}),
                createStandardMaterial: () => ({}),
            }),
        },
    );
    await realm.finished;
    const { cpp } = compileSource(program);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return cpp;
    }
    runGeneratedProgram(
        tools,
        `erased-handle-fields/${name}`,
        `#define main generated_main
${cpp}
#undef main
namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
// Each material is a record of its own; the run reads none of its fields.
MaterialHandle create_standard_material(Engine& engine) {
    engine.materials.emplace_back();
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}
} // namespace bbl
int main() { return generated_main(); }
`,
        { expectedOutput: "", timeoutMs: 20000 },
    );
    return cpp;
}

test("a Set and a Map whose erased keys a view of a material writes keep each material once by identity, as JavaScript does", async (t) => {
    const cpp = await checkMaterialIdentity(
        t,
        "identity-keys",
        identityProgram,
    );
    // The keys are the materials themselves, compared as handles.
    assert.match(cpp, /bbl::js::Set<[^>\n]*bbl::MaterialHandle/);
});

// Arrays of `unknown` and `object` elements written with materials: a
// binding of a generic whose untyped callback leaves its items `unknown`,
// a parameter and a record field.
const erasedArrayProgram = `
import { createEngine, createStandardMaterial } from "@babylonjs/lite";
function createPublication<Item>(sink: (items: readonly Item[]) => void) {
    let held: readonly Item[] = [];
    let revision = 0;
    return {
        publish(items: readonly Item[]): void {
            held = items;
            revision++;
            sink(items);
        },
        indexOf: (item: Item): number => held.indexOf(item),
        size: (): number => held.length,
        revision: (): number => revision,
    };
}
function count(list: readonly object[], item: object): number {
    let found = 0;
    for (const entry of list) if (entry === item) found++;
    return found;
}
async function main(): Promise<void> {
    await createEngine({});
    const a = createStandardMaterial();
    const b = createStandardMaterial();
    const c = createStandardMaterial();
    let sunk = 0;
    const publication = createPublication((items) => {
        sunk += items.length;
    });
    publication.publish([a, b, a]);
    const first = [publication.indexOf(a), publication.indexOf(b), publication.indexOf(c), publication.size()].join();
    publication.publish([c]);
    const box: { items: unknown[] } = { items: [] };
    box.items = [b, c, b];
    const result = first + ";" + [publication.indexOf(c), publication.indexOf(a), publication.revision(), sunk].join() + ";" + [count([a, b, a], a), count([b], a)].join() + ";" + [box.items.length, box.items.indexOf(c), box.items.lastIndexOf(b)].join();
    if (result !== "0,1,-1,3;0,-1,2,4;2,0;3,1,2") throw new Error("identity " + result);
}
void main();
`;

test("arrays of erased elements written with materials hold the materials by identity, as JavaScript does", async (t) => {
    const cpp = await checkMaterialIdentity(
        t,
        "erased-arrays",
        erasedArrayProgram,
    );
    // The binding and the field hold the materials, not documents.
    assert.match(cpp, /make_gc_shared<bbl::js::Array<bbl::MaterialHandle>>/);
    assert.match(cpp, /bbl::js::Array<bbl::MaterialHandle> items;/);
});

test("a view read of a material refuses: a property the program adds to a ShaderMaterial is not represented", () => {
    assert.throws(
        () =>
            compileSource(`
import { createEngine, createSceneContext, createShaderMaterial, createMeshFromData, wgsl, type Mesh } from "@babylonjs/lite";
const engine = await createEngine({});
createSceneContext(engine);
const material = createShaderMaterial({ name: "plain", vertexSource: wgsl\`@vertex fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(position, 1.0); }\`, fragmentSource: wgsl\`@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }\`, attributes: ["position"], uniforms: ["worldViewProjection"] });
const meshes: Mesh[] = [];
for (let i = 0; i < 2; i++) {
    const mesh = createMeshFromData(engine, "m" + i, new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), new Uint32Array([0, 1, 2]));
    mesh.material = material;
    meshes.push(mesh);
}
const tracked: { mat: { level?: number }; base: number }[] = [];
const seen = new Set<object>();
const collect = (list: readonly { material?: unknown }[]): void => {
    for (const m of list) {
        const mat = m.material as { level?: number } | undefined;
        if (mat && typeof mat === "object" && !seen.has(mat)) {
            seen.add(mat);
            const base = mat.level ?? 1;
            mat.level = base;
            tracked.push({ mat, base });
        }
    }
};
collect(meshes);
localStorage.setItem("count", String(tracked.length));
`),
        /'mat\.level' reads a material through a view the pin does not declare: a property the program adds to a ShaderMaterial is not represented/,
    );
});

// Engine objects an array of erased elements holds, re-viewed as records of
// a structural type the program asserts (`held as unknown as readonly View[]`).
const viewedArrayProgram = `
import { createEngine, createStandardMaterial } from "@babylonjs/lite";
// A view the program asserts over the engine objects a generic holder keeps.
interface Seen {
    alpha?: number | undefined;
}
function createHolder<Item>() {
    let held: readonly Item[] = [];
    return {
        publish(items: readonly Item[]): void {
            held = items;
        },
        current: () => held as unknown as readonly Seen[],
    };
}
function labelsFor(seen: readonly Seen[], subject: readonly unknown[]): string {
    const wanted = new Set(subject);
    const labels: number[] = [];
    for (let index = 0; index < seen.length; index++) if (wanted.has(seen[index])) labels.push(index);
    return labels.join("+");
}
async function main(): Promise<void> {
    await createEngine({});
    const a = createStandardMaterial();
    const b = createStandardMaterial();
    const c = createStandardMaterial();
    const holder = createHolder();
    holder.publish([a, b, a]);
    const seen = holder.current();
    const result = [seen.length, labelsFor(seen, [a]), labelsFor(seen, [b, c]), labelsFor(holder.current(), [c])].join(";");
    if (result !== "3;0+2;1;") throw new Error("view " + result);
}
void main();
`;

test("an array of engine objects asserted as records of a view stays the one array of those objects, as JavaScript keeps it", async (t) => {
    const cpp = await checkMaterialIdentity(
        t,
        "viewed-arrays",
        viewedArrayProgram,
    );
    // The view returns the held array of materials, not a copy of records.
    assert.match(
        cpp,
        /bbl::js::Array<bbl::MaterialHandle> bbl_recursive_\w+_group\(/,
    );
});

// A view over meshes reading a member the pin declares, then one it does not.
const meshView = (read: string): string => `
import { createEngine, createSceneContext, createBox, addToScene } from "@babylonjs/lite";
interface Observed {
    name?: string | undefined;
    thinInstances?: { _version?: number | undefined } | null | undefined;
}
function createHolder<Item>() {
    let held: readonly Item[] = [];
    return {
        publish(items: readonly Item[]): void {
            held = items;
        },
        current: () => held as unknown as readonly Observed[],
    };
}
const engine = await createEngine({});
const scene = createSceneContext(engine);
const a = createBox(engine, { size: 1 });
const b = createBox(engine, { size: 2 });
addToScene(scene, a);
addToScene(scene, b);
const holder = createHolder();
holder.publish([a, b]);
const names = holder.current().map((mesh) => mesh.name ?? "unnamed");
const wanted = new Set<unknown>([b]);
const found = holder.current().filter((mesh) => wanted.has(mesh)).length;
const versions = ${read};
localStorage.setItem("probe", \`\${names.join()} \${found} \${versions.join()}\`);
`;

test("a view over engine objects reads their pinned members and refuses, by name, a member the pin does not declare", () => {
    const { cpp } = compileSource(
        meshView(
            "holder.current().map((mesh) => mesh.thinInstances?._version ?? 0)",
        ),
    );
    // Each read is the mesh's own record: its name, its thin instances' version.
    assert.match(cpp, /bbl::handle_at\(v_engine\.meshes, \w+\)\.name;/);
    assert.match(
        cpp,
        /bbl::thin_instance_data\([^;]*\.thin_instances\)\.version/,
    );
    assert.throws(
        () =>
            compileSource(
                meshView(
                    "holder.current().map((mesh) => mesh.extra ?? 0)",
                ).replace(
                    "    name?: string | undefined;",
                    "    name?: string | undefined;\n    extra?: number | undefined;",
                ),
            ),
        /'mesh\.extra' reads a mesh through a view the pin does not declare: a property the program adds to an engine object is not represented/,
    );
});
