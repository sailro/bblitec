/**
 * The recording GPU device every generation-time producer runs a pinned
 * factory against.
 *
 * Executing a pinned factory under Node (the ESM generator, the text
 * pipeline, the node-material compiler, the post-process and screen-space
 * tasks, the local cubemap packer, the CSG mesh upload, the glTF albedo
 * probe, the cascaded receiver registration) means answering the WebGPU
 * calls it makes without a device. What generation wants from those calls
 * is what they CARRY -- a texture's descriptor, a shader module's code, a
 * pipeline's targets, the bytes a queue write hands over -- so one device
 * records them and each producer reads its answers off the recording.
 *
 * The device is strict. A producer names the methods its pinned factory is
 * allowed to reach, and a call outside that contract throws naming the
 * producer and the method rather than answering with a handle: a pin that
 * grew a new device call fails at generation instead of composing less. The
 * same rule holds for the queue, the command encoder and a render pass.
 *
 * Handles keep the WebGPU shape the pinned code reads back: a texture
 * carries its extent, format and mip count and hands out views; a buffer
 * created mapped hands out its whole range and keeps the bytes a queue
 * write lands in; every other resource is a copy of the descriptor it was
 * created from, so a pin reading its own descriptor back off the handle
 * (the text pipeline's `_pipeline.vertex.module.code`) still can.
 *
 * This module imports nothing: the CSG2 bake serves it to a Chromium page
 * verbatim, so the browser replay records through the same device Node does.
 */

export type DeviceMethod =
    | "createBuffer"
    | "createTexture"
    | "createSampler"
    | "createShaderModule"
    | "createBindGroupLayout"
    | "createPipelineLayout"
    | "createRenderPipeline"
    | "createBindGroup"
    | "createCommandEncoder";

export type QueueMethod =
    | "writeBuffer"
    | "writeTexture"
    | "copyExternalImageToTexture"
    | "submit";

export type EncoderMethod = "beginRenderPass" | "copyTextureToTexture" | "finish";

export type RenderPassMethod =
    | "setPipeline"
    | "setBindGroup"
    | "draw"
    | "setViewport"
    | "setScissorRect"
    | "end";

/** What one producer lets its pinned factory reach. */
export interface RecordingContract {
    /** Names the producer in every refusal. */
    readonly producer: string;
    readonly device: readonly DeviceMethod[];
    readonly queue?: readonly QueueMethod[];
    readonly encoder?: readonly EncoderMethod[];
    readonly renderPass?: readonly RenderPassMethod[];
    /** Data members the pinned code reads off the device (`limits`). */
    readonly deviceFields?: Readonly<Record<string, unknown>>;
}

/** A WebGPU extent, in either of the two spellings the specification admits. */
export type GpuExtent =
    | readonly number[]
    | {
          readonly width: number;
          readonly height?: number;
          readonly depthOrArrayLayers?: number;
      };

/** A WebGPU origin, in either of the two spellings the specification admits. */
export type GpuOrigin =
    | readonly number[]
    | { readonly x?: number; readonly y?: number; readonly z?: number };

export interface RecordedExtent {
    readonly width: number;
    readonly height: number;
    readonly depthOrArrayLayers: number;
}

export interface RecordedOrigin {
    readonly x: number;
    readonly y: number;
    readonly z: number;
}

/** The texture descriptor members the recorder reads; a pin may pass more. */
export interface RecordedTextureDescriptor {
    readonly label?: string;
    readonly size: GpuExtent;
    readonly mipLevelCount?: number;
    readonly sampleCount?: number;
    readonly dimension?: string;
    readonly format: string;
    readonly usage: number;
}

export interface RecordedBufferDescriptor {
    readonly label?: string;
    readonly size: number;
    readonly usage?: number;
    readonly mappedAtCreation?: boolean;
}

export interface RecordedViewDescriptor {
    readonly label?: string;
    readonly format?: string;
    readonly dimension?: string;
    readonly aspect?: string;
    readonly baseMipLevel?: number;
    readonly mipLevelCount?: number;
    readonly baseArrayLayer?: number;
    readonly arrayLayerCount?: number;
}

