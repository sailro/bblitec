// Scene 121: the retained splat bytes. The expected bytes are the raw
// source asset with the authored transform applied (rows 0..N-1, Y -= 2);
// the browser observation's digest must equal them, and every native
// capture's retained sidecar must hold exactly those bytes, with the
// browser's bounds (float32) and sample rows.
//
// options: { assetUrl, translatedRows, translationY }
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { downloadCached } from "../../dist/src/asset-download-cache.js";
import { assertObservationProvenance, observedStep, requireObservations, sha256 } from "./support.mjs";

export async function check(context) {
    const { assetUrl, translatedRows, translationY } = context.options;
    const observations = requireObservations(context);
    assertObservationProvenance(context, observations);
    const first = observedStep(observations, "first").state;
    const idle = observedStep(observations, "idle").state;
    assert.deepEqual(idle, first, "the browser's retained splat data changed while idle");
    assert(readFileSync(context.scene.source, "utf8").includes(assetUrl), "the source asset URL changed");
    const original = Buffer.from(await downloadCached(assetUrl));
    const expected = Buffer.from(original);
    for (let row = 0; row < translatedRows; row++) {
        expected.writeFloatLE(expected.readFloatLE(row * 32 + 4) + translationY, row * 32 + 4);
    }
    const expectedSha256 = sha256(expected);
    assert.equal(first.dataSha256, expectedSha256, "the browser's retained bytes differ from the authored F32 writes");
    assert.equal(first.byteLength, expected.length);
    assert.equal(first.vertexCount, expected.length / 32);
    const details = { assetSha256: sha256(original), expectedDataSha256: expectedSha256, phases: {} };
    for (const backend of context.backends) {
        for (const phase of Object.values(context.results[backend])) {
            const splat = phase.capture.splats[0];
            const where = `${backend}/${phase.id}`;
            assert.equal(splat.vertexCount, first.vertexCount, `${where}: vertex count`);
            assert.equal(splat.byteLength, expected.length, `${where}: byte length`);
            const data = readFileSync(resolve(dirname(phase.capturePath), splat.retainedDataFile));
            assert(data.equals(expected), `${where}: the complete retained source bytes differ`);
            for (const field of ["boundMin", "boundMax"]) {
                assert.deepEqual(splat[field].map(Math.fround), first[field].map(Math.fround), `${where}: ${field} differs from the pin`);
            }
            for (const sample of first.sampleRows) {
                for (let lane = 0; lane < 3; lane++) {
                    assert.equal(data.readFloatLE(sample.row * 32 + lane * 4), Math.fround(sample.position[lane]), `${where}: row ${sample.row} lane ${lane}`);
                }
            }
            details.phases[where] = { dataSha256: sha256(data), vertexCount: splat.vertexCount };
        }
    }
    context.log(`retained bytes ${expectedSha256.slice(0, 12)} identical on every phase and backend`);
    return { details };
}
