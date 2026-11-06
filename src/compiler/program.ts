import { compilerRepositoryRoot } from "../repository-root.js";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";
import { compilerPackageTypings, isBabylonModule } from "./symbols.js";
import type { HostPageProgram } from "./types.js";
import { hostPageServedFile } from "../host-page.js";
import { sharedPinnedContext } from "../lowering/context.js";
import {
    isLibraryTyping,
    libraryTypingFile,
} from "../typescript-library-files.js";
import { repositoryRelativePath } from "../upstream-source.js";
import { specifierSourceName } from "./syntax.js";
import {
    pinnedProgramExportNames,
    pinnedProgramSources,
    type PinnedProgramSources,
} from "../pinned-program-sources.js";

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
    {
        module: "src/camera/free-camera.ts",
        interfaceName: "FreeCamera",
        member: "_yaw",
    },
    {
        module: "src/camera/free-camera.ts",
        interfaceName: "FreeCamera",
        member: "_pitch",
    },
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
 * `libraryTypingFile` keeps the composed typings for the life of the process,
 * so this runs on the first compile alone.
 */
function pinnedInternalDeclarations(): string {
    const context = sharedPinnedContext();
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
    return (
        resolve(dirname(containingFile), relativePath) + RAW_TEXT_MODULE_SUFFIX
    );
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
        throw new Error(
            `Raw text import reads '${textPath}', which does not exist.`,
        );
    }
    return `const rawText = ${JSON.stringify(text)};\nexport default rawText;\n`;
}

export interface CompilerProgram {
    program: ts.Program;
    checker: ts.TypeChecker;
    sourceFile: ts.SourceFile;
    /**
     * Every local file the program read -- the entry, the modules it imports,
     * and local declaration files, including sources outside this repository --
     * as sorted, forward-slash paths relative to the repository root. The
     * pinned package under `node_modules` is excluded: its identity is the
     * lock file's, not a path's. This is the input list generation records
     * so a later run can prove the scene's sources unchanged without
     * building the program again.
     */
    localFiles: string[];
    /** The host page's inline module script, a second root. */
    loaderFile?: ts.SourceFile;
    startupFiles?: ts.SourceFile[];
}

/**
 * Whether a program's own files import a pinned export that compiles as
 * program code (`pinned-program-sources.ts`).
 */
function importsPinnedProgramSource(program: ts.Program): boolean {
    const nodeModules = `${sep}node_modules${sep}`;
    return program
        .getSourceFiles()
        .some(
            (file) =>
                !file.isDeclarationFile &&
                !resolve(file.fileName).includes(nodeModules) &&
                file.statements.some(
                    (statement) =>
                        (ts.isImportDeclaration(statement) ||
                            ts.isExportDeclaration(statement)) &&
                        statement.moduleSpecifier !== undefined &&
                        ts.isStringLiteral(statement.moduleSpecifier) &&
                        isBabylonModule(statement.moduleSpecifier.text) &&
                        importedNames(statement).some((name) =>
                            pinnedProgramExportNames().has(name),
                        ),
                ),
        );
}

/**
 * The pinned names an import or re-export binds: a namespace's, the members
 * its file reads off it (`N.name`), and every export a re-exported
 * namespace may hand on.
 */
function importedNames(
    statement: ts.ImportDeclaration | ts.ExportDeclaration,
): string[] {
    const bindings = ts.isImportDeclaration(statement)
        ? statement.importClause?.namedBindings
        : statement.exportClause;
    if (!bindings) return [];
    if (ts.isNamespaceExport(bindings)) return [...pinnedProgramExportNames()];
    if (ts.isNamespaceImport(bindings)) {
        const names: string[] = [];
        const visit = (node: ts.Node): void => {
            if (
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === bindings.name.text
            )
                names.push(node.name.text);
            ts.forEachChild(node, visit);
        };
        visit(statement.getSourceFile());
        return names;
    }
    return bindings.elements.map(specifierSourceName);
}

