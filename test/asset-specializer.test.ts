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
            accessors: [{ sparse: {} }],
            meshes: [{ primitives: [{ mode: 1, targets: [{}] }] }],
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
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
