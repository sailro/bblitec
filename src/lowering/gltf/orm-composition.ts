import ts from "typescript";
import { LoweringContext } from "../context.js";
import { lowerPinnedBody } from "../pinned-body-lowerer.js";
import type { PinnedBinding } from "../pinned-numeric-lowerer.js";

/** The pixel loop comes from the pin; Canvas2D calls use the native image adapter. */
export function lowerGltfOrmComposition(context: LoweringContext): string {
    const module = "src/loader-gltf/gltf-ext-orm.ts";
    const { file, declaration } = context.functionDeclaration(module, "compositeOrm");
    const bindings = new Map<string, PinnedBinding>();
    const shapes = new Map<string, "bitmap" | "canvas" | "context">();
    const bind = (name: string, shape: "bitmap" | "canvas" | "context") => {
        shapes.set(name, shape);
        bindings.set(name, { cpp: name, type: "opaque" });
        if (shape === "bitmap") {
            for (const member of ["width", "height"])
                bindings.set(`${name}.${member}`, { cpp: `${name}.${member}`, type: "scalar" });
            bindings.set(`${name}.data`, { cpp: `${name}.rgba`, type: "u8" });
        }
    };
    const parameters = declaration.parameters.map(parameter => {
        if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotDotToken)
            context.contractError(parameter, "Expected a bitmap parameter.");
        bind(parameter.name.text, "bitmap");
        return `const pal::DecodedImage& ${parameter.name.text}`;
    });
    const methods = new Map<string, { receiver: "canvas" | "context"; cpp: string; count: number; result?: "bitmap" | "context" }>([
        ["getContext", { receiver: "canvas", cpp: "context", count: 1, result: "context" }],
        ["drawImage", { receiver: "context", cpp: "draw_image", count: 5 }],
        ["getImageData", { receiver: "context", cpp: "get_image_data", count: 4, result: "bitmap" }],
        ["putImageData", { receiver: "context", cpp: "put_image_data", count: 3 }],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings, calls: new Map(),
        expression(node, lowerer) {
            if (ts.isNewExpression(node) && context.expressionMatchesShape(node.expression, "OffscreenCanvas")) {
                if (node.arguments?.length !== 2) context.contractError(node, "Expected image canvas dimensions.");
                return `pal::ImageCanvas{${node.arguments.map(argument => lowerer.expression(argument)).join(", ")}}`;
            }
            if (!ts.isCallExpression(node)) return undefined;
            const callee = context.unwrapExpression(node.expression);
            if (context.expressionMatchesShape(callee, "createImageBitmap")) {
                const source = node.arguments[0];
                if (node.arguments.length !== 1 || !source || !ts.isIdentifier(source) || shapes.get(source.text) !== "canvas")
                    context.contractError(node, "Expected a canvas bitmap snapshot.");
                return `${lowerer.expression(source)}.bitmap()`;
            }
            if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return undefined;
            const method = methods.get(callee.name.text);
            if (!method) return undefined;
            if (shapes.get(callee.expression.text) !== method.receiver || node.arguments.length !== method.count)
                context.contractError(node, "Unsupported image canvas call.");
            const args = node.arguments.map(argument => ts.isStringLiteralLike(argument) ? JSON.stringify(argument.text) : lowerer.expression(argument));
            return `${lowerer.expression(callee.expression)}.${method.cpp}(${args.join(", ")})`;
        },
        statement(statement, lowerer, indent) {
            if (ts.isExpressionStatement(statement)) {
                const expression = context.unwrapExpression(statement.expression);
                if (ts.isBinaryExpression(expression) && ts.isElementAccessExpression(expression.left) && expression.left.argumentExpression) {
                    const target = bindings.get(expression.left.expression.getText(file));
                    if (target?.type === "u8") {
                        if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
                            context.contractError(expression, "Unsupported image data update.");
                        return [`${indent}pal::image_data_store(${target.cpp}, static_cast<double>(${lowerer.expression(expression.left.argumentExpression)}), ${lowerer.expression(expression.right)});`];
                    }
                }
            }
            if (!ts.isVariableStatement(statement)) return undefined;
            if (statement.declarationList.declarations.length !== 1) context.contractError(statement, "Expected one image state declaration.");
            const variable = statement.declarationList.declarations[0]!;
            if (!ts.isIdentifier(variable.name) || !variable.initializer) context.contractError(variable, "Expected named image state.");
            const initializer = context.unwrapExpression(variable.initializer);
            let shape: "bitmap" | "canvas" | "context" | undefined;
            if (ts.isNewExpression(initializer) && context.expressionMatchesShape(initializer.expression, "OffscreenCanvas")) shape = "canvas";
            if (ts.isCallExpression(initializer) && ts.isPropertyAccessExpression(initializer.expression)) {
                shape = methods.get(initializer.expression.name.text)?.result;
            }
            if (!shape) return undefined;
            const value = lowerer.expression(initializer);
            bind(variable.name.text, shape);
            return [`${indent}auto${shape === "context" ? "&" : ""} ${variable.name.text} = ${value};`];
        },
        returnValue: (expression, lowerer) => lowerer.expression(expression!),
    });
    for (const update of context.findNodes(declaration, (node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression =>
        (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
        (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken))) {
        const operand = context.unwrapExpression(update.operand);
        if (ts.isElementAccessExpression(operand) && bindings.get(operand.expression.getText(file))?.type === "u8")
            context.contractError(update, "Unsupported image data update.");
    }
    return `// ${context.provenance(module, "compositeOrm")}
pal::DecodedImage gltf_composite_orm(${parameters.join(", ")}) {
${body}
}`;
}
