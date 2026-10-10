import assert from "node:assert/strict";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { assertAsyncSourceCloses } from "./async-oracle.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("async results retain callable identity and independent captured state", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        async function counter(start:number):Promise<()=>number> {
            await Promise.resolve();
            return ()=>++start;
        }
        async function erased(start:number):Promise<unknown> {
            return ()=>++start;
        }
        (async()=>{
            const pending=counter(1);
            const first=await pending,alias=await pending,second=await counter(10);
            if(first!==alias||first===second||first()!==2||alias()!==3||second()!==11)throw new Error('callable result');
            const hidden=await erased(20) as ()=>number;
            if(hidden()!==21||hidden()!==22)throw new Error('erased callable state');
            const direct=await Promise.resolve(first);
            if(direct!==first||direct()!==4)throw new Error('resolved callable identity');
        })().then(()=>globalThis.close());
    `;
    await assertAsyncSourceCloses(source);
    const { cpp } = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "async-resource-owners/callable", cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("async callable views preserve properties, call identity and nested erased aliases", async (t) => {
    const source = `
        queueMicrotask(()=>{});
        type Source=(()=>number)&{notify?:()=>void;count?:number};
        interface Envelope {nested:{reader:unknown};}
        async function wrap(reader:Source):Promise<Envelope> {
            await Promise.resolve();return{nested:{reader}};
        }
        async function make():Promise<Source> {
            return Object.assign(()=>7,{count:1});
        }
        (async()=>{
            let value=2,calls=0;
            const base=()=>value;
            const source:Source=base;
            const pending=wrap(source);
            const envelope=await pending;
            const reader=envelope.nested.reader as Source;
            if(reader!==source||reader!==base||Object.hasOwn(reader,'notify'))throw new Error('callable aliases');
            reader.notify=()=>{calls++;};
            source.notify?.();value=4;
            if(reader()!==4||calls!==1||!Object.hasOwn(source,'notify'))throw new Error('callable state');
            delete source.notify;
            if(Object.hasOwn(reader,'notify'))throw new Error('callable deletion');
            const initialized=await make();
            if(initialized()!==7||initialized.count!==1)throw new Error('callable assigned result');
        })().then(()=>globalThis.close());
    `;
    await assertAsyncSourceCloses(source);
    const { cpp } = compileSource(source);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    runGeneratedProgram(tools, "async-resource-owners/callable-views", cpp, {
        flags: ["/DBBLITE_WORKERS=1"],
        timeoutMs: 10000,
        expectedOutput: "",
    });
});

test("stored async resource callbacks demand an owning parameter representation", () => {
    const { cpp } = compileSource(`
            import {type Mesh} from '@babylonjs/lite';
            queueMicrotask(()=>{});
            function retain(mesh:Mesh):Promise<()=>boolean|undefined> {
                return Promise.resolve(mesh).then(owner=>()=>owner.visible);
            }
            const callbacks:Array<typeof retain>=[retain];
        `);
    assert.match(cpp, /std::pair<bbl::StoredEngine,\s*bbl::MeshHandle>/);
});

test("a nullable assertion cannot fabricate an async resource owner", () => {
    assert.throws(
        () =>
            compileSource(`
            import {createBox,type EngineContext,type Mesh} from '@babylonjs/lite';
            queueMicrotask(()=>{});
            type View=Readonly<Pick<Mesh,'name'|'visible'>>;
            async function wrap(owner:View):Promise<View>{return owner;}
            function retain(engine:EngineContext,present:boolean):Promise<View> {
                const mesh=createBox(engine);
                const maybe=present?mesh:undefined;
                return wrap(maybe as Mesh);
            }
            const callbacks:Array<typeof retain>=[retain];
        `),
        /Nullable asynchronous resources|engine|owner|without preserving its identity/,
    );
});

for (const [label, prepare, select] of [
    [
        "returned array",
        "function collect(a:Mesh,b:Mesh):Mesh[]{return[a,b];} const meshes=collect(left,right);",
        "meshes[index()]!",
    ],
    [
        "returned holder",
        "function collect(a:Mesh,b:Mesh):{meshes:Mesh[]}{return{meshes:[a,b]};} const meshes=collect(left,right).meshes;",
        "meshes[index()]!",
    ],
    [
        "structural view",
        "const meshes:Mesh[]=[left,right]; function pick(items:Mesh[],index:number):Readonly<Pick<Mesh,'name'|'visible'>>{return items[index]!;}",
        "pick(meshes,index())",
    ],
] as const)
    test(`async ${label} retains only the selected engine through an erased result and callback`, (t) => {
        const { cpp } = compileSource(`
            import {createBox,setMeshVisible,type EngineContext,type Mesh} from '@babylonjs/lite';
            queueMicrotask(()=>{});
            type View=Readonly<Pick<Mesh,'name'|'visible'>>;
            interface Envelope{wrapper:{owner:unknown};}
            async function wrap(owner:View):Promise<Envelope>{await Promise.resolve();return{wrapper:{owner}};}
            async function optional(owner:Mesh|undefined):Promise<unknown>{await Promise.resolve();return owner;}
            function retain(first:EngineContext,second:EngineContext,choice:number):Promise<()=>number>{
                const left=createBox(first),right=createBox(second);
                ${prepare}
                let reads=0;
                function index():number{reads++;return choice;}
                const selected=${select};
                const pending=Promise.resolve(selected)
                    .then(owner=>owner)
                    .then(owner=>Promise.resolve(owner))
                    .catch(()=>selected);
                meshes[0]=left;meshes[1]=left;choice=1-choice;
                return pending.then(async owner=>{
                    const maybe=await optional(owner as Mesh) as Mesh|undefined;
                    if(maybe===undefined)throw new Error('optional owner');
                    if(await optional(undefined)!==undefined)throw new Error('optional absence');
                    if(maybe!==owner)throw new Error('optional identity');
                    const result=await wrap(maybe as Mesh);
                    const view:View=result.wrapper.owner as Mesh;
                    return ()=>{
                        if(view.visible!==false)setMeshVisible(view as Mesh,false);
                        return reads+view.name.length;
                    };
                });
            }
            const factories:Array<typeof retain>=[retain];
        `);
        const factory =
            /bbl::js::Promise<bbl::js::Callback<double\(\)>> (\w+)\(\[\[maybe_unused\]\] bblscene::(\w+)& \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] bbl::StoredEngine \w+, \[\[maybe_unused\]\] double \w+\);/.exec(
                cpp,
            );
        assert.ok(factory, "async resource selector factory");
        const [, name, environment] = factory;
        const tools = optionalNativeFixtureTools(false);
        if (!tools) return t.skip("Native fixture compiler unavailable.");
        runGeneratedProgram(
            tools,
            `async-resource-owners/${label.replaceAll(" ", "-")}`,
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
                    void set_mesh_visible(Engine& engine, MeshHandle mesh, bool visible) {
                        auto& record = handle_at(engine.meshes, mesh);
                        if(record.visible == visible) throw std::runtime_error("duplicate mutation");
                        record.visible = visible;
                        ++engine.draw_call_count;
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
                            bblscene::${environment} environment{};
                            auto pending = bblscene::${name}(environment, bbl::StoredEngine{first}, bbl::StoredEngine{second}, choice);
                            pending.observe([&](const bbl::js::Callback<double()>& value) {callback = value; loop.close();},
                                [](std::exception_ptr error) {std::rethrow_exception(error);});
                            first.reset(); second.reset();
                            assert(unselected.expired());
                            assert(!selected.expired());
                        });
                        assert(unselected.expired());
                        assert(!selected.expired());
                        assert(callback() == 2 && callback() == 2);
                        assert(selected.lock()->draw_call_count == 1);
                        callback = {};
                        bbl::js::collect_cycles();
                        assert(selected.expired());
                    }
                }
            `,
            {
                flags: ["/DBBLITE_WORKERS=1"],
                timeoutMs: 10000,
                expectedOutput: "",
            },
        );
    });