/**
 * The descriptor shapes a producer expects the pin to pass for the six
 * handle kinds that are returned as copies of their descriptor. A producer
 * declares the members it reads back; the recorder itself reads none.
 */
export interface DescriptorShapes {
    sampler: object;
    shaderModule: object;
    bindGroupLayout: object;
    pipelineLayout: object;
    renderPipeline: object;
    bindGroup: object;
}

export type RecordedKind =
    | "texture"
    | "textureView"
    | "buffer"
    | keyof DescriptorShapes;

/** One `queue.writeTexture` or `queue.copyExternalImageToTexture` a texture received. */
export type RecordedTextureUpload =
    | {
          readonly kind: "write";
          readonly mipLevel: number;
          readonly origin: RecordedOrigin;
          readonly bytes: Uint8Array;
          readonly layout: unknown;
          readonly size: RecordedExtent;
      }
    | {
          readonly kind: "external";
          readonly mipLevel: number;
          readonly origin: RecordedOrigin;
          /** The pin's `GPUImageCopyExternalImage`, as it passed it. */
          readonly source: unknown;
          readonly size: RecordedExtent;
      };

export class RecordedTextureView {
    public constructor(
        public readonly texture: RecordedTexture,
        public readonly descriptor: RecordedViewDescriptor,
    ) {}
}

/** A texture the device created, carrying what `GPUTexture` exposes. */
export class RecordedTexture {
    public readonly label: string;
    public readonly width: number;
    public readonly height: number;
    public readonly depthOrArrayLayers: number;
    public readonly mipLevelCount: number;
    public readonly sampleCount: number;
    public readonly dimension: string;
    public readonly format: string;
    public readonly usage: number;
    public readonly views: RecordedTextureView[] = [];
    public readonly uploads: RecordedTextureUpload[] = [];
    public destroyed = false;

    public constructor(public readonly descriptor: RecordedTextureDescriptor) {
        const size = recordedExtent(descriptor.size);
        this.label = descriptor.label ?? "";
        this.width = size.width;
        this.height = size.height;
        this.depthOrArrayLayers = size.depthOrArrayLayers;
        this.mipLevelCount = descriptor.mipLevelCount ?? 1;
        this.sampleCount = descriptor.sampleCount ?? 1;
        this.dimension = descriptor.dimension ?? "2d";
        this.format = descriptor.format;
        this.usage = descriptor.usage;
    }

    public createView(descriptor: RecordedViewDescriptor = {}): RecordedTextureView {
        const view = new RecordedTextureView(this, descriptor);
        this.views.push(view);
        return view;
    }

    public destroy(): void {
        this.destroyed = true;
    }
}

/**
 * A buffer the device created. The bytes are the buffer's contents: a
 * mapped range is written into them by the pin, and a queue write lands in
 * them at its offset, so a producer reads a uniform block back the way the
 * device would hold it.
 */
export class RecordedBuffer {
    public readonly label: string;
    public readonly size: number;
    public readonly usage: number;
    public readonly mappedAtCreation: boolean;
    public readonly bytes: ArrayBuffer;
    public destroyed = false;
    private mapped: boolean;

    public constructor(
        public readonly descriptor: RecordedBufferDescriptor,
        private readonly producer: string,
    ) {
        this.label = descriptor.label ?? "";
        this.size = descriptor.size;
        this.usage = descriptor.usage ?? 0;
        this.mappedAtCreation = descriptor.mappedAtCreation === true;
        this.bytes = new ArrayBuffer(this.size);
        this.mapped = this.mappedAtCreation;
    }

    /**
     * The whole mapped range. A sub-range is refused rather than answered
     * with the whole buffer, which would silently misplace the pin's write.
     */
    public getMappedRange(offset = 0, size = this.size - offset): ArrayBuffer {
        if (!this.mapped) {
            throw new Error(
                `Recording device for '${this.producer}': buffer ` +
                    `'${this.label}' is not mapped; a range was asked for ` +
                    "outside a mapped-at-creation window.",
            );
        }
        if (offset !== 0 || size !== this.size) {
            throw new Error(
                `Recording device for '${this.producer}': buffer ` +
                    `'${this.label}' was asked for a mapped sub-range ` +
                    `(${offset}, ${size} of ${this.size}), which this ` +
                    "recorder does not carry.",
            );
        }
        return this.bytes;
    }

