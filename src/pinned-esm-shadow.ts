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
import { createRecordingDevice, writtenFloats } from "./recording-device.js";

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

/**
 * The descriptor members this composition reads back off the recording.
 * Every device method listed below is one the factory actually calls; a
 * pin that grew a new call fails loudly rather than silently composing less.
 */
interface EsmRecordedShapes {
    sampler: { magFilter: string; minFilter: string };
    shaderModule: { code: string };
    bindGroupLayout: object;
    pipelineLayout: object;
    renderPipeline: { fragment?: { targets?: readonly { format: string }[] } };
    bindGroup: object;
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
    const { device, recorder } = createRecordingDevice<EsmRecordedShapes>({
        producer: "esm-shadow",
        device: [
            "createTexture",
            "createShaderModule",
            "createBindGroupLayout",
            "createPipelineLayout",
            "createRenderPipeline",
            "createBindGroup",
            "createSampler",
            "createBuffer",
        ],
        queue: ["writeBuffer"],
    });
    module.createEsmDirectionalShadowGenerator(
        { _device: device },
        COMPOSITION_LIGHT,
        config,
    );
    const textures = recorder.textures.map(
        (texture): EsmTextureDescriptor => ({
            width: texture.width,
            height: texture.height,
            format: texture.format,
            usage: texture.usage,
        }),
    );
    if (textures.length !== 4) {
        throw new Error(
            "Expected the pinned ESM factory to build four textures " +
                `(esm, depth, blurH, blurV); it built ${textures.length}.`,
        );
    }
    const modules = recorder.shaderModules.map((shader) => shader.code);
    if (modules.length !== 2) {
        throw new Error(
            "Expected the pinned ESM factory to build a blur vertex and " +
                `fragment module; it built ${modules.length}.`,
        );
    }
    // The two direction UBOs, plus the 24-float receiver block the shared
    // shadow UBO writes last. Only the first two describe the blur.
    const directions = recorder.bufferWrites
        .map(writtenFloats)
        .filter((values) => values.length === 4);
    if (directions.length !== 2) {
        throw new Error(
            "Expected the pinned ESM factory to write two 4-float blur " +
                `directions; it wrote ${directions.length}.`,
        );
    }
    const pipelineTargets = recorder.renderPipelines.flatMap((pipeline) =>
        (pipeline.fragment?.targets ?? []).map((target) => target.format),
    );
    if (pipelineTargets.length !== 1) {
        throw new Error(
            "Expected the pinned blur pipeline to declare one colour " +
                `target; it declared ${pipelineTargets.length}.`,
        );
    }
    if (recorder.samplers.length !== 1) {
        throw new Error(
            "Expected the pinned ESM factory to ask for one sampler; it " +
                `asked for ${recorder.samplers.length}.`,
        );
    }
    // Dawn takes the blur pipeline's own auto layout -- derived from the
    // same composed WGSL -- so the layout's ENTRIES are not carried; what is
    // checked is that the pin still builds exactly the one layout that auto
    // layout then answers for.
    if (recorder.bindGroupLayouts.length !== 1) {
        throw new Error(
            "Expected the pinned ESM factory to build one bind-group " +
                `layout; it built ${recorder.bindGroupLayouts.length}.`,
        );
    }
    return {
        textures,
        blurVertexWgsl: modules[0]!,
        blurFragmentWgsl: modules[1]!,
        blurDirections: directions,
        blurSampler: recorder.samplers[0]!,
        blurTargetFormat: pipelineTargets[0]!,
    };
}
