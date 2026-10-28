import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { MESH_LOD_SHADER_MODULES } from "../src/lowering/mesh-lod-library.js";
import { meshLoDShaderVariants } from "../src/mesh-lod-shader-variants.js";
import {
    DEFAULT_UPSTREAM_EMIT_OPTIONS,
    emitUpstreamGenerated,
} from "../src/upstream-lower.js";
import { pinnedModules } from "./pinned-library-fixtures.js";
import {
    compileLibraryShaders,
    runWebGpuFixture,
} from "./webgpu-subset-fixture.js";

/**
 * The lowered MeshLoD library's GPU selection and page streaming on both
 * WebGPU-subset backends (test/fixtures/webgpu-subset/mesh-lod-*.cpp): a
 * statue primitive loaded from memory refines as the pages its selection
 * demands stream in, Dawn and SDL_GPU converge on the same selection, and
 * that selection is the pin's own CPU model of it (runMeshLoDGpuSelection)
 * run on the inputs the passes read.
 */

const ASSET = resolve(
    "corpus/babylon-lite/lab/lite/src/demos/mesh-lod/harvard-yenching_institute_statue.mesh000.prim000.mlod",
);
const FRAMES = 40;

/** A program reaching the library's loading, instance and scene roots. */
const PROGRAM = `
import {
    addMeshLoDToScene,
    createEngine,
    createMeshLoDInstance,
    createPbrMaterial,
    createSceneContext,
    loadMeshLoD,
} from "@babylonjs/lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const asset = await loadMeshLoD(engine, "https://assets.test/statue.mlod");
    addMeshLoDToScene(scene, createMeshLoDInstance(asset, createPbrMaterial({}), {}));
}

void main();
`;

/** The lowered library and the generated sources it links, emitted once. */
let library: Promise<{ include: string; sources: string[] }> | undefined;
function lowerLibrary(): Promise<{ include: string; sources: string[] }> {
    library ??= (async () => {
        const directory = resolve("artifacts/test-mesh-lod-gpu/generated");
        rmSync(directory, { recursive: true, force: true });
        mkdirSync(directory, { recursive: true });
        const entry = join(directory, "entry.ts");
        writeFileSync(entry, PROGRAM);
        const { manifest } = compileSource(PROGRAM, { fileName: entry });
        emitUpstreamGenerated(directory, manifest.features, {
            ...DEFAULT_UPSTREAM_EMIT_OPTIONS,
            meshLoDShaders: await meshLoDShaderVariants(
                manifest.features,
                manifest.toneMapping,
            ),
        });
        return {
            include: join(directory, "upstream/include"),
            sources: ["frame_post_submit.cpp", "gpu_retirement.cpp"].map(
                (source) => join(directory, "upstream/src", source),
            ),
        };
    })();
    return library;
}

/** One backend's run: its frame lines and the directory holding the model's inputs. */
interface BackendRun {
    readonly lines: Map<string, string>;
    readonly dump: string;
}

async function runBackend(
    backend: "dawn" | "sdl",
    shaders?: string,
): Promise<BackendRun | undefined> {
    const { include, sources } = await lowerLibrary();
    const output = resolve("artifacts/test-mesh-lod-gpu", backend);
    const dump = join(output, "dump");
    mkdirSync(dump, { recursive: true });
    const lines = runWebGpuFixture(backend, {
        output,
        defines: [
            "/DBBLITE_WORKERS=1",
            "/DBBLITE_OFFSCREEN_SURFACES=1",
            "/DBBLITE_ENGINE_WEBGPU=1",
        ],
        includes: [include],
        sources: [
            resolve(`test/fixtures/webgpu-subset/mesh-lod-${backend}.cpp`),
            ...sources,
            resolve("native/src/pal_meshopt.cpp"),
            resolve("native/src/pal_web_platform.cpp"),
        ],
        libraries: ["meshoptimizer.lib"],
        args: [ASSET, dump],
        shaders,
        timeoutMs: 300000,
    });
    if (!lines) return undefined;
    assert.equal(lines.get(backend), "ok");
    return { lines, dump };
}

let dawn: Promise<BackendRun | undefined> | undefined;
function runDawn(): Promise<BackendRun | undefined> {
    dawn ??= runBackend("dawn");
    return dawn;
}

