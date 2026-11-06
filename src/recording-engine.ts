/**
 * The engine a pinned frame-graph task factory composes against, and the
 * pinned objects composition hands it.
 *
 * The screen-space effects and `createSsaoTask` build every GPU object
 * through `engine._device` and encode through `engine._currentEncoder`, so
 * composition runs them on an engine whose device and one encoder are the
 * recording device's (`recording-device.ts`), with the engine members the
 * factories read at creation and execution. The descriptor shapes both read
 * back are one superset: each reads the members it needs.
 */
import { stringLiteral } from "./cpp-literals.js";
import { importPinnedModule } from "./pinned-shader-composer.js";
import {
    createRecordingDevice,
    type RecordingContract,
    type Recorder,
} from "./recording-device.js";

/** One bind-group layout entry as the pin declares it (`GPUBindGroupLayoutEntry`). */
export interface RecordedLayoutEntry {
    binding: number;
    visibility?: number;
    buffer?: { type?: string };
    texture?: { sampleType?: string };
    storageTexture?: { access?: string; format?: string };
    sampler?: { type?: string };
}

/** The descriptor members task composition reads back off the recording. */
export interface PinnedTaskShapes {
    sampler: {
        label?: string;
        minFilter?: string;
        magFilter?: string;
        mipmapFilter?: string;
        addressModeU?: string;
        addressModeV?: string;
        addressModeW?: string;
        compare?: string;
    };
    shaderModule: { code: string };
    bindGroupLayout: { entries: readonly RecordedLayoutEntry[] };
    pipelineLayout: {
        bindGroupLayouts: readonly PinnedTaskShapes["bindGroupLayout"][];
    };
    renderPipeline: {
        label?: string;
        layout: PinnedTaskShapes["pipelineLayout"];
        vertex: {
            module: PinnedTaskShapes["shaderModule"];
            entryPoint: string;
        };
        fragment: {
            module: PinnedTaskShapes["shaderModule"];
            entryPoint: string;
            targets: readonly { format: string; blend?: unknown }[];
            constants?: Readonly<Record<string, number>>;
        };
        primitive?: { topology?: string };
    };
    bindGroup: {
        layout: PinnedTaskShapes["bindGroupLayout"] | object;
        entries: readonly { binding: number; resource: unknown }[];
    };
}

export type PinnedTaskRecorder = Recorder<PinnedTaskShapes>;

/**
 * What a layout entry binds, in WebGPU's own spelling with every default
 * the pin left out filled in: a buffer's `type`, a texture's `sampleType`,
 * a sampler's `type`, or a storage texture's access and format. Exactly one
 * is set. Both backends read it as `GPUBindGroupLayoutEntry` would be read.
 */
export interface PlannedLayoutResource {
    bufferType?: string;
    sampleType?: string;
    samplerType?: string;
    storageTexture?: { access: string; format: string };
}

/** A group-0 layout entry and the WGSL identifier its module declares there. */
export interface PlannedLayoutEntry extends PlannedLayoutResource {
    binding: number;
    name: string;
}

/**
 * The resource a recorded layout entry binds, refusing a member this
 * port does not carry: a dynamic offset, a minimum binding size, a view
 * dimension other than 2D, multisampling.
 */
export function plannedLayoutResource(
    entry: RecordedLayoutEntry,
    what: string,
): PlannedLayoutResource {
    const refuse = (detail: string): never => {
        throw new Error(
            `${what} lays out binding ${entry.binding} ${detail}, which this port does not carry.`,
        );
    };
    const only = (
        member: object,
        allowed: Readonly<Record<string, unknown>>,
    ): void => {
        for (const [key, value] of Object.entries(member)) {
            if (!(key in allowed)) refuse(`with '${key}'`);
            if (allowed[key] !== undefined && value !== allowed[key])
                refuse(`with ${key} '${String(value)}'`);
        }
    };
    const members = [
        entry.buffer,
        entry.texture,
        entry.sampler,
        entry.storageTexture,
    ].filter((member) => member !== undefined);
    if (members.length !== 1) refuse("as other than one resource kind");
    if (entry.buffer) {
        only(entry.buffer, { type: undefined });
        return { bufferType: entry.buffer.type ?? "uniform" };
    }
    if (entry.texture) {
        only(entry.texture, {
            sampleType: undefined,
            viewDimension: "2d",
            multisampled: false,
        });
        return { sampleType: entry.texture.sampleType ?? "float" };
    }
    if (entry.sampler) {
        only(entry.sampler, { type: undefined });
        return { samplerType: entry.sampler.type ?? "filtering" };
    }
    const storage = entry.storageTexture!;
    only(storage, {
        access: undefined,
        format: undefined,
        viewDimension: "2d",
    });
    if (!storage.format) refuse("as a storage texture without a format");
    return {
        storageTexture: {
            access: storage.access ?? "write-only",
            format: storage.format!,
        },
    };
}

/** The native `PinnedLayoutEntry` row of a planned entry. */
export function plannedLayoutEntryCpp(entry: PlannedLayoutEntry): string {
    return (
        `PinnedLayoutEntry{${entry.binding}u, ${stringLiteral(entry.name)}, ` +
        [
            entry.bufferType,
            entry.sampleType,
            entry.samplerType,
            entry.storageTexture?.access,
            entry.storageTexture?.format,
        ]
            .map((value) => stringLiteral(value ?? ""))
            .join(", ") +
        "}"
    );
}

/**
 * An engine whose device answers exactly the contract's calls and records
 * them, with the canvas extent the factory sizes its owned targets from.
 */
export function createRecordingEngine(
    contract: RecordingContract,
    canvas: { width: number; height: number },
): { engine: object; recorder: PinnedTaskRecorder } {
    const { device, encoder, recorder } =
        createRecordingDevice<PinnedTaskShapes>(contract);
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

/** `engine/render-target.ts`, typed by the target object a caller reads. */
export interface PinnedRenderTargets<Target = unknown> {
    createRenderTarget: (descriptor: Record<string, unknown>) => Target;
    buildRenderTarget: (target: Target, engine: unknown) => void;
}

/** `camera/arc-rotate.ts`. */
export interface PinnedCameras {
    createArcRotateCamera: (
        alpha: number,
        beta: number,
        radius: number,
        target: { x: number; y: number; z: number },
    ) => { nearPlane: number; farPlane: number };
}

export function pinnedRenderTargets<Target = unknown>(): Promise<
    PinnedRenderTargets<Target>
> {
    return importPinnedModule<PinnedRenderTargets<Target>>(
        "engine/render-target.js",
    );
}

export function pinnedCameras(): Promise<PinnedCameras> {
    return importPinnedModule<PinnedCameras>("camera/arc-rotate.js");
}

/**
 * A render target created and built on `engine`, as a producer recorded
 * before the task leaves it: a task's `record()` refuses an unbuilt source.
 */
export function builtRenderTarget<Target>(
    targets: PinnedRenderTargets<Target>,
    engine: unknown,
    descriptor: Record<string, unknown>,
): Target {
    const target = targets.createRenderTarget(descriptor);
    targets.buildRenderTarget(target, engine);
    return target;
}
