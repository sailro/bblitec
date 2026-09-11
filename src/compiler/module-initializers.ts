import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import ts from "typescript";
import { typeCanCarryReference } from "./type-facts.js";
import { moduleImportKind } from "../module-imports.js";
import { forEachAnalysisNode, someAnalysisNode } from "./analysis-walk.js";
import { writeReceiverMethods } from "./data-methods.js";
import type { CompilerSymbols } from "./symbols.js";
import {
    isAssignmentExpression,
    isUpdateExpression,
    mutatingCallTarget,
    rootIdentifier,
    unwrapExpression,
} from "./syntax.js";

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
    const rebound = new EmissionSet<ts.Symbol>();
    const record = (target: ts.Expression): void => {
        if (!ts.isIdentifier(target)) return;
        const symbol = symbols.valueSymbol(target);
        if (symbol) rebound.add(symbol);
    };
    forEachAnalysisNode(sourceFile, (node) => {
        if (isAssignmentExpression(node)) {
            record(node.left);
        } else if (countUpdateOperators && isUpdateExpression(node)) {
            record(node.operand);
        }
    });
    return rebound;
}

/** The initializers that create a container a later write can reach into. */
function isContainerInitializer(initializer: ts.Expression): boolean {
    const current = unwrapExpression(initializer);
    return (
        ts.isObjectLiteralExpression(current) ||
        ts.isArrayLiteralExpression(current) ||
        (ts.isNewExpression(current) &&
            ts.isIdentifier(current.expression) &&
            ["Map", "Set", "WeakMap", "WeakSet", "Array"].includes(
                current.expression.text,
            ))
    );
}

/** An object literal declaring a method or a function-valued property. */
function isRecordWithMethods(initializer: ts.Expression): boolean {
    const current = unwrapExpression(initializer);
    return (
        ts.isObjectLiteralExpression(current) &&
        current.properties.some(
            (property) =>
                ts.isMethodDeclaration(property) ||
                ts.isGetAccessorDeclaration(property) ||
                ts.isSetAccessorDeclaration(property) ||
                (ts.isPropertyAssignment(property) &&
                    (ts.isArrowFunction(property.initializer) ||
                        ts.isFunctionExpression(property.initializer))),
        )
    );
}

/**
 * A `const` container the program writes into: storage as much as a
 * rebound `let`, because its initializer stops describing it at the
 * first push or field write.
 */
function isMutatedContainer(
    declaration: ts.VariableDeclaration,
    symbol: ts.Symbol,
    mutated: ReadonlySet<ts.Symbol>,
): boolean {
    return (
        mutated.has(symbol) &&
        declaration.initializer !== undefined &&
        isContainerInitializer(declaration.initializer)
    );
}

/**
 * Every name whose container `sourceFile` writes INTO -- a field store, an
 * element store, an increment through it, a `delete`, or a mutating
 * method call on it -- anywhere in the file, callbacks included. Rebinding
 * the name itself is `collectReboundSymbols`'s question; this one is about
 * what the name holds.
 */
