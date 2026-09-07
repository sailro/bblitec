import assert from "node:assert/strict";
import test from "node:test";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { composeTextPipeline } from "../src/pinned-text-pipeline.js";

test("text pipeline composition retains pin shaders, packed instance layout and target-dependent A2C", async () => {
    const { composeSlugShader } = await importPinnedModule<{
        composeSlugShader(fragment: null): { _vert: string; _frag: string };
    }>("text/shaders/slug-shader.js");
    const shaders = composeSlugShader(null);
    for (const sampleCount of [1, 4]) {
        for (const depthWrite of [false, true]) {
            for (const alphaToCoverage of [false, true]) {
                const actual = await composeTextPipeline({ format: "bgra8unorm", sampleCount,
                    depthStencilFormat: "depth24plus-stencil8", depthWrite, alphaToCoverage });
                const effective = sampleCount > 1 && depthWrite && alphaToCoverage;
                const descriptor = actual.descriptor;
                assert.equal(descriptor.vertex.module.code, shaders._vert);
                assert.equal(descriptor.fragment.module.code, shaders._frag);
                assert.equal(descriptor.vertex.entryPoint, "main");
                assert.equal(descriptor.fragment.entryPoint, "main");
                assert.deepEqual(actual.vertexConstants, []);
                assert.deepEqual(actual.fragmentConstants, effective ? [{ id: 0, value: 1 }] : []);
                assert.deepEqual(actual.quadCorners, [-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
                assert.deepEqual(descriptor.vertex.buffers, [
                    { arrayStride: 8, stepMode: "vertex", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
                    { arrayStride: 12, stepMode: "instance", attributes: [
                        { shaderLocation: 1, offset: 0, format: "float32x2" },
                        { shaderLocation: 2, offset: 8, format: "uint32" },
                    ] },
                ]);
                assert.deepEqual(descriptor.layout.bindGroupLayouts[0]!.entries, [
                    { binding: 0, visibility: 3, buffer: { type: "uniform" } },
                    { binding: 1, visibility: 2, texture: { sampleType: "unfilterable-float" } },
                    { binding: 2, visibility: 2, texture: { sampleType: "unfilterable-float" } },
                    { binding: 3, visibility: 1, buffer: { type: "read-only-storage" } },
                    { binding: 4, visibility: 1, buffer: { type: "read-only-storage" } },
                ]);
                assert.deepEqual(descriptor.primitive, { topology: "triangle-list", cullMode: "none", frontFace: "ccw" });
                assert.deepEqual(descriptor.depthStencil, { format: "depth24plus-stencil8", depthCompare: "greater-equal", depthWriteEnabled: depthWrite });
                assert.equal(descriptor.multisample.count, sampleCount);
                assert.equal(descriptor.multisample.alphaToCoverageEnabled ?? false, effective);
                const target = descriptor.fragment.targets[0]!;
                assert.equal(target.format, "bgra8unorm");
                assert.deepEqual(target.blend, effective ? undefined : {
                    color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                    alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
                });
            }
        }
    }
    const noDepth = await composeTextPipeline({ format: "rgba16float", sampleCount: 1, depthWrite: false, alphaToCoverage: true });
    assert.equal(noDepth.descriptor.depthStencil, undefined);
    assert.equal(noDepth.descriptor.fragment.targets[0]!.format, "rgba16float");
});
