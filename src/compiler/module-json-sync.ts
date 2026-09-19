// A scene-adjacent module's pure JSON pass, executed during entry
// compilation.
//
// The entry compiler is synchronous by design and the evaluator behind this
// is not: `executed-module-graph.ts` inlines the module and its relative
// siblings as data URLs and imports the result, so the corpus's own
// TypeScript runs as written under Node. The bridge is the same shape
// `asset-bytes-sync` already uses for a URL that missed the download cache:
// a short-lived child process running that evaluator module, memoized here
// per (module, export, arguments) so a repeat call within a compile never
// launches anything.
import { runGenerationChild } from "./generation-child.js";

/** A pass the child ran but could not fold; `reason` names the class. */
export class ModuleJsonDeclined extends Error {
    constructor(
        exportName: string,
        readonly reason: string,
    ) {
        super(`Running '${exportName}' at generation declined: ${reason}`);
    }
}

type Outcome = { value: unknown } | { declined: string };

/**
 * One child run per (module, export, arguments) within a compile, success
 * and classified decline alike. The outcome is a fact about the files on
 * disk, not emission state, so a rolled-back probe keeps it (a plain Map,
 * not an EmissionMap); an infrastructure failure throws and is never cached.
 */
const outcomes = new Map<string, Outcome>();

/** Separates a pass module's own stdout noise from the child's result. */
const ENVELOPE = "bblite-module-json-envelope:";

export function runModuleJsonSync(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
): unknown {
    const key = JSON.stringify([modulePath, exportName, argumentsJson]);
    let outcome = outcomes.get(key);
    if (outcome === undefined) {
        outcome = runChild(modulePath, exportName, argumentsJson);
        outcomes.set(key, outcome);
    }
    if ("declined" in outcome) {
        throw new ModuleJsonDeclined(exportName, outcome.declined);
    }
    return outcome.value;
}

/**
 * The child classifies every failure of the pass itself -- its module cannot
 * execute (a package import, a missing sibling), it throws, or its result is
 * not a round-trip JSON document -- into an envelope, so the parent can tell
 * a declined pass from a broken child: a nonzero exit or a missing envelope
 * is infrastructure and aborts, never a cached decline. The round-trip test
 * is `JSON.parse(JSON.stringify(value))` compared deeply with the value: a
 * Map or Set becomes `{}`, a Date a string, a non-finite number null, and a
 * function or symbol vanishes, each a rewrite the fold must not commit.
 */
function runChild(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
): Outcome {
    const evaluatorModule = new URL(
        "../executed-module-graph.js",
        import.meta.url,
    ).href;
    const script =
        `import { isDeepStrictEqual } from "node:util";\n` +
        `const source = JSON.parse(process.env.BBLITE_MODULE_JSON_SOURCE);\n` +
        `const graph = await import(process.env.BBLITE_MODULE_JSON_MODULE);\n` +
        `let envelope;\n` +
        `try {\n` +
        `    const value = await graph.executeModuleGraphCall(source, source.argumentsJson);\n` +
        `    const text = JSON.stringify(value);\n` +
        `    envelope = text !== undefined && isDeepStrictEqual(JSON.parse(text), value)\n` +
        `        ? { ok: true, value }\n` +
        `        : { ok: false, reason: "returns a value that is not a plain-data JSON document" };\n` +
        `} catch (error) {\n` +
        `    const message = String(error?.message ?? error);\n` +
        `    envelope = { ok: false, reason: message.startsWith("Executed module ") ? message : "threw at generation: " + message };\n` +
        `}\n` +
        `process.stdout.write(${JSON.stringify(ENVELOPE)} + JSON.stringify(envelope));\n`;
    const raw = runGenerationChild({
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
    });
    const at = raw.lastIndexOf(ENVELOPE);
    if (at < 0) {
        throw new Error(
            `Running '${exportName}' at generation returned no result: ` +
                raw.slice(0, 200),
        );
    }
    const envelope = JSON.parse(raw.slice(at + ENVELOPE.length)) as
        { ok: true; value: unknown } | { ok: false; reason: string };
    return envelope.ok
        ? { value: envelope.value }
        : { declined: envelope.reason };
}

/**
 * A pass folded to its JSON document, or `undefined` when the child
 * classified a decline, so the caller lowers the call as ordinary code. An
 * infrastructure failure still throws.
 */
export function tryModuleJsonDocument(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
): { value: unknown } | undefined {
    try {
        return {
            value: runModuleJsonSync(modulePath, exportName, argumentsJson),
        };
    } catch (error) {
        if (error instanceof ModuleJsonDeclined) return undefined;
        throw error;
    }
}
