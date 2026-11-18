import { createJavaScriptFunction } from "../src/typescript-transpile.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { PickingLowerer } from "../src/lowering/picking-lowerer.js";
import { pinnedNormalizeVec3Header } from "../src/lowering/pinned-normalize-vec3.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { composePickDiscardShaders } from "../src/pinned-picking-shaders.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

function program(twoEngines = false): string {
    return `
import {createEngine,createSceneContext,createUtilityLayer,createGpuPicker,pickAsync,disposePicker,getPickedNormal,
 type EngineContext,type SceneContext,type PickingInfo,type Mesh} from "@babylonjs/lite";
async function directPicks(engine:EngineContext):Promise<void> {
 const scene=createSceneContext(engine);
 const layer=createUtilityLayer(scene);
 const picker=createGpuPicker(layer.scene);
 let calls=0;
 const run=async():Promise<void>=>{
  const info=await pickAsync(picker,1,0);
  const alias=info;
  if(!alias.hit || !alias.pickedMesh) throw new Error("direct hit");
  const mesh=alias.pickedMesh as Mesh;
  const implicit:Mesh[]=[info.pickedMesh!];
  const explicit:Mesh[]=[mesh];
  if(mesh.name!=="first" || implicit[0]!.name!=="first" || explicit[0]!==implicit[0]) throw new Error("aliased engine");
  calls++;
 };
 const callbacks:Array<()=>Promise<void>>=[run];
 await callbacks[0]!();
 await callbacks[0]!();
 if(calls!==2) throw new Error("callback state");
 disposePicker(picker);
}
async function find(scene:SceneContext,canvas:HTMLCanvasElement,name:string):Promise<PickingInfo|null> {
 const picker=createGpuPicker(scene);
 for(let y=0;y<=12;y++) {
  for(let x=0;x<=16;x++) {
   const info=await pickAsync(picker,canvas.clientWidth*x/16,canvas.clientHeight*y/12);
   if(info.hit && info.pickedMesh?.name===name) {disposePicker(picker);return info;}
  }
 }
 disposePicker(picker);
 return null;
}
function normalY(info:PickingInfo):number {return getPickedNormal(info)?.[1] ?? -1;}
async function main() {
 const canvas=document.getElementById("renderCanvas") as HTMLCanvasElement;
 const firstEngine=await createEngine({title:"first"});
 const firstScene=createSceneContext(firstEngine);
 const secondEngine=${twoEngines ? 'await createEngine({title:"second"})' : "firstEngine"};
 const secondScene=createSceneContext(secondEngine);
 const first=await find(firstScene,canvas,"first");
 const second=await find(secondScene,canvas,"${twoEngines ? "second" : "first"}");
 const miss=await find(firstScene,canvas,"absent");
 if(!first?.hit || !second?.hit || miss!==null) throw new Error("nullable early return");
 const alias=first;
 const again=await find(firstScene,canvas,"first");
 if(alias!==first || again===first) throw new Error("result identity");
 const rows:PickingInfo[]=[first,second];
 const record:{pick:PickingInfo|null}={pick:second};
 const storedRecord:{pick:PickingInfo}={pick:second};
 if(!rows.includes(alias) || rows.includes(again!)) throw new Error("array identity");
 const indices=new Map<PickingInfo,number>();
 indices.set(first,7); indices.set(second,11);
 if(indices.get(alias)!==7 || indices.get(again!)!==undefined) throw new Error("Map identity");
 if(!record.pick?.hit) throw new Error("record optional result");
 if(record.pick.pickedMesh?.name!=="${twoEngines ? "second" : "first"}" || rows[0]!.pickedMesh?.name!=="first") throw new Error("engine provenance");
 if(normalY(rows[0]!)!==0 || normalY(record.pick!)!==${twoEngines ? 1 : 0}) throw new Error("normal provenance");
 if(normalY(storedRecord.pick)!==${twoEngines ? 1 : 0}) throw new Error("stored record normal provenance");
 let index=0;
 if(rows[index++]!.pickedMesh?.name!=="first" || index!==1) throw new Error("owner evaluated twice");
 if(first.bu!==1/3 || first.bv!==1/7) throw new Error("barycentric precision");
 if(!first.pickedPoint) throw new Error("point missing");
 const [x,y,z]=first.pickedPoint;
 if(x!==1 || y!==2 || z!==3) throw new Error("point transport");
 let read:()=>number=()=>-1;
 { const retained=second; read=()=>retained.bu; }
 if(read()!==1/3) throw new Error("retained result");
 alias.bu=0.75; alias.bv=0.5;
 if(first.bu!==0.75 || rows[0]!.bv!==0.5) throw new Error("shared scalar mutation");
 await directPicks(firstEngine);
}
`;
}

