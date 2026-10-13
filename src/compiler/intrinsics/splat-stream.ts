import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import { ApplicationRealmRequired } from "../worker-modules.js";
import type { IntrinsicCallContext } from "./context.js";
import { retainedOptions } from "./retained-options.js";

export interface SplatStreamIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            | "allocateTemporaryCppName"
            | "bindings"
            | "castNumber"
            | "dataTypes"
            | "dataLowerer"
            | "emit"
            | "fail"
            | "options"
        > {}

/**
 * The streamed Gaussian-splat library's public functions, lowered whole from
 * the pin into `bblite/upstream_splat_stream.hpp` (src/lowering/
 * splat-stream-library.ts): a stream loads on the realm's event loop, so a
 * program reaching it runs as an application realm.
 */
const STREAM_FUNCTIONS = new Set([
    "loadGaussianSplatStream",
    "attachGaussianSplatStream",
    "disposeGaussianSplatStream",
    "loadSplatVoxelCollision",
    "moveSplatVoxelCamera",
]);

/** `GaussianSplatStreamOptions`' numeric members, by native field. */
const NUMERIC_OPTIONS: ReadonlyMap<string, string> = new Map([
    ["maxSplats", "max_splats"],
    ["maxCapacitySplats", "max_capacity_splats"],
    ["maxGpuBytes", "max_gpu_bytes"],
    ["maxCpuBytes", "max_cpu_bytes"],
    ["maxConcurrentRequests", "max_concurrent_requests"],
    ["maxConcurrentDecodes", "max_concurrent_decodes"],
    ["screenError", "screen_error"],
    ["lodHysteresis", "lod_hysteresis"],
    ["lodCooldownMs", "lod_cooldown_ms"],
    ["maxRetries", "max_retries"],
]);

export const gaussianSplatStreamValue = (cpp: string): Value => ({
    kind: "gaussian-splat-stream",
    cpp,
    dataType: { kind: "handle", handle: "gaussian-splat-stream" },
});

/** An AbortSignal argument as the library's handle on the same signal. */
function signalArgument(
    context: SplatStreamIntrinsicContext,
    value: Value,
    site: ts.Node,
): string {
    const type = value.dataType;
    const optional = type?.kind === "optional";
    if ((optional ? type.inner : type)?.kind !== "abort-signal")
        return context.fail(
            site,
            "A splat-stream signal requires an AbortSignal.",
        );
    const held = context.allocateTemporaryCppName("stream_signal");
    context.emit({
        kind: "declaration",
        type: "const auto",
        name: held,
        initializer: value.cpp,
    });
    return optional
        ? `(${held}.has_value() ? bbl::splat_stream_platform::abort_signal_of(*${held}) : bbl::splat_stream_platform::AbortSignal{})`
        : `bbl::splat_stream_platform::abort_signal_of(${held})`;
}

/** `GaussianSplatStreamOptions` from a closed or typed record, each member at the call. */
function streamOptions(
    context: SplatStreamIntrinsicContext,
    site: ts.Expression | undefined,
): string {
    const target = context.allocateTemporaryCppName("stream_options");
    context.emit({
        kind: "declaration",
        type: "bbl::GaussianSplatStreamOptions",
        name: target,
        initializer: "{}",
    });
    if (!site) return target;
    for (const field of retainedOptions(
        context,
        context.compileValue(site),
        site,
    )) {
        const native = NUMERIC_OPTIONS.get(field.name);
        if (native !== undefined) {
            const type =
                field.type?.kind === "optional" ? field.type.inner : field.type;
            if (type?.kind !== "number")
                context.fail(
                    site,
                    `GaussianSplatStreamOptions.${field.name} requires a number.`,
                );
            context.emit({
                kind: "expression",
                code:
                    field.type?.kind === "optional"
                        ? `${target}.${native} = ${field.cpp};`
                        : `${target}.${native} = ${field.value ? context.castNumber(field.value, "double") : field.cpp};`,
            });
        } else if (field.name === "signal") {
            const value: Value = field.value ?? {
                kind: "data",
                cpp: field.cpp,
                ...(field.type ? { dataType: field.type } : {}),
            };
            context.emit({
                kind: "expression",
                code: `${target}.signal = ${signalArgument(context, value, site)};`,
            });
        } else
            context.fail(
                site,
                `GaussianSplatStreamOptions.${field.name} is not a public stream option.`,
            );
    }
    return target;
}

