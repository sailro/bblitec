/**
 * The typings a program reads a pinned module through when it names the
 * module itself: a subpath import (`babylon-lite/shader/wgsl.js`), and
 * every pinned module those typings name in turn.
 *
 * A subpath names one pinned module, which the pin's own lab type-checks
 * against its source; its typings are the declarations TypeScript's
 * declaration emit writes from that checked source
 * (`PinnedProgram.declarationText`), read at `pinnedModuleTypingsPath`.
 * A type they declare that the entry (`index.d.ts`) exports from the same
 * module is the entry's, re-exported, so one pinned type is one type to a
 * program that spells it both ways; every other declaration is the
 * module's own. The text replays from the bake cache, keyed like the
 * store's sources (`pinnedSourceInputs`).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { cachedBakeSync, moduleIdentity } from "./bake-cache.js";
import { babylonPackages } from "./compiler/symbols.js";
import {
    exportedDeclarations,
    pinnedSourceInputs,
    sharedUpstreamStore,
    type UpstreamSourceStore,
} from "./upstream-source.js";

const typings = new Map<string, string>();

/** A pinned module's typings (see the module comment), by its source path (`src/shader/wgsl.ts`). */
export function pinnedModuleTypings(module: string): string {
    let text = typings.get(module);
    if (text === undefined) {
        text = new TextDecoder().decode(
            cachedBakeSync(
                {
                    kind: "pinned-module-typings",
                    version: "1",
                    module: [
                        import.meta.url,
                        new URL("./upstream-source.js", import.meta.url).href,
                        new URL("./pinned-program.js", import.meta.url).href,
                    ]
                        .map(moduleIdentity)
                        .join(":"),
                    browser: false,
                    buildConditions: true,
                    parameters: { module },
                    inputs: pinnedSourceInputs(),
                },
                () =>
                    new TextEncoder().encode(
                        writeTypings(sharedUpstreamStore(), module),
                    ),
            ),
        );
        typings.set(module, text);
    }
    return text;
}

function writeTypings(store: UpstreamSourceStore, module: string): string {
    const text = store.program.declarationText(module);
    const file = ts.createSourceFile(
        module.replace(/\.ts$/, ".d.ts"),
        text,
        ts.ScriptTarget.Latest,
        false,
    );
    const entry = exportedDeclarations(
        ts.createSourceFile(
            "index.d.ts",
            readFileSync(resolve(store.packageRoot, "index.d.ts"), "utf8"),
            ts.ScriptTarget.Latest,
            false,
        ),
    );
    const shared = [...exportedDeclarations(file)].filter(
        ([name, statements]) =>
            entry.has(name) &&
            statements.every(
                (statement) =>
                    ts.isInterfaceDeclaration(statement) ||
                    ts.isTypeAliasDeclaration(statement) ||
                    ts.isClassDeclaration(statement) ||
                    ts.isEnumDeclaration(statement),
            ) &&
            entryModule(store, name) === module,
    );
    if (!shared.length) return text;
    let result = text;
    for (const statement of shared
        .flatMap(([, statements]) => statements)
        .sort((a, b) => b.pos - a.pos))
        result =
            result.slice(0, statement.getFullStart()) +
            result.slice(statement.end);
    // Imported as well as exported: the declarations left beside them may
    // name them.
    const list = shared
        .map(([name]) => name)
        .sort()
        .join(", ");
    return [
        result,
        `import { ${list} } from "${babylonPackages[1]}";`,
        `export { ${list} };`,
    ].join("\n");
}

/** The pinned module that declares an export of the entry, when one does. */
function entryModule(
    store: UpstreamSourceStore,
    name: string,
): string | undefined {
    const value = store.findPublicExport(name)?.modulePath;
    if (value !== undefined) return value;
    const owners = store.declaringModules(name);
    return owners.length === 1 ? owners[0] : undefined;
}
