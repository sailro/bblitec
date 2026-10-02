import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { requireWindowHost } from "./window-events.js";
import { browserEnvironmentPropertyValue } from "./browser-erasure.js";
import { pinOperand } from "./evaluation-order.js";

/** Metadata for the host's selected device, exposed without admitting raw device operations. */
export function compileGpuAdapterCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    hostFunction?: Value["hostFunction"],
): Value | undefined {
    if (hostFunction !== "gpu-request-adapter") return undefined;
    const context = lowerer.context;
    const target = context.unwrap(call.expression);
    const receiver = ts.isPropertyAccessExpression(target)
        ? (context.knownValueWithoutEvaluation(target.expression) ??
          browserEnvironmentPropertyValue(context, target.expression))
        : undefined;
    if (!receiver?.nativeGpu)
        context.fail(
            call.expression,
            "GPU.requestAdapter requires its native GPU receiver; detached or transplanted methods are unsupported.",
        );
    if (!context.options.workers) throw new ApplicationRealmRequired();
    if (!context.options.workers.namespace) requireWindowHost(context, call);
    context.expectArgumentCount(call, 0, 1);
    const options = call.arguments[0];
    let argumentsCpp = "";
    if (options) {
        let value = context.compileValue(options);
        if (value.kind !== "json-null") {
            if (value.recordGetters && Object.keys(value.recordGetters).length)
                context.fail(
                    options,
                    "GPU adapter options require plain data properties.",
                );
            const fields = [
                {
                    sourceName: "powerPreference",
                    type: { kind: "optional", inner: { kind: "string" } },
                    defaultWhenMissing: true,
                },
                {
                    sourceName: "forceFallbackAdapter",
                    type: { kind: "optional", inner: { kind: "boolean" } },
                    defaultWhenMissing: true,
                },
                {
                    sourceName: "featureLevel",
                    type: { kind: "optional", inner: { kind: "string" } },
                    defaultWhenMissing: true,
                },
                {
                    sourceName: "xrCompatible",
                    type: { kind: "optional", inner: { kind: "boolean" } },
                    defaultWhenMissing: true,
                },
            ] as const;
            if (value.kind === "record") {
                const properties: Record<string, Value> = {};
                for (const [name, field] of Object.entries(
                    value.recordProperties ?? {},
                )) {
                    if (fields.some((option) => option.sourceName === name))
                        properties[name] = pinOperand(
                            context,
                            field,
                            options,
                            "gpu_option",
                        );
                    else context.emitDiscardedValue(field);
                }
                value = { ...value, recordProperties: properties };
            }
            const optionsType = context.dataTypes.ownedRecordType(fields);
            const stored = context.allocateTemporaryCppName(
                "gpu_adapter_options",
            );
            context.emit({
                kind: "declaration",
                type: "const auto",
                name: stored,
                initializer: lowerer.compileKnownValueForSink(
                    value,
                    optionsType,
                    options,
                ),
            });
            argumentsCpp = `${stored}->powerPreference, ${stored}->forceFallbackAdapter.value_or(false), ${stored}->featureLevel, ${stored}->xrCompatible.value_or(false)`;
        }
    }
    context.reachJsData();
    return lowerer.leafValue(
        `bbl::pal::WorkerRealm::current().request_graphics_adapter(${argumentsCpp})`,
        {
            kind: "promise",
            result: { kind: "optional", inner: { kind: "gpu-adapter" } },
        },
    );
}

export function gpuAdapterProperty(
    lowerer: DataLowerer,
    owner: Value,
    property: string,
): Value | undefined {
    if (owner.dataType?.kind === "gpu-adapter" && property === "info")
        return lowerer.leafValue(`(${owner.cpp})->info`, {
            kind: "gpu-adapter-info",
        });
    if (
        owner.dataType?.kind === "gpu-adapter-info" &&
        ["vendor", "architecture", "device", "description"].includes(property)
    )
        return lowerer.leafValue(`(${owner.cpp})->${property}`, {
            kind: "string",
        });
    return undefined;
}
