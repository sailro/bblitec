// Source-authored controls at Ocean's seekTime=0.1 pose. Canvas checks
// exclude retained UI; the check's frozen-full phase keeps the full-page gate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, parse } from "node:path";
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
        "Ocean observations must use the unchanged pinned module",
    );
    const state = (id) => {
        const step = observedStep(observations, id);
        assert.deepEqual(step.errors ?? [], [], `${id}: browser page errors`);
        assert.equal(step.state.search, "?seekTime=0.1");
        assert.deepEqual(step.state.viewport, { width: 1280, height: 720 });
        assert.equal(step.state.dataset.ready, "true");
        assert.equal(step.state.dataset.oceanStage, "complete");
        assert.equal(step.state.dataset.error, undefined);
        return step.state;
    };
    const image = (id) => {
        const step = observedStep(observations, id);
        assert(step.image, `${id}: browser screenshot is missing`);
        return observedImage(context, step.image);
    };
    const details = { browser: {}, native: {} };
    for (const id of [
        "frozen-full",
        "frozen",
        "frozen-idle",
        "shadows-off",
        "shadows-restored",
        "debug-on",
        "debug-restored",
        "bloom-on",
        "bloom-restored",
        "light-zero",
        "light-restored",
        "paused",
        "paused-idle",
    ]) {
        assert.equal(
            state(id).dataset.animationFrozen,
            "true",
            `${id}: paused`,
        );
        assert.equal(state(id).pause, "Resume", `${id}: pause button`);
    }
    assert.equal(state("running").dataset.animationFrozen, "false");
    assert.equal(state("running").pause, "Pause");
    for (const [off, restored, label, enabled] of [
        ["shadows-off", "shadows-restored", "Enable shadows", false],
        ["debug-on", "debug-restored", "Show debug RTT", true],
        ["bloom-on", "bloom-restored", "Bloom", true],
    ]) {
        assert.equal(state(off).controls[label].checked, enabled, off);
        assert.equal(
            state(restored).controls[label].checked,
            !enabled,
            restored,
        );
    }
    assert.equal(
        Number(state("light-zero").controls["Light intensity"].value),
        0,
    );
    assert.equal(
        Number(state("light-restored").controls["Light intensity"].value),
        1,
    );
    for (const id of [
        "frozen-idle",
        "shadows-restored",
        "debug-restored",
        "bloom-restored",
        "light-restored",
    ]) {
        const difference = compareImages(image(id), image("frozen"));
        assert.equal(
            difference.maxDiff,
            0,
            `${id}: browser did not restore its frozen canvas`,
        );
        details.browser[id] = difference;
    }
    for (const id of [
        "shadows-off",
        "debug-on",
        "bloom-on",
        "light-zero",
        "running",
        "paused",
    ]) {
        const difference = compareImages(image(id), image("frozen"));
        assert(
            difference.totalPixels - difference.exactMatch >= 100,
            `${id}: browser control did not affect the canvas`,
        );
        details.browser[id] = difference;
    }
    const held = compareImages(image("paused-idle"), image("paused"));
    assert.equal(
        held.maxDiff,
        0,
        "Pause must hold the rendered Ocean for 60 browser frames",
    );
    details.browser.pauseHolds = held;
    details.browser.timing = state("frozen-full").timing;
    // Native image/restore and native-to-browser gates are declared in the
    // check, so missing native phases cannot be replaced by browser evidence.
    for (const backend of context.backends) {
        for (const phase of context.spec.phases) {
            assert(
                context.results[backend]?.[phase.id],
                `${backend}: missing phase ${phase.id}`,
            );
        }
        assert.equal(
            context.spec.phases.find((phase) => phase.id === "paused-idle")?.env
                ?.BBLITE_SCREENSHOT_FRAMES,
            "120",
            "Native pause stability requires a checkpoint from the same run",
        );
        const idle = context.results[backend]["paused-idle"];
        const imagePath = parse(idle.image);
        const checkpoint = join(
            imagePath.dir,
            `${imagePath.name}.frame-120.png`,
        );
        assert.equal(
            readFileSync(`${checkpoint}.build-stamp`, "utf8").trim(),
            idle.buildStamp,
            `${backend}: pause checkpoint must use the measured build`,
        );
        const held = compareImages(checkpoint, idle.image);
        assert.equal(
            held.maxDiff,
            0,
            `${backend}: Pause must hold the rendered Ocean for 60 frames in one process`,
        );
        details.native[backend] = { pauseHolds: held };
    }
    return { details };
}
