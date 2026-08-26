/**
 * The ESM generator's GPU resources, read by executing the pinned factory.
 *
 * `createEsmDirectionalShadowGenerator` builds four textures, a two-pass
 * separable blur pipeline, and the two direction UBOs that drive it — and
 * the blur fragment's tap table is FOLDED from `blurKernel` by
 * `createShadowBlurFragmentWGSL`, so the shader is a different text for
 * every kernel a scene asks for. None of that can be restated here without
 * becoming a second source of truth, so generation runs the pinned factory
 * against a device that records what it was asked to build and reads the
 * answers off the recording. It is the same execute-the-pin shape the
 * post-process and node-particle families already use.
 */
import { importPinnedModule } from "./pinned-shader-composer.js";

/** One texture the pinned factory asked its device for, in creation order. */
export interface EsmTextureDescriptor {
    width: number;
    height: number;
    format: string;
    usage: number;
}

/** Everything the PAL needs to reproduce the pinned generator's resources. */
export interface ComposedEsmShadow {
    /** `esmTexture`, `depthBuf`, `blurTexH`, `blurTexV`, in pinned order. */
    textures: readonly EsmTextureDescriptor[];
    /** The blur pass's shared vertex stage. */
    blurVertexWgsl: string;
    /** The blur fragment, with this kernel's own tap table folded in. */
    blurFragmentWgsl: string;
    /** `blurHData` then `blurVData`: the per-pass texel step. */
    blurDirections: readonly (readonly number[])[];
    /** The sampler descriptor `getBilinearSampler` asked for. */
    blurSampler: { magFilter: string; minFilter: string };
    /** The colour format the blur pipeline's one target declares. */
    blurTargetFormat: string;
}

interface Recorded {
    textures: EsmTextureDescriptor[];
    modules: string[];
    buffers: number[][];
    samplers: { magFilter: string; minFilter: string }[];
    pipelineTargets: string[];
    /**
     * How many bind-group layouts the factory built. Dawn takes the blur
     * pipeline's own auto layout -- derived from the same composed WGSL --
     * so the ENTRIES are not carried; what is checked is that the pin still
     * builds exactly the one layout that auto layout then answers for.
     */
    layouts: number;
}

/**
 * A device that answers the pinned factory and records what it was asked
 * for. Every method here is one the factory actually calls; a pin that grew
 * a new call fails loudly rather than silently composing less.
 */
function recordingEngine(recorded: Recorded): unknown {
    const device = {
        createTexture: (descriptor: {
            size: { width: number; height: number };
            format: string;
            usage: number;
        }) => {
            recorded.textures.push({
                width: descriptor.size.width,
                height: descriptor.size.height,
                format: descriptor.format,
                usage: descriptor.usage,
            });
            return { createView: () => ({}) };
        },
        createShaderModule: (descriptor: { code: string }) => {
            recorded.modules.push(descriptor.code);
            return {};
        },
        createBindGroupLayout: (descriptor: unknown) => {
            recorded.layouts += 1;
            return descriptor;
        },
        createPipelineLayout: (descriptor: unknown) => descriptor,
        createRenderPipeline: (descriptor: {
            fragment?: { targets?: readonly { format: string }[] };
        }) => {
            for (const target of descriptor.fragment?.targets ?? []) {
                recorded.pipelineTargets.push(target.format);
            }
            return {};
        },
        createBindGroup: (descriptor: unknown) => descriptor,
        createSampler: (
            descriptor: { magFilter: string; minFilter: string },
        ) => {
            recorded.samplers.push(descriptor);
            return {};
        },
        createBuffer: () => ({}),
        queue: {
            writeBuffer: (
                _buffer: unknown,
                _offset: number,
                data: ArrayBuffer,
                byteOffset: number,
                byteLength: number,
            ) => {
                recorded.buffers.push([
                    ...new Float32Array(
                        data.slice(byteOffset, byteOffset + byteLength),
                    ),
                ]);
            },
        },
    };
    return { _device: device };
}

/** The light shape the factory stores but never reads while composing. */
const COMPOSITION_LIGHT = {
    direction: { x: 0, y: -1, z: 0 },
    position: { x: 0, y: 0, z: 0 },
    worldMatrixVersion: 0,
};

export async function composeEsmShadow(
    config: Record<string, number>,
): Promise<ComposedEsmShadow> {
    const module = await importPinnedModule<{
        createEsmDirectionalShadowGenerator: (
            engine: unknown,
            light: unknown,
            cfg: Record<string, number>,
        ) => unknown;
    }>("shadow/esm-directional-shadow-generator.js");
    const recorded: Recorded = {
        textures: [],
        modules: [],
        buffers: [],
        samplers: [],
        pipelineTargets: [],
        layouts: 0,
    };
    module.createEsmDirectionalShadowGenerator(
        recordingEngine(recorded),
        COMPOSITION_LIGHT,
        config,
    );
    if (recorded.textures.length !== 4) {
        throw new Error(
            "Expected the pinned ESM factory to build four textures " +
                `(esm, depth, blurH, blurV); it built ${
                    recorded.textures.length
                }.`,
        );
    }
    if (recorded.modules.length !== 2) {
        throw new Error(
            "Expected the pinned ESM factory to build a blur vertex and " +
                `fragment module; it built ${recorded.modules.length}.`,
        );
    }
    // The two direction UBOs, plus the 24-float receiver block the shared
    // shadow UBO writes last. Only the first two describe the blur.
    const directions = recorded.buffers.filter(
        (values) => values.length === 4,
    );
    if (directions.length !== 2) {
        throw new Error(
            "Expected the pinned ESM factory to write two 4-float blur " +
                `directions; it wrote ${directions.length}.`,
        );
    }
    if (recorded.pipelineTargets.length !== 1) {
        throw new Error(
            "Expected the pinned blur pipeline to declare one colour " +
                `target; it declared ${recorded.pipelineTargets.length}.`,
        );
    }
    if (recorded.samplers.length !== 1) {
        throw new Error(
            "Expected the pinned ESM factory to ask for one sampler; it " +
                `asked for ${recorded.samplers.length}.`,
        );
    }
    if (recorded.layouts !== 1) {
        throw new Error(
            "Expected the pinned ESM factory to build one bind-group " +
                `layout; it built ${recorded.layouts}.`,
        );
    }
    return {
        textures: recorded.textures,
        blurVertexWgsl: recorded.modules[0]!,
        blurFragmentWgsl: recorded.modules[1]!,
        blurDirections: directions,
        blurSampler: recorded.samplers[0]!,
        blurTargetFormat: recorded.pipelineTargets[0]!,
    };
}
