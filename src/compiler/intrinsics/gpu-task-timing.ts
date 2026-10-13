import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import { booleanValue, type Value } from "../types.js";
import type { DataType } from "../data-types.js";
import { argumentAt } from "../syntax.js";
import type { IntrinsicCallContext } from "./context.js";
import { ApplicationRealmRequired } from "../worker-modules.js";
import { EmissionWeakMap } from "../emission-transaction.js";
import { sharedPinnedContext } from "../../lowering/context.js";
import { lowerGpuFrameTimer } from "../../lowering/gpu-frame-timer.js";

export interface GpuTaskTimingIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            | "dataLowerer"
            | "dataTypes"
            | "fail"
            | "reachJsData"
            | "bindings"
            | "nativeEmission"
            | "allocateTemporaryCppName"
        > {}

/** Convert PAL timestamp results to the reached, pinned public record types. */
function timingProjection(
    context: GpuTaskTimingIntrinsicContext,
    type: DataType<"struct">,
    call: ts.CallExpression,
): string {
    const fields = context.dataTypes.structFields(type.name, call);
    const tasks = fields.find((field) => field.sourceName === "tasks")?.type;
    if (tasks?.kind !== "vector" || tasks.element.kind !== "struct")
        return context.fail(
            call,
            "GPU task timing requires its pinned task records.",
        );
    const entryType = context.dataTypes.markStoredObjectReferences(
        tasks.element,
    );
    const entryProperties: Record<string, Value> = {
        index: { kind: "number", cpp: "entry.index" },
        name: { kind: "string", cpp: "entry.name" },
        durationMs: { kind: "number", cpp: "entry.duration_ms" },
    };
    const entry = context.dataLowerer.compileKnownValueForSink(
        { kind: "record", cpp: "", recordProperties: entryProperties },
        entryType,
        call,
    );
    const taskType = { kind: "vector", element: entryType } satisfies DataType;
    const entries = `([&] { ${context.dataTypes.cppType(taskType)} tasks; tasks.reserve(timing.tasks.size()); for (const auto& entry : timing.tasks) tasks.push_back(${entry}); return tasks; }())`;
    const errorType = {
        kind: "optional",
        inner: { kind: "string" },
        undefinedOnly: true,
    } satisfies DataType;
    const properties: Record<string, Value> = {
        status: { kind: "string", cpp: "timing.status" },
        supported: booleanValue("timing.supported"),
        enabled: booleanValue("timing.enabled"),
        frameIndex: { kind: "number", cpp: "timing.frame_index" },
        totalDurationMs: { kind: "number", cpp: "timing.total_duration_ms" },
        droppedTaskCount: { kind: "number", cpp: "timing.dropped_task_count" },
        tasks: context.dataLowerer.leafValue(entries, taskType),
        error: context.dataLowerer.leafValue(
            "(timing.error ? bbl::js::Nullable<std::string>(*timing.error) : bbl::js::Nullable<std::string>{})",
            errorType,
        ),
    };
    if (fields.some((field) => !(field.sourceName in properties)))
        return context.fail(call, "Unrepresented GPU timing snapshot field.");
    return context.dataLowerer.compileKnownValueForSink(
        { kind: "record", cpp: "", recordProperties: properties },
        type,
        call,
    );
}

const frameTimers = new EmissionWeakMap<object, string>();

/** `setGpuTimingEnabled` and `isGpuTimingSupported` over the task timing device. */
function compileGpuFrameTimingIntrinsic(
    context: GpuTaskTimingIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (!["setGpuTimingEnabled", "isGpuTimingSupported"].includes(name))
        return undefined;
    const setting = name === "setGpuTimingEnabled";
    context.expectArgumentCount(call, setting ? 2 : 1, setting ? 2 : 1);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", call);
    if (!engine.ownedEngineCpp) throw new ApplicationRealmRequired();
    context.reachFeature("backend:sdl", call);
    context.reachFeature("engine:gpu-task-timing", call);
    const pinned = context.bindings.pinValueToTemporary(
        engine,
        "timing_engine",
        call,
    );
    const state = `bbl::pal::gpu_task_timing_state(${pinned.cpp})`;
    if (!setting) return booleanValue(`${state}->supported`);
    const enabled = context.compileValue(argumentAt(call, 1));
    context.expectKind(enabled, "boolean", call);
    let timer = frameTimers.get(context);
    if (!timer) {
        timer = context.allocateTemporaryCppName("set_gpu_timing_enabled");
        const lowered = lowerGpuFrameTimer(sharedPinnedContext(), timer);
        context.nativeEmission.registerNativeFunction(
            lowered.prototype,
            lowered.lines,
        );
        frameTimers.set(context, timer);
    }
    return {
        kind: "void",
        cpp: `bblscene::${timer}(${state}, ${enabled.cpp})`,
    };
}

export function compileGpuTaskTimingIntrinsic(
    context: GpuTaskTimingIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    const frame = compileGpuFrameTimingIntrinsic(context, name, call);
    if (frame) return frame;
    if (
        ![
            "isRenderTaskGpuTimingSupported",
            "getRenderTaskGpuTimings",
            "setRenderTaskGpuTimingEnabled",
        ].includes(name)
    )
        return undefined;
    const setting = name === "setRenderTaskGpuTimingEnabled";
    context.expectArgumentCount(call, setting ? 2 : 1, setting ? 2 : 1);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", call);
    if (!engine.ownedEngineCpp) throw new ApplicationRealmRequired();
    context.reachFeature("backend:sdl", call);
    context.reachFeature("engine:gpu-task-timing", call);
    const pinned = context.bindings.pinValueToTemporary(
        engine,
        "timing_engine",
        call,
    );
    const state = `bbl::pal::gpu_task_timing_state(${pinned.cpp})`;
    if (name === "isRenderTaskGpuTimingSupported")
        return booleanValue(
            `bbl::is_render_task_gpu_timing_supported(${state})`,
        );
    let enabled: Value | undefined;
    if (setting) {
        enabled = context.compileValue(argumentAt(call, 1));
        context.expectKind(enabled, "boolean", call);
    }
    const mapped = context.dataLowerer.dataTypeAt(call);
    const result =
        setting && mapped?.kind === "promise" ? mapped.result : mapped;
    if (result?.kind !== "struct")
        return context.fail(
            call,
            "Task timing snapshot requires its pinned record type.",
        );
    const type = context.dataTypes.markStoredObjectReferences(result);
    if (type.kind !== "struct")
        return context.fail(
            call,
            "Task timing snapshot requires a stored record.",
        );
    context.reachJsData();
    const projection = timingProjection(context, type, call);
    const cppType = context.dataTypes.cppType(type);
    const project = `[](const std::shared_ptr<bbl::pal::GpuTaskTimingSnapshot>& snapshot) { return bbl::pal::project_gpu_task_timing_snapshot<${cppType}>(snapshot, [](const bbl::pal::GpuTaskTimingSnapshot& timing) { return ${projection}; }); }`;
    const cpp = setting
        ? `bbl::set_render_task_gpu_timing_enabled(${state}, ${enabled!.cpp}).then(${project})`
        : `(${project})(bbl::get_render_task_gpu_timings(${state}))`;
    if (!setting) return context.dataLowerer.leafValue(cpp, type);
    context.reachFeature("platform:workers", call);
    return {
        kind: "promise",
        cpp,
        promiseType: cppType,
        promiseResult: context.dataLowerer.leafValue("", type),
    };
}
