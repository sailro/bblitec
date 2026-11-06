/**
 * Composes a screen-space effect task by running Babylon Lite's own factory.
 *
 * `screen-space-contact-shadows.ts`, `screen-space-global-illumination.ts`
 * and `screen-space-ambient-occlusion.ts` each build one frame-graph task
 * out of dedicated GPU programs and two ordinary passes: one or more
 * dedicated passes that read the scene depth through a depth-only view (a
 * producer, and for ambient occlusion two bilateral blur passes over one
 * pipeline), the shared temporal resolve (`screen-space-temporal.ts`), a
 * history copy and an optional composite. The last two are ordinary
 * `createPostProcessTask` passes; the rest are dedicated pipelines the
 * factory builds itself. None of it touches a real device: `record()` and
 * `execute()` create everything through `engine._device` and encode through
 * `engine._currentEncoder`, which is what the pin's own unit tests exploit
 * with a mock device.
 *
 * So composition does the same, against a device that RECORDS. Running the
 * factory, `record()`, one enabled `execute()` and one disabled `execute()`
 * yields every shader module (by label), every pipeline's entry points and
 * target format, every bind group's binding-to-texture wiring, every buffer's
 * size and the pass sequence of both states -- all read off the pin's own
 * calls rather than restated. What generation then lowers from the pinned
 * ASTs (`screen-space-lowerer.ts`) is the arithmetic those calls carry: the
 * temporal state machine and the uniform blocks.
 */
import { pinnedEffectModule } from "./post-process-effects.js";
import { snakeCase } from "./cpp-literals.js";
import { pinnedOptionNames } from "./compiler/intrinsics/pinned-options.js";
import type { PostProcessOptionValue } from "./compiler/types.js";
import type { ComposedPostProcess } from "./pinned-post-process.js";
import { variantBindings } from "./pinned-pbr-variant-cpp.js";
import { importPinnedModule } from "./pinned-shader-composer.js";
import {
    createRecordingDevice,
    RecordedTextureView,
    type RecordedRenderPass,
    type Recorder,
} from "./recording-device.js";

/**
 * What one entry point decides, keyed by the entry point: the temporal
 * kind, the pinned module and the symbols this port reads out of it, the
 * generated frame function and enumerator, and the name the pin publishes
 * its stable target under. Every consumer that branches on the effect reads
 * this table, so another effect is one row rather than one more arm at
 * each of them.
 */
export interface ScreenSpaceKindFacts {
    /** The temporal owner's kind: a scalar effect or colour GI. */
    kind: "scalar" | "color";
    /** The pinned module, relative to the package's `src`. */
    module: string;
    /** The config interface the factory declares. */
    configType: string;
    /** The pinned clamp the factory applies at creation. */
    clamp: string;
    /** The generated per-frame function. */
    frameFunction: string;
    /** The native `ScreenSpaceEffectKind` enumerator. */
    enumerator: string;
    /** The task property the pin publishes the stable target under. */
    stableTexture: string;
}

export const SCREEN_SPACE_KINDS: Readonly<
    Record<string, ScreenSpaceKindFacts>
> = {
    createScreenSpaceContactShadowsPostProcessTask: {
        kind: "scalar",
        module: "src/post-process/screen-space-contact-shadows.ts",
        configType: "ScreenSpaceContactShadowsPostProcessTaskConfig",
        clamp: "clampScreenSpaceContactShadowsConfig",
        frameFunction: "contact_shadows_frame",
        enumerator: "contact_shadows",
        stableTexture: "shadowTexture",
    },
    createScreenSpaceGlobalIlluminationPostProcessTask: {
        kind: "color",
        module: "src/post-process/screen-space-global-illumination.ts",
        configType: "ScreenSpaceGlobalIlluminationPostProcessTaskConfig",
        clamp: "clampScreenSpaceGlobalIlluminationConfig",
        frameFunction: "global_illumination_frame",
        enumerator: "global_illumination",
        stableTexture: "illuminationTexture",
    },
    createScreenSpaceAmbientOcclusionPostProcessTask: {
        kind: "scalar",
        module: "src/post-process/screen-space-ambient-occlusion.ts",
        configType: "ScreenSpaceAmbientOcclusionPostProcessTaskConfig",
        clamp: "clampScreenSpaceAmbientOcclusionConfig",
        frameFunction: "ambient_occlusion_frame",
        enumerator: "ambient_occlusion",
        stableTexture: "occlusionTexture",
    },
};

