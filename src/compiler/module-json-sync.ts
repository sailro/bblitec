// A scene-adjacent module's pure JSON pass, executed during entry
// compilation.
//
// The entry compiler is synchronous by design, and so is the evaluation
// behind this: `executed-module-graph.ts` runs the module graph as CommonJS
// in a fresh realm of this process, so the corpus's own TypeScript runs as
// written without a child process. Each outcome is memoized here per
// (module, export, arguments), so a repeat call within a compile runs
// nothing.
import {
    runModuleJsonPass,
    type ModuleJsonOutcome,
} from "../executed-module-graph.js";

/** A pass generation ran but could not fold; `reason` names the class. */
export class ModuleJsonDeclined extends Error {
    constructor(
        exportName: string,
        readonly reason: string,
    ) {
        super(`Running '${exportName}' at generation declined: ${reason}`);
    }
}

/**
 * One evaluation per (module, export, arguments) within a compile, success
 * and classified decline alike. The outcome is a fact about the files on
 * disk, not emission state, so a rolled-back probe keeps it (a plain Map,
 * not an EmissionMap).
 */
const outcomes = new Map<string, ModuleJsonOutcome>();

/**
 * The pass's JSON document. A pass whose module cannot execute (a package
 * import, a missing sibling), which throws, or whose result is not a
 * round-trip JSON document throws {@link ModuleJsonDeclined}.
 */
export function runModuleJsonSync(
    modulePath: string,
    exportName: string,
    argumentsJson: readonly unknown[],
): unknown {
    const key = JSON.stringify([modulePath, exportName, argumentsJson]);
    let outcome = outcomes.get(key);
    if (outcome === undefined) {
        outcome = runModuleJsonPass(modulePath, exportName, argumentsJson);
        outcomes.set(key, outcome);
    }
    if ("declined" in outcome) {
        throw new ModuleJsonDeclined(exportName, outcome.declined);
    }
    return outcome.value;
}

/**
 * A pass folded to its JSON document, or `undefined` when the pass
 * declined, so the caller lowers the call as ordinary code.
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