let sdl: Promise<BackendRun | undefined> | undefined;
function runSdl(): Promise<BackendRun | undefined> {
    const shaderTools = discoverDevelopmentTools();
    if (!shaderTools.bbliteTint || !shaderTools.dxc)
        return Promise.resolve(undefined);
    sdl ??= (async () =>
        runBackend(
            "sdl",
            await compileLibraryShaders(
                resolve("artifacts/test-mesh-lod-gpu/sdl/root"),
                MESH_LOD_SHADER_MODULES,
            ),
        ))();
    return sdl;
}

/** Each frame's selected clusters and resident pages. */
function frames(run: BackendRun): (readonly [number, number])[] {
    return Array.from({ length: FRAMES }, (_, index) => {
        const line = run.lines.get(`frame${index}`);
        assert.ok(line, `frame ${index} reports`);
        const [selected, resident] = line.split(" ").map(Number);
        return [selected!, resident!] as const;
    });
}

/** The selection refines from the pinned coarse page as demanded pages stream in, then holds. */
function assertConverges(run: BackendRun): void {
    const reported = frames(run);
    assert.deepEqual(reported[0], [1, 2]);
    const [selected, resident] = reported.at(-1)!;
    assert.ok(
        selected > 1 && resident > 2,
        `converged to ${selected}/${resident}`,
    );
    assert.deepEqual(reported.at(-2), reported.at(-1), "the selection holds");
}

test("Dawn streams and selects the lowered MeshLoD library through the WebGPU subset device", async (t) => {
    const run = await runDawn();
    if (!run) {
        t.skip("Native fixture compiler or Dawn unavailable.");
        return;
    }
    assertConverges(run);
});

test("SDL_GPU streams and selects the lowered MeshLoD library through the WebGPU subset device", async (t) => {
    const run = await runSdl();
    if (!run) {
        t.skip("Native fixture compiler or the shader tools unavailable.");
        return;
    }
    assertConverges(run);
});

test("Dawn and SDL_GPU converge on the selection the pin's model makes of the same inputs", async (t) => {
    const [onDawn, onSdl] = await Promise.all([runDawn(), runSdl()]);
    if (!onDawn || !onSdl) {
        t.skip("Both backends are required.");
        return;
    }
    assert.deepEqual(frames(onSdl).at(-1), frames(onDawn).at(-1));
    // The pin's CPU model of the passes, on the inputs Dawn's last frame read.
    const module = "src/mesh-lod/mesh-lod-selection-gpu.ts";
    const { runMeshLoDGpuSelection } = pinnedModules([module]).get(module) as {
        runMeshLoDGpuSelection(input: unknown): {
            selected: unknown[];
            overflow: boolean;
        };
    };
    const words = (name: string): Uint32Array => {
        const bytes = readFileSync(join(onDawn.dump, name));
        return new Uint32Array(
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ),
        );
    };
    const params = JSON.parse(
        readFileSync(join(onDawn.dump, "params.json"), "utf8"),
    ) as {
        cameraPos: number[];
        verticalFov: number;
        near: number;
        targetWidth: number;
        targetHeight: number;
        screenSpaceError: number;
        lodHysteresis: number;
        levelCount: number;
        wordsPerInstance: number;
        nodeCount: number;
        groupCount: number;
        clusterCount: number;
        pageCount: number;
        maxSelected: number;
    };
    const instancesU32 = words("instances");
    const model = runMeshLoDGpuSelection({
        nodes: words("nodes"),
        groups: words("groups"),
        clusters: words("clusters"),
        groupPageRefs: words("refs"),
        pageState: words("pages"),
        // Page sizes rank demanded pages only; the selection never reads them.
        pageStoredBytes: new Array<number>(params.pageCount).fill(0),
        instances: new Float32Array(instancesU32.buffer),
        instancesU32,
        priorState: words("prior"),
        instanceCount: 1,
        nodeCount: params.nodeCount,
        groupCount: params.groupCount,
        clusterCount: params.clusterCount,
        pageCount: params.pageCount,
        wordsPerInstance: params.wordsPerInstance,
        maxSelected: params.maxSelected,
        params: {
            cameraPos: params.cameraPos,
            verticalFov: params.verticalFov,
            near: params.near,
            targetWidth: params.targetWidth,
            targetHeight: params.targetHeight,
            // The fixture's frame culls by cone only.
            frustumPlanes: [],
            screenSpaceError: params.screenSpaceError,
            lodHysteresis: params.lodHysteresis,
            levelCount: params.levelCount,
        },
    });
    assert.equal(model.overflow, false);
    assert.equal(model.selected.length, frames(onDawn).at(-1)![0]);
});