/** The shared temporal module. */
export const SCREEN_SPACE_TEMPORAL_MODULE =
    "src/post-process/screen-space-temporal.ts";

/** Whether an imported name is one of the screen-space entry points. */
export function isScreenSpaceIntrinsic(intrinsic: string): boolean {
    return Object.hasOwn(SCREEN_SPACE_KINDS, intrinsic);
}

/** The table row of an entry point, refusing any other name. */
export function screenSpaceFacts(intrinsic: string): ScreenSpaceKindFacts {
    const facts = SCREEN_SPACE_KINDS[intrinsic];
    if (!facts) {
        throw new Error(
            `'${intrinsic}' is not a screen-space effect entry point.`,
        );
    }
    return facts;
}

/**
 * Whether the entry point's pinned config declares a `lightDirection`: the
 * contact producer keeps one by reference and normalizes it every frame,
 * and no other effect reads one.
 */
export function screenSpaceReadsLightDirection(intrinsic: string): boolean {
    return pinnedOptionNames({
        module: screenSpaceFacts(intrinsic).module,
        factory: intrinsic,
    }).includes("lightDirection");
}

/**
 * The scalar settings the pin keeps on its task object, as it spells them.
 * The effects share the first group; each publishes its own after that. The
 * compiler writes them for a scene's setter and the lowerer reads them for
 * the factory and the composite writer; the native record spells each in
 * snake case (`nativeSettingName`). A pinned setting outside these lists is
 * a contract failure at composition, never dropped.
 */
export const SCREEN_SPACE_SCALAR_SETTINGS: readonly string[] = [
    "intensity",
    "stepCount",
    "thickness",
    "bias",
    "temporalWeight",
    "resetVersion",
    "maxDistance",
    "normalBias",
    "spatialRadius",
    "rayCount",
    "rayLength",
    "fadeStart",
    "fadeEnd",
    "edgeFade",
    "colorBleedGain",
    "colorBleedMax",
    "radius",
    "power",
    "sliceCount",
];

/** The one triple the contact task publishes, carried as three lanes. */
const SCREEN_SPACE_VECTOR_SETTINGS: readonly string[] = ["tint"];

/** The native `ScreenSpaceTaskOptions` member a pinned setting maps to. */
export function nativeSettingName(setting: string): string {
    return snakeCase(setting);
}

/**
 * The task properties that are not settings: the textures and functions
 * the factory publishes beside them, the name and the enabled flag. Any
 * other non-numeric property is a pin change this port has to look at.
 */
const NON_SETTING_PROPERTIES = new Set([
    "name",
    "engine",
    "scene",
    "enabled",
    "lightDirection",
    "sourceTexture",
    "depthTexture",
    "targetTexture",
    "outputTexture",
    "record",
    "execute",
    "dispose",
    ...Object.values(SCREEN_SPACE_KINDS).map((facts) => facts.stableTexture),
]);

interface ScreenSpaceCompositionRequest {
    /** The Babylon Lite entry point the task was created through. */
    intrinsic: string;
    /** Every option the scene wrote, statically resolved and forwarded whole. */
    options: Readonly<Record<string, PostProcessOptionValue>>;
    /** Whether the scene named a composite target. */
    hasTarget: boolean;
    /** Whether the scene named a depth source apart from the colour source. */
    hasDepthTexture: boolean;
}

/**
 * Which texture a binding reads or a pass draws into, by what the pin bound
 * there: the depth source, the lit source colour, one of the targets the
 * factory owns between its dedicated passes, or the temporal pair.
 */
type ScreenSpaceTextureRole =
    "depth" | "source-color" | "intermediate" | "history" | "stable";

export interface ScreenSpaceTextureRef {
    role: ScreenSpaceTextureRole;
    /**
     * For an intermediate, its index among the task's owned intermediates,
     * which is the order the pin's passes first draw into them (`raw`,
     * then ambient occlusion's two blur targets); zero otherwise.
     */
    index: number;
}

export interface ScreenSpaceStageBinding {
    /** The WGSL `@binding` index, which is the pin's own group-0 slot. */
    binding: number;
    /** The WGSL identifier declared at that binding. */
    name: string;
    kind: "depth-texture" | "texture" | "sampler" | "uniform";
}

