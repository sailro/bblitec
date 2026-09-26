import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

function compileDocument(edit: string, retained?: "scalar" | "texture") {
    const directory = resolve("artifacts/node-material-document-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "worker.ts"), "self.close();");
    writeFileSync(
        resolve(directory, "graph.json"),
        JSON.stringify({ blocks: [], backFaceCulling: true }),
    );
    return compileSource(
        `
        import {createEngine, parseNodeMaterialFromSnippet, createSceneContext,
            createBox, createSolidTexture2D, registerScene, onBeforeRender,
            type EngineContext, type NodeMaterial, type Mesh} from "babylon-lite";
        const worker = new Worker(new URL("./worker.ts", import.meta.url), {type:"module"});
        worker.terminate();
        async function readText(path: string): Promise<string> {
            const response = await fetch(path);
            if (!response.ok) throw new Error("missing document");
            return response.text();
        }
        async function loadGraph(engine: EngineContext, hasInstances: boolean, edit: boolean) {
            let json = await readText("/graph.json");
            if (edit) {
                const graph = JSON.parse(json) as {backFaceCulling: boolean; forceAlphaBlending?: boolean};
                ${edit}
                json = JSON.stringify(graph);
            }
            return parseNodeMaterialFromSnippet(engine, "", {json, hasInstances});
        }
        async function main() {
            const engine = await createEngine(document.querySelector("canvas")!);
            const scene = createSceneContext(engine);
            const [material] = await Promise.all([
                loadGraph(engine, true, false),
                loadGraph(engine, false, false),
                loadGraph(engine, false, true),
            ]);
            const texture = createSolidTexture2D(engine, 1, 1, 1, 1);
            async function initializeInputs(owner: NodeMaterial) {
                if (owner.inputs.gain) {
                    owner.inputs.gain.value = 2;
                    owner.inputs.albedo!.texture = texture;
                }
            }
            await initializeInputs(material);
            function attach(mesh: Mesh) {mesh.material = material;}
            attach(createBox(engine));
            await registerScene(scene);
            ${retained === "scalar" ? "onBeforeRender(scene, () => {material.inputs.gain!.value = 3;});" : retained === "texture" ? "onBeforeRender(scene, () => {material.inputs.albedo!.texture = texture;});" : ""}
        }
        void main();
    `,
        { fileName: resolve(directory, "entry.ts"), publicDir: directory },
    );
}

test("packaged graph text preserves fetch and async boolean options while specializing local JSON writes", (t) => {
    const result = compileDocument(
        "graph.backFaceCulling = false; graph.forceAlphaBlending = true;",
    );
    assert.equal(result.manifest.nodeMaterials.length, 3);
    assert.deepEqual(
        result.manifest.nodeMaterials.map((material) => material.hasInstances),
        [true, false, false],
    );
    assert.deepEqual(
        result.manifest.nodeMaterials.map((material) =>
            material.kind === "literal" ? material.graph : undefined,
        ),
        [
            { blocks: [], backFaceCulling: true },
            { blocks: [], backFaceCulling: true },
            { blocks: [], backFaceCulling: false, forceAlphaBlending: true },
        ],
    );
    const cpp = result.cpp;
    assert.match(cpp, /fetch_packaged/);
    assert.match(cpp, /http_response_text/);
    assert.match(cpp, /json_parse/);
    assert.match(cpp, /json_stringify/);
    assert.match(cpp, /Promise<bbl::MaterialHandle>/);
    assert.match(cpp, /set_node_input_texture/);
    assert.match(cpp, /set_node_input_scalar/);
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/node-material-document-check");
    const source = resolve(directory, "check.cpp");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/c",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_HAS_UI=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        `/external:I${resolve(nativeFixtureVcpkgRoot, "include")}`,
        source,
        `/Fo${directory}/`,
    ]);
});

test("retained node-input callbacks update scalar uniforms and refuse texture rebinding", () => {
    assert.match(
        compileDocument("graph.backFaceCulling = false;", "scalar").cpp,
        /set_node_input_scalar/,
    );
    assert.throws(
        () => compileDocument("graph.backFaceCulling = false;", "texture"),
        /require setup before scene registration/,
    );
});

test("graph document specialization refuses escaped JSON edits", () => {
    assert.throws(
        () =>
            compileDocument(`
        const alias = graph;
        alias.backFaceCulling = false;
    `),
        /graph must be a static JSON literal/,
    );
});
