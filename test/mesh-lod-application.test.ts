import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { CompileError, compileSource } from "../src/compiler.js";
import { meshLoDShaderVariants } from "../src/mesh-lod-shader-variants.js";
import {
    DEFAULT_UPSTREAM_EMIT_OPTIONS,
    emitUpstreamGenerated,
} from "../src/upstream-lower.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/** A program over the MeshLoD loading surface, as the MeshLoD demo uses it. */
const MESH_LOD_PROGRAM = `
import {
    addMeshLoDToScene,
    createBox,
    createEngine,
    createMeshLoDInstance,
    createPbrMaterial,
    createSceneContext,
    disposeEngine,
    disposeMeshLoDAsset,
    loadMeshLoD,
    removeMeshLoDFromScene,
    setMeshLoDCacheBudget,
    setMeshLoDDebugView,
    setMeshLoDScreenSpaceError,
    setMeshLoDStreamingPaused,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const controller = new AbortController();
    const asset = await loadMeshLoD(engine, "https://assets.test/statue.mlod", {
        screenSpaceError: 1.5,
        maxConcurrentRequests: 2,
        selectionMode: "cpu",
        signal: controller.signal,
    });
    setMeshLoDScreenSpaceError(asset, 3);
    setMeshLoDCacheBudget(asset, 64 * 1024 * 1024);
    setMeshLoDStreamingPaused(asset, true);
    setMeshLoDDebugView(asset, "lod-depth");
    const scene = createSceneContext(engine);
    const material = createPbrMaterial({ metallicFactor: 0, roughnessFactor: 1 });
    const instance = createMeshLoDInstance(asset, material, { name: "statue" });
    instance.parent = createBox(engine);
    addMeshLoDToScene(scene, instance);
    removeMeshLoDFromScene(scene, instance);
    instance.parent = null;
    disposeMeshLoDAsset(asset);
    disposeEngine(engine);
}

void main();
`;

test("a MeshLoD program lowers its load, settings, instances and disposal onto the lowered library", async (t) => {
    const directory = resolve("artifacts/test-mesh-lod-application");
    mkdirSync(directory, { recursive: true });
    const entry = join(directory, "entry.ts");
    writeFileSync(entry, MESH_LOD_PROGRAM);
    const compiled = compileSource(MESH_LOD_PROGRAM, { fileName: entry });
    const { cpp } = compiled;
    for (const feature of [
        "loader:mesh-lod",
        "platform:meshopt",
        "engine:webgpu-device",
        "engine:frame-post-submit",
        "mesh:geometry-access",
    ])
        assert.ok(compiled.manifest.features.includes(feature), feature);
    // The library's own functions over the stored engine and the asset.
    assert.match(
        cpp,
        /bbl::load_mesh_lo_d\(bbl::StoredEngine\([^]*library_options_\d+\)/,
    );
    assert.match(cpp, /library_options_\d+\.screen_space_error = 1\.5/);
    assert.match(cpp, /library_options_\d+\.selection_mode = /);
    assert.match(cpp, /library_options_\d+\.signal = /);
    assert.match(cpp, /bbl::set_mesh_lo_d_screen_space_error\(/);
    assert.match(cpp, /bbl::set_mesh_lo_d_streaming_paused\([^;]*, true\)/);
    assert.match(cpp, /bbl::dispose_mesh_lo_d_asset\(/);
    // An instance over the program's PBR record, parented to a native mesh,
    // added to and removed from the scene's own state.
    assert.match(
        cpp,
        /bbl::create_mesh_lo_d_instance\([^;]*bbl::library::pbr_material\(bbl::StoredEngine\(/,
    );
    assert.match(cpp, /bbl::library::set_node_parent\(\*/);
    assert.match(cpp, /bbl::library::clear_node_parent\(\*/);
    assert.match(cpp, /bbl::add_mesh_lo_d_to_scene\([^;]*\.state, /);
    assert.match(cpp, /bbl::remove_mesh_lo_d_from_scene\([^;]*\.state, /);
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    // The lowered library and the program compile together.
    emitUpstreamGenerated(directory, compiled.manifest.features, {
        ...DEFAULT_UPSTREAM_EMIT_OPTIONS,
        meshLoDShaders: await meshLoDShaderVariants(
            compiled.manifest.features,
            compiled.manifest.toneMapping,
        ),
    });
    const source = join(directory, "main.cpp");
    writeFileSync(source, cpp);
    runNativeFixtureCompiler(tools, [
        "/c",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        "/DBBLITE_ENGINE_WEBGPU=1",
        "/I",
        join(directory, "upstream/include"),
        `/Fo:${join(directory, "main.obj")}`,
        source,
    ]);
});

test("MeshLoD calls without a native form refuse", () => {
    const refuses = (body: string, message: RegExp): void =>
        assert.throws(
            () =>
                compileSource(
                    MESH_LOD_PROGRAM.replace(
                        "    disposeMeshLoDAsset(asset);",
                        `${body}\n    disposeMeshLoDAsset(asset);`,
                    ).replace(
                        "    setMeshLoDStreamingPaused,",
                        "    setMeshLoDStreamingPaused,\n    getMeshLoDDiagnostics,",
                    ),
                ),
            (error: unknown) =>
                error instanceof CompileError && message.test(error.message),
        );
    refuses(
        "    await loadMeshLoD(engine, new ArrayBuffer(4));",
        /A MeshLoD source URL must select packaged \.mlod files/,
    );
});
