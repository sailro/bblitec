import { EmissionSet } from "./emission-transaction.js";
import ts from "typescript";
import type { NativeHostUi } from "./types.js";
import { nativeHostUiStyleRules } from "../ui-style-rule.js";
import {
    accessedPropertySymbol,
    declarationInDefaultLibrary,
    declaredInDomLibrary,
    libraryGlobal,
    resolvedSymbol,
} from "./symbols.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    stringLiteralText,
    unwrapExpression,
} from "./syntax.js";

type ReportingValue =
    | "primitive"
    | "error"
    | "printable"
    | "input"
    | "element"
    | "canvas"
    | "style"
    | "dataset"
    | "document"
    | "body"
    | "console"
    | "reporter";

/** A reporter may format its input and build confined diagnostic DOM. No
 * application object, callback, or host service can escape through that DOM. */
export function hasOnlyReportingEffects(
    checker: ts.TypeChecker,
    handler: ts.Expression,
    options: {
        ownedRejection: boolean;
        allowReportingDom: boolean;
        isUnobservedWrite: (expression: ts.Expression) => boolean;
    },
): boolean {
    const root = unwrapExpression(handler);
    const fn =
        ts.isArrowFunction(root) || ts.isFunctionExpression(root)
            ? root
            : undefined;
    if (
        fn?.parameters.some(
            (parameter) =>
                !ts.isIdentifier(parameter.name) ||
                parameter.initializer ||
                parameter.dotDotDotToken,
        )
    )
        return false;
    if (
        fn &&
        !checker
            .getTypeAtLocation(fn)
            .getCallSignatures()
            .every(
                (signature) =>
                    (checker.getReturnTypeOfSignature(signature).flags &
                        (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !==
                    0,
            )
    )
        return false;
    const locals = new Map<ts.Symbol, ReportingValue>();
    let reported = false;
    const alternatives = <T>(left: () => T, right: () => T): [T, T] => {
        const before = reported;
        const leftValue = left(),
            leftReports = reported;
        reported = before;
        const rightValue = right();
        reported = leftReports && reported;
        return [leftValue, rightValue];
    };
    for (const [index, parameter] of (fn?.parameters ?? []).entries()) {
        const symbol = resolvedSymbol(checker, parameter.name);
        if (!symbol) return false;
        locals.set(
            symbol,
            index === 0 && options.ownedRejection ? "error" : "input",
        );
    }
    const primitive = (expression: ts.Expression): boolean => {
        const type = checker.getTypeAtLocation(expression);
        return (type.isUnion() ? type.types : [type]).every(
            (member) =>
                (member.flags &
                    (ts.TypeFlags.StringLike |
                        ts.TypeFlags.NumberLike |
                        ts.TypeFlags.BooleanLike |
                        ts.TypeFlags.BigIntLike |
                        ts.TypeFlags.Null |
                        ts.TypeFlags.Undefined |
                        ts.TypeFlags.Void)) !==
                0,
        );
    };
    const printable = (value: ReportingValue | undefined): boolean =>
        value === "primitive" || value === "error" || value === "printable";
    const join = (
        left: ReportingValue | undefined,
        right: ReportingValue | undefined,
    ): ReportingValue | undefined =>
        !left || !right
            ? undefined
            : left === right
              ? left
              : printable(left) && printable(right)
                ? "printable"
                : undefined;
    const property = (
        node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    ): string | undefined => {
        if (ts.isPropertyAccessExpression(node)) return node.name.text;
        if (value(node.argumentExpression) !== "primitive") return undefined;
        const key = checker.getTypeAtLocation(node.argumentExpression);
        return key.isStringLiteral() ? key.value : undefined;
    };
    const libraryCall = (call: ts.CallExpression): boolean => {
        const declaration = checker.getResolvedSignature(call)?.declaration;
        return (
            declaration !== undefined &&
            declarationInDefaultLibrary(declaration)
        );
    };
    const value = (expression: ts.Expression): ReportingValue | undefined => {
        const node = unwrapExpression(expression);
        if (ts.isIdentifier(node)) {
            const global = libraryGlobal(checker, node);
            if (global === "console" || global === "document") return global;
            const symbol = resolvedSymbol(checker, node);
            const local = symbol && locals.get(symbol);
            if (local) return local;
            if (global === "undefined" || primitive(node)) return "primitive";
            return undefined;
        }
        if (
            ts.isStringLiteralLike(node) ||
            ts.isNumericLiteral(node) ||
            ts.isBigIntLiteral(node) ||
            node.kind === ts.SyntaxKind.TrueKeyword ||
            node.kind === ts.SyntaxKind.FalseKeyword ||
            node.kind === ts.SyntaxKind.NullKeyword
        )
            return "primitive";
        if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            const name = property(node);
            if (!name) return undefined;
            const member = accessedPropertySymbol(checker, node);
            if (
                member?.declarations?.some(
                    (declaration) =>
                        !declarationInDefaultLibrary(declaration) &&
                        (ts.isGetAccessorDeclaration(declaration) ||
                            ts.isSetAccessorDeclaration(declaration)),
                )
            )
                return undefined;
            const owner = value(node.expression);
            if (
                owner === "console" &&
                member?.declarations?.every(declarationInDefaultLibrary)
            ) {
                const signatures = checker
                    .getTypeAtLocation(node)
                    .getCallSignatures();
                if (
                    signatures.length &&
                    signatures.every(
                        (signature) =>
                            (checker.getReturnTypeOfSignature(signature).flags &
                                ts.TypeFlags.Void) !==
                            0,
                    )
                )
                    return "reporter";
            }
            if (owner === "document" && name === "body") return "body";
            if (
                owner === "error" &&
                ["message", "stack", "name"].includes(name)
            )
                return "primitive";
            if (owner === "element" && name === "style") return "style";
            if (
                (owner === "element" || owner === "canvas") &&
                name === "dataset"
            )
                return "dataset";
            if (
                owner === "element" &&
                ["textContent", "innerText", "className", "id"].includes(name)
            )
                return "primitive";
            if (owner === "style" || owner === "dataset") return "primitive";
            return undefined;
        }
        if (ts.isCallExpression(node)) {
            if (!libraryCall(node)) return undefined;
            const callee = unwrapExpression(node.expression);
            const global = libraryGlobal(checker, callee);
            if (
                ["String", "Number", "Boolean"].includes(global ?? "") &&
                node.arguments.length <= 1 &&
                node.arguments.every((argument) => printable(value(argument)))
            )
                return "primitive";
            if (
                ts.isPropertyAccessExpression(callee) ||
                ts.isElementAccessExpression(callee)
            ) {
                const owner = value(callee.expression),
                    name = property(callee);
                if (
                    value(callee) === "reporter" &&
                    node.arguments.every((argument) => {
                        const input = value(argument);
                        return printable(input) || input === "input";
                    })
                ) {
                    reported = true;
                    return "primitive";
                }
                if (
                    owner === "document" &&
                    name === "getElementById" &&
                    node.arguments.length === 1 &&
                    value(node.arguments[0]!) === "primitive"
                ) {
                    const type = checker.getNonNullableType(
                        checker.getTypeAtLocation(expression),
                    );
                    const symbol = type.getSymbol();
                    if (
                        symbol?.getName() === "HTMLCanvasElement" &&
                        declaredInDomLibrary(symbol)
                    )
                        return "canvas";
                }
                if (
                    options.allowReportingDom &&
                    owner === "document" &&
                    name === "createElement" &&
                    node.arguments.length === 1 &&
                    ts.isStringLiteralLike(node.arguments[0]!) &&
                    ["pre", "div", "span", "p", "code", "section"].includes(
                        node.arguments[0].text,
                    )
                )
                    return "element";
                if (
                    options.allowReportingDom &&
                    (owner === "body" || owner === "element") &&
                    (name === "appendChild" || name === "append") &&
                    node.arguments.length > 0 &&
                    (name !== "appendChild" || node.arguments.length === 1) &&
                    node.arguments.every(
                        (argument) => value(argument) === "element",
                    )
                ) {
                    reported = true;
                    return name === "appendChild" ? "element" : "primitive";
                }
            }
            return undefined;
        }
        if (ts.isConditionalExpression(node)) {
            if (!value(node.condition)) return undefined;
            const [yes, no] = alternatives(
                () => value(node.whenTrue),
                () => value(node.whenFalse),
            );
            return join(yes, no);
        }
        if (ts.isTemplateExpression(node))
            return node.templateSpans.every((span) =>
                printable(value(span.expression)),
            )
                ? "primitive"
                : undefined;
        if (ts.isBinaryExpression(node)) {
            if (
                isAssignmentExpression(node) ||
                node.operatorToken.kind === ts.SyntaxKind.InKeyword
            )
                return undefined;
            const left = value(node.left);
            if (node.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
                return left === "error" &&
                    libraryGlobal(checker, unwrapExpression(node.right)) ===
                        "Error"
                    ? "primitive"
                    : undefined;
            const beforeRight = reported;
            const right = value(node.right);
            if (
                [
                    ts.SyntaxKind.AmpersandAmpersandToken,
                    ts.SyntaxKind.BarBarToken,
                    ts.SyntaxKind.QuestionQuestionToken,
                ].includes(node.operatorToken.kind)
            ) {
                reported = beforeRight;
                return join(left, right);
            }
            return printable(left) && printable(right)
                ? "primitive"
                : undefined;
        }
        if (ts.isPrefixUnaryExpression(node)) {
            if (isUpdateExpression(node)) return undefined;
            const operand = value(node.operand);
            return operand &&
                (node.operator === ts.SyntaxKind.ExclamationToken ||
                    printable(operand))
                ? "primitive"
                : undefined;
        }
        if (ts.isTypeOfExpression(node) || ts.isVoidExpression(node))
            return value(node.expression) ? "primitive" : undefined;
        return undefined;
    };
    const write = (expression: ts.BinaryExpression): boolean => {
        if (
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !printable(value(expression.right))
        )
            return false;
        const left = unwrapExpression(expression.left);
        if (
            !ts.isPropertyAccessExpression(left) &&
            !ts.isElementAccessExpression(left)
        )
            return false;
        const name = property(left);
        if (!name) return false;
        const owner = value(left.expression);
        const safe =
            owner === "dataset"
                ? options.allowReportingDom || options.isUnobservedWrite(left)
                : options.allowReportingDom &&
                  (owner === "style" ||
                      (owner === "element" &&
                          [
                              "textContent",
                              "innerText",
                              "className",
                              "id",
                          ].includes(name)));
        if (safe) reported = true;
        return safe;
    };
    const statement = (node: ts.Statement): boolean => {
        if (ts.isBlock(node)) return node.statements.every(statement);
        if (ts.isVariableStatement(node)) {
            if ((node.declarationList.flags & ts.NodeFlags.Const) === 0)
                return false;
            return node.declarationList.declarations.every((declaration) => {
                if (
                    !ts.isIdentifier(declaration.name) ||
                    !declaration.initializer
                )
                    return false;
                const symbol = resolvedSymbol(checker, declaration.name);
                const initial = value(declaration.initializer);
                if (!symbol || !initial) return false;
                locals.set(symbol, initial);
                return true;
            });
        }
        if (ts.isIfStatement(node)) {
            if (!value(node.expression)) return false;
            const [yes, no] = alternatives(
                () => statement(node.thenStatement),
                () => !node.elseStatement || statement(node.elseStatement),
            );
            return yes && no;
        }
        if (ts.isExpressionStatement(node)) {
            const expression = unwrapExpression(node.expression);
            return ts.isBinaryExpression(expression) &&
                isAssignmentExpression(expression)
                ? write(expression)
                : value(expression) !== undefined;
        }
        return ts.isEmptyStatement(node);
    };
    if (!fn) return value(root) === "reporter";
    const safe = ts.isBlock(fn.body)
        ? statement(fn.body)
        : value(fn.body) !== undefined;
    return safe && reported;
}

const metadataReaders = new Set([
    "getAttribute",
    "hasAttribute",
    "getAttributeNS",
    "hasAttributeNS",
    "getAttributeNames",
    "querySelector",
    "querySelectorAll",
    "matches",
    "closest",
]);
const styleTextProperties = new Set(["textContent", "innerText", "innerHTML"]);
const stylesheetMethods = new Set([
    "insertRule",
    "replace",
    "replaceSync",
    "addRule",
]);

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
    sourceFiles: readonly ts.SourceFile[],
    call: ts.CallExpression,
    argumentIndex: number,
    host: NativeHostUi | undefined,
): boolean {
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
    const hostText = host
        ? JSON.stringify([
              host.elements,
              nativeHostUiStyleRules(host),
              host.styleSheets,
          ])
        : "";
    if (attributes.some((name) => hostText.includes(name))) return false;
    const hasDomType = (expression: ts.Expression, name: string): boolean => {
        const owner = checker
            .getNonNullableType(checker.getTypeAtLocation(expression))
            .getSymbol();
        return owner?.name === name && declaredInDomLibrary(owner);
    };
    const observes = (node: ts.Node): boolean => {
        if (node === declaration) return false;
        if (ts.isTypeNode(node)) return false;
        if (
            ts.isElementAccessExpression(node) ||
            (ts.isPropertyAccessExpression(node) &&
                (metadataReaders.has(node.name.text) ||
                    styleTextProperties.has(node.name.text) ||
                    stylesheetMethods.has(node.name.text)))
        ) {
            const member = resolvedSymbol(
                checker,
                ts.isElementAccessExpression(node)
                    ? node.argumentExpression
                    : node,
            );
            const write = node.parent;
            if (
                member &&
                declaredInDomLibrary(member) &&
                styleTextProperties.has(member.name) &&
                hasDomType(node.expression, "HTMLStyleElement") &&
                isAssignmentExpression(write) &&
                write.left === node &&
                (write.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                    stringLiteralText(unwrapExpression(write.right)) ===
                        undefined)
            )
                return true;
            if (
                member &&
                declaredInDomLibrary(member) &&
                (metadataReaders.has(member.name) ||
                    (stylesheetMethods.has(member.name) &&
                        hasDomType(node.expression, "CSSStyleSheet")))
            ) {
                const call = node.parent;
                const argument =
                    ts.isCallExpression(call) && call.expression === node
                        ? call.arguments[member.name.endsWith("NS") ? 1 : 0]
                        : undefined;
                const literal = argument
                    ? stringLiteralText(unwrapExpression(argument))
                    : undefined;
                // An extracted reader or computed name may observe any metadata.
                if (
                    literal === undefined ||
                    attributes.some((name) =>
                        literal.toLowerCase().includes(name),
                    )
                )
                    return true;
            }
        }
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
            (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) &&
            attributes.some((name) => node.text.toLowerCase().includes(name))
        )
            return true;
        return ts.forEachChild(node, observes) ?? false;
    };
    return !sourceFiles.some(
        (file) => !file.isDeclarationFile && observes(file),
    );
}
