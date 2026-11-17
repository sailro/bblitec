import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import type { IntrinsicCallContext } from "./context.js";
import { ApplicationRealmRequired } from "../worker-modules.js";

export interface ScreenshotIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            | "dataLowerer"
            | "dataTypes"
            | "fail"
            | "reachJsData"
            | "requireEngine"
        > {}

/**
 * `captureScreenshot(surface)` (src/engine/screenshot.ts): a request the next
 * rendered frame of the engine's primary surface settles with the pin's
 * `Screenshot`, the same record for every request that frame serves.
 */
export function compileScreenshotIntrinsic(
    context: ScreenshotIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (name !== "captureScreenshot") return undefined;
    context.expectArgumentCount(call, 1, 1);
    const surface = context.compileValue(argumentAt(call, 0));
    if (surface.kind === "surface")
        return context.fail(
            call,
            "captureScreenshot of an auxiliary surface is not lowered; it captures the engine's primary surface.",
        );
    context.expectKind(surface, "engine", argumentAt(call, 0));
    // The request settles from a frame the application realm's loop runs
    // between its tasks, as the pin's render loop does.
    if (!surface.ownedEngineCpp) throw new ApplicationRealmRequired();
    const engine = context.requireEngine(surface, call);
    const mapped = context.dataLowerer.dataTypeAt(call);
    const result = mapped?.kind === "promise" ? mapped.result : mapped;
    if (result?.kind !== "struct")
        return context.fail(
            call,
            "captureScreenshot requires the pinned Screenshot record type.",
        );
    const type = context.dataTypes.markStoredObjectReferences(result);
    if (type.kind !== "struct")
        return context.fail(
            call,
            "captureScreenshot requires a stored Screenshot record.",
        );
    const properties: Record<string, Value> = {
        width: { kind: "number", cpp: "shot.width" },
        height: { kind: "number", cpp: "shot.height" },
        data: context.dataLowerer.leafValue("shot.data", {
            kind: "u8clampedarray",
        }),
    };
    const fields = context.dataTypes.structFields(type.name, call);
    if (fields.some((field) => !(field.sourceName in properties)))
        return context.fail(call, "Unrepresented Screenshot field.");
    context.reachJsData();
    context.reachFeature("engine:screenshot", call);
    context.reachFeature("platform:workers", call);
    const cppType = context.dataTypes.cppType(type);
    const record = context.dataLowerer.compileKnownValueForSink(
        { kind: "record", cpp: "", recordProperties: properties },
        type,
        call,
    );
    return {
        kind: "promise",
        cpp:
            `bbl::pal::capture_screenshot(${engine}).then(` +
            `[](const std::shared_ptr<bbl::pal::Screenshot>& settled) { ` +
            `return bbl::pal::project_screenshot<${cppType}>(settled, ` +
            `[](const bbl::pal::Screenshot& shot) { return ${record}; }); })`,
        promiseType: cppType,
        promiseResult: context.dataLowerer.leafValue("", type),
    };
}