/**
 * One dedicated pipeline the factory built -- a producer, a blur, the
 * temporal resolve -- shared by every pass that draws with it.
 */
export interface ComposedScreenSpaceStage {
    /** The module both stages compile from, the pin's own text. */
    wgsl: string;
    vertexEntry: string;
    fragmentEntry: string;
    /**
     * The colour target the pipeline was built against, which composition
     * checked is the format of the target the pin draws it into.
     */
    targetFormat: string;
    /** The byte size of the uniform buffer every pass drawing it binds. */
    uniformBytes: number;
    bindings: readonly ScreenSpaceStageBinding[];
}

/** One dedicated pass the factory encodes, in its own order. */
export interface ComposedScreenSpaceStagePass {
    /** The pin's pass label after the task name: `producer`, `resolve`. */
    label: string;
    stage: ComposedScreenSpaceStage;
    /** What the pass clears and draws into: an intermediate or stable. */
    target: ScreenSpaceTextureRef;
    /**
     * What each of the stage's bindings reads in this pass, in binding
     * order; undefined for a sampler or the uniform block. Two passes over
     * one pipeline bind different textures here, the way the pin's two
     * blur bind groups do.
     */
    textures: readonly (ScreenSpaceTextureRef | undefined)[];
}

/** One ordinary post-process pass the task built: history copy or composite. */
interface ComposedScreenSpacePass extends ComposedPostProcess {
    sampling: "nearest" | "linear";
    /** Whether the pin's pipeline blends into its target. */
    blended: boolean;
    clear: boolean;
    /** The textures bound after the source, in binding order. */
    extraTextures: readonly ScreenSpaceTextureRef[];
}

export interface ComposedScreenSpaceTask {
    intrinsic: string;
    /** The temporal owner's kind: a scalar effect or colour GI. */
    kind: "scalar" | "color";
    /**
     * The live settings the factory published on its task object, after
     * its own clamp -- `intensity`, `stepCount`, the contact `tint` triple
     * and the rest -- keyed as the pin spells them.
     */
    settings: Readonly<Record<string, number | readonly number[]>>;
    /** The creation-time settings the pin keeps in `params` alone. */
    clamped: { resolutionScale: number; temporalSamples: number };
    /**
     * The dedicated passes of an enabled frame, in the pin's order: the
     * producer first, the temporal resolve into the stable target last.
     */
    passes: readonly ComposedScreenSpaceStagePass[];
    /** The owned intermediate targets' formats, by intermediate index. */
    intermediates: readonly string[];
    historyCopy: ComposedScreenSpacePass;
    composite: ComposedScreenSpacePass | null;
}

/**
 * The name composition gives the task, so every label the pin derives from
 * it comes back as this plus the pin's own suffix.
 */
const COMPOSITION_NAME = "bblitec-screen-space";

const SOURCE_LABEL = "bblitec-sourceTexture";
const DEPTH_LABEL = "bblitec-depthTexture";
const TARGET_LABEL = "bblitec-targetTexture";

/** One bind-group layout entry as the pin declares it. */
interface RecordedLayoutEntry {
    binding: number;
    texture?: { sampleType?: string };
    sampler?: unknown;
    buffer?: unknown;
}

/**
 * The descriptor members this composition reads back off the recording:
 * a pipeline's module, entry points, layout and colour target, and a bind
 * group's resources. The device returns each handle as a copy of its
 * descriptor, so the pipeline the pin stores carries the layout handle and
 * the module handle it was built from.
 */
interface ScreenSpaceShapes {
    sampler: { magFilter?: string };
    shaderModule: { code: string };
    bindGroupLayout: { entries: readonly RecordedLayoutEntry[] };
    pipelineLayout: {
        bindGroupLayouts: readonly ScreenSpaceShapes["bindGroupLayout"][];
    };
    renderPipeline: {
        layout: ScreenSpaceShapes["pipelineLayout"];
        vertex: {
            module: ScreenSpaceShapes["shaderModule"];
            entryPoint: string;
        };
        fragment: {
            entryPoint: string;
            targets: readonly { format: string; blend?: unknown }[];
        };
    };
    bindGroup: { entries: readonly { binding: number; resource: unknown }[] };
}

