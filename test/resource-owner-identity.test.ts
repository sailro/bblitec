import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
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

test("a spread of unowned handles into engine-owned storage pairs them with the entry's engine", () => {
    // `visible` holds engine-owned meshes; the awaited group's plain mesh
    // array names no engine, so its handles are the entry engine's, as a
    // handle read out of storage is.
    const { cpp } = compileSource(`
        import { createBox, createEngine, createSceneContext, addToScene } from "@babylonjs/lite";
        import type { EngineContext, Mesh, SceneContext } from "@babylonjs/lite";
        interface Part { mesh: Mesh }
        interface Batch { meshes: Mesh[] }
        interface Group { id: string; masonry: Part; corbels: Batch }
        function createBatch(engine: EngineContext, count: number): Batch {
            const meshes: Mesh[] = [];
            for (let i = 0; i < count; i++) meshes.push(createBox(engine, { size: 1 }));
            return { meshes };
        }
        function makeGroup(engine: EngineContext, id: string): Group {
            return { id, masonry: { mesh: createBox(engine, { size: 2 }) }, corbels: createBatch(engine, id.length + 1) };
        }
        async function loadGroup(engine: EngineContext, id: string): Promise<Group> {
            await new Promise<void>((resolve) => setTimeout(resolve, 1));
            return makeGroup(engine, id);
        }
        async function buildTower(engine: EngineContext, scene: SceneContext): Promise<Mesh[]> {
            const body: Part = { mesh: createBox(engine, { size: 3 }) };
            const visible: Mesh[] = [body.mesh];
            const register = (group: Group): void => {
                visible.push(group.masonry.mesh, ...group.corbels.meshes);
            };
            for (const id of ["a", "bb"]) register(await loadGroup(engine, id));
            for (const mesh of visible) addToScene(scene, mesh);
            return visible;
        }
        async function main(): Promise<void> {
            const engine = await createEngine(document.createElement("canvas"));
            const scene = createSceneContext(engine);
            console.log((await buildTower(engine, scene)).length);
        }
        void main();
    `);
    assert.match(cpp, /bbl::js::array_from_iterable</);
});

test("an entry program compares an optional stored handle with a plain one by its slot", () => {
    // Every unowned material of the entry program is its one engine's, so
    // the cached record's material compares with the mesh's alone.
    const { cpp } = compileSource(`
        import { addToScene, createBox, createEngine, createSceneContext, createStandardMaterial } from "@babylonjs/lite";
        import type { Material, Mesh } from "@babylonjs/lite";
        interface CachedView { source: Material; base: number; view: Material | null }
        const views = new Map<Mesh, CachedView>();
        async function main(): Promise<void> {
            const engine = await createEngine(document.createElement("canvas"));
            const scene = createSceneContext(engine);
            const box = createBox(engine, { size: 1 });
            box.material = createStandardMaterial();
            addToScene(scene, box);
            for (const mesh of scene.meshes) {
                const material = mesh.material;
                if (!material) continue;
                const base = mesh.position.x > 0 ? 3 : 0;
                const cached = views.get(mesh);
                let view: Material | null;
                if (cached?.source === material && cached.base === base) view = cached.view;
                else {
                    view = material;
                    views.set(mesh, { source: material, base, view });
                }
                console.log(view === null);
            }
        }
        void main();
    `);
    assert.match(cpp, /\.has_value\(\) && \(\*\w+\) == v_\w+_material\)/);
});

