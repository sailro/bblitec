import ts from "typescript";
import type { CompilerSymbols } from "./symbols.js";

/** Statements JavaScript executes while evaluating an imported module. */
export function isModuleInitializerStatement(
    statement: ts.Statement,
): boolean {
    return !(
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
    );
}

/**
 * Selects project modules whose top-level work must run natively.
 *
 * Immutable imported builders stay on the static evaluator path. Native
 * initialization is reserved for storage whose post-initializer identity is
 * observed by the entry or an exported callable, plus the transitive module
 * state needed to construct it.
 */
export function planImportedModuleInitializers(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
): ts.SourceFile[] {
    const planner = new ModuleInitializerPlanner(
        program,
        sourceFile,
        checker,
        symbols,
    );
    return planner.plan();
}

class ModuleInitializerPlanner {
    public constructor(
        private readonly program: ts.Program,
        private readonly sourceFile: ts.SourceFile,
        private readonly checker: ts.TypeChecker,
        private readonly symbols: CompilerSymbols,
    ) {}

    public plan(): ts.SourceFile[] {
        const projectModules = this.program
            .getSourceFiles()
            .filter(
                (file) =>
                    file !== this.sourceFile &&
                    !file.isDeclarationFile &&
                    !this.program.isSourceFileFromExternalLibrary(
                        file,
                    ),
            );
        const stateByModule = new Map(
            projectModules.map((file) => [
                file,
                this.moduleVariableSymbols(file),
            ]),
        );
        const allState = new Set(
            [...stateByModule.values()].flatMap((state) => [
                ...state,
            ]),
        );
        const observedState = this.runtimeObservedModuleState(
            projectModules,
            allState,
        );
        const mutatingModules = new Set(
            projectModules.filter((file) =>
                this.moduleHasObservableInitializer(
                    file,
                    observedState,
                ),
            ),
        );
        if (mutatingModules.size === 0) {
            return [];
        }

        // A registrar module may populate storage declared by one of its
        // dependencies. Materialize both the work and the owner of every
        // state symbol that work can mutate.
        const mutatedState = new Set<ts.Symbol>();
        for (const symbol of observedState) {
            if (
                [...mutatingModules].some((file) =>
                    this.moduleHasObservableInitializer(
                        file,
                        new Set([symbol]),
                    ),
                )
            ) {
                mutatedState.add(symbol);
            }
        }
        return projectModules.filter(
            (file) =>
                mutatingModules.has(file) ||
                [...(stateByModule.get(file) ?? [])].some(
                    (symbol) => mutatedState.has(symbol),
                ),
        );
    }