type ScreenSpaceRecorder = Recorder<ScreenSpaceShapes>;
type RecordedPass = RecordedRenderPass<ScreenSpaceShapes>;

/**
 * A device that answers every call the pin's `record()` and `execute()`
 * make and remembers what was asked. Anything the pin started calling
 * beyond this surface refuses rather than composing quietly differently,
 * which is the property that makes the recording safe.
 */
function recordingEngine(canvas: { width: number; height: number }): {
    engine: unknown;
    recorder: ScreenSpaceRecorder;
} {
    const { device, encoder, recorder } =
        createRecordingDevice<ScreenSpaceShapes>({
            producer: "screen-space",
            device: [
                "createShaderModule",
                "createTexture",
                "createBuffer",
                "createSampler",
                "createBindGroupLayout",
                "createPipelineLayout",
                "createRenderPipeline",
                "createBindGroup",
            ],
            queue: ["writeBuffer"],
            encoder: ["beginRenderPass"],
            renderPass: [
                "setPipeline",
                "setBindGroup",
                "draw",
                "setViewport",
                "setScissorRect",
                "end",
            ],
        });
    return {
        recorder,
        engine: {
            canvas,
            msaaSamples: 1,
            useHighPrecisionMatrix: false,
            useFloatingOrigin: false,
            _device: device,
            _currentEncoder: encoder,
            _currentDelta: 0,
            _cbs: [],
        },
    };
}

function layoutKind(
    entry: RecordedLayoutEntry,
): ScreenSpaceStageBinding["kind"] {
    if (entry.texture) {
        return entry.texture.sampleType === "depth"
            ? "depth-texture"
            : "texture";
    }
    if (entry.sampler) return "sampler";
    if (entry.buffer) return "uniform";
    throw new Error(
        "Pinned screen-space task declared a bind group entry this port " +
            "does not recognise.",
    );
}

/**
 * The shapes this port carries, checked over everything the pin built --
 * a pipeline it created and never drew with counts as much as one it did.
 */
function assertRecordedShapes(recorder: ScreenSpaceRecorder): void {
    for (const layout of recorder.bindGroupLayouts) {
        for (const entry of layout.entries) layoutKind(entry);
    }
    for (const pipeline of recorder.renderPipelines) {
        if (
            pipeline.layout.bindGroupLayouts.length !== 1 ||
            pipeline.fragment.targets.length !== 1
        ) {
            throw new Error(
                "Pinned screen-space task built a pipeline with other " +
                    "than one bind group and one colour target.",
            );
        }
    }
    for (const pass of recorder.renderPasses) {
        if (pass.descriptor.colorAttachments.length !== 1) {
            throw new Error(
                "Pinned screen-space task began a pass with other than " +
                    "one colour attachment.",
            );
        }
    }
}

/** The one colour attachment a pass draws into. */
function passAttachment(pass: RecordedPass): RecordedTextureView {
    return pass.descriptor.colorAttachments[0]!.view;
}

/** The one pipeline and one bind group a pass drew once with. */
function passBinding(
    pass: RecordedPass,
    suffix: string,
): {
    pipeline: ScreenSpaceShapes["renderPipeline"];
    group: ScreenSpaceShapes["bindGroup"];
} {
    const pipeline = pass.pipeline;
    const bound = pass.bindGroups.at(-1);
    if (!pipeline || !bound || pass.draws.length !== 1) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass did not bind one ` +
                "pipeline and one bind group for one draw.",
        );
    }
    if (bound.index !== 0) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass bound its group at ` +
                `index ${bound.index}, where its one layout sits at 0.`,
        );
    }
    return { pipeline, group: bound.group };
}

interface PinnedRenderTargetModule {
    createRenderTarget: (descriptor: Record<string, unknown>) => unknown;
    buildRenderTarget: (target: unknown, engine: unknown) => void;
}

interface PinnedCameraModule {
    createArcRotateCamera: (
        alpha: number,
        beta: number,
        radius: number,
        target: { x: number; y: number; z: number },
    ) => unknown;
}

interface PinnedScreenSpaceTask {
    enabled: boolean;
    record(): void;
    execute(): number;
}

/**
 * A texture's role from what the pin labelled it and how it is viewed. The
 * intermediates are the targets the dedicated passes draw into before the
 * resolve, keyed by label in the order the pin first draws into them.
 */
