import type ts from "typescript";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { isTypedArrayType, type DataType } from "../data-types.js";
import { argumentAt } from "../syntax.js";
import {
    retainedOptions,
    emitPresentOption,
    emitScalarOption,
    type RetainedOptionsContext,
} from "./retained-options.js";

export interface StorageBufferIntrinsicContext
    extends
        RetainedOptionsContext,
        Pick<
            LoweringServices,
            | "expectArgumentCount"
            | "compileValue"
            | "expectKind"
            | "requireDefaultEngine"
            | "reachFeature"
            | "allocateTemporaryCppName"
        > {}

export function isGpuBufferSourceType(type: DataType | undefined): boolean {
    return (
        type?.kind === "number" ||
        type?.kind === "bufferview" ||
        type?.kind === "dataview" ||
        isTypedArrayType(type) ||
        (type?.kind === "union" && type.members.every(isGpuBufferSourceType))
    );
}

export function compileCreateStorageBuffer(
    context: StorageBufferIntrinsicContext,
    call: ts.CallExpression,
): Value {
    context.expectArgumentCount(call, 2, 3);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const sourceExpression = argumentAt(call, 1);
    const data = context.compileValue(sourceExpression);
    const numeric = data.kind === "number" || data.dataType?.kind === "number";
    if (!numeric && !isGpuBufferSourceType(data.dataType))
        return context.fail(
            sourceExpression,
            "createStorageBuffer requires an ArrayBuffer view or numeric byte length.",
        );
    const source = context.pinValueToTemporary(
        data,
        "storage_source",
        sourceExpression,
    );
    const optionsExpression = call.arguments[2];
    const options = optionsExpression
        ? context.compileValue(optionsExpression)
        : undefined;
    const record =
        options?.kind === "record" ||
        options?.dataType?.kind === "struct" ||
        options?.dataType?.kind === "optional" ||
        options?.dataType?.kind === "union";
    context.reachFeature("material:shader-storage", call);
    if (!numeric && isTypedArrayType(data.dataType) && !record) {
        if (
            options &&
            options.kind !== "json-null" &&
            options.kind !== "void" &&
            options.kind !== "string" &&
            options.dataType?.kind !== "string"
        )
            return context.fail(
                optionsExpression!,
                "Storage label requires a string or options record.",
            );
        const label =
            options && options.kind !== "void" && options.kind !== "json-null"
                ? options.cpp
                : '""';
        const engineCpp = context.requireDefaultEngine(call);
        return {
            kind: "storage-buffer",
            cpp: `bbl::create_storage_buffer(${engineCpp}, ${source.cpp}, ${label})`,
            engineCpp,
        };
    }
    context.reachFeature("compute:storage-buffer", call);
    if (!engine.ownedEngineCpp)
        return context.fail(
            call,
            "GPU storage allocations require a realm-owned engine.",
        );
    const target = context.allocateTemporaryCppName("storage_options");
    context.emit(`bbl::StorageBufferOptions ${target};`);
    const writeOptions = (value: Value): void => {
        if (value.kind === "json-null" || value.kind === "void") return;
        if (value.kind === "data" && value.dataType?.kind === "optional") {
            const owner = context.pinValueToTemporary(
                value,
                "storage_options_owner",
                optionsExpression,
            );
            context.emit(`if (${owner.cpp}.has_value()) {`);
            writeOptions({
                kind: "data",
                cpp: `${owner.cpp}.value()`,
                dataType: value.dataType.inner,
            });
            context.emit("}");
            return;
        }
        if (value.kind === "data" && value.dataType?.kind === "union") {
            const owner = context.pinValueToTemporary(
                value,
                "storage_options_union",
                optionsExpression,
            );
            value.dataType.members.forEach((type, index) => {
                context.emit(
                    `${index ? "else " : ""}if (${owner.cpp}.index() == ${index}) {`,
                );
                writeOptions({
                    kind: "data",
                    cpp: `std::get<${index}>(${owner.cpp})`,
                    dataType: type,
                });
                context.emit("}");
            });
            return;
        }
        if (value.kind === "string" || value.dataType?.kind === "string") {
            context.emit(`${target}.label = ${value.cpp};`);
            return;
        }
        for (const member of retainedOptions(
            context,
            value,
            optionsExpression!,
        )) {
            if (
                member.value?.kind === "json-null" ||
                member.value?.kind === "void"
            )
                continue;
            if (
                !["label", "writable", "vertex", "index", "indirect"].includes(
                    member.name,
                )
            )
                context.fail(
                    optionsExpression!,
                    `Unrepresented storage option: ${member.name}.`,
                );
            emitPresentOption(context, member, (field) =>
                emitScalarOption(
                    context,
                    field,
                    field.name === "label" ? "string" : "boolean",
                    `${target}.${field.name}`,
                    optionsExpression!,
                ),
            );
        }
    };
    if (options) writeOptions(options);
    return {
        kind: "storage-buffer",
        cpp: `bbl::create_gpu_storage_buffer(${engine.ownedEngineCpp}, bbl::storage_buffer_source(${source.cpp}), std::move(${target}))`,
        engineCpp: engine.cpp,
    };
}
