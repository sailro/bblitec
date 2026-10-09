import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const mutations = {
    slots: `
        return Promise.resolve({mesh:left}).then(holder=>{
            const original=holder.mesh;
            holder.mesh=right;
            let selected=original;
            selected=holder.mesh;
            holder.mesh=original;
            return ()=>{
                if(original.visible!==false)setMeshVisible(original,false);
                if(selected.visible!==false)setMeshVisible(selected,false);
                if(holder.mesh.visible!==false)throw new Error('slot owner changed');
                return 2;
            };
        });
    `,
    annotated: `
        return Promise.resolve(left).then(owner=>{
            const holder:{mesh:Mesh}={mesh:owner};
            const original=holder.mesh;
            holder.mesh=right;
            return ()=>{
                if(original.visible!==false)setMeshVisible(original,false);
                if(holder.mesh.visible!==false)setMeshVisible(holder.mesh,false);
                return 2;
            };
        });
    `,
};

for (const [label, body] of Object.entries(mutations))
    test(`stored resource assignments retain owners and snapshot aliases through ${label}`, (t) => {
        const { cpp } = compileSource(`
        import {createBox,setMeshVisible,type EngineContext,type Mesh} from '@babylonjs/lite';
        queueMicrotask(()=>{});
        function retain(first:EngineContext,second:EngineContext):Promise<()=>number>{
            const left=createBox(first),right=createBox(second);
            ${body}
        }
        const factories:Array<typeof retain>=[retain];
    `);
        const factory =
            /bbl::js::Promise<bbl::js::Callback<double\(\)>> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
                cpp,
            );
        assert.ok(factory, "resource mutation factory");
        const [, name, environment] = factory;
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            tools,
            `resource-owner-mutations/${label}`,
            `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                engine.meshes.emplace_back();
                engine.meshes.back().visible=true;
                return {0,0};
            }
            void set_mesh_visible(Engine& engine, MeshHandle mesh, bool visible) {
                auto& record=handle_at(engine.meshes,mesh);
                if(record.visible==visible)throw std::runtime_error("duplicate mutation");
                record.visible=visible;
                ++engine.draw_call_count;
            }
        }
        int main() {
            const bbl::js::RealmScope realm;
            bbl::pal::EventLoop loop;
            bbl::js::Callback<double()> callback;
            std::weak_ptr<bbl::Engine> firstOwner,secondOwner;
            loop.run([&] {
                auto first=std::make_shared<bbl::Engine>();
                auto second=std::make_shared<bbl::Engine>();
                firstOwner=first;secondOwner=second;
                bblscene::${environment} environment{};
                auto pending=bblscene::${name}(environment,bbl::StoredEngine{first},bbl::StoredEngine{second});
                pending.observe([&](const bbl::js::Callback<double()>& value){callback=value;loop.close();},
                    [](std::exception_ptr error){std::rethrow_exception(error);});
                first.reset();second.reset();
                assert(!firstOwner.expired()&&!secondOwner.expired());
            });
            assert(!firstOwner.expired()&&!secondOwner.expired());
            assert(callback()==2&&callback()==2);
            assert(firstOwner.lock()->draw_call_count==1);
            assert(secondOwner.lock()->draw_call_count==1);
            callback={};
            bbl::js::collect_cycles();
            assert(firstOwner.expired()&&secondOwner.expired());
        }
        `,
            {
                defines: ["BBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
