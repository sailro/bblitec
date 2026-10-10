import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("stored async callbacks retain collection key owners through typed result holders", (t) => {
    const { cpp } = compileSource(`
        import {createBox,type Mesh,type EngineContext} from '@babylonjs/lite';
        queueMicrotask(()=>{});
        type Keep=(mesh:Mesh)=>Promise<()=>number>;
        function retain(first:EngineContext,second:EngineContext,choice:number):Promise<()=>number> {
            const left=createBox(first),right=createBox(second);
            const selected=choice?right:left;
            function keep(mesh:Mesh):Promise<()=>number> {
                const holder:{mesh:Mesh}={mesh};
                return Promise.resolve(holder).then(result=>()=>{
                    result.mesh.visible=false;
                    return result.mesh.name.length;
                });
            }
            const keepers:Keep[]=[keep];
            const values=new Map<Mesh,number>([[selected,1]]);
            const pending:Promise<()=>number>[]=[];
            values.forEach((value,key)=>{pending.push(keepers[0]!(key));});
            values.clear();
            return pending[0]!;
        }
        const callbacks:Array<typeof retain>=[retain];
    `);
    const factory =
        /bbl::js::Promise<bbl::js::Callback<double\(\)>> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] double \w+\);/.exec(
            cpp,
        );
    assert.ok(factory, "stored async resource factory");
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "async-resource-callback-parameters",
        `
            #define main generated_main
            ${cpp}
            #undef main
            #include <cassert>
            namespace bbl {
                MeshHandle create_box(Engine& engine, BoxOptions) {
                    engine.meshes.emplace_back();
                    engine.meshes.back().name = "x";
                    engine.meshes.back().visible = true;
                    return {0,0};
                }
            }
            int main() {
                const bbl::js::RealmScope realm;
                for(unsigned choice = 0; choice < 2; ++choice) {
                    bbl::pal::EventLoop loop;
                    bbl::js::Callback<double()> callback;
                    std::weak_ptr<bbl::Engine> selected, unselected;
                    loop.run([&] {
                        auto first = std::make_shared<bbl::Engine>();
                        auto second = std::make_shared<bbl::Engine>();
                        selected = choice == 0 ? first : second;
                        unselected = choice == 0 ? second : first;
                        bblscene::${factory[2]} environment{};
                        auto pending = bblscene::${factory[1]}(environment,
                            bbl::StoredEngine{first}, bbl::StoredEngine{second}, choice);
                        pending.observe([&](const bbl::js::Callback<double()>& value) {
                            callback = value; loop.close();
                        }, [](std::exception_ptr error) {std::rethrow_exception(error);});
                        first.reset(); second.reset();
                        assert(unselected.expired());
                        assert(!selected.expired());
                    });
                    assert(unselected.expired());
                    assert(!selected.expired());
                    assert(callback() == 1);
                    assert(selected.lock()->meshes[0].visible == false);
                    callback = {};
                    bbl::js::collect_cycles();
                    assert(selected.expired());
                }
            }
        `,
        { defines: ["BBLITE_WORKERS=1"], timeoutMs: 10000, expectedOutput: "" },
    );
});
