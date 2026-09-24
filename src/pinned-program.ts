import { join, resolve } from "node:path";
import ts from "typescript";
import { compilerPackageTypings } from "./compiler/symbols.js";
import { sourceLocation } from "./source-location.js";
import {
    isLibraryTyping,
    libraryTypingFile,
} from "./typescript-library-files.js";

/**
 * The sources a typed pinned program is built over: the store that reads
 * the pin's source maps. Stated as the members the program reads so the
 * store can own its program without the two modules importing each other.
 */
export interface PinnedProgramSources {
    readonly packageRoot: string;
    listSources(): string[];
    hasSource(modulePath: string): boolean;
    getSourceFile(modulePath: string): ts.SourceFile;
    resolveImport(fromModule: string, specifier: string): string | undefined;
}

/**
 * Where an identifier in pinned source resolves, through the declarations
 * a TypeScript checker binds rather than through its spelling.
 */
export interface PinnedNames {
    /**
     * The declaration an identifier names, followed through every import
     * and re-export alias; undefined for a name that resolves to nothing
     * (an unresolved import, a global the program does not declare).
     */
    declarationOf(identifier: ts.Identifier): ts.Declaration | undefined;
}

/**
 * The options the pin's own sources type-check under: the browser
 * libraries of a scene's own program, whose files the two programs share.
 */
const PINNED_PROGRAM_OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
};

function refuse(node: ts.Node, message: string): never {
    const { file, line, character } = sourceLocation(node);
    throw new Error(`${file.fileName}:${line}:${character}: ${message}`);
}

