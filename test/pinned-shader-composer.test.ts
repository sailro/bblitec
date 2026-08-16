import assert from "node:assert/strict";
import test from "node:test";
import {
    composePinnedPbrShader,
    importPinnedModule,
} from "../src/pinned-shader-composer.js";

test("composes the pinned PBR fragment through Babylon Lite's own composer", async () => {
    const composed = await composePinnedPbrShader();
    assert.match(composed.fragmentWgsl, /@fragment/);
    assert.match(composed.vertexWgsl, /@vertex/);
    // A bare PBR material reaches no fragment, so the permutation is unnamed.
    assert.equal(composed.fragmentKey, "");
});

test("the composer emits the clearcoat base-F0 remap the pin owns", async () => {
    const { createClearcoatFragment } = await importPinnedModule<{
        createClearcoatFragment: (
            features: number,
            features2: number,
            hasIbl: boolean,
            hasBaseNormalMap: boolean,
            hasSpecularAA: boolean,
        ) => unknown;
    }>("material/pbr/fragments/clearcoat-fragment.js");
    const { createIblFragment } = await importPinnedModule<{
        createIblFragment: (hasNormalMap: boolean) => unknown;
    }>("material/pbr/fragments/ibl-fragment.js");
    const { PBR_HAS_CLEARCOAT } = await importPinnedModule<{
        PBR_HAS_CLEARCOAT: number;
    }>("material/pbr/pbr-flag-bits.js");

    const composed = await composePinnedPbrShader({}, [
        createIblFragment(false),
        createClearcoatFragment(PBR_HAS_CLEARCOAT, 0, true, false, false),
    ]);

    assert.equal(composed.fragmentKey, "ibl|clearcoat");
    // The remap the renderer currently hand-writes as bblClearcoatRemappedF0.
    // Composing it from the pin is what retires that transcription.
    assert.match(
        composed.fragmentWgsl,
        /fn getR0RemappedForClearCoat\(/,
    );
    assert.match(
        composed.fragmentWgsl,
        /colorF0 = mix\(colorF0, remappedF0, ccInt_r\);/,
    );
});

test("the composer refuses a fragment set missing a declared dependency", async () => {
    const { createClearcoatFragment } = await importPinnedModule<{
        createClearcoatFragment: (
            features: number,
            features2: number,
            hasIbl: boolean,
            hasBaseNormalMap: boolean,
            hasSpecularAA: boolean,
        ) => unknown;
    }>("material/pbr/fragments/clearcoat-fragment.js");
    const { PBR_HAS_CLEARCOAT } = await importPinnedModule<{
        PBR_HAS_CLEARCOAT: number;
    }>("material/pbr/pbr-flag-bits.js");

    // The clearcoat fragment declares `ibl` when composed with an environment.
    // The composer topologically sorts dependencies and throws on a missing
    // one, which is the pin stating a contract rather than us knowing it.
    await assert.rejects(() =>
        composePinnedPbrShader({}, [
            createClearcoatFragment(PBR_HAS_CLEARCOAT, 0, true, false, false),
        ]),
    );
});
