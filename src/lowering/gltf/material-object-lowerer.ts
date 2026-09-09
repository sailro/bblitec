import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding, PinnedNumericLowerer } from "../pinned-numeric-lowerer.js";
import { PINNED_ARITHMETIC_OPERATORS, PINNED_RELATIONAL_OPERATORS, pinnedNumericMathCalls, pinnedRoundCall } from "../pinned-operators.js";

const numericOperators = new Map([...PINNED_ARITHMETIC_OPERATORS, ...PINNED_RELATIONAL_OPERATORS]);

export interface GltfMaterialFunction {
    module: string;
    name: string;
    cpp: string;
    declaration: ts.FunctionDeclaration | ts.MethodDeclaration;
    contextParameter?: string;
    constants?: ReadonlyMap<string, string>;
    sourceSymbol?: string;
}

/** Shared statement lowering with aliased material objects and native texture boundaries. */
export function lowerGltfMaterialObjectFunction(
    context: LoweringContext,
    target: GltfMaterialFunction,
    resolveCall: (name: string) => string | undefined,
    lowerResourceCall?: (node: ts.CallExpression, lowerer: PinnedNumericLowerer) => string | undefined,
): string {
    const { module, name, cpp, declaration, contextParameter } = target;
    const file = declaration.getSourceFile();
    if (!declaration.body) context.contractError(declaration, "Expected a material function body.");
    const bindings = new Map<string, PinnedBinding>();
    for (const [name, value] of target.constants ?? []) bindings.set(name, { cpp: `GltfPbrValue{${JSON.stringify(value)}}`, type: "opaque" });
    const parameters = declaration.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected named material parameters.");
        const sourceName = parameter.name.text;
        bindings.set(sourceName, { cpp: sourceName, type: "opaque", absentCpp: `!${sourceName}.truthy()` });
        return sourceName === contextParameter ? `const GltfPbrContext& ${sourceName}` : `GltfPbrValue ${sourceName}`;
    });
    const calls = new Map<string, (args: readonly string[]) => string>();
    for (const [name, emit] of [...pinnedNumericMathCalls(), ["Math.round", pinnedRoundCall]] as const)
        calls.set(name, args => `GltfPbrValue{${emit(args.map(argument => `(${argument}).number()`))}}`);
    for (const operation of ["min", "max"])
        calls.set(`Math.${operation}`, args => `GltfPbrValue{gltf_pbr_extremum({${args.map(argument => `(${argument}).number()`).join(", ")}}, ${operation === "max"})}`);
    let temporary = 0;
    const value = (expression: ts.Expression, lowerer: PinnedNumericLowerer) => `(${lowerer.expression(expression)})`;
    const member = (expression: ts.Expression, lowerer: PinnedNumericLowerer): { receiver: string; key: string } | undefined => {
        const node = context.unwrapExpression(expression);
        if (ts.isPropertyAccessExpression(node)) return { receiver: value(node.expression, lowerer), key: JSON.stringify(node.name.text) };
        if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression))
            return { receiver: value(node.expression, lowerer), key: JSON.stringify(node.argumentExpression.text) };
        return undefined;
    };
    const object = (node: ts.ObjectLiteralExpression, lowerer: PinnedNumericLowerer): string => {
        const result = `material_object_${temporary++}`;
        const statements = node.properties.map(property => {
            if (ts.isSpreadAssignment(property)) return `${result}.merge(${lowerer.expression(property.expression)});`;
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
                context.contractError(property, "Unsupported material object member.");
            if (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
                context.contractError(property.name, "Expected a named material object member.");
            const expression = ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer;
            return `${result}.set(${JSON.stringify(property.name.text)}, ${lowerer.expression(expression)});`;
        });
        return `[&]() { auto ${result} = GltfPbrValue::object(); ${statements.join(" ")} return ${result}; }()`;
    };
    const body = lowerPinnedBody(file, declaration.body.statements, {
        bindings, calls, foldConditions: false,
        forOf(iterated, element) {
            const range = bindings.get(iterated);
            return range ? { range: `${range.cpp}.elements()`, bindings: new Map([[element,
                { cpp: element, type: "opaque", absentCpp: `!${element}.truthy()` }]]) } : undefined;
        },
        expression(node, lowerer) {
            if (ts.isAwaitExpression(node)) return lowerer.expression(node.expression);
            if (ts.isIdentifier(node) && node.text === "undefined") return "GltfPbrValue{}";
            if (node.kind === ts.SyntaxKind.NullKeyword) return "GltfPbrValue{nullptr}";
            if (node.kind === ts.SyntaxKind.TrueKeyword) return "GltfPbrValue{true}";
            if (node.kind === ts.SyntaxKind.FalseKeyword) return "GltfPbrValue{false}";
            if (ts.isNumericLiteral(node)) return `GltfPbrValue{${context.doubleLiteral(Number(node.text))}}`;
            if (ts.isStringLiteralLike(node)) return `GltfPbrValue{${JSON.stringify(node.text)}}`;
            if (ts.isTemplateExpression(node)) {
                const parts = [`std::string{${JSON.stringify(node.head.text)}}`];
                for (const span of node.templateSpans) parts.push(`${value(span.expression, lowerer)}.text()`, JSON.stringify(span.literal.text));
                return `GltfPbrValue{${parts.join(" + ")}}`;
            }
            if (ts.isArrayLiteralExpression(node)) return `GltfPbrValue::array({${node.elements.map(element => lowerer.expression(element)).join(", ")}})`;
            if (ts.isObjectLiteralExpression(node)) return object(node, lowerer);
            if (ts.isArrowFunction(node)) {
                if (ts.isBlock(node.body)) context.contractError(node, "Expected an expression material callback.");
                const saved = new Map(bindings);
                const parameters = node.parameters.map(parameter => {
                    if (!ts.isIdentifier(parameter.name)) context.contractError(parameter, "Expected a named material callback parameter.");
                    const name = parameter.name.text;
                    bindings.set(name, { cpp: name, type: "opaque", absentCpp: `!${name}.truthy()` });
                    return `GltfPbrValue ${name}`;
                });
                const body = value(node.body, lowerer);
                bindings.clear();
                for (const [name, binding] of saved) bindings.set(name, binding);
                return `[&](${parameters.join(", ")}) { return ${body}; }`;
            }
            if (ts.isConditionalExpression(node)) return `(${value(node.condition, lowerer)}.truthy() ? ${value(node.whenTrue, lowerer)} : ${value(node.whenFalse, lowerer)})`;
            if (ts.isPrefixUnaryExpression(node)) {
                const operand = value(node.operand, lowerer);
                if (node.operator === ts.SyntaxKind.ExclamationToken) return `GltfPbrValue{!${operand}.truthy()}`;
                if (node.operator === ts.SyntaxKind.MinusToken) return `GltfPbrValue{-${operand}.number()}`;
                if (node.operator === ts.SyntaxKind.PlusToken) return `GltfPbrValue{${operand}.number()}`;
            }
            if (ts.isPropertyAccessExpression(node)) {
                const receiver = context.unwrapExpression(node.expression);
                if (node.name.text === "length" && ts.isCallExpression(receiver) && context.expressionMatchesShape(receiver.expression, "Object.keys") && receiver.arguments.length === 1)
                    return `GltfPbrValue{double(${value(receiver.arguments[0]!, lowerer)}.size())}`;
                return `${value(node.expression, lowerer)}.get(${JSON.stringify(node.name.text)}, ${!!node.questionDotToken})`;
            }
            if (ts.isElementAccessExpression(node) && node.argumentExpression) {
                const index = context.unwrapExpression(node.argumentExpression);
                return ts.isStringLiteralLike(index)
                    ? `${value(node.expression, lowerer)}.get(${JSON.stringify(index.text)}, ${!!node.questionDotToken})`
                    : `${value(node.expression, lowerer)}.at(${value(index, lowerer)}.number(), ${!!node.questionDotToken})`;
            }
            if (ts.isBinaryExpression(node)) {
                const operator = node.operatorToken.kind;
                if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(operator)) {
                    const left = context.unwrapExpression(node.left);
                    if (ts.isTypeOfExpression(left) && ts.isStringLiteralLike(node.right) && node.right.text === "number")
                        return `GltfPbrValue{${operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ? "!" : ""}${value(left.expression, lowerer)}.is_number()}`;
                    return `GltfPbrValue{${operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ? "!" : ""}${value(node.left, lowerer)}.equals(${lowerer.expression(node.right)})}`;
                }
                if ([ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(operator) && node.right.kind === ts.SyntaxKind.NullKeyword)
                    return `GltfPbrValue{${operator === ts.SyntaxKind.ExclamationEqualsToken ? "!" : ""}${value(node.left, lowerer)}.nullish()}`;
                if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(operator)) {
                    const left = `material_left_${temporary++}`;
                    const condition = operator === ts.SyntaxKind.QuestionQuestionToken ? `${left}.nullish()`
                        : `${operator === ts.SyntaxKind.BarBarToken ? "!" : ""}${left}.truthy()`;
                    return `[&]() { const auto ${left} = ${value(node.left, lowerer)}; return ${condition} ? ${value(node.right, lowerer)} : ${left}; }()`;
                }
                if (operator === ts.SyntaxKind.EqualsToken || operator === ts.SyntaxKind.QuestionQuestionEqualsToken) {
                    const target = member(node.left, lowerer);
                    const left = context.unwrapExpression(node.left);
                    const store = target ? `${target.receiver}.set(${target.key}, ${value(node.right, lowerer)})`
                        : ts.isIdentifier(left) && bindings.has(left.text) ? `(${left.text} = ${value(node.right, lowerer)})` : undefined;
                    if (!store) context.contractError(node.left, "Unsupported material assignment target.");
                    if (operator === ts.SyntaxKind.EqualsToken) return store;
                    const receiver = `material_target_${temporary++}`;
                    if (target) return `[&]() { const auto ${receiver} = ${target.receiver}; const auto previous = ${receiver}.get(${target.key}); return previous.nullish() ? ${receiver}.set(${target.key}, ${value(node.right, lowerer)}) : previous; }()`;
                    return `(${value(node.left, lowerer)}.nullish() ? ${store} : ${value(node.left, lowerer)})`;
                }
                if (operator === ts.SyntaxKind.PlusToken) return `${value(node.left, lowerer)}.add(${value(node.right, lowerer)})`;
                if (operator === ts.SyntaxKind.PercentToken) return `GltfPbrValue{std::fmod(${value(node.left, lowerer)}.number(), ${value(node.right, lowerer)}.number())}`;
                const token = numericOperators.get(operator);
                if (token) return `GltfPbrValue{${value(node.left, lowerer)}.number() ${token} ${value(node.right, lowerer)}.number()}`;
                if (operator === ts.SyntaxKind.AsteriskAsteriskToken) return `GltfPbrValue{std::pow(${value(node.left, lowerer)}.number(), ${value(node.right, lowerer)}.number())}`;
                if (operator === ts.SyntaxKind.BarToken) return `GltfPbrValue{double(bbl::js::bitwise_or(${value(node.left, lowerer)}.number(), ${value(node.right, lowerer)}.number()))}`;
            }
            if (ts.isCallExpression(node)) {
                const resource = lowerResourceCall?.(node, lowerer);
                if (resource !== undefined) return resource;
                const callee = context.unwrapExpression(node.expression);
                const argument = (index: number) => {
                    const value = node.arguments[index];
                    if (!value) context.contractError(node, "Missing material call argument.");
                    return lowerer.expression(value);
                };
                if (context.expressionMatchesShape(node.expression, "Array.isArray") && node.arguments.length === 1)
                    return `GltfPbrValue{GltfPbrValue{${argument(0)}}.is_array()}`;
                if (context.expressionMatchesShape(node.expression, "JSON.stringify") && node.arguments.length === 1)
                    return `gltf_pbr_stringify_source(${argument(0)})`;
                if (context.expressionMatchesShape(node.expression, "Promise.all") && node.arguments.length === 1) return argument(0);
                if (context.expressionMatchesShape(node.expression, "Promise.resolve") && node.arguments.length === 1) return argument(0);
                if (context.expressionMatchesShape(node.expression, "Object.assign") && node.arguments.length === 2) {
                    const result = `material_assigned_${temporary++}`;
                    return `[&]() { const auto ${result} = ${argument(0)}; ${result}.merge(${argument(1)}); return ${result}; }()`;
                }
                if (ts.isPropertyAccessExpression(callee) && ["map", "some", "includes"].includes(callee.name.text) && node.arguments.length === 1) {
                    const result = `gltf_pbr_${callee.name.text}(${value(callee.expression, lowerer)}, ${argument(0)})`;
                    if (!callee.questionDotToken) return result;
                    const receiver = `material_array_${temporary++}`;
                    return `[&]() { const auto ${receiver} = ${value(callee.expression, lowerer)}; return ${receiver}.nullish() ? GltfPbrValue{} : gltf_pbr_${callee.name.text}(${receiver}, ${argument(0)}); }()`;
                }
                if (ts.isPropertyAccessExpression(callee) && callee.name.text === "applyMaterial" && node.arguments.length === 2)
                    return `gltf_pbr_apply_feature(${value(callee.expression, lowerer)}, ${argument(0)}, ${argument(1)})`;
                if (contextParameter && context.expressionMatchesShape(node.expression, `${contextParameter}._texture`) && node.arguments.length === 2)
                    return `${contextParameter}.texture(${argument(0)}, GltfPbrValue{${argument(1)}}.truthy())`;
                if (contextParameter && context.expressionMatchesShape(node.expression, `${contextParameter}._uploadImage`) && node.arguments.length === 2)
                    return `${contextParameter}.upload_image(${argument(0)}, GltfPbrValue{${argument(1)}}.truthy())`;
                if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                    if (node.arguments.length !== 1 || !ts.isStringLiteralLike(node.arguments[0]!) ||
                        !/^\.\.\/material\/pbr\/(set-(transmission|dispersion|metallic-reflectance|emissive|alpha-cutoff)|enable-material-uv-transform)\.js$/.test(node.arguments[0].text))
                        context.contractError(node, "Unsupported material feature module.");
                    return "GltfPbrValue{true}";
                }
                const callName = ts.isIdentifier(node.expression) ? node.expression.text
                    : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined;
                if (callName === "getPbrGroupBuilder" && node.arguments.length === 0) return "GltfPbrValue{true}";
                if (callName === "cloneTexture2D" && node.arguments.length === 2) {
                    const clone = `material_clone_${temporary++}`;
                    return `[&]() { auto ${clone} = GltfPbrValue{${argument(0)}}.clone(); ${clone}.merge(${argument(1)}); return ${clone}; }()`;
                }
                const functionName = callName && resolveCall(callName);
                if (functionName) return `${functionName}(${node.arguments.map(argument => value(argument, lowerer)).join(", ")})`;
            }
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (ts.isReturnStatement(statement) && !statement.expression) return [`${indent}return GltfPbrValue{};`];
            if (ts.isExpressionStatement(statement)) {
                const expression = context.unwrapExpression(statement.expression);
                if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) &&
                    ["_registerPbrExt", "_registerPbrSceneHook", "_setDispersionSampleWgsl"].includes(expression.expression.text)) {
                    // Shader fragments and scene hooks are resolved by material composition.
                    if (expression.arguments.length !== 1 || !ts.isIdentifier(expression.arguments[0]!))
                        context.contractError(expression, "Unsupported material composition registration.");
                    return [];
                }
                if (ts.isDeleteExpression(expression)) {
                    const target = member(expression.expression, lowerer);
                    if (!target) context.contractError(expression, "Unsupported material property deletion.");
                    return [`${indent}${target.receiver}.erase(${target.key});`];
                }
                return [`${indent}${lowerer.expression(expression)};`];
            }
            if (!ts.isVariableStatement(statement)) return undefined;
            return statement.declarationList.declarations.flatMap(variable => {
                if (!variable.initializer) {
                    if (!ts.isIdentifier(variable.name)) context.contractError(variable, "Expected a named material state.");
                    const name = variable.name.text;
                    bindings.set(name, { cpp: name, type: "opaque", absentCpp: `!${name}.truthy()` });
                    return [`${indent}GltfPbrValue ${name};`];
                }
                const initializer = context.unwrapExpression(variable.initializer);
                if (ts.isObjectBindingPattern(variable.name)) {
                    const imported = ts.isAwaitExpression(initializer) ? context.unwrapExpression(initializer.expression) : initializer;
                    if (!ts.isCallExpression(imported) || imported.expression.kind !== ts.SyntaxKind.ImportKeyword)
                        context.contractError(variable, "Expected a material feature import.");
                    lowerer.expression(imported);
                    for (const element of variable.name.elements) {
                        const importedName = element.propertyName ?? element.name;
                        if (!ts.isIdentifier(importedName) || !ts.isIdentifier(element.name) || element.initializer || element.dotDotDotToken)
                            context.contractError(element, "Unsupported material import binding.");
                        const cpp = resolveCall(importedName.text);
                        if (!cpp) context.contractError(element, "Unknown material feature import.");
                        calls.set(element.name.text, args => `${cpp}(${args.join(", ")})`);
                    }
                    return [];
                }
                if (ts.isArrayBindingPattern(variable.name)) {
                    const result = `material_values_${temporary++}`;
                    const lines = [`${indent}const auto ${result} = ${value(initializer, lowerer)};`];
                    variable.name.elements.forEach((element, index) => {
                        if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name) || element.dotDotDotToken || element.initializer)
                            context.contractError(element, "Unsupported material result destructuring.");
                        const name = element.name.text;
                        bindings.set(name, { cpp: name, type: "opaque", absentCpp: `!${name}.truthy()` });
                        lines.push(`${indent}GltfPbrValue ${name} = ${result}.at(${context.doubleLiteral(index)});`);
                    });
                    return lines;
                }
                if (!ts.isIdentifier(variable.name)) context.contractError(variable, "Expected a material state binding.");
                const name = variable.name.text;
                if (ts.isArrowFunction(initializer)) {
                    const callback = lowerer.expression(initializer);
                    calls.set(name, args => `${name}(${args.join(", ")})`);
                    return [`${indent}const auto ${name} = ${callback};`];
                }
                const initial = value(initializer, lowerer);
                bindings.set(name, { cpp: name, type: "opaque", absentCpp: `!${name}.truthy()` });
                return [`${indent}GltfPbrValue ${name} = ${initial};`];
            });
        },
        returnValue: (expression, lowerer) => expression ? value(expression, lowerer) : "GltfPbrValue{}",
    });
    return `// ${context.provenance(module, target.sourceSymbol ?? name)}
[[maybe_unused]] GltfPbrValue ${cpp}(${parameters.join(", ")}) {
${body}
${declaration.type?.kind === ts.SyntaxKind.VoidKeyword || (declaration.type && ts.isTypeReferenceNode(declaration.type) &&
    declaration.type.typeArguments?.[0]?.kind === ts.SyntaxKind.VoidKeyword) ? "    return {};\n" : ""}}`;
}