/** `getSymbolAtLocation` for a name, taking a shorthand member as the value it reads. */
function declarationThrough(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): ts.Declaration | undefined {
    const parent = identifier.parent;
    let symbol =
        ts.isShorthandPropertyAssignment(parent) && parent.name === identifier
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : checker.getSymbolAtLocation(identifier);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/**
 * One checked `ts.Program` over the pin's reconstructed sources.
 *
 * The source maps carry every module that emits JavaScript; a module that
 * emits none (a file of type declarations) is absent from them, and an
 * import of one resolves to the package's published `index.d.ts`, which
 * declares the names it exports. The program shares the store's parsed
 * files, so a node a lowerer already holds is a node the checker answers
 * for. It is built once per store, on the first question asked of it.
 */
export class PinnedProgram implements PinnedNames {
    public readonly program: ts.Program;
    public readonly checker: ts.TypeChecker;

    public constructor(sources: PinnedProgramSources) {
        // The package's own declarations stand in for the modules its
        // source maps do not carry; they are parsed for this program alone,
        // since a scene's program reads the same file with erased members
        // restored.
        const declarations = resolve(join(sources.packageRoot, "index.d.ts"));
        const { webGpu } = compilerPackageTypings();
        const host = ts.createCompilerHost(PINNED_PROGRAM_OPTIONS, true);
        const external = (
            specifier: string,
        ): ts.ResolvedModuleFull | undefined =>
            ts.resolveModuleName(
                specifier,
                declarations,
                PINNED_PROGRAM_OPTIONS,
                ts.sys,
            ).resolvedModule;
        const readFile = host.readFile.bind(host);
        const getSourceFile = host.getSourceFile.bind(host);
        const fileExists = host.fileExists.bind(host);
        host.getCurrentDirectory = () => "";
        host.fileExists = (path) => sources.hasSource(path) || fileExists(path);
        host.readFile = (path) =>
            sources.hasSource(path)
                ? sources.getSourceFile(path).text
                : readFile(path);
        host.getSourceFile = (path, languageVersion, onError, create) => {
            if (sources.hasSource(path)) return sources.getSourceFile(path);
            const load = () =>
                getSourceFile(path, languageVersion, onError, create);
            return isLibraryTyping(path) && resolve(path) !== declarations
                ? libraryTypingFile(path, load)
                : load();
        };
        host.resolveModuleNameLiterals = (literals, containingFile) =>
            literals.map(
                (literal): ts.ResolvedModuleWithFailedLookupLocations => {
                    const specifier = literal.text;
                    if (!specifier.startsWith(".")) {
                        return { resolvedModule: external(specifier) };
                    }
                    const source = sources.resolveImport(
                        containingFile,
                        specifier,
                    );
                    if (source) {
                        return {
                            resolvedModule: {
                                resolvedFileName: source,
                                extension: ts.Extension.Ts,
                                isExternalLibraryImport: false,
                            },
                        };
                    }
                    // A bundler query (`?raw`, `?worker`) names an asset, not a
                    // module the package declares.
                    return specifier.includes("?")
                        ? { resolvedModule: undefined }
                        : {
                              resolvedModule: {
                                  resolvedFileName: declarations,
                                  extension: ts.Extension.Dts,
                                  isExternalLibraryImport: true,
                              },
                          };
                },
            );
        this.program = ts.createProgram({
            rootNames: [...sources.listSources(), webGpu],
            options: PINNED_PROGRAM_OPTIONS,
            host,
        });
        this.checker = this.program.getTypeChecker();
    }

    /** Whether a node lies in one of this program's own files. */
    public contains(node: ts.Node): boolean {
        const file = ts.getOriginalNode(node).getSourceFile();
        return this.program.getSourceFile(file.fileName) === file;
    }

    /** A node the checker may be asked about; a node from any other tree refuses. */
    private member<T extends ts.Node>(node: T): T {
        if (!this.contains(node)) {
            refuse(node, "The node is not part of the typed pinned program.");
        }
        return node;
    }

    public declarationOf(
        identifier: ts.Identifier,
    ): ts.Declaration | undefined {
        return declarationThrough(this.checker, this.member(identifier));
    }

    /** The type the checker gives a pinned node. */
    public typeOf(node: ts.Node): ts.Type {
        return this.checker.getTypeAtLocation(this.member(node));
    }
}

/**
 * The names one lone source file declares, for a file no store owns (a
 * test's fixture, a doctored module): its own program, without libraries or
 * imports, so a name resolves to what the file itself declares and an
 * import resolves to nothing.
 */
class SingleFileNames implements PinnedNames {
    private readonly checker: ts.TypeChecker;

    public constructor(private readonly file: ts.SourceFile) {
        const options: ts.CompilerOptions = {
            noLib: true,
            noResolve: true,
            types: [],
        };
        const host = ts.createCompilerHost(options);
        host.getSourceFile = (name) =>
            name === file.fileName ? file : undefined;
        this.checker = ts
            .createProgram({ rootNames: [file.fileName], options, host })
            .getTypeChecker();
    }

    public declarationOf(
        identifier: ts.Identifier,
    ): ts.Declaration | undefined {
        if (ts.getOriginalNode(identifier).getSourceFile() !== this.file) {
            refuse(
                identifier,
                "The name is not part of the file it is resolved in.",
            );
        }
        return declarationThrough(this.checker, identifier);
    }
}

/** The program owning each file a store parsed. */
const owners = new WeakMap<ts.SourceFile, () => PinnedProgram>();
const singleFiles = new WeakMap<ts.SourceFile, SingleFileNames>();

/** Record that `program` (built on demand) owns a file its store parsed. */
export function registerPinnedSource(
    file: ts.SourceFile,
    program: () => PinnedProgram,
): void {
    owners.set(file, program);
}

/**
 * The names a pinned file resolves: its store's typed program, or, for a
 * file no store parsed, the file's own declarations.
 */
export function pinnedNamesOf(file: ts.SourceFile): PinnedNames {
    const owner = owners.get(file);
    if (owner) return owner();
    let single = singleFiles.get(file);
    if (!single) {
        single = new SingleFileNames(file);
        singleFiles.set(file, single);
    }
    return single;
}

/**
 * A module-scope variable declaration, with the statement that declares it:
 * the only declarations a pinned module's constants live in.
 */
export function moduleScopeVariable(
    declaration: ts.Declaration | undefined,
): (ts.VariableDeclaration & { name: ts.Identifier }) | undefined {
    if (
        !declaration ||
        !ts.isVariableDeclaration(declaration) ||
        !ts.isIdentifier(declaration.name) ||
        !ts.isVariableDeclarationList(declaration.parent) ||
        !ts.isVariableStatement(declaration.parent.parent) ||
        !ts.isSourceFile(declaration.parent.parent.parent)
    ) {
        return undefined;
    }
    return declaration as ts.VariableDeclaration & { name: ts.Identifier };
}
