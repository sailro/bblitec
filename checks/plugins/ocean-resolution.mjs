import assert from "node:assert/strict";
import { suiteBrowserModuleDigest } from "../../dist/src/capture-suite-reference.js";
import { compareImages } from "../../dist/src/parity.js";
import {
    assertObservationProvenance,
    observedImage,
    observedStep,
    requireObservations,
} from "./support.mjs";

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    assert.equal(observations.referenceSearch, "?seekTime=0.1");
    assert.equal(
        observations.moduleSha256,
        suiteBrowserModuleDigest(context.scene.source),
    );
    const states = {};
    const images = {};
    for (const id of [
        "resolution-256",
        "resolution-128",
        "resolution-128-idle",
    ]) {
        const step = observedStep(observations, id);
        assert.deepEqual(step.errors ?? [], [], `${id}: browser errors`);
        assert.equal(step.state.dataset.ready, "true");
        assert.equal(step.state.dataset.oceanStage, "complete");
        assert.equal(step.state.dataset.animationFrozen, "true");
        assert.equal(step.state.dataset.error, undefined);
        assert.deepEqual(step.state.viewport, { width: 1280, height: 720 });
        assert.deepEqual(step.state.options, ["256", "128", "64", "32"]);
        assert(step.image, `${id}: browser image is missing`);
        states[id] = step.state;
        images[id] = observedImage(context, step.image);
    }
    assert.equal(states["resolution-256"].search, "?seekTime=0.1");
    assert.equal(states["resolution-256"].resolution, "256");
    for (const id of ["resolution-128", "resolution-128-idle"]) {
        assert.equal(states[id].search, "?seekTime=0.1&resolution=128");
        assert.equal(states[id].resolution, "128");
        assert.notEqual(
            states[id].timeOrigin,
            states["resolution-256"].timeOrigin,
        );
    }
    assert.equal(
        states["resolution-128"].timeOrigin,
        states["resolution-128-idle"].timeOrigin,
    );
    const changed = compareImages(
        images["resolution-256"],
        images["resolution-128"],
    );
    assert(
        changed.totalPixels - changed.exactMatch >= 100,
        "Resolution changes the frozen canvas",
    );
    const idle = compareImages(
        images["resolution-128"],
        images["resolution-128-idle"],
    );
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
            selectRect: states["resolution-128"].selectRect,
        },
    };
}
