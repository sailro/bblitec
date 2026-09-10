import assert from "node:assert/strict";
import test from "node:test";
import {
    createRecordingDevice,
    RecordedBuffer,
    RecordedComputePipeline,
    RecordedTexture,
    RecordedTextureView,
    writtenFloats,
} from "../src/recording-device.js";

test("a method outside the producer's contract refuses naming both", () => {
    const { device, recorder } = createRecordingDevice({
        producer: "unit-producer",
        device: ["createTexture"],
        queue: ["writeBuffer"],
    });
    assert.throws(
        () => device.createSampler({}),
        /Recording device for 'unit-producer' does not answer 'createSampler'/,
    );
    assert.throws(
        () => device.createCommandEncoder(),
        /does not answer 'createCommandEncoder'/,
    );
    const queue = (device as unknown as { queue: { writeTexture: unknown } }).queue;
    assert.throws(
        () => queue.writeTexture,
        /Recording queue for 'unit-producer' does not answer 'writeTexture'/,
    );
    assert.throws(
        () => {
            (device as unknown as Record<string, unknown>)["label"] = "x";
        },
        /does not accept a write to 'label'/,
    );
    // `in` answers the contract without throwing, the way a probe expects.
    assert.equal("createTexture" in device, true);
    assert.equal("createSampler" in device, false);
    assert.equal("queue" in device, true);
    assert.equal(recorder.textures.length, 0);
});

test("compute recording preserves uploads and per-dispatch bindings when scratch textures are reused", () => {
    const { device, encoder, recorder } = createRecordingDevice({
        producer: "compute-transfers",
        textureOperations: "recording",
        device: ["createTexture", "createShaderModule", "createComputePipeline", "createBindGroup"],
        queue: ["copyExternalImageToTexture"],
        encoder: ["beginComputePass", "copyTextureToTexture"],
        computePass: ["setPipeline", "setBindGroup", "dispatchWorkgroups", "end"],
    });
    const shader = device.createShaderModule({ code: "source shader" });
    const constants = { 0: 1 };
    const descriptor = { layout: "auto", compute: { module: shader, entryPoint: "main", constants } };
    const pipeline = device.createComputePipeline(descriptor);
    constants[0] = 0;
    descriptor.compute.entryPoint = "changed";
    assert.equal(pipeline.descriptor.compute.entryPoint, "main");
    assert.deepEqual(pipeline.descriptor.compute.constants, { 0: 1 });
    assert.equal(pipeline.descriptor.compute.module, shader);
    assert.equal(recorder.kindOf(pipeline), "computePipeline");
    assert.equal(pipeline.getBindGroupLayout(0), pipeline.getBindGroupLayout(0));
    assert.notEqual(pipeline.getBindGroupLayout(0), pipeline.getBindGroupLayout(1));

    const input = device.createTexture({ size: [16, 16], format: "rgba8unorm", usage: 6 });
    const output = device.createTexture({ size: [16, 16], format: "rgba16float", usage: 9 });
    const cube = device.createTexture({ size: [16, 16, 6], format: "rgba16float", usage: 6 });
    const group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: input.createView() }, { binding: 1, resource: output.createView() }],
    });
    const replacement = device.createBindGroup({});
    const commands = encoder as {
        beginComputePass(): {
            setPipeline(value: RecordedComputePipeline): void;
            setBindGroup(index: number, group: object): void;
            dispatchWorkgroups(...counts: number[]): void;
            end(): void;
        };
        copyTextureToTexture(source: { texture: RecordedTexture },
            destination: { texture: RecordedTexture; origin: { z: number } }, size: number[]): void;
    };
    const queue = (device as unknown as { queue: {
        copyExternalImageToTexture(source: unknown, destination: { texture: RecordedTexture }, size: number[]): void;
    } }).queue;
    const images = [{ image: 0 }, { image: 1 }];
    for (let face = 0; face < images.length; face++) {
        queue.copyExternalImageToTexture({ source: images[face], flipY: false }, { texture: input }, [16, 16]);
        const pass = commands.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.dispatchWorkgroups(2, 2);
        // Later state changes must not alter the resources an earlier dispatch read.
        pass.setBindGroup(0, replacement);
        pass.end();
        commands.copyTextureToTexture({ texture: output }, { texture: cube, origin: { z: face } }, [16, 16]);
    }
    assert.deepEqual(recorder.textureOperations.map(operation => operation.kind),
        ["upload", "compute", "copy", "upload", "compute", "copy"]);
    let uploadIndex = 0;
    let copyIndex = 0;
    for (const operation of recorder.textureOperations) {
        if (operation.kind === "upload") {
            assert.equal(operation.texture, input);
            assert.equal(operation.upload, input.uploads[uploadIndex]);
            assert.equal(operation.upload.kind, "external");
            if (operation.upload.kind === "external")
                assert.deepEqual(operation.upload.source, { source: images[uploadIndex++], flipY: false });
        } else if (operation.kind === "compute") {
            assert.equal(operation.dispatch.pipeline, pipeline);
            assert.deepEqual([...operation.dispatch.bindGroups], [[0, group]]);
            assert.deepEqual(operation.dispatch.workgroups, [2, 2]);
        } else {
            assert.equal(operation.copy, recorder.textureCopies[copyIndex]);
            assert.equal(operation.copy.source.texture, output);
            assert.equal(operation.copy.destination.texture, cube);
            assert.equal(operation.copy.destination.origin.z, copyIndex++);
        }
    }
    recorder.clear();
    assert.equal(recorder.textureOperations.length, 0);
    assert.equal(recorder.textures.length, 0);
    assert.equal(recorder.textureCopies.length, 0);
    assert.equal(recorder.bindGroups.length, 0);
    assert.equal(input.uploads.length, 2);
    assert.equal(recorder.kindOf(pipeline), "computePipeline");
});

