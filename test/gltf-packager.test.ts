import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packageGltf } from "../src/gltf-packager.js";
import { buildGlb, readGlbFixture } from "./glb-fixture.js";

test("packages external glTF buffers and images into a GLB", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-package-"));
    try {
        mkdirSync(join(directory, "textures"));
        writeFileSync(join(directory, "mesh.bin"), Buffer.from([1, 2, 3, 4]));
        writeFileSync(join(directory, "textures", "color.png"), Buffer.from([5, 6, 7]));
        writeFileSync(
            join(directory, "scene.gltf"),
            JSON.stringify({
                asset: { version: "2.0" },
                buffers: [{ uri: "mesh.bin", byteLength: 4 }],
                bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
                images: [{ uri: "textures/color.png" }],
                textures: [{ source: 0 }],
                materials: [{ normalTexture: { index: 0, scale: 0.35 } }],
            }),
        );
        const glb = Buffer.from(await packageGltf("scene.gltf", directory));
        assert.equal(glb.readUInt32LE(0), 0x46546c67);
        const jsonLength = glb.readUInt32LE(12);
        const document = JSON.parse(
            glb.subarray(20, 20 + jsonLength).toString("utf8").trim(),
        ) as {
            buffers: Array<{ byteLength: number }>;
            bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number }>;
            images: Array<{ bufferView: number; mimeType: string; uri?: string }>;
            materials: Array<{
                normalTexture: { index: number; scale: number };
            }>;
        };
        assert.equal(document.buffers.length, 1);
        assert.equal(document.bufferViews.length, 2);
        assert.deepEqual(document.images, [{ bufferView: 1, mimeType: "image/png" }]);
        assert.equal(document.images[0]?.uri, undefined);
        assert.deepEqual(document.materials[0]?.normalTexture, {
            index: 0,
            scale: 0.35,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test("embeds an external image referenced by a GLB beside that GLB", async () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-glb-package-"));
    try {
        mkdirSync(join(directory, "models", "Textures"), { recursive: true });
        writeFileSync(
            join(directory, "models", "scene.glb"),
            buildGlb(
                {
                    asset: { version: "2.0" },
                    buffers: [{ byteLength: 4 }],
                    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
                    images: [{ uri: "Textures/color.png", name: "color" }],
                    textures: [{ source: 0 }],
                },
                Buffer.from([1, 2, 3, 4]),
            ),
        );
        writeFileSync(
            join(directory, "models", "Textures", "color.png"),
            Buffer.from([5, 6, 7]),
        );

        const packaged = readGlbFixture(
            await packageGltf("models/scene.glb", directory),
        );
        assert.deepEqual(packaged.document.bufferViews, [
            { buffer: 0, byteOffset: 0, byteLength: 4 },
            { buffer: 0, byteOffset: 4, byteLength: 3 },
        ]);
        assert.deepEqual(packaged.document.images, [
            { name: "color", bufferView: 1, mimeType: "image/png" },
        ]);
        assert.deepEqual([...packaged.binary.subarray(0, 7)], [1, 2, 3, 4, 5, 6, 7]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