function textureRole(
    view: RecordedTextureView,
    name: string,
    intermediates: ReadonlyMap<string, number>,
): ScreenSpaceTextureRef {
    if ((view.descriptor.aspect ?? "all") === "depth-only") {
        if (
            view.texture.label !== SOURCE_LABEL &&
            view.texture.label !== DEPTH_LABEL
        ) {
            throw new Error(
                `Pinned screen-space task bound a depth-only view of ` +
                    `'${view.texture.label}', which is not its depth source.`,
            );
        }
        return { role: "depth", index: 0 };
    }
    if (view.texture.label === SOURCE_LABEL) {
        return { role: "source-color", index: 0 };
    }
    if (view.texture.label === `${name}-history`) {
        return { role: "history", index: 0 };
    }
    if (view.texture.label === `${name}-stable`) {
        return { role: "stable", index: 0 };
    }
    const intermediate = intermediates.get(view.texture.label);
    if (intermediate !== undefined) {
        return { role: "intermediate", index: intermediate };
    }
    throw new Error(
        `Pinned screen-space task bound '${view.texture.label}', which this ` +
            "port does not know as one of its textures.",
    );
}

/**
 * A dedicated pipeline, read off the first pass that draws with it: its
 * entry points and target format, and each layout entry paired with the
 * identifier the module declares at that binding -- SDL_GPU binds the
 * compiled stage by the identifiers its `.slots` sidecar names, so every
 * binding has to be carried under the pin's own name for it.
 */
function stageOf(
    pipeline: ScreenSpaceShapes["renderPipeline"],
    suffix: string,
    uniformBytes: number,
): ComposedScreenSpaceStage {
    const target = pipeline.fragment.targets[0]!;
    if (target.blend !== undefined) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pipeline blends, which ` +
                "this port does not carry for a dedicated stage.",
        );
    }
    const wgsl = pipeline.vertex.module.code;
    const names = new Map(
        variantBindings(wgsl, wgsl, 0).map((binding) => [
            binding.binding,
            binding.name,
        ]),
    );
    const bindings = pipeline.layout.bindGroupLayouts[0]!.entries.map(
        (entry): ScreenSpaceStageBinding => {
            const declared = names.get(entry.binding);
            if (declared === undefined) {
                throw new Error(
                    `Pinned screen-space task's '${suffix}' layout binding ` +
                        `${entry.binding} is not declared by its module.`,
                );
            }
            return {
                binding: entry.binding,
                name: declared,
                kind: layoutKind(entry),
            };
        },
    );
    return {
        wgsl,
        vertexEntry: pipeline.vertex.entryPoint,
        fragmentEntry: pipeline.fragment.entryPoint,
        targetFormat: target.format,
        uniformBytes,
        bindings,
    };
}

/**
 * One dedicated pass: the stage it draws with (shared by every pass over
 * the same recorded pipeline), what it draws into, and what the bind group
 * it set put at each of the stage's bindings.
 */
