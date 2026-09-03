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
import { runGenerationChild } from "./generation-child.js";

/** One evaluation per (module, export, arguments) within a compile. */
const resultsByKey = new Map<string, unknown>();

export function runModuleJsonSync(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
): unknown {
    const key = JSON.stringify([modulePath, exportName, argumentsJson]);
    if (resultsByKey.has(key)) return resultsByKey.get(key);
    const evaluatorModule = new URL(
        "../executed-module-graph.js",
        import.meta.url,
    ).href;
    const script =
        `const source = JSON.parse(process.env.BBLITE_MODULE_JSON_SOURCE);\n` +
        `import(process.env.BBLITE_MODULE_JSON_MODULE)\n` +
        `    .then((graph) => graph.executeModuleGraphCall(\n` +
        `        source, source.argumentsJson))\n` +
        `    .then((value) => {\n` +
        `        process.stdout.write(JSON.stringify(value));\n` +
        `    })\n` +
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
                }),
                BBLITE_MODULE_JSON_MODULE: evaluatorModule,
            },
            maxBuffer: 512 * 1024 * 1024,
        }),
    );
    resultsByKey.set(key, value);
    return value;
}
