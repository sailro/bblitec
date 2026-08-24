/**
 * The pinned UBO writers, lowered from their own AST.
 *
 * These assertions pin the arithmetic to the pin's: a changed formula upstream
 * changes the emitted C++, and a construct the lowerer cannot carry fails here
 * rather than shipping a stale transcription.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";
import {
    lowerPinnedUboWriter,
    type UboFieldSlot,
} from "../src/lowering/pinned-ubo-writer-lowerer.js";

// One store for the whole file: the pinned sources are immutable and the
// store is a read-through cache, so each test rebuilding one only re-read
// and re-parsed the same package.
const sharedStore = new UpstreamSourceStore();

function context(): LoweringContext {
    return new LoweringContext(sharedStore);
}

/** The clearcoat variant's fields, as the composer publishes them. */
const clearcoatSlots: readonly UboFieldSlot[] = [
    { name: "ccParams", offset: 0, lanes: 4 },
    { name: "ccRefractionParams", offset: 16, lanes: 4 },
];

test("lowers the pinned clearcoat UBO writer from its own AST", () => {
    const lines = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/pbr/fragments/clearcoat-fragment.ts",
        symbolName: "writeClearcoatUBO",
        sourceLocal: "cc",
        baseField: "ccParams",
        slots: clearcoatSlots,
        propertySources: {
            indexOfRefraction: "material.clearcoat_index_of_refraction",
            intensity: "material.clearcoat_intensity",
            roughness: "material.clearcoat_roughness",
            bumpTextureScale: "material.clearcoat_bump_scale",
        },
        nestedWriters: {
            "writeCcUvTransform": () => ({
                uScale: "transform.u_scale",
                vScale: "transform.v_scale",
                uAng: "transform.u_ang",
                uOffset: "transform.u_offset",
                vOffset: "transform.v_offset",
            }),
        },
    });
    const body = lines.join("\n");
    // The pin computes `a = 1 - ior`, `b = 1 + ior`, then
    // `pow(-a / b, 2)` and `1 / ior`. None of that is written here.
    assert.match(body, /const float ior = material\.clearcoat_index_of_refraction;/);
    assert.match(body, /const float a = 1\.0f - ior;/);
    assert.match(body, /const float b = 1\.0f \+ ior;/);
    assert.match(body, /out\.ccParams\[0\] = static_cast<float>\(material\.clearcoat_intensity\)/);
    assert.match(body, /out\.ccRefractionParams\[0\] = static_cast<float>\(std::pow\(-a \/ b, 2\.0f\)\)/);
    assert.match(body, /out\.ccRefractionParams\[1\] = static_cast<float>\(1\.0f \/ ior\)/);
    assert.match(body, /out\.ccRefractionParams\[2\] = static_cast<float>\(a\)/);
    assert.match(body, /out\.ccRefractionParams\[3\] = static_cast<float>\(b\)/);
});

test("lowers the pinned iridescence UBO writer", () => {
    const lines = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/pbr/fragments/iridescence-fragment.ts",
        symbolName: "writeIridescenceUBO",
        sourceLocal: "iri",
        baseField: "iridescenceParams",
        slots: [{ name: "iridescenceParams", offset: 0, lanes: 4 }],
        propertySources: {
            intensity: "material.iridescence_intensity",
            indexOfRefraction: "material.iridescence_index_of_refraction",
            minimumThickness: "material.iridescence_minimum_thickness",
            maximumThickness: "material.iridescence_maximum_thickness",
        },
        nestedWriters: {
            "writeUvTransform": () => ({
                uScale: "transform.u_scale",
                vScale: "transform.v_scale",
                uAng: "transform.u_ang",
                uOffset: "transform.u_offset",
                vOffset: "transform.v_offset",
            }),
        },
    });
    const body = lines.join("\n");
    assert.match(body, /out\.iridescenceParams\[0\] = static_cast<float>\(material\.iridescence_intensity\)/);
    assert.match(body, /out\.iridescenceParams\[3\] = static_cast<float>\(material\.iridescence_maximum_thickness\)/);
});

test("refuses a pinned writer construct it cannot carry", () => {
    assert.throws(
        () =>
            lowerPinnedUboWriter(context(), {
                modulePath: "src/material/pbr/fragments/clearcoat-fragment.ts",
                symbolName: "writeClearcoatUBO",
                sourceLocal: "cc",
                baseField: "ccParams",
                slots: clearcoatSlots,
                // `intensity` deliberately absent: an unmapped property must
                // fail rather than emit a plausible zero.
                propertySources: {
                    indexOfRefraction: "material.clearcoat_index_of_refraction",
                },
            }),
        /has no source on our record/,
    );
});

