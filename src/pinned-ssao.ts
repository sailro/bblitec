/**
 * Composes `createSsaoTask` (XeGTAO with temporal reconstruction) by running
 * Babylon Lite's own factory and enablers against the recording device.
 *
 * The pin's task builds every GPU object itself through `engine._device` and
 * encodes through `engine._currentEncoder`: compute passes for depth
 * preparation, estimation and the spatial resolve, render passes for the
 * temporal reconstruction, and with `enableSsaoHalfResolution` a prepare and
 * an upsample compute pass around them, and with `enableSsaoMotionPruning` a
 * buffer clear, a mask dispatch and an indirect transport draw. None of it is
 * decided by anything but the configuration, the live settings that select
 * programs (quality, normal input, temporal reconstruction, pruning), the
 * source extent and the temporal history's ping-pong index, so composition
 * runs the factory for each working mode the build can reach, at two source
 * extents, for two frames, and reads off the recording:
 *
 *  - every texture and storage buffer the task owns, with its format or size,
 *    usage, mip chain and the extent it takes from the source (the source's
 *    own, half of it rounded up, or one texel), classified by comparing the
 *    two extents;
 *  - every program: its module text (the pin's own builders' output), entry
 *    points, pipeline-overridable constants, target formats and layout;
 *  - every pass of both history parities in encoding order, with what each
 *    binding of its group reads or writes and, for a dispatch, the storage
 *    view or working extent its workgroup counts cover.
 *
 * What the pin decides per frame from the camera and the history (the
 * uniform blocks, the reset rules, the phase) is lowered from its ASTs
 * (`lowering/ssao-lowerer.ts`); the backends only encode the plan.
 */
import ts from "typescript";
import type {
    PostProcessOptionValue,
    SsaoLiveSetting,
    SsaoTaskManifest,
} from "./compiler/types.js";
import type {
    MaterialPluginManifest,
    MaterialPluginSamplerManifest,
} from "./pinned-material-plugins.js";
import {
    geometryAttachmentDefaultFormat,
    importPinnedModule,
    pinnedSourceModule,
    requirePinnedModule,
} from "./pinned-shader-composer.js";
import {
    RecordedBuffer,
    RecordedTexture,
    RecordedTextureView,
    type RecordedComputeDispatch,
    type RecordedComputePipeline,
    type RecordedPass,
    type RecordedRenderPass,
} from "./recording-device.js";
import {
    builtRenderTarget,
    createRecordingEngine,
    pinnedCameras,
    pinnedRenderTargets,
    plannedLayoutResource,
    type PinnedTaskRecorder,
    type PinnedTaskShapes,
    type PlannedLayoutEntry,
    type RecordedLayoutEntry,
} from "./recording-engine.js";
import {
    reflectWgslBindings,
    reflectWgslModule,
    wgslEntryPoints,
    wgslSamplesTexture,
    wgslWorkgroupSize,
} from "./shader-ir.js";
import { sharedUpstreamStore } from "./upstream-source.js";

/** The pinned modules the composition and the lowering read. */
export const SSAO_MODULE = "src/post-process/ssao.ts";
export const SSAO_GPU_MODULE = "src/post-process/ssao/ssao-gpu.ts";
export const SSAO_TEMPORAL_MODULE = "src/post-process/ssao/ssao-temporal.ts";
export const SSAO_XEGTAO_GPU_MODULE =
    "src/post-process/ssao/ssao-xegtao-gpu.ts";
export const SSAO_HALF_MODULE = "src/post-process/ssao/ssao-half-resolution.ts";
const SSAO_PBR_MODULE = "src/post-process/ssao/ssao-pbr.ts";
export const SSAO_PRUNING_MODULE =
    "src/post-process/ssao/ssao-motion-pruning.ts";
export const SSAO_MOTION_MASK_MODULE =
    "src/post-process/ssao/ssao-motion-mask-wgsl.ts";

/** The pinned public entry points of the family, by the module that exports them. */
export const SSAO_INTRINSICS: ReadonlyMap<string, string> = new Map([
    ["createSsaoTask", SSAO_MODULE],
    ["resetSsaoTemporal", SSAO_TEMPORAL_MODULE],
    ["enableSsaoHalfResolution", SSAO_HALF_MODULE],
    ["enablePbrSsao", SSAO_PBR_MODULE],
    ["enableSsaoMotionPruning", SSAO_PRUNING_MODULE],
]);

/** What generation knows about one reached `createSsaoTask` call. */
export interface SsaoCompositionRequest {
    /** The settings the scene wrote (radius, intensity, quality, normalSpace, temporal). */
    options: Readonly<Record<string, PostProcessOptionValue>>;
    /** The normal input's colour format when one is supplied, at creation or later. */
    normalFormat: string | undefined;
    /** Whether the normal input is supplied at creation. */
    initialNormal: boolean;
    /** Whether `enableSsaoHalfResolution` reaches the task. */
    halfResolution: boolean;
    /** `temporal.velocityTexture`'s colour format and `velocityHasPreviousDepth`. */
    velocity?: { format: string; previousDepth: boolean };
    /** Whether `enableSsaoMotionPruning` reaches the task. */
    motionPruning?: boolean;
    /** The live settings the program writes; each composes every value it can take. */
    live?: readonly SsaoLiveSetting[];
}

/** The live settings one working mode was composed for. */
export interface SsaoModeKey {
    quality: string;
    normal: boolean;
    temporal: boolean;
    /** Motion pruning's transport extension is installed (pruning and temporal enabled). */
    pruning: boolean;
}

/** Where a texture's extent comes from, read off two recorded source extents. */
export type SsaoExtent = "source" | "half" | "unit";

/**
 * A storage buffer's size: fixed, or the pin's motion-mask pyramid over the
 * working extent (`ssaoMotionMaskCellCount(width, height) * 16`).
 */
export type SsaoBufferSize =
    { kind: "fixed"; bytes: number } | { kind: "motion-cells" };

export interface SsaoBufferPlan {
    label: string;
    size: SsaoBufferSize;
    /** The pin's `GPUBufferUsage` bits. */
    usage: number;
}

export interface SsaoTexturePlan {
    label: string;
    format: string;
    extent: SsaoExtent;
    /** The pin's AO mip chain (`ssao_mip_level_count`), or one level. */
    chain: boolean;
    /** The pin's `GPUTextureUsage` bits. */
    usage: number;
}

/** A texture a binding names: one the task owns, or one of its sources. */
export type SsaoTextureRef =
    | { kind: "owned"; texture: number }
    | { kind: "depth-source" }
    | { kind: "normal-source" }
    | { kind: "velocity-source" };

export interface SsaoViewPlan {
    texture: SsaoTextureRef;
    /** Relative to the pass's chain level when `relative`. */
    baseMip: number;
    /** `undefined` views every level from `baseMip`. */
    mipCount: number | undefined;
    relative?: true;
}

export interface SsaoProgramPlan {
    stage: "compute" | "render";
    wgsl: string;
    /** The compute entry point, or the fragment one of a render program. */
    entry: string;
    vertexEntry?: string;
    /** The pipeline-overridable constants, by name. */
    constants: readonly { name: string; value: number }[];
    /** A render program's colour target formats, in attachment order. */
    targets: readonly string[];
    layout: readonly PlannedLayoutEntry[];
    /** A compute program's `@workgroup_size` x and y. */
    workgroup?: readonly [number, number];
}

export interface SsaoSamplerPlan {
    minFilter: "nearest" | "linear";
    magFilter: "nearest" | "linear";
}

export type SsaoResourcePlan =
    | { kind: "uniform"; block: number }
    | { kind: "view"; view: number }
    | { kind: "sampler"; sampler: number }
    | { kind: "buffer"; buffer: number };

export interface SsaoPassPlan {
    /** The pin's pass label, or the cleared buffer's. */
    label: string;
    stage: "compute" | "render" | "clear" | "clear-buffer";
    /** The program a compute or render pass runs. */
    program?: number;
    /** Per layout entry, in layout order. */
    resources: readonly SsaoResourcePlan[];
    /**
     * A dispatch's storage binding whose view extent its workgroups cover;
     * absent for one that covers the working extent.
     */
    domain?: number;
    /** A `clear-buffer` pass's buffer, or the buffer a render pass draws indirectly from. */
    buffer?: number;
    /** A render or clear pass's colour attachments. */
    attachments: readonly { view: number; clear: readonly number[] }[];
    /** The pass runs once per level 1..levels-1 of this owned chain. */
    repeat?: { texture: number };
    /**
     * The dispatch is encoded in the same pinned compute pass as the one
     * before it (the pin's `ssao` pass carries several), which GPU task
     * timing counts as one pass; a repeated dispatch's levels share it too.
     */
    continues?: true;
}

