import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("shared resource returns retain the selected owner and nullable state once", (t) => {
    const { cpp } = compileSource(`
        import {createBox,type EngineContext,type Mesh} from '@babylonjs/lite';
        function retain(first:EngineContext,second:EngineContext,choice:boolean):()=>number {
            const left=createBox(first),right=createBox(second);
            let calls=0;
            function select(flag:boolean):Mesh {
                if(calls<0)throw new Error('shared owner selector');
                calls++;
                return flag?left:right;
            }
            class Selector {
                pick(flag:boolean):Mesh {
                    if(calls<0)throw new Error('shared owner method');
                    return select(flag);
                }
            }
            const selector=new Selector();
            selector.pick(choice).visible=false;
            selector.pick(!choice).visible=false;
            const selected=select(choice);
            function maybe(present:boolean):Mesh|null {
                calls++;
                if(present)return selected;
                return null;
            }
            const absent=maybe(false),present=maybe(true);
            function tagged(state:number):Mesh|null|undefined {
                calls++;
                if(state===0)return undefined;
                if(state===1)return null;
                return selected;
            }
            const missing=tagged(0),empty=tagged(1),value=tagged(2);
            choice=!choice;
            return()=>{
                if(calls!==8||absent!==null||present!==selected||
                    missing!==undefined||empty!==null||value!==selected)
                    throw new Error('shared return evaluation and presence');
                selected.visible=true;
                return calls;
            };
        }
        const factories:Array<typeof retain>=[retain];
    `);
    for (const marker of ["shared owner selector", "shared owner method"])
        assert.equal(cpp.split(marker).length - 1, 1, marker);
    const factory =
        /bbl::js::Callback<double\(\)> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bool \w+\);/.exec(
            cpp,
        );
    assert.ok(factory, "two-engine resource-return factory");
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "shared-resource-return-owners",
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
        }
        int main() {
            const bbl::js::RealmScope realm;
            for(bool choice:{false,true}) {
                bbl::js::Callback<double()> callback;
                std::weak_ptr<bbl::Engine> selected,unselected;
                {
                    auto first=std::make_shared<bbl::Engine>();
                    auto second=std::make_shared<bbl::Engine>();
                    selected=choice?first:second;
                    unselected=choice?second:first;
                    bblscene::${factory[2]} environment{};
                    callback=bblscene::${factory[1]}(environment,bbl::StoredEngine{first},bbl::StoredEngine{second},choice);
                    assert(first->meshes.size()==1&&second->meshes.size()==1);
                    assert(first->meshes[0].visible == false);
                    assert(second->meshes[0].visible == false);
                }
                bbl::js::collect_cycles();
                assert(unselected.expired()&&!selected.expired());
                assert(callback()==8);
                assert(selected.lock()->meshes[0].visible == true);
                callback={};
                bbl::js::collect_cycles();
                assert(selected.expired());
            }
        }
        `,
        { expectedOutput: "" },
    );
});