/**
 * The alpha-test extension binds the byte offset to a local and divides at the
 * index — `data[off / 4] = …` — where every other writer binds the lane. The
 * lowerer has to carry both shapes, because the alternative is a hand-written
 * `alphaCutOff` assignment, which is the re-derivation this whole path removes.
 */
test("lowers a writer that divides at the data index", () => {
    const lines = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/pbr/fragments/alpha-test-fragment.ts",
        symbolName: "pbrExt.writeUbo",
        sourceLocal: "",
        baseField: "alphaCutOff",
        slots: [{ name: "alphaCutOff", offset: 0, lanes: 1 }],
        propertySources: { _alphaCutOff: "material.alpha_cutoff" },
    });
    const body = lines.join("\n");
    assert.match(
        body,
        /out\.alphaCutOff = static_cast<float>\(material\.alpha_cutoff\)/,
    );
});

/**
 * The emissive extension's colour, which scene 259 rendered as black because no
 * writer filled it: 57.6 MAD against 0.001 on the transcribed path. Pinned here
 * so the field cannot go unwritten again.
 */
test("lowers the pinned emissive UBO writer", () => {
    const lines = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/pbr/fragments/emissive-fragment.ts",
        symbolName: "writeEmissiveUBO",
        sourceLocal: "",
        baseField: "emissiveColor",
        slots: [{ name: "emissiveColor", offset: 0, lanes: 3 }],
        propertySources: { _emissiveColor: "material.emissive_factor" },
        vectorProperties: { _emissiveColor: 3 },
    });
    const body = lines.join("\n");
    assert.match(body, /out\.emissiveColor\[0\] = /);
    assert.match(body, /out\.emissiveColor\[1\] = /);
    assert.match(body, /out\.emissiveColor\[2\] = /);
    assert.match(body, /material\.emissive_factor/);
});

/**
 * The anisotropy writer, whose UV-transform tail sits behind an early return
 * on two offsets that only the texture-carrying variant declares. Generation
 * decides that return, so the tail is dropped rather than lowered against a
 * property our records do not carry -- and the two-lane direction reads a
 * Vec2's members, not a colour's.
 */
test("takes the pinned anisotropy writer's absent-offset early return", () => {
    const lines = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/pbr/fragments/anisotropy-fragment.ts",
        symbolName: "pbrExt.writeUbo",
        sourceLocal: "aniso",
        baseField: "anisotropyParams",
        slots: [{ name: "anisotropyParams", offset: 0, lanes: 4 }],
        propertySources: {
            intensity: "material.anisotropy_intensity",
            direction: "material.anisotropy_direction",
            texture: null,
        },
        vectorProperties: { direction: 2 },
    });
    const body = lines.join("\n");
    assert.match(body, /out\.anisotropyParams\[0\] = .*anisotropy_intensity/);
    assert.match(body, /out\.anisotropyParams\[1\] = .*\.x\)/);
    assert.match(body, /out\.anisotropyParams\[2\] = .*\.y\)/);
    // The tail the early return cuts off, and the colour members a two-lane
    // value must not borrow.
    assert.doesNotMatch(body, /anisotropyUVm|anisotropyUVt|uScale|uAng/);
    assert.doesNotMatch(body, /dir\.r|dir\.g/);
});

/** The variant that does declare the transform fields keeps the tail. */
test("keeps the anisotropy UV transform when the variant declares it", () => {
    const lines = lowerPinnedUboWriter(context(), {
        modulePath: "src/material/pbr/fragments/anisotropy-fragment.ts",
        symbolName: "pbrExt.writeUbo",
        sourceLocal: "aniso",
        baseField: "anisotropyParams",
        slots: [
            { name: "anisotropyParams", offset: 0, lanes: 4 },
            { name: "anisotropyUVm", offset: 16, lanes: 4 },
            { name: "anisotropyUVt", offset: 32, lanes: 4 },
        ],
        propertySources: {
            intensity: "material.anisotropy_intensity",
            direction: "material.anisotropy_direction",
            texture: "transform",
            uScale: "transform.u_scale",
            vScale: "transform.v_scale",
            uAng: "transform.u_ang",
            uOffset: "transform.u_offset",
            vOffset: "transform.v_offset",
        },
        vectorProperties: { direction: 2 },
    });
    const body = lines.join("\n");
    assert.match(body, /out\.anisotropyUVm\[0\] = /);
    assert.match(body, /out\.anisotropyUVt\[0\] = /);
});
