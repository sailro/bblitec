import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { callMember, type DataType } from "./data-types.js";
import { DynamicBindingStorageRequired } from "./dynamic-binding-storage.js";
import { unwrapExpression } from "./syntax.js";
import type { Value } from "./types.js";
import type { DataSinkHost } from "./data-sinks/contracts.js";

/** A function expression, or a call whose source returns only new functions. */
function freshCallable(
    checker: ts.TypeChecker,
    expression: ts.Expression,
    active = new Set<ts.Node>(),
): boolean {
    const source = unwrapExpression(expression);
    if (ts.isArrowFunction(source) || ts.isFunctionExpression(source))
        return true;
    if (ts.isConditionalExpression(source))
        return (
            freshCallable(checker, source.whenTrue, active) &&
            freshCallable(checker, source.whenFalse, active)
        );
    if (!ts.isCallExpression(source)) return false;
    const declaration = checker.getResolvedSignature(source)?.declaration;
    if (
        !declaration ||
        !(
            ts.isFunctionDeclaration(declaration) ||
            ts.isArrowFunction(declaration) ||
            ts.isFunctionExpression(declaration) ||
            ts.isMethodDeclaration(declaration)
        ) ||
        !declaration.body ||
        active.has(declaration)
    )
        return false;
    active.add(declaration);
    try {
        if (!ts.isBlock(declaration.body))
            return freshCallable(checker, declaration.body, active);
        let returns = 0;
        let fresh = true;
        forEachAnalysisNode(
            declaration.body,
            (node) => {
                if (!ts.isReturnStatement(node)) return;
                returns++;
                fresh &&=
                    node.expression !== undefined &&
                    freshCallable(checker, node.expression, active);
            },
            { functions: "skip", types: "skip" },
        );
        return returns > 0 && fresh;
    } finally {
        active.delete(declaration);
    }
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
    if (!expression || !freshCallable(lowerer.context.checker, expression))
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
    return { ...lowerer.leafValue(cpp, type), freshData: true };
}
