import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { specializeGltf } from "../src/asset-specializer.js";

function writeGlb(path: string, document: Record<string, unknown>): void {
    const json = Buffer.from(JSON.stringify(document));
    const paddedLength = Math.ceil(json.length / 4) * 4;
    const binaryLength = 4;
    const buffer = Buffer.alloc(12 + 8 + paddedLength + 8 + binaryLength, 0x20);
    buffer.writeUInt32LE(0x46546c67, 0);
    buffer.writeUInt32LE(2, 4);
    buffer.writeUInt32LE(buffer.length, 8);
    buffer.writeUInt32LE(paddedLength, 12);
    buffer.writeUInt32LE(0x4e4f534a, 16);
    json.copy(buffer, 20);
    const binaryHeader = 20 + paddedLength;
    buffer.writeUInt32LE(binaryLength, binaryHeader);
    buffer.writeUInt32LE(0x004e4942, binaryHeader + 4);
    writeFileSync(path, buffer);
}

test("specializes glTF dynamic feature imports without any-typed JSON", () => {
    const directory = mkdtempSync(join(tmpdir(), "bblitec-gltf-"));
    try {
        const path = join(directory, "asset.glb");
        writeGlb(path, {
            extensionsUsed: ["KHR_texture_transform"],
            animations: [{}],
            accessors: [{ sparse: {} }, { count: 384 }],
            materials: [{ name: "Glass", alphaMode: "BLEND", doubleSided: true }],
            meshes: [
                { name: "Lines", primitives: [{ mode: 1, targets: [{}], material: 0 }] },
                { name: "Mesh", primitives: [{ attributes: { POSITION: 1 }, material: 0 }] },
            ],
            nodes: [
                { name: "LineNode", mesh: 0 },
                { name: "Node", mesh: 1 },
            ],
            skins: [{}],
        });
        const specialization = specializeGltf(path, "asset.glb");
        assert.deepEqual(specialization.extensionsUsed, ["KHR_texture_transform"]);
        assert.ok(specialization.staticModules.includes("./gltf-ext-uv-transform.js"));
        assert.ok(specialization.staticModules.includes("./gltf-feature-animations.js"));
        assert.ok(specialization.staticModules.includes("./gltf-feature-morph.js"));
        assert.ok(specialization.staticModules.includes("./gltf-feature-skeleton.js"));
        assert.ok(specialization.staticModules.includes("./gltf-feature-sparse.js"));
        assert.ok(specialization.staticModules.includes("./gltf-feature-primitive.js"));
        assert.deepEqual(specialization.renderItems, [
            {
                drawId: 1,
                nodeIndex: 0,
                nodeName: "LineNode",
                meshIndex: 0,
                meshName: "Lines",
                primitiveIndex: 0,
                triangleCount: 0,
                trianglesPerCluster: 128,
                clusterIdStart: 0,
                clusterCount: 0,
                materialIndex: 0,
                materialName: "Glass",
                alphaMode: "BLEND",
                doubleSided: true,
            },
            {
                drawId: 2,
                nodeIndex: 1,
                nodeName: "Node",
                meshIndex: 1,
                meshName: "Mesh",
                primitiveIndex: 0,
                triangleCount: 128,
                trianglesPerCluster: 128,
                clusterIdStart: 1,
                clusterCount: 1,
                materialIndex: 0,
                materialName: "Glass",
                alphaMode: "BLEND",
                doubleSided: true,
            },
        ]);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
