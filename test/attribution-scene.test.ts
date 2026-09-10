import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attributionScene, copyAttributionReferences } from "../src/attribution-scene.js";
import { parseParityArguments } from "../src/parity-scene.js";
import { resolveScene } from "../src/scene-registry.js";

test("attribution preserves source, pose, host UI and gates with independent outputs", () => {
    const scene = resolveScene("scene6");
    const before = structuredClone(scene);
    const twin = attributionScene(scene);
    assert.deepEqual(scene, before);
    assert.equal(twin.source, scene.source);
    assert.equal(twin.title, scene.title);
    assert.equal(twin.nativeHostUi, scene.nativeHostUi);
    assert.notEqual(twin.id, scene.id);
    assert.notEqual(twin.output, scene.output);
    assert.notEqual(twin.buildDirectory, scene.buildDirectory);
    const { reference, outputDirectory, attribution, ...poseAndGates } = twin.parity!;
    const { reference: _reference, outputDirectory: _output, attribution: _attribution, ...originalPoseAndGates } = scene.parity!;
    assert.deepEqual(poseAndGates, originalPoseAndGates);
    assert.notEqual(reference.path, scene.parity!.reference.path);
    assert.notEqual(outputDirectory, scene.parity!.outputDirectory);
    assert.equal(attribution?.drawIds, true);
    assert.equal(attribution?.triangleClusters, true);
    assert.ok(attribution!.specialization.startsWith(`${twin.output}/`));
});

test("diagnostic reference refresh and recapture cannot overwrite the curated reference", t => {
    const directory = mkdtempSync(join(tmpdir(), "bblite-attribution-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = resolveScene("scene6");
    const scene = { ...source, id: "attribution-reference-fixture", parity: { ...source.parity!, reference: { kind: "source" as const, path: join(directory, "curated.png") } } };
    const twin = attributionScene(scene);
    twin.parity!.reference.path = join(directory, "diagnostic", "reference.png");
    writeFileSync(scene.parity.reference.path, "curated bytes");
    copyAttributionReferences(scene, twin);
    assert.equal(readFileSync(twin.parity!.reference.path, "utf8"), "curated bytes");
    writeFileSync(twin.parity!.reference.path, "recaptured diagnostic pose");
    assert.equal(readFileSync(scene.parity.reference.path, "utf8"), "curated bytes");
    copyAttributionReferences(scene, twin);
    assert.equal(readFileSync(twin.parity!.reference.path, "utf8"), "curated bytes");
});

test("attribution accepts differential capture and rejects inputs without instrumented draws", () => {
    assert.equal(parseParityArguments(["scene6", "--attribute", "--differential"]).attribute, true);
    assert.equal(parseParityArguments(["scene6"]).attribute, undefined);
    for (const companion of [["--actual", "frame.png"], ["--exe", "other.exe"], ["--without", "ground"]]) {
        assert.throws(() => parseParityArguments(["scene6", "--attribute", ...companion]), /instrumented twin/);
    }
});