test("nullable picking results reuse data returns and preserve the unchanged scene", () => {
    const result = compileSource(program());
    assert(!result.manifest.features.includes("platform:window"));
    assert.match(result.cpp, /Nullable<bbl::PickingInfo>/);
    assert.match(
        result.cpp,
        /return bbl::js::Nullable<bbl::PickingInfo>\{std::nullopt\}/,
    );
    assert.match(result.cpp, /picked_normal\([^,]+, false\)/);
    assert.equal(result.cpp.match(/bbl::gpu_pick\(/g)?.length, 5);
    assert.equal(result.cpp.match(/for \(;/g)?.length, 8);
    const fileName = "corpus/babylon-lite/lab/lite/src/lite/scene114.ts";
    const unchanged = compileSource(readFileSync(fileName, "utf8"), {
        fileName,
    });
    assert.equal(unchanged.cpp.match(/bbl::gpu_pick\(/g)?.length, 4);
    assert.equal(unchanged.manifest.sceneMeshes.length, 19);
    for (const access of [
        'if(info.subMeshId>0) throw new Error("subMeshId")',
        "info.pickedMesh = null",
        "info.pickedPoint = [3,2,1]",
    ]) {
        assert.throws(
            () =>
                compileSource(`import {createEngine,createSceneContext,createGpuPicker,pickAsync} from "@babylonjs/lite";
            async function main(){const e=await createEngine({});const s=createSceneContext(e);const p=createGpuPicker(s);const info=await pickAsync(p,0,0);${access};}`),
            /Unsupported|not supported/,
        );
    }
});

test("data-transported results become bare meshes of the entry engine their pick proves", () => {
    for (const body of [
        "const meshes:Mesh[]=[info.pickedMesh as Mesh]; return meshes[0]!.name;",
        "const meshes:Mesh[]=[info.pickedMesh!]; return meshes[0]!.name;",
        "const mesh=info.pickedMesh as Mesh; return mesh.name;",
        "const selected=direct.pickedMesh ?? info.pickedMesh; const mesh=selected as Mesh; return mesh.name;",
        "let selected=direct; selected=info; const mesh=selected.pickedMesh as Mesh; return mesh.name;",
    ]) {
        const result = compileSource(`
            import {createEngine,createSceneContext,createGpuPicker,pickAsync,type PickingInfo,type Mesh} from "@babylonjs/lite";
            async function main() {
                const engine=await createEngine({}); const scene=createSceneContext(engine);
                const picker=createGpuPicker(scene); const direct=await pickAsync(picker,0,0);
                const readers:Array<(info:PickingInfo)=>string>=[(info)=>{${body}}];
                if(readers[0]!(direct)==="wrong") throw new Error("wrong owner");
            }
        `);
        assert.match(result.cpp, /bbl::picked_mesh\([^()]+, v_engine\)/, body);
    }
});

test("pinned result identity, nullable helpers and engine provenance satisfy the same assertions", async () => {
    const pin = await import("@babylonjs/lite");
    const { createEmptyPickingInfo } = await importPinnedModule<{
        createEmptyPickingInfo(
            this: void,
        ): import("@babylonjs/lite").PickingInfo;
    }>("picking/picking-info.js");
    const javascript = ts.transpileModule(
        program(true).replace(
            /import\s*\{[^}]+\}\s*from\s*"@babylonjs\/lite";/,
            "",
        ),
        {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
            },
        },
    ).outputText;
    interface Host {
        title: string;
        mesh: {
            name: string;
            _cpuNormals: Float32Array;
            _cpuIndices: Uint32Array;
            worldMatrix: Float32Array;
        };
    }
    const identity = new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
    ]);
    const createEngine = async ({
        title,
    }: {
        title: string;
    }): Promise<Host> => ({
        title,
        mesh: {
            name: title,
            _cpuNormals: new Float32Array(
                title === "first"
                    ? [1, 0, 0, 1, 0, 0, 1, 0, 0]
                    : [0, 1, 0, 0, 1, 0, 0, 1, 0],
            ),
            _cpuIndices: new Uint32Array([0, 1, 2]),
            worldMatrix: identity,
        },
    });
    const createSceneContext = (engine: Host) => ({ engine });
    const createGpuPicker = (scene: { engine: Host }) => ({ scene });
    const queries: number[][] = [];
    const pickAsync = async (
        picker: { scene: { engine: Host } },
        x: number,
        y: number,
    ) => {
        queries.push([x, y]);
        const info = createEmptyPickingInfo();
        if (!((x === 160 && y === 60) || (x === 1 && y === 0))) return info;
        // Only GPU readback is a seam. The result/default factory and normal
        // helper are the installed pin, and the source assertions are shared.
        Object.assign(info, {
            hit: true,
            pickedMesh: picker.scene.engine.mesh,
            pickedPoint: [1, 2, 3],
            faceId: 0,
            bu: 1 / 3,
            bv: 1 / 7,
        });
        return info;
    };
    // Graphics factories expose only engine/scene association at this seam.
    const createUtilityLayer = (mainScene: { engine: Host }) => ({
        scene: createSceneContext(mainScene.engine),
    });
    const run = createJavaScriptFunction(
        "createEngine",
        "createSceneContext",
        "createUtilityLayer",
        "createGpuPicker",
        "pickAsync",
        "disposePicker",
        "getPickedNormal",
        "document",
        `${javascript}\nreturn main();`,
    );
    await run(
        createEngine,
        createSceneContext,
        createUtilityLayer,
        createGpuPicker,
        pickAsync,
        () => {},
        pin.getPickedNormal,
        { getElementById: () => ({ clientWidth: 1280, clientHeight: 720 }) },
    );
    assert.deepEqual(queries, [
        ...[20, 20, 221, 20].flatMap((count) =>
            Array.from({ length: count }, (_, index) => [
                (index % 17) * 80,
                Math.floor(index / 17) * 60,
            ]),
        ),
        [1, 0],
        [1, 0],
    ]);
});

