import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerCameraMatrixCaches } from "../src/lowering/camera-matrix-cache.js";
import { NavigationLowerer } from "../src/lowering/navigation-lowerer.js";
import { navigationSourceQueryDefinitions } from "../src/lowering/navigation-source-queries.js";
import { cameraSources } from "./camera-fixture.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("plain Vec3 outputs retain feature isolation", () => {
    const result =
        compileSource(`import {addVec3ToRef,normalizeVec3ToRef} from "@babylonjs/lite";
        const output={x:0,y:0,z:0};addVec3ToRef({x:1,y:2,z:3},output,output);normalizeVec3ToRef(output,output);`);
    assert.ok(
        !result.manifest.features.some((feature) =>
            feature.startsWith("camera:"),
        ),
    );
    assert.doesNotMatch(result.cpp, /write_camera_vector_component/);
});

test("navigation and math outputs retain camera notifications and cached matrix ownership", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler required.");
        return;
    }
    const compiled = compileSource(`
import {createEngine,createFreeCamera,getViewMatrix,createNavigationPluginAsync,findClosestPointWithinInto,normalizeVec3ToRef,addVec3ToRef} from "@babylonjs/lite";
const engine=await createEngine({});
const camera=createFreeCamera({x:1,y:2,z:-3},{x:0,y:0,z:0});
const output=camera.position;
const plugin=await createNavigationPluginAsync();
const view=getViewMatrix(camera);view[0]=17;
const originalVersion=camera.worldMatrixVersion;
if(!findClosestPointWithinInto(plugin,{x:1,y:5,z:-3},{x:1,y:1,z:1},output))throw new Error("query missed");
if(camera.worldMatrixVersion!==originalVersion+1)throw new Error("changed-lane notifications");
if(getViewMatrix(camera)!==view||view[0]===17)throw new Error("stale view cache");
view[0]=19;
const changedVersion=camera.worldMatrixVersion;
if(!findClosestPointWithinInto(plugin,{x:1,y:5,z:-3},{x:1,y:1,z:1},camera.position))throw new Error("same query missed");
if(camera.worldMatrixVersion!==changedVersion||getViewMatrix(camera)[0]!==19)throw new Error("same-lane invalidation");
if(findClosestPointWithinInto(plugin,{x:-1,y:0,z:0},{x:1,y:1,z:1},output))throw new Error("failed query succeeded");
if(output.x!==1||output.y!==5||output.z!==-3||camera.worldMatrixVersion!==changedVersion||getViewMatrix(camera)[0]!==19)throw new Error("failed query mutated output");
const other=createFreeCamera({x:9,y:8,z:7},{x:0,y:0,z:0});
let current=camera;
function epsilon(){current=other;return 1e-10;}
normalizeVec3ToRef({x:0,y:3,z:4},current.position,epsilon());
if(camera.worldMatrixVersion!==changedVersion+3||other.worldMatrixVersion!==0||other.position.x!==9)throw new Error("normalization output owner");
if(Math.abs(output.y-.6)>1e-12||Math.abs(output.z-.8)>1e-12||getViewMatrix(camera)[0]===19)throw new Error("normalization cache");
normalizeVec3ToRef({x:0,y:0,z:0},output);
if(camera.worldMatrixVersion!==changedVersion+5)throw new Error("zero normalization notifications");
addVec3ToRef({x:0,y:0,z:0},{x:0,y:0,z:0},output);
if(camera.worldMatrixVersion!==changedVersion+5)throw new Error("unchanged math notification");
`);
    assert.match(compiled.cpp, /write_camera_vector_component/);
    const directory = resolve("artifacts/camera-vec3-output");
    const sources = cameraSources(directory, { arcRotate: true, free: true });
    const context = new LoweringContext();
    const navigation = new NavigationLowerer(context).lowerNavigation(false);
    writeFileSync(
        join(directory, "include/bblite/upstream/navigation.hpp"),
        navigation.header,
    );
    writeFileSync(
        join(directory, "include/bblite/upstream/renderer_plan.hpp"),
        "#pragma once\n// Camera matrix getters are defined before the generated entry.\n",
    );
    const queries = navigationSourceQueryDefinitions(context);
    const fixture = join(directory, "check.cpp");
    writeFileSync(
        fixture,
        `
#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/navigation.hpp>
namespace bbl::pal {
bool navigation_has_nav_mesh(NavigationHandle) {return true;}
bool navigation_has_query(NavigationHandle) {return true;}
bool navigation_status_succeed(double status) {return status==1;}
double navigation_raw_closest_point(NavigationHandle,NavQueryScratch& scratch) {
    if(scratch.position[0]<0)return 0;
    scratch.poly_ref=1;
    scratch.point={static_cast<float>(scratch.position[0]),static_cast<float>(scratch.position[1]),static_cast<float>(scratch.position[2])};
    return 1;
}
}
namespace bbl::upstream {
bbl::pal::NavigationHandle create_navigation_plugin(){return {};}
${cppFunction(queries, "static void assert_navigation_ready(")}
${cppFunction(queries, "bool nav_closest_point_within_into(")}
}
${lowerCameraMatrixCaches(context, false)}
#define main generated_main
${compiled.cpp}
#undef main
namespace bbl {Engine create_engine(EngineOptions){return {};}}
int main(){return generated_main();}
`,
    );
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(tools, [
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        join(directory, "include"),
        fixture,
        ...sources,
    ]);
    execFileSync(executable, { windowsHide: true, timeout: 10000 });
});
