import {
    dirname,
    resolve,
    sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isBabylonModule } from "./symbols.js";
import { LoweringContext } from "../lowering/context.js";
import {
    findRepositoryRoot,
    sharedUpstreamStore,
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
