/**
 * A value a scene module BUILDS, read by running the module under Node.
 *
 * This is the third executed-module route and the only one that needs no
 * browser. Its siblings in `executed-module-assets.ts` produce *pixels* — a
 * canvas2D atlas and a computed buffer — so they run where the golden runs
 * them and record an adaptation for it. A node-material graph is structure:
 * an object of numbers, strings and arrays assembled from id counters and
 * `push`, with no Math and no browser global in any of the corpus modules
 * that write one. Nothing about it can differ between two ECMAScript engines,
 * so running it in Chromium would buy a launch per graph and an adaptation
 * whose stated risk would not be true.
 *
 * What it is NOT is a licence to lower less. A module reaching outside plain
 * data fails here, at its own import, rather than being executed against a
 * shim — which is the same boundary the browser route draws, one engine over.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { transpileForBrowser } from "./browser-harness.js";
import { javascriptModuleUrl } from "./data-url.js";
import type { ExecutedModuleSource } from "./executed-module-assets.js";

/**
 * Run a scene module and return the object one of its exports holds.
 *
 * Each module is transpiled and imported through a `data:` URL — the same
 * mechanism `pinned-shader-composer.ts` uses to import a pinned module with
 * substitutions — so nothing is written to disk.
 */
export async function executeModuleGraph(
    source: ExecutedModuleSource,
): Promise<Record<string, unknown>> {
    const url = moduleDataUrl(source.modulePath, new Map());
    const module = (await import(url)) as Record<string, unknown>;
    const value = module[source.exportName];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
            `Module export ${source.exportName} in ${source.modulePath} is ` +
                "not an object.",
        );
    }
    return value as Record<string, unknown>;
}

/**
 * The value a scene module's own function BUILDS from arguments generation
 * already knows, read by running that function under Node.
 *
 * The same route and the same boundary as the export above, one call
 * deeper: scene 140 derives its caster graph from its receiver graph by
 * wiring an alpha discard into it, and that wiring is the corpus's own
 * TypeScript. Executing it is right for the reason this file opens with --
 * a graph is structure, and nothing about assembling one can differ
 * between two ECMAScript engines -- which is also why it earns no
 * adaptation where the pixel routes do.
 *
 * The arguments are plain JSON for the same reason the result is: anything
 * else would be a value this route cannot promise two engines agree on.
 */
export async function executeModuleGraphCall(
    source: ExecutedModuleSource,
    argumentsJson: readonly unknown[],
): Promise<unknown> {
    const url = moduleDataUrl(source.modulePath, new Map());
    const module = (await import(url)) as Record<string, unknown>;
    const value = module[source.exportName];
    if (typeof value !== "function") {
        throw new Error(
            `Module export ${source.exportName} in ${source.modulePath} is ` +
                "not a function.",
        );
    }
    return (value as (...args: readonly unknown[]) => unknown)(
        ...argumentsJson,
    );
}

/**
 * One module as a self-contained `data:` URL, with each relative import
 * replaced by the URL of the sibling it names.
 *
 * The corpus composes graphs out of each other — scene 87's document is
 * scene 67's with three blocks changed — so a graph module's own `./sibling`
 * import is part of the same plain-data structure and travels with it. What
 * does NOT travel is a bare specifier: a package import is the boundary this
 * route draws, and it fails here naming the specifier rather than resolving
 * to the engine, a shim, or anything a second engine could disagree about.
 *
 * Inlining is what keeps that true. A data URL has no base to resolve
 * against, so a specifier this walk did not rewrite cannot resolve at all,
 * and the refusal below is the only way one is reached.
 */
function moduleDataUrl(
    modulePath: string,
    building: Map<string, string | null>,
): string {
    const done = building.get(modulePath);
    if (done === null) {
        throw new Error(
            `Executed module ${modulePath} imports itself; a graph module ` +
                "is plain data and cannot be cyclic.",
        );
    }
    if (done !== undefined) return done;
    building.set(modulePath, null);
    const source = readFileSync(modulePath, "utf8");
    const file = ts.createSourceFile(
        modulePath,
        source,
        ts.ScriptTarget.ES2022,
        true,
    );
    // Rewrite specifiers in the TypeScript source rather than in the emitted
    // JavaScript: the transpiler copies a module specifier through verbatim,
    // so substituting here is exact where a regex over the output is a guess.
    const edits: Array<{ start: number; end: number; text: string }> = [];
    for (const specifier of importSpecifiers(file)) {
        const text = specifier.text;
        if (!text.startsWith("./") && !text.startsWith("../")) {
            throw new Error(
                `Executed module ${modulePath} imports '${text}'; a graph ` +
                    "module may only import its own relative siblings.",
            );
        }
        const sibling = resolve(
            dirname(modulePath),
            text.replace(/\.js$/, ".ts"),
        );
        edits.push({
            start: specifier.getStart(file),
            end: specifier.getEnd(),
            text: JSON.stringify(moduleDataUrl(sibling, building)),
        });
    }
    let rewritten = source;
    for (const edit of edits.sort((left, right) => right.start - left.start)) {
        rewritten = rewritten.slice(0, edit.start) + edit.text +
            rewritten.slice(edit.end);
    }
    const javascript = transpileForBrowser(rewritten, modulePath);
    const url = javascriptModuleUrl(javascript);
    building.set(modulePath, url);
    return url;
}

/** Every module specifier the module names, static and dynamic alike. */
function importSpecifiers(file: ts.SourceFile): ts.StringLiteralLike[] {
    const found: ts.StringLiteralLike[] = [];
    const visit = (node: ts.Node): void => {
        if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteralLike(node.moduleSpecifier)
        ) {
            found.push(node.moduleSpecifier);
        }
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length > 0 &&
            ts.isStringLiteralLike(node.arguments[0]!)
        ) {
            found.push(node.arguments[0] as ts.StringLiteralLike);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}
