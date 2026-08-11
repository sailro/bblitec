import {
    dirname,
    resolve,
    sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
    findRepositoryRoot,
} from "../upstream-source.js";

let sharedSourceFiles:
    | Map<string, ts.SourceFile>
    | undefined;

function cachedSourceFile(
    path: string,
    load: () => ts.SourceFile | undefined,
): ts.SourceFile | undefined {
    sharedSourceFiles ??= new Map();
    const key = resolve(path);
    const cached = sharedSourceFiles.get(key);
    if (cached) {
        return cached;
    }
    const sourceFile = load();
    if (sourceFile) {
        sharedSourceFiles.set(key, sourceFile);
    }
    return sourceFile;
}

function canCacheSourceFile(path: string): boolean {
    return resolve(path).includes(
        `${sep}node_modules${sep}`,
    );
}

export interface CompilerProgram {
    program: ts.Program;
    checker: ts.TypeChecker;
    sourceFile: ts.SourceFile;
}

export function createCompilerProgram(
    source: string,
    fileName: string,
): CompilerProgram {
    const rootName = resolve(fileName);
    const repositoryRoot = findRepositoryRoot(
        dirname(fileURLToPath(import.meta.url)),
    );
    const babylonTypes = resolve(
        repositoryRoot,
        "node_modules",
        "@babylonjs",
        "lite",
        "index.d.ts",
    );
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
    };
    const defaultHost = ts.createCompilerHost(options, true);
    const host: ts.CompilerHost = {
        ...defaultHost,
        fileExists: (path) =>
            resolve(path) === rootName ||
            defaultHost.fileExists(path),
        readFile: (path) =>
            resolve(path) === rootName
                ? source
                : defaultHost.readFile(path),
        getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) => {
            if (resolve(path) === rootName) {
                return ts.createSourceFile(
                    rootName,
                    source,
                    languageVersion,
                    true,
                    ts.ScriptKind.TS,
                );
            }
            const load = () =>
                defaultHost.getSourceFile(
                    path,
                    languageVersion,
                    onError,
                    shouldCreateNewSourceFile,
                );
            return canCacheSourceFile(path)
                ? cachedSourceFile(path, load)
                : load();
        },
        resolveModuleNameLiterals: (
            moduleLiterals,
            containingFile,
            redirectedReference,
            compilerOptions,
        ) =>
            moduleLiterals.map((moduleLiteral) => {
                const moduleName = moduleLiteral.text;
                if (
                    moduleName === "babylon-lite" ||
                    moduleName === "@babylonjs/lite"
                ) {
                    return {
                        resolvedModule: {
                            resolvedFileName: babylonTypes,
                            extension: ts.Extension.Dts,
                            isExternalLibraryImport: true,
                        },
                    };
                }
                return ts.resolveModuleName(
                    moduleName,
                    containingFile,
                    compilerOptions,
                    defaultHost,
                    undefined,
                    redirectedReference,
                );
            }),
    };
    const program = ts.createProgram([rootName], options, host);
    const sourceFile = program.getSourceFile(rootName);
    if (!sourceFile) {
        throw new Error(`Unable to create TypeScript program for '${fileName}'.`);
    }
    return {
        program,
        checker: program.getTypeChecker(),
        sourceFile,
    };
}
