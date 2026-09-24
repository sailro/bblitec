// The globals the check init scripts (checks/plugins/*.init.js) install on an
// observed page, for tsconfig.browser.json.

interface GpuReceiptResource {
    id: number;
    kind: "buffer" | "texture" | "sampler" | "view";
    label: string;
    size?: number | { width: number; height: number };
    usage?: number;
    format?: GPUTextureFormat;
    texture?: number;
}

interface GpuReceiptWrite {
    id: number;
    frame: number;
    offset?: number;
    layout?: {
        offset: number;
        bytesPerRow: number | undefined;
        rowsPerImage: number | undefined;
    };
    mipLevel?: number;
    origin?: unknown;
    size?: unknown;
    bytes: number[] | null;
    byteLength: number;
    mapped?: boolean;
}

interface GpuReceiptGroup {
    id: number;
    label: string;
    entries: Array<{
        binding: number;
        resource: number;
        offset?: number;
        size?: number | null;
    }>;
}

interface GpuReceiptPipeline {
    id: number;
    label: string;
    vertex: { constants: unknown; buffers: unknown };
    fragment: { constants: unknown; targets: unknown } | null;
    depthStencil: unknown;
    primitive: unknown;
    multisample: unknown;
}

interface GpuReceiptBinding {
    pipeline: number | null;
    groups: Array<number | null>;
    vertices: Array<{
        buffer: number | null;
        offset: number;
        size: number | null;
    }>;
    index: {
        buffer: number;
        format: GPUIndexFormat;
        offset: number;
        size: number | null;
    } | null;
}

interface GpuReceiptDraw extends GpuReceiptBinding {
    method: "draw" | "drawIndexed";
    frame: number;
    args: number[];
}

/** checks/plugins/gpu-receipts.init.js's record of a page's WebGPU operations. */
interface GpuReceipts {
    resources: GpuReceiptResource[];
    writes: GpuReceiptWrite[];
    pipelines: GpuReceiptPipeline[];
    groups: GpuReceiptGroup[];
    draws: GpuReceiptDraw[];
    frame: number;
}

/** gpu-receipts.init.js */
declare var __gpuReceipts: GpuReceipts;
/** scene180-uniform.init.js: the text layer uniform bytes, write for write. */
declare var __textUniform: Uint8Array | undefined;
/** raf-pacing.init.js: pace requestAnimationFrame at `rate` frames per second. */
declare var __bblRafPacing: (rate: number) => void;
