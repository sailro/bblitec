import ts from "typescript";
import type { CompilerSymbols } from "./symbols.js";
import { isAssignmentExpression, isUpdateExpression } from "./syntax.js";

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
 * Every name `sourceFile` rebinds, resolved in one walk for the whole file.
 *
 * `countUpdateOperators` decides whether `++`/`--` joins the set. The
 * module-state planner counts it -- `count++` at module scope is what makes
 * the name storage rather than a folded constant -- and the declaration
 * lowering's `identifierIsRebound` does not. The two answers are different
 * answers, so sharing one walk keeps the arm a parameter rather than merging
 * it: a caller that gains `++`/`--` here changes what every scene emits.
 */
export function collectReboundSymbols(
    sourceFile: ts.SourceFile,
    symbols: CompilerSymbols,
    countUpdateOperators: boolean,
): Set<ts.Symbol> {
    const rebound = new Set<ts.Symbol>();
    const record = (target: ts.Expression): void => {
        if (!ts.isIdentifier(target)) return;
        const symbol = symbols.valueSymbol(target);
        if (symbol) rebound.add(symbol);
    };
    const visit = (node: ts.Node): void => {
        if (isAssignmentExpression(node)) {
            record(node.left);
        } else if (countUpdateOperators && isUpdateExpression(node)) {
            record(node.operand);
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return rebound;
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

/**
 * The entry module's own mutable state: its top-level `let`/`var`
 * declarations that the file rebinds.
 *
 * A scene whose entry is `main()` never emits its module-scope statements --
 * the body of `main` is the program -- so nothing creates storage for a name
 * the module's functions share. A `const` needs none: its initializer never
 * stops being its value, and the static evaluator answers every read from it.
 * A rebound `let` does, because after the first write the initializer
 * describes a value that no longer exists.
 */
export function planEntryModuleState(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
): readonly ts.VariableStatement[] {
    return new ModuleInitializerPlanner(
        program,
        sourceFile,
        checker,
        symbols,
    ).planEntryState();
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
        const mutableStateModules = new Set(
            projectModules.filter((file) =>
                this.moduleHasObservedMutableState(
                    file,
                    observedState,
                ),
            ),
        );
        if (
            mutatingModules.size === 0 &&
            mutableStateModules.size === 0
        ) {
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
                mutableStateModules.has(file) ||
                [...(stateByModule.get(file) ?? [])].some(
                    (symbol) => mutatedState.has(symbol),
                ),
        );
    }

    /**
     * Entry-file top-level `let`/`var` statements the file rebinds.
     *
     * Not `moduleHasObservableInitializer`, which asks a different question
     * for a different file: there the subject is an IMPORTED module and the
     * search is confined to work JavaScript runs eagerly, because that is
     * what decides whether the module leaves the lazy path. Here the subject
     * is the entry itself, every function it declares is part of the program
     * being emitted, and one write anywhere in the file is enough to make the
     * name storage rather than a folded constant.
     *
     * Rebinding is the whole rule. A write THROUGH the name -- a property
     * assignment or a mutating method on an object it holds -- leaves the
     * binding pointing at the same object, so the declaration's own
     * initializer still describes it and the data lowerer keeps owning that
     * representation.
     */
    public planEntryState(): readonly ts.VariableStatement[] {
        // `true`: at module scope an incremented name is storage too.
        const rebound = collectReboundSymbols(
            this.sourceFile,
            this.symbols,
            true,
        );
        const result: ts.VariableStatement[] = [];
        for (const statement of this.sourceFile.statements) {
            if (
                !ts.isVariableStatement(statement) ||
                (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
            ) {
                continue;
            }
            const writes = statement.declarationList.declarations.some(
                (declaration) => {
                    if (!ts.isIdentifier(declaration.name)) return false;
                    const symbol = this.symbols.valueSymbol(declaration.name);
                    return symbol !== undefined && rebound.has(symbol);
                },
            );
            if (writes) result.push(statement);
        }
        return result;
    }

    /**
     * A `let`/`var` read or written by an exported callable is module storage,
     * even when its initializer is only `null` or another side-effect-free
     * value. JavaScript creates that storage once before the callable can run;
     * leaving the module on the lazy/static path would instead make the
     * callable's reads look like unbound browser values.
     */
    private moduleHasObservedMutableState(
        file: ts.SourceFile,
        observedState: ReadonlySet<ts.Symbol>,
    ): boolean {
        for (const symbol of this.moduleVariableSymbols(file, "mutable")) {
            if (observedState.has(symbol)) return true;
        }
        return false;
    }

    /**
     * Native storage declared by one project module, exported or private:
     * every variable, or only the `let`/`var` ones.
     */
    private moduleVariableSymbols(
        file: ts.SourceFile,
        subset: "all" | "mutable" = "all",
    ): Set<ts.Symbol> {
        const result = new Set<ts.Symbol>();
        for (const statement of file.statements) {
            if (
                !ts.isVariableStatement(statement) ||
                (subset === "mutable" &&
                    (statement.declarationList.flags &
                        ts.NodeFlags.Const) !==
                        0)
            ) {
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
                isAssignmentExpression(current) &&
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
