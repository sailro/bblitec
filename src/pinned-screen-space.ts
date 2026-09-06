/**
 * Composes a screen-space effect task by running Babylon Lite's own factory.
 *
 * `screen-space-contact-shadows.ts` and `screen-space-global-illumination.ts`
 * each build one frame-graph task out of four GPU programs: a producer that
 * raymarches the scene depth through a depth-only view, the shared temporal
 * resolve (`screen-space-temporal.ts`), a history copy and an optional
 * composite. The last two are ordinary `createPostProcessTask` passes; the
 * first two are dedicated pipelines the factory builds itself. None of it
 * touches a real device: `record()` and `execute()` create everything through
 * `engine._device` and encode through `engine._currentEncoder`, which is what
 * the pin's own unit tests exploit with a mock device.
 *
 * So composition does the same, against a device that RECORDS. Running the
 * factory, `record()`, one enabled `execute()` and one disabled `execute()`
 * yields every shader module (by label), every pipeline's entry points and
 * target format, every bind group's binding-to-texture wiring, every buffer's
 * size and the pass sequence of both states -- all read off the pin's own
 * calls rather than restated. What generation then lowers from the pinned
 * ASTs (`screen-space-lowerer.ts`) is the arithmetic those calls carry: the
 * temporal state machine and the two uniform blocks.
 */
import { pinnedEffectModule } from "./post-process-effects.js";
import { snakeCase } from "./cpp-literals.js";
import type { PostProcessOptionValue } from "./compiler/types.js";
import type { ComposedPostProcess } from "./pinned-post-process.js";
import { variantBindings } from "./pinned-pbr-variant-cpp.js";
import { importPinnedModule } from "./pinned-shader-composer.js";

/**
 * What one entry point decides, keyed by the entry point: the temporal
 * kind, the pinned module and the symbols this port reads out of it, the
 * generated frame function and enumerator, and the name the pin publishes
 * its stable target under. Every consumer that branches on the kind reads
 * this table, so a third effect is one row rather than one more arm at
 * each of them.
 */
export interface ScreenSpaceKindFacts {
    /** The temporal owner's kind: scalar contact shadows or colour GI. */
    kind: "scalar" | "color";
    /** The pinned module, relative to the package's `src`. */
    module: string;
    /** The config interface the factory declares. */
    configType: string;
    /** The pinned clamp the factory applies at creation. */
    clamp: string;
    /** The module constant sizing the producer's uniform block, in floats. */
    producerUniformFloats: string;
    /** The generated per-frame function. */
    frameFunction: string;
    /** The native `ScreenSpaceEffectKind` enumerator. */
    enumerator: string;
    /** The task property the pin publishes the stable target under. */
    stableTexture: string;
}

export const SCREEN_SPACE_KINDS: Readonly<Record<string, ScreenSpaceKindFacts>> = {
    createScreenSpaceContactShadowsPostProcessTask: {
        kind: "scalar",
        module: "src/post-process/screen-space-contact-shadows.ts",
        configType: "ScreenSpaceContactShadowsPostProcessTaskConfig",
        clamp: "clampScreenSpaceContactShadowsConfig",
        producerUniformFloats: "SS_CONTACT_PRODUCER_UNIFORM_FLOATS",
        frameFunction: "contact_shadows_frame",
        enumerator: "contact_shadows",
        stableTexture: "shadowTexture",
    },
    createScreenSpaceGlobalIlluminationPostProcessTask: {
        kind: "color",
        module: "src/post-process/screen-space-global-illumination.ts",
        configType: "ScreenSpaceGlobalIlluminationPostProcessTaskConfig",
        clamp: "clampScreenSpaceGlobalIlluminationConfig",
        producerUniformFloats: "SS_GI_PRODUCER_UNIFORM_FLOATS",
        frameFunction: "global_illumination_frame",
        enumerator: "global_illumination",
        stableTexture: "illuminationTexture",
    },
};

/** The shared temporal module and the constant sizing its uniform block. */
export const SCREEN_SPACE_TEMPORAL_MODULE =
    "src/post-process/screen-space-temporal.ts";
export const SCREEN_SPACE_TEMPORAL_UNIFORM_FLOATS =
    "SS_TEMPORAL_UNIFORM_FLOATS";

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

/** The row of the entry point creating a temporal kind. */
export function screenSpaceFactsOfKind(
    kind: "scalar" | "color",
): ScreenSpaceKindFacts & { intrinsic: string } {
    for (const [intrinsic, facts] of Object.entries(SCREEN_SPACE_KINDS)) {
        if (facts.kind === kind) return { ...facts, intrinsic };
    }
    throw new Error(`No screen-space entry point creates a ${kind} task.`);
}

