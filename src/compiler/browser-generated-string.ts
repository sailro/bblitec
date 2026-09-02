// Generation-time evaluation for deterministic Canvas2D data-URL helpers.
//
// Demos commonly build a small procedural texture in a local function and
// pass its returned data URL straight to loadTexture2D. Native has no DOM or
// Canvas2D surface; executing that closed helper in the pinned capture browser
// preserves the browser's actual rasterization while leaving the source graph
// byte-identical.
//
// The compiler walk is synchronous, so the Chromium run crosses a
// `spawnSync` subprocess boundary — the same shape as
// `asset-bytes-sync.ts` — and the subprocess imports the one browser
// ceremony (`browser-harness.ts`'s `withBrowserPage`) rather than
// inlining its own launch. Results replay from the content-addressed
// bake cache: warm recompiles launch no Chromium and yield the exact
// bytes of the run that produced them.
import { spawnSync } from "node:child_process";

import ts from "typescript";

import { cachedBakeSync, moduleIdentity } from "../bake-cache.js";
import { tryResolveFunctionDeclaration } from "./user-functions.js";

// Same-process fast path in front of the durable bake cache: a scene
// that calls the same helper twice pays neither a subprocess nor a
// cache-file read the second time.
const cache = new Map<string, string>();

/**
 * Fold one argument to the literal a generation-time call can carry.
 *
 * The helper runs in a browser with nothing but its own source in scope,
 * so an argument that is not written as a literal has to arrive as one.
 * The compiler answers that: `labelTextureUrl(text)` reached from inside
 * an inlined `createLabelMaterial(engine, "-")` names a parameter whose
 * bound value is a compile-time string, and the fold is what turns the
 * name back into the text the browser is handed. Returning `undefined`
 * means the value is not generation-known, which is what keeps a runtime
 * argument out of the bake.
 */
export type FoldGeneratedStringArgument = (
    argument: ts.Expression,
) => string | number | boolean | undefined;

export function browserGeneratedString(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
    foldArgument: FoldGeneratedStringArgument,
): string | undefined {
    if (!ts.isIdentifier(call.expression)) return undefined;
    const declaration = tryResolveFunctionDeclaration(
        checker,
        call.expression,
    );
    if (!declaration?.body || !ts.isFunctionDeclaration(declaration)) {
        return undefined;
    }
    // The helper being baked is the one whose own body draws and reads the
    // canvas back, and the test is over its AST rather than its text: a
    // file-scoped substring match reached every other function beside it
    // (scene 187 declares `createUnlitMaterial([r,g,b])` in the file that
    // also declares its fence texture, and a StandardMaterial factory was
    // sent to Chromium, where it returned an object), while a body-scoped
    // one would still be a source-text decision, which generated behaviour
    // does not make.
    if (!readsCanvasDataUrl(declaration.body)) return undefined;
    const source = declaration.getSourceFile();

    const functionName = declaration.name?.text;
    if (!functionName) return undefined;
    const argumentTexts: string[] = [];
    for (const argument of call.arguments) {
        if (isLiteralConfiguration(argument)) {
            argumentTexts.push(argument.getText(call.getSourceFile()));
            continue;
        }
        const folded = foldArgument(argument);
        if (folded === undefined) return undefined;
        argumentTexts.push(JSON.stringify(folded));
    }
    const argumentsText = argumentTexts.join(", ");
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

    const value = cachedBrowserGeneratedString(
        javascript,
        functionName,
        argumentsText,
        runCanvasHelperInChromium,
    );
    cache.set(key, value);
    return value;
}

/**
 * The bake-cache wrapper around the Chromium run. The string is
 * deterministic in (the helper's transpiled source with its call
 * appended, pin, browser) — the transpiled input already embeds the
 * helper's whole source file and the literal arguments, and the
 * parameters name them again for the key's readability. The runner is
 * injectable so the replay contract is testable without a browser
 * launch.
 */
export function cachedBrowserGeneratedString(
    javascript: string,
    functionName: string,
    argumentsText: string,
    run: (javascript: string, functionName: string) => string,
): string {
    const bytes = cachedBakeSync(
        {
            kind: "browser-generated-string",
            version: "1",
            module: moduleIdentity(import.meta.url),
            browser: true,
            parameters: { functionName, arguments: argumentsText },
            inputs: [Buffer.from(javascript, "utf8")],
        },
        () => Buffer.from(run(javascript, functionName), "utf8"),
    );
    return Buffer.from(bytes).toString("utf8");
}

/**
 * Execute the transpiled helper in the capture Chromium and return the
 * string it assigned to `__bbliteGeneratedString`. The subprocess
 * imports the one launch ceremony from `browser-harness.js`; like the
 * drawn-atlas Canvas2D bake it passes no Chromium flags, and the script
 * runs on the fresh page exactly as it always has (`addScriptTag` on the
 * unnavigated page — the served shell exists only because the ceremony
 * hosts one).
 */
function runCanvasHelperInChromium(
    javascript: string,
    functionName: string,
): string {
    const harnessModule = new URL(
        "../browser-harness.js",
        import.meta.url,
    ).href;
    const script = `
        import { createServer } from "node:http";
        import { withBrowserPage } from ${JSON.stringify(harnessModule)};
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const code = Buffer.concat(chunks).toString("utf8");
        const server = createServer((_request, response) => {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end("<!doctype html><title>Canvas2D helper</title>");
        });
        const value = await withBrowserPage(
            server,
            {
                serverName: "Canvas2D helper server",
                browserRequirement: "Canvas2D texture generation requires Chromium.",
            },
            async (page) => {
                await page.addScriptTag({ content: code });
                return page.evaluate(() => globalThis.__bbliteGeneratedString);
            },
        );
        if (typeof value !== "string") throw new Error("Canvas helper did not return a string.");
        process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
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
    return Buffer.from(child.stdout.trim(), "base64").toString("utf8");
}

/**
 * Whether a body reads a canvas back as a data URL.
 *
 * `canvas.toDataURL(...)` is the one call that turns a browser
 * rasterization into a string a native build can carry, so a helper that
 * makes it is what generation executes. The test is the call's own
 * property name in the AST -- a `.toDataURL(` in a comment or a string is
 * not a call, and generated behaviour is never decided by source text.
 */
function readsCanvasDataUrl(body: ts.Node): boolean {
    let reads = false;
    const visit = (node: ts.Node): void => {
        if (reads) return;
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "toDataURL"
        ) {
            reads = true;
            return;
        }
        node.forEachChild(visit);
    };
    visit(body);
    return reads;
}

/**
 * An argument whose text can be spelled straight into the executed helper.
 *
 * A literal needs no fold, and an object or array literal of literals is
 * one too — the drawn-texture helpers take an options bag. Anything else
 * goes through {@link FoldGeneratedStringArgument}, which answers with a
 * value rather than with source text.
 */
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
