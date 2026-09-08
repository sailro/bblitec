// Helpers every check plugin shares. A plugin exports `check(context)`
// (see src/tooling/check-run.ts, PluginContext), asserts with
// node:assert/strict, and returns `{ findings?, details? }`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

export const loadPng = (path) => PNG.sync.read(readFileSync(path));

/** The largest absolute lane difference between two equal-length arrays. */
export const maxError = (a, b) => Math.max(...a.map((value, index) => Math.abs(value - b[index])));

/** The browser observations a plugin needs, or a failure naming the command that produces them. */
export function requireObservations(context) {
    if (context.observations === undefined) {
        throw new Error(`no browser observations for ${context.checkId}; run 'scene -- observe ${context.checkId}' first`);
    }
    return context.observations;
}

/** The recorded step of an observation, by id. */
export function observedStep(observations, id) {
    const step = observations.steps?.find((entry) => entry.id === id);
    assert(step, `the observations carry no step '${id}'`);
    return step;
}

/** The absolute path of an observation image (recorded relative to the browser directory). */
export const observedImage = (context, name) => resolve(context.observeDirectory, name);

/**
 * The observations must describe this scene's source and the served
 * module the check compares against: a moved source is a different
 * scene, and an observer that changed the golden is not evidence.
 */
export function assertObservationProvenance(context, observations) {
    assert.equal(sha256(readFileSync(context.scene.source)), observations.sourceSha256, "the scene source moved since it was observed");
    const golden = context.scene.parity?.reference.path;
    if (golden !== undefined && observations.referenceSha256 !== undefined && existsSync(golden)) {
        assert.equal(sha256(readFileSync(golden)), observations.referenceSha256, "the golden moved since the scene was observed");
    }
}

/** The manifest of the tree the check runs against. */
export const readManifest = (context) => readJson(resolve(context.target.output, "manifest.json"));
