import { join, resolve } from "node:path";
import ts from "typescript";
import {
    aliasTarget,
    compilerPackageTypings,
    declaredSymbol,
    resolvedSymbol,
} from "./compiler/symbols.js";
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
interface PinnedProgramSources {
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
interface PinnedNames {
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

/** A file bound alone: no libraries, no imports resolved. */
const OWN_SYMBOL_OPTIONS: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
};

function refuse(node: ts.Node, message: string): never {
    const { file, line, character } = sourceLocation(node);
    throw new Error(`${file.fileName}:${line}:${character}: ${message}`);
}

/** The declaration of the symbol a name resolves to, through its aliases. */
function declarationThrough(
    checker: ts.TypeChecker,
    identifier: ts.Identifier,
): ts.Declaration | undefined {
    const symbol = resolvedSymbol(checker, identifier);
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

function symbolDeclaration(symbol: ts.Symbol): ts.Declaration | undefined {
    return symbol.valueDeclaration ?? symbol.declarations?.[0];
}

const ownSymbols = new WeakMap<ts.SourceFile, ts.TypeChecker>();

/**
 * One file's own symbol table: its declarations, scopes and imports, bound
 * without libraries or module resolution, so an import is an alias its
 * reader follows and a global resolves to nothing. Binding is syntactic,
 * so a name the file declares is the symbol any program would give it.
 */
export function moduleSymbols(file: ts.SourceFile): ts.TypeChecker {
    let checker = ownSymbols.get(file);
    if (!checker) {
        const host = ts.createCompilerHost(OWN_SYMBOL_OPTIONS);
        host.getSourceFile = (name) =>
            name === file.fileName ? file : undefined;
        // A program rewrites the (internal) paths of every file it reads,
        // and a file's path is how the programs that share it find its
        // imports: this one, which resolves none, leaves them as they were.
        const paths = ["path", "resolvedPath"].map((key): [string, unknown] => [
            key,
            Reflect.get(file, key),
        ]);
        const program = ts.createProgram({
            rootNames: [file.fileName],
            options: OWN_SYMBOL_OPTIONS,
            host,
        });
        for (const [key, value] of paths)
            if (typeof value === "string") Reflect.set(file, key, value);
        checker = program.getTypeChecker();
        ownSymbols.set(file, checker);
    }
    return checker;
}

/**
 * Whether a name resolves through the scopes around it alone. A member
 * name (`value.name`, `{ name: ... }`, `Type.Name`) resolves through the
 * type of what it is read from, which a file's own symbols cannot know.
 */
function scopedName(identifier: ts.Identifier): boolean {
    const parent = identifier.parent;
    return !(
        !parent ||
        (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
        (ts.isQualifiedName(parent) && parent.right === identifier) ||
        (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
        (ts.isBindingElement(parent) && parent.propertyName === identifier) ||
        ((ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) &&
            parent.propertyName === identifier) ||
        ts.isExportSpecifier(parent) ||
        ts.isJsxAttribute(parent) ||
        ts.isTypePredicateNode(parent) ||
        ts.findAncestor(parent, ts.isImportTypeNode) !== undefined
    );
}

/** Not answered from the modules' own symbols: the checker decides. */
const CHECKER = Symbol("checker");

/**
 * The pin's reconstructed sources, answering names from each module's own
 * symbols and types from a checked program.
 *
 * A name resolves through the module that uses it: its scopes, then its
 * imports, followed module by module through the store's own import
 * resolution and each module's exports and re-exports. Only a question a
 * module's symbols cannot answer -- a member name, an import the package's
 * declarations or another package answer -- asks a checker.
 *
 * A type question asks a program rooted at the module it is about: that
 * module, what it imports, the libraries and the package's declarations
 * (which stand in for the modules the source maps do not carry, since a
 * module that emits no JavaScript is absent from them). The program shares
 * the store's parsed files, so a node a lowerer already holds is a node
 * the checker answers for. A module the store served again as another tree
 * (an edited copy) roots its own. The program over every source is built
 * only for a question about all of them (a class's overrides).
 */
export class PinnedProgram implements PinnedNames {
    private readonly declarations: string;
    private readonly webGpu: string;
    private readonly host: ts.CompilerHost;
    private readonly rooted = new WeakMap<ts.SourceFile, ts.TypeChecker>();
    private whole:
        | { readonly program: ts.Program; readonly checker: ts.TypeChecker }
        | undefined;
    private globals:
        | {
              readonly program: ts.Program;
              readonly symbols: ReadonlyMap<string, ts.Symbol>;
          }
        | undefined;

    public constructor(private readonly sources: PinnedProgramSources) {
        // The package's own declarations stand in for the modules its
        // source maps do not carry; they are parsed for these programs
        // alone, since a scene's program reads the same file with erased
        // members restored.
        this.declarations = resolve(join(sources.packageRoot, "index.d.ts"));
        this.webGpu = compilerPackageTypings().webGpu;
        const declarations = this.declarations;
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
        this.host = host;
    }

    /** A program over `rootNames`, with `file` standing for its path. */
    private createProgram(
        rootNames: readonly string[],
        file?: ts.SourceFile,
    ): ts.Program {
        const getSourceFile = this.host.getSourceFile.bind(this.host);
        return ts.createProgram({
            rootNames,
            options: PINNED_PROGRAM_OPTIONS,
            host: file
                ? {
                      ...this.host,
                      getSourceFile: (path, ...rest) =>
                          path === file.fileName
                              ? file
                              : getSourceFile(path, ...rest),
                  }
                : this.host,
        });
    }

    private wholeProgram(): {
        readonly program: ts.Program;
        readonly checker: ts.TypeChecker;
    } {
        if (!this.whole) {
            const program = this.createProgram([
                ...this.sources.listSources(),
                this.webGpu,
            ]);
            this.whole = { program, checker: program.getTypeChecker() };
        }
        return this.whole;
    }

    /** The program over every pinned source: a question about all of them. */
    public get program(): ts.Program {
        return this.wholeProgram().program;
    }

    public get checker(): ts.TypeChecker {
        return this.wholeProgram().checker;
    }

    /**
     * The checker that answers type questions about a node: a program
     * rooted at the node's module, built on the first question about that
     * module (or that tree of it). A node of the package's declarations is
     * answered by the program over every source; a node of no pinned
     * module refuses.
     */
    public checkerFor(node: ts.Node): ts.TypeChecker {
        const file = ts.getOriginalNode(node).getSourceFile();
        if (!this.sources.hasSource(file.fileName)) {
            if (
                file.isDeclarationFile &&
                this.program.getSourceFile(file.fileName) === file
            )
                return this.checker;
            refuse(node, "The node is not part of the typed pinned program.");
        }
        let checker = this.rooted.get(file);
        if (!checker) {
            checker = this.createProgram(
                [file.fileName, this.webGpu],
                file,
            ).getTypeChecker();
            this.rooted.set(file, checker);
        }
        return checker;
    }

    /** The type the checker gives a pinned node. */
    public typeOf(node: ts.Node): ts.Type {
        return this.checkerFor(node).getTypeAtLocation(node);
    }

    public declarationOf(
        identifier: ts.Identifier,
    ): ts.Declaration | undefined {
        const named = this.scopedDeclaration(identifier);
        return named === CHECKER
            ? declarationThrough(this.checkerFor(identifier), identifier)
            : named;
    }

    /**
     * The symbol a module exports under `name`, followed through its
     * re-exports to the binding that declares it; undefined when the
     * module exports no such name.
     */
    public exportedSymbol(
        modulePath: string,
        name: string,
    ): ts.Symbol | undefined {
        const found = this.exportOf(modulePath, name, new Set());
        if (found !== CHECKER) return found;
        const file = this.sources.getSourceFile(modulePath);
        const checker = this.checkerFor(file);
        const module = declaredSymbol(checker, file);
        const symbol = module
            ? checker
                  .getExportsOfModule(module)
                  .find((entry) => entry.name === name)
            : undefined;
        return symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0
            ? aliasTarget(checker, symbol)
            : symbol;
    }

    /** A name through the scopes of its module, then through its imports. */
    private scopedDeclaration(
        identifier: ts.Identifier,
    ): ts.Declaration | undefined | typeof CHECKER {
        const file = ts.getOriginalNode(identifier).getSourceFile();
        if (!this.sources.hasSource(file.fileName) || !scopedName(identifier))
            return CHECKER;
        const own = declaredSymbol(moduleSymbols(file), identifier);
        // A name no scope declares reads as nothing, or as a placeholder
        // symbol with no declaration.
        if (!own?.declarations?.length) {
            // Declared by no scope of its module: a global, or nothing.
            const global = this.globalSymbols().get(identifier.text);
            return global && symbolDeclaration(global);
        }
        const symbol = this.throughImports(own, file);
        return symbol === CHECKER
            ? CHECKER
            : symbol && symbolDeclaration(symbol);
    }

    /** A module-scope symbol, or the binding the import it is resolves to. */
    private throughImports(
        symbol: ts.Symbol,
        file: ts.SourceFile,
        seen = new Set<string>(),
    ): ts.Symbol | undefined | typeof CHECKER {
        if ((symbol.flags & ts.SymbolFlags.Alias) === 0) return symbol;
        const declaration = symbol.declarations?.[0];
        if (!declaration) return CHECKER;
        const imported = (node: ts.Node): { specifier: string } | undefined => {
            const statement = ts.findAncestor(node, ts.isImportDeclaration);
            return statement && ts.isStringLiteral(statement.moduleSpecifier)
                ? { specifier: statement.moduleSpecifier.text }
                : undefined;
        };
        if (ts.isImportSpecifier(declaration)) {
            const from = imported(declaration);
            if (!from) return CHECKER;
            const name = (declaration.propertyName ?? declaration.name).text;
            return this.importedExport(file, from.specifier, name, seen);
        }
        if (ts.isImportClause(declaration)) {
            const from = imported(declaration);
            if (!from) return CHECKER;
            return this.importedExport(file, from.specifier, "default", seen);
        }
        if (ts.isNamespaceImport(declaration)) {
            const from = imported(declaration);
            if (!from) return CHECKER;
            const target = this.moduleOf(file, from.specifier);
            if (target === undefined || target === CHECKER) return target;
            return declaredSymbol(
                moduleSymbols(this.sources.getSourceFile(target)),
                this.sources.getSourceFile(target),
            );
        }
        if (ts.isExportSpecifier(declaration)) {
            const clause = declaration.parent.parent;
            if (clause.moduleSpecifier) {
                if (!ts.isStringLiteral(clause.moduleSpecifier)) return CHECKER;
                const name = (declaration.propertyName ?? declaration.name)
                    .text;
                return this.importedExport(
                    file,
                    clause.moduleSpecifier.text,
                    name,
                    seen,
                );
            }
            const local =
                moduleSymbols(file).getExportSpecifierLocalTargetSymbol(
                    declaration,
                );
            return local ? this.throughImports(local, file, seen) : CHECKER;
        }
        return CHECKER;
    }

    /**
     * The module a specifier in `file` names, as the programs resolve it:
     * a pinned module, nothing (a bundler asset query), or a module only a
     * checker reads (the package's declarations, another package).
     */
    private moduleOf(
        file: ts.SourceFile,
        specifier: string,
    ): string | undefined | typeof CHECKER {
        if (!specifier.startsWith(".")) return CHECKER;
        const source = this.sources.resolveImport(file.fileName, specifier);
        if (source) return source;
        return specifier.includes("?") ? undefined : CHECKER;
    }

    private importedExport(
        file: ts.SourceFile,
        specifier: string,
        name: string,
        seen: Set<string>,
    ): ts.Symbol | undefined | typeof CHECKER {
        const target = this.moduleOf(file, specifier);
        if (target === undefined || target === CHECKER) return target;
        return this.exportOf(target, name, seen);
    }

    /**
     * What `modulePath` exports as `name`: its own export, followed through
     * a re-export, or one of its `export *` modules' (never their default).
     */
    private exportOf(
        modulePath: string,
        name: string,
        seen: Set<string>,
    ): ts.Symbol | undefined | typeof CHECKER {
        const key = `${modulePath}\0${name}`;
        if (seen.has(key)) return undefined;
        seen.add(key);
        const file = this.sources.getSourceFile(modulePath);
        const checker = moduleSymbols(file);
        const module = declaredSymbol(checker, file);
        if (!module) return CHECKER;
        const own = checker
            .getExportsOfModule(module)
            .find((entry) => entry.name === name);
        if (own) return this.throughImports(own, file, seen);
        if (name === "default") return undefined;
        for (const statement of file.statements) {
            if (
                !ts.isExportDeclaration(statement) ||
                statement.exportClause ||
                !statement.moduleSpecifier ||
                !ts.isStringLiteral(statement.moduleSpecifier)
            )
                continue;
            const found = this.importedExport(
                file,
                statement.moduleSpecifier.text,
                name,
                seen,
            );
            if (found !== undefined) return found;
        }
        return undefined;
    }

    /**
     * The global names the pinned programs declare: the libraries, the
     * WebGPU typings and whatever the package's declarations add, read from
     * a program over those alone.
     */
    private globalScope(): {
        readonly program: ts.Program;
        readonly symbols: ReadonlyMap<string, ts.Symbol>;
    } {
        if (!this.globals) {
            const program = this.createProgram([
                this.webGpu,
                this.declarations,
            ]);
            const webGpu = program.getSourceFile(this.webGpu);
            const symbols = webGpu
                ? program
                      .getTypeChecker()
                      .getSymbolsInScope(
                          webGpu,
                          ts.SymbolFlags.Value |
                              ts.SymbolFlags.Type |
                              ts.SymbolFlags.Namespace |
                              ts.SymbolFlags.Alias,
                      )
                : [];
            this.globals = {
                program,
                symbols: new Map(
                    symbols.map((symbol) => [symbol.name, symbol]),
                ),
            };
        }
        return this.globals;
    }

    private globalSymbols(): ReadonlyMap<string, ts.Symbol> {
        return this.globalScope().symbols;
    }

    /** Whether a file is one of the default libraries every pinned program reads. */
    public isDefaultLibrary(file: ts.SourceFile): boolean {
        return this.globalScope().program.isSourceFileDefaultLibrary(file);
    }
}

/**
 * The names one lone source file declares, for a file no store owns (a
 * test's fixture, a doctored module): its own symbols, so a name resolves
 * to what the file itself declares and an import resolves to nothing.
 */
class SingleFileNames implements PinnedNames {
    public constructor(private readonly file: ts.SourceFile) {}

    public declarationOf(
        identifier: ts.Identifier,
    ): ts.Declaration | undefined {
        if (ts.getOriginalNode(identifier).getSourceFile() !== this.file) {
            refuse(
                identifier,
                "The name is not part of the file it is resolved in.",
            );
        }
        return declarationThrough(moduleSymbols(this.file), identifier);
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
