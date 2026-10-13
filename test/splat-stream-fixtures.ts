import type { LoweredRecordFamily } from "../src/lowering/splat-stream-records.js";
import {
    createJavaScriptFunction,
    transpileCommonJs,
} from "../src/typescript-transpile.js";
import { sharedUpstreamStore } from "../src/upstream-source.js";

/** One pinned module's CommonJS exports under Node. */
export type Exports = Record<string, unknown>;

/** Each pinned module's CommonJS text, transpiled once per test process. */
const transpiled = new Map<string, string>();

/**
 * The pinned modules `roots` reach, as CommonJS under Node, each evaluated
 * once: `globals` are the free names their code reads (the test's own
 * platform), `stubs` stand for modules the scenario never runs.
 */
export function pinnedModules(
    roots: readonly string[],
    options: {
        readonly globals?: Readonly<Record<string, unknown>>;
        readonly stubs?: ReadonlyMap<string, Exports>;
    } = {},
): Map<string, Exports> {
    const store = sharedUpstreamStore();
    const loaded = new Map<string, Exports>();
    const globals = options.globals ?? {};
    const names = Object.keys(globals);
    const load = (module: string): Exports => {
        const known = loaded.get(module) ?? options.stubs?.get(module);
        if (known) return known;
        const exports: Exports = {};
        loaded.set(module, exports);
        const require = (specifier: string): Exports => {
            const target = store.resolveImport(module, specifier);
            if (!target)
                throw new Error(`${module} imports unresolved ${specifier}.`);
            return load(target);
        };
        let code = transpiled.get(module);
        if (code === undefined) {
            code = transpileCommonJs(store.getSource(module), module);
            transpiled.set(module, code);
        }
        createJavaScriptFunction(
            "exports",
            "require",
            ...names,
            code,
        )(exports, require, ...names.map((name) => globals[name]));
        return exports;
    };
    for (const module of roots) load(module);
    return loaded;
}

/** A lowered splat-stream record family as the header a fixture includes. */
export function splatStreamFamilyHeader(family: LoweredRecordFamily): string {
    const includes = [
        "bblite/pinned_records.hpp",
        "bblite/gpu.hpp",
        "bblite/web_platform.hpp",
        ...family.includes,
    ];
    return `#pragma once
${includes.map((header) => `#include <${header}>`).join("\n")}
namespace bbl {
${family.structs}
${family.declarations}
${family.definitions}
} // namespace bbl
`;
}
