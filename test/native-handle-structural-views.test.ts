import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const imports = `
    import {createBox, type EngineContext, type Mesh, type TransformNode} from "@babylonjs/lite";
`;

test("checked native handle views retain producer identity through methods, results and closures", (t) => {
    const { cpp } = compileSource(`${imports}
        type Named = Readonly<Pick<Mesh, "name">>;
        type Shown = Pick<Mesh, "visible">;
        function named(mesh: Mesh): Named { return mesh; }
        function alias(view: Named): Named { return view; }
        function hide(view: Shown): void { view.visible = false; }
        function label(view: Named & Partial<Shown>): string {
            return view.name + (view.visible === false ? ":hidden" : ":shown");
        }
        class Reader {
            read(view: Named): string { return label(view); }
            bound(view: Readonly<Pick<TransformNode, "parent">>, parent: Mesh): boolean {
                return view.parent === parent;
            }
            move(view: Pick<TransformNode, "position" | "rotation">): number {
                view.position.set(1, 2, 3);
                view.rotation.x = 1;
                return view.position.y;
            }
        }
        function retain(first: EngineContext, second: EngineContext): () => string {
            const left = createBox(first);
            const leftParent = createBox(first);
            left.parent = leftParent;
            const right = createBox(second);
            const rightParent = createBox(second);
            right.parent = rightParent;
            const view: Named = left;
            const holder: {readonly item: Named} = {item: alias(named(right))};
            let selected = createBox(first);
            const original: Named = selected;
            selected = createBox(first);
            const reader = new Reader();
            if (!reader.bound(left, leftParent) || !reader.bound(right, rightParent))
                throw new Error("structural parent read");
            return () => {
                hide(left);
                if (reader.move(left) !== 2 || left.rotation.x !== 1) throw new Error("live transform view");
                if (original.name !== "10:2" || selected.name !== "10:3") throw new Error("rebound source");
                if (view !== left || holder.item !== right) throw new Error("view identity");
                return reader.read(view) + "/" + reader.read(holder.item);
            };
        }
        const factories: Array<typeof retain> = [retain];
    `);
    const factory =
        /bbl::js::Callback<std::string\(\)> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            cpp,
        );
    assert.ok(factory, "retained view factory prototype");
    const [, name, environment] = factory;
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        native,
        "native-handle-structural-views/retained",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                const auto index = static_cast<std::uint32_t>(engine.meshes.size());
                engine.meshes.emplace_back();
                engine.meshes.back().name = std::to_string(engine.draw_call_count) + ":" + std::to_string(index);
                engine.meshes.back().visible = true;
                return {index, 0};
            }
            void set_mesh_transform_parent(Engine& engine, MeshHandle mesh, MeshHandle parent) {
                handle_at(engine.meshes, mesh).parent = parent;
            }
            void set_mesh_visible(Engine& engine, MeshHandle mesh, bool visible) {
                handle_at(engine.meshes, mesh).visible = visible;
            }
            void mark_mesh_dirty(Engine&, MeshHandle) {}
        }
        int main() {
            const bbl::js::RealmScope realm;
            auto first = std::make_shared<bbl::Engine>();
            auto second = std::make_shared<bbl::Engine>();
            first->draw_call_count = 10;
            second->draw_call_count = 20;
            std::weak_ptr<bbl::Engine> weak_first = first, weak_second = second;
            bblscene::${environment} environment{};
            auto callback = bblscene::${name}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second});
            first.reset(); second.reset();
            assert(callback() == "10:0:hidden/20:0:shown");
            assert(callback() == "10:0:hidden/20:0:shown");
            assert(!weak_first.expired() && !weak_second.expired());
            callback = {};
            bbl::js::collect_cycles();
            assert(weak_first.expired() && weak_second.expired());
        }
    `,
    );
});

test("structural annotations retain unsupported native member refusals", () => {
    assert.throws(
        () =>
            compileSource(`${imports}
            class Reader {
                read(view: Pick<Mesh, "worldMatrixVersion">): number { return view.worldMatrixVersion; }
            }
            function run(engine: EngineContext): number { return new Reader().read(createBox(engine)); }
            const calls: Array<typeof run> = [run];
        `),
        /not supported|Unsupported|not lowered|not implemented|requires/,
    );
});

test("stored structural views refuse mixed objects and missing producer owners", () => {
    assert.throws(
        () =>
            compileSource(`${imports}
            type View = Readonly<Pick<Mesh, "name">>;
            function run(engine: EngineContext): string {
                const native: View = createBox(engine);
                const plain: View = {name: "plain"};
                return native.name + plain.name;
            }
            const calls: Array<typeof run> = [run];
        `),
        /Expected a mesh value, received record/,
    );
    assert.throws(
        () =>
            compileSource(`${imports}
            type View = Readonly<Pick<Mesh, "name">>;
            function read(view: View): string { return view.name; }
            const readers: Array<typeof read> = [read];
            function run(engine: EngineContext): string { return readers[0]!(createBox(engine)); }
            const calls: Array<typeof run> = [run];
        `),
        /not associated with an engine/,
    );
});
