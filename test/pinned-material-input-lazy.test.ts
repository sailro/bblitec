import assert from "node:assert/strict";
import test from "node:test";
import {
    ensurePinnedLoaderExecution,
    pinnedLoaderExecuted,
    pinnedMaterialInputFromGltf,
} from "../src/pinned-material-input.js";
import { composePinnedPbrVariant } from "../src/pinned-pbr-variants.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";

// BU-14's contract, in the order the process lives it. `node --test` runs
// this file in its own process, so the bare-import state at the top is the
// state `cli.js` starts every compile in — which is the point: a scene
// with no glTF material must never execute the ~15 pinned loader imports.
//
// The phases are one test because they are one ordering claim: composing
// BEFORE the loader runs is the new possible interleaving, and the bytes
// it produces must equal the bytes composed after — the process-global
// registration order (scene 12's empty-setter semantics make it
// observable) cannot depend on when the loader executed.

test("the pinned loader executes on demand, not at import, and moves no bytes", async () => {
    // Bare import ran no pinned loader execution.
    assert.equal(pinnedLoaderExecuted(), false);

    // Reading materials before the await refuses by name instead of
    // misbehaving — the guard that turns a missed consumer into a loud
    // failure rather than a subtle reorder.
    assert.throws(
        () => pinnedMaterialInputFromGltf({}),
        /ensurePinnedLoaderExecution/,
    );

    // A composition can now precede the loader (a scene-code material in
    // a process that later meets a glTF one). It anchors the curated
    // registration itself, exactly as before.
    const { PBR_HAS_ENV } = await importPinnedModule<{
        PBR_HAS_ENV: number;
    }>("material/pbr/pbr-flag-bits.js");
    const input = {
        doubleSided: false,
        enableSpecularAA: true,
        occlusionStrength: 0,
    };
    const before = await composePinnedPbrVariant(
        { ...input },
        { sceneFeatures: PBR_HAS_ENV },
    );
    assert.equal(pinnedLoaderExecuted(), false);

    // The loader runs on the first await, idempotently.
    await ensurePinnedLoaderExecution();
    await ensurePinnedLoaderExecution();
    assert.equal(pinnedLoaderExecuted(), true);

    // The same input composes the same bytes after the loader ran: the
    // executed imports touched no pinned registry, so the material UBO
    // layout and both stages are unchanged.
    const after = await composePinnedPbrVariant(
        { ...input },
        { sceneFeatures: PBR_HAS_ENV },
    );
    assert.equal(after.fragmentKey, before.fragmentKey);
    assert.equal(after.vertexWgsl, before.vertexWgsl);
    assert.equal(after.fragmentWgsl, before.fragmentWgsl);

    // And the compose-reaching glTF flow lands on the same variant the
    // eager module always produced — the existing fixture from
    // pinned-material-input.test.ts, byte-composed through the pin.
    const iridescence = await composePinnedPbrVariant(
        pinnedMaterialInputFromGltf({
            extensions: { KHR_materials_iridescence: {} },
        }),
        { sceneFeatures: PBR_HAS_ENV },
    );
    assert.equal(iridescence.fragmentKey, "ibl|iridescence");
    // Stable across a recompose — the composer reads only process-global
    // state, so agreement here is agreement about that state.
    const again = await composePinnedPbrVariant(
        pinnedMaterialInputFromGltf({
            extensions: { KHR_materials_iridescence: {} },
        }),
        { sceneFeatures: PBR_HAS_ENV },
    );
    assert.equal(again.fragmentWgsl, iridescence.fragmentWgsl);
    assert.equal(again.vertexWgsl, iridescence.vertexWgsl);
});
