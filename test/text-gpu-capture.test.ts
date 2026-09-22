import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";
import { gpuCaptureSerializer } from "./gpu-capture-fixture.js";
import { jsonNumbers, jsonObject, jsonRecords } from "./json.js";

test("text GPU capture retains actual write ranges, allocation identities and independent frame receipts", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-text-gpu-capture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "text-capture-serializer.hpp"),
        gpuCaptureSerializer("text"),
    );
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        "/nologo",
        "/std:c++20",
        "/EHsc",
        "/W4",
        "/WX",
        `/I${resolve("native/src")}`,
        `/I${resolve("native/include")}`,
        `/I${directory}`,
        resolve("test/fixtures/text-gpu-capture-check.cpp"),
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${executable}`,
    ]);
    const output = execFileSync(executable, [], {
        cwd: directory,
        encoding: "utf8",
    });
    assert.match(output, /text GPU capture receipt contract passed/);
    const partial = jsonObject(
        JSON.parse(readFileSync(resolve(directory, "partial.json"), "utf8")),
    );
    const partialResource = jsonRecords(partial.resources)[0]!;
    assert.equal(partial.frame, 7);
    assert.deepEqual(partialResource.writtenRanges, [
        { offset: 4, bytes: 6 },
        { offset: 12, bytes: 3 },
    ]);
    assert.deepEqual(
        jsonNumbers(partialResource.uploadedBytes).slice(4, 10),
        [11, 12, 21, 22, 23, 24],
    );
    assert.deepEqual(
        jsonNumbers(partialResource.uploadedBytes).slice(12),
        [41, 42, 43],
    );
    // Bytes outside writtenRanges are placeholders, so no assertion gives the
    // serialized gaps a meaning that the capture never observed.
    assert.deepEqual(partialResource.writes, [
        { sequence: 1, frame: 7, offset: 4, bytes: 3 },
        { sequence: 2, frame: 7, offset: 12, bytes: 3 },
        { sequence: 3, frame: 7, offset: 6, bytes: 4 },
    ]);
    const frame = jsonObject(
        JSON.parse(readFileSync(resolve(directory, "frame7.json"), "utf8")),
    );
    const resources = jsonRecords(frame.resources);
    const draws = jsonRecords(frame.draws);
    assert.deepEqual(
        resources.map((resource) => resource.id),
        [1, 2, 3, 4, 5],
    );
    assert.deepEqual(resources[0]!.writtenRanges, [{ offset: 4, bytes: 11 }]);
    assert.deepEqual(jsonRecords(resources[0]!.writes)[4], {
        sequence: 5,
        frame: 7,
        offset: 20,
        bytes: 0,
    });
    assert.equal(resources[4]!.allocationBytes, 65536);
    assert.equal(resources[4]!.width, 4096);
    assert.equal(resources[4]!.rows, 1);
    assert.equal(draws.length, 2);
    assert.deepEqual(
        draws.map((draw) => draw.instances),
        [3, 4],
    );
    for (const draw of draws) {
        assert.equal(draw.pipeline, 0x100000065);
        assert.equal(draw.group, 201);
        assert.equal(draw.quad, 301);
        assert.deepEqual(draw.bindings, [
            { binding: 0, role: "text-ubo", resource: 1, view: 0 },
            { binding: 1, role: "text-curves", resource: 5, view: 401 },
        ]);
        assert.deepEqual(draw.vertexConstants, [
            { id: 3, value: 1.2345678901234567 },
            { id: 5, value: -0 },
        ]);
        assert.deepEqual(draw.fragmentConstants, [
            { id: 0, value: 1.0000000000000002 },
        ]);
        assert.equal(draw.depthCompare, "greater_equal");
        assert.equal(draw.depthWrite, true);
        assert.equal(draw.topology, "triangle-list");
        assert.equal(draw.cullMode, "none");
        assert.equal(draw.frontFace, "ccw");
        assert.equal(draw.samples, 4);
        assert.equal(draw.sampleMask, 0xffffffff);
        assert.equal(draw.alphaToCoverage, true);
        assert.equal(draw.blendEnabled, false);
        assert.equal(draw.vertices, 6);
        assert.equal(draw.instanceCount, 3);
        assert.equal(draw.firstVertex, 0);
        assert.equal(draw.firstInstance, 2);
    }
    assert.deepEqual(
        draws.map((draw) => draw.pushedUniformBytes),
        [
            [1, 2, 3, 4],
            [8, 2, 3, 4],
        ],
    );
    const stopped = jsonObject(
        JSON.parse(readFileSync(resolve(directory, "stopped.json"), "utf8")),
    );
    const stoppedResources = jsonRecords(stopped.resources);
    const stoppedDraws = jsonRecords(stopped.draws);
    assert.equal(stopped.frame, 8);
    assert.equal(stoppedResources[0]!.destroyed, true);
    assert.deepEqual(
        stoppedResources[0]!.uploadedBytes,
        resources[0]!.uploadedBytes,
    );
    assert.equal(stoppedResources[5]!.id, 6);
    assert.equal(stoppedResources[5]!.destroyed, false);
    assert.deepEqual(stoppedResources[5]!.writtenRanges, [
        { offset: 0, bytes: 2 },
    ]);
    assert.deepEqual(stoppedResources[5]!.writes, [
        { sequence: 7, frame: 8, offset: 0, bytes: 2 },
    ]);
    assert.equal(stoppedDraws.length, 1);
    const ordinary = stoppedDraws[0]!;
    assert.equal(jsonRecords(ordinary.bindings)[0]!.resource, 6);
    assert.equal(ordinary.samples, 1);
    assert.equal(ordinary.alphaToCoverage, false);
    assert.equal(ordinary.blendEnabled, true);
    for (const part of ["color", "alpha"]) {
        assert.equal(ordinary[`${part}SrcFactor`], "one");
        assert.equal(ordinary[`${part}DstFactor`], "one-minus-src-alpha");
        assert.equal(ordinary[`${part}Operation`], "add");
    }
});
