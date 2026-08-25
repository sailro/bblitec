/**
 * The Standard material family's UBO mirror and its pinned writers.
 *
 * `writeStdMaterialData` keys on literal float lanes into the renderable's
 * `F32(24)` scratch, and the template inlines the `matUniforms` struct those
 * lanes fill — there is no `_offsets` map on this family. The emitter derives
 * the layout from the composed fragment's own struct text, cross-checks it
 * against the pin's allocation, and lowers both writers from their pinned
 * ASTs; these tests assert all three legs against the real pin.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import { lowerPinnedUboWriter } from "../src/lowering/pinned-ubo-writer-lowerer.js";
import { pinnedStandardVariantsHeader } from "../src/pinned-pbr-variant-cpp.js";
import {
    composePinnedStandardVariant,
    pinnedStandardVariantManifestEntry,
} from "../src/pinned-standard-variants.js";

// One store for the whole file: the pinned sources are immutable and the
// store is a read-through cache, so each test rebuilding one only re-read
// and re-parsed the same package.
const sharedStore = new UpstreamSourceStore();

function context(): LoweringContext {
    return new LoweringContext(sharedStore);
}

test("lowers writeStdMaterialData from its own AST", () => {
    const body = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/standard/standard-pipeline.ts",
        symbolName: "writeStdMaterialData",
        sourceLocal: "mat",
        baseField: "dc",
        propertySources: {
            diffuseColor: "material.diffuse_color",
            specularColor: "material.specular_color",
            emissiveColor: "material.emissive_color",
            ambientColor: "material.ambient_color",
            alpha: "material.alpha",
            specularPower: "material.specular_power",
            bumpLevel: "material.bump_level",
            ambientTexLevel: "material.ambient_tex_level",
            lightmapLevel: "material.lightmap_level",
            opacityLevel: "material.opacity_level",
            alphaCutOff: "material.alpha_cutoff",
            reflectionLevel: "material.reflection_level",
            reflectionCoordMode: "material.reflection_coord_mode",
            textureLevel: "texture_level",
        },
        vectorProperties: {
            diffuseColor: 3,
            specularColor: 3,
            emissiveColor: 3,
            ambientColor: 3,
        },
        // The template's own matUniforms layout: vec4, vec4, vec3+f32,
        // vec3+f32, then eight scalars ending in two pad lanes.
        slots: [
            { name: "dc", offset: 0, lanes: 4 },
            { name: "sc", offset: 16, lanes: 4 },
            { name: "ec", offset: 32, lanes: 3 },
            { name: "bs", offset: 44, lanes: 1 },
            { name: "ac", offset: 48, lanes: 3 },
            { name: "tl", offset: 60, lanes: 1 },
            { name: "ambTexLvl", offset: 64, lanes: 1 },
            { name: "lmLvl", offset: 68, lanes: 1 },
            { name: "opLvl", offset: 72, lanes: 1 },
            { name: "aCut", offset: 76, lanes: 1 },
            { name: "rLvl", offset: 80, lanes: 1 },
            { name: "rCm", offset: 84, lanes: 1 },
            { name: "_0", offset: 88, lanes: 1 },
            { name: "_1", offset: 92, lanes: 1 },
        ],
    }).join("\n");
    // The pin destructures the four colours; each lowers to an alias of the
    // record's own colour and lane reads become members.
    assert.match(body, /const auto& dc = material\.diffuse_color;/);
    assert.match(body, /out\.dc\[0\] = static_cast<float>\(dc\.r\);/);
    assert.match(body, /out\.dc\[2\] = static_cast<float>\(dc\.b\);/);
    assert.match(body, /out\.dc\[3\] = static_cast<float>\(material\.alpha\);/);
    assert.match(body, /out\.sc\[3\] = static_cast<float>\(material\.specular_power\);/);
    // `1.0 / mat.bumpLevel` — the arithmetic is the pin's, not restated.
    assert.match(body, /out\.bs = static_cast<float>\(1\.0f \/ material\.bump_level\);/);
    // `textureLevel` is the writer's own parameter, resolved like a capture.
    assert.match(body, /out\.tl = static_cast<float>\(texture_level\);/);
    assert.match(body, /out\.rCm = static_cast<float>\(material\.reflection_coord_mode\);/);
    // The pad lanes are never written.
    assert.ok(!body.includes("out._0"));
    assert.ok(!body.includes("out._1"));
});

test("lowers writeStandardUvTransformData with the uninstalled resolver folded", () => {
    const body = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/standard/standard-pipeline.ts",
        symbolName: "writeStandardUvTransformData",
        sourceLocal: "material",
        baseField: "u",
        propertySources: {
            invertY: "invert_y",
            uvScale: "material.uv_scale",
        },
        vectorProperties: { uvScale: 2 },
        laneSources: {
            uvScale: {
                0: "material.uv_scale[0]",
                1: "material.uv_scale[1]",
            },
        },
        absentHooks: ["_uvOffsetResolver"],
        slots: [{ name: "u", offset: 0, lanes: 4 }],
    }).join("\n");
    // The scale lanes come off the record.
    assert.match(body, /const float scaleX = material\.uv_scale\[0\];/);
    // `let scaleY` is reassigned under the invert arm, so it is mutable.
    assert.match(body, /(^|\n)\s*float scaleY = material\.uv_scale\[1\];/);
    // `_uvOffsetResolver?.(material) ?? null` is the pin's uninstalled
    // state, so `offset?.[n] ?? 0` folds to the pin's own zero.
    assert.match(body, /const float offsetX = 0\.0f;/);
    assert.match(body, /(^|\n)\s*float offsetY = 0\.0f;/);
    // The invert arm is a real runtime branch on the caller's flag, with the
    // pin's own flip arithmetic.
    assert.match(body, /if \(invert_y\) \{/);
    assert.match(body, /offsetY \+= scaleY;/);
    assert.match(body, /scaleY = -scaleY;/);
    assert.match(body, /out\.u\[0\] = static_cast<float>\(scaleX\);/);
    assert.match(body, /out\.u\[1\] = static_cast<float>\(scaleY\);/);
    assert.match(body, /out\.u\[2\] = static_cast<float>\(offsetX\);/);
    assert.match(body, /out\.u\[3\] = static_cast<float>\(offsetY\);/);
});

test("emits the Standard header with the pin's own offsets", async () => {
    const variant = await composePinnedStandardVariant(
        { diffuseTexture: {}, bumpTexture: {} },
        { fog: true },
    );
    const header = pinnedStandardVariantsHeader(
        context(),
        "test provenance",
        [pinnedStandardVariantManifestEntry(variant)],
    );
    // The mirror totals the renderable's own F32(24) scratch: 96 bytes.
    assert.match(
        header,
        /sizeof\(StandardMaterialUniforms\) == 96/,
    );
    assert.match(header, /standard_material_ubo_bytes = 96;/);
    // Each field sits where the WGSL layout puts it — the same lanes
    // writeStdMaterialData writes (dc 0, sc 16, ec 32, bs 44, ac 48, tl 60,
    // then the scalars through rCm at 84).
    for (
        const [field, offset] of [
            ["dc", 0],
            ["sc", 16],
            ["ec", 32],
            ["bs", 44],
            ["ac", 48],
            ["tl", 60],
            ["ambTexLvl", 64],
            ["lmLvl", 68],
            ["opLvl", 72],
            ["aCut", 76],
            ["rLvl", 80],
            ["rCm", 84],
        ] as const
    ) {
        assert.ok(
            header.includes(
                `offsetof(StandardMaterialUniforms, ${field}) == ${offset}`,
            ),
            `expected ${field} at ${offset}`,
        );
    }
    // Both writers are lowered into the header, with the pin's defaults on
    // the props mirror (createStandardMaterial's own values).
    assert.match(header, /inline void write_standard_material\(/);
    assert.match(header, /inline void write_standard_uv_transform\(/);
    assert.match(
        header,
        /\[\[maybe_unused\]\] const StandardMaterialProps& material/,
    );
    assert.match(header, /float specular_power = 64\.0f;/);
    assert.match(header, /float lightmap_level = 1\.0f;/);
    assert.match(header, /float reflection_coord_mode = 1\.0f;/);
    assert.match(header, /Color3 diffuse_color\{1\.0f, 1\.0f, 1\.0f\};/);
    assert.match(header, /float alpha_cutoff = 0\.0f;/);
    // The variant table row names the composed stages, and the group-1
    // reading found the diffuse pair plus the vertex-stage up block.
    assert.match(header, /"normal-map\|std-fog"/);
    assert.match(
        header,
        /\{\d+, "dT", StandardBindingKind::texture2d, false, true\},/,
    );
    assert.match(
        header,
        /\{\d+, "dS", StandardBindingKind::sampler, false, true\},/,
    );
    assert.match(
        header,
        /\{\d+, "up", StandardBindingKind::uniformBuffer, true, false\},/,
    );
    // Attributes are the pin's own, densely numbered per variant.
    assert.match(
        header,
        /\{0, "position", "vec3<f32>"\},/,
    );
    assert.match(header, /\{2, "uv", "vec2<f32>"\},/);
});

test("the header emitter is deterministic", async () => {
    const variant = await composePinnedStandardVariant(
        { diffuseTexture: {} },
    );
    const entries = [pinnedStandardVariantManifestEntry(variant)];
    const first = pinnedStandardVariantsHeader(
        context(),
        "test provenance",
        entries,
    );
    const second = pinnedStandardVariantsHeader(
        context(),
        "test provenance",
        entries,
    );
    assert.equal(second, first);
});