function stagePassFrom(
    pass: RecordedPass,
    name: string,
    recorder: ScreenSpaceRecorder,
    intermediates: ReadonlyMap<string, number>,
    stages: Map<ScreenSpaceShapes["renderPipeline"], ComposedScreenSpaceStage>,
): ComposedScreenSpaceStagePass {
    const suffix = strippedLabel(pass.descriptor.label ?? "", name);
    const { pipeline, group } = passBinding(pass, suffix);
    const attachment = passAttachment(pass);
    const format = pipeline.fragment.targets[0]!.format;
    if (format !== attachment.texture.format) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pipeline targets ` +
                `'${format}' but draws into '${attachment.texture.format}'.`,
        );
    }
    if (pass.descriptor.colorAttachments[0]!.loadOp !== "clear") {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass loads its target, ` +
                "where both backends clear it.",
        );
    }
    const uniform = recorder.buffers.find(
        (buffer) => buffer.label === `${name}-${suffix}-uniforms`,
    );
    if (!uniform) {
        throw new Error(
            `Pinned screen-space task created no '${suffix}' uniform buffer.`,
        );
    }
    let stage = stages.get(pipeline);
    if (!stage) {
        stage = stageOf(pipeline, suffix, uniform.size);
        stages.set(pipeline, stage);
    } else if (stage.uniformBytes !== uniform.size) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass binds a ` +
                `${uniform.size}-byte block to a pipeline another pass ` +
                `binds ${stage.uniformBytes} bytes to.`,
        );
    }
    const textures = pipeline.layout.bindGroupLayouts[0]!.entries.map(
        (entry): ScreenSpaceTextureRef | undefined => {
            const kind = layoutKind(entry);
            const bound = group.entries.find(
                (candidate) => candidate.binding === entry.binding,
            );
            if (!bound) {
                throw new Error(
                    `Pinned screen-space task's '${suffix}' layout binding ` +
                        `${entry.binding} is not bound.`,
                );
            }
            if (kind !== "depth-texture" && kind !== "texture") {
                return undefined;
            }
            if (!(bound.resource instanceof RecordedTextureView)) {
                throw new Error(
                    `Pinned screen-space task bound binding ` +
                        `${entry.binding} of '${suffix}' to a non-texture.`,
                );
            }
            return textureRole(bound.resource, name, intermediates);
        },
    );
    const target = textureRole(attachment, name, intermediates);
    if (target.role !== "intermediate" && target.role !== "stable") {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass draws into its ` +
                `${target.role} texture.`,
        );
    }
    return { label: suffix, stage, target, textures };
}

/**
 * One of the task's ordinary post-process passes, read off its pass: the
 * pin's `createPostProcessGpuState` binds the sampler at 0, the source at 1,
 * each extra texture from 2 and the uniform block at its own binding.
 */
function postProcessPassFrom(
    pass: RecordedPass,
    name: string,
    recorder: ScreenSpaceRecorder,
    suffix: string,
    intermediates: ReadonlyMap<string, number>,
): ComposedScreenSpacePass {
    const { pipeline, group } = passBinding(pass, suffix);
    const bound = group.entries.find((entry) => entry.binding === 0);
    const sampler = recorder.samplers.find(
        (candidate) => candidate === bound?.resource,
    );
    if (!sampler) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass binds no sampler at 0.`,
        );
    }
    const sampling = sampler.magFilter ?? "nearest";
    if (sampling !== "nearest" && sampling !== "linear") {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass samples '${sampling}'.`,
        );
    }
    const uniformEntry = pipeline.layout.bindGroupLayouts[0]!.entries.find(
        (entry) => layoutKind(entry) === "uniform",
    );
    const uniform = recorder.buffers.find(
        (buffer) => buffer.label === `${name}-${suffix}-uniforms`,
    );
    if ((uniformEntry === undefined) !== (uniform === undefined)) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass declares a uniform ` +
                "block without a buffer, or the reverse.",
        );
    }
    const extraTextures: ScreenSpaceTextureRef[] = [];
    for (const entry of group.entries) {
        if (
            entry.binding < 2 ||
            !(entry.resource instanceof RecordedTextureView)
        )
            continue;
        extraTextures[entry.binding - 2] = textureRole(
            entry.resource,
            name,
            intermediates,
        );
    }
    return {
        wgsl: pipeline.vertex.module.code,
        uniformByteLength: uniform?.size ?? 0,
        uniformBinding: uniformEntry?.binding ?? 0,
        sampling,
        blended: pipeline.fragment.targets[0]!.blend !== undefined,
        clear: pass.descriptor.colorAttachments[0]!.loadOp === "clear",
        extraTextures,
    };
}

function strippedLabel(label: string, name: string): string {
    if (!label.startsWith(`${name}-`)) {
        throw new Error(
            `Pinned screen-space task encoded a pass named '${label}', which ` +
                "does not derive from the name it was given.",
        );
    }
    return label.slice(name.length + 1);
}

/**
 * The pass order both backends encode by hand, asserted against what the
 * pin encoded: an enabled frame runs the factory's dedicated passes ending
 * in the resolve, then the history copy and then the composite; the frame
 * after `enabled` went false clears both temporal targets once and still
 * composites the source through.
 */
function assertPassSequence(
    intrinsic: string,
    state: string,
    encoded: readonly string[],
    expected: readonly string[],
): void {
    if (
        encoded.length !== expected.length ||
        encoded.some((label, index) => label !== expected[index])
    ) {
        throw new Error(
            `Pinned ${intrinsic} encodes a ${state} frame as [${encoded.join(
                ", ",
            )}], where this port's backends encode [${expected.join(", ")}].`,
        );
    }
}

