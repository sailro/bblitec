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

test("realm line constants cannot fold past direct, aliased or retained child mutation", () => {
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
    ])
        assert.throws(
            () => compileSource(source(mutation, declarations)),
            /Expected a static array literal/,
            mutation,
        );
    const unknown = source(
        "",
        "declare function opaque(options:{points:{x:number;y:number;z:number}[][]}):void;",
    ).replace(
        "    addToScene(scene,mesh);",
        "    opaque({points:INITIAL});\n    addToScene(scene,mesh);",
    );
    assert.throws(
        () => compileSource(unknown),
        /Expected a static array literal/,
        "an unknown consumer may retain geometry for later writes",
    );
});
