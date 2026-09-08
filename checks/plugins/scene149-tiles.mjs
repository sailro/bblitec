// Scene 149: the seven geometry attachment tiles the source's placeStrip
// displays in the bottom 15% of the frame, compared tile by tile between
// each native phase and its browser counterpart; the settled native
// orbit camera must equal the browser's pointer-gesture camera exactly;
// the browser's live resize must have failed the way the pin fails
// (error #84 thrown from buildResolvePath, submissions stopping) while
// its intermediate and resolve targets disagree.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import { compareImages } from "../../dist/src/parity.js";
import { assertObservationProvenance, loadPng, observedImage, observedStep, requireObservations } from "./support.mjs";

const TILES = ["viewNormal", "worldNormal", "worldPosition", "reflectivity", "localPosition", "viewDepth", "screenspaceDepth"];

function compareTiles(actualPath, referencePath, stem) {
    const images = [actualPath, referencePath].map(loadPng);
    const { width, height } = images[0];
    const top = Math.floor(height * 0.85);
    return TILES.map((name, index) => {
        const left = Math.floor(index * width / TILES.length);
        const right = Math.floor((index + 1) * width / TILES.length);
        const paths = images.map((image, side) => {
            const crop = new PNG({ width: right - left, height: height - top });
            PNG.bitblt(image, crop, left, top, crop.width, crop.height, 0, 0);
            const path = `${stem}-${name}-${side === 0 ? "native" : "browser"}.png`;
            writeFileSync(path, PNG.sync.write(crop));
            return path;
        });
        return { name, rect: { x: left, y: top, width: right - left, height: height - top }, comparison: compareImages(paths[0], paths[1]) };
    });
}

export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const initial = observedStep(observations, "initial");
    const orbit = observedStep(observations, "orbit");
    const failed = observedStep(observations, "failed-resize");
    const idle = observedStep(observations, "idle-after-failure");
    const startup = observedStep(observations, "startup-960x600");
    assert(Math.abs(orbit.state.camera.alpha - initial.state.camera.alpha) > 0.1, "the browser pointer gesture did not turn the camera");
    assert(orbit.state.submissions > initial.state.submissions, "the browser stopped submitting during the gesture");
    assert(failed.errors?.some((error) => error.includes("#84")), "the pin's live resize did not throw Babylon error #84");
    assert.equal(failed.state.submissions, idle.state.submissions, "the pin's RAF loop kept submitting after its thrown resize error");
    assert.notDeepEqual(failed.state.targets.intermediate, failed.state.targets.resolve, "the failed resize left matching targets");
    assert.deepEqual(startup.extras.startup.viewport, { width: 960, height: 600 }, "the resized browser startup viewport");
    const references = { canonical: initial, orbit, resize: startup };
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend])) {
            const where = `${backend}/${phase.id}`;
            const reference = references[phase.id];
            const tiles = compareTiles(phase.image, observedImage(context, reference.image), phase.image.replace(/\.png$/, ""));
            for (const tile of tiles) assert(tile.comparison.mad < 0.5, `${where}/${tile.name}: tile MAD ${tile.comparison.mad}`);
            if (phase.id === "orbit") {
                for (const key of ["alpha", "beta", "radius"]) {
                    assert.equal(phase.capture.camera[key], orbit.state.camera[key], `${where}: settled native ${key} differs from the browser pointer gesture`);
                }
            } else {
                for (const key of ["alpha", "beta", "radius"]) {
                    assert.equal(phase.capture.camera[key], initial.state.camera[key], `${where}: camera ${key}`);
                }
            }
            details[where] = { worstTileMad: Math.max(...tiles.map((tile) => tile.comparison.mad)), tiles: tiles.map(({ name, comparison }) => ({ name, mad: comparison.mad })) };
            context.log(`${where}: worst tile MAD ${details[where].worstTileMad.toFixed(4)}`);
        }
    }
    return { details };
}
