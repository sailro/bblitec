/**
 * A value a scene module BUILDS, read by running the module in this process.
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
 *
 * Every module runs as the CommonJS the browser bakes also execute
 * (`closureModules`): transpiled once, its siblings resolved from the
 * `require` calls its emitted code makes. An import the transpiler erased —
 * a type, or a name used only as one — is therefore never resolved or run,
 * whatever keyword its source spelled it with.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import vm from "node:vm";
import ts from "typescript";
import { resolveRepositoryModuleFile } from "./bake-cache.js";
import type { ExecutedModuleSource } from "./executed-module-assets.js";
import { moduleImportKind } from "./module-imports.js";
import { transpileCommonJs } from "./typescript-transpile.js";
import {
    isRelativeSpecifier,
    moduleSpecifiers,
} from "./typescript-module-specifiers.js";

/** One module of an executed graph, as the CommonJS it runs as. */
export interface ClosureModule {
    /** The module's identity in its graph. */
    key: string;
    javascript: string;
    /** Relative specifier its emitted code requires -> module key. */
    resolved: Record<string, string>;
}

/** An entry module and every sibling its emitted code requires. */
export interface CommonJsModuleGraph {
    entry: string;
    modules: Record<string, ClosureModule>;
}

/** Every specifier the emitted CommonJS passes to `require`, in order. */
function requiredSpecifiers(javascript: string, fileName: string): string[] {
    const file = ts.createSourceFile(
        fileName,
        javascript,
        ts.ScriptTarget.ES2022,
        true,
        ts.ScriptKind.JS,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "require" &&
            node.arguments.length === 1
        ) {
            const specifier = node.arguments[0]!;
            if (ts.isStringLiteralLike(specifier)) found.push(specifier.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
}

/**
 * Each module's CommonJS and the specifiers it requires, by path, reused for
 * as long as the module's source is unchanged: every bake and pass of a
 * generation that reaches a module shares one transpile of it.
 */
const transpiledModules = new Map<
    string,
    { source: string; javascript: string; required: readonly string[] }
>();

function transpiledModule(path: string): {
    javascript: string;
    required: readonly string[];
} {
    const source = readFileSync(path, "utf8");
    const cached = transpiledModules.get(path);
    if (cached?.source === source) return cached;
    const javascript = transpileCommonJs(source, path);
    const transpiled = {
        source,
        javascript,
        required: requiredSpecifiers(javascript, path),
    };
    transpiledModules.set(path, transpiled);
    return transpiled;
}

/**
 * The entry and every repository sibling its emitted code requires, as
 * CommonJS.
 *
 * A relative `require` must resolve through the suite server's resolver
 * (`resolveRepositoryModuleFile`), so a sibling spelled with `.js`, no
 * extension, or as a directory `index.ts` joins the graph as the file it
 * serves. A package specifier is left to whoever evaluates the graph: the
 * browser drivers stand the pinned package in, and the Node evaluator below
 * refuses it. `keyOf` names each module in the graph, or refuses one that
 * cannot join it.
 */
export function commonJsModuleGraph(
    entryPath: string,
    keyOf: (path: string) => string | undefined,
): { graph: CommonJsModuleGraph } | { refusal: string } {
    const outside = (path: string): { refusal: string } => ({
        refusal: `Executed module ${path} is outside the repository.`,
    });
    const entry = keyOf(entryPath);
    if (entry === undefined) return outside(entryPath);
    const modules: Record<string, ClosureModule> = {};
    const queue = [{ path: entryPath, key: entry }];
    const queued = new Set([entry]);
    for (let next = queue.shift(); next; next = queue.shift()) {
        const { javascript, required } = transpiledModule(next.path);
        const resolved: Record<string, string> = {};
        for (const specifier of required) {
            if (
                !isRelativeSpecifier(specifier) ||
                Object.hasOwn(resolved, specifier)
            )
                continue;
            const sibling = resolveRepositoryModuleFile(
                resolve(dirname(next.path), specifier),
            );
            if (sibling === undefined) {
                return {
                    refusal:
                        `Executed module ${next.path} imports '${specifier}'; ` +
                        "no sibling module resolves to that path.",
                };
            }
            const key = keyOf(sibling);
            if (key === undefined) return outside(sibling);
            resolved[specifier] = key;
            if (!queued.has(key)) {
                queued.add(key);
                queue.push({ path: sibling, key });
            }
        }
        modules[next.key] = { key: next.key, javascript, resolved };
    }
    return { graph: { entry, modules } };
}

type CompileModule = (module: ClosureModule) => (...args: unknown[]) => void;

/** Evaluated modules by key, with the CommonJS they evaluated; null while
 *  a module is still evaluating. */
type LoadedModules = Map<
    string,
    { javascript: string; exports: unknown } | null
>;

/**
 * Evaluate a graph's entry and return its exports. A package import refuses
 * where it is required, and so does a cycle: a graph module is plain data.
 * A module already in `loaded` from the same CommonJS is not evaluated
 * again; one that throws leaves no entry, so a later load throws again.
 */
function evaluateGraph(
    graph: CommonJsModuleGraph,
    compile: CompileModule,
    loaded: LoadedModules,
): unknown {
    const load = (key: string): unknown => {
        const record = graph.modules[key]!;
        const existing = loaded.get(key);
        if (existing === null) {
            throw new Error(
                `Executed module ${key} imports itself; a graph module ` +
                    "is plain data and cannot be cyclic.",
            );
        }
        if (existing?.javascript === record.javascript) return existing.exports;
        loaded.set(key, null);
        const module: { exports: unknown } = { exports: {} };
        const require = (specifier: string): unknown => {
            if (Object.hasOwn(record.resolved, specifier))
                return load(record.resolved[specifier]!);
            throw new Error(
                `Executed module ${key} imports '${specifier}'; a graph ` +
                    "module may only import its own relative siblings.",
            );
        };
        try {
            compile(record)(module, module.exports, require);
        } catch (error) {
            loaded.delete(key);
            throw error;
        }
        loaded.set(key, {
            javascript: record.javascript,
            exports: module.exports,
        });
        return module.exports;
    };
    return load(graph.entry);
}

/** One export of an evaluated module, whatever the module's exports are. */
function exportOf(exports: unknown, name: string): unknown {
    return typeof exports === "object" && exports !== null
        ? (Reflect.get(exports, name) as unknown)
        : undefined;
}

/** A CommonJS module body, compiled in `context` (this realm when omitted). */
function moduleFunction(
    module: ClosureModule,
    context?: vm.Context,
): (...args: unknown[]) => void {
    const body = vm.compileFunction(
        module.javascript,
        ["module", "exports", "require"],
        {
            filename: module.key,
            ...(context ? { parsingContext: context } : {}),
        },
    );
    return (...args) => {
        Reflect.apply(body, undefined, args);
    };
}

/**
 * The modules this process has evaluated for the compose step, by path. Like
 * the module map of the import they replace, a module evaluates once per
 * process: two graphs read from one module, or from modules sharing a
 * sibling, see one instance of it.
 */
const composeModules: LoadedModules = new Map();

/**
 * Run a scene module and return the object one of its exports holds.
 *
 * The module runs in this realm, so the graph it builds is an ordinary
 * object of this process, exactly as the compose step reads it.
 */
export async function executeModuleGraph(
    source: ExecutedModuleSource,
): Promise<Record<string, unknown>> {
    const built = commonJsModuleGraph(source.modulePath, (path) => path);
    if ("refusal" in built) throw new Error(built.refusal);
    const value = exportOf(
        evaluateGraph(
            built.graph,
            (module) => moduleFunction(module),
            composeModules,
        ),
        source.exportName,
    );
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(
            `Module export ${source.exportName} in ${source.modulePath} is ` +
                "not an object.",
        );
    }
    return value as Record<string, unknown>;
}

/** A pass folded to its JSON document, or why generation cannot fold it. */
export type ModuleJsonOutcome = { value: unknown } | { declined: string };

/** The decline a pass that threw (or refused an import) reports. */
function thrownAtGeneration(error: unknown): { declined: string } {
    const message =
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
            ? error.message
            : String(error);
    return {
        declined: message.startsWith("Executed module ")
            ? message
            : `threw at generation: ${message}`,
    };
}

/**
 * The value a scene module's own function BUILDS from arguments generation
 * already knows, read by running that function in this process.
 *
 * The same route and the same boundary as the export above, one call
 * deeper: scene 140 derives its caster graph from its receiver graph by
 * wiring an alpha discard into it, and that wiring is the corpus's own
 * TypeScript. Executing it is right for the reason this file opens with --
 * a graph is structure, and nothing about assembling one can differ
 * between two ECMAScript engines -- which is also why it earns no
 * adaptation where the pixel routes do.
 *
 * The pass runs in a fresh ECMAScript realm holding the language's own
 * globals and nothing of the host, so neither can reach the other: a pass
 * that needs a host API throws, and its module's globals do not outlive
 * it. Promise jobs run as soon as the call returns, so a pass that only
 * awaits its own promises settles; one still waiting on anything else
 * declines. The arguments and the result are plain JSON: anything else
 * would be a value this route cannot promise two engines agree on. The
 * round-trip test is `JSON.parse(JSON.stringify(value))` compared deeply
 * with the value -- a Map or Set becomes `{}`, a Date a string, a
 * non-finite number null, and a function or symbol vanishes, each a
 * rewrite the fold must not commit.
 */
export function runModuleJsonPass(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
): ModuleJsonOutcome {
    const built = commonJsModuleGraph(modulePath, (path) => path);
    if ("refusal" in built) return { declined: built.refusal };
    const realm: Record<string, unknown> = {};
    const context = vm.createContext(realm, {
        name: `generation pass ${exportName}`,
        microtaskMode: "afterEvaluate",
    });
    const parse: unknown = vm.runInContext("JSON.parse", context);
    if (typeof parse !== "function") {
        throw new Error("A generation pass realm has no JSON.parse.");
    }
    const parseInRealm = (text: string): unknown =>
        Reflect.apply(parse, undefined, [text]) as unknown;
    let result: unknown;
    try {
        const target = exportOf(
            evaluateGraph(
                built.graph,
                (module) => moduleFunction(module, context),
                new Map(),
            ),
            exportName,
        );
        if (typeof target !== "function") {
            throw new Error(
                `Module export ${exportName} in ${modulePath} is not a function.`,
            );
        }
        const args = parseInRealm(JSON.stringify(argumentsJson));
        result = Reflect.apply(
            target,
            undefined,
            Array.isArray(args) ? args : [],
        ) as unknown;
    } catch (error) {
        return thrownAtGeneration(error);
    }
    // The settling callbacks belong to the pass's realm, so their jobs join
    // the queue the evaluation drains before `runInContext` returns.
    realm.__bblPending = result;
    realm.__bblOutcome = undefined;
    vm.runInContext(
        "Promise.resolve(__bblPending).then(" +
            "(value) => { __bblOutcome = { value }; }, " +
            "(error) => { __bblOutcome = { error }; });",
        context,
    );
    const outcome = realm.__bblOutcome;
    if (typeof outcome !== "object" || outcome === null) {
        return {
            declined:
                "does not settle at generation: it waits on something " +
                "outside the pass",
        };
    }
    if ("error" in outcome) return thrownAtGeneration(outcome.error);
    const value = "value" in outcome ? outcome.value : undefined;
    let text: string | undefined;
    try {
        text = JSON.stringify(value);
    } catch (error) {
        return thrownAtGeneration(error);
    }
    if (text === undefined || !isDeepStrictEqual(parseInRealm(text), value)) {
        return {
            declined: "returns a value that is not a plain-data JSON document",
        };
    }
    const document: unknown = JSON.parse(text);
    return { value: document };
}

/**
 * Whether a module's own imports reach a package. The executed graph refuses
 * such a module, so a caller can decline before running anything to learn
 * it; a sibling that reaches one is still the evaluation's to discover.
 */
export function moduleReachesPackage(file: ts.SourceFile): boolean {
    return moduleSpecifiers(file).some((specifier) => {
        const declaration = specifier.parent;
        const erased =
            (ts.isImportDeclaration(declaration) ||
                ts.isExportDeclaration(declaration)) &&
            moduleImportKind(declaration) === "type";
        return !erased && !isRelativeSpecifier(specifier.text);
    });
}
