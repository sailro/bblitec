import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("awaited scene registration executes statement-valued setup before suspension", (t) => {
    const directory = resolve("artifacts/async-scene-registration");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const result = compileSource(
        `import {createEngine,createSceneContext,registerSceneWithShadowSupport} from "@babylonjs/lite";
        const worker=new Worker(new URL("./worker.ts",import.meta.url),{type:"module"});worker.terminate();
        const engine=await createEngine(document.createElement("canvas"));
        const scene=createSceneContext(engine);
        await registerSceneWithShadowSupport(scene);`,
        { fileName: resolve(directory, "entry.ts") },
    );
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable.");
        return;
    }
    const cpp = resolve(directory, "check.cpp");
    writeFileSync(cpp, result.cpp);
    runNativeFixtureCompiler(tools, [
        "/Zs",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_HAS_UI=1",
        cpp,
    ]);
});

function setup(body: string) {
    return `
    import {createEngine, createSceneContext, createPbrMaterial, onBeforeRender} from "@babylonjs/lite";
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {type: "module"});
    worker.terminate();
    async function allocate() {
        await Promise.resolve();
        createPbrMaterial({metallicFactor: 0, roughnessFactor: 1});
    }
    async function nested() {return await allocate();}
    async function main() {
        const canvas = document.querySelector("canvas")!;
        const engine = await createEngine(canvas);
        const scene = createSceneContext(engine);
        ${body}
    }
    void main();`;
}

test("immediately awaited setup helpers preserve PBR construction order", () => {
    const directory = resolve("artifacts/async-engine-setup");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    const options = { fileName: resolve(directory, "entry.ts") };
    const result = compileSource(
        setup(`
        await allocate();
        await nested();
        createPbrMaterial({metallicFactor: 1, roughnessFactor: 0.5});
    `),
        options,
    );
    assert.equal(result.manifest.scenePbrMaterials.length, 3);
    assert.deepEqual(result.manifest.runtimeMaterialProfiles ?? [], []);
    for (const body of [
        "void allocate();",
        "if (Math.random() < 0.5) await allocate();",
        "while (Math.random() < 0.5) await allocate();",
        "onBeforeRender(scene, async () => {await allocate();});",
    ]) {
        const runtime = compileSource(setup(body), options);
        assert.equal(runtime.manifest.runtimeMaterialProfiles?.length, 1, body);
        assert.equal(runtime.manifest.scenePbrMaterials.length, 1, body);
    }
});

test("awaited fixed-array maps retain per-input asset slots and URL specialization", () => {
    const directory = resolve("artifacts/async-engine-setup");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    writeFileSync(
        resolve(directory, "asset-paths.ts"),
        `
        export const paths: readonly {url: string}[] = [{url:"./first.glb"}, {url:"./second.glb"}];
    `,
    );
    const compile = (input: string, immediate = true) =>
        compileSource(
            `
        import {createEngine, loadGltf, type EngineContext, type AssetContainer} from "@babylonjs/lite";
        import {paths} from "./asset-paths.js";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        function moduleUrl(path: string, source: string): string {
            const value = new URL(path, source);
            return value.href;
        }
        async function load(engine: EngineContext, url: string) { return await loadGltf(engine, url); }
        class AssetSet {
            readonly containers: readonly AssetContainer[];
            constructor(containers: readonly AssetContainer[]) { this.containers = containers; }
        }
        async function initialize(engine: EngineContext, resolveUrl: (path: string) => string) {
            function named(path: {url: string}) { return load(engine, resolveUrl(path.url)); }
            const aliased = named;
            const arrow = (path: {url: string}) => load(engine, resolveUrl(path.url));
            async function awaited(path: {url: string}) { return await load(engine, resolveUrl(path.url)); }
            ${
                immediate
                    ? `const containers = await Promise.all(${input});`
                    : `const pending = Promise.all(${input}); const containers = await pending;`
            }
            return new AssetSet(containers);
        }
        const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
        const engine = await createEngine(canvas);
        const assets = await initialize(engine, path => moduleUrl(path, import.meta.url));
        console.log(assets.containers.length);
    `,
            {
                fileName: resolve(directory, "entry.ts"),
                publicUrl: "https://assets.example/",
            },
        );
    for (const input of [
        "paths.map(path => load(engine, resolveUrl(path.url)))",
        "paths.map(path => { return load(engine, resolveUrl(path.url)); })",
        "paths.map(named)",
        "paths.map(aliased)",
        "paths.map(arrow)",
        "paths.map(awaited)",
        "paths.map(async path => await load(engine, resolveUrl(path.url)))",
        '[load(engine, resolveUrl("./first.glb")), load(engine, resolveUrl("./second.glb"))]',
    ]) {
        const result = compile(input);
        assert.equal(
            result.manifest.assets.filter((asset) => asset.kind === "gltf")
                .length,
            2,
            input,
        );
        assert.equal(
            result.cpp.match(/bbl::pal::load_realm_gltf\(/g)?.length,
            2,
            input,
        );
        assert.match(
            result.cpp,
            /using AssetSet = bbl::js::Ref<AssetSetData>;/,
        );
        assert.match(
            result.cpp,
            /ui_primary_canvas\(bbl::pal::window_document_engine\(\), "renderCanvas"\)/,
        );
    }
    assert.throws(
        () =>
            compile(
                'paths.filter(() => Math.random() > 0.5).map(() => load(engine, "./first.glb"))',
            ),
        /generation-known iteration count for glTF load order/,
    );
    assert.throws(
        () => compile("paths.map(named)", false),
        /generation-known iteration count for glTF load order/,
    );
});
