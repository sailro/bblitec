import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { sharedUpstreamStore } from "../upstream-source.js";

/** The pinned module that declares the error helper. */
const liteErrorModule = "src/lite-error.ts";

/** Match the imported error helper, including local aliases. */
export function isPinnedErrorCall(
    file: ts.SourceFile,
    call: ts.CallExpression,
): boolean {
    const callee = call.expression;
    if (!ts.isIdentifier(callee)) return false;
    return file.statements.some((statement) => {
        if (
            !ts.isImportDeclaration(statement) ||
            !ts.isStringLiteral(statement.moduleSpecifier) ||
            sharedUpstreamStore().resolveImport(
                file.fileName,
                statement.moduleSpecifier.text,
            ) !== liteErrorModule
        )
            return false;
        const bindings = statement.importClause?.namedBindings;
        return (
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.some(
                (binding) =>
                    binding.name.text === callee.text &&
                    (binding.propertyName ?? binding.name).text ===
                        "ThrowLiteError",
            )
        );
    });
}

/** The pin's generated error table: one message decoder per code. */
function pinnedErrorTable(context: LoweringContext): {
    file: ts.SourceFile;
    table: ts.ArrayLiteralExpression;
} {
    const file = context.sourceFile("src/error-messages.ts");
    const table = context.variableInitializer(file, "T");
    if (!ts.isArrayLiteralExpression(table))
        return context.contractError(
            table,
            "Expected the pinned error message table.",
        );
    return { file, table };
}

/** Encode fixed-message contract throws using the pin's generated error table. */
export function encodePinnedErrorContracts(
    context: LoweringContext,
    source: string,
    owner: ts.Node,
): string {
    const { file, table } = pinnedErrorTable(context);
    const codes = new Map<string, number>();
    const templates = new Map<string, number>();
    const reachedCodes = new Set(
        context
            .findNodes(
                owner,
                (node): node is ts.CallExpression =>
                    ts.isCallExpression(node) &&
                    ts.isIdentifier(node.expression) &&
                    node.expression.text === "ThrowLiteError",
            )
            .flatMap((call) =>
                call.arguments[0] && ts.isNumericLiteral(call.arguments[0])
                    ? [Number(call.arguments[0].text)]
                    : [],
            ),
    );
    const templateKey = (template: ts.TemplateExpression): string =>
        JSON.stringify([
            template.head.text,
            ...template.templateSpans.map((span) => span.literal.text),
        ]);
    for (const [code, decoder] of table.elements.entries()) {
        if (!reachedCodes.has(code)) continue;
        if (ts.isArrowFunction(decoder) && ts.isStringLiteral(decoder.body))
            codes.set(decoder.body.text, code);
        else if (
            ts.isArrowFunction(decoder) &&
            ts.isTemplateExpression(decoder.body) &&
            decoder.parameters.length === decoder.body.templateSpans.length &&
            decoder.body.templateSpans.every(
                (span, index) =>
                    ts.isIdentifier(span.expression) &&
                    span.expression.text ===
                        decoder.parameters[index]!.name.getText(file),
            )
        )
            templates.set(templateKey(decoder.body), code);
    }
    const input = ts.createSourceFile(
        "error-contract.ts",
        source,
        ts.ScriptTarget.Latest,
        true,
    );
    const transformed = ts.transform(input, [
        (transformation) => {
            const visit: ts.Visitor = (node) => {
                if (
                    ts.isThrowStatement(node) &&
                    ts.isNewExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    node.expression.expression.text === "Error" &&
                    node.expression.arguments?.length === 1
                ) {
                    const message = node.expression.arguments[0]!;
                    const code = ts.isStringLiteral(message)
                        ? codes.get(message.text)
                        : ts.isTemplateExpression(message)
                          ? templates.get(templateKey(message))
                          : undefined;
                    if (code !== undefined)
                        return ts.factory.createExpressionStatement(
                            ts.factory.createCallExpression(
                                ts.factory.createIdentifier("ThrowLiteError"),
                                undefined,
                                [
                                    ts.factory.createNumericLiteral(code),
                                    ...(ts.isTemplateExpression(message)
                                        ? message.templateSpans.map(
                                              (span) => span.expression,
                                          )
                                        : []),
                                ],
                            ),
                        );
                }
                return ts.visitEachChild(node, visit, transformation);
            };
            return (root) => ts.visitNode(root, visit, ts.isSourceFile)!;
        },
    ]);
    try {
        return ts.createPrinter().printFile(transformed.transformed[0]!);
    } finally {
        transformed.dispose();
    }
}

/** The fixed message the pin's error table decodes for `code`. */
export function pinnedErrorMessage(
    context: LoweringContext,
    code: number,
): string {
    const { table } = pinnedErrorTable(context);
    const decoder = table.elements[code];
    const message =
        decoder &&
        ts.isArrowFunction(decoder) &&
        decoder.parameters.length === 0 &&
        !ts.isBlock(decoder.body)
            ? context.unwrapExpression(decoder.body)
            : undefined;
    if (!message || !ts.isStringLiteral(message))
        return context.contractError(
            decoder ?? table,
            `Expected pinned error ${code} to be a fixed message.`,
        );
    return message.text;
}

/** The diagnostic table belongs to the pin; numeric error IDs are build outputs. */
export function containsPinnedErrorMessage(
    context: LoweringContext,
    node: ts.Node,
    message: string,
): boolean {
    const calls = context.findNodes(
        node,
        (child): child is ts.CallExpression =>
            ts.isCallExpression(child) &&
            ts.isIdentifier(child.expression) &&
            child.expression.text === "ThrowLiteError",
    );
    if (!calls.length) return false;
    const { table } = pinnedErrorTable(context);
    return calls.some((call) => {
        const id = call.arguments[0];
        if (!id || !ts.isNumericLiteral(id)) return false;
        const decoder = table.elements[Number(id.text)];
        if (!decoder || !ts.isArrowFunction(decoder))
            return context.contractError(
                call,
                "Expected a pinned error decoder.",
            );
        if (ts.isBlock(decoder.body))
            return context.contractError(
                decoder,
                "Expected an error message expression.",
            );
        const body = context.unwrapExpression(decoder.body);
        return (
            (ts.isStringLiteral(body) && body.text.includes(message)) ||
            (ts.isTemplateExpression(body) && body.head.text.includes(message))
        );
    });
}
