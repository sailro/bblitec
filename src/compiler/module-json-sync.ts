// A scene-adjacent module's pure JSON pass, executed during entry
// compilation.
//
// The entry compiler is synchronous by design and the evaluator behind this
// is not -- it serves the module (and its siblings) through the suite
// server so the corpus's own TypeScript runs as written, which needs a
// browser. The bridge is the same shape `asset-bytes-sync` already uses for
// a URL that missed the download cache: a short-lived child process running
// the repository's own evaluator module, so there is one evaluator and one
// bake cache rather than a second copy of either. A repeat compile replays
// from that cache and never launches anything.
import { EmissionMap, EmissionSet } from "./emission-transaction.js";
import { runGenerationChild } from "./generation-child.js";

/** One evaluation per (module, export, arguments) within a compile. */
const resultsByKey = new EmissionMap<string, unknown>();

/** Keys whose pass could not run at generation, or ran to a non-document value. */
const declinedKeys = new EmissionSet<string>();

export function runModuleJsonSync(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
    options: { requireDocument?: boolean } = {},
): unknown {
    const requireDocument = options.requireDocument === true;
    const key = JSON.stringify([modulePath, exportName, argumentsJson, requireDocument]);
    if (resultsByKey.has(key)) return resultsByKey.get(key);
    const evaluatorModule = new URL(
        "../executed-module-graph.js",
        import.meta.url,
    ).href;
    // When the caller requires a document, the child rejects a value the
    // fold would silently rewrite (a Map, a Date), so the pass declines to
    // ordinary lowering instead of folding to wrong data.
    const script =
        `const source = JSON.parse(process.env.BBLITE_MODULE_JSON_SOURCE);\n` +
        `import(process.env.BBLITE_MODULE_JSON_MODULE)\n` +
        `    .then((graph) => Promise.resolve(graph.executeModuleGraphCall(\n` +
        `        source, source.argumentsJson)).then((value) => {\n` +
        `        if (source.requireDocument && !graph.isRoundTripJsonData(value)) {\n` +
        `            throw new Error("returns a value that is not a plain-data JSON document");\n` +
        `        }\n` +
        `        process.stdout.write(JSON.stringify(value));\n` +
        `    }))\n` +
        `    .catch((error) => {\n` +
        `        console.error(String(error?.message ?? error));\n` +
        `        process.exit(1);\n` +
        `    });\n`;
    const value: unknown = JSON.parse(
        runGenerationChild({
            script,
            label: `Running '${exportName}' at generation`,
            env: {
                BBLITE_MODULE_JSON_SOURCE: JSON.stringify({
                    modulePath,
                    exportName,
                    argumentsJson,
                    requireDocument,
                }),
                BBLITE_MODULE_JSON_MODULE: evaluatorModule,
            },
            maxBuffer: 512 * 1024 * 1024,
        }),
    );
    resultsByKey.set(key, value);
    return value;
}

/**
 * A pass run at generation as a JSON document, or `undefined` when it cannot
 * be one: its module fails to execute (a package import, a missing sibling)
 * or its result is a value `JSON.stringify` would rewrite. The caller then
 * lowers the call as ordinary code rather than aborting the compile.
 */
export function tryModuleJsonDocument(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
): { value: unknown } | undefined {
    const key = JSON.stringify([modulePath, exportName, argumentsJson, "document"]);
    if (declinedKeys.has(key)) return undefined;
    try {
        return { value: runModuleJsonSync(modulePath, exportName, argumentsJson, { requireDocument: true }) };
    } catch {
        declinedKeys.add(key);
        return undefined;
    }
}