    public unmap(): void {
        this.mapped = false;
    }

    public destroy(): void {
        this.destroyed = true;
    }
}

export interface RecordedBufferWrite {
    readonly buffer: RecordedBuffer;
    readonly offset: number;
    /** A copy taken at the call, since the pin reuses its scratch arrays. */
    readonly bytes: Uint8Array;
}

export interface RecordedTextureCopyLocation {
    readonly texture: RecordedTexture;
    readonly mipLevel: number;
    readonly origin: RecordedOrigin;
}

export interface RecordedTextureCopy {
    readonly source: RecordedTextureCopyLocation;
    readonly destination: RecordedTextureCopyLocation;
    readonly size: RecordedExtent;
}

/** The render-pass descriptor members the recorder reads; a pin passes more. */
export interface RecordedRenderPassDescriptor {
    readonly label?: string;
    readonly colorAttachments: readonly {
        readonly view: RecordedTextureView;
        readonly loadOp: string;
        readonly storeOp?: string;
    }[];
    readonly depthStencilAttachment?: { readonly view: RecordedTextureView };
}

export interface RecordedRenderPass<S extends DescriptorShapes> {
    readonly descriptor: RecordedRenderPassDescriptor;
    pipeline?: S["renderPipeline"];
    readonly bindGroups: { readonly index: number; readonly group: S["bindGroup"] }[];
    /** Each `draw` call's arguments, as passed. */
    readonly draws: (readonly number[])[];
    ended: boolean;
}

/** The device surface a producer's pinned factory calls, typed by its shapes. */
export interface RecordedDeviceMethods<S extends DescriptorShapes> {
    createBuffer(descriptor: RecordedBufferDescriptor): RecordedBuffer;
    createTexture(descriptor: RecordedTextureDescriptor): RecordedTexture;
    createSampler(descriptor: S["sampler"]): S["sampler"];
    createShaderModule(descriptor: S["shaderModule"]): S["shaderModule"];
    createBindGroupLayout(descriptor: S["bindGroupLayout"]): S["bindGroupLayout"];
    createPipelineLayout(descriptor: S["pipelineLayout"]): S["pipelineLayout"];
    createRenderPipeline(descriptor: S["renderPipeline"]): S["renderPipeline"];
    createBindGroup(descriptor: S["bindGroup"]): S["bindGroup"];
    createCommandEncoder(descriptor?: { readonly label?: string }): object;
}

/** Everything a device recorded, in call order per kind. */
export interface Recorder<S extends DescriptorShapes> {
    readonly textures: readonly RecordedTexture[];
    readonly buffers: readonly RecordedBuffer[];
    readonly samplers: readonly S["sampler"][];
    readonly shaderModules: readonly S["shaderModule"][];
    readonly bindGroupLayouts: readonly S["bindGroupLayout"][];
    readonly pipelineLayouts: readonly S["pipelineLayout"][];
    readonly renderPipelines: readonly S["renderPipeline"][];
    readonly bindGroups: readonly S["bindGroup"][];
    readonly bufferWrites: readonly RecordedBufferWrite[];
    readonly textureCopies: readonly RecordedTextureCopy[];
    readonly renderPasses: readonly RecordedRenderPass<S>[];
    /** How many command buffers `queue.submit` received. */
    readonly submitted: number;
    /** Which kind of handle this device created `value` as, if any. */
    kindOf(value: unknown): RecordedKind | undefined;
}

export interface RecordingDevice<S extends DescriptorShapes> {
    /** Hand this to the pinned factory as `engine._device`. */
    readonly device: RecordedDeviceMethods<S>;
    /**
     * The one command encoder, for a factory that encodes through
     * `engine._currentEncoder`; `createCommandEncoder` answers with it too.
     */
    readonly encoder: object;
    readonly recorder: Recorder<S>;
}

function isSequence(value: GpuExtent | GpuOrigin): value is readonly number[] {
    return Array.isArray(value);
}

