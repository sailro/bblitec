import ts from "typescript";
import {
    accessedPropertySymbol,
    declarationInDefaultLibrary,
    declaredSymbol,
    resolvedSymbol,
} from "./symbols.js";
import {
    isOperandSelection,
    propertyKey,
    unwrapExpression,
    valueOperands,
    arrayLiteralSlots,
    aliasKey,
    ANY_KEY,
    plainDataMembers,
    functionKind,
} from "./syntax.js";
import { typeCanCarryReference } from "./type-facts.js";
import { isSupportedFunction } from "./user-functions.js";

type Path = readonly string[];
interface SourceValue {
    readonly expression: ts.Expression;
    readonly bindings: ReadonlyMap<ts.Symbol, SourceValue>;
}

/**
 * Locate a selected object identity inside a closed concrete argument.
 * Scalar reads copy values. Fresh containers carry only their children;
 * shared composite bindings, opaque calls and recursive sources decline.
 * This proves reference separation, not the absence of evaluation effects.
 */
export function concreteArgumentIdentityPaths(
    checker: ts.TypeChecker,
    argument: ts.Expression,
    matchesSelectedReference: (expression: ts.Expression) => boolean,
    selectedRecordKeys?: ReadonlySet<string>,
): readonly Path[] | undefined {
    const active = new Set<ts.Node>();
    const scalar = (expression: ts.Expression): boolean =>
        !typeCanCarryReference(checker.getTypeAtLocation(expression));
    const scalarArray = (expression: ts.Expression): boolean => {
        const type = checker.getNonNullableType(
            checker.getTypeAtLocation(expression),
        );
        const element = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
        return (
            (checker.isArrayType(type) || checker.isTupleType(type)) &&
            element !== undefined &&
            !typeCanCarryReference(element)
        );
    };
    const scalarRecord = (expression: ts.Expression): boolean => {
        const node = unwrapExpression(expression);
        return (
            ts.isObjectLiteralExpression(node) &&
            (plainDataMembers(node)?.every((member) => scalar(member.value)) ??
                false)
        );
    };
    const excludesSelected = (
        type: ts.Type,
        activeTypes = new Set<ts.Type>(),
    ): boolean => {
        if (!typeCanCarryReference(type)) return true;
        if (!selectedRecordKeys || activeTypes.has(type)) return false;
        activeTypes.add(type);
        try {
            if (type.isUnion())
                return type.types.every((member) =>
                    excludesSelected(member, activeTypes),
                );
            if (
                (type.flags &
                    (ts.TypeFlags.Any |
                        ts.TypeFlags.Unknown |
                        ts.TypeFlags.TypeParameter)) !==
                    0 ||
                type.getCallSignatures().length > 0 ||
                type.getConstructSignatures().length > 0
            )
                return false;
            if (checker.isArrayType(type) || checker.isTupleType(type)) {
                const element = checker.getIndexTypeOfType(
                    type,
                    ts.IndexKind.Number,
                );
                return (
                    element !== undefined &&
                    excludesSelected(element, activeTypes)
                );
            }
            const properties = checker.getPropertiesOfType(type);
            // The selected identity is a closed plain scalar record. A
            // required own field absent from that record separates the
            // receiver, but its children still need independent proof.
            const different = properties.some(
                (property) =>
                    (property.flags & ts.SymbolFlags.Optional) === 0 &&
                    !selectedRecordKeys.has(property.name) &&
                    !Object.hasOwn(Object.prototype, property.name) &&
                    property.declarations?.some(
                        (declaration) =>
                            ts.isPropertySignature(declaration) ||
                            ts.isPropertyDeclaration(declaration) ||
                            ts.isPropertyAssignment(declaration),
                    ),
            );
            return (
                different &&
                checker.getIndexInfosOfType(type).length === 0 &&
                properties.every((property) =>
                    excludesSelected(
                        checker.getTypeOfSymbolAtLocation(property, argument),
                        activeTypes,
                    ),
                )
            );
        } finally {
            activeTypes.delete(type);
        }
    };
    const visit = (source: SourceValue): Path[] | undefined => {
        const node = unwrapExpression(source.expression);
        if (scalar(node)) return [];
        if (matchesSelectedReference(node)) return [[]];
        if (active.has(node)) return undefined;
        active.add(node);
        try {
            return inspect(node, source.bindings);
        } finally {
            active.delete(node);
        }
    };
    const inspect = (
        node: ts.Expression,
        bindings: ReadonlyMap<ts.Symbol, SourceValue>,
    ): Path[] | undefined => {
        const child = (expression: ts.Expression): Path[] | undefined =>
            visit({ expression, bindings });
        if (ts.isIdentifier(node)) {
            const symbol = resolvedSymbol(checker, node);
            const bound = symbol && bindings.get(symbol);
            if (bound) return visit(bound);
            const declaration = symbol?.valueDeclaration;
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                ts.isVariableDeclarationList(declaration.parent) &&
                (declaration.parent.flags & ts.NodeFlags.Const) !== 0
            ) {
                const initializer = unwrapExpression(declaration.initializer);
                // A fresh scalar record cannot hide another object. Other
                // shared containers can acquire reference-valued children.
                if (
                    scalarRecord(initializer) ||
                    scalarArray(initializer) ||
                    ts.isIdentifier(initializer)
                )
                    return child(initializer);
            }
            return scalarArray(node) ||
                excludesSelected(checker.getTypeAtLocation(node))
                ? []
                : undefined;
        }
        if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            const property = accessedPropertySymbol(checker, node);
            if (
                property?.declarations?.some(
                    (declaration) =>
                        ts.isGetAccessorDeclaration(declaration) ||
                        ts.isSetAccessorDeclaration(declaration),
                )
            )
                return undefined;
            return scalarArray(node) ||
                excludesSelected(checker.getTypeAtLocation(node))
                ? []
                : undefined;
        }
        if (isOperandSelection(node)) {
            const paths: Path[] = [];
            for (const operand of valueOperands(node)) {
                const found = child(operand);
                if (!found) return undefined;
                paths.push(...found);
            }
            return paths;
        }
        if (ts.isObjectLiteralExpression(node)) {
            const paths: Path[] = [];
            for (const property of node.properties) {
                if (ts.isSpreadAssignment(property)) {
                    const spread = child(property.expression);
                    // Copying an opaque selected object does not establish
                    // which of its own children might carry that identity.
                    if (!spread || spread.some((path) => path.length === 0))
                        return undefined;
                    paths.push(...spread);
                    continue;
                }
                if (
                    !ts.isPropertyAssignment(property) &&
                    !ts.isShorthandPropertyAssignment(property)
                )
                    return undefined;
                const key = propertyKey(property.name);
                if (key === undefined) return undefined;
                const member = child(
                    ts.isPropertyAssignment(property)
                        ? property.initializer
                        : property.name,
                );
                if (!member) return undefined;
                paths.push(...member.map((path) => [key, ...path]));
            }
            return paths;
        }
        if (ts.isArrayLiteralExpression(node)) {
            const paths: Path[] = [];
            for (const { element, index } of arrayLiteralSlots(node)) {
                if (ts.isOmittedExpression(element)) continue;
                if (ts.isSpreadElement(element)) {
                    const spread = child(element.expression);
                    if (!spread || spread.some((path) => path.length === 0))
                        return undefined;
                    paths.push(
                        ...spread.map((path) => [ANY_KEY, ...path.slice(1)]),
                    );
                } else {
                    const member = child(element);
                    if (!member) return undefined;
                    paths.push(
                        ...member.map((path) => [
                            aliasKey(
                                index === undefined ? undefined : String(index),
                            ),
                            ...path,
                        ]),
                    );
                }
            }
            return paths;
        }
        if (ts.isNewExpression(node)) {
            const declaration = checker.getResolvedSignature(node)?.declaration;
            return declaration &&
                declarationInDefaultLibrary(declaration) &&
                ts.isInterfaceDeclaration(declaration.parent) &&
                declaration.parent.name.text === "ArrayConstructor" &&
                (node.arguments?.every(scalar) ?? true)
                ? []
                : undefined;
        }
        if (!ts.isCallExpression(node)) return undefined;
        // A call's result can be disjoint from the selected identity even
        // when its body is opaque. Its evaluation effects are checked separately.
        if (
            scalarArray(node) ||
            excludesSelected(checker.getTypeAtLocation(node))
        )
            return [];
        const declaration = checker.getResolvedSignature(node)?.declaration;
        // Default-library scalar arrays cannot carry the selected record.
        // Resolve the declaration so an authored method with the same name
        // cannot acquire this rule.
        if (
            declaration &&
            declarationInDefaultLibrary(declaration) &&
            ts.isInterfaceDeclaration(declaration.parent) &&
            declaration.parent.name.text === "Array" &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "fill" &&
            node.arguments.every(scalar)
        ) {
            const receiver = child(node.expression.expression);
            return receiver?.length === 0 ? [] : undefined;
        }
        if (
            !isSupportedFunction(declaration) ||
            !declaration.body ||
            functionKind(declaration) !== "plain" ||
            active.has(declaration) ||
            node.arguments.some(ts.isSpreadElement) ||
            node.arguments.length > declaration.parameters.length
        )
            return undefined;
        const locals = new Map(bindings);
        for (let index = 0; index < declaration.parameters.length; index++) {
            const parameter = declaration.parameters[index]!;
            if (!ts.isIdentifier(parameter.name) || parameter.dotDotDotToken)
                return undefined;
            const symbol = declaredSymbol(checker, parameter.name);
            const actual = node.arguments[index];
            const expression = actual ?? parameter.initializer;
            if (!symbol || !expression) return undefined;
            const value = { expression, bindings: actual ? bindings : locals };
            if (visit(value) === undefined) return undefined;
            locals.set(symbol, value);
        }
        active.add(declaration);
        try {
            if (!ts.isBlock(declaration.body))
                return visit({
                    expression: declaration.body,
                    bindings: locals,
                });
            let returned: ts.Expression | undefined;
            for (const statement of declaration.body.statements) {
                if (returned) return undefined;
                if (ts.isReturnStatement(statement) && statement.expression) {
                    returned = statement.expression;
                    continue;
                }
                if (
                    !ts.isVariableStatement(statement) ||
                    (statement.declarationList.flags & ts.NodeFlags.Const) === 0
                )
                    return undefined;
                for (const local of statement.declarationList.declarations) {
                    if (!ts.isIdentifier(local.name) || !local.initializer)
                        return undefined;
                    const symbol = declaredSymbol(checker, local.name);
                    const value = {
                        expression: local.initializer,
                        bindings: locals,
                    };
                    if (!symbol || visit(value) === undefined) return undefined;
                    locals.set(symbol, value);
                }
            }
            return returned
                ? visit({ expression: returned, bindings: locals })
                : undefined;
        } finally {
            active.delete(declaration);
        }
    };
    return visit({ expression: argument, bindings: new Map() });
}