test("compute passes refuse uncontracted calls, foreign resources and missing pipelines", () => {
    const { device, encoder, recorder } = createRecordingDevice({
        producer: "compute-refusals",
        textureOperations: "recording",
        device: ["createComputePipeline", "createBindGroup"],
        encoder: ["beginComputePass"],
        computePass: ["setPipeline", "setBindGroup", "dispatchWorkgroups"],
    });
    const other = createRecordingDevice({ producer: "other", device: ["createComputePipeline", "createBindGroup"] });
    const descriptor = { layout: "auto", compute: { module: {} } };
    const pass = (encoder as { beginComputePass(): {
        setPipeline(pipeline: RecordedComputePipeline): void;
        setBindGroup(index: number, group: object): void;
        dispatchWorkgroups(count: number): void;
        end(): void;
    } }).beginComputePass();
    assert.throws(() => pass.dispatchWorkgroups(1), /compute dispatch has no pipeline/);
    const foreign = other.device.createComputePipeline(descriptor);
    assert.equal(recorder.kindOf(foreign), undefined);
    assert.throws(() => pass.setPipeline(foreign), /pipeline this device did not create/);
    assert.throws(() => pass.setPipeline(new RecordedComputePipeline(descriptor)), /pipeline this device did not create/);
    assert.throws(() => pass.setBindGroup(0, other.device.createBindGroup({})), /group this device did not create/);
    assert.throws(() => pass.end(), /compute pass for 'compute-refusals' does not answer 'end'/);
    pass.setPipeline(device.createComputePipeline(descriptor));
    pass.dispatchWorkgroups(1);
    assert.equal(recorder.textureOperations.length, 1);
});