/** One working mode's resources and the passes of both history parities. */
export interface SsaoModePlan {
    /** `half` when the half-resolution adapter is active, `full` otherwise. */
    resolution: "full" | "half";
    key: SsaoModeKey;
    /** The task's textures and buffers this mode uses (`ComposedSsaoTask`). */
    textures: readonly number[];
    buffers: readonly number[];
    /** The texture the task publishes as `outputTexture`. */
    output: number;
    views: readonly SsaoViewPlan[];
    /** Encoded frames by history index (`XegtaoTemporalGpu.index`). */
    frames: readonly [readonly SsaoPassPlan[], readonly SsaoPassPlan[]];
    /** The frame a disabled task encodes: its output cleared to the AO identity. */
    disabled: readonly SsaoPassPlan[];
    /** `SsaoGpu.samplingFootprint`, which a working-resolution adapter sets. */
    samplingFootprint?: number;
}

export interface ComposedSsaoTask {
    /** The live settings the factory published, after its defaults. */
    settings: {
        quality: string;
        radius: number;
        intensity: number;
        temporalEnabled: boolean;
        historySamples: number;
    };
    /** The uniform buffers the task writes, by label, with their sizes. */
    uniforms: readonly { label: string; bytes: number }[];
    programs: readonly SsaoProgramPlan[];
    samplers: readonly SsaoSamplerPlan[];
    /** Every texture and storage buffer a mode owns; one a mode switch keeps is one entry. */
    textures: readonly SsaoTexturePlan[];
    buffers: readonly SsaoBufferPlan[];
    /** Full modes first, then half modes when the adapter is reached. */
    modes: readonly SsaoModePlan[];
    /** The temporal velocity input's colour format, when the task has one. */
    velocityFormat?: string;
}

type SsaoShapes = PinnedTaskShapes;
type SsaoRecorder = PinnedTaskRecorder;

/** The source textures composition builds, by label. */
const DEPTH_LABEL = "bblitec-ssao-depth";
const NORMAL_LABEL = "bblitec-ssao-normal";
const VELOCITY_LABEL = "bblitec-ssao-velocity";

interface PinnedSsaoTask {
    enabled: boolean;
    _gpu: { samplingFootprint?: number; width: number; height: number } | null;
    temporal: { enabled: boolean; historySamples: number };
    quality: string;
    radius: number;
    intensity: number;
    outputTexture: { _colorTexture: unknown };
    record(): void;
    execute(): number;
}
interface PinnedSsaoModule {
    createSsaoTask: (
        config: unknown,
        engine: unknown,
        scene?: unknown,
    ) => PinnedSsaoTask;
}
interface PinnedHalfModule {
    enableSsaoHalfResolution: (task: PinnedSsaoTask) => { active: boolean };
}
interface PinnedPruningModule {
    enableSsaoMotionPruning: (task: PinnedSsaoTask) => { enabled: boolean };
}
interface PinnedMotionMaskModule {
    ssaoMotionMaskCellCount: (width: number, height: number) => number;
}

/** WebGPU defines the device features the browser engine requests; the reference device reports this one. */
const REFERENCE_DEVICE_FEATURES = ["float32-filterable"];

/** The calls the pin's factory, enablers, `record()` and `execute()` make. */
const SSAO_CONTRACT = {
    producer: "ssao",
    device: [
        "createShaderModule",
        "createTexture",
        "createBuffer",
        "createSampler",
        "createBindGroupLayout",
        "createPipelineLayout",
        "createRenderPipeline",
        "createComputePipeline",
        "createBindGroup",
    ],
    queue: ["writeBuffer"],
    encoder: ["beginRenderPass", "beginComputePass", "clearBuffer"],
    renderPass: ["setPipeline", "setBindGroup", "draw", "drawIndirect", "end"],
    computePass: ["setPipeline", "setBindGroup", "dispatchWorkgroups", "end"],
    deviceFields: {
        // WebGPU's default limit, which the pin's engine requests no change to.
        limits: { maxTextureDimension2D: 8192 },
        features: new Set(REFERENCE_DEVICE_FEATURES),
    },
} as const;

/** One mode recorded at one source extent. */
interface Recording {
    width: number;
    height: number;
    recorder: SsaoRecorder;
    task: PinnedSsaoTask;
    /** Both history parities, then the frame after `enabled` went false. */
    frames: [
        RecordedPass<SsaoShapes>[],
        RecordedPass<SsaoShapes>[],
        RecordedPass<SsaoShapes>[],
    ];
    halfActive: boolean;
    samplingFootprint: number | undefined;
    /** The working owner's (`SsaoGpu`) extent. */
    workingWidth: number;
    workingHeight: number;
    /** Motion pruning's settings are enabled (false when it is not reached). */
    pruning: boolean;
}

/**
 * The state a recording creates its task in. Created directly in a state,
 * the factory encodes the passes the same task encodes once live writes have
 * brought it there: each setting is sampled at `prepare`/`execute`.
 */
interface RecordedState {
    /** Undefined keeps the scene's own setting. */
    quality?: string;
    normal: boolean;
    temporal?: boolean;
    pruning?: boolean;
}

async function record(
    request: SsaoCompositionRequest,
    width: number,
    height: number,
    state: RecordedState,
): Promise<Recording> {
    const ssao = await importPinnedModule<PinnedSsaoModule>(
        pinnedSourceModule(SSAO_MODULE),
    );
    const halfModule = await importPinnedModule<PinnedHalfModule>(
        pinnedSourceModule(SSAO_HALF_MODULE),
    );
    const targets = await pinnedRenderTargets();
    const cameras = await pinnedCameras();
    const { engine, recorder } = createRecordingEngine(SSAO_CONTRACT, {
        width,
        height,
    });
    const source = (
        lbl: string,
        format: string,
        depthFormat?: string,
    ): unknown =>
        builtRenderTarget(targets, engine, {
            lbl,
            format,
            ...(depthFormat !== undefined ? { dFormat: depthFormat } : {}),
            samples: 1,
            size: { width, height },
        });
    const depth = source(DEPTH_LABEL, "rgba16float", "depth32float");
    let normal: unknown;
    if (state.normal) {
        if (request.normalFormat === undefined) {
            throw new Error(
                "An SSAO state with a normal input has no normal format.",
            );
        }
        normal = source(NORMAL_LABEL, request.normalFormat);
    }
    const camera = cameras.createArcRotateCamera(1.8, 1.4, 1.5, {
        x: 0,
        y: 1.3,
        z: 0,
    });
    camera.nearPlane = 0.05;
    camera.farPlane = 20;
    const velocity = request.velocity
        ? source(VELOCITY_LABEL, request.velocity.format)
        : undefined;
    // The scene's flat temporal settings, nested as the pin's config declares them.
    const temporal: Record<string, unknown> = {};
    const options: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(request.options)) {
        if (key.startsWith("temporal."))
            temporal[key.slice("temporal.".length)] = value;
        else options[key] = value;
    }
    if (state.quality !== undefined) options.quality = state.quality;
    if (velocity !== undefined) {
        temporal.velocityTexture = velocity;
        temporal.velocityHasPreviousDepth = request.velocity!.previousDepth;
    }
    if (state.temporal !== undefined) {
        // A boolean `temporal` is the enabled flag the options record states.
        delete options.temporal;
        temporal.enabled = state.temporal;
    }
    if (Object.keys(temporal).length > 0) {
        if (typeof options.temporal === "boolean") {
            throw new Error(
                "createSsaoTask temporal is both a boolean and reconstruction options.",
            );
        }
        options.temporal = temporal;
    }
    const task = ssao.createSsaoTask(
        {
            ...options,
            depthTexture: depth,
            ...(normal !== undefined ? { normalTexture: normal } : {}),
            camera,
        },
        engine,
    );
    const settings = request.halfResolution
        ? halfModule.enableSsaoHalfResolution(task)
        : undefined;
    let pruning = false;
    if (request.motionPruning) {
        const settings = (
            await importPinnedModule<PinnedPruningModule>(
                pinnedSourceModule(SSAO_PRUNING_MODULE),
            )
        ).enableSsaoMotionPruning(task);
        if (state.pruning !== undefined) settings.enabled = state.pruning;
        pruning = settings.enabled;
    }
    task.record();
    const frame = (): RecordedPass<SsaoShapes>[] => {
        const before = recorder.passes.length;
        task.execute();
        return recorder.passes.slice(before);
    };
    const first = frame();
    const second = frame();
    const third = frame();
    if (passSignature(third) !== passSignature(first)) {
        throw new Error(
            "Pinned createSsaoTask encodes a third frame unlike the first; the " +
                "temporal history has more than two parities.",
        );
    }
    const samplingFootprint = task._gpu?.samplingFootprint;
    const workingWidth = task._gpu?.width ?? 0;
    const workingHeight = task._gpu?.height ?? 0;
    const chainLevels = new Set(
        recorder.textures
            .filter(
                (texture) => !texture.destroyed && texture.mipLevelCount > 1,
            )
            .map((texture) => texture.mipLevelCount),
    );
    if (chainLevels.size > 1) {
        throw new Error(
            `Pinned SSAO sizes its mip chains two ways at ${width}x${height}.`,
        );
    }
    task.enabled = false;
    const disabled = frame();
    return {
        width,
        height,
        recorder,
        task,
        frames: [first, second, disabled],
        halfActive: settings?.active ?? false,
        samplingFootprint,
        workingWidth,
        workingHeight,
        pruning,
    };
}