test("an array of elements stored in a record field stays the caller's one array", (t) => {
    // `keep` is called once per caller and specializes on each caller's
    // elements, which keep their engine: the field does, and so do the
    // arrays the caller still changes, so each tab's rows are the array the
    // caller holds.
    const source = `
        interface Tab { readonly name: string; readonly rows: readonly HTMLElement[]; }
        const tabs: Tab[] = [];
        function keep(name: string, rows: HTMLElement[]): void {
            if (rows.length === 0) return;
            tabs.push({ name, rows });
        }
        const grown: HTMLElement[] = [];
        grown.push(document.createElement("div"));
        const listed: HTMLElement[] = [document.createElement("div")];
        keep("grown", grown);
        keep("listed", listed);
        keep("mapped", listed.map((row) => row));
        const added = document.createElement("div");
        grown.push(added);
        const replaced = listed[0]!;
        listed[0] = document.createElement("div");
        const [first, second, third] = tabs;
        if (!first || !second || !third) throw new Error("stored tabs");
        if (first.rows.length !== 2 || first.rows[1] !== added || first.rows[0] !== grown[0]) throw new Error("grown rows");
        if (second.rows[0] !== listed[0] || second.rows[0] === replaced) throw new Error("listed rows");
        if (third.rows.length !== 1 || third.rows[0] !== replaced) throw new Error("mapped rows");
        globalThis.close();
    `;
    runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ESNext },
        }).outputText,
        {
            document: { createElement: (tag: string) => ({ tag }) },
            globalThis: { close: () => undefined },
        },
    );
    const { cpp } = compileSource(source);
    assert.match(
        cpp,
        /bbl::js::Array<std::pair<bbl::StoredEngine, bbl::UiElementHandle>> rows;/,
    );
    assert.match(
        cpp,
        /bbl::js::Array<std::pair<bbl::StoredEngine, bbl::UiElementHandle>> v_grown = /,
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(
        tools,
        "resource-owner-identity/element-rows",
        `
        #define main generated_main
        ${cpp}
        #undef main
        #include <cassert>
        namespace bbl {
            unsigned created = 0;
            UiElementHandle ui_create_element(Engine& owner, std::string_view tag) {
                assert(&owner == &pal::window_document_engine() && tag == "div");
                return UiElementHandle{created++};
            }
        }
        namespace bbl::pal {
            Engine& window_document_engine() { static Engine host; return host; }
            int run_window_application(WorkerEntry initialize, EngineOptions) {
                const js::RealmScope scope;
                EventLoop loop;
                WorkerRealm realm(loop);
                loop.run([&] { initialize(realm); });
                return 0;
            }
        }
        int main() { const int result = generated_main(); assert(bbl::created == 4); return result; }
    `,
        {
            flags: [
                "/DBBLITE_HAS_UI=1",
                "/DBBLITE_WORKERS=1",
                "/DBBLITE_OFFSCREEN_SURFACES=1",
            ],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
    // A new array of meshes read from record fields, which keep their
    // engine, is the array a callback's record receives even after it
    // grows: its local holds the engine-less elements that record holds.
    const meshes = `
        import {createBox, type EngineContext, type Mesh} from "@babylonjs/lite";
        interface Part { readonly mesh: Mesh; show(): void; }
        function inspect(engine: EngineContext): number {
            const listeners: ((ready: { meshes: Mesh[] }) => void)[] = [];
            const held: Mesh[][] = [];
            listeners.push((ready) => { held.push(ready.meshes); });
            function part(size: number): Part {
                const mesh = createBox(engine, { size });
                return { mesh, show: () => { if (size < 0) console.log(mesh.name); } };
            }
            function finish(top: Part, bottom: Part): number {
                top.show();
                const meshes = [top.mesh, bottom.mesh];
                for (const listener of listeners) listener({ meshes });
                meshes.push(top.mesh);
                if (held[0] !== meshes || held[0]!.length !== 3) throw new Error("one array");
                return meshes.length;
            }
            return finish(part(1), part(2));
        }
        const factories: Array<typeof inspect> = [inspect];
    `;
    runInNewContext(
        `${
            ts.transpileModule(meshes, {
                compilerOptions: {
                    target: ts.ScriptTarget.ESNext,
                    module: ts.ModuleKind.CommonJS,
                },
            }).outputText
        }; if (factories[0](engine) !== 3) throw new Error("meshes");`,
        {
            exports: {},
            require: () => ({ createBox: () => ({ name: "box" }) }),
            engine: {},
        },
    );
    const { cpp: meshCpp } = compileSource(meshes);
    const factory =
        /double (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+\);/.exec(
            meshCpp,
        );
    assert.ok(factory, "mesh factory");
    const [, name, environment] = factory;
    runGeneratedProgram(
        tools,
        "resource-owner-identity/callback-meshes",
        `
        #define main generated_main
        ${meshCpp}
        #undef main
        #include <cassert>
        namespace bbl {
            MeshHandle create_box(Engine& engine, BoxOptions) {
                const auto generation = static_cast<std::uint32_t>(engine.meshes.size());
                engine.meshes.emplace_back();
                return {0, generation};
            }
        }
        int main() {
            const bbl::js::RealmScope realm;
            auto engine = std::make_shared<bbl::Engine>();
            bblscene::${environment} environment{};
            assert(bblscene::${name}(environment, bbl::StoredEngine{engine}) == 3);
            assert(engine->meshes.size() == 2);
        }
        `,
        { expectedOutput: "" },
    );
});

test("a returned record's array of owned resources assigned to a binding is its declared field's one array", () => {
    // The declared field takes the elements' engine owners, as a declared
    // initializer's does (`retainedResultType`): an engine-less copy would
    // be a second array.
    const { cpp } = compileSource(`
        import {addToScene, createBox, createEngine, createSceneContext, type EngineContext, type Mesh, type SceneContext} from '@babylonjs/lite';
        interface Group { readonly meshes: readonly Mesh[]; count(): number; grow(by: number): void }
        interface Part { mesh: Mesh; count: number }
        function build(engine: EngineContext, scene: SceneContext, sizes: readonly number[]): Group {
            const parts: Part[] = sizes.map((size) => { const mesh = createBox(engine, { size }); addToScene(scene, mesh); return { mesh, count: 0 }; });
            return { meshes: parts.map((part) => part.mesh), count: () => parts.reduce((sum, part) => sum + part.count, 0), grow(by) { for (const part of parts) part.count += by; } };
        }
        const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
        const scene = createSceneContext(engine);
        const all: Mesh[] = [];
        let group: Group | null = null;
        const groupOf = (): Group => {
            if (!group) { group = build(engine, scene, [1, 2]); all.push(...group.meshes); }
            return group;
        };
        groupOf().grow(2);
        for (const mesh of groupOf().meshes) mesh.position.y = groupOf().count() + all.length;
    `);
    assert.match(
        cpp,
        /struct GroupData \{\s*bbl::js::Array<std::pair<bbl::StoredEngine, bbl::MeshHandle>> meshes;/,
    );
});
