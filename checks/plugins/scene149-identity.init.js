// Page init script for scene149-transport: give every WebGPU object an
// identity and record what the check joins against the native nodeGpu
// receipts -- every buffer's current bytes and the ranges written into it,
// every bind group and render pipeline, and, for the submissions an
// observation step asks for, every draw with the pipeline, bind groups,
// vertex and index buffers bound (render-bundle draws expanded where the
// bundle executes). The source hook hands over the scene's material map, and
// `materials()` resolves each node material to its albedo texture, view,
// sampler and meshes by the same identities.
(() => {
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

    /**
     * A buffer's bytes as the page wrote them, and which of them it wrote.
     * @typedef {{ id: number, label: string, size: number, usage: number, bytes: Uint8Array, written: Uint8Array }} ShadowBuffer
     */
    /** @type {Map<number, ShadowBuffer>} */
    const buffers = new Map();
    /**
     * @param {GPUBuffer} buffer
     * @param {number} offset
     * @param {Uint8Array} bytes
     */
    const write = (buffer, offset, bytes) => {
        const shadow = buffers.get(identity(buffer));
        if (shadow === undefined) return;
        shadow.bytes.set(bytes, offset);
        shadow.written.fill(1, offset, offset + bytes.byteLength);
    };
    /** @type {IdentityBindGroup[]} */
    const groups = [];
    /** @type {IdentityPipeline[]} */
    const pipelines = [];
    /** @type {IdentityDraw[][]} */
    const submissions = [];
    /** @type {IdentityDraw[]} */
    let pending = [];
    let remaining = 0;

    const device = GPUDevice.prototype;
    const createBuffer = device.createBuffer;
    device.createBuffer = function (desc) {
        const buffer = createBuffer.call(this, desc);
        buffers.set(identity(buffer), {
            id: identity(buffer),
            label: desc.label ?? "",
            size: desc.size,
            usage: desc.usage,
            bytes: new Uint8Array(desc.size),
            written: new Uint8Array(desc.size),
        });
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
                    write(buffer, entry.offset, new Uint8Array(entry.range));
                ranges.length = 0;
                unmap();
            };
        }
        return buffer;
    };
    const writeBuffer = GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer = function (
        buffer,
        bufferOffset,
        data,
        dataOffset,
        size,
    ) {
        // dataOffset and size count elements of a typed array, bytes otherwise.
        const view = ArrayBuffer.isView(data);
        const unit =
            view && "BYTES_PER_ELEMENT" in data
                ? Number(data.BYTES_PER_ELEMENT)
                : 1;
        const source = view
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
            : new Uint8Array(data);
        const begin = (dataOffset ?? 0) * unit;
        const end =
            size === undefined ? source.byteLength : begin + size * unit;
        write(buffer, bufferOffset, source.subarray(begin, end));
        return writeBuffer.call(
            this,
            buffer,
            bufferOffset,
            data,
            dataOffset,
            size,
        );
    };
    const createBindGroup = device.createBindGroup;
    device.createBindGroup = function (desc) {
        const group = createBindGroup.call(this, desc);
        groups.push({
            id: identity(group),
            entries: Array.from(desc.entries, ({ binding, resource }) => ({
                binding,
                resource: identity(
                    "buffer" in resource ? resource.buffer : resource,
                ),
            })),
        });
        return group;
    };
    /**
     * @param {GPURenderPipeline} pipeline
     * @param {GPURenderPipelineDescriptor} desc
     */
    const recordPipeline = (pipeline, desc) => {
        pipelines.push({
            id: identity(pipeline),
            vertex: {
                buffers: Array.from(desc.vertex.buffers ?? [], (layout) =>
                    layout === null
                        ? null
                        : {
                              arrayStride: layout.arrayStride,
                              attributes: Array.from(
                                  layout.attributes,
                                  ({ format, offset }) => ({ format, offset }),
                              ),
                          },
                ),
            },
            fragment: {
                targets: Array.from(desc.fragment?.targets ?? [], (target) =>
                    target === null ? null : { format: target.format },
                ),
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

    /** @typedef {GPURenderPassEncoder | GPURenderBundleEncoder} Encoder */
    /** @type {WeakMap<Encoder, IdentityBinding & { draws: IdentityDraw[] }>} */
    const states = new WeakMap();
    /** @type {WeakMap<GPURenderBundle, IdentityDraw[]>} */
    const bundles = new WeakMap();
    /** @param {Encoder} encoder */
    const state = (encoder) => {
        let current = states.get(encoder);
        if (current === undefined) {
            current = {
                pipeline: null,
                groups: {},
                vertices: {},
                index: null,
                draws: [],
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
            const groupsBound = state(this).groups;
            if (group === null) delete groupsBound[index];
            else groupsBound[index] = { group: identity(group) };
            Reflect.apply(setBindGroup, this, [index, group, ...rest]);
        };
        const setVertexBuffer = proto.setVertexBuffer;
        proto.setVertexBuffer = function (slot, buffer, offset, size) {
            const vertices = state(this).vertices;
            if (buffer === null) delete vertices[slot];
            else
                vertices[slot] = {
                    buffer: identity(buffer),
                    offset: offset ?? 0,
                };
            setVertexBuffer.call(this, slot, buffer, offset, size);
        };
        const setIndexBuffer = proto.setIndexBuffer;
        proto.setIndexBuffer = function (buffer, format, offset, size) {
            state(this).index = {
                buffer: identity(buffer),
                format,
                offset: offset ?? 0,
            };
            setIndexBuffer.call(this, buffer, format, offset, size);
        };
        /**
         * @param {Encoder} encoder
         * @param {IdentityDraw} draw
         */
        const record = (encoder, draw) => {
            if (inBundle) state(encoder).draws.push(draw);
            else if (remaining > 0) pending.push(draw);
        };
        const draw = proto.draw;
        proto.draw = function (
            vertexCount,
            instanceCount,
            firstVertex,
            firstInstance,
        ) {
            record(this, {
                method: "draw",
                args: [
                    vertexCount,
                    instanceCount ?? 1,
                    firstVertex ?? 0,
                    firstInstance ?? 0,
                ],
            });
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
            const current = state(this);
            record(this, {
                method: "drawIndexed",
                args: [
                    indexCount,
                    instanceCount ?? 1,
                    firstIndex ?? 0,
                    baseVertex ?? 0,
                    firstInstance ?? 0,
                ],
                pipeline: current.pipeline,
                groups: { ...current.groups },
                vertices: { ...current.vertices },
                index: current.index && { ...current.index },
            });
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
        bundles.set(bundle, state(this).draws);
        return bundle;
    };
    const executeBundles = GPURenderPassEncoder.prototype.executeBundles;
    GPURenderPassEncoder.prototype.executeBundles = function (values) {
        if (remaining > 0) {
            for (const bundle of values) {
                const draws = bundles.get(bundle);
                if (draws === undefined)
                    throw new Error("An unobserved render bundle executed");
                pending.push(...draws);
            }
        }
        executeBundles.call(this, values);
    };
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function (commandBuffers) {
        submit.call(this, commandBuffers);
        if (remaining > 0) {
            submissions.push(pending);
            pending = [];
            remaining -= 1;
        }
    };

    /**
     * The written ranges of a mask, as [start, end) pairs.
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
    /** @param {Uint8Array} bytes */
    const base64 = (bytes) => {
        let text = "";
        for (let index = 0; index < bytes.length; index += 0x8000)
            text += String.fromCharCode(
                ...bytes.subarray(index, index + 0x8000),
            );
        return btoa(text);
    };

    window.__scene149Identity = {
        source: undefined,
        submissions,
        /** @param {number} count */
        record(count) {
            pending = [];
            remaining = count;
        },
        materials() {
            const source = this.source;
            if (source === undefined)
                throw new Error(
                    "The scene hook did not hand over its materials",
                );
            return [...source.byMaterial].map(([original, meshes]) => {
                const [first] = meshes;
                if (first === undefined)
                    throw new Error("A material without meshes was listed");
                const material = first.material;
                const albedo = material.inputs.albedo.texture;
                const authored =
                    original.baseColorTexture ?? original.diffuseTexture;
                return {
                    original: identity(original),
                    material: identity(material),
                    texture: identity(albedo.texture),
                    view: identity(albedo.view),
                    sampler: identity(albedo.sampler),
                    sameSourceTexture: (authored ?? albedo) === albedo,
                    sameOwner: meshes.every(
                        (mesh) => mesh.material === material,
                    ),
                    meshes: meshes.map((mesh) => ({
                        name: mesh.name,
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
                    })),
                };
            });
        },
        observation() {
            return {
                buffers: Array.from(buffers.values(), (buffer) => ({
                    id: buffer.id,
                    label: buffer.label,
                    size: buffer.size,
                    usage: buffer.usage,
                    data: base64(buffer.bytes),
                    written: ranges(buffer.written),
                })),
                groups,
                pipelines,
                submissions,
            };
        },
    };
})();
