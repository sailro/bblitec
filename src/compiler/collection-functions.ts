import ts from "typescript";
import type { DataLowerer } from "./data-lowering.js";
import { dataTypesEqual, type DataType } from "./data-types.js";
import { renderClosure } from "./closure-captures.js";
import { pinOperand } from "./evaluation-order.js";
import { declarationInDefaultLibrary, resolvedSymbol } from "./symbols.js";
import type { Value } from "./types.js";

/** A library collection method binds the supplied receiver, independently of its lookup owner. */
export function compileBoundCollectionMethod(
    lowerer: DataLowerer,
    call: ts.CallExpression,
    access: ts.Expression,
): Value | undefined {
    const context = lowerer.context;
    const method = context.unwrap(access);
    if (!ts.isPropertyAccessExpression(method)) return undefined;
    const declaration = resolvedSymbol(
        context.checker,
        method,
    )?.valueDeclaration;
    if (!declaration || !declarationInDefaultLibrary(declaration))
        return undefined;
    const ownerType = lowerer.dataTypeAt(method.expression);
    if (
        (ownerType?.kind !== "map" && ownerType?.kind !== "set") ||
        (ownerType.kind === "map" && (ownerType.weak || ownerType.dictionary))
    )
        return undefined;
    const name = method.name.text;
    const key = ownerType.kind === "map" ? ownerType.key : ownerType.element;
    let parameters: DataType[];
    let result: DataType | undefined;
    if (name === "has" || name === "delete") {
        parameters = [key];
        result = { kind: "boolean" };
    } else if (name === "clear") parameters = [];
    else if (name === "get" && ownerType.kind === "map") {
        parameters = [key];
        result = context.dataTypes.nullableType(ownerType.value);
    } else if (name === "set" && ownerType.kind === "map") {
        parameters = [key, ownerType.value];
        result = ownerType;
    } else if (name === "add" && ownerType.kind === "set") {
        parameters = [key];
        result = ownerType;
    } else return undefined;
    context.expectArgumentCount(call, 1, parameters.length + 1);
    context.emitDiscardedValue(context.compileValue(method.expression));
    const receiverExpression = call.arguments[0]!;
    const receiver = pinOperand(
        context,
        context.compileValue(receiverExpression),
        receiverExpression,
        "bound_collection",
    );
    if (!receiver.dataType || !dataTypesEqual(receiver.dataType, ownerType))
        context.fail(
            call,
            "A bound collection method requires matching owned receiver storage.",
        );
    if (name !== "get" && name !== "has") {
        lowerer.invalidateEscapingCollection(receiver);
        context.bindings.invalidateRecordProperties(receiver);
    }
    const prefix = call.arguments
        .slice(1)
        .map((argument, index) =>
            pinOperand(
                context,
                lowerer.leafValue(
                    lowerer.compileForRetainedSink(
                        argument,
                        parameters[index]!,
                        "Bound collection argument",
                    ),
                    parameters[index]!,
                ),
                argument,
                "bound_collection_argument",
            ),
        );
    const remaining = parameters.slice(prefix.length).map((type) => ({
        type,
        name: context.allocateTemporaryCppName("collection_argument"),
    }));
    const closure = context.captureManagedClosureLines(() => {
        context.useNativeValue(receiver);
        const values = [
            ...prefix,
            ...remaining.map(({ name, type }) => lowerer.leafValue(name, type)),
        ];
        const args = values.map((value, index) =>
            lowerer.compileKnownValueForSink(value, parameters[index]!, call),
        );
        const native =
            name === "delete" ? "erase" : name === "get" ? "get_owned" : name;
        const invocation = `${receiver.cpp}.${native}(${args.join(", ")})`;
        context.emit(result ? `return ${invocation};` : `${invocation};`);
    });
    const type: DataType<"function"> = {
        kind: "function",
        parameters: remaining.map(({ type }) => type),
        ...(result ? { result } : {}),
        identity: true,
    };
    context.reachJsData();
    return {
        ...lowerer.leafValue(
            `${context.dataTypes.cppType(type)}{${renderClosure(
                closure,
                remaining
                    .map(
                        ({ name, type }) =>
                            `${context.dataTypes.cppType(type)} ${name}`,
                    )
                    .join(", "),
                result ? context.dataTypes.cppType(result) : "void",
            )}}`,
            type,
        ),
        freshData: true,
    };
}
