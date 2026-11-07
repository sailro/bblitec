// `enableGeometryVelocity(task, options)` (`frame-graph/enable-geometry-velocity.ts`).
//
// The enabler installs module state the PBR geometry composer reads, so
// composition settles it for the whole program (`pinned-geometry-velocity.ts`)
// and the call must run unconditionally before scene registration. What it
// installs on the task -- the previous-depth flag the params block carries
// and the perspective-camera check -- is the native call's.
import type ts from "typescript";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import {
    compileOptionalStaticBoolean,
    validateObjectProperties,
} from "../option-helpers.js";
import type { EngineIntrinsicContext } from "./engine.js";

/** The previous-depth contract stores view depth in velocity Z, which needs an RGBA float target. */
const PREVIOUS_DEPTH_FORMATS: ReadonlySet<string> = new Set([
    "rgba16float",
    "rgba32float",
]);

export function compileEnableGeometryVelocity(
    context: EngineIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 1, 2);
    const task = context.compileValue(argumentAt(call, 0));
    const manifest = task.kind === "task" ? task.geometryTask : undefined;
    if (!manifest) {
        return context.fail(
            call,
            "enableGeometryVelocity requires a createGeometryRendererTask task.",
        );
    }
    if (!manifest.attachments.includes("LINEAR_VELOCITY")) {
        return context.fail(
            call,
            "Geometry velocity requires a live LINEAR_VELOCITY attachment.",
        );
    }
    const optionsExpression = call.arguments[1];
    let previousDepthExpression: ts.Expression | undefined;
    if (optionsExpression) {
        const options = context.expectObjectLiteral(optionsExpression);
        validateObjectProperties(
            context,
            options,
            ["previousDepth"],
            "enableGeometryVelocity options support previousDepth.",
        );
        previousDepthExpression = context.objectProperty(
            options,
            "previousDepth",
        );
    }
    const previousDepth = compileOptionalStaticBoolean(
        context,
        previousDepthExpression,
        false,
        "enableGeometryVelocity previousDepth",
    );
    if (
        previousDepth &&
        !PREVIOUS_DEPTH_FORMATS.has(manifest.velocityFormat ?? "")
    ) {
        return context.fail(
            call,
            "Geometry previous-depth velocity requires a floating-point RGBA velocity attachment.",
        );
    }
    if (
        context.engineLifecycle.engineHasStarted() ||
        context.hasRegisteredScene() ||
        context.isRuntimeResourceConstruction()
    ) {
        return context.fail(
            call,
            "enableGeometryVelocity is lowered as an unconditional call before " +
                "scene registration: the geometry views it marks compose at registration.",
        );
    }
    context.sceneManifest.recordGeometryVelocity(manifest, previousDepth, call);
    context.reachFeature("renderer:geometry-velocity", call);
    return {
        kind: "void",
        cpp: `bbl::upstream::enable_geometry_velocity(${context.requireEngine(task, call)}, ${task.cpp}, ${previousDepth ? "true" : "false"})`,
    };
}