/**
 * The scalar settings the pin keeps on its task object, as it spells them.
 * Both kinds share the first group; each publishes its own after that. The
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
];

/** The one triple the contact task publishes, carried as three lanes. */
export const SCREEN_SPACE_VECTOR_SETTINGS: readonly string[] = ["tint"];

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

export interface ScreenSpaceCompositionRequest {
    /** The Babylon Lite entry point the task was created through. */
    intrinsic: string;
    /** Every option the scene wrote, statically resolved and forwarded whole. */
    options: Readonly<Record<string, PostProcessOptionValue>>;
    /** Whether the scene named a composite target. */
    hasTarget: boolean;
    /** Whether the scene named a depth source apart from the colour source. */
    hasDepthTexture: boolean;
}

/** Which texture a stage's binding reads, by what the pin bound there. */
export type ScreenSpaceTextureRole =
    | "depth"
    | "source-color"
    | "raw"
    | "history"
    | "stable";

export interface ScreenSpaceStageBinding {
    /** The WGSL `@binding` index, which is the pin's own group-0 slot. */
    binding: number;
    /** The WGSL identifier declared at that binding. */
    name: string;
    kind: "depth-texture" | "texture" | "sampler" | "uniform";
    /** For a texture binding, which frame-graph texture the pin bound. */
    role?: ScreenSpaceTextureRole;
}

/** One dedicated pipeline: the producer or the temporal resolve. */
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
    /** The uniform buffer's byte size. */
    uniformBytes: number;
    bindings: readonly ScreenSpaceStageBinding[];
}

/** One ordinary post-process pass the task built: history copy or composite. */
export interface ComposedScreenSpacePass extends ComposedPostProcess {
    sampling: "nearest" | "linear";
    /** Whether the pin's pipeline blends into its target. */
    blended: boolean;
    clear: boolean;
    /** The textures bound after the source, by role, in binding order. */
    extraTextures: readonly ScreenSpaceTextureRole[];
}

