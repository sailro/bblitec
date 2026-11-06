import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";

function source(mutation = "", declarations = "", realm = true): string {
    return `import {createEngine,createSceneContext,createLineSystem,updateLineSystem,createLineMaterial,setThinInstances,addToScene,waitForGpuIdle} from "@babylonjs/lite";
const INITIAL=[[{x:1,y:2,z:3},{x:4,y:5,z:6}]];
const UPDATED=[[{x:7,y:8,z:9},{x:10,y:11,z:12}]];
${declarations}
async function main(){
    const engine=await createEngine(document.createElement("canvas"));
    ${realm ? "await waitForGpuIdle(engine);" : ""}
    const scene=createSceneContext(engine);
    const material=createLineMaterial({useThinInstances:true});
    ${mutation}
    const mesh=createLineSystem(engine,{lines:INITIAL,material});
    updateLineSystem(engine,mesh,{lines:UPDATED});
    setThinInstances(mesh,new Float32Array(16),1);
    addToScene(scene,mesh);
}
void main();`;
}

test("realm line inputs reuse proven immutable module geometry across copied mesh results", () => {
    const result = compileSource(source());
    assert.match(result.cpp, /bbl::pal::create_realm_engine/);
    assert.match(
        result.cpp,
        /bbl::create_line_system\([^\n]+bbl::Vec3\{1\.0f, 2\.0f, 3\.0f\}, bbl::Vec3\{4\.0f, 5\.0f, 6\.0f\}/,
    );
    assert.match(
        result.cpp,
        /bbl::update_line_system\([^\n]+bbl::Vec3\{7\.0f, 8\.0f, 9\.0f\}, bbl::Vec3\{10\.0f, 11\.0f, 12\.0f\}/,
    );
});

test("thin line inputs preserve the ordinary scene host without an explicit realm operation", () => {
    const result = compileSource(source("", "", false));
    assert.match(result.cpp, /bbl::create_engine\(/);
    assert.doesNotMatch(result.cpp, /bbl::pal::create_realm_engine/);
    assert.ok(result.manifest.features.includes("mesh:thin-instances"));
    assert.ok(!result.manifest.features.includes("platform:window"));
    assert.deepEqual(result.manifest.deferredCapabilities ?? [], []);
});

test("realm line constants a program writes are read at run time, not folded", () => {
    for (const [mutation, declarations] of [
        ["INITIAL[0]![0]!.x=42;", ""],
        ["const alias=INITIAL[0]![0]!;alias.x=42;", ""],
        [
            "change({points:INITIAL});",
            "function change(options:{points:{x:number;y:number;z:number}[][]}){options.points[0]![0]!.x=42;}",
        ],
        [
            "const retained=keep({points:INITIAL});retained[0]![0]!.x=42;",
            "function keep(options:{points:{x:number;y:number;z:number}[][]}){return options.points;}",
        ],
    ] as const) {
        const label = mutation;
        const result = compileSource(source(mutation, declarations));
        assert.doesNotMatch(
            result.cpp,
            /bbl::create_line_system\([^\n]+bbl::Vec3\{1\.0f, 2\.0f, 3\.0f\}/,
            label,
        );
        assert.match(
            result.cpp,
            /bbl::create_line_system\([^\n]+for \(const auto& line : /,
            label,
        );
    }
});

test("line systems take run-time points, construct at run time and keep each material's colour", () => {
    const result =
        compileSource(`import {createEngine,createSceneContext,createLines,createLineSystem,createLineMaterial,addToScene,registerScene,startEngine} from "@babylonjs/lite";
async function main(){
    const engine=await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
    const scene=createSceneContext(engine);
    const path=createLineMaterial({color:{r:1,g:0.5,b:0,a:1}});
    const grid=createLineMaterial({color:{r:0,g:0.5,b:1,a:1}});
    const count=Number((document.getElementById("count") as HTMLInputElement).value);
    const points=[{x:0,y:0,z:0}];
    for(let i=1;i<count;i++)points.push({x:i,y:0,z:i*2});
    addToScene(scene,createLines(engine,{points:points.map((p)=>({...p,y:p.y+1})),material:path}));
    const rows:{x:number;y:number;z:number}[][]=[];
    for(let i=0;i<count;i++)rows.push([{x:i,y:0,z:0},{x:i,y:0,z:1}]);
    for(const row of rows)addToScene(scene,createLineSystem(engine,{lines:[row,row],material:grid}));
    addToScene(scene,createLineSystem(engine,{lines:rows,material:grid}));
    await registerScene(scene);
    await startEngine(engine);
}
void main();`);
    assert.match(
        result.cpp,
        /std::vector<std::vector<bbl::Vec3>> rows\(1\); auto& row = rows\[0\];/,
        "createLines reads its run-time points as the one row",
    );
    assert.match(
        result.cpp,
        /for \(const auto& line : [^)]+\) \{ auto& row = rows\.emplace_back\(\);/,
        "a run-time Vec3[][] is read line by line",
    );
    assert.match(result.cpp, /bbl::upstream::begin_scene_mesh_profile\(/);
    assert.equal(
        result.cpp.match(
            /bbl::set_shader_uniform_value\([^;]*material, \d+u, 0\.0f, 0\.5f, 1\.0f, 1\.0f\)/g,
        )?.length,
        1,
        "the second colour of one permutation is the material's own",
    );
});
