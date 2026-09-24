// Helpers every check plugin shares. A plugin exports `check(context)`
// (see src/tooling/check-run.ts, PluginContext), asserts with
// node:assert/strict, and returns `{ findings?, details? }`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

/**
 * @import { BinaryLike } from "node:crypto"
 * @import { CompileManifest } from "../../dist/src/compiler/types.js"
 * @import { ObservationsReport, PluginContext } from "../../dist/src/tooling/check-run.js"
 */

/**
 * @typedef {NonNullable<ObservationsReport["steps"]>[number]} ObservedStep
 * @typedef {NonNullable<ObservationsReport["captureFrames"]>[number]} ObservedFrame
 */

/** @param {BinaryLike} bytes */
export const sha256 = (bytes) =>
    createHash("sha256").update(bytes).digest("hex");

/**
 * A JSON file's value; the caller states the shape it reads.
 * @param {string} path
 * @returns {unknown}
 */
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** @param {string} path */
export const loadPng = (path) => PNG.sync.read(readFileSync(path));

/**
 * The largest absolute lane difference between two equal-length arrays.
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 */
export const maxError = (a, b) =>
    Math.max(...a.map((value, index) => Math.abs(value - (b[index] ?? NaN))));

/**
 * The browser observations a plugin needs, or a failure naming the command that produces them.
 * @param {PluginContext} context
 */
export function requireObservations(context) {
    if (context.observations === undefined) {
        throw new Error(
            `no browser observations for ${context.checkId}; run 'scene -- check ${context.checkId} --observe' first`,
        );
    }
    return context.observations;
}

/**
 * The recorded step of an observation, by id.
 * @param {ObservationsReport} observations
 * @param {string} id
 */
export function observedStep(observations, id) {
    const step = observations.steps?.find((entry) => entry.id === id);
    assert(step, `the observations carry no step '${id}'`);
    return step;
}

/**
 * The absolute path of an observation image (recorded relative to the browser directory).
 * @param {PluginContext} context
 * @param {string | undefined} name
 */
export function observedImage(context, name) {
    assert(name !== undefined, "the observed step recorded no image");
    return resolve(context.observeDirectory, name);
}

/**
 * The observations must describe this scene's source and the served
 * module the check compares against: a moved source is a different
 * scene, and an observer that changed the golden is not evidence.
 * @param {PluginContext} context
 * @param {ObservationsReport} observations
 */
export function assertObservationProvenance(context, observations) {
    assert.equal(
        sha256(readFileSync(context.scene.source)),
        observations.sourceSha256,
        "the scene source moved since it was observed",
    );
    const golden = context.scene.parity?.reference.path;
    if (
        golden !== undefined &&
        observations.referenceSha256 !== undefined &&
        existsSync(golden)
    ) {
        assert.equal(
            sha256(readFileSync(golden)),
            observations.referenceSha256,
            "the golden moved since the scene was observed",
        );
    }
}

/**
 * The manifest of the tree the check runs against.
 * @param {PluginContext} context
 */
export const readManifest = (context) =>
    /** @type {CompileManifest} */ (
        readJson(resolve(context.target.output, "manifest.json"))
    );
