import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import { optionalPresentCpp, type Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { argumentAt } from "../syntax.js";
import { isGpuBufferSourceType } from "./storage-buffer.js";
import {
    retainedOptions,
    emitPresentOption,
    emitScalarOption,
    type RetainedOptionsContext,
} from "./retained-options.js";

export interface UniformBufferIntrinsicContext
    extends
        IntrinsicCallContext,
        RetainedOptionsContext,
        Pick<LoweringServices, "allocateTemporaryCppName" | "compileNumber"> {}

export function compileUniformBufferIntrinsic(
    context: UniformBufferIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (
        ![
            "createUniformBuffer",
            "updateUniformBuffer",
            "disposeUniformBuffer",
        ].includes(name)
    )
        return undefined;
    if (name === "disposeUniformBuffer") {
        context.expectArgumentCount(call, 1, 1);
        const buffer = context.compileValue(argumentAt(call, 0));
        context.expectKind(buffer, "uniform-buffer", call);
        return {
            kind: "void",
            cpp: `bbl::dispose_uniform_buffer(${buffer.cpp})`,
        };
    }
    const create = name === "createUniformBuffer";
    context.expectArgumentCount(call, create ? 2 : 3, create ? 3 : 4);
    context.reachFeature("compute:uniform-buffer", call);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", call);
    if (!engine.ownedEngineCpp)
        return context.fail(
            call,
            "Uniform buffers require a realm-owned engine.",
        );
    const buffer = create
        ? undefined
        : context.compileValue(argumentAt(call, 1));
    if (buffer) context.expectKind(buffer, "uniform-buffer", call);
    const sourceExpression = argumentAt(call, create ? 1 : 2),
        value = context.compileValue(sourceExpression);
    const type =
        value.dataType ??
        (value.kind === "number" ? { kind: "number" as const } : undefined);
    if (
        !isGpuBufferSourceType(type) ||
        (!create && (type?.kind === "number" || type?.kind === "union"))
    )
        return context.fail(
            sourceExpression,
            create
                ? "Uniform buffer sources require numeric sizes or ArrayBuffer views."
                : "Uniform buffer updates require ArrayBuffer views.",
        );
    const source = context.bindings.pinValueToTemporary(
        value,
        "uniform_source",
        sourceExpression,
    );
    if (buffer) {
        const offset = call.arguments[3]
            ? context.compileNumber(call.arguments[3])
            : "0.0";
        return {
            kind: "void",
            cpp: `bbl::update_uniform_buffer(${engine.ownedEngineCpp}, ${buffer.cpp}, bbl::storage_buffer_source(${source.cpp}).bytes, ${offset})`,
        };
    }
    const label = compileUniformBufferLabel(context, call.arguments[2]);
    return {
        kind: "uniform-buffer",
        dataType: { kind: "handle", handle: "uniform-buffer" },
        engineCpp: engine.cpp,
        cpp: `bbl::create_uniform_buffer(${engine.ownedEngineCpp}, bbl::storage_buffer_source(${source.cpp}), ${label})`,
    };
}

export function compileUniformBufferLabel(
    context: UniformBufferIntrinsicContext,
    optionsExpression: ts.Expression | undefined,
): string {
    const label = context.allocateTemporaryCppName("uniform_label");
    context.emit(`std::optional<std::string> ${label};`);
    if (optionsExpression) {
        const write = (options: Value): void => {
            if (options.kind === "json-null" || options.kind === "void") return;
            if (options.dataType?.kind === "optional") {
                const retained = context.bindings.pinValueToTemporary(
                    options,
                    "uniform_options",
                    optionsExpression,
                );
                context.emit(`if (${optionalPresentCpp(retained.cpp)}) {`);
                write({
                    kind: "data",
                    dataType: options.dataType.inner,
                    cpp: `${retained.cpp}.value()`,
                });
                context.emit("}");
                return;
            }
            for (const member of retainedOptions(
                context,
                options,
                optionsExpression,
            )) {
                if (member.name !== "label")
                    context.fail(
                        optionsExpression,
                        `Unrepresented uniform buffer option ${member.name}.`,
                    );
                if (
                    member.value?.kind === "json-null" ||
                    member.value?.kind === "void"
                )
                    continue;
                emitPresentOption(context, member, (field) =>
                    emitScalarOption(
                        context,
                        field,
                        "string",
                        label,
                        optionsExpression,
                    ),
                );
            }
        };
        write(context.compileValue(optionsExpression));
    }
    return label;
}