export function compileSplatStreamIntrinsic(
    context: SplatStreamIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (!STREAM_FUNCTIONS.has(name)) return undefined;
    if (!context.options.workers) throw new ApplicationRealmRequired();
    context.reachFeature("loader:splat-stream", call);
    switch (name) {
        case "loadGaussianSplatStream": {
            context.expectArgumentCount(call, 2, 3);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const owner = context.bindings.pinValueToTemporary(
                engine,
                "stream_engine",
                argumentAt(call, 0),
            );
            const url = context.bindings.pinValueToTemporary(
                {
                    kind: "string",
                    cpp: context.dataLowerer.compileForSink(
                        argumentAt(call, 1),
                        { kind: "string" },
                    ),
                },
                "stream_url",
                argumentAt(call, 1),
            );
            const options = streamOptions(context, call.arguments[2]);
            return {
                kind: "promise",
                cpp: `bbl::load_gaussian_splat_stream(bbl::StoredEngine(${owner.cpp}), ${url.cpp}, ${options})`,
                promiseType: "std::shared_ptr<bbl::GaussianSplatStream>",
                promiseResult: gaussianSplatStreamValue(""),
            };
        }
        case "attachGaussianSplatStream":
        case "disposeGaussianSplatStream": {
            context.expectArgumentCount(call, 2, 2);
            const scene = context.compileValue(argumentAt(call, 0));
            context.expectKind(scene, "scene", argumentAt(call, 0));
            const held = context.bindings.pinValueToTemporary(
                scene,
                "stream_scene",
                argumentAt(call, 0),
            );
            const stream = context.compileValue(argumentAt(call, 1));
            context.expectKind(
                stream,
                "gaussian-splat-stream",
                argumentAt(call, 1),
            );
            // An attached stream draws in the scene's own pass.
            if (name === "attachGaussianSplatStream") {
                context.reachFeature("renderer:scene", call);
                context.reachFeature("renderer:geometry-output", call);
            }
            const native =
                name === "attachGaussianSplatStream"
                    ? "attach_gaussian_splat_stream"
                    : "dispose_gaussian_splat_stream";
            return {
                kind: "void",
                cpp: `bbl::${native}(${held.cpp}.state, ${stream.cpp})`,
            };
        }
        case "loadSplatVoxelCollision": {
            context.expectArgumentCount(call, 1, 2);
            const url = context.bindings.pinValueToTemporary(
                {
                    kind: "string",
                    cpp: context.dataLowerer.compileForSink(
                        argumentAt(call, 0),
                        { kind: "string" },
                    ),
                },
                "collision_url",
                argumentAt(call, 0),
            );
            const signal = call.arguments[1]
                ? signalArgument(
                      context,
                      context.compileValue(argumentAt(call, 1)),
                      argumentAt(call, 1),
                  )
                : "bbl::splat_stream_platform::AbortSignal{}";
            return {
                kind: "promise",
                cpp: `bbl::load_splat_voxel_collision(${url.cpp}, ${signal})`,
                promiseType: "std::shared_ptr<bbl::SplatVoxelCollision>",
                promiseResult: {
                    kind: "splat-voxel-collision",
                    cpp: "",
                    dataType: {
                        kind: "handle",
                        handle: "splat-voxel-collision",
                    },
                },
            };
        }
        case "moveSplatVoxelCamera": {
            context.expectArgumentCount(call, 3, 4);
            const collision = context.compileValue(argumentAt(call, 0));
            context.expectKind(
                collision,
                "splat-voxel-collision",
                argumentAt(call, 0),
            );
            const held = context.bindings.pinValueToTemporary(
                collision,
                "collision",
                argumentAt(call, 0),
            );
            const point = (index: number): string =>
                context.bindings.pinValueToTemporary(
                    {
                        kind: "data",
                        cpp: context.dataLowerer.compileForSink(
                            argumentAt(call, index),
                            { kind: "tuple", arity: 3 },
                        ),
                        dataType: { kind: "tuple", arity: 3 },
                    },
                    "collision_point",
                    argumentAt(call, index),
                ).cpp;
            const from = point(1);
            const to = point(2);
            const radius = call.arguments[3]
                ? `, ${context.dataLowerer.compileForSink(argumentAt(call, 3), { kind: "number" })}`
                : "";
            return {
                kind: "data",
                cpp: `bbl::move_splat_voxel_camera(${held.cpp}, ${from}, ${to}${radius})`,
                dataType: { kind: "tuple", arity: 3 },
            };
        }
    }
    return undefined;
}