/**
 * The targets the dedicated passes before the resolve draw into, numbered
 * in the order the pin first draws into each; every one must be a target
 * the factory owns, never the temporal pair.
 */
function intermediateTargets(
    intrinsic: string,
    name: string,
    passes: readonly RecordedPass[],
): { indices: Map<string, number>; formats: string[] } {
    const indices = new Map<string, number>();
    const formats: string[] = [];
    for (const pass of passes) {
        const texture = passAttachment(pass).texture;
        const label = texture.label;
        if (
            !label.startsWith(`${name}-`) ||
            label === `${name}-stable` ||
            label === `${name}-history`
        ) {
            throw new Error(
                `Pinned ${intrinsic}'s '${pass.descriptor.label}' pass draws ` +
                    `into '${label}', which is not a target it owns between ` +
                    "its passes.",
            );
        }
        if (!indices.has(label)) {
            indices.set(label, formats.length);
            formats.push(texture.format);
        }
    }
    return { indices, formats };
}

/**
 * Runs the pinned factory for one enabled and one disabled frame and reads
 * the task's structure off the recorded device calls.
 */
export async function composeScreenSpaceTask(
    request: ScreenSpaceCompositionRequest,
): Promise<ComposedScreenSpaceTask> {
    const facts = screenSpaceFacts(request.intrinsic);
    const { kind, module } = facts;
    const factoryModule = await importPinnedModule<
        Record<
            string,
            (config: unknown, engine: unknown, scene: unknown) => unknown
        >
    >(pinnedEffectModule({ module }));
    const factory = factoryModule[request.intrinsic];
    if (typeof factory !== "function") {
        throw new Error(
            `Pinned module ${module} no longer exports ${request.intrinsic}.`,
        );
    }
    const renderTargets = await importPinnedModule<PinnedRenderTargetModule>(
        "engine/render-target.js",
    );
    const cameras = await importPinnedModule<PinnedCameraModule>(
        "camera/arc-rotate.js",
    );
    const canvas = { width: 1280, height: 720 };
    const { engine, recorder } = recordingEngine(canvas);
    const built = (label: string, depth: boolean): unknown => {
        const target = renderTargets.createRenderTarget({
            lbl: label,
            format: "bgra8unorm",
            ...(depth ? { dFormat: "depth24plus-stencil8" } : {}),
            samples: 1,
            size: { width: canvas.width, height: canvas.height },
        });
        renderTargets.buildRenderTarget(target, engine);
        return target;
    };
    const name = COMPOSITION_NAME;
    const config: Record<string, unknown> = {
        ...request.options,
        name,
        sourceTexture: built(SOURCE_LABEL, true),
        ...(request.hasDepthTexture
            ? { depthTexture: built(DEPTH_LABEL, true) }
            : {}),
        targetTexture: request.hasTarget ? built(TARGET_LABEL, false) : null,
        camera: cameras.createArcRotateCamera(0.4, 1.1, 8, {
            x: 0,
            y: 1,
            z: 0,
        }),
        ...(screenSpaceReadsLightDirection(request.intrinsic)
            ? { lightDirection: { x: 0.3, y: -1, z: 0.18 } }
            : {}),
    };
    const task = factory(config, engine, undefined) as PinnedScreenSpaceTask;
    // The settings the pin publishes on the task are its clamped ones: a
    // number in the scalar table, or the tint triple. Everything else on
    // the object is one of the known non-settings; a property outside both
    // is a setting the native record does not carry, refused rather than
    // dropped.
    const settings: Record<string, number | readonly number[]> = {};
    for (const [key, value] of Object.entries(task)) {
        if (key.startsWith("_") || NON_SETTING_PROPERTIES.has(key)) continue;
        if (
            typeof value === "number" &&
            SCREEN_SPACE_SCALAR_SETTINGS.includes(key)
        ) {
            settings[key] = value;
        } else if (
            Array.isArray(value) &&
            value.length > 0 &&
            value.every((lane) => typeof lane === "number") &&
            SCREEN_SPACE_VECTOR_SETTINGS.includes(key)
        ) {
            settings[key] = [...value];
        } else {
            throw new Error(
                `Pinned ${request.intrinsic} publishes '${key}', which the ` +
                    "native task record does not carry.",
            );
        }
    }
    const clamp = (factoryModule as Record<string, unknown>)[facts.clamp];
    if (typeof clamp !== "function") {
        throw new Error(
            `Pinned module ${module} no longer exports ${facts.clamp}.`,
        );
    }
    const clamped = (clamp as (config: unknown) => Record<string, unknown>)(
        config,
    );
    if (
        typeof clamped.resolutionScale !== "number" ||
        typeof clamped.temporalSamples !== "number"
    ) {
        throw new Error(
            `Pinned ${facts.clamp} no longer clamps resolutionScale and ` +
                "temporalSamples.",
        );
    }
    task.record();
    const before = recorder.renderPasses.length;
    task.execute();
    const enabled = recorder.renderPasses.slice(before);
    task.enabled = false;
    const beforeDisabled = recorder.renderPasses.length;
    task.execute();
    const disabled = recorder.renderPasses.slice(beforeDisabled);
    assertRecordedShapes(recorder);

    const label = (pass: RecordedPass): string =>
        strippedLabel(pass.descriptor.label ?? "", name);
    // An enabled frame is the factory's own dedicated passes ending in the
    // owner's resolve, then the owner's history copy and the composite.
    const historyIndex = enabled.findIndex(
        (pass) => label(pass) === "history-copy",
    );
    const dedicated = historyIndex > 0 ? enabled.slice(0, historyIndex) : [];
    const dedicatedLabels = dedicated.map(label);
    if (
        dedicated.length < 2 ||
        dedicatedLabels.at(-1) !== "resolve" ||
        new Set(dedicatedLabels).size !== dedicatedLabels.length
    ) {
        throw new Error(
            `Pinned ${request.intrinsic} encoded an enabled frame as ` +
                `[${enabled.map(label).join(", ")}], not as its own passes ` +
                "ending in one resolve before the history copy.",
        );
    }
    const compositePass = enabled
        .slice(historyIndex + 1)
        .find((pass) => label(pass) === "composite");
    const compositeLabels = compositePass ? ["composite"] : [];
    assertPassSequence(request.intrinsic, "enabled", enabled.map(label), [
        ...dedicatedLabels,
        "history-copy",
        ...compositeLabels,
    ]);
    assertPassSequence(request.intrinsic, "disabled", disabled.map(label), [
        "clear-stable",
        "clear-history",
        ...compositeLabels,
    ]);
    const intermediates = intermediateTargets(
        request.intrinsic,
        name,
        dedicated.slice(0, -1),
    );
    const stages = new Map<
        ScreenSpaceShapes["renderPipeline"],
        ComposedScreenSpaceStage
    >();
    const passes = dedicated.map((pass) =>
        stagePassFrom(pass, name, recorder, intermediates.indices, stages),
    );
    const historyPass = enabled[historyIndex]!;
    const historyCopy = postProcessPassFrom(
        historyPass,
        name,
        recorder,
        "history-copy",
        intermediates.indices,
    );
    const composite = compositePass
        ? postProcessPassFrom(
              compositePass,
              name,
              recorder,
              "composite",
              intermediates.indices,
          )
        : null;
    if (
        historyCopy.uniformByteLength !== 0 ||
        historyCopy.extraTextures.length !== 0
    ) {
        throw new Error(
            `Pinned ${request.intrinsic} builds a history copy with uniforms ` +
                "or extra textures, which this port does not carry.",
        );
    }
    if (composite?.blended) {
        throw new Error(
            `Pinned ${request.intrinsic} composites with a blend, which this ` +
                "port does not carry.",
        );
    }
    const stable = passAttachment(dedicated.at(-1)!).texture;
    const history = passAttachment(historyPass).texture;
    if (
        stable.label !== `${name}-stable` ||
        history.label !== `${name}-history`
    ) {
        throw new Error(
            `Pinned ${request.intrinsic} resolves into '${stable.label}' and ` +
                `copies into '${history.label}'.`,
        );
    }
    if (history.format !== stable.format) {
        throw new Error(
            `Pinned ${request.intrinsic} keeps stable and history targets in ` +
                "different formats.",
        );
    }
    return {
        intrinsic: request.intrinsic,
        kind,
        settings,
        clamped: {
            resolutionScale: clamped.resolutionScale,
            temporalSamples: clamped.temporalSamples,
        },
        passes,
        intermediates: intermediates.formats,
        historyCopy,
        composite,
    };
}
