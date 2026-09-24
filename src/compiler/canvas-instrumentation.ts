import { EmissionSet } from "./emission-transaction.js";
import ts from "typescript";
import type { NativeHostUi } from "./types.js";
import { nativeHostUiStyleRules } from "../ui-style-rule.js";
import {
    declarationInDefaultLibrary,
    declaredInDomLibrary,
    libraryGlobal,
    resolvedSymbol,
} from "./symbols.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    unwrapExpression,
} from "./syntax.js";

/** Erasing a metadata writer also erases its closures. Prove their other
 * effects stay in fresh local state or browser instrumentation; a void result
 * says nothing about writes to captured application state. */
function hasOnlyInstrumentationEffects(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    declaration: ts.FunctionDeclaration,
    canvas: ts.Symbol,
): boolean {
    const roots = new Set<ts.Node>([declaration]);
    const inspecting = new Set<ts.Node>();
    const isLocal = (node: ts.Node): boolean => {
        for (
            let current: ts.Node | undefined = node;
            current;
            current = current.parent
        ) {
            if (roots.has(current)) return true;
        }
        return false;
    };
    const valueDeclaration = (node: ts.Node): ts.Declaration | undefined =>
        resolvedSymbol(checker, node)?.valueDeclaration;
    const isPrimitive = (expression: ts.Expression): boolean => {
        const type = checker.getTypeAtLocation(expression);
        const members = type.isUnion() ? type.types : [type];
        return members.every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.StringLike |
                        ts.TypeFlags.NumberLike |
                        ts.TypeFlags.BooleanLike |
                        ts.TypeFlags.BigIntLike |
                        ts.TypeFlags.ESSymbolLike |
                        ts.TypeFlags.Null |
                        ts.TypeFlags.Undefined |
                        ts.TypeFlags.Void)) !==
                0,
        );
    };
    const isBrowserType = (expression: ts.Expression): boolean => {
        const direct = checker.getTypeAtLocation(expression);
        const type = checker.getAwaitedType(direct) ?? direct;
        return (type.isUnion() ? type.types : [type]).every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !==
                    0 || declaredInDomLibrary(member.getSymbol()),
        );
    };
    const isFetch = (expression: ts.Expression): boolean =>
        libraryGlobal(checker, expression) === "fetch";
    const functions = (
        node: ts.Node | undefined,
    ): ts.FunctionLikeDeclaration | undefined => {
        if (!node) return undefined;
        if (
            ts.isFunctionDeclaration(node) ||
            ts.isFunctionExpression(node) ||
            ts.isArrowFunction(node) ||
            ts.isMethodDeclaration(node)
        )
            return node;
        if (ts.isVariableDeclaration(node) && node.initializer)
            return functions(unwrapExpression(node.initializer));
        return undefined;
    };
    // Objects must originate here, rather than merely have a local alias.
    // Mutable aliases are conservatively retained because their initializer
    // does not prove what object a later write will reach.
    const confined = (
        expression: ts.Expression,
        seen = new Set<ts.Node>(),
    ): boolean => {
        const value = unwrapExpression(expression, { await: true });
        if (isPrimitive(value) || isFetch(value)) return true;
        if (seen.has(value)) return false;
        seen.add(value);
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
            return prove(value);
        if (ts.isObjectLiteralExpression(value))
            return value.properties.every((property) => {
                if (ts.isPropertyAssignment(property))
                    return confined(property.initializer, new Set(seen));
                if (ts.isShorthandPropertyAssignment(property)) {
                    const target = valueDeclaration(property.name);
                    return (
                        target !== undefined &&
                        ts.isVariableDeclaration(target) &&
                        target.initializer !== undefined &&
                        isLocal(target) &&
                        confined(target.initializer, new Set(seen))
                    );
                }
                return ts.isMethodDeclaration(property) && prove(property);
            });
        if (ts.isArrayLiteralExpression(value))
            return value.elements.every((element) =>
                confined(element, new Set(seen)),
            );
        if (ts.isIdentifier(value)) {
            const target = valueDeclaration(value);
            const fn = functions(target);
            if (fn) return prove(fn);
            if (!target || !isLocal(target)) return false;
            if (ts.isParameter(target)) return isBrowserType(value);
            return (
                ts.isVariableDeclaration(target) &&
                target.initializer !== undefined &&
                ts.isVariableDeclarationList(target.parent) &&
                (target.parent.flags & ts.NodeFlags.Const) !== 0 &&
                confined(target.initializer, seen)
            );
        }
        if (ts.isCallExpression(value) || ts.isNewExpression(value)) {
            return (
                safeCall(value) &&
                (isBrowserType(value) || isFetchBinding(value))
            );
        }
        // Library-owned browser properties (response.headers/body, for
        // example) stay in the same browser realm as their proven owner.
        return (
            ts.isPropertyAccessExpression(value) &&
            isBrowserType(value.expression) &&
            confined(value.expression, seen)
        );
    };
    const isFetchBinding = (
        call: ts.CallExpression | ts.NewExpression,
    ): boolean => {
        const callee = unwrapExpression(call.expression);
        return (
            ts.isCallExpression(call) &&
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "bind" &&
            isFetch(callee.expression) &&
            call.arguments.length === 1 &&
            ts.isIdentifier(call.arguments[0]!) &&
            libraryGlobal(checker, call.arguments[0]) === "globalThis"
        );
    };
    const safeCall = (call: ts.CallExpression | ts.NewExpression): boolean => {
        if (isFetchBinding(call)) return true;
        const signature = checker.getResolvedSignature(call)?.declaration;
        if (!signature) return false;
        const fn = functions(signature);
        if (fn?.body) return prove(fn);
        const callee = unwrapExpression(call.expression);
        if (ts.isIdentifier(callee)) {
            const target = valueDeclaration(callee);
            if (
                target &&
                ts.isVariableDeclaration(target) &&
                isLocal(target) &&
                target.initializer
            ) {
                const initializer = unwrapExpression(target.initializer);
                if (
                    ts.isCallExpression(initializer) &&
                    isFetchBinding(initializer)
                )
                    return true;
            }
        }
        if (!declarationInDefaultLibrary(signature)) return false;
        if (isFetch(callee)) return true;
        if (ts.isIdentifier(callee))
            return (
                (call.arguments ?? []).every((argument) =>
                    confined(argument),
                ) &&
                [
                    "String",
                    "Number",
                    "requestAnimationFrame",
                    "cancelAnimationFrame",
                    "setTimeout",
                    "clearTimeout",
                    "ReadableStream",
                    "Response",
                ].includes(libraryGlobal(checker, callee) ?? "")
            );
        if (!ts.isPropertyAccessExpression(callee)) return false;
        const receiver = unwrapExpression(callee.expression);
        if (isBrowserType(receiver) && confined(receiver)) {
            return (call.arguments ?? []).every(
                (argument) =>
                    checker.getTypeAtLocation(argument).getCallSignatures()
                        .length === 0 || confined(argument),
            );
        }
        return (
            (call.arguments ?? []).every((argument) => confined(argument)) &&
            (isPrimitive(receiver) ||
                confined(receiver) ||
                libraryGlobal(checker, receiver) === "Math")
        );
    };
    const safeWrite = (expression: ts.Expression): boolean => {
        const value = unwrapExpression(expression);
        if (ts.isIdentifier(value)) {
            const target = valueDeclaration(value);
            return target !== undefined && isLocal(target);
        }
        if (isFetch(value)) return true;
        if (
            ts.isPropertyAccessExpression(value) ||
            ts.isElementAccessExpression(value)
        ) {
            const owner = value.expression;
            if (
                ts.isPropertyAccessExpression(owner) &&
                owner.name.text === "dataset" &&
                resolvedSymbol(checker, owner.expression) === canvas
            )
                return true;
            return confined(owner);
        }
        return false;
    };
    const visit = (node: ts.Node): boolean => {
        if (ts.isTypeNode(node)) return true;
        if (isAssignmentExpression(node) && !safeWrite(node.left)) return false;
        if (
            isAssignmentExpression(node) &&
            isFetch(node.left) &&
            !confined(node.right)
        )
            return false;
        if (isUpdateExpression(node) && !safeWrite(node.operand)) return false;
        if (ts.isDeleteExpression(node) && !safeWrite(node.expression))
            return false;
        if (
            (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
            !safeCall(node)
        )
            return false;
        // Accessors and dynamic dispatch can hide arbitrary native effects.
        if (ts.isPropertyAccessExpression(node)) {
            const target = valueDeclaration(node);
            if (
                target &&
                (ts.isGetAccessorDeclaration(target) ||
                    ts.isSetAccessorDeclaration(target))
            )
                return false;
        }
        if (ts.isElementAccessExpression(node) && !confined(node.expression))
            return false;
        if (ts.isForOfStatement(node) && !confined(node.expression))
            return false;
        if (
            (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) &&
            !confined(node.expression)
        )
            return false;
        if (
            ts.isThrowStatement(node) ||
            ts.isTaggedTemplateExpression(node) ||
            ts.isYieldExpression(node)
        )
            return false;
        return (
            ts.forEachChild(node, (child) => !visit(child) || undefined) !==
            true
        );
    };
    const prove = (fn: ts.FunctionLikeDeclaration): boolean => {
        if (!fn.body) return false;
        if (inspecting.has(fn)) return true;
        inspecting.add(fn);
        roots.add(fn);
        const result = visit(fn.body);
        inspecting.delete(fn);
        roots.delete(fn);
        return result;
    };
    return prove(declaration) && call.arguments.every(visit);
}

