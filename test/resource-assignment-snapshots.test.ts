import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("resource assignment targets and nullable comparisons snapshot their selected owners", (t) => {
    const { cpp } = compileSource(`
        import {createBox,type EngineContext,type Mesh} from '@babylonjs/lite';
        function check(first:EngineContext,second:EngineContext):number {
            const left=createBox(first),right=createBox(second);
            const holder:{mesh:Mesh}={mesh:left};
            function replace():number {holder.mesh=right;return 7;}
            const holders=[holder];
            let index=0;
            const x=(holders[index++]!.mesh.position.x=replace());
            holder.mesh=left;
            const y=(holder.mesh.position.y=replace());
            if(index!==1||x!==7||y!==7)throw new Error('target evaluation');
            let current:Mesh|null=null;
            let changes=0;
            function update(next:Mesh|null):void {
                if(next===current)return;
                changes++;
                current=next;
            }
            update(null);update(left);update(left);update(right);update(null);
            if(changes!==3||current!==null)throw new Error('nullable state');
            current=left;
            function swap():Mesh {current=right;return left;}
            if(current!==swap())throw new Error('comparison snapshot');
            if(current!==right)throw new Error('comparison mutation');
            return changes;
        }
        const checks:Array<typeof check>=[check];
    `);
    const entry =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(entry, "stored resource assignment check");
    const native = optionalNativeFixtureTools(false);
    if (!native) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        native,
        "resource-assignment-snapshots",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                engine.meshes.emplace_back();
                return {0,0};
            }
            void mark_mesh_dirty(Engine& engine, MeshHandle mesh) {
                static_cast<void>(handle_at(engine.meshes,mesh));
                ++engine.draw_call_count;
            }
        }
        int main() {
            const bbl::js::RealmScope realm;
            auto first=std::make_shared<bbl::Engine>(),second=std::make_shared<bbl::Engine>();
            bblscene::${entry[2]} environment{};
            assert(bblscene::${entry[1]}(environment,bbl::StoredEngine{first},bbl::StoredEngine{second})==3);
            assert(first->meshes[0].position.x==7&&first->meshes[0].position.y==7);
            assert(second->meshes[0].position.x==0&&second->meshes[0].position.y==0);
            assert(first->draw_call_count==2&&second->draw_call_count==0);
        }
    `,
        { expectedOutput: "" },
    );
});
