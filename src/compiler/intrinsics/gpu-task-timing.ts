import type ts from "typescript";
import { nativeTaskTimingSnapshot } from "../../pinned-gpu-task-timing.js";
import type { LoweringServices } from "../lowering-services.js";
import { booleanValue, staticStringValue, type Value } from "../types.js";
import { numberConstantValue } from "../number-intrinsics.js";
import { argumentAt } from "../syntax.js";
import type { IntrinsicCallContext } from "./context.js";
import { ApplicationRealmRequired } from "../worker-modules.js";

export interface GpuTaskTimingIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            | "emitDiscardedValue"
            | "dataLowerer"
            | "dataTypes"
            | "cppString"
            | "fail"
            | "reachJsData"
        > {}

export function compileGpuTaskTimingIntrinsic(
    context: GpuTaskTimingIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
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
    if (setting && !engine.ownedEngineCpp) throw new ApplicationRealmRequired();
    context.reachFeature("backend:sdl", call);
    context.emitDiscardedValue(engine);
    if (setting) {
        const enabled = context.compileValue(argumentAt(call, 1));
        context.expectKind(enabled, "boolean", call);
        context.emitDiscardedValue(enabled);
    }
    const snapshot = nativeTaskTimingSnapshot();
    if (name === "isRenderTaskGpuTimingSupported") return booleanValue("false");
    const properties: Record<string, Value> = {};
    for (const [key, value] of snapshot) {
        properties[key] =
            typeof value === "string"
                ? staticStringValue(value, (text) => context.cppString(text))
                : typeof value === "number"
                  ? numberConstantValue(value)
                  : typeof value === "boolean"
                    ? booleanValue(String(value))
                    : { kind: "tuple", cpp: "", tupleElements: [] };
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
    context.reachJsData();
    const cpp = context.dataLowerer.compileKnownValueForSink(
        { kind: "record", cpp: "", recordProperties: properties },
        type,
        call,
    );
    const value = context.dataLowerer.leafValue(cpp, type);
    if (!setting) return value;
    context.reachFeature("platform:workers", call);
    const promiseType = context.dataTypes.cppType(type);
    return {
        kind: "promise",
        cpp: `bbl::js::Promise<${promiseType}>::resolved(${cpp})`,
        promiseType,
        promiseResult: context.dataLowerer.leafValue("", type),
    };
}