/** A packaged-asset progress helper may write canvas metadata that the retained
 * page never reads. Retained controls, layout, and observed metadata stay live. */
export function writesUnobservedCanvasMetadata(
    checker: ts.TypeChecker,
    program: ts.Program,
    call: ts.CallExpression,
    argumentIndex: number,
    host: NativeHostUi | undefined,
): boolean {
    if (!host) return false;
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (
        !declaration ||
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.body
    )
        return false;
    const parameter = declaration.parameters[argumentIndex];
    if (!parameter || !ts.isIdentifier(parameter.name)) return false;
    const symbol = resolvedSymbol(checker, parameter.name);
    if (
        !symbol ||
        !hasOnlyInstrumentationEffects(checker, call, declaration, symbol)
    )
        return false;
    const fields = new EmissionSet<string>();
    let valid = true;
    const visit = (node: ts.Node): void => {
        if (!valid || ts.isTypeNode(node)) return;
        // A shorthand `{ canvas }` names the parameter too: resolved as a
        // value, it is a use that is not a dataset write.
        if (ts.isIdentifier(node) && resolvedSymbol(checker, node) === symbol) {
            const dataset = node.parent;
            const field = dataset.parent;
            if (
                !ts.isPropertyAccessExpression(dataset) ||
                dataset.expression !== node ||
                dataset.name.text !== "dataset" ||
                !ts.isPropertyAccessExpression(field) ||
                field.expression !== dataset
            ) {
                valid = false;
                return;
            }
            const write = field.parent;
            if (
                !(
                    ts.isBinaryExpression(write) &&
                    write.left === field &&
                    write.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ) &&
                !(ts.isDeleteExpression(write) && write.expression === field)
            ) {
                valid = false;
                return;
            }
            fields.add(field.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration.body);
    if (!valid || fields.size === 0) return false;
    const attributes = [...fields].map(
        (name) =>
            `data-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
    );
    // A selector, declared attribute, or any external source read can observe
    // the metadata. Dynamic property reads conservatively retain the helper.
    const hostText = JSON.stringify([
        host.elements,
        nativeHostUiStyleRules(host),
    ]);
    if (attributes.some((name) => hostText.includes(name))) return false;
    const observes = (node: ts.Node): boolean => {
        if (node === declaration) return false;
        if (ts.isTypeNode(node)) return false;
        if (ts.isElementAccessExpression(node)) {
            const map = checker.getTypeAtLocation(node.expression).getSymbol();
            if (map?.name === "DOMStringMap" && declaredInDomLibrary(map))
                return true;
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            node.name.text === "dataset" &&
            !(
                ts.isPropertyAccessExpression(node.parent) &&
                node.parent.expression === node
            )
        )
            return true;
        if (ts.isPropertyAccessExpression(node) && fields.has(node.name.text))
            return true;
        if (
            ts.isStringLiteralLike(node) &&
            attributes.some((name) => node.text.includes(name))
        )
            return true;
        return ts.forEachChild(node, observes) ?? false;
    };
    return !program
        .getSourceFiles()
        .some((file) => !file.isDeclarationFile && observes(file));
}
