/** Records the actual pin's text GPU descriptors without a device or shader transcription. */
import { importPinnedModule } from "./pinned-shader-composer.js";
import { createRecordingDevice } from "./recording-device.js";
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
    weighted?: boolean;
}

export interface ComposedTextPipeline {
    descriptor: TextPipelineDescriptor;
    quadCorners: readonly number[];
    vertexConstants: readonly ShaderStageConstant[];
    fragmentConstants: readonly ShaderStageConstant[];
    weighted?: true;
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
        _textVariantResolver: ((device: unknown) => unknown) | null;
        _installTextVariantResolver(resolver: ((device: unknown) => unknown) | null): void;
    }>("text/_gpu/text-pipeline.js");
    const { setAlphaToCoverage } = await importPinnedModule<{
        setAlphaToCoverage(owner: object, enabled: boolean): void;
    }>("render/alpha-to-coverage.js");
    // Every handle is its descriptor: the pipeline the pin stores is read
    // back below as the descriptor it was built from, module code and layout
    // entries included.
    const { device, recorder } = createRecordingDevice<{
        sampler: object;
        shaderModule: TextShaderStage["module"];
        bindGroupLayout: TextBindingLayout;
        pipelineLayout: TextPipelineDescriptor["layout"];
        renderPipeline: TextPipelineDescriptor;
        bindGroup: object;
    }>({
        producer: "text-pipeline",
        device: ["createBindGroupLayout", "createPipelineLayout", "createShaderModule", "createRenderPipeline", "createBuffer"],
    });
    const engine = { _device: device };
    const owner = {};
    setAlphaToCoverage(owner, options.alphaToCoverage);
    const previousResolver = module._textVariantResolver;
    try {
        if (options.weighted) {
            const { WEIGHT_SHADER_FRAGMENT } = await importPinnedModule<{ WEIGHT_SHADER_FRAGMENT: unknown }>("text/shaders/weight-shader-fragment.js");
            const { composeSlugShader } = await importPinnedModule<{ composeSlugShader(fragment: unknown): { _key: string; _vert: string; _frag: string } }>("text/shaders/slug-shader.js");
            const composed = composeSlugShader(WEIGHT_SHADER_FRAGMENT);
            module._installTextVariantResolver(() => ({ _id: composed._key,
                _vertModule: device.createShaderModule({ code: composed._vert }),
                _fragModule: device.createShaderModule({ code: composed._frag }) }));
        }
        const result = module.getOrCreateTextPipeline(engine, options.format, options.sampleCount,
            options.depthStencilFormat, options.depthWrite, owner);
        const quad = recorder.buffers[0];
        if ((!options.weighted && result._pipeline !== result._variantPipeline) || recorder.buffers.length !== 1 || !quad) {
            throw new Error("Pinned base text pipeline requires one quad buffer and no installed style variant.");
        }
        if (!quad.mappedAtCreation) throw new Error("Pinned text quad is no longer mapped at creation.");
        const descriptor = options.weighted ? result._variantPipeline : result._pipeline;
        return {
            descriptor,
            quadCorners: Array.from(new Float32Array(quad.bytes)),
            vertexConstants: stageConstants(descriptor.vertex),
            fragmentConstants: stageConstants(descriptor.fragment),
            ...(options.weighted ? { weighted: true as const } : {}),
        };
    } finally {
        module.clearTextPipelineCache(engine);
        module._installTextVariantResolver(previousResolver);
        setAlphaToCoverage(owner, false);
    }
}
