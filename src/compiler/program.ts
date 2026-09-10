import { EmissionMap } from "./emission-transaction.js";
import {
    dirname,
    relative,
    resolve,
    sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isBabylonModule } from "./symbols.js";
import { LoweringContext } from "../lowering/context.js";
import {
    findRepositoryRoot,
    repositoryRelativePath,
    sharedUpstreamStore,
} from "../upstream-source.js";

let sharedSourceFiles:
    | Map<string, ts.SourceFile>
    | undefined;

function cachedSourceFile(
    path: string,
    load: () => ts.SourceFile | undefined,
): ts.SourceFile | undefined {
    sharedSourceFiles ??= new EmissionMap();
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

/**
 * The pinned members the published typings erase.
 *
 * `index.d.ts` is rolled up with `@internal` members stripped, so a member a
 * corpus scene reaches has no declared type at all and every read of it falls
 * out of the type model — which would leave each such read restating its own
 * type somewhere in the compiler. The declaration is restored here instead,
 * at the one seam where Babylon typings enter the program, and it is restored
 * from the PINNED SOURCE rather than written out: what is appended is the
 * member's own text, so a rename or a changed element type fails generation
 * instead of quietly losing its model.
 *
 * TypeScript merges a re-opened interface within one file, so the restored
 * members ride as a second declaration appended to the typings.
 */
const erasedInternalMembers: readonly {
    /** The pinned module declaring the interface. */
    module: string;
    /** The interface the published typings also declare. */
    interfaceName: string;
    /** The member `@internal` removed. */
    member: string;
}[] = [
    // `AssetContainer._gaussianSplats`: the clouds the pinned
    // KHR_gaussian_splatting feature contributes, one promise per GS
    // primitive. Scene 226 reads it, and its element type is what tells the
    // handle-collection concept what a member binds as.
    {
        module: "src/asset-container.ts",
        interfaceName: "AssetContainer",
        member: "_gaussianSplats",
    },
];

/**
 * The restored declarations, appended to the typings once per process.
 *
 * `cachedSourceFile` keeps the composed typings for the life of the process,
 * so this runs on the first compile alone.
 */
function pinnedInternalDeclarations(): string {
    const context = new LoweringContext(sharedUpstreamStore());
    return erasedInternalMembers
        .map((erased) => {
            const { file, declaration } = context.interfaceDeclaration(
                erased.module,
                erased.interfaceName,
            );
            const member = declaration.members.find(
                (candidate) =>
                    candidate.name !== undefined &&
                    context.propertyName(candidate.name) === erased.member,
            );
            if (!member) {
                return context.contractError(
                    declaration,
                    `Expected ${erased.interfaceName} to declare ` +
                        `'${erased.member}': the published typings erase it, ` +
                        "so this port restores its declaration and cannot " +
                        "restore one that moved.",
                );
            }
            return (
                `export declare interface ${erased.interfaceName} {` +
                `${member.getText(file)}}`
            );
        })
        .join("\n");
}

/**
 * The bundler convention `import text from "./shader.wgsl?raw"`: the file's
 * bytes as a string. The import resolves to a synthesized module beside the
 * file, spelled with this suffix, whose default export is that string.
 * The generation record lists the text file itself as the input it read.
 */
const RAW_TEXT_MODULE_SUFFIX = ".raw-text-import.ts";

/** The synthesized module a `?raw` specifier resolves to, or undefined for any other specifier. */
function rawTextImportPath(
    moduleName: string,
    containingFile: string,
): string | undefined {
    if (!moduleName.endsWith("?raw")) {
        return undefined;
    }
    const relativePath = moduleName.slice(0, -"?raw".length);
    return resolve(dirname(containingFile), relativePath) + RAW_TEXT_MODULE_SUFFIX;
}

/** The text file a synthesized raw-text module carries, or undefined for a real path. */
function rawTextSourcePath(path: string): string | undefined {
    return path.endsWith(RAW_TEXT_MODULE_SUFFIX)
        ? path.slice(0, -RAW_TEXT_MODULE_SUFFIX.length)
        : undefined;
}

/** The synthesized module's source: the text file's bytes as one default export. */
function rawTextModuleSource(
    path: string,
    host: ts.CompilerHost,
): string | undefined {
    const textPath = rawTextSourcePath(path);
    if (textPath === undefined) {
        return undefined;
    }
    const text = host.readFile(textPath);
    if (text === undefined) {
        throw new Error(`Raw text import reads '${textPath}', which does not exist.`);
    }
    return `const rawText = ${JSON.stringify(text)};\nexport default rawText;\n`;
}

export interface CompilerProgram {
    program: ts.Program;
    checker: ts.TypeChecker;
    sourceFile: ts.SourceFile;
    /**
     * Every file the program read from inside the repository -- the entry,
     * the modules it imports, and any repository-local declaration file --
     * as sorted, forward-slash paths relative to the repository root. The
     * pinned package under `node_modules` is excluded: its identity is the
     * lock file's, not a path's. This is the input list generation records
     * so a later run can prove the scene's sources unchanged without
     * building the program again.
     */
    localFiles: string[];
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
        // Entry sources target the browser-facing Babylon Lite API. Do not
        // let ambient packages installed for this compiler (notably
        // @types/node) change browser globals such as setInterval from their
        // DOM number handle into NodeJS.Timeout.
        types: [],
        noEmit: true,
        skipLibCheck: true,
        strict: true,
    };
    const defaultHost = ts.createCompilerHost(options, true);
    const host: ts.CompilerHost = {
        ...defaultHost,
        fileExists: (path) =>
            resolve(path) === rootName ||
            rawTextSourcePath(path) !== undefined ||
            defaultHost.fileExists(path),
        readFile: (path) =>
            resolve(path) === rootName
                ? source
                : rawTextModuleSource(path, defaultHost) ??
                  defaultHost.readFile(path),
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
            const rawText = rawTextModuleSource(path, defaultHost);
            if (rawText !== undefined) {
                return ts.createSourceFile(
                    path,
                    rawText,
                    languageVersion,
                    true,
                    ts.ScriptKind.TS,
                );
            }
            const load = () =>
                resolve(path) === babylonTypes
                    // The one place Babylon typings enter the program, and
                    // therefore the one place the members `@internal`
                    // stripped from them are restored.
                    ? ts.createSourceFile(
                          babylonTypes,
                          [
                              defaultHost.readFile(babylonTypes) ?? "",
                              pinnedInternalDeclarations(),
                          ].join("\n"),
                          languageVersion,
                          true,
                          ts.ScriptKind.TS,
                      )
                    : defaultHost.getSourceFile(
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
                if (isBabylonModule(moduleName)) {
                    return {
                        resolvedModule: {
                            resolvedFileName: babylonTypes,
                            extension: ts.Extension.Dts,
                            isExternalLibraryImport: true,
                        },
                    };
                }
                const rawImport = rawTextImportPath(moduleName, containingFile);
                if (rawImport) {
                    return {
                        resolvedModule: {
                            resolvedFileName: rawImport,
                            extension: ts.Extension.Ts,
                            isExternalLibraryImport: false,
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
    const nodeModules = `${sep}node_modules${sep}`;
    const localFiles = program
        .getSourceFiles()
        .map((file) => resolve(rawTextSourcePath(file.fileName) ?? file.fileName))
        .filter(
            (path) =>
                !path.includes(nodeModules) &&
                !relative(repositoryRoot, path).startsWith(".."),
        )
        .map((path) => repositoryRelativePath(repositoryRoot, path))
        .sort();
    return {
        program,
        checker: program.getTypeChecker(),
        sourceFile,
        localFiles,
    };
}
