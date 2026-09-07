/** Records the actual pin's text GPU descriptors without a device or shader transcription. */
import { importPinnedModule } from "./pinned-shader-composer.js";
import type { ShaderStageConstant } from "./shader-ir.js";

interface TextShaderStage {
    module: { code: string };
    entryPoint: string;
    constants?: Readonly<Record<string, number>>;
}

export interface TextPipelineDescriptor {
    layout: { bindGroupLayouts: readonly TextBindingLayout[] };
    vertex: TextShaderStage & {
        buffers: readonly {
            arrayStride: number;
            stepMode: "vertex" | "instance";
            attributes: readonly { shaderLocation: number; offset: number; format: string }[];
        }[];
    };
    fragment: TextShaderStage & {
        targets: readonly { format: string; blend?: {
            color: { srcFactor: string; dstFactor: string; operation: string };
            alpha: { srcFactor: string; dstFactor: string; operation: string };
        } }[];
    };
    primitive: { topology: string; cullMode: string; frontFace: string };
    multisample: { count: number; alphaToCoverageEnabled?: boolean };
    depthStencil?: { format: string; depthCompare: string; depthWriteEnabled: boolean };
}

interface TextBindingLayout {
    entries: readonly ({ binding: number; visibility: number } & (
        { buffer: { type: "uniform" | "read-only-storage" } } |
        { texture: { sampleType: "unfilterable-float" } }
    ))[];
}

export interface TextPipelineOptions {
    format: string;
    sampleCount: number;
    depthStencilFormat?: string;
    depthWrite: boolean;
    alphaToCoverage: boolean;
}

export interface ComposedTextPipeline {
    descriptor: TextPipelineDescriptor;
    quadCorners: readonly number[];
    vertexConstants: readonly ShaderStageConstant[];
    fragmentConstants: readonly ShaderStageConstant[];
}

function stageConstants(stage: TextShaderStage): ShaderStageConstant[] {
    return Object.entries(stage.constants ?? {}).map(([key, value]) => {
        const id = Number(key);
        if (!Number.isInteger(id) || id < 0 || id > 65535 || String(id) !== key || !Number.isFinite(value)) {
            throw new Error(`Pinned text pipeline constant '${key}' is not a finite numeric override ID/value.`);
        }
        return { id, value };
    }).sort((a, b) => a.id - b.id);
}

/** Descriptor inputs remain the caller's actual target/sample/depth state. */
export async function composeTextPipeline(options: TextPipelineOptions): Promise<ComposedTextPipeline> {
    const module = await importPinnedModule<{
        getOrCreateTextPipeline(engine: unknown, format: string, samples: number, depth: string | undefined,
            depthWrite: boolean, owner: object): { _pipeline: TextPipelineDescriptor; _variantPipeline: TextPipelineDescriptor };
        clearTextPipelineCache(engine: unknown): void;
    }>("text/_gpu/text-pipeline.js");
    const { setAlphaToCoverage } = await importPinnedModule<{
        setAlphaToCoverage(owner: object, enabled: boolean): void;
    }>("render/alpha-to-coverage.js");
    const buffers: ArrayBuffer[] = [];
    const device = {
        createBindGroupLayout: (descriptor: TextBindingLayout) => descriptor,
        createPipelineLayout: (descriptor: TextPipelineDescriptor["layout"]) => descriptor,
        createShaderModule: (descriptor: { code: string }) => descriptor,
        createRenderPipeline: (descriptor: TextPipelineDescriptor) => descriptor,
        createBuffer: (descriptor: { size: number; mappedAtCreation: boolean }) => {
            if (!descriptor.mappedAtCreation) throw new Error("Pinned text quad is no longer mapped at creation.");
            const bytes = new ArrayBuffer(descriptor.size);
            buffers.push(bytes);
            return { getMappedRange: () => bytes, unmap: () => {} };
        },
    };
    const engine = { _device: device };
    const owner = {};
    setAlphaToCoverage(owner, options.alphaToCoverage);
    try {
        const result = module.getOrCreateTextPipeline(engine, options.format, options.sampleCount,
            options.depthStencilFormat, options.depthWrite, owner);
        if (result._pipeline !== result._variantPipeline || buffers.length !== 1) {
            throw new Error("Pinned base text pipeline requires one quad buffer and no installed style variant.");
        }
        return {
            descriptor: result._pipeline,
            quadCorners: Array.from(new Float32Array(buffers[0]!)),
            vertexConstants: stageConstants(result._pipeline.vertex),
            fragmentConstants: stageConstants(result._pipeline.fragment),
        };
    } finally {
        module.clearTextPipelineCache(engine);
        setAlphaToCoverage(owner, false);
    }
}
