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
import { resolveRepositoryModuleFile } from "./bake-cache.js";
import { transpileForBrowser } from "./browser-harness.js";
import { javascriptModuleUrl } from "./data-url.js";
import type { ExecutedModuleSource } from "./executed-module-assets.js";
import { moduleImportKind } from "./module-imports.js";
import { moduleSpecifiers } from "./typescript-module-specifiers.js";

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
// Referenced by name from the generation-child script in src/compiler/module-json-sync.ts.
/**
 * Whether a value survives `JSON.stringify` then `JSON.parse` unchanged, so
 * folding a pass to it is faithful. Plain objects, arrays and finite
 * primitives do; a Map or Set becomes `{}`, a Date a string, a function or
 * symbol vanishes, and a non-finite number becomes null -- each a value the
 * fold would silently rewrite, so the pass lowers as an ordinary call
 * instead. An undefined object property is dropped, which is the document
 * behavior `JSON.stringify` already defines, so it is allowed.
 */
export function isRoundTripJsonData(
    value: unknown,
    seen: Set<object> = new Set(),
): boolean {
    if (value === null) return true;
    const type = typeof value;
    if (type === "string" || type === "boolean") return true;
    if (type === "number") return Number.isFinite(value);
    if (type !== "object") return false;
    if (seen.has(value as object)) return false;
    seen.add(value as object);
    if (Array.isArray(value)) {
        return value.every((element) => isRoundTripJsonData(element, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Object.values(value as Record<string, unknown>).every(
        (property) => property === undefined || isRoundTripJsonData(property, seen),
    );
}

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
    for (const specifier of moduleSpecifiers(file)) {
        // A type-only import is erased by the transpiler and never runs, so
        // the module it names is not part of the executed graph.
        const declaration = specifier.parent;
        if (
            (ts.isImportDeclaration(declaration) ||
                ts.isExportDeclaration(declaration)) &&
            moduleImportKind(declaration) === "type"
        ) {
            continue;
        }
        const text = specifier.text;
        if (!text.startsWith("./") && !text.startsWith("../")) {
            throw new Error(
                `Executed module ${modulePath} imports '${text}'; a graph ` +
                    "module may only import its own relative siblings.",
            );
        }
        // The same resolver that keys this module's bake, so a sibling
        // spelled with `.js`, no extension, or as a directory `index.ts`
        // executes as the file the cache identity already named.
        const sibling = resolveRepositoryModuleFile(
            resolve(dirname(modulePath), text),
        );
        if (sibling === undefined) {
            throw new Error(
                `Executed module ${modulePath} imports '${text}'; no sibling ` +
                    "module resolves to that path.",
            );
        }
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