test("submitted texture recording follows queue order and rejects command-buffer reuse", () => {
    const {device, recorder} = createRecordingDevice({producer: "submitted-order",
        device: ["createTexture", "createCommandEncoder"], queue: ["writeTexture", "submit"],
        encoder: ["copyTextureToTexture", "finish"], textureOperations: "submitted"});
    const textures = Array.from({length: 3}, () => device.createTexture({size: [1, 1], format: "rgba8unorm", usage: 3}));
    const commands = [0, 1].map(index => {
        const encoder = device.createCommandEncoder() as {
            copyTextureToTexture(source: {texture: RecordedTexture}, destination: {texture: RecordedTexture}, size: number[]): void;
            finish(): object;
        };
        encoder.copyTextureToTexture({texture: textures[index]!}, {texture: textures[index + 1]!}, [1, 1]);
        const buffer = encoder.finish();
        assert.throws(() => encoder.finish(), /already finished/);
        return buffer;
    });
    assert.equal(recorder.textureOperations.length, 0);
    const queue = (device as unknown as {queue: {
        writeTexture(destination: {texture: RecordedTexture}, data: Uint8Array, layout: object, size: number[]): void;
        submit(buffers: object[]): void;
    }}).queue;
    queue.writeTexture({texture: textures[0]!}, Uint8Array.of(1, 2, 3, 4), {}, [1, 1]);
    queue.submit([commands[1]!, commands[0]!]);
    assert.deepEqual(recorder.textureOperations.map(operation => operation.kind), ["upload", "copy", "copy"]);
    assert.deepEqual(recorder.textureOperations.filter(operation => operation.kind === "copy").map(operation => operation.copy.source.texture),
        [textures[1], textures[0]]);
    assert.throws(() => queue.submit([commands[0]!]), /unknown or already submitted/);
    assert.throws(() => queue.submit([{}]), /unknown or already submitted/);
});

test("a device without queue methods exposes no queue at all", () => {
    const { device } = createRecordingDevice({
        producer: "queueless",
        device: ["createBuffer"],
    });
    assert.equal("queue" in device, false);
    assert.throws(
        () => (device as unknown as { queue: unknown }).queue,
        /does not answer 'queue'/,
    );
});

test("a contract listing a method the recorder lacks refuses at creation", () => {
    assert.throws(
        () =>
            createRecordingDevice({
                producer: "unit-producer",
                device: ["createTexture", "createQuerySet" as "createTexture"],
            }),
        /lists 'createQuerySet', which this recorder does not implement/,
    );
});

test("textures carry their descriptor in both extent spellings and their uploads", () => {
    const { device, recorder } = createRecordingDevice({
        producer: "textures",
        device: ["createTexture"],
        queue: ["writeTexture", "copyExternalImageToTexture"],
    });
    const cube = device.createTexture({
        label: "cube",
        size: [64, 64, 6],
        mipLevelCount: 7,
        format: "rgba16float",
        usage: 5,
    });
    const flat = device.createTexture({
        size: { width: 1, height: 1 },
        format: "rgba8unorm",
        usage: 4,
    });
    assert.ok(cube instanceof RecordedTexture);
    assert.deepEqual(
        [cube.width, cube.height, cube.depthOrArrayLayers, cube.mipLevelCount, cube.label],
        [64, 64, 6, 7, "cube"],
    );
    assert.deepEqual(
        [flat.width, flat.height, flat.depthOrArrayLayers, flat.mipLevelCount, flat.label],
        [1, 1, 1, 1, ""],
    );
    const view = cube.createView({ dimension: "cube", aspect: "depth-only" });
    assert.ok(view instanceof RecordedTextureView);
    assert.equal(view.texture, cube);
    assert.equal(view.descriptor.aspect, "depth-only");
    assert.equal(recorder.kindOf(view), "textureView");
    assert.equal(recorder.kindOf(cube), "texture");

    const queue = (device as unknown as {
        queue: {
            writeTexture(
                destination: { texture: unknown; mipLevel?: number },
                data: ArrayBufferView,
                layout: unknown,
                size: { width: number; height: number },
            ): void;
            copyExternalImageToTexture(
                source: unknown,
                destination: { texture: unknown },
                size: { width: number; height: number },
            ): void;
        };
    }).queue;
    const texels = new Uint8Array([1, 2, 3, 4]);
    queue.writeTexture({ texture: flat }, texels, { bytesPerRow: 4 }, { width: 1, height: 1 });
    texels[0] = 9;
    queue.copyExternalImageToTexture({ source: { sourceImage: 3 } }, { texture: cube }, { width: 64, height: 64 });
    assert.deepEqual(recorder.textures, [cube, flat]);
    assert.equal(recorder.textureOperations.length, 0);
    assert.equal(flat.uploads.length, 1);
    const upload = flat.uploads[0]!;
    assert.equal(upload.kind, "write");
    // The bytes are the call's own, not the scratch the pin then reuses.
    assert.deepEqual(upload.kind === "write" ? [...upload.bytes] : [], [1, 2, 3, 4]);
    assert.deepEqual(cube.uploads.map((entry) => entry.kind), ["external"]);
    assert.throws(
        () => queue.writeTexture({ texture: {} }, texels, {}, { width: 1, height: 1 }),
        /is not a texture this device created/,
    );
});

