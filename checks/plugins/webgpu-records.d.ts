// The JSON records checks/plugins/webgpu-recorder.init.js returns from an
// observed page, as the check plugins read them. Strings stand for WebGPU
// enums, so the Node-side plugins need no DOM declarations.

/** A buffer, texture, sampler or texture view, by identity. */
export type RecordedResource =
    | { id: number; kind: "buffer"; label: string; size: number; usage: number }
    | {
          id: number;
          kind: "texture";
          label: string;
          size: { width: number; height: number };
          format: string;
          usage: number;
      }
    | { id: number; kind: "sampler"; label: string }
    | { id: number; kind: "view"; label: string; texture: number };

/** A buffer or texture upload, in page order. */
export interface RecordedWrite {
    /** The buffer or texture written. */
    id: number;
    /** The animation frame the write happened in. */
    frame: number;
    /** A buffer write's byte offset. */
    offset?: number;
    /** A texture write's data layout. */
    layout?: { offset: number; bytesPerRow?: number; rowsPerImage?: number };
    mipLevel?: number;
    origin?: unknown;
    size?: unknown;
    /** The written bytes as base64; null past 1 MiB. */
    data: string | null;
    byteLength: number;
    /** Written through a mapping at creation. */
    mapped?: boolean;
}

/** A buffer's bytes after every recorded write, and the ranges written. */
export interface RecordedBufferState {
    id: number;
    label: string;
    size: number;
    usage: number;
    /** base64 */
    data: string;
    /** [start, end) byte ranges some write covered. */
    written: Array<[number, number]>;
}

export interface RecordedBindGroup {
    id: number;
    label: string;
    entries: Array<{
        binding: number;
        resource: number;
        offset?: number;
        size?: number | null;
    }>;
}

export interface RecordedBlendComponent {
    srcFactor?: string;
    dstFactor?: string;
    operation?: string;
}

export interface RecordedPipeline {
    id: number;
    label: string;
    vertex: {
        constants: Record<string, number>;
        buffers: Array<{
            arrayStride: number;
            stepMode?: string;
            attributes: Array<{
                format: string;
                offset: number;
                shaderLocation: number;
            }>;
        } | null>;
    };
    fragment: {
        constants: Record<string, number>;
        targets: Array<{
            format: string;
            blend?: {
                color: RecordedBlendComponent;
                alpha: RecordedBlendComponent;
            };
            writeMask?: number;
        } | null>;
    } | null;
    depthStencil: {
        format: string;
        depthCompare?: string;
        depthWriteEnabled?: boolean;
    } | null;
    primitive: { topology?: string; cullMode?: string; frontFace?: string };
    multisample: {
        count?: number;
        mask?: number;
        alphaToCoverageEnabled?: boolean;
    };
}

/** A draw as it executed: in a pass, or from a render bundle the pass executed. */
export interface RecordedDraw {
    method: "draw" | "drawIndexed";
    frame: number;
    args: number[];
    pipeline: number | null;
    /** Bound groups by index; null where none is bound. */
    groups: Array<number | null>;
    /** Bound vertex buffers by slot; null where none is bound. */
    vertices: Array<{
        buffer: number;
        offset: number;
        size: number | null;
    } | null>;
    index: {
        buffer: number;
        format: string;
        offset: number;
        size: number | null;
    } | null;
}

/** Every upload since the page started, with the current objects. */
export interface RecordedReceipts {
    resources: RecordedResource[];
    writes: RecordedWrite[];
    pipelines: RecordedPipeline[];
    groups: RecordedBindGroup[];
    /** The draws of the last two queue submissions, oldest first. */
    submissions: RecordedDraw[][];
}

/** Every buffer's current bytes, with the current objects. */
export interface RecordedObservation {
    buffers: RecordedBufferState[];
    pipelines: RecordedPipeline[];
    groups: RecordedBindGroup[];
    /** The draws of the last two queue submissions, oldest first. */
    submissions: RecordedDraw[][];
}

/** A mesh by the identities of its material, GPU buffers and world matrix bytes. */
export interface RecordedMesh {
    name: string;
    material: number;
    worldType: string;
    worldBytes: number[];
    gpuBuffers: {
        positionBuffer: number;
        normalBuffer: number;
        uvBuffer: number;
        indexBuffer: number;
    };
}