export interface ComposedScreenSpaceTask {
    intrinsic: string;
    /** The temporal owner's kind: scalar contact shadows or colour GI. */
    kind: "scalar" | "color";
    /**
     * The live settings the factory published on its task object, after
     * its own clamp -- `intensity`, `stepCount`, the contact `tint` triple
     * and the rest -- keyed as the pin spells them.
     */
    settings: Readonly<Record<string, number | readonly number[]>>;
    /** The creation-time settings the pin keeps in `params` alone. */
    clamped: { resolutionScale: number; temporalSamples: number };
    producer: ComposedScreenSpaceStage;
    resolve: ComposedScreenSpaceStage;
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

interface RecordedTexture {
    label: string;
    format: string;
}

interface RecordedView {
    texture: RecordedTexture;
    aspect: string;
}

interface RecordedSampler {
    magFilter: string;
}

interface RecordedBuffer {
    label: string;
    size: number;
}

interface RecordedModule {
    code: string;
}

interface RecordedLayoutEntry {
    binding: number;
    kind: ScreenSpaceStageBinding["kind"];
}

interface RecordedLayout {
    entries: readonly RecordedLayoutEntry[];
}

interface RecordedPipeline {
    module: RecordedModule;
    vertexEntry: string;
    fragmentEntry: string;
    targetFormat: string;
    blended: boolean;
    layout: RecordedLayout;
}

interface RecordedGroupEntry {
    binding: number;
    resource: RecordedView | RecordedSampler | { buffer: RecordedBuffer };
}

interface RecordedGroup {
    entries: readonly RecordedGroupEntry[];
}

interface RecordedPass {
    label: string;
    attachment: RecordedTexture;
    loadOp: string;
    pipeline?: RecordedPipeline;
    group?: RecordedGroup;
    draws: number;
}

interface Recorder {
    buffers: RecordedBuffer[];
    passes: RecordedPass[];
}

/**
 * A device that answers every call the pin's `record()` and `execute()`
 * make and remembers what was asked. Anything the pin started calling
 * beyond this surface is a `TypeError` rather than a quietly different
 * composition, which is the property that makes the stub safe.
 */
function recordingEngine(
    recorder: Recorder,
    canvas: { width: number; height: number },
): unknown {
    const layoutKind = (entry: {
        texture?: { sampleType?: string };
        sampler?: unknown;
        buffer?: unknown;
    }): RecordedLayoutEntry["kind"] => {
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
    };
    const device = {
        createShaderModule: (descriptor: { code: string }): RecordedModule => ({
            code: descriptor.code,
        }),
        createTexture: (descriptor: {
            label?: string;
            format: string;
            size: { width: number; height: number };
        }) => {
            const texture: RecordedTexture = {
                label: descriptor.label ?? "",
                format: descriptor.format,
            };
            return {
                createView: (options?: { aspect?: string }): RecordedView => ({
                    texture,
                    aspect: options?.aspect ?? "all",
                }),
                destroy: () => {},
            };
        },
        createBuffer: (descriptor: {
            label: string;
            size: number;
        }): RecordedBuffer & { destroy: () => void } => {
            const buffer = {
                label: descriptor.label,
                size: descriptor.size,
                destroy: () => {},
            };
            recorder.buffers.push(buffer);
            return buffer;
        },
        createSampler: (descriptor: { magFilter?: string }): RecordedSampler => ({
            magFilter: descriptor.magFilter ?? "nearest",
        }),
        createBindGroupLayout: (descriptor: {
            entries: readonly {
                binding: number;
                texture?: { sampleType?: string };
                sampler?: unknown;
                buffer?: unknown;
            }[];
        }): RecordedLayout => ({
            entries: descriptor.entries.map((entry) => ({
                binding: entry.binding,
                kind: layoutKind(entry),
            })),
        }),
        createPipelineLayout: (descriptor: {
            bindGroupLayouts: readonly RecordedLayout[];
        }) => ({ layouts: descriptor.bindGroupLayouts }),
        createRenderPipeline: (descriptor: {
            layout: { layouts: readonly RecordedLayout[] };
            vertex: { module: RecordedModule; entryPoint: string };
            fragment: {
                entryPoint: string;
                targets: readonly { format: string; blend?: unknown }[];
            };
        }): RecordedPipeline => {
            if (
                descriptor.layout.layouts.length !== 1 ||
                descriptor.fragment.targets.length !== 1
            ) {
                throw new Error(
                    "Pinned screen-space task built a pipeline with other " +
                        "than one bind group and one colour target.",
                );
            }
            return {
                module: descriptor.vertex.module,
                vertexEntry: descriptor.vertex.entryPoint,
                fragmentEntry: descriptor.fragment.entryPoint,
                targetFormat: descriptor.fragment.targets[0]!.format,
                blended: descriptor.fragment.targets[0]!.blend !== undefined,
                layout: descriptor.layout.layouts[0]!,
            };
        },
        createBindGroup: (descriptor: {
            entries: readonly RecordedGroupEntry[];
        }): RecordedGroup => ({ entries: descriptor.entries }),
        queue: { writeBuffer: () => {} },
    };
    const encoder = {
        beginRenderPass: (descriptor: {
            label: string;
            colorAttachments: readonly {
                view: RecordedView;
                loadOp: string;
            }[];
        }) => {
            if (descriptor.colorAttachments.length !== 1) {
                throw new Error(
                    "Pinned screen-space task began a pass with other than " +
                        "one colour attachment.",
                );
            }
            const attachment = descriptor.colorAttachments[0]!;
            const pass: RecordedPass = {
                label: descriptor.label,
                attachment: attachment.view.texture,
                loadOp: attachment.loadOp,
                draws: 0,
            };
            recorder.passes.push(pass);
            return {
                setPipeline: (pipeline: RecordedPipeline) => {
                    pass.pipeline = pipeline;
                },
                setBindGroup: (_index: number, group: RecordedGroup) => {
                    pass.group = group;
                },
                draw: () => {
                    pass.draws += 1;
                },
                setViewport: () => {},
                setScissorRect: () => {},
                end: () => {},
            };
        },
    };
    const engine = {
        canvas,
        msaaSamples: 1,
        useHighPrecisionMatrix: false,
        useFloatingOrigin: false,
        _device: device,
        _currentEncoder: encoder,
        _currentDelta: 0,
        _cbs: [],
    };
    return engine;
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

/** A texture's role from what the pin labelled it and how it is viewed. */
function textureRole(
    view: RecordedView,
    name: string,
): ScreenSpaceTextureRole {
    if (view.aspect === "depth-only") {
        if (
            view.texture.label !== SOURCE_LABEL &&
            view.texture.label !== DEPTH_LABEL
        ) {
            throw new Error(
                `Pinned screen-space task bound a depth-only view of ` +
                    `'${view.texture.label}', which is not its depth source.`,
            );
        }
        return "depth";
    }
    if (view.texture.label === SOURCE_LABEL) return "source-color";
    if (view.texture.label === `${name}-raw`) return "raw";
    if (view.texture.label === `${name}-history`) return "history";
    if (view.texture.label === `${name}-stable`) return "stable";
    throw new Error(
        `Pinned screen-space task bound '${view.texture.label}', which this ` +
            "port does not know as one of its textures.",
    );
}

/**
 * A dedicated stage, read off its pass: the pipeline's entry points and
 * target format, and each layout entry paired with what the bind group put
 * there and the identifier the module declares at that binding -- SDL_GPU
 * binds the compiled stage by the identifiers its `.slots` sidecar names,
 * so every role has to be carried under the pin's own name for it.
 */
function stageFrom(
    pass: RecordedPass,
    name: string,
    buffers: readonly RecordedBuffer[],
    suffix: string,
): ComposedScreenSpaceStage {
    const pipeline = pass.pipeline;
    const group = pass.group;
    if (!pipeline || !group || pass.draws !== 1) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass did not bind one ` +
                "pipeline and one bind group for one draw.",
        );
    }
    if (pipeline.blended) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pipeline blends, which ` +
                "this port does not carry for a dedicated stage.",
        );
    }
    if (pipeline.targetFormat !== pass.attachment.format) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pipeline targets ` +
                `'${pipeline.targetFormat}' but draws into ` +
                `'${pass.attachment.format}'.`,
        );
    }
    const wgsl = pipeline.module.code;
    const names = new Map(
        variantBindings(wgsl, wgsl, 0).map((binding) => [
            binding.binding,
            binding.name,
        ]),
    );
    const bindings = pipeline.layout.entries.map(
        (entry): ScreenSpaceStageBinding => {
            const bound = group.entries.find(
                (candidate) => candidate.binding === entry.binding,
            );
            const declared = names.get(entry.binding);
            if (!bound || declared === undefined) {
                throw new Error(
                    `Pinned screen-space task's '${suffix}' layout binding ` +
                        `${entry.binding} is not bound or not declared.`,
                );
            }
            const resource = bound.resource;
            if (entry.kind === "depth-texture" || entry.kind === "texture") {
                if (!("texture" in resource)) {
                    throw new Error(
                        `Pinned screen-space task bound binding ` +
                            `${entry.binding} of '${suffix}' to a non-texture.`,
                    );
                }
                return {
                    binding: entry.binding,
                    name: declared,
                    kind: entry.kind,
                    role: textureRole(resource, name),
                };
            }
            return { binding: entry.binding, name: declared, kind: entry.kind };
        },
    );
    const uniform = buffers.find(
        (buffer) => buffer.label === `${name}-${suffix}-uniforms`,
    );
    if (!uniform) {
        throw new Error(
            `Pinned screen-space task created no '${suffix}' uniform buffer.`,
        );
    }
    return {
        wgsl,
        vertexEntry: pipeline.vertexEntry,
        fragmentEntry: pipeline.fragmentEntry,
        targetFormat: pipeline.targetFormat,
        uniformBytes: uniform.size,
        bindings,
    };
}

