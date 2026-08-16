import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    composePinnedPbrVariant,
    registeredPbrExtensionIds,
} from "../src/pinned-pbr-variants.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

/** Whitespace is not shader identity; the composer and the capture differ in it. */
const normalize = (source: string): string =>
    source.replace(/\s+/g, " ").trim();

test("registers every PBR extension the pin owns", async () => {
    assert.deepEqual(await registeredPbrExtensionIds(), [
        "anisotropy",
        "clearcoat",
        "ibl",
        "iridescence",
        "reflectance",
        "sheen",
    ]);
});

test("derives a material's feature bits through the pin's own detect hooks", async () => {
    const { PBR_HAS_CLEARCOAT, PBR_HAS_OCCLUSION } = await importPinnedModule<{
        PBR_HAS_CLEARCOAT: number;
        PBR_HAS_OCCLUSION: number;
    }>("material/pbr/pbr-flag-bits.js");

    const plain = await composePinnedPbrVariant({});
    assert.equal(plain.features & PBR_HAS_CLEARCOAT, 0);

    // Nothing here names a clearcoat bit: the material carries `_clearCoat`
    // and the registered extension's own `detect` contributes the bit.
    const coated = await composePinnedPbrVariant({
        _clearCoat: { isEnabled: true, intensity: 1 },
    });
    assert.equal(coated.features & PBR_HAS_CLEARCOAT, PBR_HAS_CLEARCOAT);
    assert.equal(coated.features & PBR_HAS_OCCLUSION, PBR_HAS_OCCLUSION);
});

test("composes Scene 19's fragment exactly as the browser compiled it", async () => {
    // The instrumented capture is the browser's own composed module for
    // Scene 19's sphere, checked byte-for-byte against the committed golden
    // when it was taken. Reproducing it from a material record is what says
    // the composer is being driven correctly rather than plausibly.
    const capture = resolve(
        "artifacts",
        "capture",
        "scene19",
        "shaders",
        "02-module-2.wgsl",
    );
    let captured: string;
    try {
        captured = readFileSync(capture, "utf8");
    } catch {
        // Captures are disposable artifacts; skip rather than fail a clean tree.
        return;
    }

    const { PBR_HAS_ENV } = await importPinnedModule<{ PBR_HAS_ENV: number }>(
        "material/pbr/pbr-flag-bits.js",
    );
    const hemispheric = await importPinnedModule<{
        SINGLE_LIGHT_STRUCTS: string;
        getSingleLightBlock: () => string;
    }>("material/pbr/fragments/singlelight-hemispheric-wgsl.js");

    const variant = await composePinnedPbrVariant(
        {
            _clearCoat: {
                isEnabled: true,
                intensity: 1,
                roughness: 0,
                indexOfRefraction: 2,
            },
        },
        {
            // The environment is a scene bit, not a material one.
            sceneFeatures: PBR_HAS_ENV,
            lightMode: 1,
            singleLightType: "hemi",
            singleLightWgsl: hemispheric.SINGLE_LIGHT_STRUCTS,
            singleLightBlock: hemispheric.getSingleLightBlock(),
        },
    );

    assert.equal(variant.fragmentKey, "ibl|clearcoat");
    assert.equal(normalize(variant.fragmentWgsl), normalize(captured));
});