test("buffers keep the mapped range and every queue write, by WebGPU's byte rules", () => {
    const { device, recorder } = createRecordingDevice({
        producer: "buffers",
        device: ["createBuffer"],
        queue: ["writeBuffer"],
    });
    const mapped = device.createBuffer({ label: "quad", size: 16, usage: 32, mappedAtCreation: true });
    assert.ok(mapped instanceof RecordedBuffer);
    new Float32Array(mapped.getMappedRange()).set([1, 2, 3, 4]);
    mapped.unmap();
    assert.throws(() => mapped.getMappedRange(), /is not mapped/);
    assert.deepEqual([...new Float32Array(mapped.bytes)], [1, 2, 3, 4]);

    const uniform = device.createBuffer({ label: "ubo", size: 32 });
    assert.throws(() => uniform.getMappedRange(), /is not mapped/);
    const queue = (device as unknown as {
        queue: {
            writeBuffer(
                buffer: unknown,
                offset: number,
                data: ArrayBuffer | ArrayBufferView,
                dataOffset?: number,
                size?: number,
            ): void;
        };
    }).queue;
    const scratch = new Float32Array([5, 6, 7, 8, 9, 10]);
    // A typed array counts its offset and size in elements ...
    queue.writeBuffer(uniform, 8, scratch, 1, 2);
    // ... and an ArrayBuffer counts them in bytes.
    queue.writeBuffer(uniform, 0, scratch.buffer, 16, 8);
    scratch.fill(0);
    assert.deepEqual(
        recorder.bufferWrites.map((write) => [write.buffer, write.offset, writtenFloats(write)]),
        [[uniform, 8, [6, 7]], [uniform, 0, [9, 10]]],
    );
    assert.deepEqual([...new Float32Array(uniform.bytes)].slice(0, 4), [9, 10, 6, 7]);
    assert.throws(
        () => queue.writeBuffer(uniform, 28, new Float32Array([1, 2])),
        /overflows buffer 'ubo' of 32 bytes/,
    );
    assert.throws(
        () => queue.writeBuffer({}, 0, new Float32Array([1])),
        /is not a buffer this device created/,
    );
    assert.throws(
        () => mapped.getMappedRange(),
        /is not mapped/,
    );
    const half = device.createBuffer({ size: 8, mappedAtCreation: true });
    assert.throws(() => half.getMappedRange(4), /mapped sub-range/);
});

test("copied-descriptor handles keep the descriptor's members and their kind", () => {
    interface Shapes {
        sampler: { magFilter?: string };
        shaderModule: { code: string };
        bindGroupLayout: { entries: readonly { binding: number }[] };
        pipelineLayout: { bindGroupLayouts: readonly { entries: readonly { binding: number }[] }[] };
        renderPipeline: { layout: object; vertex: { module: { code: string } } };
        bindGroup: { entries: readonly { binding: number; resource: unknown }[] };
    }
    const { device, recorder } = createRecordingDevice<Shapes>({
        producer: "handles",
        device: [
            "createSampler",
            "createShaderModule",
            "createBindGroupLayout",
            "createPipelineLayout",
            "createRenderPipeline",
            "createBindGroup",
        ],
    });
    const moduleDescriptor = { code: "fn main() {}" };
    const module = device.createShaderModule(moduleDescriptor);
    assert.notEqual(module, moduleDescriptor);
    assert.equal(module.code, "fn main() {}");
    moduleDescriptor.code = "changed";
    assert.equal(module.code, "fn main() {}");
    const layout = device.createBindGroupLayout({ entries: [{ binding: 0 }] });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    assert.equal(pipelineLayout.bindGroupLayouts[0], layout);
    const pipeline = device.createRenderPipeline({ layout: pipelineLayout, vertex: { module } });
    const sampler = device.createSampler({ magFilter: "linear" });
    const group = device.createBindGroup({ entries: [{ binding: 0, resource: sampler }] });
    assert.deepEqual(
        [module, layout, pipelineLayout, pipeline, sampler, group].map((handle) => recorder.kindOf(handle)),
        ["shaderModule", "bindGroupLayout", "pipelineLayout", "renderPipeline", "sampler", "bindGroup"],
    );
    assert.equal(recorder.kindOf({ magFilter: "linear" }), undefined);
    assert.deepEqual(recorder.samplers, [{ magFilter: "linear" }]);
    assert.deepEqual(Object.keys(group), ["entries"]);
    assert.throws(
        () => device.createShaderModule(undefined as unknown as { code: string }),
        /createShaderModule was handed no descriptor object/,
    );
});

