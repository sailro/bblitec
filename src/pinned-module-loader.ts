import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { statementDeclaredNames } from "./compiler/syntax.js";

const requireModule = createRequire(import.meta.url);
interface AugmentedModule {
    file: string;
    names: readonly string[];
    bindings?: Readonly<Record<string, unknown>>;
}
const modules = new Map<string, AugmentedModule>();
const exportedAlias = "__bblitecExecuted_";

/** Both loading modes execute the same content-addressed module instance. */
function augmentedModule(text: string, origin: string) {
    let entry = modules.get(text);
    if (!entry) {
        const names = [...new Set(topLevelDeclarations(text, origin))];
        const exports = names
            .map((name) => name + " as " + exportedAlias + name)
            .join(", ");
        entry = {
            names,
            file: augmentedModuleFile(text + "\nexport { " + exports + " };\n"),
        };
        modules.set(text, entry);
    }
    return entry;
}

function bindings(
    namespace: unknown,
    names: readonly string[],
): Readonly<Record<string, unknown>> {
    if (typeof namespace !== "object" || namespace === null)
        throw new Error("Pinned module did not load a namespace.");
    const read = (name: string): unknown => Reflect.get(namespace, name);
    return Object.fromEntries<unknown>([
        ...Object.keys(namespace)
            .filter((name) => !name.startsWith(exportedAlias))
            .map((name): [string, unknown] => [name, read(name)]),
        ...names.map((name): [string, unknown] => [
            name,
            read(exportedAlias + name),
        ]),
    ]);
}

/** Load already anchored source with its module-scope declarations exported. */
export function loadAugmentedModule(
    text: string,
    origin: string,
): Readonly<Record<string, unknown>> {
    const entry = augmentedModule(text, origin);
    if (entry.bindings) return entry.bindings;
    const namespace: unknown = requireModule(entry.file);
    return (entry.bindings = bindings(namespace, entry.names));
}

/** Asynchronous loading also supports modules containing top-level await. */
export async function importAugmentedModule(
    text: string,
    origin: string,
): Promise<Readonly<Record<string, unknown>>> {
    const entry = augmentedModule(text, origin);
    if (entry.bindings) return entry.bindings;
    const namespace: unknown = await import(pathToFileURL(entry.file).href);
    return (entry.bindings ??= bindings(namespace, entry.names));
}

/** The names a packaged module declares at its top level, from its syntax. */
function topLevelDeclarations(text: string, fileName: string): string[] {
    const file = ts.createSourceFile(
        fileName,
        text,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
    );
    return file.statements.flatMap((statement) =>
        statementDeclaredNames(statement).map((name) => name.text),
    );
}

/** The augmented module, written once per content under the OS temp directory. */
function augmentedModuleFile(text: string): string {
    const directory = join(tmpdir(), "bblitec-pinned-modules");
    mkdirSync(directory, { recursive: true });
    const file = join(
        directory,
        `${createHash("sha256").update(text).digest("hex")}.mjs`,
    );
    if (!existsSync(file)) {
        // Parallel generations may write the same content; the rename makes
        // the file whole before anyone can load it.
        const pending = `${file}.${process.pid}.tmp`;
        writeFileSync(pending, text);
        try {
            renameSync(pending, file);
        } catch (error: unknown) {
            rmSync(pending, { force: true });
            if (!existsSync(file)) throw error;
        }
    }
    return file;
}
