import assert from "node:assert/strict";
import { suiteBrowserModuleDigest } from "../../dist/src/capture-suite-reference.js";
import { compareImages } from "../../dist/src/parity.js";
import {
    assertObservationProvenance,
    observedImage,
    observedStep,
    requireObservations,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {{
 *     search: string,
 *     timeOrigin: number,
 *     dataset: Record<string, string | undefined>,
 *     viewport: { width: number, height: number },
 *     resolution: string,
 *     options: string[],
 *     selectRect: { x: number, y: number, width: number, height: number },
 * }} ResolutionState the check's `observe.state` record
 */

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    assert.equal(observations.referenceSearch, "?seekTime=0.1");
    assert.equal(
        observations.moduleSha256,
        suiteBrowserModuleDigest(context.scene.source),
    );
    /** @param {string} id */
    const observed = (id) => {
        const step = observedStep(observations, id);
        assert.deepEqual(step.errors ?? [], [], `${id}: browser errors`);
        assert(step.state, `${id}: browser state is missing`);
        const state = /** @type {ResolutionState} */ (step.state);
        assert.equal(state.dataset.ready, "true");
        assert.equal(state.dataset.oceanStage, "complete");
        assert.equal(state.dataset.animationFrozen, "true");
        assert.equal(state.dataset.error, undefined);
        assert.deepEqual(state.viewport, { width: 1280, height: 720 });
        assert.deepEqual(state.options, ["256", "128", "64", "32"]);
        assert(step.image, `${id}: browser image is missing`);
        return { state, image: observedImage(context, step.image) };
    };
    const at256 = observed("resolution-256");
    const at128 = observed("resolution-128");
    const at128Idle = observed("resolution-128-idle");
    assert.equal(at256.state.search, "?seekTime=0.1");
    assert.equal(at256.state.resolution, "256");
    for (const { state } of [at128, at128Idle]) {
        assert.equal(state.search, "?seekTime=0.1&resolution=128");
        assert.equal(state.resolution, "128");
        assert.notEqual(state.timeOrigin, at256.state.timeOrigin);
    }
    assert.equal(at128.state.timeOrigin, at128Idle.state.timeOrigin);
    const changed = compareImages(at256.image, at128.image);
    assert(
        changed.totalPixels - changed.exactMatch >= 100,
        "Resolution changes the frozen canvas",
    );
    const idle = compareImages(at128.image, at128Idle.image);
    assert.equal(idle.maxDiff, 0, "The reloaded simulation stays frozen");
    for (const backend of context.backends) {
        for (const phase of context.spec.phases) {
            const result = context.results[backend]?.[phase.id];
            assert(result, `${backend}: missing ${phase.id}`);
            const sizes = phase.id === "resolution-256" ? [256] : [256, 128];
            const noiseBytes = [
                ...result.log.matchAll(
                    /^\[bblite trace\] dynamic frame=0 .*?storage\[\d+\]=\{label=ocean-gaussian-noise,version=\d+,bytes=(\d+)\}/gm,
                ),
            ].map((match) => Number(match[1]));
            // decodeOceanGaussianNoise creates two Float32 lanes per texel.
            assert.deepEqual(
                noiseBytes,
                sizes.map(
                    (size) => size * size * 2 * Float32Array.BYTES_PER_ELEMENT,
                ),
                `${backend}/${phase.id}: source resolution and reload count`,
            );
            if (sizes.length === 2) {
                assert.equal(
                    [
                        ...result.log.matchAll(
                            /ui-event type=click element=\d+ tag=option/g,
                        ),
                    ].length,
                    2,
                    `${backend}/${phase.id}: pointer option selection before and after reload`,
                );
            }
        }
    }
    return {
        details: {
            changed,
            idle,
            selectRect: at128.state.selectRect,
        },
    };
}