function collectMutatedContainerSymbols(
    sourceFile: ts.SourceFile,
    symbols: CompilerSymbols,
): Set<ts.Symbol> {
    const mutated = new EmissionSet<ts.Symbol>();
    const record = (target: ts.Expression): void => {
        const identifier = rootIdentifier(target);
        const symbol = identifier && symbols.valueSymbol(identifier);
        if (symbol) mutated.add(symbol);
    };
    const recordThrough = (target: ts.Expression): void => {
        // A write to the name itself is a rebinding, not a write through it.
        if (!ts.isIdentifier(target)) record(target);
    };
    forEachAnalysisNode(sourceFile, (node) => {
        if (isAssignmentExpression(node)) {
            recordThrough(node.left);
        } else if (isUpdateExpression(node)) {
            recordThrough(node.operand);
        } else if (ts.isDeleteExpression(node)) {
            recordThrough(node.expression);
        } else {
            const target = mutatingCallTarget(node, (method) => writeReceiverMethods.has(method));
            if (target) record(target);
        }
    });
    return mutated;
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
        const projectModules = this.runtimeModules().filter(file => file !== this.sourceFile);
        const stateByModule = new EmissionMap(
            projectModules.map((file) => [
                file,
                this.moduleVariableSymbols(file),
            ]),
        );
        const allState = new EmissionSet(
            [...stateByModule.values()].flatMap((state) => [
                ...state,
            ]),
        );
        const observedState = this.runtimeObservedModuleState(
            projectModules,
            allState,
        );
        const mutatingModules = new EmissionSet(
            projectModules.filter((file) =>
                this.moduleHasObservableInitializer(
                    file,
                    observedState,
                ),
            ),
        );
        const mutableStateModules = new EmissionSet(
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
        const mutatedState = new EmissionSet<ts.Symbol>();
        for (const symbol of observedState) {
            if (
                [...mutatingModules].some((file) =>
                    this.moduleHasObservableInitializer(
                        file,
                        new EmissionSet([symbol]),
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

    private runtimeModuleCache: ts.SourceFile[] | undefined;

    /** JavaScript evaluation order follows runtime edges, including re-exports. */
    private runtimeModules(): ts.SourceFile[] {
        if (this.runtimeModuleCache) return this.runtimeModuleCache;
        const ordered: ts.SourceFile[] = [];
        const visited = new Set<ts.SourceFile>();
        const visit = (file: ts.SourceFile): void => {
            if (visited.has(file) || file.isDeclarationFile || this.program.isSourceFileFromExternalLibrary(file)) return;
            visited.add(file);
            for (const statement of file.statements) {
                if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
                    !statement.moduleSpecifier || moduleImportKind(statement) === "type") continue;
                const symbol = this.checker.getSymbolAtLocation(statement.moduleSpecifier);
                const dependency = symbol?.declarations?.find(ts.isSourceFile);
                if (dependency) visit(dependency);
            }
            ordered.push(file);
        };
        visit(this.sourceFile);
        return this.runtimeModuleCache = ordered;
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
        const mutated = collectMutatedContainerSymbols(
            this.sourceFile,
            this.symbols,
        );
        const result: ts.VariableStatement[] = [];
        for (const statement of this.sourceFile.statements) {
            if (!ts.isVariableStatement(statement)) {
                continue;
            }
            const isConst =
                (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
            const selected = statement.declarationList.declarations.some(
                (declaration) => {
                    if (!ts.isIdentifier(declaration.name)) return false;
                    const symbol = this.symbols.valueSymbol(declaration.name);
                    if (symbol === undefined) return false;
                    if (!isConst) return rebound.has(symbol);
                    // A record carrying methods binds here too, so its
                    // methods have a receiver to run against.
                    return (
                        isMutatedContainer(declaration, symbol, mutated) ||
                        (declaration.initializer !== undefined &&
                            isRecordWithMethods(declaration.initializer))
                    );
                },
            );
            if (selected) result.push(statement);
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
        const result = new EmissionSet<ts.Symbol>();
        // A `const` container a project file writes into is mutable state
        // too: an exported registry the entry pushes to, or one the
        // module's own callable fills.
        const mutatedContainers =
            subset === "mutable"
                ? this.mutatedContainerSymbols()
                : undefined;
        for (const statement of file.statements) {
            if (!ts.isVariableStatement(statement)) {
                continue;
            }
            const isConst =
                (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
            for (const declaration of statement.declarationList
                .declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }
                const symbol = this.symbols.valueSymbol(
                    declaration.name,
                );
                if (!symbol) {
                    continue;
                }
                if (
                    mutatedContainers &&
                    isConst &&
                    !isMutatedContainer(declaration, symbol, mutatedContainers)
                ) {
                    continue;
                }
                result.add(symbol);
            }
        }
        return result;
    }

    private mutatedContainerCache: Set<ts.Symbol> | undefined;

    /** Container names any project file writes into, entry included. */
    private mutatedContainerSymbols(): Set<ts.Symbol> {
        if (!this.mutatedContainerCache) {
            const mutated = new EmissionSet<ts.Symbol>();
            for (const file of this.runtimeModules()) {
                for (const symbol of collectMutatedContainerSymbols(
                    file,
                    this.symbols,
                )) {
                    mutated.add(symbol);
                }
            }
            this.mutatedContainerCache = mutated;
        }
        return this.mutatedContainerCache;
    }

    private runtimeObservedModuleState(
        projectModules: readonly ts.SourceFile[],
        moduleState: ReadonlySet<ts.Symbol>,
    ): Set<ts.Symbol> {
        const observed = new EmissionSet<ts.Symbol>();
        const projectFiles = new Set([this.sourceFile, ...projectModules]);
        const visitedFunctions = new Set<ts.Node>();
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, node => {
            if (ts.isFunctionLike(node)) {
                if (visitedFunctions.has(node)) return "skip";
                visitedFunctions.add(node);
            }
            if (ts.isIdentifier(node)) {
                const symbol = this.symbols.valueSymbol(node);
                if (symbol && moduleState.has(symbol)) {
                    observed.add(symbol);
                }
            }
            if (ts.isCallExpression(node)) {
                const called = this.calledFunction(node.expression);
                if (called?.body && projectFiles.has(called.getSourceFile())) {
                    visit(called);
                }
            }
        });
        visit(this.sourceFile);
        for (const file of projectModules) {
            const moduleSymbol =
                this.checker.getSymbolAtLocation(file);
            const exported = new EmissionSet(
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
                    visit(statement);
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
        const dependencies = new EmissionSet<ts.Symbol>();
        const activeFunctions = new EmissionSet<
            ts.FunctionLikeDeclaration
        >();
        const visit = (root: ts.Node): void => forEachAnalysisNode(root, node => {
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
        }, { functions: "skip" });
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
                new EmissionSet(),
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
        if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
            return undefined;
        }
        const name = ts.isPropertyAccessExpression(current) ? current.name : current;
        if (!ts.isIdentifier(name)) return undefined;
        const declaration = this.symbols
            .valueSymbol(name)
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
        aliases = new EmissionSet(targets),
    ): boolean {
        const canMutateThrough = (expression: ts.Expression): boolean => {
            return typeCanCarryReference(this.checker.getTypeAtLocation(expression));
        };
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
        return someAnalysisNode(node, (current) => {
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
                return true;
            }
            if (
                (ts.isPostfixUnaryExpression(current) ||
                    ts.isPrefixUnaryExpression(current)) &&
                targetsSymbol(current.operand)
            ) {
                return true;
            }
            if (
                ts.isDeleteExpression(current) &&
                targetsSymbol(current.expression)
            ) {
                return true;
            }
            if (ts.isCallExpression(current)) {
                const callee = current.expression;
                if (
                    (ts.isPropertyAccessExpression(callee) ||
                        ts.isElementAccessExpression(callee)) &&
                    targetsSymbol(callee.expression) && canMutateThrough(callee.expression)
                ) {
                    return true;
                }
                if (current.arguments.some(argument => targetsSymbol(argument) && canMutateThrough(argument))) {
                    return true;
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
                        return true;
                    }
                }
            }
            return false;
        }, { functions: "skip" });
    }
}
