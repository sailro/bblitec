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
    staticAccessKey,
    libraryName,
    calledDeclaration,
    memberAccessors,
    namedMember,
} from "./symbols.js";
import {
    choosesOperand,
    isAssignmentExpression,
    isUpdateExpression,
    operandYield,
    stringLiteralText,
    unwrapExpression,
    writeSites,
    writeSiteOf,
    positionalParameter,
    variableKind,
    isMemberAccess,
} from "./syntax.js";
import {
    undefinedOnly,
    presentMembers,
    isVoid,
    holdsOnly,
    typeCanCarryReference,
    callSignatures,
} from "./type-facts.js";

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
        !callSignatures(checker, checker.getTypeAtLocation(fn), "exact").every(
            (signature) =>
                undefinedOnly(checker.getReturnTypeOfSignature(signature)),
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
    // A symbol is not printable: concatenating one throws.
    const primitive = (expression: ts.Expression): boolean =>
        holdsOnly(checker.getTypeAtLocation(expression), [
            "string",
            "number",
            "boolean",
            "bigint",
            "null",
            "undefined",
            "void",
        ]);
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
        // A key that converts an object may run its toString.
        if (
            ts.isElementAccessExpression(node) &&
            value(node.argumentExpression) !== "primitive"
        )
            return undefined;
        return staticAccessKey(checker, node);
    };
    const libraryCall = (call: ts.CallExpression): boolean => {
        const declaration = calledDeclaration(checker, call);
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
                memberAccessors(checker, node, "either").some(
                    (declaration) => !declarationInDefaultLibrary(declaration),
                )
            )
                return undefined;
            const owner = value(node.expression);
            if (
                owner === "console" &&
                member?.declarations?.every(declarationInDefaultLibrary)
            ) {
                const signatures = callSignatures(
                    checker,
                    checker.getTypeAtLocation(node),
                    "exact",
                );
                if (
                    signatures.length &&
                    signatures.every((signature) =>
                        isVoid(checker.getReturnTypeOfSignature(signature)),
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
            const reportedBeforeCall = reported;
            if (!libraryCall(node)) return undefined;
            const callee = unwrapExpression(node.expression);
            const global = libraryGlobal(checker, callee);
            if (
                ["String", "Number", "Boolean"].includes(global ?? "") &&
                node.arguments.length <= 1 &&
                node.arguments.every((argument) => printable(value(argument)))
            )
                return "primitive";
            if (isMemberAccess(callee)) {
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
                    (name === "getElementById" || name === "querySelector") &&
                    node.arguments.length === 1 &&
                    value(node.arguments[0]!) === "primitive"
                ) {
                    const type = checker.getNonNullableType(
                        checker.getTypeAtLocation(expression),
                    );
                    const symbol = type.getSymbol();
                    if (libraryName(symbol) === "HTMLCanvasElement")
                        return "canvas";
                }
                if (
                    options.allowReportingDom &&
                    (owner === "canvas" || owner === "element") &&
                    name === "setAttribute" &&
                    node.arguments.length === 2 &&
                    value(node.arguments[0]!) === "primitive" &&
                    printable(value(node.arguments[1]!))
                ) {
                    const attribute = checker.getTypeAtLocation(
                        node.arguments[0]!,
                    );
                    if (
                        attribute.isStringLiteral() &&
                        /^data-[a-z0-9_.-]+$/i.test(attribute.value)
                    ) {
                        // A missing optional receiver performs no reporting.
                        reported = ts.isCallChain(node)
                            ? reportedBeforeCall
                            : true;
                        return "primitive";
                    }
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
            // A chosen right operand may not run: its reports do not stand.
            if (choosesOperand(node)) {
                reported = beforeRight;
                return join(left, right);
            }
            // A comma yields its right operand once its left one is known.
            if (operandYield(node, node.right))
                return left === undefined ? undefined : right;
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
            if (variableKind(node.declarationList) !== "const") return false;
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
    const isPrimitive = (expression: ts.Expression): boolean =>
        !typeCanCarryReference(checker.getTypeAtLocation(expression));
    const isBrowserType = (expression: ts.Expression): boolean => {
        const direct = checker.getTypeAtLocation(expression);
        const type = checker.getAwaitedType(direct) ?? direct;
        return presentMembers(type).every((member) =>
            declaredInDomLibrary(member.getSymbol()),
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
                variableKind(target.parent) === "const" &&
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
        const callee = namedMember(checker, unwrapExpression(call.expression));
        return (
            ts.isCallExpression(call) &&
            callee?.name === "bind" &&
            isFetch(callee.expression) &&
            call.arguments.length === 1 &&
            ts.isIdentifier(call.arguments[0]!) &&
            libraryGlobal(checker, call.arguments[0]) === "globalThis"
        );
    };
    const safeCall = (call: ts.CallExpression | ts.NewExpression): boolean => {
        if (isFetchBinding(call)) return true;
        const signature = calledDeclaration(checker, call);
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
        const member = namedMember(checker, callee);
        if (!member) return false;
        const receiver = unwrapExpression(member.expression);
        if (isBrowserType(receiver) && confined(receiver)) {
            return (call.arguments ?? []).every(
                (argument) =>
                    callSignatures(
                        checker,
                        checker.getTypeAtLocation(argument),
                        "exact",
                    ).length === 0 || confined(argument),
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
        for (const { target, stored } of writeSites(node))
            if (
                !safeWrite(target) ||
                (stored && isFetch(target) && !confined(stored))
            )
                return false;
        if (
            (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
            !safeCall(node)
        )
            return false;
        // Accessors and dynamic dispatch can hide arbitrary native effects.
        if (
            ts.isPropertyAccessExpression(node) &&
            memberAccessors(checker, node, "either").length > 0
        )
            return false;
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
    const declaration = calledDeclaration(checker, call);
    if (
        !declaration ||
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.body
    )
        return false;
    const parameter = positionalParameter(call, declaration, argumentIndex);
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
            const kind = writeSiteOf(field)?.kind;
            if (kind !== "assign" && kind !== "delete") {
                valid = false;
                return;
            }
            fields.add(field.name.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration.body);
    if (!valid || fields.size === 0) return false;
    return !observesDatasetFields(checker, sourceFiles, fields, host, (node) =>
        node === declaration ? "subtree" : undefined,
    );
}

/**
 * Whether a program source or the native host can observe the named dataset
 * fields: a host element, rule or sheet naming the attribute, a style text
 * or stylesheet write that could select it, an attribute reader or query that
 * may name it, any whole-dataset use, a member of the same name, or a string
 * naming the attribute. `ignore` excludes the writes being judged: a whole
 * subtree, or one node whose children are still read.
 */
export function observesDatasetFields(
    checker: ts.TypeChecker,
    sourceFiles: readonly ts.SourceFile[],
    fields: ReadonlySet<string>,
    host: NativeHostUi | undefined,
    ignore: (node: ts.Node) => "subtree" | "self" | undefined,
): boolean {
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
    if (attributes.some((name) => hostText.includes(name))) return true;
    const hasDomType = (expression: ts.Expression, name: string): boolean => {
        const owner = checker
            .getNonNullableType(checker.getTypeAtLocation(expression))
            .getSymbol();
        return owner?.name === name && declaredInDomLibrary(owner);
    };
    const observes = (node: ts.Node): boolean => {
        const ignored = ignore(node);
        if (ignored === "subtree") return false;
        if (ts.isTypeNode(node)) return false;
        if (ignored === "self") return ts.forEachChild(node, observes) ?? false;
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
    return sourceFiles.some(
        (file) => !file.isDeclarationFile && observes(file),
    );
}
