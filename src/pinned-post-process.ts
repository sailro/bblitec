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
    postProcessComposite,
    postProcessEffect,
    type PostProcessComposite,
} from "./post-process-effects.js";
import type { PostProcessOptionValue } from "./compiler/types.js";
import {
    importPinnedModule,
    importPinnedModuleObserving,
    importPinnedModuleWithExports,
} from "./pinned-shader-composer.js";

export interface PostProcessCompositionRequest {
    /** The Babylon Lite entry point the pass was created through. */
    intrinsic: string;
    /**
     * Whether the scene named a target. A composite branches on it -- the
     * pass it ends on makes its own output when it was given none -- so the
     * absence has to reach the factory rather than be substituted.
     */
    hasTarget?: boolean;
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

/** Which texture a composite's sub-pass reads or writes. */
export type CompositeTextureRef =
    /** One of the composite's own config textures, by the option naming it. */
    | { kind: "input"; option: string }
    /** A target the composite created, by its index in `intermediates`. */
    | { kind: "intermediate"; index: number }
    /** The output a pass allocated for itself, having been given no target. */
    | { kind: "internal" };

/** One target a composite owns, sized from the source on every record. */
export interface CompositeIntermediate {
    /** The pin's own label for it. */
    label: string;
    /**
     * Its texture format, or null when it takes the source's. The composite
     * decides one or the other and the two are told apart by composing twice
     * against sources of different formats.
     */
    format: string | null;
    /**
     * Its extent, as the fraction of the source the pin sizes it at:
     * `max(1, floor(sourceExtent * ratio))`, re-evaluated every record because
     * a canvas-sized source changes with the window. Derived by composing at
     * two source sizes and refusing anything the single ratio does not
     * reproduce exactly.
     */
    widthRatio: number;
    heightRatio: number;
}

/** One pass a composite builds, in the order the composite built it. */
export interface ComposedCompositePass {
    /** The pin's own name for the pass. */
    name: string;
    /** The leaf entry point that built it. */
    intrinsic: string;
    /** The module both stages compile from, the pin's own text. */
    wgsl: string;
    uniformByteLength: number;
    uniformBinding: number;
    sampling: string;
    alphaMode: number;
    clear: boolean;
    viewport: { x: number; y: number; width: number; height: number } | null;
    source: CompositeTextureRef;
    extraTextures: readonly CompositeTextureRef[];
    target: CompositeTextureRef;
    /**
     * The scalars the pass's writer reads, in the effect table's own order.
     *
     * The composite resolved them from its config, and the pin publishes each
     * on the pass through the same name its `writeUniforms` reads it by, so
     * they are read off the pass rather than recomputed from the descriptor.
     */
    params: readonly number[];
}

/** What running a composite's own factory produced. */
export interface ComposedComposite {
    /** The Babylon Lite entry point that built it. */
    intrinsic: string;
    intermediates: readonly CompositeIntermediate[];
    passes: readonly ComposedCompositePass[];
}

/** What the factories read off a render target while composing. */
interface PinnedRenderTarget {
    _descriptor: {
        lbl?: string;
        format?: string;
        size: { width: number; height: number };
    };
}

interface PinnedPostProcessTask {
    name: string;
    sourceTexture: PinnedRenderTarget;
    targetTexture: PinnedRenderTarget | null;
    /** `config.targetTexture ?? internalTarget`, resolved by the pin. */
    outputTexture: PinnedRenderTarget;
    sourceSamplingMode: string;
    alphaMode: number;
    clear: boolean;
    viewport: {
        x: number;
        y: number;
        width: number;
        height: number;
    } | null;
    _shader: {
        uniformByteLength?: number;
        extraTextures?: readonly PinnedRenderTarget[];
    };
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
 * One run of a composite's factory, against a source of a given size and
 * format. Two runs settle what a single run cannot tell apart: an intermediate
 * sized in pixels from one sized as a fraction of the source, and a format the
 * composite chose from one it took off the source.
 */
interface CompositeRun {
    passes: { intrinsic: string; task: PinnedPostProcessTask }[];
    inputs: Map<PinnedRenderTarget, string>;
    width: number;
    height: number;
}

/**
 * Options with every pinned enum member replaced by the pin's own value.
 *
 * Scene code writes `DepthOfFieldBlurLevel.High`; what that is worth belongs
 * to the pinned package, which exports the enum from the same entry point the
 * scene imported it from. So the name travels here and the module answers it.
 */
async function resolvePinnedEnums(
    options: Readonly<Record<string, PostProcessOptionValue>>,
): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = { ...options };
    const members = Object.entries(options).filter(
        (entry): entry is [string, { pinnedEnum: string; member: string }] =>
            typeof entry[1] === "object" && "pinnedEnum" in entry[1],
    );
    if (members.length === 0) {
        return resolved;
    }
    const entry =
        await importPinnedModule<Record<string, unknown>>("index.js");
    for (const [option, reference] of members) {
        const values = entry[reference.pinnedEnum] as
            | Record<string, unknown>
            | undefined;
        const value = values?.[reference.member];
        if (typeof value !== "number") {
            throw new Error(
                `Babylon Lite no longer exports ` +
                    `${reference.pinnedEnum}.${reference.member} as a number.`,
            );
        }
        resolved[option] = value;
    }
    return resolved;
}

/** The pin's own extent rule for a fraction of the source. */
function scaledExtent(extent: number, ratio: number): number {
    return Math.max(1, Math.floor(extent * ratio));
}

async function runComposite(
    composite: PostProcessComposite,
    request: PostProcessCompositionRequest,
    width: number,
    height: number,
    format: string,
): Promise<CompositeRun> {
    const options = request.options;
    const renderTargets = await importPinnedModule<PinnedRenderTargetModule>(
        "engine/render-target.js",
    );
    const passes: CompositeRun["passes"] = [];
    const module = await importPinnedModuleObserving<
        Record<
            string,
            (
                config: Record<string, unknown>,
                engine: unknown,
                scene: unknown,
            ) => unknown
        >
    >(
        pinnedEffectModule(composite),
        composite.passes,
        (intrinsic, value) => {
            passes.push({
                intrinsic,
                task: value as PinnedPostProcessTask,
            });
        },
    );
    const factory = module[composite.intrinsic];
    if (typeof factory !== "function") {
        throw new Error(
            `Pinned module ${pinnedEffectModule(composite)} no longer exports ${
                composite.intrinsic
            }.`,
        );
    }
    const resolved = await resolvePinnedEnums(options);
    const inputs = new Map<PinnedRenderTarget, string>();
    const input = (option: string): PinnedRenderTarget => {
        const target = renderTargets.createRenderTarget({
            lbl: `bblitec-${option}`,
            format,
            samples: 1,
            size: { width, height },
        });
        inputs.set(target, option);
        return target;
    };
    const config: Record<string, unknown> = {
        ...resolved,
        name: COMPOSITION_NAME,
        sourceTexture: input("sourceTexture"),
        targetTexture: request.hasTarget ? input("targetTexture") : null,
        camera: COMPOSITION_CAMERA,
    };
    for (const option of composite.extraTextures) {
        config[option] = input(option);
    }
    const task = factory(
        config,
        compositionEngine(),
        undefined,
    ) as { outputTexture?: PinnedRenderTarget };
    // The observation seam only sees passes the composite builds through the
    // entry points its descriptor names, so a chain that ends somewhere else
    // would compose short and silently. What the composite says its output is
    // settles that: it must be the output of the last pass observed.
    const last = passes[passes.length - 1];
    if (!last || task.outputTexture !== last.task.outputTexture) {
        throw new Error(
            `Pinned ${composite.intrinsic} ends on a pass this port did not ` +
                "observe; its descriptor does not name every entry point it " +
                "builds through.",
        );
    }
    return { passes, inputs, width, height };
}

/**
 * Runs a composite post-process factory and reports what it built.
 *
 * The composite is the pin's own: it creates its intermediate targets, chains
 * its passes over them and composes each pass's module, all from the config
 * alone and without touching a device. So generation runs it and reads the
 * result, exactly as a single pass is composed — what differs is only that the
 * result is several passes rather than one, and that the targets between them
 * have to be described to the backend rather than named by the scene.
 */
export async function composeComposite(
    request: PostProcessCompositionRequest,
): Promise<ComposedComposite> {
    const composite = postProcessComposite(request.intrinsic);
    if (!composite) {
        throw new Error(
            `Post-process composite '${request.intrinsic}' has no descriptor.`,
        );
    }
    const taskModule = await importPinnedModuleWithExports<
        PinnedPostProcessTaskModule
    >("frame-graph/post-process-task.js", [
        "getShaderModule",
        "getUniformBinding",
        "align16",
    ]);
    // Two runs, differing in both source extent and source format, so an
    // intermediate that tracks either is told apart from one that does not.
    const [run, check] = await Promise.all([
        runComposite(composite, request, 4096, 2048, "bgra8unorm"),
        runComposite(composite, request, 8192, 4096, "rgba16float"),
    ]);
    if (run.passes.length !== check.passes.length) {
        throw new Error(
            `Pinned ${request.intrinsic} built a different pass count at a ` +
                "different source size; its structure is not settled by its " +
                "config alone.",
        );
    }
    const intermediates: CompositeIntermediate[] = [];
    const indices = new Map<PinnedRenderTarget, number>();
    const engine = compositionEngine();
    const passes = run.passes.map(({ intrinsic, task }, index) => {
        const other = check.passes[index]!;
        if (other.intrinsic !== intrinsic) {
            throw new Error(
                `Pinned ${request.intrinsic} built pass ${index} through ` +
                    `${intrinsic} at one source size and ` +
                    `${other.intrinsic} at another.`,
            );
        }
        const reference = (
            target: PinnedRenderTarget | null,
            twin: PinnedRenderTarget | null,
        ): CompositeTextureRef =>
            resolveCompositeTexture(
                request.intrinsic,
                { run, check },
                { intermediates, indices },
                target,
                twin,
            );
        return {
            name: task.name,
            intrinsic,
            wgsl: taskModule.getShaderModule(task, engine).code,
            uniformByteLength: taskModule.align16(
                task._shader.uniformByteLength ?? 0,
            ),
            uniformBinding: taskModule.getUniformBinding(task),
            sampling: task.sourceSamplingMode,
            alphaMode: task.alphaMode,
            clear: task.clear,
            viewport: task.viewport,
            source: reference(task.sourceTexture, other.task.sourceTexture),
            extraTextures: (task._shader.extraTextures ?? []).map(
                (extra, slot) =>
                    reference(
                        extra,
                        (other.task._shader.extraTextures ?? [])[slot] ?? null,
                    ),
            ),
            target: reference(task.targetTexture, other.task.targetTexture),
            params: compositePassParams(intrinsic, task),
        };
    });
    return { intrinsic: request.intrinsic, intermediates, passes };
}

/**
 * A sub-pass's parameter vector, read off the pass the composite built.
 *
 * The pin publishes each scalar its `writeUniforms` reads under that same
 * name — `lensSize`, `direction.x` — so the effect table's own paths address
 * both. A runtime slot has no value yet by definition: the backend refreshes
 * it from the attachments before every write.
 */
function compositePassParams(
    intrinsic: string,
    task: PinnedPostProcessTask,
): number[] {
    const effect = postProcessEffect(intrinsic);
    if (!effect) {
        throw new Error(
            `A composite built a pass through '${intrinsic}', which has no ` +
                "effect descriptor.",
        );
    }
    return effect.params.map((slot) => {
        if (slot.runtime) {
            return slot.fallback;
        }
        let value: unknown = task;
        for (const step of slot.path.split(".")) {
            value = (value as Record<string, unknown>)?.[step];
        }
        if (typeof value !== "number") {
            throw new Error(
                `Pinned ${intrinsic} no longer publishes '${slot.path}' on ` +
                    "the pass it builds.",
            );
        }
        return value;
    });
}

/**
 * Names one texture a sub-pass reached, and describes it the first time.
 *
 * A target the composite made is described by comparing the two runs: the
 * format is the source's when it followed the source's, and each extent is the
 * fraction of the source that reproduces both runs exactly. A composite that
 * sizes a target any other way is refused rather than approximated.
 */
function resolveCompositeTexture(
    intrinsic: string,
    runs: { run: CompositeRun; check: CompositeRun },
    seen: {
        intermediates: CompositeIntermediate[];
        indices: Map<PinnedRenderTarget, number>;
    },
    target: PinnedRenderTarget | null,
    twin: PinnedRenderTarget | null,
): CompositeTextureRef {
    if (!target) {
        return { kind: "internal" };
    }
    const option = runs.run.inputs.get(target);
    if (option) {
        return { kind: "input", option };
    }
    const known = seen.indices.get(target);
    if (known !== undefined) {
        return { kind: "intermediate", index: known };
    }
    if (!twin || runs.check.inputs.has(twin)) {
        throw new Error(
            `Pinned ${intrinsic} reached a different texture at a different ` +
                "source size; its wiring is not settled by its config alone.",
        );
    }
    const label = target._descriptor.lbl ?? "";
    const ratio = (
        extent: number,
        checkExtent: number,
        source: number,
        checkSource: number,
        axis: string,
    ): number => {
        const value = checkExtent / checkSource;
        if (
            scaledExtent(source, value) !== extent ||
            scaledExtent(checkSource, value) !== checkExtent
        ) {
            throw new Error(
                `Pinned ${intrinsic} sizes '${label}' ${axis} as ${extent} of ` +
                    `${source} and ${checkExtent} of ${checkSource}, which is ` +
                    "no single fraction of the source.",
            );
        }
        return value;
    };
    const index = seen.intermediates.length;
    seen.intermediates.push({
        label,
        // A format that changed with the source's is the source's.
        format:
            target._descriptor.format === twin._descriptor.format
                ? (target._descriptor.format ?? null)
                : null,
        widthRatio: ratio(
            target._descriptor.size.width,
            twin._descriptor.size.width,
            runs.run.width,
            runs.check.width,
            "width",
        ),
        heightRatio: ratio(
            target._descriptor.size.height,
            twin._descriptor.size.height,
            runs.run.height,
            runs.check.height,
            "height",
        ),
    });
    seen.indices.set(target, index);
    return { kind: "intermediate", index };
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

/**
 * The name composition gives a composite, so its passes' names come back as
 * this plus the suffix the pin derived. The generated factory rebuilds each
 * from the scene's own name, which is only known at run time.
 */
export const COMPOSITION_NAME = "bblitec-composite";

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