function recordedExtent(extent: GpuExtent): RecordedExtent {
    if (isSequence(extent)) {
        const [width = 1, height = 1, depthOrArrayLayers = 1] = extent;
        return { width, height, depthOrArrayLayers };
    }
    return {
        width: extent.width,
        height: extent.height ?? 1,
        depthOrArrayLayers: extent.depthOrArrayLayers ?? 1,
    };
}

function recordedOrigin(origin: GpuOrigin | undefined): RecordedOrigin {
    if (origin === undefined) return { x: 0, y: 0, z: 0 };
    if (isSequence(origin)) {
        const [x = 0, y = 0, z = 0] = origin;
        return { x, y, z };
    }
    return { x: origin.x ?? 0, y: origin.y ?? 0, z: origin.z ?? 0 };
}

/**
 * The bytes a `BufferSource` argument names, as WebGPU reads them: a typed
 * array's `dataOffset` and `size` count its own elements, an `ArrayBuffer`'s
 * count bytes.
 */
function bufferSourceBytes(
    data: ArrayBuffer | ArrayBufferView,
    dataOffset = 0,
    size?: number,
): Uint8Array {
    if (ArrayBuffer.isView(data)) {
        const elementBytes =
            "BYTES_PER_ELEMENT" in data && typeof data.BYTES_PER_ELEMENT === "number"
                ? data.BYTES_PER_ELEMENT
                : 1;
        const elements = data.byteLength / elementBytes;
        const count = size ?? elements - dataOffset;
        return new Uint8Array(
            data.buffer,
            data.byteOffset + dataOffset * elementBytes,
            count * elementBytes,
        );
    }
    return new Uint8Array(data, dataOffset, size ?? data.byteLength - dataOffset);
}

type SurfaceMethod = (...args: never[]) => unknown;

/**
 * A surface (device, queue, encoder, render pass) that answers exactly the
 * listed methods and the given data fields, and refuses everything else by
 * name.
 */
function strictSurface(
    producer: string,
    surface: string,
    allowed: readonly string[],
    methods: Readonly<Record<string, SurfaceMethod>>,
    fields: Readonly<Record<string, unknown>> = {},
): object {
    const listed = new Set<string>(allowed);
    for (const name of listed) {
        if (!Object.hasOwn(methods, name)) {
            throw new Error(
                `Recording ${surface} for '${producer}' lists '${name}', ` +
                    "which this recorder does not implement.",
            );
        }
    }
    const refuse = (key: string, verb: string): never => {
        throw new Error(
            `Recording ${surface} for '${producer}' does not ${verb} '${key}'; ` +
                "the pinned code reached a GPU call outside the producer's contract.",
        );
    };
    return new Proxy(
        {},
        {
            get: (_target, key) => {
                if (typeof key === "symbol") return undefined;
                if (Object.hasOwn(fields, key)) return fields[key];
                if (listed.has(key)) return methods[key];
                return refuse(key, "answer");
            },
            has: (_target, key) =>
                typeof key === "string" &&
                (listed.has(key) || Object.hasOwn(fields, key)),
            set: (_target, key) => refuse(String(key), "accept a write to"),
        },
    );
}

/**
 * One recording device for one producer.
 *
 * `S` declares the descriptor shapes the producer reads back off the six
 * copied-descriptor kinds; the recorder trusts them the way a typed stub
 * parameter would, and the pin's own text decides what is actually passed.
 */
