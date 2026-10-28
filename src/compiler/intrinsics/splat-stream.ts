import ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import type { IntrinsicCallContext } from "./context.js";

export interface SplatStreamIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            | "allocateTemporaryCppName"
            | "bindings"
            | "checker"
            | "dataTypes"
            | "dataLowerer"
            | "emit"
            | "fail"
            | "options"
        > {}

/** An AbortSignal argument: the runtime's own signal object, which the library holds. */
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
    return optional
        ? `(${value.cpp}).value_or(bbl::js::AbortSignal{})`
        : value.cpp;
}

/**
 * The splat library's voxel collision calls, whose signal and points the
 * generic library call (`compileLoweredLibraryIntrinsic`) does not read.
 */
export function compileSplatStreamIntrinsic(
    context: SplatStreamIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (name !== "loadSplatVoxelCollision" && name !== "moveSplatVoxelCamera")
        return undefined;
    context.reachFeature("loader:splat-stream", call);
    switch (name) {
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
                : "bbl::js::AbortSignal{}";
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
