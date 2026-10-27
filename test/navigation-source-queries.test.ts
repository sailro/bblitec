import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { NavigationLowerer } from "../src/lowering/navigation-lowerer.js";
import {
    navigationMeshMergeDefinition,
    navigationSourceQueryDefinitions,
} from "../src/lowering/navigation-source-queries.js";
import { navigationLibraryHeader } from "../src/lowering/navigation-library.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import {
    cppFunction,
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
    runGeneratedProgram,
} from "./native-fixture.js";

const imports = `import {createNavigationPluginAsync,createNavMeshFromSources,findClosestPointWithinInto,navRayBlockedFast,disposeNavigationPlugin,computePath} from 'babylon-lite';`;
const sourceProgram = `${imports}
interface Source {positions:Float32Array;indices:Uint32Array}
const positions=new Float32Array([99,99,99,-10,0,-10,-10,0,10,10,0,10,10,0,-10,99,99,99]);
const indices=new Uint32Array([99,0,1,2,0,2,3,99]);
const sources:Source[]=[{positions:positions.subarray(3,15),indices:indices.subarray(1,7)}];
const params={cs:.2,doNotReverseIndices:true};
const plugin=await createNavigationPluginAsync();const alias=plugin;
let evaluations=0;
function selectedSources(){evaluations=evaluations*10+1;return sources;}
function selectedParams(){evaluations=evaluations*10+2;positions[3]=-10;return params;}
positions[3]=100;
createNavMeshFromSources(plugin,selectedSources(),selectedParams());
if(evaluations!==12)throw new Error('source argument order');
const result={x:71,y:72,z:73};const resultAlias=result;
if(!findClosestPointWithinInto(plugin,{x:0,y:1,z:0},{x:1,y:2,z:1},result))throw new Error('snap missed');
if(resultAlias.x!==0||Math.abs(resultAlias.y-.2)>1e-6||resultAlias.z!==0)throw new Error('snap owner');
result.x=71;result.y=72;result.z=73;
if(findClosestPointWithinInto(plugin,{x:100,y:0,z:100},{x:1,y:2,z:1},result))throw new Error('false snap');
if(resultAlias.x!==71||resultAlias.y!==72||resultAlias.z!==73)throw new Error('failed write');
if(navRayBlockedFast(plugin,{x:0,y:0,z:0},{x:2,y:0,z:2}))throw new Error('clear ray');
if(!navRayBlockedFast(plugin,{x:0,y:0,z:0},{x:100,y:0,z:0}))throw new Error('wall ray');
function firstPath(points:{x:number;y:number;z:number}[]):number {
    for(let i=1;i<points.length;i++) {
        const path=computePath(plugin,points[i-1]!,points[i]!);
        if(path.length>=2)return path.length;
    }
    return 0;
}
if(firstPath([{x:0,y:0,z:0},{x:2,y:0,z:2}])<2)throw new Error('runtime path');
disposeNavigationPlugin(alias);disposeNavigationPlugin(plugin);
let rejected=false;try{navRayBlockedFast(plugin,{x:0,y:0,z:0},{x:0,y:0,z:0});}catch(error){rejected=error.message==='#615';}
if(!rejected)throw new Error('disposed query');
createNavMeshFromSources(alias,sources,{doNotReverseIndices:true});
if(!findClosestPointWithinInto(plugin,{x:0,y:1,z:0},{x:1,y:2,z:1},result))throw new Error('rebuild');
if(positions[0]!==99||indices[0]!==99||indices[3]!==2)throw new Error('source mutation');
disposeNavigationPlugin(plugin);
const numberPositions:number[]=[-10,0,-10,-10,0,10,10,0,10,10,0,-10];
const numberIndices:number[]=[0,1,2,0,2,3];
createNavMeshFromSources(plugin,[{positions:numberPositions,indices:numberIndices}],{doNotReverseIndices:true});
if(!findClosestPointWithinInto(plugin,{x:0,y:1,z:0},{x:1,y:2,z:1},result))throw new Error('number array source');
disposeNavigationPlugin(plugin);
createNavMeshFromSources(plugin,[{positions:[-10,0,-10,-10,0,10,10,0,10,10,0,-10],indices:[0,1,2,0,2,3]}],{doNotReverseIndices:true});
if(!findClosestPointWithinInto(plugin,{x:0,y:1,z:0},{x:1,y:2,z:1},result))throw new Error('tuple source');
disposeNavigationPlugin(plugin);
`;