export function createCompilerProgram(
    source: string,
    fileName: string,
    page?: HostPageProgram,
): CompilerProgram {
    const rootName = resolve(fileName);
    const loaderName = page?.loader ? resolve(page.loader.fileName) : undefined;
    // Classic scripts in page order; an external one is its own file.
    const startupNames = (page?.startup ?? []).map((script) =>
        resolve(script.fileName),
    );
    const inlineStartup = new Map(
        (page?.startup ?? []).flatMap((script) =>
            script.source === undefined
                ? []
                : [[resolve(script.fileName), script.source] as const],
        ),
    );
    // Set when the program imports a pinned export compiled as program
    // code (`pinned-program-sources.ts`): its modules are then virtual
    // files of the program.
    let pinnedSources: PinnedProgramSources | undefined;
    const virtualSource = (path: string): string | undefined => {
        const absolute = resolve(path);
        return absolute === rootName
            ? source
            : absolute === loaderName
              ? page?.loader?.source
              : (inlineStartup.get(absolute) ??
                pinnedSources?.module(absolute)?.text);
    };
    const repositoryRoot = compilerRepositoryRoot();
    const { babylon: babylonTypes, webGpu: webGpuTypes } =
        compilerPackageTypings();
    const options: ts.CompilerOptions = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        // Entry sources target the browser-facing Babylon Lite API. Do not
        // let ambient packages installed for this compiler (notably
        // @types/node) change browser globals such as setInterval from their
        // DOM number handle into NodeJS.Timeout.
        types: [],
        allowJs: true,
        noEmit: true,
        skipLibCheck: true,
        strict: true,
    };
    const defaultHost = ts.createCompilerHost(options, true);
    const host: ts.CompilerHost = {
        ...defaultHost,
        fileExists: (path) =>
            virtualSource(path) !== undefined ||
            rawTextSourcePath(path) !== undefined ||
            defaultHost.fileExists(path),
        readFile: (path) =>
            virtualSource(path) ??
            rawTextModuleSource(path, defaultHost) ??
            defaultHost.readFile(path),
        getSourceFile: (
            path,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
        ) => {
            const virtual = virtualSource(path);
            if (virtual !== undefined) {
                return ts.createSourceFile(
                    resolve(path),
                    virtual,
                    languageVersion,
                    true,
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
            const babylon = resolve(path) === babylonTypes;
            const typings = (): string =>
                defaultHost.readFile(babylonTypes) ?? "";
            const load = () =>
                babylon
                    ? // The one place Babylon typings enter the program, and
                      // therefore the one place the members `@internal`
                      // stripped from them are restored, and where the
                      // exports a program compiles from their sources are
                      // read from those.
                      ts.createSourceFile(
                          babylonTypes,
                          [
                              pinnedSources
                                  ? pinnedSources.typings(typings())
                                  : typings(),
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
            return isLibraryTyping(path)
                ? libraryTypingFile(
                      babylon && pinnedSources
                          ? `${path}?program-sources`
                          : path,
                      load,
                  )
                : load();
        },
        resolveModuleNameLiterals: (
            moduleLiterals,
            containingFile,
            redirectedReference,
            compilerOptions,
        ) =>
            moduleLiterals.map((moduleLiteral) => {
                const pinned = pinnedSources?.module(containingFile);
                const target = pinned
                    ? pinnedSources!.resolve(moduleLiteral.text, pinned)
                    : pinnedSources &&
                        resolve(containingFile) === babylonTypes &&
                        moduleLiteral.text.startsWith("./src/")
                      ? pinnedSources.pinnedPath(
                            moduleLiteral.text
                                .slice("./".length)
                                .replace(/\.js$/, ".ts"),
                        )
                      : undefined;
                if (target)
                    return {
                        resolvedModule: {
                            resolvedFileName: target,
                            extension: target.endsWith(".d.ts")
                                ? ts.Extension.Dts
                                : ts.Extension.Ts,
                            isExternalLibraryImport:
                                resolve(target) === babylonTypes,
                        },
                    };
                // The page's site serves a root-relative specifier, and the
                // page loader's, as the page's own module script loads it.
                const moduleName =
                    (page !== undefined &&
                        (moduleLiteral.text.startsWith("/") ||
                            resolve(containingFile) === loaderName) &&
                        hostPageServedFile(page, moduleLiteral.text)) ||
                    moduleLiteral.text;
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
                const resolved = ts.resolveModuleName(
                    moduleName,
                    containingFile,
                    compilerOptions,
                    defaultHost,
                    undefined,
                    redirectedReference,
                );
                const implementation = resolve(
                    dirname(containingFile),
                    moduleName,
                );
                const extension = moduleName.endsWith(".mjs")
                    ? ts.Extension.Mjs
                    : moduleName.endsWith(".cjs")
                      ? ts.Extension.Cjs
                      : moduleName.endsWith(".js")
                        ? ts.Extension.Js
                        : undefined;
                if (
                    extension &&
                    moduleName.startsWith(".") &&
                    resolved.resolvedModule?.resolvedFileName.match(
                        /\.d\.[cm]?ts$/,
                    ) &&
                    defaultHost.fileExists(implementation)
                ) {
                    // A declaration describes a local JavaScript module but
                    // cannot supply its executable initializer or functions.
                    // Read the implementation through the same typed pipeline.
                    return {
                        resolvedModule: {
                            resolvedFileName: implementation,
                            extension,
                            isExternalLibraryImport: false,
                        },
                    };
                }
                return resolved;
            }),
    };
    // Include the pin's WebGPU peer typings explicitly, including for entries
    // outside this checkout. Keep unrelated ambient packages excluded above.
    const roots = [
        rootName,
        webGpuTypes,
        ...(loaderName ? [loaderName] : []),
        ...startupNames,
    ];
    let program = ts.createProgram(roots, options, host);
    if (importsPinnedProgramSource(program)) {
        pinnedSources = pinnedProgramSources();
        program = ts.createProgram(
            [...roots, ...pinnedSources.files()],
            options,
            host,
            program,
        );
    }
    const sourceFile = program.getSourceFile(rootName);
    if (!sourceFile) {
        throw new Error(
            `Unable to create TypeScript program for '${fileName}'.`,
        );
    }
    const nodeModules = `${sep}node_modules${sep}`;
    // The page itself is read in place of its synthesized loader module and
    // inline scripts; an external classic script is a file of its own.
    const localFiles = program
        .getSourceFiles()
        .map((file) =>
            resolve(rawTextSourcePath(file.fileName) ?? file.fileName),
        )
        .filter((path) => path !== loaderName && !inlineStartup.has(path))
        .concat(page ? [resolve(page.path)] : [])
        .filter((path) => !path.includes(nodeModules))
        .map((path) => repositoryRelativePath(repositoryRoot, path))
        .sort();
    const loaderFile = loaderName && program.getSourceFile(loaderName);
    return {
        program,
        checker: program.getTypeChecker(),
        sourceFile,
        localFiles,
        ...(loaderFile ? { loaderFile } : {}),
        ...(startupNames.length
            ? {
                  startupFiles: startupNames.map((name) =>
                      program.getSourceFile(name)!,
                  ),
              }
            : {}),
    };
}
