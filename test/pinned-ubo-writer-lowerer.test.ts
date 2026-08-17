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

function context(): LoweringContext {
    return new LoweringContext(new UpstreamSourceStore());
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
            "writeCcUvTransform": {
                uScale: "transform.u_scale",
                vScale: "transform.v_scale",
                uAng: "transform.u_ang",
                uOffset: "transform.u_offset",
                vOffset: "transform.v_offset",
            },
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
            "writeUvTransform": {
                uScale: "transform.u_scale",
                vScale: "transform.v_scale",
                uAng: "transform.u_ang",
                uOffset: "transform.u_offset",
                vOffset: "transform.v_offset",
            },
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