const tools = optionalNativeFixtureTools(false);

/**
 * Builds a generated program with the lowered picking unit and a native
 * `check` that stubs the engine, and returns what the executable prints.
 */
function runPickingCheck(name: string, cpp: string, check: string): string {
    const output = resolve("artifacts", name);
    const headers = join(output, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    const context = new LoweringContext();
    writeFileSync(
        join(headers, "pinned_normalize_vec3.hpp"),
        pinnedNormalizeVec3Header(context),
    );
    writeFileSync(
        join(headers, "renderer_plan.hpp"),
        `#pragma once\n#include <bblite/runtime.hpp>\nnamespace bbl::upstream { std::array<float,16> mesh_world_matrix(const Engine&,const MeshRecord&); }\n`,
    );
    writeFileSync(
        join(output, "picking.cpp"),
        new PickingLowerer(context).lower(false, true).source,
    );
    const source = join(output, "check.cpp");
    const executable = join(output, "check.exe");
    writeFileSync(
        source,
        `#define main generated_scene_main\n${cpp}\n#undef main\n${check}`,
    );
    runNativeFixtureCompiler(tools!, [
        "/O2",
        "/DBBLITE_HAS_PICKING=1",
        "/I",
        output,
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        source,
        join(output, "picking.cpp"),
    ]);
    return execFileSync(executable, { encoding: "utf8" });
}

test(
    "native picking preserves identity, aliased callback engines, query order and checked lifetime",
    { skip: !tools },
    () => {
        assert.match(
            runPickingCheck(
                "picking-info-check",
                compileSource(program()).cpp,
                readFileSync("test/fixtures/picking-info-check.cpp", "utf8"),
            ),
            /picking-info-check: ok/,
        );
    },
);

/**
 * `runPickingCheck` over a stub engine of two meshes whose `pick_hook` is
 * `hook`, an assignment to `engine.pick_hook` with `engine` in scope; the
 * scene must return normally.
 */
function runPickHookCheck(name: string, cpp: string, hook: string): string {
    return runPickingCheck(
        name,
        cpp,
        `#include <cassert>
#include <iostream>
namespace bbl {
Engine create_engine(EngineOptions options) {
    Engine engine;
    engine.options = options;
    engine.meshes.emplace_back();
    engine.meshes.emplace_back();
${hook}    return engine;
}
Scene create_scene_context(Engine& engine) {
    Scene scene;
    scene.engine = &engine;
    return scene;
}
std::vector<float> mesh_cpu_positions(const Engine&, MeshHandle) { return {}; }
std::vector<float> mesh_cpu_normals(const Engine&, MeshHandle) { return {}; }
std::vector<std::uint32_t> mesh_cpu_indices(const Engine&, MeshHandle) { return {}; }
namespace upstream {
std::array<float, 16> mesh_world_matrix(const Engine&, const MeshRecord&) {
    return {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
}
} // namespace upstream
} // namespace bbl
int main() {
    assert(generated_scene_main() == 0);
    bbl::js::collect_cycles();
    std::cout << "${name}: ok\\n";
}
`,
    );
}

test("a pick's filter option is the scene's predicate, asked per mesh after the options' coordinates", (t) => {
    const result = compileSource(`
        import {createEngine,createSceneContext,createGpuPicker,pickAsync,type Mesh} from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const picker = createGpuPicker(scene);
            const plain = await pickAsync(picker, 1, 0);
            const first = plain.pickedMesh as Mesh;
            let asked = 0;
            const order: string[] = [];
            const coordinate = (value: number): number => { order.push("x"); return value; };
            const info = await pickAsync(picker, coordinate(1), 0, {
                filter: (mesh) => { asked++; return mesh !== first; },
                debugLabel: (order.push("label"), "skip-first"),
            });
            const picked = info.pickedMesh as Mesh;
            if (!info.hit || picked === first || asked !== 2 || order.join() !== "x,label")
                throw new Error("filtered pick " + asked);
        }
        void main();
    `);
    assert.match(result.cpp, /bbl::gpu_pick\([^\n]*bbl::Engine::PickFilter\(/);
    for (const [option, message] of [
        ["{ discard: rule }", /pickAsync `discard` rule folds at generation/],
        [
            "{ filter(m: Mesh) { return m === mesh; } }",
            /pickAsync options are lowered from plain/,
        ],
        ["extra", /pickAsync options are lowered from an object literal/],
    ] as const)
        assert.throws(
            () =>
                compileSource(`
                import {createEngine,createSceneContext,createGpuPicker,pickAsync,createSphere,type Mesh,type PickDiscardRule} from "@babylonjs/lite";
                async function main(rule: PickDiscardRule, extra: { debugLabel?: string }) {
                    const engine = await createEngine({});
                    const scene = createSceneContext(engine);
                    const mesh: Mesh = createSphere(engine, {});
                    const info = await pickAsync(createGpuPicker(scene), 0, 0, ${option});
                    if (info.hit && !mesh) throw new Error("never");
                }
                void main({ key: "k", wgsl: "" }, {});
            `),
            message,
        );
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    assert.match(
        runPickHookCheck(
            "picking-filter-check",
            result.cpp,
            `
    engine.pick_hook = [](GpuPickerHandle, double, double, const Engine::PickOptions* options) {
        PickingInfo info;
        for (std::uint32_t index = 0; index < 2; ++index) {
            if (options && options->filter && !options->filter(MeshHandle{index}))
                continue;
            info.hit = true;
            info.picked_kind = PickedNodeKind::mesh;
            info.picked_index = index;
            break;
        }
        return info;
    };
`,
        ),
        /picking-filter-check: ok/,
    );
});

test("a pick's ignore option reaches the native pick as its entries, through the options' conditional spreads", (t) => {
    const result = compileSource(`
        import {createEngine,createSceneContext,createGpuPicker,pickAsync,type Mesh,type PickIgnore,type PickingInfo} from "@babylonjs/lite";
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const picker = createGpuPicker(scene);
            const first = (await pickAsync(picker, 1, 0)).pickedMesh as Mesh;
            const order: string[] = [];
            const project = (whole: boolean): PickIgnore | readonly PickIgnore[] => {
                order.push("ignore");
                return whole ? { mesh: first } : [{ mesh: first, thinInstanceRange: { start: 1.5, count: 2 } }, { mesh: first, thinInstanceIndex: 4 }];
            };
            const pick = (whole: boolean | undefined, label?: string) => {
                const ignored = whole === undefined ? undefined : project(whole);
                return pickAsync(picker, 1, 0, {
                    filter: () => { order.push("filter"); return true; },
                    ...(ignored ? { ignore: ignored } : {}),
                    ...(label ? { debugLabel: label } : {}),
                });
            };
            const skipped = await pick(true, "whole");
            const thin = await pick(false);
            const none = await pick(undefined);
            const one = await pickAsync(picker, 1, 0, { ignore: { mesh: first, thinInstanceIndex: 2 } });
            const optional = (ignored: PickIgnore | undefined) => pickAsync(picker, 1, 0, { ignore: ignored });
            const absent = await optional(undefined);
            const present = await optional({ mesh: first });
            const describe = (picked: Mesh, point: PickingInfo["pickedPoint"]): string =>
                (picked === first ? "first" : "second") + (point ? ":" + point[0] + ":" + point[1] + ":" + point[2] : "");
            const report = [
                describe(skipped.pickedMesh as Mesh, skipped.pickedPoint),
                describe(thin.pickedMesh as Mesh, thin.pickedPoint),
                describe(none.pickedMesh as Mesh, none.pickedPoint),
                describe(one.pickedMesh as Mesh, one.pickedPoint),
                describe(absent.pickedMesh as Mesh, absent.pickedPoint),
                describe(present.pickedMesh as Mesh, present.pickedPoint),
            ];
            if (report.join() !== "second:1:-1:-1,first:2:-1:1502,first:0:-1:-1,first:1:2:-1,first:0:-1:-1,second:1:-1:-1" ||
                order.join() !== "ignore,filter,ignore,filter,filter")
                throw new Error(report.join() + " " + order.join());
        }
        void main();
    `);
    assert.match(result.cpp, /bbl::Engine::PickOptions\{/);
    assert.throws(
        () =>
            compileSource(`
            import {createEngine,createSceneContext,createGpuPicker,pickAsync,createSphere} from "@babylonjs/lite";
            async function main(flag: boolean) {
                const engine = await createEngine({});
                const mesh = createSphere(engine, {});
                const scene = createSceneContext(engine);
                const picker = createGpuPicker(scene);
                await pickAsync(picker, 0, 0, { ignore: [], ...(flag ? { ignore: { mesh } } : {}) });
            }
            void main(Date.now() > 0);
        `),
        /pickAsync options name 'ignore' once/,
    );
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    // The stub reports the entries it was handed as the picked point: their
    // count, the first one's index and its range (start * 1000 + count); it
    // skips a mesh whose first entry names neither.
    assert.match(
        runPickHookCheck(
            "picking-ignore-check",
            result.cpp,
            `
    engine.pick_hook = [](GpuPickerHandle, double, double, const Engine::PickOptions* options) {
        PickingInfo info;
        const auto& entries = options ? options->ignore : std::vector<Engine::PickIgnore>{};
        info.picked_point = std::array<double, 3>{static_cast<double>(entries.size()),
            entries.empty() ? -1.0 : entries[0].thin_instance_index.value_or(-1.0),
            entries.empty() || !entries[0].thin_instance_range ? -1.0
                : (*entries[0].thin_instance_range)[0] * 1000 + (*entries[0].thin_instance_range)[1]};
        for (std::uint32_t index = 0; index < 2; ++index) {
            const auto entry = std::find_if(entries.begin(), entries.end(),
                [index](const Engine::PickIgnore& ignore) { return ignore.mesh.value == index; });
            if (entry != entries.end() && !entry->thin_instance_index && !entry->thin_instance_range)
                continue;
            if (options && options->filter && !options->filter(MeshHandle{index}))
                continue;
            info.hit = true;
            info.picked_kind = PickedNodeKind::mesh;
            info.picked_index = index;
            break;
        }
        return info;
    };
`,
        ),
        /picking-ignore-check: ok/,
    );
});

test("a pick's discard rule reaches the native pick with each storage entry's data, asked per mesh in declaration order", (t) => {
    const result = compileSource(`
        import {createEngine,createSceneContext,createGpuPicker,pickAsync,type Mesh,type PickDiscardRule,type PickingInfo} from "@babylonjs/lite";
        const HIDE = "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return hidden[0] > 0.5; }";
        const shared = { name: "hidden", type: "array<f32>" };
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const picker = createGpuPicker(scene);
            const first = (await pickAsync(picker, 1, 0)).pickedMesh as Mesh;
            const order: string[] = [];
            const lanes = new Float32Array([1, 2, 3]);
            const rule: PickDiscardRule = {
                key: "hide-first",
                wgsl: HIDE,
                storage: [
                    { ...shared, data: (mesh: Mesh) => { order.push("hidden"); return mesh === first ? lanes : null; } },
                    { name: "tail", type: "array<f32>", vertex: true, data: () => { order.push("tail"); return lanes.subarray(1); } },
                ],
            };
            const other: PickDiscardRule = { key: "none", wgsl: HIDE.replace("hidden[0] > 0.5", "false") };
            const pick = (alternate: boolean) => pickAsync(picker, 1, 0, {
                filter: () => { order.push("filter"); return true; },
                discard: alternate ? other : rule,
            });
            const hidden = await pick(false);
            const plain = await pick(true);
            const describe = (picked: Mesh, point: PickingInfo["pickedPoint"]): string =>
                (picked === first ? "first" : "second") + (point ? ":" + point[0] + ":" + point[1] + ":" + point[2] : "");
            const report = [describe(hidden.pickedMesh as Mesh, hidden.pickedPoint), describe(plain.pickedMesh as Mesh, plain.pickedPoint)];
            if (report.join() !== "second:3:20:1102,first:0:0:40" ||
                order.join() !== "filter,filter,hidden,tail,hidden,filter,filter")
                throw new Error(report.join() + " " + order.join());
        }
        void main();
    `);
    // Each arm of the conditional, in source order.
    assert.deepEqual(result.manifest.pickDiscardRules, [
        {
            key: "none",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return false; }",
            storage: [],
        },
        {
            key: "hide-first",
            wgsl: "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return hidden[0] > 0.5; }",
            storage: [
                { name: "hidden", type: "array<f32>", vertex: false },
                { name: "tail", type: "array<f32>", vertex: true },
            ],
        },
    ]);
    for (const [rule, message] of [
        [
            `{ key: "k", wgsl: String(Date.now()) }`,
            /rule's `wgsl` is generation-known text/,
        ],
        [
            `{ key: "k", wgsl: "", storage: [{ name: "a", type: "u32", vertex: Date.now() > 0, data: () => null }] }`,
            /`vertex` is a generation-known boolean/,
        ],
    ] as const)
        assert.throws(
            () =>
                compileSource(`
                import {createEngine,createSceneContext,createGpuPicker,pickAsync} from "@babylonjs/lite";
                async function main() {
                    const engine = await createEngine({});
                    await pickAsync(createGpuPicker(createSceneContext(engine)), 0, 0, { discard: ${rule} });
                }
                void main();
            `),
            message,
        );
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    // The stub draws the two meshes the way the pin's draw loop asks a rule
    // once the filter built the candidates: per candidate, each entry in order until one returns null; a mesh all
    // of whose entries answered is discarded when its first lane exceeds one
    // half. It reports the entries asked, their bytes, and the key's length
    // beside the second entry's first lane and its stage.
    assert.match(
        runPickHookCheck(
            "picking-discard-check",
            result.cpp,
            `
    engine.pick_hook = [](GpuPickerHandle, double, double, const Engine::PickOptions* options) {
        PickingInfo info;
        double asked = 0, bytes = 0, tail = 0;
        std::vector<std::uint32_t> candidates;
        for (std::uint32_t index = 0; index < 2; ++index) {
            if (!options || !options->filter || options->filter(MeshHandle{index}))
                candidates.push_back(index);
        }
        for (const std::uint32_t index : candidates) {
            bool admitted = options && options->discard && !options->discard->storage.empty();
            std::vector<std::vector<std::uint8_t>> entries;
            for (std::size_t entry = 0; admitted && entry < options->discard->storage.size(); ++entry) {
                ++asked;
                auto data = options->discard->storage[entry].data(MeshHandle{index});
                if (!data)
                    admitted = false;
                else {
                    bytes += static_cast<double>(data->size());
                    entries.push_back(*data);
                }
            }
            float lane = 0.0f;
            if (admitted) {
                float second = 0.0f;
                std::memcpy(&lane, entries[0].data(), sizeof(lane));
                std::memcpy(&second, entries[1].data(), sizeof(second));
                tail = second + (options->discard->storage[1].vertex ? 1000.0 : 0.0);
            }
            if ((admitted && lane > 0.5f) || info.hit)
                continue;
            info.hit = true;
            info.picked_kind = PickedNodeKind::mesh;
            info.picked_index = index;
        }
        info.picked_point = std::array<double, 3>{asked, bytes,
            options && options->discard ? static_cast<double>(options->discard->key.size()) * 10.0 + tail : -1.0};
        return info;
    };
`,
        ),
        /picking-discard-check: ok/,
    );
});

test("a discard rule's modules splice its WGSL and storage into each pick pipeline the pin builds", async () => {
    const wgsl =
        "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return hide[0] > 0.5; }";
    const [variant] = await composePickDiscardShaders(
        [
            {
                key: "k",
                wgsl,
                storage: [{ name: "hide", type: "array<f32>", vertex: false }],
            },
        ],
        { thin: true, detailed: true },
    );
    const binding = "@group(2)@binding(0)var<storage,read> hide:array<f32>;";
    for (const module of [
        variant!.regular,
        variant!.thin!,
        variant!.detailed!,
    ]) {
        assert.ok(module.includes(wgsl) && module.includes(binding));
        assert.ok(!module.includes("{return false;}"));
    }
    assert.match(variant!.thin!, /var<storage,read>instances:array<mat4x4f>/);
    assert.match(variant!.detailed!, /^\s*enable primitive_index;/);
    const [none] = await composePickDiscardShaders(
        [{ key: "n", wgsl, storage: [] }],
        {
            thin: false,
            detailed: false,
        },
    );
    assert.ok(
        none!.thin === undefined &&
            none!.detailed === undefined &&
            !none!.regular.includes("@group(2)"),
    );
});

test("a discard rule an application call composes folds from a model run of the call, its engine values opaque", () => {
    const program = (key: string) => `
        import {createEngine,createSceneContext,createGpuPicker,createSphere,pickAsync,type EngineContext,type Mesh,type PickDiscardRule,type SceneContext} from "@babylonjs/lite";
        interface Part { key: string; fn: string; wgsl: string; name: string; data(mesh: Mesh): Float32Array | null }
        const registries = new WeakMap<EngineContext, Part>();
        function registry(engine: EngineContext, scene: SceneContext): Part {
            let part = registries.get(engine);
            if (part) return part;
            const marked = createSphere(engine, {});
            part = {
                key: ${key},
                fn: "partHit",
                wgsl: "fn partHit(input: PickDiscardInput) -> bool { return partData[0] > 0.5; }",
                name: "partData",
                data: (mesh) => (mesh === marked ? new Float32Array([1]) : null),
            };
            registries.set(engine, part);
            return part;
        }
        function compose(parts: readonly Part[]): PickDiscardRule {
            return {
                key: parts.map((part) => part.key).join("+"),
                wgsl: parts.map((part) => part.wgsl).join("\\n") +
                    "\\nfn shouldDiscardPick(input: PickDiscardInput) -> bool { return " +
                    parts.map((part) => part.fn + "(input)").join(" || ") + "; }",
                storage: parts.map((part) => ({ name: part.name, type: "array<f32>", data: (mesh: Mesh) => part.data(mesh) })),
            };
        }
        async function main() {
            const engine = await createEngine({});
            const scene = createSceneContext(engine);
            const rule = compose([registry(engine, scene)]);
            await pickAsync(createGpuPicker(scene), 0, 0, { discard: rule });
        }
        void main();
    `;
    assert.deepEqual(
        compileSource(program(`"part"`)).manifest.pickDiscardRules,
        [
            {
                key: "part",
                wgsl:
                    "fn partHit(input: PickDiscardInput) -> bool { return partData[0] > 0.5; }\n" +
                    "fn shouldDiscardPick(input: PickDiscardInput) -> bool { return partHit(input); }",
                storage: [
                    { name: "partData", type: "array<f32>", vertex: false },
                ],
            },
        ],
    );
    assert.throws(
        () => compileSource(program(`"part" + String(scene.meshes.length)`)),
        /discard rule 'compose\(\.\.\.\)' threw at generation: it reads 'meshes' of 'scene'/,
    );
});