/**
 * One of the task's ordinary post-process passes, read off its pass: the
 * pin's `createPostProcessGpuState` binds the sampler at 0, the source at 1,
 * each extra texture from 2 and the uniform block at its own binding.
 */
function postProcessPassFrom(
    pass: RecordedPass,
    name: string,
    buffers: readonly RecordedBuffer[],
    suffix: string,
): ComposedScreenSpacePass {
    const pipeline = pass.pipeline;
    const group = pass.group;
    if (!pipeline || !group || pass.draws !== 1) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass did not bind one ` +
                "pipeline and one bind group for one draw.",
        );
    }
    const sampler = group.entries.find((entry) => entry.binding === 0);
    if (!sampler || !("magFilter" in sampler.resource)) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass binds no sampler at 0.`,
        );
    }
    const sampling = sampler.resource.magFilter;
    if (sampling !== "nearest" && sampling !== "linear") {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass samples '${sampling}'.`,
        );
    }
    const uniformEntry = pipeline.layout.entries.find(
        (entry) => entry.kind === "uniform",
    );
    const uniform = buffers.find(
        (buffer) => buffer.label === `${name}-${suffix}-uniforms`,
    );
    if ((uniformEntry === undefined) !== (uniform === undefined)) {
        throw new Error(
            `Pinned screen-space task's '${suffix}' pass declares a uniform ` +
                "block without a buffer, or the reverse.",
        );
    }
    const extraTextures: ScreenSpaceTextureRole[] = [];
    for (const entry of group.entries) {
        if (entry.binding < 2 || !("texture" in entry.resource)) continue;
        extraTextures[entry.binding - 2] = textureRole(entry.resource, name);
    }
    return {
        wgsl: pipeline.module.code,
        uniformByteLength: uniform?.size ?? 0,
        uniformBinding: uniformEntry?.binding ?? 0,
        sampling,
        blended: pipeline.blended,
        clear: pass.loadOp === "clear",
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
 * pin encoded: an enabled frame runs producer, resolve and history copy
 * and then the composite; the frame after `enabled` went false clears both
 * temporal targets once and still composites the source through.
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
 * Runs the pinned factory for one enabled and one disabled frame and reads
 * the task's structure off the recorded device calls.
 */
export async function composeScreenSpaceTask(
    request: ScreenSpaceCompositionRequest,
): Promise<ComposedScreenSpaceTask> {
    const facts = screenSpaceFacts(request.intrinsic);
    const { kind, module } = facts;
    const factoryModule = await importPinnedModule<
        Record<string, (config: unknown, engine: unknown, scene: unknown) => unknown>
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
    const recorder: Recorder = { buffers: [], passes: [] };
    const canvas = { width: 1280, height: 720 };
    const engine = recordingEngine(recorder, canvas);
    const built = (
        label: string,
        depth: boolean,
    ): unknown => {
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
        camera: cameras.createArcRotateCamera(0.4, 1.1, 8, { x: 0, y: 1, z: 0 }),
        ...(kind === "scalar"
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
            settings[key] = [...(value as number[])];
        } else {
            throw new Error(
                `Pinned ${request.intrinsic} publishes '${key}', which the ` +
                    "native task record does not carry.",
            );
        }
    }
    const clamp = (factoryModule as Record<string, unknown>)[facts.clamp];
    if (typeof clamp !== "function") {
        throw new Error(`Pinned module ${module} no longer exports ${facts.clamp}.`);
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
    const before = recorder.passes.length;
    task.execute();
    const enabled = recorder.passes.slice(before);
    task.enabled = false;
    const beforeDisabled = recorder.passes.length;
    task.execute();
    const disabled = recorder.passes.slice(beforeDisabled);

    const find = (
        passes: readonly RecordedPass[],
        suffix: string,
    ): RecordedPass | undefined =>
        passes.find((pass) => pass.label === `${name}-${suffix}`);
    const producerPass = find(enabled, "producer");
    const resolvePass = find(enabled, "resolve");
    const historyPass = find(enabled, "history-copy");
    if (!producerPass || !resolvePass || !historyPass) {
        throw new Error(
            `Pinned ${request.intrinsic} encoded an enabled frame without a ` +
                "producer, resolve and history-copy pass.",
        );
    }
    const compositePass = find(enabled, "composite");
    const compositeLabels = compositePass ? ["composite"] : [];
    assertPassSequence(
        request.intrinsic,
        "enabled",
        enabled.map((pass) => strippedLabel(pass.label, name)),
        ["producer", "resolve", "history-copy", ...compositeLabels],
    );
    assertPassSequence(
        request.intrinsic,
        "disabled",
        disabled.map((pass) => strippedLabel(pass.label, name)),
        ["clear-stable", "clear-history", ...compositeLabels],
    );
    const producer = stageFrom(producerPass, name, recorder.buffers, "producer");
    const resolve = stageFrom(resolvePass, name, recorder.buffers, "resolve");
    const historyCopy = postProcessPassFrom(
        historyPass,
        name,
        recorder.buffers,
        "history-copy",
    );
    const composite = compositePass
        ? postProcessPassFrom(compositePass, name, recorder.buffers, "composite")
        : null;
    if (historyCopy.uniformByteLength !== 0 || historyCopy.extraTextures.length !== 0) {
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
    const stable = resolvePass.attachment;
    if (stable.label !== `${name}-stable` || historyPass.attachment.label !== `${name}-history`) {
        throw new Error(
            `Pinned ${request.intrinsic} resolves into '${stable.label}' and ` +
                `copies into '${historyPass.attachment.label}'.`,
        );
    }
    if (historyPass.attachment.format !== stable.format) {
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
        producer,
        resolve,
        historyCopy,
        composite,
    };
}
