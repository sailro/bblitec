import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

for (const [label, prepare, select, mutate] of [
    ["fields", "", "index() === 0 ? holder.left : holder.right", ""],
    [
        "aliases",
        "const a=holder.left,b=holder.right;",
        "index() === 0 ? a : b",
        "",
    ],
    [
        "lazy arms",
        "",
        "choice === 0 ? (reads++, holder.left) : (reads++, holder.right)",
        "",
    ],
    [
        "prepared calls",
        "function take(value:Mesh){reads++;const result=value;return result;}",
        "choice === 0 ? take(holder.left) : take(holder.right)",
        "",
    ],
    ["mixed storage", "", "index() === 0 ? holder.left : right", ""],
    [
        "array",
        "const values=[holder.left,holder.right];",
        "values[index()]!",
        "values[0]=holder.right;values[1]=holder.left;",
    ],
    [
        "array key mutation",
        "const values=[holder.left,holder.right];function pick(){reads++;holder.left=right;holder.right=left;return choice;}",
        "values[pick()]!",
        "",
    ],
] as const)
    test(`owned resource ${label} selection snapshots the selected handle and owner`, (t) => {
        const { cpp } = compileSource(`
            import {createBox,setMeshVisible,type EngineContext,type Mesh} from '@babylonjs/lite';
            queueMicrotask(()=>{});
            function retain(first:EngineContext,second:EngineContext,choice:number):Promise<()=>number>{
                const left=createBox(first),right=createBox(second);
                return Promise.resolve({left,right}).then(holder=>{
                    let reads=0;
                    function index(){reads++;return choice;}
                    ${prepare}
                    const selected=${select};
                    ${mutate}
                    holder.left=right;holder.right=left;
                    choice=1-choice;
                    return()=>{
                        if(selected.visible!==false)setMeshVisible(selected,false);
                        return reads;
                    };
                });
            }
            const factories:Array<typeof retain>=[retain];
        `);
        const factory =
            /bbl::js::Promise<bbl::js::Callback<double\(\)>> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] double \w+\);/.exec(
                cpp,
            );
        assert.ok(factory, "owned resource selector factory");
        const [, name, environment] = factory;
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            tools,
            `resource-owner-choice-storage/${label.replaceAll(" ", "-")}`,
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
                for(unsigned choice=0;choice<2;++choice){
                    bbl::pal::EventLoop loop;
                    bbl::js::Callback<double()> callback;
                    std::weak_ptr<bbl::Engine> selected,unselected;
                    loop.run([&] {
                        auto first=std::make_shared<bbl::Engine>();
                        auto second=std::make_shared<bbl::Engine>();
                        selected=choice==0?first:second;
                        unselected=choice==0?second:first;
                        bblscene::${environment} environment{};
                        auto pending=bblscene::${name}(environment,bbl::StoredEngine{first},bbl::StoredEngine{second},choice);
                        pending.observe([&](const bbl::js::Callback<double()>& value){callback=value;loop.close();},
                            [](std::exception_ptr error){std::rethrow_exception(error);});
                    });
                    assert(unselected.expired());
                    assert(!selected.expired());
                    assert(callback()==1&&callback()==1);
                    assert(selected.lock()->draw_call_count==1);
                    callback={};
                    bbl::js::collect_cycles();
                    assert(selected.expired());
                }
            }
            `,
            {
                flags: ["/DBBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
