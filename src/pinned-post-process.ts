/**
 * Composes a post-process stage by running Babylon Lite's own factory.
 *
 * `frame-graph/post-process-task.ts` builds one shader module per pass — the
 * fullscreen-triangle vertex stage, the source sampler pair, the effect's
 * extra textures, its uniform block and its fragment — and every effect module
 * (`post-process/blur.ts` and its siblings) contributes only that `_shader`
 * record. None of it touches a device until `record()`, so the module the
 * browser compiles can be *obtained* here rather than reproduced: the factory
 * runs under Node against a descriptor-only render target, and the pin's own
 * `getShaderModule` concatenates the parts.
 *
 * That matters most for the blur, whose text is not fixed at all. Its kernel
 * decides how many taps the vertex stage carries, and each tap's offset and
 * weight is a Gaussian evaluated in doubles and printed through the pin's own
 * `toFixed(7)`. Folding that would mean restating an integration, a rounding
 * rule and a formatter; executing it settles all three the way the golden
 * settles them. The tradeoff is the HDR prefilter's and the drawn atlas's, and
 * the same one: what is baked is what this Node ran.
 */
import {
    pinnedEffectModule,
    postProcessEffect,
} from "./post-process-effects.js";
import type { PostProcessOptionValue } from "./compiler/types.js";
import {
    importPinnedModule,
    importPinnedModuleWithExports,
} from "./pinned-shader-composer.js";

export interface PostProcessCompositionRequest {
    /** The Babylon Lite entry point the pass was created through. */
    intrinsic: string;
    /**
     * Every option the pass itself does not read, as the scene wrote them.
     * They are forwarded whole: which of them the composed text branches on
     * is the pin's to decide, not this port's.
     */
    options: Readonly<Record<string, PostProcessOptionValue>>;
}

/** What the pin composed, plus the layout its bind group declares. */
export interface ComposedPostProcess {
    /** The module both stages compile from, the pin's own text. */
    wgsl: string;
    /** The uniform block's size, rounded by the pin's own `align16`. */
    uniformByteLength: number;
    /** The binding the pin's own `getUniformBinding` gives that block. */
    uniformBinding: number;
}

/** What the factories read off a render target while composing. */
interface PinnedRenderTarget {
    _descriptor: { format?: string };
}

interface PinnedPostProcessTask {
    _shader: { uniformByteLength?: number };
}

interface PinnedPostProcessTaskModule {
    getShaderModule: (
        task: PinnedPostProcessTask,
        engine: unknown,
    ) => { code: string };
    getUniformBinding: (task: PinnedPostProcessTask) => number;
    align16: (value: number) => number;
}

interface PinnedRenderTargetModule {
    createRenderTarget: (descriptor: {
        lbl: string;
        format: string;
        samples: number;
        size: { width: number; height: number };
    }) => PinnedRenderTarget;
}

/**
 * A device whose only method is the one `getShaderModule` calls. Composition
 * asks the pin for a shader module and reads the code it would have handed
 * WebGPU, so nothing else on the device is reachable from here — a pin that
 * started needing more would fail loudly rather than compose something else.
 */
function compositionEngine(): unknown {
    return {
        _device: {
            createShaderModule: (descriptor: { code: string }) => ({
                code: descriptor.code,
            }),
        },
    };
}

/**
 * The camera shape `createCircleOfConfusionPostProcessTask` closes over. It is
 * read only by `writeUniforms`, which generation lowers rather than runs, so
 * the values here never reach an artifact.
 */
const COMPOSITION_CAMERA = { nearPlane: 0, farPlane: 1 };

export async function composePostProcess(
    request: PostProcessCompositionRequest,
): Promise<ComposedPostProcess> {
    const effect = postProcessEffect(request.intrinsic);
    if (!effect) {
        throw new Error(
            `Post-process effect '${request.intrinsic}' has no descriptor.`,
        );
    }
    const [taskModule, renderTargets, effectModule] = await Promise.all([
        importPinnedModuleWithExports<PinnedPostProcessTaskModule>(
            "frame-graph/post-process-task.js",
            ["getShaderModule", "getUniformBinding", "align16"],
        ),
        importPinnedModule<PinnedRenderTargetModule>(
            "engine/render-target.js",
        ),
        importPinnedModule<
            Record<
                string,
                (
                    config: Record<string, unknown>,
                    engine: unknown,
                    scene: unknown,
                ) => PinnedPostProcessTask
            >
        >(pinnedEffectModule(effect)),
    ]);
    const factory = effectModule[request.intrinsic];
    if (typeof factory !== "function") {
        throw new Error(
            `Pinned module ${pinnedEffectModule(effect)} no longer exports ${
                request.intrinsic
            }.`,
        );
    }
    const engine = compositionEngine();
    const target = renderTargets.createRenderTarget({
        lbl: "bblitec-post-process-composition",
        format: "bgra8unorm",
        samples: 1,
        // The extents reach uniforms, never the text; the pass reads the real
        // attachments at record time through the emitted writer.
        size: { width: 1, height: 1 },
    });
    const task = factory(
        {
            ...request.options,
            name: "composition",
            sourceTexture: target,
            targetTexture: target,
            // The two extra-texture effects name their own option; supplying
            // both keeps this one call shape for every factory, and an effect
            // that reads neither ignores them exactly as the pin does.
            leftTexture: target,
            depthTexture: target,
            camera: COMPOSITION_CAMERA,
        },
        engine,
        undefined,
    );
    return {
        wgsl: taskModule.getShaderModule(task, engine).code,
        uniformByteLength: taskModule.align16(
            task._shader.uniformByteLength ?? 0,
        ),
        uniformBinding: taskModule.getUniformBinding(task),
    };
}