    /** Native storage declared by one project module, exported or private. */
    private moduleVariableSymbols(
        file: ts.SourceFile,
    ): Set<ts.Symbol> {
        const result = new Set<ts.Symbol>();
        for (const statement of file.statements) {
            if (!ts.isVariableStatement(statement)) {
                continue;
            }
            for (const declaration of statement.declarationList
                .declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }
                const symbol = this.symbols.valueSymbol(
                    declaration.name,
                );
                if (symbol) {
                    result.add(symbol);
                }
            }
        }
        return result;
    }

    private runtimeObservedModuleState(
        projectModules: readonly ts.SourceFile[],
        moduleState: ReadonlySet<ts.Symbol>,
    ): Set<ts.Symbol> {
        const observed = new Set<ts.Symbol>();
        const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node)) {
                const symbol = this.symbols.valueSymbol(node);
                if (symbol && moduleState.has(symbol)) {
                    observed.add(symbol);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(this.sourceFile);
        for (const file of projectModules) {
            const moduleSymbol =
                this.checker.getSymbolAtLocation(file);
            const exported = new Set(
                moduleSymbol
                    ? this.checker
                          .getExportsOfModule(moduleSymbol)
                          .map((symbol) =>
                              (symbol.flags &
                                  ts.SymbolFlags.Alias) !==
                              0
                                  ? this.checker.getAliasedSymbol(
                                        symbol,
                                    )
                                  : symbol,
                          )
                    : [],
            );
            const isExported = (
                name: ts.Identifier,
            ): boolean => {
                const symbol = this.symbols.valueSymbol(name);
                return (
                    symbol !== undefined &&
                    exported.has(symbol)
                );
            };
            for (const statement of file.statements) {
                if (
                    ts.isFunctionDeclaration(statement) &&
                    statement.name &&
                    statement.body &&
                    isExported(statement.name)
                ) {
                    visit(statement.body);
                    continue;
                }
                if (
                    ts.isClassDeclaration(statement) &&
                    statement.name &&
                    isExported(statement.name)
                ) {
                    visit(statement);
                    continue;
                }
                if (!ts.isVariableStatement(statement)) {
                    continue;
                }
                for (const declaration of statement
                    .declarationList.declarations) {
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.initializer &&
                        ts.isFunctionLike(
                            declaration.initializer,
                        ) &&
                        isExported(declaration.name)
                    ) {
                        visit(declaration.initializer);
                    }
                }
            }
        }

        let previousSize = -1;
        while (observed.size !== previousSize) {
            previousSize = observed.size;
            for (const file of projectModules) {
                if (
                    !this.moduleHasObservableInitializer(
                        file,
                        observed,
                    )
                ) {
                    continue;
                }
                for (const symbol of
                    this.moduleInitializerStateDependencies(
                        file,
                        moduleState,
                    )) {
                    observed.add(symbol);
                }
            }
        }
        return observed;
    }

    /** Module storage read or written by eagerly executed top-level work. */
    private moduleInitializerStateDependencies(
        file: ts.SourceFile,
        moduleState: ReadonlySet<ts.Symbol>,
    ): Set<ts.Symbol> {
        const dependencies = new Set<ts.Symbol>();
        const activeFunctions = new Set<
            ts.FunctionLikeDeclaration
        >();
        const visit = (node: ts.Node): void => {
            if (ts.isFunctionLike(node)) {
                return;
            }
            if (ts.isIdentifier(node)) {
                const symbol = this.symbols.valueSymbol(node);
                if (symbol && moduleState.has(symbol)) {
                    dependencies.add(symbol);
                }
            }
            if (ts.isCallExpression(node)) {
                const called = this.calledFunction(
                    node.expression,
                );
                if (
                    called?.body &&
                    !activeFunctions.has(called)
                ) {
                    activeFunctions.add(called);
                    visit(called.body);
                }
            }
            ts.forEachChild(node, visit);
        };
        for (const statement of file.statements) {
            if (!isModuleInitializerStatement(statement)) {
                continue;
            }
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement
                    .declarationList.declarations) {
                    if (declaration.initializer) {
                        visit(declaration.initializer);
                    }
                }
                continue;
            }
            visit(statement);
        }
        return dependencies;
    }

    private moduleHasObservableInitializer(
        file: ts.SourceFile,
        moduleState: ReadonlySet<ts.Symbol>,
    ): boolean {
        return (
            moduleState.size > 0 &&
            this.nodeMayMutateSymbols(
                file,
                moduleState,
                new Set(),
            )
        );
    }

    private calledFunction(
        expression: ts.Expression,
    ): ts.FunctionLikeDeclaration | undefined {
        let current = expression;
        while (
            ts.isParenthesizedExpression(current) ||
            ts.isAsExpression(current) ||
            ts.isTypeAssertionExpression(current) ||
            ts.isNonNullExpression(current) ||
            ts.isSatisfiesExpression(current)
        ) {
            current = current.expression;
        }
        if (
            ts.isArrowFunction(current) ||
            ts.isFunctionExpression(current)
        ) {
            return current;
        }
        if (!ts.isIdentifier(current)) {
            return undefined;
        }
        const declaration = this.symbols
            .valueSymbol(current)
            ?.valueDeclaration;
        if (declaration && ts.isFunctionLike(declaration)) {
            return declaration as ts.FunctionLikeDeclaration;
        }
        return declaration &&
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer &&
            ts.isFunctionLike(declaration.initializer)
            ? (declaration.initializer as ts.FunctionLikeDeclaration)
            : undefined;
    }

    private nodeMayMutateSymbols(
        node: ts.Node,
        targets: ReadonlySet<ts.Symbol>,
        activeFunctions: Set<ts.FunctionLikeDeclaration>,
        aliases = new Set(targets),
    ): boolean {
        let found = false;
        const targetsSymbol = (
            expression: ts.Expression,
        ): boolean => {
            let current = expression;
            while (true) {
                if (ts.isIdentifier(current)) {
                    const symbol = this.symbols.valueSymbol(
                        current,
                    );
                    return (
                        symbol !== undefined &&
                        aliases.has(symbol)
                    );
                }
                if (
                    ts.isPropertyAccessExpression(current) ||
                    ts.isElementAccessExpression(current)
                ) {
                    current = current.expression;
                    continue;
                }
                if (
                    ts.isParenthesizedExpression(current) ||
                    ts.isAsExpression(current) ||
                    ts.isTypeAssertionExpression(current) ||
                    ts.isNonNullExpression(current) ||
                    ts.isSatisfiesExpression(current)
                ) {
                    current = current.expression;
                    continue;
                }
                return false;
            }
        };
        const visit = (current: ts.Node): void => {
            if (found || ts.isFunctionLike(current)) {
                return;
            }
            if (
                ts.isVariableDeclaration(current) &&
                ts.isIdentifier(current.name) &&
                current.initializer &&
                targetsSymbol(current.initializer)
            ) {
                const alias = this.symbols.valueSymbol(
                    current.name,
                );
                if (alias) {
                    aliases.add(alias);
                }
            }
            if (
                ts.isBinaryExpression(current) &&
                current.operatorToken.kind >=
                    ts.SyntaxKind.FirstAssignment &&
                current.operatorToken.kind <=
                    ts.SyntaxKind.LastAssignment &&
                targetsSymbol(current.left)
            ) {
                found = true;
                return;
            }
            if (
                (ts.isPostfixUnaryExpression(current) ||
                    ts.isPrefixUnaryExpression(current)) &&
                targetsSymbol(current.operand)
            ) {
                found = true;
                return;
            }
            if (
                ts.isDeleteExpression(current) &&
                targetsSymbol(current.expression)
            ) {
                found = true;
                return;
            }
            if (ts.isCallExpression(current)) {
                const callee = current.expression;
                if (
                    (ts.isPropertyAccessExpression(callee) ||
                        ts.isElementAccessExpression(callee)) &&
                    targetsSymbol(callee.expression)
                ) {
                    found = true;
                    return;
                }
                if (current.arguments.some(targetsSymbol)) {
                    found = true;
                    return;
                }
                const called = this.calledFunction(callee);
                if (
                    called?.body &&
                    !activeFunctions.has(called)
                ) {
                    activeFunctions.add(called);
                    if (
                        this.nodeMayMutateSymbols(
                            called.body,
                            targets,
                            activeFunctions,
                            aliases,
                        )
                    ) {
                        found = true;
                        return;
                    }
                }
            }
            ts.forEachChild(current, visit);
        };
        visit(node);
        return found;
    }
}
