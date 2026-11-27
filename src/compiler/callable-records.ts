import ts from "typescript";
import { returnsOnly } from "./fresh-records.js";
import { callMember, type DataType } from "./data-types.js";
import { DynamicBindingStorageRequired } from "./dynamic-binding-storage.js";
import { bindingReferences } from "./binding-references.js";
import {
    isOperandSelection,
    outermostWrapper,
    unwrapExpression,
    valueOperands,
} from "./syntax.js";
import type { Value } from "./types.js";
import type { DataSinkHost } from "./data-sinks/contracts.js";
import { calledFunction, resolvedSymbol } from "./symbols.js";

/** A function expression, or a call whose source returns only new functions. */
function freshCallable(
    checker: ts.TypeChecker,
    expression: ts.Expression,
    active = new Set<ts.Node>(),
): boolean {
    const source = unwrapExpression(expression);
    if (ts.isArrowFunction(source) || ts.isFunctionExpression(source))
        return true;
    if (isOperandSelection(source))
        return valueOperands(source).every((operand) =>
            freshCallable(checker, operand, active),
        );
    if (!ts.isCallExpression(source)) return false;
    const declaration = calledFunction(checker, source);
    return (
        declaration !== undefined &&
        returnsOnly(declaration, active, (returned) =>
            freshCallable(checker, returned, active),
        )
    );
}

/**
 * A parameter read only at `expression`, bound to a function expression
 * written as its argument in the call binding it
 * (`withHalo((ent) => draw(ent), halo)`): no binding but the parameter
 * holds that function object, so a record made at `expression` is it.
 */
function freshArgument(
    lowerer: DataSinkHost,
    value: Value,
    expression: ts.Expression,
): boolean {
    const { checker, program } = lowerer.context;
    const source = unwrapExpression(expression);
    const symbol = ts.isIdentifier(source)
        ? resolvedSymbol(checker, source)
        : undefined;
    const parameter = symbol?.valueDeclaration;
    const callback =
        value.kind === "callback" ? value.callbackDeclaration : undefined;
    if (
        !symbol ||
        !parameter ||
        !ts.isParameter(parameter) ||
        parameter.dotDotDotToken ||
        !callback ||
        !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    )
        return false;
    const argument = outermostWrapper(callback);
    const call = argument.parent;
    return (
        ts.isCallExpression(call) &&
        call.arguments[parameter.parent.parameters.indexOf(parameter)] ===
            argument &&
        calledFunction(checker, call) === parameter.parent &&
        bindingReferences(program, checker, symbol).every(
            (reference) => reference === source,
        )
    );
}

/**
 * A module's function declaration is one function object for the whole
 * run: its callable record is one carrier in entry storage, made at its
 * first conversion, which every alias and conversion shares with the
 * properties written on it.
 */
function functionObjectRecord(
    lowerer: DataSinkHost,
    value: Value,
    type: DataType<"struct">,
    call: DataType<"function">,
    declaration: ts.FunctionDeclaration,
    node: ts.Node,
): Value {
    const { context } = lowerer;
    if (
        !ts.isSourceFile(declaration.parent) &&
        !ts.isModuleBlock(declaration.parent)
    )
        context.fail(
            node,
            "A nested function declaration viewed as a callable record is a new object each time its scope runs, which one native carrier cannot follow.",
        );
    const cppType = context.dataTypes.cppType(type);
    const storage = context.entryStorage(
        declaration,
        "function_object",
        cppType,
    );
    if (storage.type !== cppType)
        context.fail(
            node,
            "A function declaration viewed as two callable record types has no one native object.",
        );
    const carrier = storage.binding.name;
    let callback = "";
    const lines = context.captureEmittedLines(() => {
        callback = lowerer.compileKnownValueForSink(value, call, node);
    });
    context.emit({
        kind: "expression",
        code:
            `if (!${carrier}) { ${carrier} = bbl::js::make_ref<bblscene::${type.name}Data>(); ` +
            `${lines.join("\n")} ${carrier}->${callMember} = ${callback}; }`,
    });
    return {
        ...lowerer.leafValue(carrier, type),
        nativeCaptures: [storage.binding],
    };
}

/** A function's properties live on one carrier shared by every lexical alias. */
export function callableRecordValue(
    lowerer: DataSinkHost,
    value: Value,
    type: DataType<"struct">,
    node: ts.Node,
    initializingProperties = false,
): Value | undefined {
    const call = lowerer.context.dataTypes.structCall(type.name);
    if (
        !call ||
        (value.kind !== "callback" && value.dataType?.kind !== "function")
    )
        return undefined;
    if (
        lowerer.context.dataTypes
            .structFields(type.name, node, "accessors")
            .some((field) =>
                ["name", "length", "prototype", "arguments", "caller"].includes(
                    field.sourceName,
                ),
            )
    )
        lowerer.context.fail(
            node,
            "Callable intrinsic properties require represented function metadata.",
        );
    const demand = lowerer.context.dataTypes.callableRecordDemand(type.name);
    if (!demand) return undefined;
    const expression = lowerer.convertedExpression(node);
    const initializer =
        expression &&
        ts.isVariableDeclaration(expression.parent) &&
        expression.parent.initializer === expression
            ? lowerer.context.dynamicBindings.get(expression.parent)
            : undefined;
    const initializingOwner =
        typeof initializer === "object" &&
        "callable" in initializer &&
        initializer.callable.identity === demand.identity;
    if (
        !initializingProperties &&
        !initializingOwner &&
        lowerer.context.checker
            .getPropertiesOfType(demand.type)
            .some(
                (property) => (property.flags & ts.SymbolFlags.Optional) === 0,
            )
    )
        lowerer.context.fail(
            node,
            "A bare callback does not supply the required properties of this callable record.",
        );
    const owner =
        value.kind === "callback" ? value.callbackDeclaration : undefined;
    if (owner && ts.isFunctionDeclaration(owner))
        return functionObjectRecord(lowerer, value, type, call, owner, node);
    const declaration =
        expression &&
        (value.kind === "callback"
            ? lowerer.context.bindings.callbackDeclaration(value, expression)
            : lowerer.context.bindings.variableDeclarationOf(value.cpp));
    if (declaration) {
        if (
            lowerer.context.dynamicBindings.has(declaration) &&
            lowerer.context.dynamicBindings.get(declaration) !== "callback"
        )
            lowerer.context.fail(
                node,
                "A callback's demanded callable record storage could not preserve its original object.",
            );
        throw new DynamicBindingStorageRequired(declaration, {
            callable: demand,
        });
    }
    if (
        !expression ||
        !(
            freshCallable(lowerer.context.checker, expression) ||
            freshArgument(lowerer, value, expression)
        )
    )
        lowerer.context.fail(
            node,
            "A callable structural view needs its original lexical function owner or a fresh function result.",
        );
    const cpp = lowerer.context.allocateTemporaryCppName("callable_record");
    lowerer.context.emit({
        kind: "declaration",
        type: "auto",
        name: cpp,
        initializer: `bbl::js::make_ref<bblscene::${type.name}Data>()`,
    });
    lowerer.context.emit({
        kind: "expression",
        code: `${cpp}->${callMember} = ${lowerer.compileKnownValueForSink(value, call, node)};`,
    });
    // A closure that reads the record later (a static list's element) captures it.
    const binding = lowerer.context.registerNativeConstBinding(cpp);
    return {
        ...lowerer.leafValue(cpp, type),
        freshData: true,
        nativeCaptures: [binding],
    };
}
