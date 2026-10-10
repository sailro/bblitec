import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

for (const [label, prepare, select] of [
    [
        "returned array",
        "function collect(a:Mesh,b:Mesh):Mesh[]{return[a,b];} const meshes=collect(left,right);",
        "meshes[index()]!",
    ],
    [
        "returned array holder",
        "function collect(a:Mesh,b:Mesh):{meshes:Mesh[]}{return {meshes:[a,b]};} const group=collect(left,right); const meshes=group.meshes;",
        "meshes[index()]!",
    ],
    [
        "array helper",
        "const meshes:Mesh[]=[left,right]; function pick(values:Mesh[],index:number):Mesh{return values[index]!;}",
        "pick(meshes,index())",
    ],
    ["conditional", "", "index() === 0 ? left : right"],
] as const)
    test(`${label} retains only the selected engine across helpers and closures`, (t) => {
        const { cpp } = compileSource(`
        import {createBox, setMeshVisible, type EngineContext, type Mesh} from "@babylonjs/lite";
        function wrap(mesh: Mesh): {readonly mesh: Mesh} {return {mesh};}
        function retain(first: EngineContext, second: EngineContext, choice: number): () => number {
            const left = createBox(first);
            const right = createBox(second);
            ${prepare}
            let reads = 0;
            function index(): number {reads++; return choice;}
            const selected = ${select};
            ${label === "conditional" ? "" : "meshes[0] = left; meshes[1] = left;"}
            choice = 1 - choice;
            const holder = wrap(selected);
            if (reads !== 1) throw new Error('repeated index');
            return () => {
                if (holder.mesh.visible !== false) setMeshVisible(holder.mesh, false);
                return reads;
            };
        }
        const factories: Array<typeof retain> = [retain];
    `);
        const factory =
            /bbl::js::Callback<double\(\)> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] double \w+\);/.exec(
                cpp,
            );
        assert.ok(factory, "resource selector factory");
        const [, name, environment] = factory;
        const tools = optionalNativeFixtureTools(false);
        if (!tools)
            return t.skip("Requires the Windows native fixture compiler.");
        runGeneratedProgram(
            tools,
            `resource-owner-selection/${label.replaceAll(" ", "-")}`,
            `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                engine.meshes.emplace_back();
                engine.meshes.back().visible = true;
                return {0, 0};
            }
            void set_mesh_visible(Engine& engine, MeshHandle mesh, bool visible) {
                auto& record = handle_at(engine.meshes, mesh);
                if (record.visible == visible) throw std::runtime_error("duplicate mutation");
                record.visible = visible;
                ++engine.draw_call_count;
            }
        }
        int main() {
            const bbl::js::RealmScope realm;
            for (unsigned choice = 0; choice < 2; ++choice) {
                auto first = std::make_shared<bbl::Engine>();
                auto second = std::make_shared<bbl::Engine>();
                std::weak_ptr<bbl::Engine> selected = choice == 0 ? first : second;
                std::weak_ptr<bbl::Engine> unselected = choice == 0 ? second : first;
                bblscene::${environment} environment{};
                auto callback = bblscene::${name}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second}, choice);
                first.reset(); second.reset();
                assert(unselected.expired());
                assert(!selected.expired());
                assert(callback() == 1 && callback() == 1);
                assert(selected.lock()->draw_call_count == 1);
                callback = {};
                bbl::js::collect_cycles();
                assert(selected.expired());
            }
        }
    `,
            { timeoutMs: 10000, expectedOutput: "" },
        );
    });
