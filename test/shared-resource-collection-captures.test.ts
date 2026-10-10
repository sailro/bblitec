import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("shared collection helpers capture fresh owning arguments in caller scope", (t) => {
    const { cpp } = compileSource(`
        import {createBox,type Mesh,type EngineContext} from '@babylonjs/lite';
        function inspect(first:EngineContext,second:EngineContext):number {
            const left=createBox(first),right=createBox(second);
            function copy(source:Map<Mesh,number>):Map<Mesh,number> {
                return new Map(source.entries());
            }
            function copySet(source:Set<Mesh>):Set<Mesh> {
                return new Set(source.values());
            }
            function copyKeys(source:IterableIterator<Mesh>):Set<Mesh> {
                return new Set(source);
            }
            const firstCopy=copy(new Map([[left,1],[right,2]]));
            const secondCopy=copy(new Map([[right,3]]));
            if(firstCopy.size!==2||firstCopy.get(left)!==1||firstCopy.get(right)!==2||
                secondCopy.size!==1||secondCopy.get(right)!==3)throw new Error('map captures');
            const values=copySet(new Set([left,right]));
            const keys=copyKeys(new Map([[right,4]]).keys());
            if(values.size!==2||!values.has(left)||!values.has(right)||
                keys.size!==1||!keys.has(right))throw new Error('iterator captures');
            for(const [key,value] of firstCopy) {
                if(firstCopy.get(key)!==value)throw new Error('entry owner');
                key.visible=false;
            }
            if(left.visible!==false||right.visible!==false)throw new Error('retained owner');
            return 1;
        }
        const callbacks:Array<typeof inspect>=[inspect];
    `);
    const entry =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(entry, "two-engine collection callback");
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "shared-resource-collection-captures",
        `
            #define main generated_main
            ${cpp}
            #undef main
            #include <cassert>
            namespace bbl {
                MeshHandle create_box(Engine& engine, BoxOptions) {
                    engine.meshes.emplace_back();
                    engine.meshes.back().visible = true;
                    return {0,0};
                }
            }
            int main() {
                const bbl::js::RealmScope realm;
                auto first = std::make_shared<bbl::Engine>();
                auto second = std::make_shared<bbl::Engine>();
                bblscene::${entry[2]} environment{};
                assert(bblscene::${entry[1]}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second}) == 1);
            }
        `,
    );
});
