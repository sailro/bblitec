import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { SplatLowerer } from "../src/lowering/splat-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const meshModule = "src/mesh/GaussianSplatting/gaussian-splatting-mesh.ts";
class EditedStore extends UpstreamSourceStore {
    constructor(private readonly edit: (text: string) => string) { super(); }
    override getSourceFile(path: string): ts.SourceFile {
        const file = super.getSourceFile(path);
        return path === meshModule
            ? ts.createSourceFile(file.fileName, this.edit(file.text), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
            : file;
    }
}

test("splat CPU lifecycle anchors the whole handoff and preserves source refusal", () => {
    for (const edit of [
        (s: string) => s.replace("const newGeom = buildSplatGeometry(newBuffer);", "return; const newGeom = buildSplatGeometry(newBuffer);"),
        (s: string) => s.replace("mesh._sortDepthTransform.fill(0);", "mesh._sortDepthTransform.fill(1);"),
        (s: string) => s.replace("retainedSplatsData = newBuffer;", "retainedSplatsData = newBuffer.slice(0);"),
        (s: string) => s.replace("newGeom.centersRGBA);", "newGeom.colorsRGBA);"),
    ]) {
        const context = new LoweringContext(new EditedStore(edit));
        assert.throws(() => new SplatLowerer(context).lowerLoader({ retainRows: true, containers: new Map() }), /updateData/);
    }
    const lowerer = new SplatLowerer(new LoweringContext());
    assert.doesNotMatch(lowerer.lowerLoader({ retainRows: false, containers: new Map() }).source, /void update_splat_data/);
    const changed = new SplatLowerer(new LoweringContext(new EditedStore((s) => s.replace("GS vertex count mismatch", "changed pinned message"))))
        .lowerLoader({ retainRows: true, containers: new Map() });
    assert.match(changed.source, /throw std::runtime_error\("changed pinned message"\)/);
    assert.throws(() => compileSource(`import {createEngine,createSceneContext,loadSplat} from "@babylonjs/lite";
        async function main(){const engine=await createEngine({});const scene=createSceneContext(engine);
        const cloud=await loadSplat(scene,"https://example.com/cloud.splat");
        const bytes=new Uint8Array(64);cloud.updateData(bytes.buffer);}`), /Unsupported|not supported/);
});

interface Geometry {
    vertexCount: number; textureWidth: number; textureHeight: number;
    boundMin: number[]; boundMax: number[]; positions: Float32Array;
    centersRGBA: Float32Array; covARGBA: Float32Array; covBRGBA: Float32Array; colorsRGBA: Float32Array;
}
interface Cloud {
    splatsData: ArrayBuffer;
    boundMin: number[]; boundMax: number[];
    position: { x: number; y: number; z: number };
    scaling: { x: number; y: number; z: number };
    _sortDepthTransform: Float32Array;
    updateData(buffer: ArrayBuffer): void;
}

/** Only GPU allocation/upload and worker transport are seams. The actual pin
 * builds, updates and bakes the cloud, including source-buffer ownership. */
async function pinnedLifecycle(output: string): Promise<void> {
    const { buildSplatGeometry } = await importPinnedModule<{ buildSplatGeometry(buffer: ArrayBuffer): Geometry }>("loader-splat/splat-data.js");
    const { createGaussianSplattingMesh } = await importPinnedModule<{
        createGaussianSplattingMesh(engine: unknown, name: string, geometry: Geometry, worker: unknown, parsed: { data: ArrayBuffer }): Cloud;
    }>("mesh/GaussianSplatting/gaussian-splatting-mesh.js");
    const { bakeCurrentTransformIntoVertices } = await importPinnedModule<{ bakeCurrentTransformIntoVertices(mesh: Cloud): void }>("mesh/GaussianSplatting/gaussian-splatting-bake.js");
    const textures: Float32Array[] = [];
    const events: string[] = [];
    let positions = new Float32Array();
    const queue = {
        writeBuffer() {},
        writeTexture(destination: { texture: { index: number } }, bytes: ArrayBuffer) {
            events.push(`texture${destination.texture.index}`);
            textures[destination.texture.index] = new Float32Array(bytes.slice(0));
        },
    };
    const engine = { _device: {
        queue,
        createTexture() { const index = textures.length; textures.push(new Float32Array()); return { index, createView: () => ({}) }; },
        createSampler: () => ({}),
        createBuffer({ size }: { size: number }) { const bytes = new ArrayBuffer(size); return { getMappedRange: () => bytes, unmap() {} }; },
    } };
    const worker = { postMessage(message: { p: Float32Array }) { events.push("positions"); positions = message.p.slice(); } };
    const original = new ArrayBuffer(64);
    const floats = new Float32Array(original);
    floats.set([1, 2, 3, 1, 2, 0.5], 0);
    floats.set([-4, 5, -6, 0.25, 0.75, 1.25], 8);
    const bytes = new Uint8Array(original);
    bytes.set([10, 80, 160, 220, 255, 128, 128, 128], 24);
    bytes.set([250, 120, 30, 180, 128, 255, 128, 128], 56);
    writeFileSync(join(output, "initial.bin"), bytes);
    const geometry = buildSplatGeometry(original);
    const cloud = createGaussianSplattingMesh(engine, "cloud", geometry, worker, { data: original });
    const capture = (name: string) => {
        const chunks = [new Uint32Array([geometry.vertexCount, geometry.textureWidth, geometry.textureHeight]),
            new Float32Array([...cloud.boundMin, ...cloud.boundMax]), positions, ...textures];
        writeFileSync(join(output, `${name}.bin`), Buffer.concat(chunks.map((v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength))));
    };
    capture("stage0");
    assert.equal(cloud.splatsData, original);
    const oldPayload = textures.map((t) => t.slice());
    floats[1]! -= 2;
    writeFileSync(join(output, "mutated.bin"), bytes);
    assert.deepEqual(textures, oldPayload, "a buffer write is not an updateData upload");
    const update = (buffer: ArrayBuffer) => {
        events.length = 0;
        cloud._sortDepthTransform.fill(1);
        cloud.updateData(buffer);
        assert.deepEqual(events, ["texture0", "texture1", "texture2", "texture3", "positions"]);
        assert.deepEqual([...cloud._sortDepthTransform], [0, 0, 0, 0]);
        assert.equal(cloud.splatsData, buffer);
        assert.equal(textures.length, 4, "updates retain texture objects");
    };
    update(original);
    capture("stage1");
    const replacement = original.slice(0);
    new Float32Array(replacement)[8] = 7;
    writeFileSync(join(output, "replacement.bin"), new Uint8Array(replacement));
    update(replacement);
    capture("stage2");
    assert.equal(new Float32Array(original)[8], -4, "replacement preserves old aliases");
    for (const [length, message] of [[96, "GS vertex count mismatch"], [0, "splat buffer is empty"], [65, "multiple of 4"]] as const) {
        events.length = 0;
        assert.throws(() => cloud.updateData(new ArrayBuffer(length)), new RegExp(message));
        assert.equal(cloud.splatsData, replacement);
        assert.deepEqual(events, [], "rejection precedes uploads and worker messages");
    }
    const trailing = new Uint8Array(68);
    trailing.set(new Uint8Array(replacement));
    update(trailing.buffer);
    capture("stage3");
    const beforeBake = cloud.splatsData;
    const beforeBytes = beforeBake.slice(0);
    cloud.position.x = 3; cloud.position.y = 4; cloud.position.z = 5;
    cloud.scaling.x = cloud.scaling.y = cloud.scaling.z = 2;
    bakeCurrentTransformIntoVertices(cloud);
    capture("stage4");
    assert.notEqual(cloud.splatsData, beforeBake);
    assert.deepEqual(beforeBake, beforeBytes);
    writeFileSync(join(output, "baked.bin"), new Uint8Array(cloud.splatsData));
}

test("the pinned splat lifecycle preserves aliases and rejection order", async () => {
    const output = resolve("artifacts/splat-data-pin-check");
    mkdirSync(output, { recursive: true });
    await pinnedLifecycle(output);
});

const nativeTools = optionalNativeFixtureTools(false);
test("native splat CPU updates and bake match the pin across shared and replaced buffers", { skip: !nativeTools }, async () => {
    const output = resolve("artifacts/splat-data-native-check");
    const headers = join(output, "bblite/upstream");
    mkdirSync(headers, { recursive: true });
    await pinnedLifecycle(output);
    const lowerer = new SplatLowerer(new LoweringContext());
    for (const [name, lowered] of [
        ["splat_geometry", lowerer.lowerGeometry()], ["splat_sort", lowerer.lowerSort()],
        ["splat_loader", lowerer.lowerLoader({ retainRows: true, containers: new Map() })],
        ["splat_bake", lowerer.lowerBake()],
    ] as const) {
        if (lowered.header) writeFileSync(join(headers, `${name}.hpp`), lowered.header);
        writeFileSync(join(output, `${name}.cpp`), lowered.source);
    }
    const source = join(output, "check.cpp");
    writeFileSync(source, readFileSync("test/fixtures/splat-data-check.cpp"));
    const executable = join(output, "check.exe");
    runNativeFixtureCompiler(nativeTools!, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/MD", "/O2", "/Gy",
        "/I", "native/include", "/I", output, `/Fo:${output}\\`, `/Fe:${executable}`,
        source, ...["geometry", "sort", "loader", "bake"].map((name) => join(output, `splat_${name}.cpp`)), "/link", "/OPT:REF"]);
    assert.match(execFileSync(executable, [output], { encoding: "utf8" }), /splat-data-check: ok/);
});
