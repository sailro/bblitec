/**
 * A type-checked program over recovered pinned sources.
 *
 * The record lowerer reads each pinned expression's type from the checker
 * rather than from its spelling: a local's storage, a member's shape and a
 * narrowed read all come from the pin's own declarations. The program holds
 * the requested modules plus the ones they import (relative specifiers,
 * resolved through the store), TypeScript's ES2022 library and the pin's
 * WebGPU peer typings. Package imports the store does not carry (the text
 * shaper) stay unresolved; a lowered body that reaches one fails where it
 * does.
 */
import ts from "typescript";
import { compilerPackageTypings } from "../compiler/symbols.js";
import type { UpstreamSourceStore } from "../upstream-source.js";

export interface PinnedTypedProgram {
    readonly program: ts.Program;
    readonly checker: ts.TypeChecker;
    sourceFile(modulePath: string): ts.SourceFile;
}

const programs = new WeakMap<
    UpstreamSourceStore,
    Map<string, PinnedTypedProgram>
>();

/** The store path a program file name stands for, if it is a pinned module. */
function storePath(fileName: string): string | undefined {
    const normalized = fileName.replaceAll("\\", "/");
    if (normalized.includes("/node_modules/")) return undefined;
    const at = normalized.lastIndexOf("/src/");
    if (normalized.startsWith("src/")) return normalized;
    return at >= 0 ? normalized.slice(at + 1) : undefined;
}

/** One checked program per store and root set, built on first use. */
export function pinnedTypedProgram(
    store: UpstreamSourceStore,
    roots: readonly string[],
): PinnedTypedProgram {
    const key = [...roots].sort().join("\n");
    let byRoots = programs.get(store);
    if (!byRoots) {
        byRoots = new Map<string, PinnedTypedProgram>();
        programs.set(store, byRoots);
    }
    const existing = byRoots.get(key);
    if (existing) return existing;
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ["lib.es2022.d.ts"],
        types: [],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const readLibrary = host.getSourceFile.bind(host);
    const parsed = new Map<string, ts.SourceFile>();
    host.getSourceFile = (fileName, languageVersion) => {
        const path = storePath(fileName);
        if (path === undefined || !store.hasSource(path))
            return readLibrary(fileName, languageVersion);
        let file = parsed.get(path);
        if (!file) {
            file = ts.createSourceFile(
                path,
                store.getSource(path),
                languageVersion,
                true,
                ts.ScriptKind.TS,
            );
            parsed.set(path, file);
        }
        return file;
    };
    host.fileExists = (fileName) => {
        const path = storePath(fileName);
        return path !== undefined && store.hasSource(path)
            ? true
            : ts.sys.fileExists(fileName);
    };
    host.resolveModuleNameLiterals = (literals, containingFile) =>
        literals.map((literal) => {
            const from = storePath(containingFile);
            const resolved =
                from === undefined
                    ? undefined
                    : store.resolveImport(from, literal.text);
            return {
                resolvedModule: resolved
                    ? {
                          resolvedFileName: resolved,
                          extension: ts.Extension.Ts,
                          isExternalLibraryImport: false,
                      }
                    : undefined,
            };
        });
    const program = ts.createProgram({
        rootNames: [...roots, compilerPackageTypings().webGpu],
        options,
        host,
    });
    const result: PinnedTypedProgram = {
        program,
        checker: program.getTypeChecker(),
        sourceFile(modulePath) {
            const file = program.getSourceFile(modulePath);
            if (!file)
                throw new Error(
                    `Pinned module ${modulePath} is not part of the typed program.`,
                );
            return file;
        },
    };
    byRoots.set(key, result);
    return result;
}
