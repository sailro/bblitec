import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("runtime queue methods reuse bodies without exhausting static loop emission", async (t) => {
    const body = `
        class Queue {
            private readonly pending:{x:number;y:number}[]=[];
            private readonly active=new Map<string,{meshes:Mesh[]}>();
            private counter=0;
            private checksum=0;
            onBuilt?:((x:number)=>void);
            constructor(private readonly engine:EngineContext,private readonly scene:SceneContext,private readonly options:{budget:number}){}
            enqueue(x:number,y:number):void {this.pending.push({x,y});}
            total():number {return this.checksum;}
            process(budget=this.options.budget):void {
                let done=0;
                while(done<budget&&this.pending.length>0){
                    const next=this.pending.shift()!;
                    const key=String(next.x);
                    if(this.active.has(key))continue;
                    ${"this.checksum += next.x;".repeat(160)}
                    this.build(next.x,next.y);
                    this.onBuilt?.(next.x);
                    done++;
                }
            }
            private build(x:number,y:number):void {
                const positions=new Float32Array([x,y,0,x+1,y,0,x,y+1,0]);
                const normals=new Float32Array([0,0,1,0,0,1,0,0,1]);
                const indices=new Uint32Array([0,1,2]);
                const mesh=createMeshFromData(this.engine,'part_'+this.counter++,positions,normals,indices);
                addToScene(this.scene,mesh);
                this.active.set(String(x),{meshes:[mesh]});
            }
        }
        async function main():Promise<void> {
            const engine=await createEngine({});
            const scene=createSceneContext(engine);
            const queue=new Queue(engine,scene,{budget:2});
            let calls=0;
            queue.onBuilt=(x)=>{calls+=x;};
            queue.enqueue(1,2);
            for(let i=0;i<173;i++)queue.process(Infinity);
            queue.enqueue(1,2);
            queue.enqueue(3,4);
            queue.process();
            if(calls!==4||queue.total()!==640)throw new Error('live queue state');
        }
    `;
    const names: string[] = [];
    let registrations = 0;
    await runInNewContext(
        ts.transpileModule(body, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText + "\nmain();",
        {
            createEngine: async () => ({}),
            createSceneContext: () => ({}),
            createMeshFromData: (
                _engine: object,
                name: string,
                positions: Float32Array,
                normals: Float32Array,
                indices: Uint32Array,
            ) => {
                assert.equal(positions.length, 9);
                assert.equal(normals.length, 9);
                assert.equal(indices.length, 3);
                assert.equal(positions[0], names.length === 0 ? 1 : 3);
                names.push(name);
                return { name };
            },
            addToScene: () => registrations++,
        },
    );
    assert.deepEqual(names, ["part_0", "part_1"]);
    assert.equal(registrations, 2);
    const result = compileSource(`
        import {createEngine,createSceneContext,createMeshFromData,addToScene,
            type EngineContext,type SceneContext,type Mesh} from '@babylonjs/lite';
        ${body}
    `);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "shared-method-effects/queue",
        `#define main generated_queue_main\n${result.cpp}\n#undef main
        #include <cassert>
        namespace {
            std::size_t constructions=0;
            std::size_t registrations=0;
        }
        namespace bbl {
            Engine create_engine(EngineOptions) {return {};}
            Scene create_scene_context(Engine& engine) {Scene scene;scene.engine=&engine;return scene;}
            MeshHandle create_retained_mesh_from_data(Engine& engine,const std::string& name,
                const js::F32Array& positions,const js::F32Array& normals,const js::U32Array& indices,
                const std::optional<js::F32Array>& uvs,const std::optional<js::F32Array>& uvs2,
                const std::optional<js::F32Array>& tangents,const std::optional<js::F32Array>& colors) {
                assert(positions.size()==9&&normals.size()==9&&indices.size()==3);
                assert(!uvs&&!uvs2&&!tangents&&!colors);
                assert(name=="part_"+std::to_string(constructions));
                assert(positions[0]==(constructions==0?1.0f:3.0f));
                const auto index=static_cast<std::uint32_t>(engine.meshes.size());
                engine.meshes.emplace_back();++constructions;return {index};
            }
            void add_to_scene(Scene& scene,MeshHandle mesh) {
                assert(scene.engine&&mesh.value==registrations);
                scene.meshes.push_back(mesh);++registrations;
            }
        }
        int main() {
            const auto initial=bbl::js::managed_node_count();
            assert(generated_queue_main()==0);
            assert(constructions==2&&registrations==2);
            bbl::js::collect_cycles();
            assert(bbl::js::managed_node_count()==initial);
        }`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

test("shared methods replay genuinely distinct resource composition options", async (t) => {
    const body = `
        function make(engine:EngineContext,scene:SceneContext,size:number):void {
            addToScene(scene,createSphere(engine,{segments:3,diameter:size}));
            addToScene(scene,createSphere(engine,{segments:5,diameter:size+1}));
        }
        async function main():Promise<void> {
            const engine=await createEngine({});
            const scene=createSceneContext(engine);
            for(let i=0;i<3;i++)make(engine,scene,i+4);
        }
    `;
    const options: Array<{ segments: number; diameter: number }> = [];
    await runInNewContext(
        ts.transpileModule(body, {
            compilerOptions: { target: ts.ScriptTarget.ES2022 },
        }).outputText + "\nmain();",
        {
            createEngine: async () => ({}),
            createSceneContext: () => ({}),
            createSphere: (
                _engine: object,
                value: { segments: number; diameter: number },
            ) => {
                options.push({
                    segments: value.segments,
                    diameter: value.diameter,
                });
                return {};
            },
            addToScene: () => {},
        },
    );
    assert.deepEqual(options, [
        { segments: 3, diameter: 4 },
        { segments: 5, diameter: 5 },
        { segments: 3, diameter: 5 },
        { segments: 5, diameter: 6 },
        { segments: 3, diameter: 6 },
        { segments: 5, diameter: 7 },
    ]);
    const result = compileSource(`
        import {createEngine,createSceneContext,createSphere,addToScene,
            type EngineContext,type SceneContext} from '@babylonjs/lite';
        ${body}
    `);
    assert.equal(result.manifest.sceneMeshes.length, 6);
    assert.equal(result.cpp.match(/bbl::create_sphere\(/g)?.length, 2);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "shared-method-effects/composition",
        `#define main generated_composition_main\n${result.cpp}\n#undef main
        #include <cassert>
        namespace {std::uint32_t constructions=0;std::uint32_t registrations=0;}
        namespace bbl {
            Engine create_engine(EngineOptions) {return {};}
            Scene create_scene_context(Engine& engine) {Scene scene;scene.engine=&engine;return scene;}
            MeshHandle create_sphere(Engine& engine,SphereOptions options) {
                assert(options.segments==(constructions%2==0?3u:5u));
                assert(options.diameter_x==constructions/2+4+constructions%2);
                assert(options.diameter_y==options.diameter_x&&options.diameter_z==options.diameter_x);
                const auto index=static_cast<std::uint32_t>(engine.meshes.size());
                engine.meshes.emplace_back();++constructions;return {index};
            }
            void add_to_scene(Scene& scene,MeshHandle mesh) {assert(mesh.value==registrations);scene.meshes.push_back(mesh);++registrations;}
        }
        int main() {assert(generated_composition_main()==0);assert(constructions==6&&registrations==6);}`,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});