function viewLabel(view: RecordedTextureView): string {
    return `${view.texture.label}[${view.descriptor.baseMipLevel ?? 0}+${view.descriptor.mipLevelCount ?? "*"}]`;
}

/** A frame's passes as text, to compare two recordings of the same frame. */
function passSignature(passes: readonly RecordedPass<SsaoShapes>[]): string {
    const resource = (value: unknown): string =>
        value instanceof RecordedTextureView
            ? viewLabel(value)
            : value instanceof RecordedBuffer
              ? `buffer:${value.label}`
              : typeof value === "object" &&
                  value !== null &&
                  "buffer" in value &&
                  value.buffer instanceof RecordedBuffer
                ? `buffer:${value.buffer.label}`
                : JSON.stringify(value);
    const group = (value: SsaoShapes["bindGroup"]): string =>
        value.entries
            .map((entry) => `${entry.binding}=${resource(entry.resource)}`)
            .join(",");
    return passes
        .map((pass) =>
            pass.kind === "compute"
                ? `C:${pass.label}:` +
                  pass.dispatches
                      .map(
                          (dispatch) =>
                              `${dispatch.pipeline.descriptor.label ?? ""}(${[...dispatch.bindGroups.values()].map(group).join("|")})`,
                      )
                      .join(";")
                : pass.kind === "clearBuffer"
                  ? `B:${pass.buffer.label}`
                  : `R:${pass.pass.descriptor.label ?? ""}:` +
                    pass.pass.descriptor.colorAttachments
                        .map((attachment) => viewLabel(attachment.view))
                        .join(",") +
                    `(${pass.pass.bindGroups.map((bound) => group(bound.group)).join("|")})` +
                    pass.pass.indirectDraws
                        .map((draw) => `@${draw.buffer.label}`)
                        .join(""),
        )
        .join("\n");
}

/** The layout kinds the backends bind, by the WebGPU member that names each. */
const SSAO_LAYOUT_KINDS = {
    bufferType: new Set(["uniform", "storage", "read-only-storage"]),
    sampleType: new Set(["depth", "float", "unfilterable-float", "uint"]),
    samplerType: new Set(["filtering", "non-filtering"]),
} as const;

/** A layout entry under its module's identifier, of the kinds the backends bind. */
function layoutEntry(
    entry: RecordedLayoutEntry,
    name: string,
    what: string,
): PlannedLayoutEntry {
    const resource = plannedLayoutResource(entry, what);
    if (resource.storageTexture?.access === "write-only")
        return { binding: entry.binding, name, ...resource };
    for (const [member, kinds] of Object.entries(SSAO_LAYOUT_KINDS)) {
        const kind = resource[member as keyof typeof SSAO_LAYOUT_KINDS];
        if (kind !== undefined && kinds.has(kind))
            return { binding: entry.binding, name, ...resource };
    }
    throw new Error(
        `Pinned SSAO declared binding ${entry.binding} of a kind this port does not carry.`,
    );
}

