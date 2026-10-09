import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const imports = `
    import {createBox, setMeshVisible, type EngineContext, type Mesh} from "@babylonjs/lite";
`;

test("source-created resource views retain independent engines through fields, indices and returns", (t) => {
    const { cpp } = compileSource(`${imports}
        function wrap(mesh: Mesh): {readonly mesh: Mesh} { return {mesh}; }
        function mutable(mesh: Mesh): {mesh: Mesh} { return {mesh}; }
        function hide(mesh: Mesh): void { if (mesh.visible !== false) setMeshVisible(mesh, false); }
        function retain(first: EngineContext, second: EngineContext): () => number {
            const state: {engine: EngineContext} = {engine: first};
            const left = createBox(state.engine);
            state.engine = second;
            let widthCalls = 0;
            function width(): number {widthCalls++; state.engine = first; return 1;}
            const right = createBox(state.engine, {width: width()});
            state.engine = first;
            if (widthCalls !== 1) throw new Error('repeated option evaluation');
            const meshes: Mesh[] = [left, right];
            const selected = meshes[0]!;
            const holder: {readonly mesh: Mesh} = wrap(meshes[1]!);
            const aliases: Mesh[] = [left, left];
            const dynamic = aliases[first.drawCallCount]!;
            const view = mutable(dynamic);
            return () => {
                hide(selected);
                hide(holder.mesh);
                if (dynamic.visible !== false) throw new Error('lost same-owner alias');
                if (view.mesh.visible !== false) throw new Error('lost mutable record owner');
                for (const mesh of aliases) {
                    if (mesh.visible !== false) throw new Error('lost iterated owner');
                }
                return first.drawCallCount + second.drawCallCount;
            };
        }
        const factories: Array<typeof retain> = [retain];
    `);
    const factory =
        /bbl::js::Callback<double\(\)> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(factory, "retained resource factory prototype");
    const [, name, environment] = factory;
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Requires the Windows native fixture compiler.");
        return;
    }
    runGeneratedProgram(
        tools,
        "resource-owner-views/retained",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                engine.meshes.emplace_back();
                engine.meshes.back().visible = true;
                return {static_cast<std::uint32_t>(engine.meshes.size() - 1), 0};
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
            auto first = std::make_shared<bbl::Engine>();
            auto second = std::make_shared<bbl::Engine>();
            std::weak_ptr<bbl::Engine> weak_first = first, weak_second = second;
            bblscene::${environment} environment{};
            auto callback = bblscene::${name}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second});
            first.reset(); second.reset();
            assert(!weak_first.expired() && !weak_second.expired());
            assert(callback() == 2);
            assert(callback() == 2);
            assert(weak_first.lock()->draw_call_count == 1);
            assert(weak_second.lock()->draw_call_count == 1);
            assert(weak_first.lock()->meshes.size() == 1);
            assert(weak_second.lock()->meshes.size() == 1);
            callback = {};
            bbl::js::collect_cycles();
            assert(weak_first.expired() && weak_second.expired());
        }
        `,
        { timeoutMs: 10000, expectedOutput: "" },
    );
});

for (const select of [
    "for (const selected of meshes) setMeshVisible(selected, false); const selected = left;",
    "const alias = meshes; alias[0] = right; const selected = meshes[0]!;",
    "function changeIndex():number {meshes[0] = right; return index;} const selected = meshes[changeIndex()]!;",
]) {
    test(`resource selection refuses an unrepresented engine choice: ${select}`, () => {
        assert.throws(
            () =>
                compileSource(`${imports}
                    function inspect(first: EngineContext, second: EngineContext, index: number): void {
                        const left = createBox(first);
                        const right = createBox(second);
                        const meshes: Mesh[] = [left, right];
                        ${select}
                        setMeshVisible(selected, false);
                    }
                    const callbacks: Array<typeof inspect> = [inspect];
                `),
            /not associated with an engine|native assignment|Unsupported property assignment/,
        );
    });
}

test("retained engine parameters refuse reassignment through raw aliases", () => {
    for (const assignment of [
        "first = second;",
        "const changed = (first = second);",
    ])
        assert.throws(
            () =>
                compileSource(`${imports}
                function retain(first: EngineContext, second: EngineContext): () => number {
                    const mesh = createBox(first);
                    ${assignment}
                    return () => {setMeshVisible(mesh, false); return 0;};
                }
                const callbacks: Array<typeof retain> = [retain];
            `),
            /Reassigning an engine alias is not supported/,
        );
});
