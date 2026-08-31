// Scene 66 is the corpus boundary that combines a source-owned gzip/base64
// NME document, a static scan that extracts its texture records, computed
// texture-map keys, morph data, and a PCF no-color view of the same node
// graph. Keep the source exact here: a smaller synthetic fixture would not
// prove those values survive the imported helper boundary together.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import { composeNodeMaterial } from "../src/pinned-node-material.js";

const scene66 = resolve(
    "corpus/babylon-lite/lab/lite/src/lite/scene66.ts",
);

test("compiles the exact Scene 66 compressed NME and its PCF caster", async () => {
    const result = compileSource(readFileSync(scene66, "utf8"), {
        fileName: scene66,
    });
    assert.equal(result.manifest.assets.length, 8);
    assert.deepEqual(
        result.manifest.nodeMaterials.map((material) => material.textureNames),
        [[
            "Reflection_map",
            "Normal_map",
            "Specular_map",
            "Emissive_map",
            "Diffuse_map",
            "Ambient_map",
            "Light_map",
            "Opacity_map",
        ]],
    );
    assert.ok(result.manifest.features.includes("mesh:morph-targets"));
    assert.ok(result.manifest.features.includes("shadow:pcf-directional"));
    const fileLoads = [
        ...result.cpp.matchAll(
            /load_file_texture\([^;\n]*?, (true|false), false, false\)/g,
        ),
    ];
    assert.equal(fileLoads.length, 8);
    const expectedInvertY = [
            "true",
            "false",
            "false",
            "false",
            "false",
            "false",
            "false",
            "false",
        ];
    assert.deepEqual(
        fileLoads.map((load) => load[1]),
        expectedInvertY,
    );

    const material = result.manifest.nodeMaterials[0]!;
    assert.equal(material.kind, "literal");
    if (material.kind !== "literal") return;
    assert.equal(
        Array.isArray(material.graph.blocks)
            ? material.graph.blocks.length
            : 0,
        136,
    );

    const composed = await composeNodeMaterial(
        material.graph,
        "scene66-focused",
        {
            shadowLights: [{ lightIndex: 0, shadowType: "pcf" }],
            blockEmitters: material.blockEmitters,
            castsPcfShadow: true,
        },
    );
    assert.equal(composed.caster?.kind, "pcf");
    assert.match(composed.caster?.wgsl ?? "", /@vertex\s+fn vs_main/);
    assert.match(
        composed.caster?.wgsl ?? "",
        /@fragment\s+fn fs_main\(.*\)\s*\{/,
    );
});
