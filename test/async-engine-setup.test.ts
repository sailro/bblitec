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
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/Zs",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_WINDOW_SURFACES=1",
        "/DBBLITE_HAS_UI=1",
        `/I${resolve("native/include")}`,
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
    ])
        assert.throws(
            () => compileSource(setup(body), options),
            /generation-known iteration count for PBR material slots/,
        );
});
