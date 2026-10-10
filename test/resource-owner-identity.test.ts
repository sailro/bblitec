import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("resource equality and array search preserve engine identity, generations and operand order", (t) => {
    const { cpp } = compileSource(`
        import {createBox,type EngineContext,type Mesh} from '@babylonjs/lite';
        function inspect(first:EngineContext,second:EngineContext):number {
            const left=createBox(first),right=createBox(second),replacement=createBox(first);
            if(left===right||left===replacement||left!==left)throw new Error('identity');
            const equal:Array<(a:Mesh,b:Mesh)=>boolean>=[(a,b)=>a===b];
            if(equal[0]!(left,right)||equal[0]!(left,replacement)||!equal[0]!(left,left))
                throw new Error('stored identity parameter owners');
            let reads=0;
            function leftOperand():Mesh {reads++;return left;}
            function rightOperand():Mesh {if(reads!==1)throw new Error('order');reads++;return right;}
            if(leftOperand()===rightOperand()||reads!==2)throw new Error('evaluation');
            let selected=left;
            function replace():Mesh {selected=right;return left;}
            if(selected!==replace())throw new Error('left snapshot');
            const rows:Mesh[]=[left];
            if(!rows.includes(left)||rows.includes(right)||rows.includes(replacement))throw new Error('includes');
            if(rows.indexOf(left)!==0||rows.indexOf(right)!==-1||rows.indexOf(replacement)!==-1)throw new Error('indexOf');
            if(rows.lastIndexOf(left)!==0||rows.lastIndexOf(right)!==-1)throw new Error('lastIndexOf');
            return reads;
        }
        const factories:Array<typeof inspect>=[inspect];
    `);
    const factory =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(factory, "resource identity factory");
    const [, name, environment] = factory;
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "resource-owner-identity/direct",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                const auto generation=static_cast<std::uint32_t>(engine.meshes.size());
                engine.meshes.emplace_back();
                return {0,generation};
            }
        }
        int main() {
            const bbl::js::RealmScope realm;
            auto first=std::make_shared<bbl::Engine>();
            auto second=std::make_shared<bbl::Engine>();
            bblscene::${environment} environment{};
            assert(bblscene::${name}(environment,bbl::StoredEngine{first},bbl::StoredEngine{second})==2);
            assert(first->meshes.size()==2&&second->meshes.size()==1);
        }
        `,
        { expectedOutput: "" },
    );
});

test("raw resource array searches refuse an unrepresented mixture of engines", () => {
    for (const method of ["includes", "indexOf", "lastIndexOf"]) {
        assert.throws(
            () =>
                compileSource(`
                import {createBox,type EngineContext,type Mesh} from '@babylonjs/lite';
                function inspect(first:EngineContext,second:EngineContext):boolean {
                    const left=createBox(first),right=createBox(second);
                    const rows:Mesh[]=[left,right];
                    return Boolean(rows.${method}(left));
                }
                const factories:Array<typeof inspect>=[inspect];
            `),
            /Array resource identity requires one proved engine or owned element storage/,
        );
    }
});

test("optional camera identity compares owned handles without native equality operators", (t) => {
    const { cpp } = compileSource(`
        import {type Camera} from '@babylonjs/lite';
        function inspect(left:Camera,right:Camera,missing:Camera):number {
            const pairs=new Map(new Set([left,right]).entries());
            if(pairs.get(left)!==left||right!==pairs.get(right)||pairs.get(left)===pairs.get(right))
                throw new Error('optional camera owner identity');
            if(pairs.get(missing)===left||left===pairs.get(missing)||pairs.get(missing)!==undefined)
                throw new Error('missing camera identity');
            function clear():Camera {pairs.clear();return left;}
            if(pairs.get(left)!==clear())throw new Error('optional camera snapshot');
            return 2;
        }
        const callbacks:Array<typeof inspect>=[inspect];
    `);
    const factory =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] std::pair<bbl::StoredEngine, bbl::CameraHandle> \w+, \[\[maybe_unused\]\] std::pair<bbl::StoredEngine, bbl::CameraHandle> \w+, \[\[maybe_unused\]\] std::pair<bbl::StoredEngine, bbl::CameraHandle> \w+\);/.exec(
            cpp,
        );
    assert.ok(factory, "camera identity factory");
    const [, name, environment] = factory;
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "resource-owner-identity/camera",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        int main() {
            const bbl::js::RealmScope realm;
            auto first=std::make_shared<bbl::Engine>(),second=std::make_shared<bbl::Engine>();
            bblscene::${environment} environment{};
            assert(bblscene::${name}(environment,
                {bbl::StoredEngine{first},bbl::CameraHandle{0}},
                {bbl::StoredEngine{second},bbl::CameraHandle{0}},
                {bbl::StoredEngine{first},bbl::CameraHandle{1}})==2);
        }
    `,
        { expectedOutput: "" },
    );
});

test("resource identity callbacks require owned parameters and preserve absence checks", () => {
    const { cpp } = compileSource(`
            import {type Mesh} from '@babylonjs/lite';
            function equal(left:Mesh,right:Mesh):boolean {return left===right;}
            const callbacks:Array<typeof equal>=[equal];
        `);
    assert.match(cpp, /std::pair<bbl::StoredEngine, bbl::MeshHandle>/);
    assert.doesNotThrow(() =>
        compileSource(`
        import {type Mesh} from '@babylonjs/lite';
        function present(value:Mesh|undefined):boolean {return value!==undefined;}
        const callbacks:Array<typeof present>=[present];
    `),
    );
});
