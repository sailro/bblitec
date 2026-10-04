import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { planImportedModuleInitializers } from "../src/compiler/module-initializers.js";
import { createCompilerProgram } from "../src/compiler/program.js";
import { CompilerSymbols } from "../src/compiler/symbols.js";
import { LoweringContext } from "../src/lowering/context.js";
import { NavigationLowerer } from "../src/lowering/navigation-lowerer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("nested copying factories do not make their inputs aliases of a retained result", (t) => {
    const directory = resolve("artifacts/nested-factory-inputs");
    mkdirSync(directory, { recursive: true });
    for (const name of ["copied", "retained", "written", "unknown"])
        writeFileSync(
            join(directory, `${name}.ts`),
            `export const ${name}=[{x:1}];`,
        );
    const source = `
        import {copied} from './copied.js';
        import {retained} from './retained.js';
        import {written} from './written.js';
        interface Point{x:number}
        let order=0;
        function copy(options:{points:Point[]}):Point[]{
            order=order*10+1;
            const output:Point[]=[];
            for(const point of options.points)output.push({x:point.x});
            return output;
        }
        function retain(options:{points:Point[]}):Point[]{return options.points;}
        function write(points:Point[]):void {order=order*10+2;points[0]!.x=9;}
        write(copy({points:copied}));
        if(copied[0]!.x!==1||order!==12)throw new Error('copy/order');
        write(retain({points:retained}));
        if(retained[0]!.x!==9)throw new Error('retained alias');
        write(copy({points:written}));
        const alias=written;alias[0]!.x=7;
        if(written[0]!.x!==7)throw new Error('original alias');
    `;
    const fileName = join(directory, "entry.ts");
    const planned = createCompilerProgram(source, fileName);
    assert.deepEqual(
        planImportedModuleInitializers(
            planned.program,
            planned.sourceFile,
            planned.checker,
            new CompilerSymbols(planned.checker),
        ).map((file) => basename(file.fileName)),
        ["retained.ts", "written.ts"],
    );
    const opaque = createCompilerProgram(
        `import {unknown} from './unknown.js';declare function factory(points:{x:number}[]):{x:number}[];declare function consume(points:{x:number}[]):void;consume(factory(unknown));`,
        fileName,
    );
    assert.deepEqual(
        planImportedModuleInitializers(
            opaque.program,
            opaque.sourceFile,
            opaque.checker,
            new CompilerSymbols(opaque.checker),
        ).map((file) => basename(file.fileName)),
        ["unknown.ts"],
    );
    const tools = optionalNativeFixtureTools(false);
    const result = compileSource(source, { fileName });
    if (!tools) {
        t.skip("Native fixture compiler unavailable");
        return;
    }
    runGeneratedProgram(tools, "nested-factory-inputs", result.cpp, {
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

const imports = `import {createEngine,createBox,createNavigationPluginAsync,createNavMesh,type OffMeshConnection} from '@babylonjs/lite';`;
const connection = `{startPosition:{x:1,y:2,z:3},endPosition:{x:4,y:5,z:6},radius:.5,bidirectional:true}`;

test("navigation copies current owned connection fields once in argument order", (t) => {
    const source = `${imports}
        const connections:OffMeshConnection[]=[${connection},${connection}];
        let effects=0;
        function prepare():number {effects++;connections[0]!.startPosition.x=7;connections[0]!.area=0;return .25;}
        async function main(){
            const engine=await createEngine({});const mesh=createBox(engine);const nav=await createNavigationPluginAsync();
            const alias=connections;alias[0]!.radius=2;
            createNavMesh(nav,[mesh],{offMeshConnections:connections,cs:prepare(),maxObstacles:0});
            if(effects!==1)throw new Error('argument reevaluation');
            alias[0]!.startPosition.x=8;alias[0]!.flags=3;alias[0]!.userId=0;
            alias.push(${connection});
            createNavMesh(nav,[mesh],{offMeshConnections:alias,maxObstacles:0});
        }
    `;
    const result = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable");
        return;
    }
    const output = resolve("artifacts/navigation-collection-values");
    mkdirSync(join(output, "bblite/upstream"), { recursive: true });
    writeFileSync(join(output, "program.hpp"), result.cpp);
    writeFileSync(
        join(output, "bblite/upstream/navigation.hpp"),
        new NavigationLowerer(new LoweringContext()).lowerNavigation(false)
            .header,
    );
    const file = join(output, "check.cpp"),
        executable = join(output, "check.exe");
    writeFileSync(
        file,
        `
        #define main generated_main
        #include "program.hpp"
        #undef main
        #include <cassert>
        namespace {unsigned calls=0;}
        namespace bbl {
        Engine create_engine(EngineOptions){return {};}
        MeshHandle create_box(Engine& engine,BoxOptions){engine.meshes.emplace_back();return {0};}
        }
        namespace bbl::upstream {
        bbl::pal::NavigationHandle create_navigation_plugin(){return {};}
        void create_nav_mesh(Engine&,bbl::pal::NavigationHandle,const std::vector<MeshHandle>& meshes,const bbl::pal::NavMeshBuildParams& params){
            ++calls;assert(meshes.size()==1);assert(params.off_mesh_connections.size()==(calls==1?2u:3u));
            const auto& first=params.off_mesh_connections[0];
            assert(first.start.x==(calls==1?7.0f:8.0f));assert(first.start.y==2&&first.end.z==6&&first.radius==2&&first.bidirectional);
            assert(first.area&&*first.area==0);
            assert(first.flags.has_value()==(calls==2));assert(first.user_id.has_value()==(calls==2));
            if(calls==2){assert(*first.flags==3&&*first.user_id==0);}
            const auto& second=params.off_mesh_connections[1];assert(!second.area&&!second.flags&&!second.user_id);
        }
        }
        int main(){assert(generated_main()==0);assert(calls==2);}
    `,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/permissive-",
        "/EHsc",
        "/MD",
        `/Fo:${output}\\`,
        `/Fe:${executable}`,
        "/I",
        output,
        "/I",
        "native/include",
        file,
    ]);
    assert.equal(
        execFileSync(executable, {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
        }),
        "",
    );
});

test("navigation keeps retained tile-cache connections outside the admitted boundary", () => {
    for (const list of [`[${connection}]`, `connections`])
        assert.throws(
            () =>
                compileSource(
                    `${imports}const connections:OffMeshConnection[]=[${connection}];async function main(){const engine=await createEngine({});const mesh=createBox(engine);const nav=await createNavigationPluginAsync();createNavMesh(nav,[mesh],{maxObstacles:1,offMeshConnections:${list}});}`,
                ),
            /TileCacheMeshProcess|static array literal/,
        );
});
