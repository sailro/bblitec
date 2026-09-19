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
import { jsonObject, jsonRecords } from "./json.js";

test("node GPU receipts keep independent view uniforms and actual layout and binding identities", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/test-node-gpu-capture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "node-capture-serializer.hpp"),
        gpuCaptureSerializer("node"),
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
        resolve("test/fixtures/node-gpu-capture-check.cpp"),
        `/Fo${resolve(directory, "check.obj")}`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, [], { cwd: directory });
    const capture = jsonObject(
        JSON.parse(readFileSync(resolve(directory, "capture.json"), "utf8")),
    );
    const resources = jsonRecords(capture.resources);
    const pipelines = jsonRecords(capture.pipelines);
    const draws = jsonRecords(capture.draws);
    assert.equal(capture.frame, 8);
    assert.deepEqual(
        resources.map((resource) => resource.id),
        [1, 2, 3, 4, 5],
    );
    assert.deepEqual(resources[0]!.writtenRanges, [{ offset: 12, bytes: 4 }]);
    assert.deepEqual(
        resources.slice(2).map((resource) => resource.uploadedBytes),
        [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
            [9, 10, 11, 12],
        ],
    );
    assert.deepEqual(
        pipelines.map((pipeline) => pipeline.geometryVariant),
        [-1, 0, 1],
    );
    assert.deepEqual(
        pipelines.map((pipeline) => pipeline.colorTargetCount),
        [1, 7, 4],
    );
    assert.deepEqual(pipelines[1]!.attributes, [
        {
            name: "position",
            format: "float32x3",
            location: 2,
            slot: 0,
            offset: 48,
            stride: 128,
        },
        {
            name: "normal",
            format: "float32x3",
            location: 3,
            slot: 0,
            offset: 80,
            stride: 128,
        },
    ]);
    assert.deepEqual(
        draws.map((draw) => draw.meshUniform),
        [3, 4, 5],
    );
    assert.deepEqual(
        draws.map((draw) => draw.group),
        [100, 101, 102],
    );
    for (const draw of draws) {
        assert.equal(draw.mesh, 12);
        assert.equal(draw.material, 79);
        assert.equal(draw.vertices, 1);
        assert.equal(draw.indices, 2);
        assert.equal(draw.vertexOffset, 16);
        assert.equal(draw.indexOffset, 4);
        assert.equal(draw.indexCount, 6);
        assert.equal(draw.firstIndex, 2);
        assert.equal(draw.baseVertex, -3);
        assert.equal(draw.instanceCount, 1);
        assert.deepEqual(draw.bindings, [
            {
                binding: 4,
                role: "albedo-view",
                resource: 0x100000001,
                view: 0x100000002,
            },
            {
                binding: 5,
                role: "albedo-sampler",
                resource: 0x100000003,
                view: 0,
            },
        ]);
    }
    assert.deepEqual(draws[2]!.pushedUniformBytes, [21, 22, 23, 24]);
});
