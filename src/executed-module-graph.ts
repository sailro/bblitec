/**
 * A value a scene module BUILDS, read by running the module under Node.
 *
 * This is the third executed-module route and the only one that needs no
 * browser. Its siblings in `executed-module-assets.ts` produce *pixels* — a
 * canvas2D atlas and a computed buffer — so they run where the golden runs
 * them and record an adaptation for it. A node-material graph is structure:
 * an object of numbers, strings and arrays assembled from id counters and
 * `push`, with no Math, no browser global and no import in any of the seven
 * corpus modules that write one. Nothing about it can differ between two
 * ECMAScript engines, so running it in Chromium would buy a launch per graph
 * and an adaptation whose stated risk would not be true.
 *
 * What it is NOT is a licence to lower less. A module reaching outside plain
 * data fails here, at its own import, rather than being executed against a
 * shim — which is the same boundary the browser route draws, one engine over.
 */
import { readFileSync } from "node:fs";
import { transpileForBrowser } from "./browser-harness.js";
import type { ExecutedModuleSource } from "./executed-module-assets.js";

/**
 * Run a scene module and return the object one of its exports holds.
 *
 * The module is transpiled and imported through a `data:` URL — the same
 * mechanism `pinned-shader-composer.ts` uses to import a pinned module with
 * substitutions — so nothing is written to disk and the module's own
 * `import` statements would fail to resolve rather than resolving to
 * something else.
 */
export async function executeModuleGraph(
    source: ExecutedModuleSource,
): Promise<Record<string, unknown>> {
    const javascript = transpileForBrowser(
        readFileSync(source.modulePath, "utf8"),
        source.modulePath,
    );
    const url = `data:text/javascript;base64,${
        Buffer.from(javascript, "utf8").toString("base64")
    }`;
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
