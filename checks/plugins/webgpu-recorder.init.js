// Page init script: the one WebGPU recorder the checks observe pages with.
// Every buffer, texture, sampler, view, bind group and render pipeline gets
// an identity; every buffer and texture upload is kept in page order; every
// draw is recorded as it executes (render-bundle draws where the pass runs
// the bundle), and the last two queue submissions are kept. The records
// (checks/plugins/webgpu-records.d.ts) come out of window.__webgpuRecorder:
// `receipts()` with the upload log, `observation()` with each buffer's
// current bytes, `describeMeshes()` for a scene's meshes by the same
// identities. A source hook may hand the recorder scene objects as `source`.
(() => {
    /** @typedef {import("./webgpu-records.js").RecordedWrite} RecordedWrite */
    /** @typedef {import("./webgpu-records.js").RecordedResource} RecordedResource */
    /** @typedef {import("./webgpu-records.js").RecordedBindGroup} RecordedBindGroup */
    /** @typedef {import("./webgpu-records.js").RecordedPipeline} RecordedPipeline */
    /** @typedef {import("./webgpu-records.js").RecordedDraw} RecordedDraw */

    /** Writes past this many bytes keep their bytes in the page only. */
    const RECEIPT_BYTES = 1048576;
    const KEPT_SUBMISSIONS = 2;

    /** @type {WeakMap<object, number>} */
    const identities = new WeakMap();
    let nextIdentity = 1;
    /** @param {object} object */
    const identity = (object) => {
        let id = identities.get(object);
        if (id === undefined) {
            id = nextIdentity++;
            identities.set(object, id);
        }
        return id;
    };

    let frame = 0;
    const requestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = function (callback) {
        return requestAnimationFrame.call(window, (time) => {
            frame += 1;
            callback(time);
        });
    };

    /** @type {RecordedResource[]} */
    const resources = [];
    /** @type {Map<number, { label: string, size: number, usage: number }>} */
    const buffers = new Map();
    /** @type {Array<{ record: Omit<RecordedWrite, "data">, bytes: Uint8Array }>} */
    const writes = [];
    /**
     * @param {Omit<RecordedWrite, "data" | "byteLength">} record
     * @param {Uint8Array} bytes
     */
    const logWrite = (record, bytes) => {
        writes.push({
            record: { ...record, byteLength: bytes.byteLength },
            bytes: bytes.slice(),
        });
    };
    /**
     * The bytes an upload takes from its source: dataOffset and size count
     * elements of a typed array and bytes otherwise.
     * @param {AllowSharedBufferSource} data
     * @param {number | undefined} dataOffset
     * @param {number | undefined} size
     */
    const sourceBytes = (data, dataOffset, size) => {
        const view = ArrayBuffer.isView(data);
        const unit =
            view && "BYTES_PER_ELEMENT" in data
                ? Number(data.BYTES_PER_ELEMENT)
                : 1;
        const bytes = view
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        const begin = (dataOffset ?? 0) * unit;
        return bytes.subarray(
            begin,
            size === undefined ? bytes.byteLength : begin + size * unit,
        );
    };

    const device = GPUDevice.prototype;
    const createBuffer = device.createBuffer;
    device.createBuffer = function (desc) {
        const buffer = createBuffer.call(this, desc);
        const id = identity(buffer);
        const label = desc.label ?? "";
        resources.push({
            id,
            kind: "buffer",
            label,
            size: desc.size,
            usage: desc.usage,
        });
        buffers.set(id, { label, size: desc.size, usage: desc.usage });
        if (desc.mappedAtCreation) {
            // A mapped range reaches the buffer when it is unmapped.
            /** @type {Array<{ offset: number, range: ArrayBuffer }>} */
            const ranges = [];
            const getMappedRange = buffer.getMappedRange.bind(buffer);
            buffer.getMappedRange = function (offset, size) {
                const range = getMappedRange(offset, size);
                ranges.push({ offset: offset ?? 0, range });
                return range;
            };
            const unmap = buffer.unmap.bind(buffer);
            buffer.unmap = function () {
                for (const entry of ranges)
                    logWrite(
                        { id, frame, offset: entry.offset, mapped: true },
                        new Uint8Array(entry.range),
                    );
                ranges.length = 0;
                unmap();
            };
        }
        return buffer;
    };
    const createTexture = device.createTexture;
    device.createTexture = function (desc) {
        const texture = createTexture.call(this, desc);
        const [width, height = 1] = Array.isArray(desc.size)
            ? desc.size
            : [desc.size.width, desc.size.height];
        if (width === undefined)
            throw new TypeError(
                "createTexture accepted a size without a width",
            );
        resources.push({
            id: identity(texture),
            kind: "texture",
            label: desc.label ?? "",
            size: { width, height },
            format: desc.format,
            usage: desc.usage,
        });
        return texture;
    };
    const createSampler = device.createSampler;
    device.createSampler = function (desc) {
        const sampler = createSampler.call(this, desc);
        resources.push({
            id: identity(sampler),
            kind: "sampler",
            label: desc?.label ?? "",
        });
        return sampler;
    };
    const createView = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (desc) {
        const view = createView.call(this, desc);
        resources.push({
            id: identity(view),
            kind: "view",
            label: desc?.label ?? "",
            texture: identity(this),
        });
        return view;
    };

    /** @type {RecordedBindGroup[]} */
    const groups = [];
    const createBindGroup = device.createBindGroup;
    device.createBindGroup = function (desc) {
        const group = createBindGroup.call(this, desc);
        groups.push({
            id: identity(group),
            label: desc.label ?? "",
            entries: Array.from(desc.entries, ({ binding, resource }) =>
                "buffer" in resource
                    ? {
                          binding,
                          resource: identity(resource.buffer),
                          offset: resource.offset ?? 0,
                          size: resource.size ?? null,
                      }
                    : { binding, resource: identity(resource) },
            ),
        });
        return group;
    };

    /** @param {Record<string, number> | undefined} constants */
    const copyConstants = (constants) => ({ ...constants });
    /** @param {GPUBlendComponent} component */
    const blendComponent = ({ srcFactor, dstFactor, operation }) => ({
        ...(srcFactor === undefined ? {} : { srcFactor }),
        ...(dstFactor === undefined ? {} : { dstFactor }),
        ...(operation === undefined ? {} : { operation }),
    });
    /** @type {RecordedPipeline[]} */
    const pipelines = [];
    /**
     * @param {GPURenderPipeline} pipeline
     * @param {GPURenderPipelineDescriptor} desc
     */
    const recordPipeline = (pipeline, desc) => {
        const { depthStencil, primitive, multisample, fragment } = desc;
        pipelines.push({
            id: identity(pipeline),
            label: desc.label ?? "",
            vertex: {
                constants: copyConstants(desc.vertex.constants),
                buffers: Array.from(desc.vertex.buffers ?? [], (layout) =>
                    layout === null || layout === undefined
                        ? null
                        : {
                              arrayStride: layout.arrayStride,
                              ...(layout.stepMode === undefined
                                  ? {}
                                  : { stepMode: layout.stepMode }),
                              attributes: Array.from(
                                  layout.attributes,
                                  ({ format, offset, shaderLocation }) => ({
                                      format,
                                      offset,
                                      shaderLocation,
                                  }),
                              ),
                          },
                ),
            },
            fragment: fragment
                ? {
                      constants: copyConstants(fragment.constants),
                      targets: Array.from(fragment.targets, (target) =>
                          target === null || target === undefined
                              ? null
                              : {
                                    format: target.format,
                                    ...(target.blend
                                        ? {
                                              blend: {
                                                  color: blendComponent(
                                                      target.blend.color,
                                                  ),
                                                  alpha: blendComponent(
                                                      target.blend.alpha,
                                                  ),
                                              },
                                          }
                                        : {}),
                                    ...(target.writeMask === undefined
                                        ? {}
                                        : { writeMask: target.writeMask }),
                                },
                      ),
                  }
                : null,
            depthStencil: depthStencil
                ? {
                      format: depthStencil.format,
                      ...(depthStencil.depthCompare === undefined
                          ? {}
                          : { depthCompare: depthStencil.depthCompare }),
                      ...(depthStencil.depthWriteEnabled === undefined
                          ? {}
                          : {
                                depthWriteEnabled:
                                    depthStencil.depthWriteEnabled,
                            }),
                  }
                : null,
            primitive: {
                ...(primitive?.topology === undefined
                    ? {}
                    : { topology: primitive.topology }),
                ...(primitive?.cullMode === undefined
                    ? {}
                    : { cullMode: primitive.cullMode }),
                ...(primitive?.frontFace === undefined
                    ? {}
                    : { frontFace: primitive.frontFace }),
            },
            multisample: {
                ...(multisample?.count === undefined
                    ? {}
                    : { count: multisample.count }),
                ...(multisample?.mask === undefined
                    ? {}
                    : { mask: multisample.mask }),
                ...(multisample?.alphaToCoverageEnabled === undefined
                    ? {}
                    : {
                          alphaToCoverageEnabled:
                              multisample.alphaToCoverageEnabled,
                      }),
            },
        });
    };
    const createRenderPipeline = device.createRenderPipeline;
    device.createRenderPipeline = function (desc) {
        const pipeline = createRenderPipeline.call(this, desc);
        recordPipeline(pipeline, desc);
        return pipeline;
    };
    const createRenderPipelineAsync = device.createRenderPipelineAsync;
    device.createRenderPipelineAsync = function (desc) {
        return createRenderPipelineAsync.call(this, desc).then((pipeline) => {
            recordPipeline(pipeline, desc);
            return pipeline;
        });
    };

    const writeBuffer = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (
        buffer,
        bufferOffset,
        data,
        dataOffset,
        size,
    ) {
        logWrite(
            { id: identity(buffer), frame, offset: bufferOffset },
            sourceBytes(data, dataOffset, size),
        );
        writeBuffer.call(this, buffer, bufferOffset, data, dataOffset, size);
    };
    const writeTexture = GPUQueue.prototype.writeTexture;
    /**
     * @this {GPUQueue}
     * @param {GPUTexelCopyTextureInfo} destination
     * @param {AllowSharedBufferSource} data
     * @param {GPUTexelCopyBufferLayout} layout
     * @param {GPUExtent3D | Iterable<number>} size
     */
    GPUQueue.prototype.writeTexture = function (
        destination,
        data,
        layout,
        size,
    ) {
        logWrite(
            {
                id: identity(destination.texture),
                frame,
                layout: {
                    offset: layout.offset ?? 0,
                    ...(layout.bytesPerRow === undefined
                        ? {}
                        : { bytesPerRow: layout.bytesPerRow }),
                    ...(layout.rowsPerImage === undefined
                        ? {}
                        : { rowsPerImage: layout.rowsPerImage }),
                },
                mipLevel: destination.mipLevel ?? 0,
                origin: JSON.parse(
                    JSON.stringify(destination.origin ?? [0, 0, 0]),
                ),
                size: JSON.parse(
                    JSON.stringify(
                        Symbol.iterator in size ? Array.from(size) : size,
                    ),
                ),
            },
            sourceBytes(data, undefined, undefined),
        );
        // The same receiver and arguments, whichever overload they select.
        Reflect.apply(writeTexture, this, [destination, data, layout, size]);
    };

    /** @typedef {GPURenderPassEncoder | GPURenderBundleEncoder} Encoder */
    /**
     * @typedef {Omit<RecordedDraw, "method" | "frame" | "args">} Binding
     */
    /** @type {WeakMap<Encoder, Binding & { bundled: Array<Omit<RecordedDraw, "frame">> }>} */
    const states = new WeakMap();
    /** @type {WeakMap<GPURenderBundle, Array<Omit<RecordedDraw, "frame">>>} */
    const bundles = new WeakMap();
    /** @type {RecordedDraw[][]} */
    const submissions = [];
    /** @type {RecordedDraw[]} */
    let pending = [];
    /** @param {Encoder} encoder */
    const state = (encoder) => {
        let current = states.get(encoder);
        if (current === undefined) {
            current = {
                pipeline: null,
                groups: [],
                vertices: [],
                index: null,
                bundled: [],
            };
            states.set(encoder, current);
        }
        return current;
    };
    for (const proto of [
        GPURenderPassEncoder.prototype,
        GPURenderBundleEncoder.prototype,
    ]) {
        const inBundle = proto === GPURenderBundleEncoder.prototype;
        const setPipeline = proto.setPipeline;
        proto.setPipeline = function (pipeline) {
            state(this).pipeline = identity(pipeline);
            setPipeline.call(this, pipeline);
        };
        const setBindGroup = proto.setBindGroup;
        /**
         * @this {Encoder}
         * @param {number} index
         * @param {GPUBindGroup | null} group
         * @param {unknown[]} rest the dynamic offsets, as a list or as a range of a Uint32Array
         */
        proto.setBindGroup = function (index, group, ...rest) {
            state(this).groups[index] = group ? identity(group) : null;
            Reflect.apply(setBindGroup, this, [index, group, ...rest]);
        };
        const setVertexBuffer = proto.setVertexBuffer;
        proto.setVertexBuffer = function (slot, buffer, offset, size) {
            // A null buffer unbinds the slot.
            state(this).vertices[slot] = buffer
                ? {
                      buffer: identity(buffer),
                      offset: offset ?? 0,
                      size: size ?? null,
                  }
                : null;
            setVertexBuffer.call(this, slot, buffer, offset, size);
        };
        const setIndexBuffer = proto.setIndexBuffer;
        proto.setIndexBuffer = function (buffer, format, offset, size) {
            state(this).index = {
                buffer: identity(buffer),
                format,
                offset: offset ?? 0,
                size: size ?? null,
            };
            setIndexBuffer.call(this, buffer, format, offset, size);
        };
        /**
         * @param {Encoder} encoder
         * @param {"draw" | "drawIndexed"} method
         * @param {number[]} args
         */
        const record = (encoder, method, args) => {
            const current = state(encoder);
            const draw = {
                method,
                args,
                pipeline: current.pipeline,
                groups: Array.from(current.groups, (group) => group ?? null),
                vertices: Array.from(
                    current.vertices,
                    (vertex) => vertex ?? null,
                ),
                index: current.index,
            };
            if (inBundle) current.bundled.push(draw);
            else pending.push({ ...draw, frame });
        };
        const draw = proto.draw;
        proto.draw = function (
            vertexCount,
            instanceCount,
            firstVertex,
            firstInstance,
        ) {
            record(this, "draw", [
                vertexCount,
                instanceCount ?? 1,
                firstVertex ?? 0,
                firstInstance ?? 0,
            ]);
            draw.call(
                this,
                vertexCount,
                instanceCount,
                firstVertex,
                firstInstance,
            );
        };
        const drawIndexed = proto.drawIndexed;
        proto.drawIndexed = function (
            indexCount,
            instanceCount,
            firstIndex,
            baseVertex,
            firstInstance,
        ) {
            record(this, "drawIndexed", [
                indexCount,
                instanceCount ?? 1,
                firstIndex ?? 0,
                baseVertex ?? 0,
                firstInstance ?? 0,
            ]);
            drawIndexed.call(
                this,
                indexCount,
                instanceCount,
                firstIndex,
                baseVertex,
                firstInstance,
            );
        };
    }
    const finish = GPURenderBundleEncoder.prototype.finish;
    GPURenderBundleEncoder.prototype.finish = function (desc) {
        const bundle = finish.call(this, desc);
        bundles.set(bundle, state(this).bundled);
        return bundle;
    };
    const executeBundles = GPURenderPassEncoder.prototype.executeBundles;
    GPURenderPassEncoder.prototype.executeBundles = function (values) {
        for (const bundle of values) {
            const draws = bundles.get(bundle);
            if (draws === undefined)
                throw new Error("An unobserved render bundle executed");
            for (const draw of draws) pending.push({ ...draw, frame });
        }
        executeBundles.call(this, values);
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (commandBuffers) {
        submit.call(this, commandBuffers);
        submissions.push(pending);
        if (submissions.length > KEPT_SUBMISSIONS) submissions.shift();
        pending = [];
    };

    /** @param {Uint8Array} bytes */
    const base64 = (bytes) => {
        let text = "";
        for (let index = 0; index < bytes.length; index += 0x8000)
            text += String.fromCharCode(
                ...bytes.subarray(index, index + 0x8000),
            );
        return btoa(text);
    };
    /**
     * The [start, end) ranges a mask has set.
     * @param {Uint8Array} mask
     * @returns {Array<[number, number]>}
     */
    const ranges = (mask) => {
        /** @type {Array<[number, number]>} */
        const found = [];
        let start = -1;
        for (let index = 0; index <= mask.length; index++) {
            const set = index < mask.length && mask[index] === 1;
            if (set && start < 0) start = index;
            if (!set && start >= 0) {
                found.push([start, index]);
                start = -1;
            }
        }
        return found;
    };

    window.__webgpuRecorder = {
        source: undefined,
        identity,
        receipts() {
            return {
                resources,
                writes: writes.map(({ record, bytes }) => ({
                    ...record,
                    data:
                        bytes.byteLength <= RECEIPT_BYTES
                            ? base64(bytes)
                            : null,
                })),
                pipelines,
                groups,
                submissions,
            };
        },
        observation() {
            /** @type {Map<number, { bytes: Uint8Array, written: Uint8Array }>} */
            const states = new Map(
                Array.from(buffers, ([id, buffer]) => [
                    id,
                    {
                        bytes: new Uint8Array(buffer.size),
                        written: new Uint8Array(buffer.size),
                    },
                ]),
            );
            for (const { record, bytes } of writes) {
                const buffer = states.get(record.id);
                if (buffer === undefined || record.offset === undefined)
                    continue;
                buffer.bytes.set(bytes, record.offset);
                buffer.written.fill(
                    1,
                    record.offset,
                    record.offset + bytes.byteLength,
                );
            }
            return {
                buffers: Array.from(buffers, ([id, buffer]) => {
                    const current = states.get(id);
                    if (current === undefined)
                        throw new Error(`Buffer ${id} has no state`);
                    return {
                        id,
                        ...buffer,
                        data: base64(current.bytes),
                        written: ranges(current.written),
                    };
                }),
                pipelines,
                groups,
                submissions,
            };
        },
        describeMeshes(meshes) {
            return meshes.map((mesh) => ({
                name: mesh.name,
                material: identity(mesh.material),
                worldType: mesh.worldMatrix.constructor.name,
                worldBytes: Array.from(
                    new Uint8Array(
                        mesh.worldMatrix.buffer,
                        mesh.worldMatrix.byteOffset,
                        mesh.worldMatrix.byteLength,
                    ),
                ),
                gpuBuffers: {
                    positionBuffer: identity(mesh._gpu.positionBuffer),
                    normalBuffer: identity(mesh._gpu.normalBuffer),
                    uvBuffer: identity(mesh._gpu.uvBuffer),
                    indexBuffer: identity(mesh._gpu.indexBuffer),
                },
            }));
        },
    };
})();