/** The constants a pipeline passes, sorted by name. */
function constantsOf(
    constants: Readonly<Record<string, number>> | undefined,
): { name: string; value: number }[] {
    return Object.entries(constants ?? {})
        .map(([name, value]) => ({ name, value }))
        .sort((left, right) =>
            left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
}

/** A compute entry point's 2D `@workgroup_size`, as its module declares it. */
function workgroupOf(
    wgsl: string,
    entry: string,
): readonly [number, number] | undefined {
    const point = wgslEntryPoints(reflectWgslModule(wgsl), "compute").find(
        (candidate) => candidate.name === entry,
    );
    const size = point ? wgslWorkgroupSize(point) : undefined;
    if (!size || size.length < 2 || (size[2] ?? 1) !== 1) return undefined;
    return [size[0]!, size[1]!];
}

function extentOf(
    texture: RecordedTexture,
    width: number,
    height: number,
): SsaoExtent | undefined {
    if (texture.width === width && texture.height === height) return "source";
    if (
        texture.width === Math.ceil(width / 2) &&
        texture.height === Math.ceil(height / 2)
    )
        return "half";
    if (texture.width === 1 && texture.height === 1) return "unit";
    return undefined;
}

function mipExtent(size: number, level: number): number {
    return Math.max(1, size >> level);
}

type DispatchItem = {
    kind: "dispatch";
    label: string;
    dispatch: RecordedComputeDispatch<SsaoShapes>;
    /** The recorded compute pass the dispatch is in. */
    pass: number;
};
type RenderItem = { kind: "render"; pass: RecordedRenderPass<SsaoShapes> };
type ClearBufferItem = {
    kind: "clear-buffer";
    buffer: RecordedBuffer;
    offset: number;
    size: number;
};
/** One dispatch, render pass or buffer clear: what a backend encodes as one command. */
type RawItem = DispatchItem | RenderItem | ClearBufferItem;

function rawItems(passes: readonly RecordedPass<SsaoShapes>[]): RawItem[] {
    return passes.flatMap((pass, index): RawItem[] =>
        pass.kind === "compute"
            ? pass.dispatches.map((dispatch) => ({
                  kind: "dispatch",
                  label: pass.label,
                  dispatch,
                  pass: index,
              }))
            : pass.kind === "clearBuffer"
              ? [
                    {
                        kind: "clear-buffer",
                        buffer: pass.buffer,
                        offset: pass.offset,
                        size: pass.size,
                    },
                ]
              : [{ kind: "render", pass: pass.pass }],
    );
}

function itemViews(item: RawItem): RecordedTextureView[] {
    if (item.kind === "clear-buffer") return [];
    const groups =
        item.kind === "dispatch"
            ? [...item.dispatch.bindGroups.values()]
            : item.pass.bindGroups.map((bound) => bound.group);
    const attachments =
        item.kind === "render"
            ? item.pass.descriptor.colorAttachments.map(
                  (attachment) => attachment.view,
              )
            : [];
    return [
        ...groups.flatMap((group) =>
            group.entries.flatMap((entry) =>
                entry.resource instanceof RecordedTextureView
                    ? [entry.resource]
                    : [],
            ),
        ),
        ...attachments,
    ];
}

function itemIdentity(item: RawItem): string {
    return item.kind === "dispatch"
        ? `dispatch:${item.label}:${item.dispatch.pipeline.descriptor.label ?? ""}`
        : item.kind === "clear-buffer"
          ? `clear-buffer:${item.buffer.label}`
          : `render:${item.pass.descriptor.label ?? ""}`;
}

/**
 * The level of a pass that reads level `m - 1` and writes level `m` of a
 * mip chain through single-level views, as the pin's reduction loops do.
 */
function chainLevel(item: RawItem): number | undefined {
    const levels = itemViews(item)
        .filter(
            (view) =>
                view.descriptor.mipLevelCount === 1 &&
                view.texture.mipLevelCount > 1,
        )
        .map((view) => view.descriptor.baseMipLevel ?? 0);
    if (levels.length === 0) return undefined;
    const high = Math.max(...levels);
    const low = Math.min(...levels);
    return high >= 1 && low === high - 1 ? high : undefined;
}

/** The single-level view a chained pass writes: its first attachment or its first storage binding. */
function writtenView(item: RawItem): RecordedTextureView {
    if (item.kind === "clear-buffer")
        throw new Error("Pinned SSAO repeats a buffer clear over a chain.");
    if (item.kind === "render")
        return item.pass.descriptor.colorAttachments[0]!.view;
    const layout = (
        item.dispatch.pipeline.descriptor.layout as SsaoShapes["pipelineLayout"]
    ).bindGroupLayouts[0]!;
    const storage = [...layout.entries]
        .sort((left, right) => left.binding - right.binding)
        .find((entry) => entry.storageTexture !== undefined);
    const bound = item.dispatch.bindGroups
        .get(0)
        ?.entries.find((entry) => entry.binding === storage?.binding);
    if (!(bound?.resource instanceof RecordedTextureView)) {
        throw new Error("Pinned SSAO chain pass writes no storage view.");
    }
    return bound.resource;
}

/** Consecutive passes over levels 1, 2, ... of one chain fold into one repeated pass. */
function collapseChainRuns(
    items: readonly RawItem[],
): { items: RawItem[]; repeat: boolean }[] {
    const runs: { items: RawItem[]; repeat: boolean }[] = [];
    for (const item of items) {
        const level = chainLevel(item);
        const last = runs.at(-1);
        if (
            level !== undefined &&
            last?.repeat &&
            itemIdentity(last.items[0]!) === itemIdentity(item) &&
            chainLevel(last.items.at(-1)!) === level - 1
        ) {
            last.items.push(item);
            continue;
        }
        runs.push({ items: [item], repeat: level === 1 });
    }
    return runs;
}

/** Builds one mode's plan from its two recordings, cross-checking every size-dependent value. */
class ModeBuilder {
    /** The task-level textures and buffers this mode uses. */
    public readonly textures = new Set<number>();
    public readonly buffers = new Set<number>();
    public readonly views: SsaoViewPlan[] = [];
    private readonly viewIndex = new Map<string, number>();

    public constructor(
        private readonly composed: CompositionTables,
        private readonly recordings: readonly [Recording, Recording],
    ) {}

    /** An owned texture by label, classified over both recordings. */
    private owned(label: string): number {
        const textures = this.recordings.map((recording) => {
            const matches = recording.recorder.textures.filter(
                (texture) => texture.label === label && !texture.destroyed,
            );
            if (matches.length !== 1) {
                throw new Error(
                    `Pinned SSAO keeps ${matches.length} live textures labelled '${label}'.`,
                );
            }
            return { texture: matches[0]!, recording };
        });
        const plan = textures[0]!.texture;
        const extents = new Set(
            textures.map(({ texture, recording }) =>
                extentOf(texture, recording.width, recording.height),
            ),
        );
        const [extent] = extents;
        if (extents.size !== 1 || extent === undefined) {
            throw new Error(
                `Pinned SSAO texture '${label}' is sized neither like its source, ` +
                    "half of it rounded up, nor one texel.",
            );
        }
        // A chain's level count is the pin's one rule over the working
        // extent, which generation lowers (`ssao_mip_level_count`) and
        // `record` checks every chain of a recording takes.
        const chains = new Set(
            textures.map(({ texture }) => texture.mipLevelCount > 1),
        );
        const [chain] = chains;
        if (chains.size !== 1 || chain === undefined) {
            throw new Error(
                `Pinned SSAO texture '${label}' has a mip count this port does not size.`,
            );
        }
        const formats = new Set(
            textures.map(({ texture }) => `${texture.format}:${texture.usage}`),
        );
        if (
            formats.size !== 1 ||
            plan.sampleCount !== 1 ||
            plan.dimension !== "2d"
        ) {
            throw new Error(
                `Pinned SSAO texture '${label}' changes format or usage with its size.`,
            );
        }
        const index = this.composed.texture({
            label,
            format: plan.format,
            extent,
            chain,
            usage: plan.usage,
        });
        this.textures.add(index);
        return index;
    }

    /** An owned storage buffer, one per recording, classified over both. */
    private buffer(buffers: readonly unknown[], what: string): number {
        const recorded = buffers.map((buffer) => {
            if (!(buffer instanceof RecordedBuffer) || buffer.destroyed) {
                throw new Error(`${what} is no live buffer the task owns.`);
            }
            return buffer;
        });
        const [first] = recorded;
        if (
            new Set(recorded.map((buffer) => `${buffer.label}:${buffer.usage}`))
                .size !== 1 ||
            !first
        ) {
            throw new Error(`${what} binds different buffers at two extents.`);
        }
        let size: SsaoBufferSize;
        if (recorded.every((buffer) => buffer.size === first.size)) {
            size = { kind: "fixed", bytes: first.size };
        } else if (
            recorded.every(
                (buffer, index) =>
                    buffer.size ===
                    this.composed.motionCellBytes(
                        this.recordings[index]!.workingWidth,
                        this.recordings[index]!.workingHeight,
                    ),
            )
        ) {
            size = { kind: "motion-cells" };
        } else {
            throw new Error(
                `Pinned SSAO buffer '${first.label}' is sized neither fixed nor ` +
                    "by the motion-mask pyramid of the working extent.",
            );
        }
        const index = this.composed.buffer({
            label: first.label,
            size,
            usage: first.usage,
        });
        this.buffers.add(index);
        return index;
    }

    private textureRef(view: RecordedTextureView): SsaoTextureRef {
        const label = view.texture.label;
        if (label === DEPTH_LABEL) {
            if (
                view.descriptor.aspect !== "depth-only" ||
                view.texture.format !== "depth32float"
            ) {
                throw new Error(
                    "Pinned SSAO bound its depth source other than through a depth-only view.",
                );
            }
            return { kind: "depth-source" };
        }
        if (label === NORMAL_LABEL) return { kind: "normal-source" };
        if (label === VELOCITY_LABEL) return { kind: "velocity-source" };
        if (
            view.descriptor.aspect !== undefined &&
            view.descriptor.aspect !== "all"
        ) {
            throw new Error(
                `Pinned SSAO viewed '${label}' through one aspect.`,
            );
        }
        return { kind: "owned", texture: this.owned(label) };
    }

    /**
     * One view, the same at every recording. Inside a pass repeated over a
     * mip chain (`level` given), a single-level view of a chained texture
     * is relative to the pass's level, which is how the pin's reduction
     * loops name `mip - 1` and `mip`.
     */
    public view(views: readonly RecordedTextureView[], level?: number): number {
        const [first] = views;
        const relative = (view: RecordedTextureView): boolean =>
            level !== undefined &&
            view.descriptor.mipLevelCount === 1 &&
            view.texture.mipLevelCount > 1;
        const base = (view: RecordedTextureView): number =>
            (view.descriptor.baseMipLevel ?? 0) - (relative(view) ? level! : 0);
        const shapes = new Set(
            views.map(
                (view) =>
                    `${view.texture.label}|${base(view)}|${view.descriptor.mipLevelCount ?? "*"}|${view.descriptor.aspect ?? "all"}|${view.descriptor.dimension ?? ""}|${view.descriptor.format ?? ""}`,
            ),
        );
        if (shapes.size !== 1 || !first) {
            throw new Error(
                "Pinned SSAO binds different views at two source extents.",
            );
        }
        if (
            first.descriptor.dimension !== undefined ||
            first.descriptor.format !== undefined
        ) {
            throw new Error(
                "Pinned SSAO reinterpreted a view's dimension or format.",
            );
        }
        const plan: SsaoViewPlan = {
            texture: this.textureRef(first),
            baseMip: base(first),
            mipCount: first.descriptor.mipLevelCount,
            ...(relative(first) ? { relative: true as const } : {}),
        };
        const key = JSON.stringify(plan);
        const known = this.viewIndex.get(key);
        if (known !== undefined) return known;
        this.views.push(plan);
        this.viewIndex.set(key, this.views.length - 1);
        return this.views.length - 1;
    }

    /** The resources a group binds, one per layout entry, at every recording. */
    private resources(
        layout: readonly PlannedLayoutEntry[],
        groups: readonly SsaoShapes["bindGroup"][],
        what: string,
        level: number | undefined,
    ): SsaoResourcePlan[] {
        return layout.map((entry) => {
            const bound = groups.map((group) => {
                const found = group.entries.find(
                    (candidate) => candidate.binding === entry.binding,
                );
                if (!found)
                    throw new Error(
                        `${what} leaves binding ${entry.binding} unbound.`,
                    );
                return found.resource;
            });
            const [first] = bound;
            if (entry.bufferType !== undefined) {
                const buffers = bound.map((resource) => {
                    const buffer =
                        typeof resource === "object" &&
                        resource !== null &&
                        "buffer" in resource
                            ? resource.buffer
                            : undefined;
                    if (!(buffer instanceof RecordedBuffer)) {
                        throw new Error(
                            `${what} binds a buffer at ${entry.binding} that is no buffer.`,
                        );
                    }
                    if (
                        "offset" in (resource as object) ||
                        "size" in (resource as object)
                    ) {
                        throw new Error(
                            `${what} binds a buffer sub-range at ${entry.binding}.`,
                        );
                    }
                    return buffer;
                });
                return entry.bufferType === "uniform"
                    ? { kind: "uniform", block: this.composed.uniform(buffers) }
                    : {
                          kind: "buffer",
                          buffer: this.buffer(
                              buffers,
                              `${what}'s buffer at ${entry.binding}`,
                          ),
                      };
            }
            if (entry.samplerType !== undefined) {
                return {
                    kind: "sampler",
                    sampler: this.composed.sampler(
                        bound as SsaoShapes["sampler"][],
                    ),
                };
            }
            if (!(first instanceof RecordedTextureView)) {
                throw new Error(
                    `${what} binds a non-texture at texture binding ${entry.binding}.`,
                );
            }
            return {
                kind: "view",
                view: this.view(bound as RecordedTextureView[], level),
            };
        });
    }

    private dispatchPlan(
        items: readonly DispatchItem[],
        level: number | undefined,
    ): SsaoPassPlan {
        const [first] = items;
        const label = first!.label;
        const program = this.composed.computeProgram(
            items.map((each) => each.dispatch.pipeline),
        );
        const plan = this.composed.programs[program]!;
        const groups = items.map(({ dispatch }) => {
            if (dispatch.bindGroups.size !== 1 || !dispatch.bindGroups.has(0)) {
                throw new Error(
                    `Pinned SSAO dispatch of '${label}' binds other than group 0.`,
                );
            }
            return dispatch.bindGroups.get(0)!;
        });
        const what = `Pinned SSAO dispatch of '${label}'`;
        const resources = this.resources(plan.layout, groups, what, level);
        const domain = plan.layout.findIndex(
            (entry) => entry.storageTexture !== undefined,
        );
        if (!plan.workgroup) {
            throw new Error(`${what} runs a module without a 2D workgroup.`);
        }
        const [sizeX, sizeY] = plan.workgroup;
        for (const [index, { dispatch }] of items.entries()) {
            // The storage view the dispatch writes, or the working owner's
            // extent for one that writes buffers alone.
            let width = this.recordings[index]!.workingWidth;
            let height = this.recordings[index]!.workingHeight;
            if (domain >= 0) {
                const view = groups[index]!.entries.find(
                    (entry) => entry.binding === plan.layout[domain]!.binding,
                )!.resource as RecordedTextureView;
                const mip = view.descriptor.baseMipLevel ?? 0;
                width = mipExtent(view.texture.width, mip);
                height = mipExtent(view.texture.height, mip);
            }
            const expected = [
                Math.ceil(width / sizeX),
                Math.ceil(height / sizeY),
            ];
            const workgroups = [
                dispatch.workgroups[0],
                dispatch.workgroups[1] ?? 1,
                dispatch.workgroups[2] ?? 1,
            ];
            if (
                workgroups[0] !== expected[0] ||
                workgroups[1] !== expected[1] ||
                workgroups[2] !== 1
            ) {
                throw new Error(
                    `${what} dispatches ${workgroups.join("x")}, not its ` +
                        `${domain >= 0 ? "storage view's" : "working"} extent ` +
                        `over the module's ${sizeX}x${sizeY} workgroup.`,
                );
            }
        }
        return {
            label,
            stage: "compute",
            program,
            resources,
            ...(domain >= 0 ? { domain } : {}),
            attachments: [],
        };
    }

    private renderPlan(
        passes: readonly RecordedRenderPass<SsaoShapes>[],
        level: number | undefined,
    ): SsaoPassPlan {
        const [first] = passes;
        const label = first!.descriptor.label ?? "";
        const attachments = first!.descriptor.colorAttachments.map(
            (attachment, index) => {
                const views = passes.map((pass) => {
                    const each = pass.descriptor.colorAttachments[index];
                    if (
                        !each ||
                        each.loadOp !== "clear" ||
                        (each.storeOp ?? "store") !== "store"
                    ) {
                        throw new Error(
                            `Pinned SSAO pass '${label}' loads or discards an attachment.`,
                        );
                    }
                    return each.view;
                });
                const clear = (attachment as { clearValue?: unknown })
                    .clearValue;
                const values = Array.isArray(clear)
                    ? clear
                    : typeof clear === "object" && clear !== null
                      ? [
                            (clear as { r: number }).r,
                            (clear as { g: number }).g,
                            (clear as { b: number }).b,
                            (clear as { a: number }).a,
                        ]
                      : [0, 0, 0, 0];
                return {
                    view: this.view(views, level),
                    clear: values.map(Number),
                };
            },
        );
        if (first!.descriptor.depthStencilAttachment) {
            throw new Error(`Pinned SSAO pass '${label}' attaches depth.`);
        }
        if (!first!.pipeline) {
            if (
                first!.draws.length !== 0 ||
                first!.indirectDraws.length !== 0 ||
                first!.bindGroups.length !== 0
            ) {
                throw new Error(
                    `Pinned SSAO pass '${label}' draws without a pipeline.`,
                );
            }
            return { label, stage: "clear", resources: [], attachments };
        }
        const program = this.composed.renderProgram(
            passes.map((pass) => pass.pipeline!),
        );
        const plan = this.composed.programs[program]!;
        const indirect = first!.indirectDraws.length === 1;
        const groups = passes.map((pass) => {
            const drawn = indirect
                ? pass.draws.length === 0 &&
                  pass.indirectDraws.length === 1 &&
                  pass.indirectDraws[0]!.offset === 0
                : pass.indirectDraws.length === 0 &&
                  pass.draws.length === 1 &&
                  pass.draws[0]!.length === 1 &&
                  pass.draws[0]![0] === 3;
            if (
                pass.bindGroups.length !== 1 ||
                pass.bindGroups[0]!.index !== 0 ||
                !drawn ||
                pass.indexedDraws.length !== 0
            ) {
                throw new Error(
                    `Pinned SSAO pass '${label}' is not one group-0 bind and one draw(3) or indirect draw.`,
                );
            }
            return pass.bindGroups[0]!.group;
        });
        for (const [
            index,
            attachment,
        ] of first!.descriptor.colorAttachments.entries()) {
            if (attachment.view.texture.format !== plan.targets[index]) {
                throw new Error(
                    `Pinned SSAO pass '${label}' draws a target its pipeline was not built for.`,
                );
            }
        }
        const what = `Pinned SSAO pass '${label}'`;
        return {
            label,
            stage: "render",
            program,
            resources: this.resources(plan.layout, groups, what, level),
            ...(indirect
                ? {
                      buffer: this.buffer(
                          passes.map((pass) => pass.indirectDraws[0]!.buffer),
                          `${what}'s indirect draw`,
                      ),
                  }
                : {}),
            attachments,
        };
    }

    private itemPlan(
        items: readonly RawItem[],
        level: number | undefined,
    ): SsaoPassPlan {
        const dispatches = items.filter(
            (item): item is DispatchItem => item.kind === "dispatch",
        );
        if (dispatches.length === items.length)
            return this.dispatchPlan(dispatches, level);
        const renders = items.filter(
            (item): item is RenderItem => item.kind === "render",
        );
        if (renders.length === items.length) {
            return this.renderPlan(
                renders.map((item) => item.pass),
                level,
            );
        }
        const clears = items.filter(
            (item): item is ClearBufferItem => item.kind === "clear-buffer",
        );
        if (clears.length === items.length) {
            if (
                clears.some(
                    (clear) =>
                        clear.offset !== 0 || clear.size !== clear.buffer.size,
                )
            ) {
                throw new Error("Pinned SSAO clears part of a buffer.");
            }
            return {
                label: clears[0]!.buffer.label,
                stage: "clear-buffer",
                resources: [],
                buffer: this.buffer(
                    clears.map((clear) => clear.buffer),
                    "Pinned SSAO's buffer clear",
                ),
                attachments: [],
            };
        }
        throw new Error(
            "Pinned SSAO encodes different passes at another source extent.",
        );
    }

    public frame(index: 0 | 1 | 2): SsaoPassPlan[] {
        const [left, right] = this.recordings.map((recording) =>
            collapseChainRuns(rawItems(recording.frames[index])),
        );
        if (left!.length !== right!.length) {
            throw new Error(
                "Pinned SSAO encodes a different pass count at another source extent.",
            );
        }
        // Whether a run's first dispatch shares the pinned compute pass of
        // the run before it, at both extents.
        const continues = (runs: typeof left, position: number): boolean => {
            const first = runs![position]!.items[0]!;
            const previous = runs![position - 1]?.items.at(-1);
            return (
                first.kind === "dispatch" &&
                previous?.kind === "dispatch" &&
                previous.pass === first.pass
            );
        };
        return left!.map((run, position) => {
            const other = right![position]!;
            const continued = continues(left, position);
            if (continued !== continues(right, position)) {
                throw new Error(
                    "Pinned SSAO groups its dispatches into passes differently at another source extent.",
                );
            }
            return {
                ...this.runPlan(run, other),
                ...(continued ? { continues: true as const } : {}),
            };
        });
    }

    private runPlan(
        run: { items: RawItem[]; repeat: boolean },
        other: { items: RawItem[]; repeat: boolean },
    ): SsaoPassPlan {
        if (run.repeat !== other.repeat) {
            throw new Error(
                "Pinned SSAO repeats a pass over a mip chain at one extent only.",
            );
        }
        if (!run.repeat)
            return this.itemPlan([run.items[0]!, other.items[0]!], undefined);
        const template = this.itemPlan([run.items[0]!, other.items[0]!], 1);
        const key = JSON.stringify(template);
        const chained = new Set<number>();
        for (const each of [run, other]) {
            const written = writtenView(each.items[0]!);
            if (each.items.length !== written.texture.mipLevelCount - 1) {
                throw new Error(
                    `Pinned SSAO repeats '${template.label}' ${each.items.length} times over a ` +
                        `${written.texture.mipLevelCount}-level chain.`,
                );
            }
            chained.add(this.owned(written.texture.label));
            for (const [offset, item] of each.items.entries()) {
                if (JSON.stringify(this.itemPlan([item], offset + 1)) !== key) {
                    throw new Error(
                        `Pinned SSAO's '${template.label}' changes shape along its mip chain.`,
                    );
                }
            }
        }
        if (chained.size !== 1)
            throw new Error(
                `Pinned SSAO's '${template.label}' walks two chains.`,
            );
        if (
            template.stage === "compute" &&
            run.items.some((item, index) => {
                const previous = run.items[index - 1];
                return (
                    previous !== undefined &&
                    (item.kind !== "dispatch" ||
                        previous.kind !== "dispatch" ||
                        item.pass !== previous.pass)
                );
            })
        ) {
            throw new Error(
                `Pinned SSAO's '${template.label}' repeats its dispatch across passes.`,
            );
        }
        return { ...template, repeat: { texture: [...chained][0]! } };
    }

    public outputTexture(): number {
        const labels = new Set(
            this.recordings.map((recording) => {
                const published = recording.task.outputTexture._colorTexture;
                if (!(published instanceof RecordedTexture)) {
                    throw new Error("Pinned SSAO published no output texture.");
                }
                return published.label;
            }),
        );
        const [label] = labels;
        if (labels.size !== 1 || label === undefined) {
            throw new Error(
                "Pinned SSAO publishes different textures at two source extents.",
            );
        }
        return this.owned(label);
    }
}

/**
 * The layout WebGPU derives for a pipeline built with `layout: "auto"`, read
 * off its module: buffers by address space and access, textures by type. A
 * float texture the module reads only through `textureLoad` binds as
 * unfilterable-float, which every float format admits.
 */
function automaticLayout(wgsl: string, what: string): PlannedLayoutEntry[] {
    const module = reflectWgslModule(wgsl);
    return reflectWgslBindings(wgsl)
        .filter((binding) => binding.group === 0)
        .sort((left, right) => left.binding - right.binding)
        .map((binding): PlannedLayoutEntry => {
            const type = (binding.type?.text ?? "").replace(/\s+/g, "");
            const entry = { binding: binding.binding, name: binding.name };
            if (binding.addressSpace === "uniform")
                return { ...entry, bufferType: "uniform" };
            if (binding.addressSpace === "storage") {
                return {
                    ...entry,
                    bufferType:
                        binding.accessMode === "read_write"
                            ? "storage"
                            : "read-only-storage",
                };
            }
            if (type.startsWith("texture_depth_2d"))
                return { ...entry, sampleType: "depth" };
            const storage = /^texture_storage_2d<([a-z0-9]+),write>$/.exec(
                type,
            );
            if (storage)
                return {
                    ...entry,
                    storageTexture: {
                        access: "write-only",
                        format: storage[1]!,
                    },
                };
            if (
                type === "texture_2d<f32>" &&
                !wgslSamplesTexture(module, binding.name)
            )
                return { ...entry, sampleType: "unfilterable-float" };
            if (type === "texture_2d<u32>")
                return { ...entry, sampleType: "uint" };
            throw new Error(
                `${what} declares binding ${binding.binding} ('${type}'), which an automatic layout this port derives does not carry.`,
            );
        });
}

/**
 * A table of distinct plain rows, each row's index by its JSON text: the
 * first insertion of a row appends it, a later equal one answers its index.
 */
export class InternTable<T> {
    public readonly rows: T[] = [];
    private readonly indices = new Map<string, number>();

    public intern(row: T): number {
        const key = JSON.stringify(row);
        const known = this.indices.get(key);
        if (known !== undefined) return known;
        this.rows.push(row);
        this.indices.set(key, this.rows.length - 1);
        return this.rows.length - 1;
    }
}

/** Programs, samplers, uniform blocks, textures and buffers, shared by every mode. */
class CompositionTables {
    private readonly programTable = new InternTable<SsaoProgramPlan>();
    private readonly samplerTable = new InternTable<SsaoSamplerPlan>();
    private readonly textureTable = new InternTable<SsaoTexturePlan>();
    private readonly bufferTable = new InternTable<SsaoBufferPlan>();
    public readonly programs = this.programTable.rows;
    public readonly samplers = this.samplerTable.rows;
    public readonly uniforms: { label: string; bytes: number }[] = [];
    public readonly textures = this.textureTable.rows;
    public readonly buffers = this.bufferTable.rows;

    public constructor(
        /** The pin's `ssaoMotionMaskCellCount`. */
        private readonly motionCells: (width: number, height: number) => number,
    ) {}

    /** The motion-mask pyramid's bytes over a working extent, as the pin sizes the buffer. */
    public motionCellBytes(width: number, height: number): number {
        return this.motionCells(width, height) * 16;
    }

    private program(plan: SsaoProgramPlan): number {
        return this.programTable.intern(plan);
    }

    /** A texture the task owns; the same one in two modes is one entry a mode switch keeps. */
    public texture(plan: SsaoTexturePlan): number {
        return this.textureTable.intern(plan);
    }

    public buffer(plan: SsaoBufferPlan): number {
        return this.bufferTable.intern(plan);
    }

    private layout(
        layout: SsaoShapes["pipelineLayout"],
        wgsl: string,
        what: string,
    ): PlannedLayoutEntry[] {
        if (layout.bindGroupLayouts.length !== 1) {
            throw new Error(`${what} is not laid out as one bind group.`);
        }
        const names = new Map(
            reflectWgslBindings(wgsl)
                .filter((binding) => binding.group === 0)
                .map((binding) => [binding.binding, binding.name]),
        );
        return [...layout.bindGroupLayouts[0]!.entries]
            .sort((left, right) => left.binding - right.binding)
            .map((entry) => {
                const name = names.get(entry.binding);
                if (name === undefined) {
                    throw new Error(
                        `${what} lays out binding ${entry.binding}, which its module does not declare.`,
                    );
                }
                return layoutEntry(entry, name, what);
            });
    }

    public computeProgram(
        pipelines: readonly RecordedComputePipeline[],
    ): number {
        const indices = new Set(
            pipelines.map((pipeline) => {
                const descriptor = pipeline.descriptor;
                const module = descriptor.compute
                    .module as SsaoShapes["shaderModule"];
                const wgsl = module.code;
                const entry = descriptor.compute.entryPoint ?? "main";
                const workgroup = workgroupOf(wgsl, entry);
                if (!workgroup)
                    throw new Error(
                        "Pinned SSAO compute module declares no 2D workgroup size.",
                    );
                const what = `Pinned SSAO compute program '${descriptor.label ?? ""}'`;
                return this.program({
                    stage: "compute",
                    wgsl,
                    entry,
                    constants: constantsOf(descriptor.compute.constants),
                    targets: [],
                    layout:
                        descriptor.layout === "auto"
                            ? automaticLayout(wgsl, what)
                            : this.layout(
                                  descriptor.layout as SsaoShapes["pipelineLayout"],
                                  wgsl,
                                  what,
                              ),
                    workgroup,
                });
            }),
        );
        if (indices.size !== 1)
            throw new Error(
                "Pinned SSAO builds a size-dependent compute program.",
            );
        return [...indices][0]!;
    }

    public renderProgram(
        pipelines: readonly SsaoShapes["renderPipeline"][],
    ): number {
        const indices = new Set(
            pipelines.map((pipeline) => {
                const what = `Pinned SSAO render program '${pipeline.label ?? ""}'`;
                if (
                    pipeline.vertex.module.code !==
                    pipeline.fragment.module.code
                ) {
                    throw new Error(
                        `${what} builds its stages from two modules.`,
                    );
                }
                if (
                    (pipeline.primitive?.topology ?? "triangle-list") !==
                    "triangle-list"
                ) {
                    throw new Error(
                        `${what} draws other than a triangle list.`,
                    );
                }
                if (
                    pipeline.fragment.targets.some(
                        (target) => target.blend !== undefined,
                    )
                ) {
                    throw new Error(`${what} blends.`);
                }
                const wgsl = pipeline.vertex.module.code;
                return this.program({
                    stage: "render",
                    wgsl,
                    entry: pipeline.fragment.entryPoint,
                    vertexEntry: pipeline.vertex.entryPoint,
                    constants: constantsOf(pipeline.fragment.constants),
                    targets: pipeline.fragment.targets.map(
                        (target) => target.format,
                    ),
                    layout: this.layout(pipeline.layout, wgsl, what),
                });
            }),
        );
        if (indices.size !== 1)
            throw new Error(
                "Pinned SSAO builds a size-dependent render program.",
            );
        return [...indices][0]!;
    }

    public sampler(samplers: readonly SsaoShapes["sampler"][]): number {
        const plans = samplers.map((sampler): SsaoSamplerPlan => {
            const filter = (
                value: string | undefined,
            ): "nearest" | "linear" => {
                if (value === undefined || value === "nearest")
                    return "nearest";
                if (value === "linear") return "linear";
                throw new Error(
                    `Pinned SSAO samples with a '${value}' filter.`,
                );
            };
            for (const address of [
                sampler.addressModeU,
                sampler.addressModeV,
                sampler.addressModeW,
            ]) {
                if (address !== undefined && address !== "clamp-to-edge") {
                    throw new Error(
                        "Pinned SSAO samples with an address mode other than clamp-to-edge.",
                    );
                }
            }
            if (
                (sampler.mipmapFilter ?? "nearest") !== "nearest" ||
                sampler.compare !== undefined
            ) {
                throw new Error(
                    "Pinned SSAO samples mips linearly or by comparison.",
                );
            }
            return {
                minFilter: filter(sampler.minFilter),
                magFilter: filter(sampler.magFilter),
            };
        });
        const keys = new Set(plans.map((plan) => JSON.stringify(plan)));
        if (keys.size !== 1)
            throw new Error("Pinned SSAO binds a size-dependent sampler.");
        return this.samplerTable.intern(plans[0]!);
    }

    public uniform(buffers: readonly RecordedBuffer[]): number {
        const shapes = new Set(
            buffers.map((buffer) => `${buffer.label}|${buffer.size}`),
        );
        if (shapes.size !== 1)
            throw new Error(
                "Pinned SSAO binds a size-dependent uniform buffer.",
            );
        const [first] = buffers;
        const found = this.uniforms.findIndex(
            (candidate) => candidate.label === first!.label,
        );
        if (found >= 0) {
            if (this.uniforms[found]!.bytes !== first!.size) {
                throw new Error(
                    `Pinned SSAO sizes uniform buffer '${first!.label}' two ways.`,
                );
            }
            return found;
        }
        this.uniforms.push({ label: first!.label, bytes: first!.size });
        return this.uniforms.length - 1;
    }
}

/**
 * Two source extents per mode: both even and odd ones, so a texture sized
 * from half of its source is told apart from one sized by flooring, and the
 * full mode under a half-resolution adapter below its activation floor.
 */
const HALF_EXTENTS: readonly [number, number][] = [
    [1280, 720],
    [1001, 601],
];
const FULL_EXTENTS: readonly [number, number][] = [
    [300, 200],
    [13, 9],
];

/** The pin's `SsaoQuality` presets, read off its own type alias. */
function pinnedQualities(): string[] {
    const file = sharedUpstreamStore().getSourceFile(SSAO_GPU_MODULE);
    const alias = file.statements.find(
        (statement): statement is ts.TypeAliasDeclaration =>
            ts.isTypeAliasDeclaration(statement) &&
            statement.name.text === "SsaoQuality",
    );
    const members =
        alias && ts.isUnionTypeNode(alias.type) ? alias.type.types : undefined;
    const names = members?.map((member) =>
        ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
            ? member.literal.text
            : undefined,
    );
    if (!names?.length || names.some((name) => name === undefined)) {
        throw new Error(
            "Pinned SsaoQuality is no union of string literal presets.",
        );
    }
    return names as string[];
}

/**
 * Runs the pinned factory for every mode the request can reach and reads the
 * plan off it: the full working resolution (and the half one when the
 * adapter is reached) for every value of each live setting the program
 * writes, the scene's own value of every other.
 */
export async function composeSsaoTask(
    request: SsaoCompositionRequest,
): Promise<ComposedSsaoTask> {
    const motionMask = await importPinnedModule<PinnedMotionMaskModule>(
        pinnedSourceModule(SSAO_MOTION_MASK_MODULE),
    );
    const tables = new CompositionTables(motionMask.ssaoMotionMaskCellCount);
    const modes: SsaoModePlan[] = [];
    const composed = (resolution: "full" | "half", key: SsaoModeKey) =>
        modes.some(
            (mode) =>
                mode.resolution === resolution &&
                JSON.stringify(mode.key) === JSON.stringify(key),
        );
    const compose = async (
        extents: readonly [number, number][],
        expectActive: boolean,
        state: RecordedState,
    ): Promise<Recording> => {
        const recordings = (await Promise.all(
            extents.map(([width, height]) =>
                record(request, width, height, state),
            ),
        )) as [Recording, Recording];
        for (const recording of recordings) {
            if (recording.halfActive !== expectActive) {
                throw new Error(
                    `Pinned enableSsaoHalfResolution is ${recording.halfActive ? "" : "in"}active at ` +
                        `${recording.width}x${recording.height}, where this composition expected otherwise.`,
                );
            }
        }
        const [first] = recordings;
        const key: SsaoModeKey = {
            quality: first.task.quality,
            normal: state.normal,
            temporal: first.task.temporal.enabled,
            pruning: first.pruning && first.task.temporal.enabled,
        };
        const resolution = expectActive ? "half" : "full";
        if (composed(resolution, key)) return first;
        const builder = new ModeBuilder(tables, recordings);
        const frames: [SsaoPassPlan[], SsaoPassPlan[]] = [
            builder.frame(0),
            builder.frame(1),
        ];
        const disabled = builder.frame(2);
        const output = builder.outputTexture();
        const footprints = new Set(
            recordings.map((recording) => recording.samplingFootprint),
        );
        if (footprints.size !== 1)
            throw new Error(
                "Pinned SSAO sets a size-dependent sampling footprint.",
            );
        const [samplingFootprint] = footprints;
        modes.push({
            resolution,
            key,
            textures: [...builder.textures].sort((a, b) => a - b),
            buffers: [...builder.buffers].sort((a, b) => a - b),
            output,
            views: builder.views,
            frames,
            disabled,
            ...(samplingFootprint !== undefined ? { samplingFootprint } : {}),
        });
        return first;
    };
    const initial = await compose(FULL_EXTENTS, false, {
        normal: request.initialNormal,
    });
    const settings = {
        quality: initial.task.quality,
        radius: initial.task.radius,
        intensity: initial.task.intensity,
        temporalEnabled: initial.task.temporal.enabled,
        historySamples: initial.task.temporal.historySamples,
    };
    const live = new Set(request.live ?? []);
    const qualities = live.has("quality")
        ? pinnedQualities()
        : [settings.quality];
    const normals = live.has("normal")
        ? [true, false].filter(
              (normal) => !normal || request.normalFormat !== undefined,
          )
        : [request.initialNormal];
    const temporals = live.has("temporal")
        ? [true, false]
        : [settings.temporalEnabled];
    const prunings = (temporal: boolean): boolean[] =>
        !request.motionPruning || !temporal
            ? [false]
            : live.has("pruning")
              ? [true, false]
              : [initial.pruning];
    const resolutions: [readonly [number, number][], boolean][] = [
        [FULL_EXTENTS, false],
        ...(request.halfResolution
            ? [[HALF_EXTENTS, true] as [readonly [number, number][], boolean]]
            : []),
    ];
    // A state names its whole key, so one composed already (the initial
    // one among them) is not recorded again.
    for (const [extents, active] of resolutions)
        for (const quality of qualities)
            for (const normal of normals)
                for (const temporal of temporals)
                    for (const pruning of prunings(temporal)) {
                        const key = { quality, normal, temporal, pruning };
                        if (composed(active ? "half" : "full", key)) continue;
                        await compose(extents, active, {
                            quality,
                            normal,
                            temporal,
                            ...(request.motionPruning ? { pruning } : {}),
                        });
                    }
    return {
        settings,
        uniforms: tables.uniforms,
        programs: tables.programs,
        samplers: tables.samplers,
        textures: tables.textures,
        buffers: tables.buffers,
        modes,
        ...(request.velocity
            ? { velocityFormat: request.velocity.format }
            : {}),
    };
}

/** Each composition request's plan, composed once: equal tasks share it. */
const compositions = new Map<string, Promise<ComposedSsaoTask>>();

/** A reached task's composition, its inputs' formats read from the pin's geometry table. */
export function composeSsaoTaskManifest(
    manifest: SsaoTaskManifest,
): Promise<ComposedSsaoTask> {
    const request: SsaoCompositionRequest = {
        options: manifest.options,
        normalFormat:
            manifest.normalAttachment === undefined
                ? undefined
                : geometryAttachmentDefaultFormat(manifest.normalAttachment),
        initialNormal: manifest.initialNormal,
        halfResolution: manifest.halfResolution,
        ...(manifest.velocity
            ? {
                  velocity: {
                      format: geometryAttachmentDefaultFormat(
                          manifest.velocity.attachment,
                      ),
                      previousDepth: manifest.velocity.previousDepth,
                  },
              }
            : {}),
        motionPruning: manifest.motionPruning,
        live: manifest.live,
    };
    const key = JSON.stringify(request);
    let composed = compositions.get(key);
    if (!composed) {
        composed = composeSsaoTask(request);
        compositions.set(key, composed);
    }
    return composed;
}

/** The members of the plugin `enablePbrSsao` attaches (its scoped wrapper). */
const SSAO_PBR_PLUGIN_MEMBERS = [
    "name",
    "_pbrIblOnly",
    "_bindingVersion",
    "_prepareDraw",
    "getCustomCode",
    "getSamplers",
    "bindTextures",
    "getActiveTextures",
    "_selectBindingScope",
];

interface PinnedSsaoPbrPlugin {
    name: string;
    _pbrIblOnly?: boolean;
    getCustomCode(
        type: "vertex" | "fragment",
    ): Readonly<Record<string, string>> | null;
    getSamplers(): readonly MaterialPluginSamplerManifest[];
}

let ssaoPbrPlugin: MaterialPluginManifest | undefined;

/**
 * The plugin `enablePbrSsao` attaches, as the plain manifest the PBR
 * plugin composition takes.
 *
 * The plugin is a closure inside the enabler, so the enabler itself runs,
 * once, against a stand-in scene holding one PBR material and a task of its
 * camera, and the plugin is read off that material. Running it also installs
 * what the call installs in a program: the diffuse-occlusion modifier, the
 * IBL-pass plugin decorator and the dynamic bindings, all inert for a
 * material holding no `_pbrIblOnly` plugin by the pin's own design, which
 * composition of this program's materials then reads. What the rest of the
 * plugin does at run time -- sampling the task's output in a pass of its
 * camera and a neutral texture otherwise, and refusing a mismatched aspect
 * -- is the native binding's (`ssao_pbr_binding`), so a pin adding a member
 * refuses here.
 */
export function ssaoPbrPluginManifest(): MaterialPluginManifest {
    if (ssaoPbrPlugin) return ssaoPbrPlugin;
    const { enablePbrSsao } = requirePinnedModule<{
        enablePbrSsao: (scene: object, task: object) => Promise<void>;
    }>(pinnedSourceModule(SSAO_PBR_MODULE));
    const { getPbrGroupBuilder } = requirePinnedModule<{
        getPbrGroupBuilder: () => unknown;
    }>("material/pbr/pbr-group-builder.js");
    const view = {};
    const device = {
        createTexture: () => ({ createView: () => view }),
        createSampler: (descriptor: object) => ({ ...descriptor }),
        queue: { writeTexture: () => undefined },
    };
    const engine = { _device: device };
    const camera = {};
    const material: {
        _buildGroup: unknown;
        plugins?: readonly PinnedSsaoPbrPlugin[];
    } = {
        _buildGroup: getPbrGroupBuilder(),
    };
    const scene = {
        surface: { engine },
        camera,
        meshes: [{ material }],
        _built: false,
        _z: false,
        _disposables: [],
        _beforeRender: [],
    };
    // The enabler awaits nothing, so its whole body has run when it returns,
    // and a refusal it rejects with leaves the material without the plugin.
    void enablePbrSsao(scene, {
        engine,
        camera,
        outputTexture: { _disposed: false },
    }).catch(() => undefined);
    const plugin =
        material.plugins?.length === 1 ? material.plugins[0] : undefined;
    if (!plugin)
        throw new Error(
            "Pinned enablePbrSsao attached no single plugin to a stand-in PBR material.",
        );
    const members = Object.keys(plugin);
    if (members.join() !== SSAO_PBR_PLUGIN_MEMBERS.join()) {
        throw new Error(
            `Pinned enablePbrSsao attaches a plugin with members ${members.join(", ")}; the native binding implements ${SSAO_PBR_PLUGIN_MEMBERS.join(", ")}.`,
        );
    }
    if (
        plugin._pbrIblOnly !== true ||
        plugin.getCustomCode("vertex") !== null
    ) {
        throw new Error(
            "Pinned enablePbrSsao no longer attaches an IBL-pass fragment plugin.",
        );
    }
    const fragment = plugin.getCustomCode("fragment");
    if (!fragment)
        throw new Error(
            "Pinned enablePbrSsao attaches a plugin without fragment code.",
        );
    ssaoPbrPlugin = {
        name: plugin.name,
        fragment: { ...fragment },
        samplers: plugin.getSamplers().map((sampler) => ({ ...sampler })),
        pbrIblOnly: true,
    };
    return ssaoPbrPlugin;
}
