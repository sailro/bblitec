import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";
import { gpuCaptureSerializer } from "./gpu-capture-fixture.js";

test("text GPU capture retains actual write ranges, allocation identities and independent frame receipts", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/test-text-gpu-capture");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "text-capture-serializer.hpp"), gpuCaptureSerializer("text"));
    const executable = resolve(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", `/I${resolve("native/src")}`,
        `/I${resolve("native/include")}`, `/I${directory}`,
        resolve("test/fixtures/text-gpu-capture-check.cpp"),
        `/Fo${resolve(directory, "check.obj")}`, `/Fe${executable}`,
    ]);
    const output = execFileSync(executable, [], { cwd: directory, encoding: "utf8" });
    assert.match(output, /text GPU capture receipt contract passed/);
    const partial = JSON.parse(readFileSync(resolve(directory, "partial.json"), "utf8"));
    assert.equal(partial.frame, 7);
    assert.deepEqual(partial.resources[0].writtenRanges, [{ offset: 4, bytes: 6 }, { offset: 12, bytes: 3 }]);
    assert.deepEqual(partial.resources[0].uploadedBytes.slice(4, 10), [11, 12, 21, 22, 23, 24]);
    assert.deepEqual(partial.resources[0].uploadedBytes.slice(12), [41, 42, 43]);
    // Bytes outside writtenRanges are placeholders, so no assertion gives the
    // serialized gaps a meaning that the capture never observed.
    assert.deepEqual(partial.resources[0].writes, [
        { sequence: 1, frame: 7, offset: 4, bytes: 3 },
        { sequence: 2, frame: 7, offset: 12, bytes: 3 },
        { sequence: 3, frame: 7, offset: 6, bytes: 4 },
    ]);
    const frame = JSON.parse(readFileSync(resolve(directory, "frame7.json"), "utf8"));
    assert.deepEqual(frame.resources.map((resource: { id: number }) => resource.id), [1, 2, 3, 4, 5]);
    assert.deepEqual(frame.resources[0].writtenRanges, [{ offset: 4, bytes: 11 }]);
    assert.deepEqual(frame.resources[0].writes[4], { sequence: 5, frame: 7, offset: 20, bytes: 0 });
    assert.equal(frame.resources[4].allocationBytes, 65536);
    assert.equal(frame.resources[4].width, 4096);
    assert.equal(frame.resources[4].rows, 1);
    assert.equal(frame.draws.length, 2);
    assert.deepEqual(frame.draws.map((draw: { instances: number }) => draw.instances), [3, 4]);
    for (const draw of frame.draws) {
        assert.equal(draw.pipeline, 0x100000065);
        assert.equal(draw.group, 201);
        assert.equal(draw.quad, 301);
        assert.deepEqual(draw.bindings, [{ binding: 0, role: "text-ubo", resource: 1, view: 0 }, { binding: 1, role: "text-curves", resource: 5, view: 401 }]);
        assert.deepEqual(draw.vertexConstants, [{ id: 3, value: 1.2345678901234567 }, { id: 5, value: -0 }]);
        assert.deepEqual(draw.fragmentConstants, [{ id: 0, value: 1.0000000000000002 }]);
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
    assert.deepEqual(frame.draws.map((draw: { pushedUniformBytes: number[] }) => draw.pushedUniformBytes), [[1, 2, 3, 4], [8, 2, 3, 4]]);
    const stopped = JSON.parse(readFileSync(resolve(directory, "stopped.json"), "utf8"));
    assert.equal(stopped.frame, 8);
    assert.equal(stopped.resources[0].destroyed, true);
    assert.deepEqual(stopped.resources[0].uploadedBytes, frame.resources[0].uploadedBytes);
    assert.equal(stopped.resources[5].id, 6);
    assert.equal(stopped.resources[5].destroyed, false);
    assert.deepEqual(stopped.resources[5].writtenRanges, [{ offset: 0, bytes: 2 }]);
    assert.deepEqual(stopped.resources[5].writes, [{ sequence: 7, frame: 8, offset: 0, bytes: 2 }]);
    assert.equal(stopped.draws.length, 1);
    const ordinary = stopped.draws[0];
    assert.equal(ordinary.bindings[0].resource, 6);
    assert.equal(ordinary.samples, 1);
    assert.equal(ordinary.alphaToCoverage, false);
    assert.equal(ordinary.blendEnabled, true);
    for (const part of ["color", "alpha"]) {
        assert.equal(ordinary[`${part}SrcFactor`], "one");
        assert.equal(ordinary[`${part}DstFactor`], "one-minus-src-alpha");
        assert.equal(ordinary[`${part}Operation`], "add");
    }
});

test("a build without visual capture keeps the text capture interface and no storage", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/test-text-gpu-capture-stub");
    mkdirSync(directory, { recursive: true });
    const source = resolve(directory, "stub.cpp");
    writeFileSync(source, [
        '#include "pal_text_capture.hpp"',
        "#include <vector>",
        "using namespace bbl::pal;",
        "int main() {",
        "    TextGpuCapture capture(true);",
        "    static_assert(!TextGpuCapture::enabled(), \"shipping capture is never enabled\");",
        "    static_assert(sizeof(TextGpuCapture) == 1, \"shipping capture keeps no receipts\");",
        "    capture.begin_frame(1);",
        "    const std::uint64_t id = capture.create_resource(\"text-instance\", 16, 4, 1);",
        "    const std::vector<std::uint8_t> bytes(4);",
        "    capture.write(id, 0, bytes);",
        "    capture.draw(TextGpuDrawCapture{});",
        "    capture.destroy(id);",
        "    capture.stop();",
        "    return id == 0 ? 0 : 1;",
        "}",
        "",
    ].join("\n"));
    const executable = resolve(directory, "stub.exe");
    runNativeFixtureCompiler(native, [
        "/nologo", "/std:c++20", "/EHsc", "/W4", "/WX", "/DBBLITE_VISUAL_CAPTURE=0",
        `/I${resolve("native/src")}`, `/I${resolve("native/include")}`,
        source, `/Fo${resolve(directory, "stub.obj")}`, `/Fe${executable}`,
    ]);
    execFileSync(executable, [], { cwd: directory, encoding: "utf8" });
});
