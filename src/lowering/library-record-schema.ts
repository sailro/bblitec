/**
 * The schema every lowered pinned library shares: the web platform
 * (`web-platform-schema.ts`) and the WebGPU subset (`gpu-schema.ts`), with
 * the library's own records after them and its own platform calls.
 */
import type { LoweringContext } from "./context.js";
import {
    type CallAdapter,
    PinnedRecordModel,
    type RecordSchema,
    type RecordSpec,
} from "./pinned-record-lowerer.js";
import {
    gpuMapModeConstants,
    gpuSubsetRecords,
    gpuSubsetValues,
} from "./gpu-schema.js";
import { matrixValues } from "./record-shapes.js";
import { webgpuFlagConstants } from "../webgpu-flags.js";
import {
    webPlatformConstructors,
    webPlatformGlobals,
    webPlatformGlobalValues,
    webPlatformInstanceOf,
    webPlatformRecords,
    webPlatformValues,
} from "./web-platform-schema.js";

/**
 * A library's record model built once per lowering context: the record
 * layouts and member spellings the application compiler reads the
 * library's public records through.
 */
export function recordModelPerContext(
    build: (context: LoweringContext) => PinnedRecordModel,
): (context: LoweringContext) => PinnedRecordModel {
    const models = new WeakMap<LoweringContext, PinnedRecordModel>();
    return (context) => {
        let model = models.get(context);
        if (!model) models.set(context, (model = build(context)));
        return model;
    };
}

/** A lowered record family: structs, prototypes, definitions and includes. */
export interface LoweredRecordFamily {
    readonly structs: string;
    readonly declarations: string;
    readonly definitions: string;
    readonly includes: readonly string[];
}

export function libraryRecordSchema(
    records: readonly RecordSpec[],
    adapters: ReadonlyMap<string, CallAdapter> = new Map(),
): Pick<
    RecordSchema,
    | "records"
    | "values"
    | "adapters"
    | "constructors"
    | "globals"
    | "globalValues"
    | "instanceOf"
    | "constants"
> {
    return {
        records: [...gpuSubsetRecords, ...webPlatformRecords, ...records],
        // A single-precision engine's matrices and the WebGPU objects held
        // without a member read, beside the platform's values.
        values: new Map([
            ...webPlatformValues,
            ...gpuSubsetValues,
            ...matrixValues,
        ]),
        adapters,
        constructors: webPlatformConstructors,
        globals: webPlatformGlobals,
        globalValues: webPlatformGlobalValues,
        instanceOf: webPlatformInstanceOf,
        constants: new Map([...webgpuFlagConstants, ...gpuMapModeConstants]),
    };
}
