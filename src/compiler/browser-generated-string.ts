// Generation-time evaluation for deterministic Canvas2D data-URL helpers.
//
// Demos commonly build a small procedural texture in a local function and
// pass its returned data URL straight to loadTexture2D. Native has no DOM or
// Canvas2D surface; executing that closed helper in the pinned capture browser
// preserves the browser's actual rasterization while leaving the source graph
// byte-identical.
import { spawnSync } from "node:child_process";

import ts from "typescript";

import { resolveFunctionDeclaration } from "./user-functions.js";

const cache = new Map<string, string>();

export function browserGeneratedString(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): string | undefined {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const declaration = resolveFunctionDeclaration(
        checker,
        call.expression,
        () => undefined as never,
    );
    if (!declaration?.body || !ts.isFunctionDeclaration(declaration)) {
        return undefined;
    }
    const source = declaration.getSourceFile();
    if (!source.text.includes(".toDataURL(")) return undefined;
    if (!call.arguments.every(isLiteralConfiguration)) return undefined;

    const functionName = declaration.name?.text;
    if (!functionName) return undefined;
    const argumentsText = call.arguments
        .map((argument) => argument.getText(call.getSourceFile()))
        .join(", ");
    const key = `${source.fileName}\0${functionName}\0${argumentsText}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let sourceText = source.text;
    const imports = source.statements.filter(ts.isImportDeclaration);
    for (const statement of [...imports].reverse()) {
        sourceText =
            sourceText.slice(0, statement.getFullStart()) +
            sourceText.slice(statement.end);
    }
    sourceText +=
        `\n(globalThis as any).__bbliteGeneratedString = ` +
        `${functionName}(${argumentsText});\n`;
    const javascript =
        "const exports = {};\n" +
        ts.transpileModule(sourceText, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.CommonJS,
            },
            fileName: source.fileName,
        }).outputText;

    const browserPathModule = new URL(
        "../browser-path.js",
        import.meta.url,
    ).href;
    const script = `
        import { chromium } from "playwright-core";
        import { resolveBrowserPath } from ${JSON.stringify(browserPathModule)};
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const code = Buffer.concat(chunks).toString("utf8");
        const browser = await chromium.launch({
            executablePath: resolveBrowserPath("Canvas2D texture generation requires Chromium."),
            headless: true,
        });
        try {
            const page = await browser.newPage();
            await page.addScriptTag({ content: code });
            const value = await page.evaluate(() => globalThis.__bbliteGeneratedString);
            if (typeof value !== "string") throw new Error("Canvas helper did not return a string.");
            process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
        } finally {
            await browser.close();
        }
    `;
    const child = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
            cwd: process.cwd(),
            input: javascript,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    if (child.status !== 0) {
        throw new Error(
            `Generation-time Canvas2D call '${functionName}' failed: ` +
                `${(child.stderr || child.error?.message || "no output").trim()}`,
        );
    }
    const value = Buffer.from(child.stdout.trim(), "base64").toString("utf8");
    cache.set(key, value);
    return value;
}

function isLiteralConfiguration(expression: ts.Expression): boolean {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    if (
        ts.isStringLiteral(current) ||
        ts.isNumericLiteral(current) ||
        current.kind === ts.SyntaxKind.TrueKeyword ||
        current.kind === ts.SyntaxKind.FalseKeyword ||
        current.kind === ts.SyntaxKind.NullKeyword
    ) {
        return true;
    }
    if (
        ts.isPrefixUnaryExpression(current) &&
        (current.operator === ts.SyntaxKind.MinusToken ||
            current.operator === ts.SyntaxKind.PlusToken)
    ) {
        return isLiteralConfiguration(current.operand);
    }
    if (ts.isArrayLiteralExpression(current)) {
        return current.elements.every(
            (element) =>
                !ts.isSpreadElement(element) &&
                isLiteralConfiguration(element),
        );
    }
    if (ts.isObjectLiteralExpression(current)) {
        return current.properties.every(
            (property) =>
                ts.isPropertyAssignment(property) &&
                isLiteralConfiguration(property.initializer),
        );
    }
    return false;
}
