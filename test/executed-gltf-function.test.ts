import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { parseDataUrl } from "../src/data-url.js";
import {
    GenerationBlob,
    generationBlobBytes,
} from "../src/compiler/generation-blob.js";

const directory = resolve("artifacts/executed-gltf-function");

/** A program loading what `producer` (the body of `makeDocument`) builds. */
function compileProducer(producer: string): ReturnType<typeof compileSource> {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        join(directory, "producer.ts"),
        `import { loadGltf, createBox } from "@babylonjs/lite";
import type { EngineContext } from "@babylonjs/lite";
${producer}`,
    );
    return compileSource(
        `
        import { addToScene, createArcRotateCamera, createEngine, createSceneContext, registerScene, startEngine } from "@babylonjs/lite";
        import { makeDocument } from "./producer.js";
        const engine = await createEngine({});
        const scene = createSceneContext(engine);
        scene.camera = createArcRotateCamera(0, 1, 4, { x: 0, y: 0, z: 0 });
        addToScene(scene, await makeDocument(engine));
        await registerScene(scene);
        await startEngine(engine);
    `,
        { fileName: join(directory, "entry.ts") },
    );
}

const TRIANGLE = `
export async function makeDocument(engine: EngineContext) {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const bytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
    let encoded = "";
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    const gltf = {
        asset: { version: "2.0" },
        buffers: [{ byteLength: bytes.length, uri: "data:application/octet-stream;base64," + btoa(encoded) }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        nodes: [{ mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
    };
    return loadGltf(engine, new Blob([JSON.stringify(gltf)], { type: "MODEL/gltf+json" }));
}`;

test("a function loading a glTF it builds in code loads that document, packaged", () => {
    const result = compileProducer(TRIANGLE);
    const [asset, ...others] = result.manifest.assets.filter(
        (candidate) => candidate.kind === "gltf",
    );
    assert.ok(asset);
    assert.equal(others.length, 0);
    assert.ok(
        result.cpp.includes(
            `load_gltf(v_engine, bbl::asset_path("${asset.output}"))`,
        ),
    );
    const payload = parseDataUrl(result.assetPayloads.get(asset.source)!)!;
    assert.equal(payload.mediaType, "model/gltf+json");
    const document = JSON.parse(
        Buffer.from(payload.bytes).toString("utf8"),
    ) as {
        buffers: { uri: string }[];
    };
    const buffer = parseDataUrl(document.buffers[0]!.uri)!;
    assert.deepEqual(
        [...new Float32Array(new Uint8Array(buffer.bytes).buffer)],
        [0, 0, 0, 1, 0, 0, 0, 1, 0],
    );
    // The producer's body runs at generation only.
    assert.doesNotMatch(result.cpp, /fromCharCode|string_to_base64/);
});

test("a glTF producer's engine exists only as its loadGltf argument", () => {
    assert.throws(
        () =>
            compileProducer(
                TRIANGLE.replace(
                    "const positions",
                    "const used = engine;\n    const positions",
                ),
            ),
        /'makeDocument' builds its glTF at generation, where its engine exists only as loadGltf's argument/,
    );
});

test("a glTF producer runs no other pinned API", () => {
    assert.throws(
        () =>
            compileProducer(
                TRIANGLE.replace(
                    "const positions",
                    "createBox;\n    const positions",
                ),
            ),
        /'makeDocument' builds its glTF at generation, which runs no pinned API but its one loadGltf/,
    );
});

test("a glTF built at generation has no base URL for an external buffer", () => {
    assert.throws(
        () =>
            compileProducer(
                TRIANGLE.replace(
                    '"data:application/octet-stream;base64," + btoa(encoded)',
                    '"triangle.bin"',
                ),
            ),
        /no base URL to resolve 'triangle\.bin'/,
    );
});

test("a generation Blob copies its parts and normalizes its type as the File API does", () => {
    const view = new Uint16Array([0x4241, 0x4443]);
    const inner = new GenerationBlob(["é"]);
    const blob = new GenerationBlob(
        [view.subarray(1), new Uint8Array([0x45]).buffer, inner, "\ud800"],
        { type: "Text/PLAIN" },
    );
    view[1] = 0;
    assert.equal(blob.size, 2 + 1 + 2 + 3);
    assert.equal(blob.type, "text/plain");
    assert.deepEqual(
        [...generationBlobBytes(blob)!.bytes],
        [0x43, 0x44, 0x45, 0xc3, 0xa9, 0xef, 0xbf, 0xbd],
    );
    assert.equal(new GenerationBlob([], { type: "aé" }).type, "");
    assert.throws(
        () => new GenerationBlob(["x"], { endings: "native" }),
        /line endings depend on the host/,
    );
    assert.throws(() => blob.arrayBuffer(), /not carried at generation/);
});
