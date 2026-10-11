import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { aliasTarget, declaredSymbol } from "./compiler/symbols.js";
import { isMainModule, parseFlags } from "./tooling/flags.js";

interface UnusedExport {
    file: string;
    line: number;
    name: string;
    usedInModule: boolean;
}

/** Advisory TypeScript export usage; JavaScript modules also count as consumers. */
function unusedExports(program: ts.Program): UnusedExport[] {
    const checker = program.getTypeChecker();
    const sources = program
        .getSourceFiles()
        .filter(
            (source) =>
                !source.isDeclarationFile &&
                !program.isSourceFileFromExternalLibrary(source),
        );
    const candidates = new Map<
        ts.Symbol,
        { source: ts.SourceFile; declaration: ts.Declaration }
    >();
    const references = new Map<ts.Symbol, Set<ts.SourceFile>>();
    for (const source of sources) {
        if (!/\.[cm]?tsx?$/.test(source.fileName)) continue;
        const module = declaredSymbol(checker, source);
        if (!module) continue;
        for (const symbol of checker.getExportsOfModule(module)) {
            const declaration = symbol.declarations?.find(
                (item) => item.getSourceFile() === source,
            );
            if (declaration) candidates.set(symbol, { source, declaration });
        }
    }
    // Export usage only distinguishes a declaration's own module from any
    // other module. Expand each inferred type in at most two source contexts;
    // walking the same compiler/runtime graph for every file is quadratic.
    const typeSources = new Map<ts.Type, ts.SourceFile | null>();
    for (const source of sources) {
        const expanding = new Set<ts.Symbol>();
        const visitedNodes = new Set<ts.Node>();
        function mark(symbol: ts.Symbol | undefined): void {
            if (!symbol) return;
            const candidate = candidates.get(symbol);
            if (candidate) {
                const uses = references.get(symbol) ?? new Set<ts.SourceFile>();
                if (uses.has(source)) return;
                uses.add(source);
                references.set(symbol, uses);
                // Inferred types matter at module boundaries. Asking for the
                // type of every expression type-checks all implementation
                // bodies, including huge generic compiler specializations.
                if (
                    candidate.source !== source &&
                    !(symbol.flags & ts.SymbolFlags.Alias)
                )
                    visitType(
                        symbol.flags & ts.SymbolFlags.Type
                            ? checker.getDeclaredTypeOfSymbol(symbol)
                            : checker.getTypeOfSymbolAtLocation(
                                  symbol,
                                  candidate.declaration,
                              ),
                    );
            }
            if (symbol.flags & ts.SymbolFlags.Alias)
                mark(aliasTarget(checker, symbol));
        }
        function visitType(type: ts.Type): void {
            const previous = typeSources.get(type);
            if (previous === null || previous === source) return;
            typeSources.set(type, previous === undefined ? source : null);
            mark(type.aliasSymbol);
            mark(type.getSymbol());
            for (const argument of type.aliasTypeArguments ?? [])
                visitType(argument);
            if (type.isUnionOrIntersection()) {
                for (const item of type.types) visitType(item);
                return;
            }
            if (!(type.flags & ts.TypeFlags.Object)) return;
            if (
                type.flags & ts.TypeFlags.Object &&
                (type as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference
            )
                for (const argument of checker.getTypeArguments(
                    type as ts.TypeReference,
                ))
                    visitType(argument);
            // Library containers expose their type arguments, not the entire
            // standard library through every inherited method and callback.
            const symbol = type.getSymbol();
            if (
                symbol?.declarations?.every(
                    (declaration) =>
                        declaration.getSourceFile().isDeclarationFile,
                )
            )
                return;
            // Recursive generics can produce an infinite sequence of distinct
            // instantiations (Node<T>, Node<T[]>, ...). Their declaration is one
            // surface; each instantiation's arguments were already visited.
            const shape = type.aliasSymbol ?? symbol;
            if (shape && expanding.has(shape)) return;
            if (shape) expanding.add(shape);
            for (const property of type.getProperties()) {
                mark(property);
                const declaration =
                    property.valueDeclaration ?? property.declarations?.[0];
                if (declaration)
                    visitType(
                        checker.getTypeOfSymbolAtLocation(
                            property,
                            declaration,
                        ),
                    );
            }
            for (const signature of [
                ...type.getCallSignatures(),
                ...type.getConstructSignatures(),
            ]) {
                visitType(signature.getReturnType());
                for (const parameter of signature.getParameters()) {
                    const declaration =
                        parameter.valueDeclaration ??
                        parameter.declarations?.[0];
                    if (declaration)
                        visitType(
                            checker.getTypeOfSymbolAtLocation(
                                parameter,
                                declaration,
                            ),
                        );
                }
            }
            for (const index of checker.getIndexInfosOfType(type))
                visitType(index.type);
            if (shape) expanding.delete(shape);
        }
        function markImported(
            moduleSpecifier: ts.Expression,
            name: string,
        ): void {
            const module = declaredSymbol(checker, moduleSpecifier);
            if (module)
                mark(
                    checker
                        .getExportsOfModule(module)
                        .find((symbol) => symbol.name === name),
                );
        }
        function visit(node: ts.Node): void {
            if (visitedNodes.has(node)) return;
            visitedNodes.add(node);
            for (const tag of ts.getJSDocTags(node)) visit(tag);
            // Imports connect an alias to the exact exported name, including a
            // re-export alias whose resolved target belongs to another module.
            if (ts.isImportDeclaration(node)) {
                const clause = node.importClause;
                if (clause?.name) markImported(node.moduleSpecifier, "default");
                if (
                    clause?.namedBindings &&
                    ts.isNamedImports(clause.namedBindings)
                )
                    for (const specifier of clause.namedBindings.elements)
                        markImported(
                            node.moduleSpecifier,
                            (specifier.propertyName ?? specifier.name).text,
                        );
                return;
            }
            if (ts.isExportDeclaration(node)) {
                if (node.exportClause && ts.isNamedExports(node.exportClause))
                    for (const specifier of node.exportClause.elements) {
                        if (node.moduleSpecifier)
                            markImported(
                                node.moduleSpecifier,
                                (specifier.propertyName ?? specifier.name).text,
                            );
                        else
                            mark(
                                checker.getExportSpecifierLocalTargetSymbol(
                                    specifier,
                                ),
                            );
                    }
                return;
            }
            // Destructuring a dynamic import creates local binding symbols;
            // record the selected source properties, not the whole module.
            if (
                ts.isBindingElement(node) &&
                ts.isObjectBindingPattern(node.parent)
            ) {
                const name = node.propertyName ?? node.name;
                if (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
                    mark(
                        checker.getPropertyOfType(
                            checker.getTypeAtLocation(node.parent),
                            name.text,
                        ),
                    );
            }
            const symbol = declaredSymbol(checker, node);
            const declarationName = symbol?.declarations?.some(
                (declaration) =>
                    "name" in declaration && declaration.name === node,
            );
            if (
                !declarationName &&
                (ts.isIdentifier(node) || ts.isStringLiteralLike(node))
            )
                mark(symbol);
            const parent = node.parent;
            const namespaceQualifier =
                parent &&
                symbol &&
                (aliasTarget(checker, symbol).flags & ts.SymbolFlags.Module) !==
                    0 &&
                ((ts.isPropertyAccessExpression(parent) &&
                    parent.expression === node) ||
                    (ts.isQualifiedName(parent) && parent.left === node) ||
                    (ts.isElementAccessExpression(parent) &&
                        parent.expression === node));
            if (
                !declarationName &&
                !namespaceQualifier &&
                ((ts.isExpression(node) &&
                    symbol &&
                    (aliasTarget(checker, symbol).flags &
                        ts.SymbolFlags.Module) !==
                        0) ||
                    (ts.isImportTypeNode(node) && !node.qualifier))
            )
                visitType(checker.getTypeAtLocation(node));
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
    return [...candidates]
        .flatMap(([symbol, { source, declaration }]) => {
            const uses = references.get(symbol);
            if (uses && [...uses].some((use) => use !== source)) return [];
            return [
                {
                    file: source.fileName,
                    line:
                        source.getLineAndCharacterOfPosition(
                            declaration.getStart(),
                        ).line + 1,
                    name: symbol.name,
                    usedInModule: uses?.has(source) ?? false,
                },
            ];
        })
        .sort(
            (left, right) =>
                left.file.localeCompare(right.file) ||
                left.line - right.line ||
                left.name.localeCompare(right.name),
        );
}

export function scanUnusedExports(configPath: string): UnusedExport[] {
    const config = resolve(configPath);
    const loaded = ts.readConfigFile(config, (file) => ts.sys.readFile(file));
    const parsed = ts.parseJsonConfigFileContent(
        loaded.config,
        ts.sys,
        dirname(config),
    );
    const errors = [...(loaded.error ? [loaded.error] : []), ...parsed.errors];
    if (errors.length > 0)
        throw new Error(
            ts.formatDiagnosticsWithColorAndContext(errors, {
                getCanonicalFileName: (file) => file,
                getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
                getNewLine: () => "\n",
            }),
        );
    const host = ts.createCompilerHost(parsed.options);
    const resolutionCache = ts.createModuleResolutionCache(
        host.getCurrentDirectory(),
        (file) => host.getCanonicalFileName(file),
        parsed.options,
    );
    // Tools import the built JavaScript/declarations. Join those uses to the
    // producing source, so one export has one identity across both projects.
    host.resolveModuleNames = (names, containingFile) =>
        names.map((name) => {
            const resolved = ts.resolveModuleName(
                name,
                containingFile,
                parsed.options,
                host,
                resolutionCache,
            ).resolvedModule;
            if (!resolved || !parsed.options.outDir) return resolved;
            const outputRelative = relative(
                parsed.options.outDir,
                resolved.resolvedFileName,
            );
            if (outputRelative.startsWith("..") || isAbsolute(outputRelative))
                return resolved;
            const source = resolve(
                parsed.options.rootDir ?? dirname(config),
                outputRelative.replace(/(?:\.d)?\.(?:ts|js)$/, ".ts"),
            );
            return host.fileExists(source)
                ? {
                      resolvedFileName: source,
                      extension: ts.Extension.Ts,
                      isExternalLibraryImport: false,
                  }
                : resolved;
        });
    return unusedExports(
        ts.createProgram(parsed.fileNames, parsed.options, host),
    );
}

if (isMainModule(import.meta.url)) {
    const flags = parseFlags(
        process.argv.slice(2),
        { value: ["--project"], alias: { "--config": "--project" } },
        "lint:exports",
    );
    for (const item of scanUnusedExports(
        flags.values.get("--project") ?? "tsconfig.exports.json",
    ))
        console.log(
            `${relative(process.cwd(), item.file).replaceAll("\\", "/")}:${item.line} - ${item.name}${item.usedInModule ? " (used in module)" : ""}`,
        );
}
