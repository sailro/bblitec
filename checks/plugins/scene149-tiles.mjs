// Scene 149: the seven geometry attachment tiles the source's placeStrip
// displays in the bottom 15% of the frame, compared tile by tile between
// each native phase and its browser counterpart; the settled native
// orbit camera must equal the browser's pointer-gesture camera exactly;
// the browser's live resize must have failed the way the pin fails (an
// error thrown from buildResolvePath, submissions stopping) while its
// intermediate and resolve targets disagree.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { PNG } from "pngjs";
import ts from "typescript";
import { isPinnedErrorCall } from "../../dist/src/lowering/pinned-error.js";
import { compareImages } from "../../dist/src/parity.js";
import { sharedUpstreamStore } from "../../dist/src/upstream-source.js";
import {
    assertObservationProvenance,
    loadPng,
    observedImage,
    observedStep,
    requireObservations,
} from "./support.mjs";

/**
 * @import { PluginContext } from "../../dist/src/tooling/check-run.js"
 * @import { ObservedStep } from "./support.mjs"
 */

/**
 * @typedef {{ width: number, height: number }} Extent
 * @typedef {{ alpha: number, beta: number, radius: number }} OrbitCamera
 * @typedef {{
 *     camera: OrbitCamera,
 *     viewport: Extent,
 *     submissions: number,
 *     targets: Record<string, Extent>,
 * }} ObservedState the hook's `window.__observe()` record
 * @typedef {{ camera: OrbitCamera }} NativeCapture the fields read from a phase's render capture
 */

const TILES = [
    "viewNormal",
    "worldNormal",
    "worldPosition",
    "reflectivity",
    "localPosition",
    "viewDepth",
    "screenspaceDepth",
];

const CAMERA_KEYS = /** @type {const} */ (["alpha", "beta", "radius"]);

/**
 * The page errors the pin's buildResolvePath throws, as the bare `#<code>`
 * messages an undecoded Babylon Lite error carries. The codes are build
 * outputs of the pin's error table, so they are read from its source.
 */
function resolvePathErrors() {
    const file = sharedUpstreamStore().getSourceFile(
        "src/frame-graph/copy-to-texture-task.ts",
    );
    const declaration = file.statements.find(
        (statement) =>
            ts.isFunctionDeclaration(statement) &&
            statement.name?.text === "buildResolvePath",
    );
    assert(declaration, "the pin declares no buildResolvePath");
    /** @type {string[]} */
    const messages = [];
    /** @param {ts.Node} node */
    const visit = (node) => {
        const code = ts.isCallExpression(node) ? node.arguments[0] : undefined;
        if (
            ts.isCallExpression(node) &&
            isPinnedErrorCall(file, node) &&
            code !== undefined &&
            ts.isNumericLiteral(code)
        )
            messages.push(`#${code.text}`);
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    assert(messages.length > 0, "the pin's buildResolvePath throws nothing");
    return messages;
}

/**
 * @param {ObservedStep} step
 * @returns {ObservedState}
 */
function observedState(step) {
    assert(step.state, `the observed step '${step.id}' recorded no state`);
    return /** @type {ObservedState} */ (step.state);
}

/**
 * @param {string} actualPath
 * @param {string} referencePath
 * @param {string} stem
 */
function compareTiles(actualPath, referencePath, stem) {
    const [actual, reference] = [actualPath, referencePath].map(loadPng);
    assert(actual && reference);
    const { width, height } = actual;
    const top = Math.floor(height * 0.85);
    return TILES.map((name, index) => {
        const left = Math.floor((index * width) / TILES.length);
        const right = Math.floor(((index + 1) * width) / TILES.length);
        const [nativeTile, browserTile] = [actual, reference].map(
            (image, side) => {
                const crop = new PNG({
                    width: right - left,
                    height: height - top,
                });
                PNG.bitblt(
                    image,
                    crop,
                    left,
                    top,
                    crop.width,
                    crop.height,
                    0,
                    0,
                );
                const path = `${stem}-${name}-${side === 0 ? "native" : "browser"}.png`;
                writeFileSync(path, PNG.sync.write(crop));
                return path;
            },
        );
        assert(nativeTile && browserTile);
        return {
            name,
            rect: {
                x: left,
                y: top,
                width: right - left,
                height: height - top,
            },
            comparison: compareImages(nativeTile, browserTile),
        };
    });
}

/** @param {PluginContext} context */
export function check(context) {
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const initial = observedStep(observations, "initial");
    const orbit = observedStep(observations, "orbit");
    const failed = observedStep(observations, "failed-resize");
    const idle = observedStep(observations, "idle-after-failure");
    const startup = observedStep(observations, "startup-960x600");
    const initialState = observedState(initial);
    const orbitState = observedState(orbit);
    const failedState = observedState(failed);
    assert(
        Math.abs(orbitState.camera.alpha - initialState.camera.alpha) > 0.1,
        "the browser pointer gesture did not turn the camera",
    );
    assert(
        orbitState.submissions > initialState.submissions,
        "the browser stopped submitting during the gesture",
    );
    const resolveErrors = resolvePathErrors();
    assert(
        failed.errors?.some((error) => resolveErrors.includes(error)),
        `the pin's live resize did not throw a buildResolvePath error (${resolveErrors.join(", ")}): ${JSON.stringify(failed.errors ?? [])}`,
    );
    assert.equal(
        failedState.submissions,
        observedState(idle).submissions,
        "the pin's RAF loop kept submitting after its thrown resize error",
    );
    assert.notDeepEqual(
        failedState.targets.intermediate,
        failedState.targets.resolve,
        "the failed resize left matching targets",
    );
    const startupRecord = /** @type {{ viewport: Extent } | undefined} */ (
        startup.extras?.startup
    );
    assert.deepEqual(
        startupRecord?.viewport,
        { width: 960, height: 600 },
        "the resized browser startup viewport",
    );
    /** @type {Record<string, ObservedStep>} */
    const references = { canonical: initial, orbit, resize: startup };
    /** @type {Record<string, { worstTileMad: number, tiles: Array<{ name: string, mad: number }> }>} */
    const details = {};
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend] ?? {})) {
            const where = `${backend}/${phase.id}`;
            const reference = references[phase.id];
            assert(reference, `${where}: no browser reference for the phase`);
            const tiles = compareTiles(
                phase.image,
                observedImage(context, reference.image),
                phase.image.replace(/\.png$/, ""),
            );
            for (const tile of tiles)
                assert(
                    tile.comparison.mad < 0.5,
                    `${where}/${tile.name}: tile MAD ${tile.comparison.mad}`,
                );
            const capture = /** @type {NativeCapture} */ (phase.capture);
            const expected = phase.id === "orbit" ? orbitState : initialState;
            for (const key of CAMERA_KEYS) {
                assert.equal(
                    capture.camera[key],
                    expected.camera[key],
                    phase.id === "orbit"
                        ? `${where}: settled native ${key} differs from the browser pointer gesture`
                        : `${where}: camera ${key}`,
                );
            }
            const worstTileMad = Math.max(
                ...tiles.map((tile) => tile.comparison.mad),
            );
            details[where] = {
                worstTileMad,
                tiles: tiles.map(({ name, comparison }) => ({
                    name,
                    mad: comparison.mad,
                })),
            };
            context.log(`${where}: worst tile MAD ${worstTileMad.toFixed(4)}`);
        }
    }
    return { details };
}
