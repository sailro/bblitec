import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import type { Value } from "./types.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { requireWindowHost } from "./window-events.js";
import { pinOperand } from "./evaluation-order.js";
import { compileBooleanOptions } from "./option-helpers.js";

/** Metadata for the host's selected device, exposed without admitting raw device operations. */
export function compileGpuAdapterCall(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    hostFunction?: Value["hostFunction"],
): Value | undefined {
    const context = lowerer.context;
    const target = context.unwrap(call.expression);
    if (
        hostFunction !== "gpu-request-adapter" &&
        (!ts.isPropertyAccessExpression(target) ||
            target.name.text !== "requestAdapter")
    )
        return undefined;
    const receiver = ts.isPropertyAccessExpression(target)
        ? context.probeEmission(() => {
              const value = context.compileValue(target.expression);
              const type =
                  value.dataType?.kind === "optional"
                      ? value.dataType.inner
                      : value.dataType;
              return value.nativeGpu || type?.kind === "gpu"
                  ? value
                  : undefined;
          })
        : undefined;
    if (!receiver && hostFunction !== "gpu-request-adapter") return undefined;
    if (!receiver)
        return context.fail(
            call.expression,
            "GPU.requestAdapter requires its native GPU receiver; detached or transplanted methods are unsupported.",
        );
    if (ts.isOptionalChain(target) && !ts.isOptionalChain(call))
        return context.fail(
            call,
            "An optional GPU method reference requires a continuous optional call.",
        );
    if (!context.options.workers) throw new ApplicationRealmRequired();
    if (!context.options.workers.namespace) requireWindowHost(context, call);
    // Reading the owner precedes option evaluation, even when only its
    // branded method is needed by the native call.
    const held = pinOperand(context, receiver, call.expression, "gpu_receiver");
    const present =
        receiver.dataType?.kind === "optional"
            ? `${held.cpp}.has_value() && *${held.cpp} != nullptr`
            : `${held.cpp} != nullptr`;
    if (ts.isOptionalChain(call) && ts.isOptionalChain(target)) {
        // Normalize both nullable storage and a null native pointer into the
        // shared optional-call presence contract. The receiver is already held.
        const owner = lowerer.leafValue(
            receiver.dataType?.kind === "optional"
                ? `(*${held.cpp})`
                : held.cpp,
            { kind: "gpu" },
        );
        const requested = lowerer.optionalAccess(
            { ...owner, optionalFoundCpp: present },
            call,
            () => compileRequest(lowerer, call),
        );
        if (requested?.dataType?.kind !== "optional")
            throw new Error(
                "An optional GPU request requires represented result storage.",
            );
        return {
            ...pinOperand(
                context,
                {
                    ...requested,
                    dataType: { ...requested.dataType, undefinedOnly: true },
                },
                call,
                "optional_gpu_request",
            ),
            preserveUncheckedLookup: true,
        };
    }
    context.emit({
        kind: "expression",
        code: `if (!(${present})) std::rethrow_exception(bbl::js::make_error("TypeError", "Cannot call requestAdapter on an absent GPU owner"));`,
    });
    return compileRequest(lowerer, call);
}

function compileRequest(lowerer: DataLowerer, call: ts.CallExpression): Value {
    const context = lowerer.context;
    context.expectArgumentCount(call, 0, 1);
    const options = call.arguments[0];
    let argumentsCpp = "";
    if (options) {
        let powerPreference = "bbl::js::Nullable<std::string>{}";
        let featureLevel = powerPreference;
        const text = (value: Value, present?: string): string => {
            const type = {
                kind: "optional",
                inner: { kind: "string" },
            } as const;
            const converted = lowerer.compileKnownValueForSink(
                value,
                type,
                options,
            );
            const stored = context.allocateTemporaryCppName("gpu_option");
            context.emit({
                kind: "declaration",
                type: "const bbl::js::Nullable<std::string>",
                name: stored,
                initializer: present
                    ? `${present} ? ${converted} : bbl::js::Nullable<std::string>{}`
                    : converted,
            });
            return stored;
        };
        const flags = compileBooleanOptions(
            context,
            lowerer,
            options,
            ["forceFallbackAdapter", "xrCompatible"] as const,
            {
                subject: "GPU adapter options",
                member: "GPU adapter option",
                forms: "a represented options record",
                temporary: "gpu_option",
                consume: {
                    powerPreference: (value, present) => {
                        powerPreference = text(value, present);
                    },
                    featureLevel: (value, present) => {
                        featureLevel = text(value, present);
                    },
                },
            },
        );
        argumentsCpp = `${powerPreference}, ${flags.forceFallbackAdapter ?? "false"}, ${featureLevel}, ${flags.xrCompatible ?? "false"}`;
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
