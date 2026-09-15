/** Node --import preload: collect actual compileSource inputs in test workers. */
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { observeSourceTrace } from "./compiler/source-trace.js";
import { apiHash, loadApiSurface, type ApiSurface } from "./api-surface.js";
import { scanApiUsage } from "./api-usage.js";
import { findRepositoryRoot, repositoryRelativePath } from "./upstream-source.js";
import { sharedUpstreamStore } from "./upstream-source.js";
import { observePinnedTranslation } from "./lowering/translation-trace.js";

const output = process.env.BBLITE_API_TRACE_DIR;
if (output) {
    const root = findRepositoryRoot(process.cwd());
    const directory = resolve(output);
    mkdirSync(directory, { recursive: true });
    let surface: ApiSurface | undefined;
    const suite = (): string => process.env.BBLITE_API_SCENE ?? repositoryRelativePath(root, process.argv[1] ?? "unknown");
    const translations = new Set<string>();
    observePinnedTranslation(trace => {
        const store = sharedUpstreamStore();
        const modulePath = trace.file.fileName.replaceAll("\\", "/");
        if (!store.hasSource(modulePath) || store.getSource(modulePath) !== trace.file.text) return;
        const metadata = { kind: "translation", suite: suite(), modulePath,
            symbolName: trace.symbolName, extent: trace.extent, adapters: trace.adapters, requests: trace.requests };
        const key = JSON.stringify(metadata);
        if (translations.has(key)) return;
        translations.add(key);
        const record = JSON.stringify({ ...metadata, source: apiHash(trace.file.text) });
        appendFileSync(join(directory, `${process.pid}.jsonl`), record + "\n");
    });
    observeSourceTrace(traces => {
        surface ??= loadApiSurface();
        for (const trace of traces) {
            const usage = scanApiUsage(trace.program, surface, root, trace.nodes);
            const source = apiHash(JSON.stringify(usage.files));
            appendFileSync(join(directory, `${process.pid}.jsonl`), JSON.stringify({
                suite: suite(),
                source, files: usage.files, uses: usage.uses,
            }) + "\n");
        }
    });
}