test("the encoder records texture copies, render passes and submits", () => {
    const { device, encoder, recorder } = createRecordingDevice({
        producer: "encoding",
        device: ["createTexture", "createCommandEncoder", "createRenderPipeline", "createBindGroup"],
        queue: ["submit"],
        encoder: ["copyTextureToTexture", "beginRenderPass", "finish"],
        renderPass: ["setPipeline", "setBindGroup", "draw", "end"],
    });
    assert.equal(device.createCommandEncoder(), encoder);
    const source = device.createTexture({ size: [8, 8, 6], format: "rgba16float", usage: 1 });
    const target = device.createTexture({ size: [8, 8, 12], format: "rgba16float", usage: 2 });
    const commands = encoder as {
        copyTextureToTexture(
            source: { texture: unknown; mipLevel?: number; origin?: readonly number[] },
            destination: { texture: unknown; mipLevel?: number; origin?: { z: number } },
            size: readonly number[],
        ): void;
        beginRenderPass(descriptor: {
            label: string;
            colorAttachments: { view: unknown; loadOp: string }[];
        }): {
            setPipeline(pipeline: unknown): void;
            setBindGroup(index: number, group: unknown): void;
            draw(count: number): void;
            end(): void;
            setViewport(): void;
        };
        finish(): unknown;
    };
    commands.copyTextureToTexture(
        { texture: source, mipLevel: 2, origin: [0, 0, 5] },
        { texture: target, origin: { z: 11 } },
        [2, 2, 1],
    );
    assert.deepEqual(recorder.textureCopies, [
        {
            source: { texture: source, mipLevel: 2, origin: { x: 0, y: 0, z: 5 } },
            destination: { texture: target, mipLevel: 0, origin: { x: 0, y: 0, z: 11 } },
            size: { width: 2, height: 2, depthOrArrayLayers: 1 },
        },
    ]);
    const pipeline = device.createRenderPipeline({});
    const group = device.createBindGroup({});
    const pass = commands.beginRenderPass({
        label: "pass",
        colorAttachments: [{ view: target.createView(), loadOp: "clear" }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.draw(3);
    assert.throws(() => pass.setViewport(), /Recording render pass for 'encoding' does not answer 'setViewport'/);
    assert.throws(() => pass.setPipeline({}), /set a pipeline this device did not create/);
    pass.end();
    assert.equal(recorder.renderPasses.length, 1);
    const recorded = recorder.renderPasses[0]!;
    assert.equal(recorded.descriptor.label, "pass");
    assert.equal(recorded.pipeline, pipeline);
    assert.deepEqual(recorded.bindGroups, [{ index: 0, group }]);
    assert.deepEqual(recorded.draws, [[3]]);
    assert.equal(recorded.ended, true);
    assert.throws(
        () => commands.beginRenderPass({ label: "bad", colorAttachments: [{ view: {}, loadOp: "load" }] }),
        /attached a view this device did not create/,
    );
    const queue = (device as unknown as { queue: { submit(buffers: unknown[]): void } }).queue;
    queue.submit([commands.finish(), commands.finish()]);
    assert.equal(recorder.submitted, 2);
});
