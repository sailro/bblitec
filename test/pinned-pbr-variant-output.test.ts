import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GeneratedTree } from "../src/generated-tree.js";
import type { PinnedRenderableVariant } from "../src/pinned-material-arms.js";
import { writePinnedPbrVariants } from "../src/pinned-pbr-variant-output.js";

function variant(
    materialIndex: number,
    vertexWgsl: string,
    fragmentWgsl: string,
): PinnedRenderableVariant {
    return {
        materialIndex,
        materialName: `material-${materialIndex}`,
        meshFeatures: materialIndex,
        lightMode: 2,
        singleLightType: "",
        toneMapping: true,
        armLabel: `arm-${materialIndex}`,
        fragmentKey: `key-${materialIndex}`,
        vertexWgsl,
        fragmentWgsl,
        materialUboSpec: { _totalBytes: 16 },
    };
}

test("writes independently reachable shader stages exactly once", () => {
    const root = mkdtempSync(join(tmpdir(), "bblite-pbr-stages-"));
    try {
        const tree = new GeneratedTree(root);
        const sharedVertex = "@vertex fn mainVertex() {}";
        const manifest = writePinnedPbrVariants(tree, [
            variant(0, sharedVertex, "@fragment fn mainFragment() { var a = 1; }"),
            variant(1, sharedVertex, "@fragment fn mainFragment() { var a = 2; }"),
        ]);

        assert.equal(manifest.length, 2);
        assert.equal(manifest[0]!.vertex, manifest[1]!.vertex);
        assert.notEqual(manifest[0]!.fragment, manifest[1]!.fragment);
        assert.notEqual(manifest[0]!.pipeline, manifest[1]!.pipeline);

        const files = readdirSync(join(root, "upstream", "pbr-variants"));
        assert.equal(files.filter((file) => file.endsWith(".vert.wgsl")).length, 1);
        assert.equal(files.filter((file) => file.endsWith(".frag.wgsl")).length, 2);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