test("navigation source arrays and caller-owned query results generate without deferred calls", () => {
    const compiled = compileSource(sourceProgram);
    assert.deepEqual(compiled.manifest.deferredCapabilities ?? [], []);
    assert.match(compiled.cpp, /bbl::js::NumericArrayView\(/);
    assert.doesNotMatch(compiled.cpp, /nav_lane/);
    for (const name of [
        "create_nav_mesh_from_sources",
        "nav_closest_point_within_into",
        "nav_ray_blocked_fast",
        "dispose_navigation_plugin",
    ])
        assert.match(compiled.cpp, new RegExp(name));
    assert.throws(
        () =>
            compileSource(
                `${imports}const plugin=await createNavigationPluginAsync();const value=new Float32Array([1])[0]!;createNavMeshFromSources(plugin,[],{maxObstacles:value});`,
            ),
        /Navigation build arm 'maxObstacles' must be known at compilation/,
    );
});

test("pinned mesh navigation merge reads active CPU aliases and source winding", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler required.");
        return;
    }
    const context = new LoweringContext();
    const mutated = navigationMeshMergeDefinition(
        doctoredContext(
            "src/navigation/navigation.ts",
            "positions[pOff++] = x * wm[0]! + y * wm[4]! + z * wm[8]! + wm[12]!;",
            "positions[pOff++] = x * wm[0]! + y * wm[4]! + z * wm[8]! + wm[12]! + 7;",
        ),
    );
    runGeneratedProgram(
        tools,
        "navigation-cpu-merge",
        `
#include <bblite/mesh_cpu_streams.hpp>
#include <bblite/pal_navigation.hpp>
#include <cassert>
namespace bbl::upstream {
std::array<float,16> mesh_world_matrix(Engine&,const MeshRecord&) {return {1,0,0,0,0,1,0,0,0,0,1,0,5,0,0,1};}
${navigationMeshMergeDefinition(context)}
}
namespace changed {using namespace bbl;${mutated}}
int main(){
    bbl::Engine engine;engine.meshes.emplace_back();engine.geometries.emplace_back();
    auto& mesh=engine.meshes[0];auto& geometry=engine.geometries[0];mesh.geometry=0;

    geometry.vertices.resize(12);geometry.indices={0,0,0,0,0,0};
    geometry.render_vertices_override=std::vector<bbl::ModelVertex>(30);
    geometry.render_indices_override=std::vector<std::uint32_t>(90,0);
    bbl::js::F32Array positions{0,0,0,1,0,0,0,0,1};
    bbl::js::U32Array indices{0,1,2};
    mesh.cpu_streams=std::make_shared<bbl::MeshCpuStreams>();
    mesh.cpu_streams->positions=positions;mesh.cpu_streams->indices=indices;
    positions.store(0,2);indices.store(1,2);indices.store(2,1);
    const std::vector<bbl::MeshHandle> meshes{{0},{0}};
    const auto merged=bbl::upstream::merge_nav_meshes(engine,meshes);
    assert(merged.positions.size()==18&&merged.positions[0]==7&&merged.positions[9]==7);
    assert((merged.indices==std::vector<std::uint32_t>{0,1,2,3,4,5}));
    const auto changed=changed::merge_nav_meshes(engine,meshes);
    assert(changed.positions[0]==14);
    mesh.cpu_streams->indices.reset();bool rejected=false;
    try{bbl::upstream::merge_nav_meshes(engine,meshes);}catch(const std::runtime_error& error){rejected=std::string(error.what())=="#613";}
    assert(rejected);
    mesh.cpu_streams.reset();geometry.vertices.resize(3);geometry.indices={0,2,1};geometry.source_indices_reversed=true;
    const auto fallback=bbl::upstream::merge_nav_meshes(engine,{{0}});
    assert(fallback.positions.size()==9&&(fallback.indices==std::vector<std::uint32_t>{0,2,1}));
}
`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

interface Point {
    x: number;
    y: number;
    z: number;
}
interface PinnedNavigation {
    createNavigationPluginAsync(): Promise<object>;
    createNavMeshFromSources(
        plugin: object,
        sources: Array<{ positions: Float32Array; indices: Uint32Array }>,
        params: { doNotReverseIndices: boolean },
    ): void;
    findClosestPointWithinInto(
        plugin: object,
        position: Point,
        halfExtents: Point,
        out: Point,
    ): boolean;
    navRayBlockedFast(plugin: object, start: Point, end: Point): boolean;
    disposeNavigationPlugin(plugin: object): void;
}

test("native raw navigation queries match pinned WASM and disposal releases resources before rebuild", async (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native Recast fixture compiler required.");
        return;
    }
    const pin = await importPinnedModule<PinnedNavigation>(
        "navigation/navigation.js",
    );
    const positions = new Float32Array([
        -10, 0, -10, -10, 0, 10, 10, 0, 10, 10, 0, -10,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const plugin = await pin.createNavigationPluginAsync();
    const samples = [
        { position: { x: 0, y: 1, z: 0 }, extents: { x: 1, y: 2, z: 1 } },
        { position: { x: 10, y: 0, z: 0 }, extents: { x: 3, y: 4, z: 3 } },
        { position: { x: 100, y: 0, z: 100 }, extents: { x: 1, y: 2, z: 1 } },
        {
            position: { x: 0, y: 100, z: 0 },
            extents: { x: 0.1, y: 0.1, z: 0.1 },
        },
    ];
    const rays = [
        [
            { x: 0, y: 0, z: 0 },
            { x: 2, y: 0, z: 2 },
        ],
        [
            { x: 0, y: 0, z: 0 },
            { x: 100, y: 0, z: 0 },
        ],
        [
            { x: 100, y: 0, z: 100 },
            { x: 0, y: 0, z: 0 },
        ],
        [
            { x: 0, y: 0, z: 0 },
            { x: 0, y: 0, z: 0 },
        ],
    ] as const;
    pin.createNavMeshFromSources(plugin, [{ positions, indices }], {
        doNotReverseIndices: true,
    });
    const expected = samples.map(({ position, extents }) => {
        const out = { x: 71, y: 72, z: 73 };
        return {
            found: pin.findClosestPointWithinInto(
                plugin,
                position,
                extents,
                out,
            ),
            out,
        };
    });
    const blocked = rays.map(([start, end]) =>
        pin.navRayBlockedFast(plugin, start, end),
    );
    pin.disposeNavigationPlugin(plugin);
    const context = new LoweringContext();
    const lowered = new NavigationLowerer(context).lowerNavigation(false);
    const directory = resolve("artifacts/navigation-source-queries");
    mkdirSync(join(directory, "bblite/upstream"), { recursive: true });
    writeFileSync(
        join(directory, "bblite/upstream/navigation.hpp"),
        lowered.header,
    );
    writeFileSync(
        join(directory, "bblite/upstream/navigation_library.hpp"),
        navigationLibraryHeader(true),
    );
    const compiled = compileSource(sourceProgram);
    const point = (value: Point) =>
        `bbl::Vec3d{${value.x},${value.y},${value.z}}`;
    const checks = samples
        .map(({ position, extents }, index) => {
            const result = expected[index]!;
            return `{bbl::Vec3d out{71,72,73};assert(nav_closest_point_within_into(plugin,${point(position)},${point(extents)},out)==${result.found});assert(out.x==${result.out.x}&&out.y==${result.out.y}&&out.z==${result.out.z});}`;
        })
        .concat(
            rays.map(
                ([start, end], index) =>
                    `assert(nav_ray_blocked_fast(plugin,${point(start)},${point(end)})==${blocked[index]});`,
            ),
        )
        .join("\n");
    const changed = navigationSourceQueryDefinitions(
        doctoredContext(
            "src/navigation/navigation.ts",
            "indices[iOff++] = source.indices[i + 2]! + vertBase;",
            "indices[iOff++] = source.indices[i + 1]! + vertBase;",
        ),
    );
    const cpp = `
#include <bblite/upstream/navigation.hpp>
#include "pal_navigation_recast.cpp"
#include <cassert>
namespace bbl::upstream {
${cppFunction(lowered.source, "bbl::pal::NavigationHandle create_navigation_plugin(")}
${cppFunction(lowered.source, "static void create_nav_mesh_from_merged(")}
${cppFunction(lowered.source, "bbl::pal::NavVec3 nav_vec3(")}
${cppFunction(lowered.source, "Vec3d nav_closest_point(")}
${cppFunction(lowered.source, "std::vector<Vec3d> nav_compute_path(")}
${navigationSourceQueryDefinitions(context)}
${cppFunction(lowered.source, "void create_nav_mesh_from_sources(")}
}
namespace changed {using namespace bbl;using namespace bbl::upstream;${changed}}
#define main generated_main
${compiled.cpp}
#undef main
int main(){
    using namespace bbl::upstream;
    assert(generated_main()==0);
    auto plugin=create_navigation_plugin();
    bbl::js::F32Array sourcePositions{${Array.from(positions).join(",")}};
    bbl::js::U32Array sourceIndices{${Array.from(indices).join(",")}};
    const std::vector<NavMeshSource> sources{{bbl::js::NumericArrayView(sourcePositions),bbl::js::NumericArrayView(sourceIndices)}};
    assert(sources[0].positions.identity()==sourcePositions.identity()&&sources[0].indices.identity()==sourceIndices.identity());
    sourcePositions.store(0,31);assert(merge_nav_mesh_sources(sources,true).positions[0]==31);sourcePositions.store(0,-10);
    sourceIndices.store(0,2);assert(merge_nav_mesh_sources(sources,true).indices[0]==2);sourceIndices.store(0,0);
    const std::vector<NavMeshSource> wide{{bbl::js::NumericArrayView(bbl::js::Array<double>{1.0/3,0,0}),bbl::js::NumericArrayView(bbl::js::Array<double>{4294967297.75,-1.75,0})}};
    const auto narrow=merge_nav_mesh_sources(wide,true);assert(narrow.positions[0]==static_cast<float>(1.0/3));assert(narrow.indices[0]==1&&narrow.indices[1]==4294967295u);
    auto merged=merge_nav_mesh_sources(sources,true);assert(merged.positions.size()==12&&merged.indices[1]==1);
    auto reversed=merge_nav_mesh_sources(sources,false);assert(reversed.indices[1]==2&&reversed.indices[2]==1);
    auto mutated=changed::merge_nav_mesh_sources(sources,false);assert(mutated.indices[1]==1);
    bbl::pal::NavMeshBuildParams params;
    create_nav_mesh_from_sources(plugin,sources,params,true);
    ${checks}
    auto crowd=bbl::pal::navigation_create_crowd(plugin,2,.5f);
    bool rejected=false;try{dispose_navigation_plugin(plugin);}catch(const std::runtime_error& error){rejected=std::string(error.what()).find("live crowd")!=std::string::npos;}
    assert(rejected&&bbl::pal::navigation_has_query(plugin)&&bbl::pal::navigation_has_nav_mesh(plugin));
    crowd={};dispose_navigation_plugin(plugin);dispose_navigation_plugin(plugin);
    assert(!bbl::pal::navigation_has_query(plugin)&&!bbl::pal::navigation_has_nav_mesh(plugin));
    create_nav_mesh_from_sources(plugin,sources,params,true);
    ${checks}
    dispose_navigation_plugin(plugin);
}
`;
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/Gy",
        "/DBBLITE_HAS_NAV_CROWD=1",
        "/DBBLITE_HAS_NAV_TILE_CACHE=1",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        "native/src",
        "/I",
        directory,
        `/external:I${join(nativeFixtureVcpkgRoot, "include/recastnavigation")}`,
        source,
        "/link",
        `/LIBPATH:${join(nativeFixtureVcpkgRoot, "lib")}`,
        "Recast.lib",
        "Detour.lib",
        "DetourCrowd.lib",
        "DetourTileCache.lib",
        "RecastNavigationTileCache.lib",
    ]);
    execFileSync(executable, {
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
        env: {
            ...tools.environment,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${tools.environment.PATH ?? ""}`,
        },
    });
});