export function createRecordingDevice<S extends DescriptorShapes = DescriptorShapes>(
    contract: RecordingContract,
): RecordingDevice<S> {
    const producer = contract.producer;
    const kinds = new WeakMap<object, RecordedKind>();
    const textures: RecordedTexture[] = [];
    const buffers: RecordedBuffer[] = [];
    const samplers: S["sampler"][] = [];
    const shaderModules: S["shaderModule"][] = [];
    const bindGroupLayouts: S["bindGroupLayout"][] = [];
    const pipelineLayouts: S["pipelineLayout"][] = [];
    const renderPipelines: S["renderPipeline"][] = [];
    const bindGroups: S["bindGroup"][] = [];
    const bufferWrites: RecordedBufferWrite[] = [];
    const textureCopies: RecordedTextureCopy[] = [];
    const renderPasses: RecordedRenderPass<S>[] = [];
    let submitted = 0;

    const kindOf = (value: unknown): RecordedKind | undefined => {
        if (value instanceof RecordedTexture) return "texture";
        if (value instanceof RecordedTextureView) return "textureView";
        if (value instanceof RecordedBuffer) return "buffer";
        return typeof value === "object" && value !== null
            ? kinds.get(value)
            : undefined;
    };

    const copied = <K extends keyof DescriptorShapes>(
        kind: K,
        into: S[K][],
        descriptor: S[K],
        method: string,
    ): S[K] => {
        if (typeof descriptor !== "object" || descriptor === null) {
            throw new Error(
                `Recording device for '${producer}': ${method} was handed ` +
                    "no descriptor object.",
            );
        }
        const handle: S[K] = { ...descriptor };
        kinds.set(handle, kind);
        into.push(handle);
        return handle;
    };

    const recordedTexture = (value: unknown, what: string): RecordedTexture => {
        if (value instanceof RecordedTexture) return value;
        throw new Error(
            `Recording device for '${producer}': ${what} is not a texture ` +
                "this device created.",
        );
    };

    const recordedBuffer = (value: unknown, what: string): RecordedBuffer => {
        if (value instanceof RecordedBuffer) return value;
        throw new Error(
            `Recording device for '${producer}': ${what} is not a buffer ` +
                "this device created.",
        );
    };

    const copyLocation = (
        location: { texture: unknown; mipLevel?: number; origin?: GpuOrigin },
        what: string,
    ): RecordedTextureCopyLocation => ({
        texture: recordedTexture(location.texture, what),
        mipLevel: location.mipLevel ?? 0,
        origin: recordedOrigin(location.origin),
    });

    const renderPassSurface = (pass: RecordedRenderPass<S>): object =>
        strictSurface(producer, "render pass", contract.renderPass ?? [], {
            setPipeline: (pipeline: S["renderPipeline"]) => {
                if (kindOf(pipeline) !== "renderPipeline") {
                    throw new Error(
                        `Recording device for '${producer}': a render pass ` +
                            "set a pipeline this device did not create.",
                    );
                }
                pass.pipeline = pipeline;
            },
            setBindGroup: (index: number, group: S["bindGroup"]) => {
                if (kindOf(group) !== "bindGroup") {
                    throw new Error(
                        `Recording device for '${producer}': a render pass ` +
                            "bound a group this device did not create.",
                    );
                }
                pass.bindGroups.push({ index, group });
            },
            draw: (...counts: number[]) => {
                pass.draws.push(counts);
            },
            setViewport: () => undefined,
            setScissorRect: () => undefined,
            end: () => {
                pass.ended = true;
            },
        });

    const encoder = strictSurface(producer, "command encoder", contract.encoder ?? [], {
        beginRenderPass: (descriptor: RecordedRenderPassDescriptor) => {
            for (const attachment of descriptor.colorAttachments) {
                if (kindOf(attachment.view) !== "textureView") {
                    throw new Error(
                        `Recording device for '${producer}': a render pass ` +
                            "attached a view this device did not create.",
                    );
                }
            }
            const pass: RecordedRenderPass<S> = {
                descriptor,
                bindGroups: [],
                draws: [],
                ended: false,
            };
            renderPasses.push(pass);
            return renderPassSurface(pass);
        },
        copyTextureToTexture: (
            source: { texture: unknown; mipLevel?: number; origin?: GpuOrigin },
            destination: { texture: unknown; mipLevel?: number; origin?: GpuOrigin },
            size: GpuExtent,
        ) => {
            textureCopies.push({
                source: copyLocation(source, "a texture copy's source"),
                destination: copyLocation(destination, "a texture copy's destination"),
                size: recordedExtent(size),
            });
        },
        finish: () => ({}),
    });

    const queue = strictSurface(producer, "queue", contract.queue ?? [], {
        writeBuffer: (
            buffer: unknown,
            offset: number,
            data: ArrayBuffer | ArrayBufferView,
            dataOffset?: number,
            size?: number,
        ) => {
            const target = recordedBuffer(buffer, "a queue write's buffer");
            const bytes = bufferSourceBytes(data, dataOffset, size).slice();
            if (offset + bytes.byteLength > target.size) {
                throw new Error(
                    `Recording device for '${producer}': a queue write of ` +
                        `${bytes.byteLength} bytes at ${offset} overflows ` +
                        `buffer '${target.label}' of ${target.size} bytes.`,
                );
            }
            new Uint8Array(target.bytes, offset, bytes.byteLength).set(bytes);
            bufferWrites.push({ buffer: target, offset, bytes });
        },
        writeTexture: (
            destination: { texture: unknown; mipLevel?: number; origin?: GpuOrigin },
            data: ArrayBuffer | ArrayBufferView,
            layout: unknown,
            size: GpuExtent,
        ) => {
            const location = copyLocation(destination, "a texture write's destination");
            location.texture.uploads.push({
                kind: "write",
                mipLevel: location.mipLevel,
                origin: location.origin,
                bytes: bufferSourceBytes(data).slice(),
                layout,
                size: recordedExtent(size),
            });
        },
        copyExternalImageToTexture: (
            source: unknown,
            destination: { texture: unknown; mipLevel?: number; origin?: GpuOrigin },
            size: GpuExtent,
        ) => {
            const location = copyLocation(destination, "an external image copy's destination");
            location.texture.uploads.push({
                kind: "external",
                mipLevel: location.mipLevel,
                origin: location.origin,
                source,
                size: recordedExtent(size),
            });
        },
        submit: (commandBuffers: readonly unknown[]) => {
            submitted += commandBuffers.length;
        },
    });

    const deviceFields: Record<string, unknown> = { ...(contract.deviceFields ?? {}) };
    if (contract.queue !== undefined) deviceFields["queue"] = queue;

    const methods: Readonly<Record<DeviceMethod, SurfaceMethod>> = {
        createBuffer: (descriptor: RecordedBufferDescriptor) => {
            const buffer = new RecordedBuffer(descriptor, producer);
            buffers.push(buffer);
            return buffer;
        },
        createTexture: (descriptor: RecordedTextureDescriptor) => {
            const texture = new RecordedTexture(descriptor);
            textures.push(texture);
            return texture;
        },
        createSampler: (descriptor: S["sampler"]) =>
            copied("sampler", samplers, descriptor, "createSampler"),
        createShaderModule: (descriptor: S["shaderModule"]) =>
            copied("shaderModule", shaderModules, descriptor, "createShaderModule"),
        createBindGroupLayout: (descriptor: S["bindGroupLayout"]) =>
            copied("bindGroupLayout", bindGroupLayouts, descriptor, "createBindGroupLayout"),
        createPipelineLayout: (descriptor: S["pipelineLayout"]) =>
            copied("pipelineLayout", pipelineLayouts, descriptor, "createPipelineLayout"),
        createRenderPipeline: (descriptor: S["renderPipeline"]) =>
            copied("renderPipeline", renderPipelines, descriptor, "createRenderPipeline"),
        createBindGroup: (descriptor: S["bindGroup"]) =>
            copied("bindGroup", bindGroups, descriptor, "createBindGroup"),
        createCommandEncoder: () => encoder,
    };
    // A Proxy carries no type of its own; the one assertion in this module
    // names the surface the method table above implements member for member.
    const device = strictSurface(
        producer,
        "device",
        contract.device,
        methods,
        deviceFields,
    ) as RecordedDeviceMethods<S>;

    return {
        device,
        encoder,
        recorder: {
            textures,
            buffers,
            samplers,
            shaderModules,
            bindGroupLayouts,
            pipelineLayouts,
            renderPipelines,
            bindGroups,
            bufferWrites,
            textureCopies,
            renderPasses,
            get submitted() {
                return submitted;
            },
            kindOf,
        },
    };
}

/** The floats a recorded queue write carried, for a producer reading a UBO back. */
export function writtenFloats(write: RecordedBufferWrite): number[] {
    if (write.bytes.byteLength % 4 !== 0) {
        throw new Error(
            `A recorded queue write of ${write.bytes.byteLength} bytes into ` +
                `'${write.buffer.label}' is not a whole number of floats.`,
        );
    }
    return [
        ...new Float32Array(
            write.bytes.buffer,
            write.bytes.byteOffset,
            write.bytes.byteLength / 4,
        ),
    ];
}
