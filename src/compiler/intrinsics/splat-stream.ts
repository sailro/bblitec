import ts from "typescript";
import { cppIdentifier, snakeCase } from "../../cpp-literals.js";
import { SPLAT_STREAM_APPLICATION_ROOTS } from "../../lowering/splat-stream-library.js";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import type { IntrinsicCallContext } from "./context.js";
import {
    emitPresentOption,
    emitScalarOption,
    retainedOptions,
} from "./retained-options.js";

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

const gaussianSplatStreamValue = (cpp: string): Value => ({
    kind: "gaussian-splat-stream",
    cpp,
    dataType: { kind: "handle", handle: "gaussian-splat-stream" },
});

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
 * `GaussianSplatStreamOptions` from a closed or typed record, each member at
 * the call: the pinned interface's public members (none `@internal`), each
 * into its record field (the pinned name in snake case), absent ones left to
 * the library's normalization.
 */
function streamOptions(
    context: SplatStreamIntrinsicContext,
    call: ts.CallExpression,
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
    const parameter = context.checker
        .getResolvedSignature(call)
        ?.getParameters()[2];
    const pinned = parameter
        ? context.checker.getNonNullableType(
              context.checker.getTypeOfSymbolAtLocation(parameter, call),
          )
        : undefined;
    for (const option of retainedOptions(
        context,
        context.compileValue(site),
        site,
    )) {
        const declaration = pinned
            ?.getProperty(option.name)
            ?.declarations?.find(ts.isPropertySignature);
        if (
            !declaration ||
            ts
                .getJSDocTags(declaration)
                .some((tag) => tag.tagName.text === "internal")
        )
            context.fail(
                site,
                `GaussianSplatStreamOptions.${option.name} is not a public stream option.`,
            );
        const field = `${target}.${cppIdentifier(snakeCase(option.name))}`;
        emitPresentOption(context, option, (present) => {
            if (present.type?.kind === "abort-signal")
                context.emit({
                    kind: "expression",
                    code: `${field} = ${present.cpp};`,
                });
            else emitScalarOption(context, present, "number", field, site);
        });
    }
    return target;
}

export function compileSplatStreamIntrinsic(
    context: SplatStreamIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (!SPLAT_STREAM_APPLICATION_ROOTS.has(name)) return undefined;
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
            const options = streamOptions(context, call, call.arguments[2]);
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
