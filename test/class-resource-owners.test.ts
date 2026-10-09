import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("inherited resource initializers and method returns retain their actual engine", (t) => {
    const { cpp } = compileSource(`
        import {createBox,type Mesh,type EngineContext} from '@babylonjs/lite';
        function inspect(first:EngineContext,second:EngineContext):()=>number {
            const left=createBox(first),right=createBox(second);
            class Base {
                mesh:Mesh;
                constructor(mesh:Mesh){this.mesh=mesh;}
                getMesh():Mesh{return this.mesh;}
            }
            class Derived extends Base {mesh:Mesh=this.getMesh();}
            class Parameter {constructor(public mesh:Mesh){}}
            const set=new Set<Base>();
            const parameters=new Set<Parameter>();
            const base=new Base(left),derived=new Derived(right),parameter=new Parameter(left);
            parameters.add(parameter);
            set.add(base);set.add(derived);
            const saved=base.getMesh();
            if(derived.getMesh()!==right||saved!==left||parameter.mesh!==left)
                throw new Error('initialized owner');
            const map=new Map<Base,number>();
            for(const key of set){
                map.set(key,1);key.mesh=right;
                if(!map.has(key)||key.getMesh()!==right)throw new Error('class key owner');
                key.mesh.visible=false;
            }
            for(const key of parameters){key.mesh.visible=false;}
            if(saved!==left||base.mesh!==right||derived.mesh!==right)
                throw new Error('method result snapshot');
            if(map.size!==2)throw new Error('class key identity');
            return ()=>{saved.visible=false;return 2;};
        }
        const callbacks:Array<typeof inspect>=[inspect];
    `);
    const entry =
        /bbl::js::Callback<double\(\)> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(entry, "class owner callback");
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "class-resource-owners/inherited",
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
            auto first=std::make_shared<bbl::Engine>(),second=std::make_shared<bbl::Engine>();
            bblscene::${entry[2]} environment{};
            auto callback=bblscene::${entry[1]}(environment,bbl::StoredEngine{first},bbl::StoredEngine{second});
            assert(!first->meshes[0].visible&&!second->meshes[0].visible);
            std::weak_ptr<bbl::Engine> selected=first,unselected=second;
            first->meshes[0].visible=true;
            first.reset();second.reset();
            assert(!selected.expired()&&unselected.expired());
            assert(callback()==2&&!selected.lock()->meshes[0].visible);
            callback={};
            assert(selected.expired());
        }
    `,
        { expectedOutput: "" },
    );
});

test("recursive resource methods retain their explicit refusal", () => {
    assert.throws(
        () =>
            compileSource(`
                import {createBox,type Mesh,type EngineContext} from '@babylonjs/lite';
                function inspect(engine:EngineContext):void {
                    class Owner {
                        mesh:Mesh;
                        constructor(mesh:Mesh){this.mesh=mesh;}
                        get(n:number):Mesh{return n ? this.get(n-1) : this.mesh;}
                    }
                    const owner=new Owner(createBox(engine));
                    owner.get(1);
                }
                const callbacks:Array<typeof inspect>=[inspect];
            `),
        /Recursive method 'Owner\.get' must return plain data or void/,
    );
});
