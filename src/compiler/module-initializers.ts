import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import ts from "typescript";
import { typeCanCarryReference, callSignatures } from "./type-facts.js";
import { isRuntimeImport } from "../module-imports.js";
import { findAnalysisNode, forEachAnalysisNode } from "./analysis-walk.js";
import { isInstantiatedNamespace } from "./namespace-declarations.js";
import {
    aliasTarget,
    declaredSymbol,
    type CompilerSymbols,
} from "./symbols.js";
import {
    ClassHierarchy,
    classHasStaticState,
    classMemberTable,
} from "./class-members.js";
import { EvaluationOrder } from "./evaluation-order.js";
import {
    unwrapExpression,
    writeSites,
    variableKind,
    isMemberAccess,
} from "./syntax.js";
import { isRebound } from "./binding-rebinds.js";
import {
    moduleConstantIsWritten,
    moduleContainerSymbol,
    type ModuleConstantWrites,
} from "./module-container-writes.js";

/** Immutable runtime edges in source order, excluding type-only dependencies. */
export function runtimeModuleDependencies(
    checker: ts.TypeChecker,
    file: ts.SourceFile,
): ts.SourceFile[] {
    return file.statements.flatMap((statement) => {
        if (
            (!ts.isImportDeclaration(statement) &&
                !ts.isExportDeclaration(statement)) ||
            !statement.moduleSpecifier ||
            !isRuntimeImport(checker, statement)
        )
            return [];
        const dependency = declaredSymbol(
            checker,
            statement.moduleSpecifier,
        )?.declarations?.find(ts.isSourceFile);
        return dependency ? [dependency] : [];
    });
}

/** Statements JavaScript executes while evaluating an imported module. */
export function isModuleInitializerStatement(
    statement: ts.Statement,
    checker: ts.TypeChecker,
): boolean {
    // A class body runs nothing when its declaration evaluates -- except its
    // static fields and `static { ... }` blocks, which run then.
    if (ts.isClassDeclaration(statement)) {
        return classHasStaticState(checker, statement);
    }
    // A namespace declaring values runs its body.
    if (ts.isModuleDeclaration(statement))
        return isInstantiatedNamespace(statement);
    return !(
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)
    );
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

/** Array spread copies its iterable once during module evaluation. */
function hasArraySnapshot(declaration: ts.VariableDeclaration): boolean {
    if (!declaration.initializer) return false;
    const initializer = unwrapExpression(declaration.initializer);
    return (
        ts.isArrayLiteralExpression(initializer) &&
        initializer.elements.some(ts.isSpreadElement)
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
 * An object literal holding a member a program calls (a method, an
 * accessor, a function value): the static path does not lower calls on an
 * imported record's members, so such a record keeps runtime storage.
 */
export function recordHoldsCallables(
    checker: ts.TypeChecker,
    initializer: ts.Expression,
): boolean {
    const current = unwrapExpression(initializer);
    return (
        ts.isObjectLiteralExpression(current) &&
        (isRecordWithMethods(current) ||
            current.properties.some(
                (property) =>
                    (ts.isPropertyAssignment(property) ||
                        ts.isShorthandPropertyAssignment(property)) &&
                    callSignatures(
                        checker,
                        checker.getTypeAtLocation(property.name),
                        "present",
                    ).length > 0,
            ))
    );
}

/** Whether a function body reads `this` as its own receiver (arrow functions share it). */
function readsOwnReceiver(body: ts.Node): boolean {
    const visit = (node: ts.Node): boolean =>
        node.kind === ts.SyntaxKind.ThisKeyword ||
        (!ts.isClassLike(node) &&
            !(ts.isFunctionLike(node) && !ts.isArrowFunction(node)) &&
            ts.forEachChild(node, visit) === true);
    return ts.forEachChild(body, visit) === true;
}

/** An object literal with a method or accessor that reads `this`. */
function isRecordWithReceiverMethods(initializer: ts.Expression): boolean {
    const current = unwrapExpression(initializer);
    return (
        ts.isObjectLiteralExpression(current) &&
        current.properties.some((property) => {
            const method =
                ts.isMethodDeclaration(property) ||
                ts.isGetAccessorDeclaration(property) ||
                ts.isSetAccessorDeclaration(property)
                    ? property
                    : ts.isPropertyAssignment(property) &&
                        ts.isFunctionExpression(property.initializer)
                      ? property.initializer
                      : undefined;
            return method?.body !== undefined && readsOwnReceiver(method.body);
        })
    );
}

/**
 * A `const` container the program writes into: storage as much as a
 * rebound `let`, because its initializer stops describing it at the
 * first push or field write.
 */
function isMutatedContainer(
    writes: ModuleConstantWrites,
    declaration: ts.VariableDeclaration,
): boolean {
    return (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer !== undefined &&
        isContainerInitializer(declaration.initializer) &&
        moduleConstantIsWritten(writes, declaration.name)
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
export function planImportedModuleState(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
    evaluationOrder = new EvaluationOrder(
        checker,
        new ClassHierarchy(checker, program),
    ),
    retainedDeclarations: Iterable<ts.VariableDeclaration> = [],
): ts.SourceFile[] {
    return new ModuleInitializerPlanner(
        program,
        sourceFile,
        checker,
        symbols,
        evaluationOrder,
    ).plan(retainedDeclarations);
}

/**
 * The entry module's shared state, including containers whose reached uses
 * request retained identity through storage replay.
 *
 * An implicit main body needs storage for names its functions share.
 * Authored module entries emit their own declarations and skip this plan's
 * duplicates. Immutable values can remain on the static evaluator path.
 */
export function planEntryModuleState(
    program: ts.Program,
    sourceFile: ts.SourceFile,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
    retainedDeclarations: Iterable<ts.VariableDeclaration> = [],
): readonly ts.Statement[] {
    return new ModuleInitializerPlanner(
        program,
        sourceFile,
        checker,
        symbols,
    ).planEntryState(retainedDeclarations);
}

/** The function a callee expression names, as the planner resolves it. */
function calleeFunction(
    symbols: CompilerSymbols,
    expression: ts.Expression,
): ts.FunctionLikeDeclaration | undefined {
    const current = unwrapExpression(expression);
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
        return current;
    }
    if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) {
        return undefined;
    }
    const name = ts.isPropertyAccessExpression(current)
        ? current.name
        : current;
    if (!ts.isIdentifier(name)) return undefined;
    const declaration = symbols.valueSymbol(name)?.valueDeclaration;
    if (declaration && ts.isFunctionLike(declaration)) {
        return declaration as ts.FunctionLikeDeclaration;
    }
    return declaration &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer &&
        ts.isFunctionLike(declaration.initializer)
        ? declaration.initializer
        : undefined;
}

/**
 * A `const` whose initializer creates an object its members need, so
 * JavaScript's one evaluation in module order is observable: a record
 * whose methods read `this`, or a call whose function leaves closures
 * behind that write its locals or returns locally initialized callables.
 * Evaluated again at each use (the static
 * path), every receiver would get another object, and a member call or
 * a member read as a callback, through an element access or a holder
 * would run on state no other use sees.
 */
export function createsReceiverState(
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
    declaration: ts.VariableDeclaration,
): boolean {
    const initializer = declaration.initializer;
    if (!initializer) return false;
    if (isRecordWithReceiverMethods(initializer)) return true;
    const call = unwrapExpression(initializer);
    const called = ts.isCallExpression(call)
        ? calleeFunction(symbols, call.expression)
        : undefined;
    if (!called?.body) return false;
    const owner = (node: ts.Node) =>
        ts.findAncestor(node.parent, ts.isFunctionLike);
    // A returned callable binding needs the factory's evaluated scope,
    // even if all its assignments happened before the return.
    if (
        findAnalysisNode(called.body, (node) => {
            if (
                !ts.isReturnStatement(node) ||
                !node.expression ||
                owner(node) !== called
            )
                return false;
            return (
                findAnalysisNode(
                    node.expression,
                    (part) => {
                        if (!ts.isIdentifier(part)) return false;
                        const local =
                            symbols.valueSymbol(part)?.valueDeclaration;
                        return (
                            local !== undefined &&
                            ts.isVariableDeclaration(local) &&
                            owner(local) === called &&
                            callSignatures(
                                checker,
                                checker.getTypeAtLocation(part),
                                "exact",
                            ).length !== 0
                        );
                    },
                    { functions: "skip" },
                ) !== undefined
            );
        }) !== undefined
    )
        return true;
    const writesLocal = (target: ts.Expression): boolean => {
        const name = unwrapExpression(target);
        const local = ts.isIdentifier(name)
            ? symbols.valueSymbol(name)?.valueDeclaration
            : undefined;
        return (
            local !== undefined &&
            ts.isVariableDeclaration(local) &&
            owner(local) === called
        );
    };
    return (
        findAnalysisNode(
            called.body,
            (node) =>
                owner(node) !== called &&
                writeSites(node).some(({ target }) => writesLocal(target)),
        ) !== undefined
    );
}

class ModuleInitializerPlanner implements ModuleConstantWrites {
    public constructor(
        public readonly program: ts.Program,
        private readonly sourceFile: ts.SourceFile,
        public readonly checker: ts.TypeChecker,
        public readonly symbols: CompilerSymbols,
        public readonly evaluationOrder = new EvaluationOrder(
            checker,
            new ClassHierarchy(checker, program),
        ),
    ) {}

    public plan(
        retainedDeclarations: Iterable<ts.VariableDeclaration> = [],
    ): ts.SourceFile[] {
        const retainedModules = new Set(
            [...retainedDeclarations]
                .filter(
                    (declaration) =>
                        ts.isVariableStatement(declaration.parent.parent) &&
                        ts.isSourceFile(declaration.parent.parent.parent),
                )
                .map((declaration) => declaration.getSourceFile()),
        );
        const projectModules = this.runtimeModules().filter(
            (file) => file !== this.sourceFile,
        );
        const stateByModule = new EmissionMap(
            projectModules.map((file) => [
                file,
                this.moduleVariableSymbols(file),
            ]),
        );
        const allState = new EmissionSet(
            [...stateByModule.values()].flatMap((state) => [...state]),
        );
        const observedState = this.runtimeObservedModuleState(
            projectModules,
            allState,
        );
        const mutatingModules = new EmissionSet(
            projectModules.filter((file) =>
                this.moduleHasObservableInitializer(file, observedState),
            ),
        );
        const mutableStateModules = new EmissionSet(
            projectModules.filter((file) =>
                this.moduleHasObservedMutableState(file, observedState),
            ),
        );
        if (
            mutatingModules.size === 0 &&
            mutableStateModules.size === 0 &&
            retainedModules.size === 0
        ) {
            return [];
        }

        // A registrar module may populate storage declared by one of its
        // dependencies. Materialize both the work and the owner of every
        // state symbol that work can mutate.
        const mutatedState = new EmissionSet<ts.Symbol>();
        for (const file of mutatingModules) {
            for (const symbol of this.moduleInitializerMutations(file)) {
                if (observedState.has(symbol)) mutatedState.add(symbol);
            }
        }
        return projectModules.filter(
            (file) =>
                mutatingModules.has(file) ||
                mutableStateModules.has(file) ||
                retainedModules.has(file) ||
                [...(stateByModule.get(file) ?? [])].some((symbol) =>
                    mutatedState.has(symbol),
                ),
        );
    }

    /** @unjournaled Derived from the program alone, on first use. */
    private runtimeModuleCache: ts.SourceFile[] | undefined;

    /** JavaScript evaluation order follows runtime edges, including re-exports. */
    private runtimeModules(): ts.SourceFile[] {
        if (this.runtimeModuleCache) return this.runtimeModuleCache;
        const ordered: ts.SourceFile[] = [];
        const visited = new Set<ts.SourceFile>();
        const visit = (file: ts.SourceFile): void => {
            if (
                visited.has(file) ||
                file.isDeclarationFile ||
                this.program.isSourceFileFromExternalLibrary(file)
            )
                return;
            visited.add(file);
            runtimeModuleDependencies(this.checker, file).forEach(visit);
            ordered.push(file);
        };
        visit(this.sourceFile);
        return (this.runtimeModuleCache = ordered);
    }

    /**
     * Entry-file declarations requiring shared native storage.
     *
     * Not `moduleHasObservableInitializer`, which asks a different question
     * for a different file: there the subject is an IMPORTED module and the
     * search is confined to work JavaScript runs eagerly, because that is
     * what decides whether the module leaves the lazy path. Here the subject
     * is the entry itself, every function it declares is part of the program
     * being emitted, and one write anywhere in the file is enough to make the
     * name storage rather than a folded constant.
     *
     * Container representation belongs to the data lowerer; its explicit
     * storage demands retain the original declaration here too.
     */
    public planEntryState(
        retainedDeclarations: Iterable<ts.VariableDeclaration>,
    ): readonly ts.Statement[] {
        const retained = new Set(retainedDeclarations);
        // At module scope an incremented name is storage too.
        const rebound = (symbol: ts.Symbol): boolean =>
            isRebound(this.checker, this.program.getSourceFiles(), symbol);
        const result: ts.Statement[] = [];
        for (const statement of this.sourceFile.statements) {
            // A class declaration beside `main` still evaluates its static
            // fields and blocks when the module does.
            if (
                ts.isClassDeclaration(statement) &&
                classHasStaticState(this.checker, statement)
            ) {
                result.push(statement);
                continue;
            }
            if (!ts.isVariableStatement(statement)) {
                continue;
            }
            const isConst = variableKind(statement.declarationList) === "const";
            const selected = statement.declarationList.declarations.some(
                (declaration) => {
                    if (retained.has(declaration)) return true;
                    if (!ts.isIdentifier(declaration.name)) return false;
                    const symbol = this.symbols.valueSymbol(declaration.name);
                    if (symbol === undefined) return false;
                    if (!isConst) return rebound(symbol);
                    // A record carrying methods binds here too, so its
                    // methods have a receiver to run against.
                    return (
                        hasArraySnapshot(declaration) ||
                        (declaration.initializer !== undefined &&
                            isRecordWithMethods(declaration.initializer)) ||
                        isMutatedContainer(this, declaration)
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
        for (const statement of file.statements) {
            // A class's static fields are storage its declaration creates.
            if (ts.isClassDeclaration(statement)) {
                for (const field of classMemberTable(
                    this.checker,
                    statement,
                ).staticFields.values()) {
                    const symbol = this.symbols.valueSymbol(field.name);
                    if (symbol) result.add(symbol);
                }
                continue;
            }
            if (!ts.isVariableStatement(statement)) {
                continue;
            }
            const isConst = variableKind(statement.declarationList) === "const";
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }
                const symbol = this.symbols.valueSymbol(declaration.name);
                if (!symbol) {
                    continue;
                }
                if (
                    subset === "mutable" &&
                    isConst &&
                    !hasArraySnapshot(declaration) &&
                    !this.createsReceiverState(declaration) &&
                    !isMutatedContainer(this, declaration)
                ) {
                    continue;
                }
                result.add(symbol);
            }
        }
        return result;
    }

    private createsReceiverState(declaration: ts.VariableDeclaration): boolean {
        return createsReceiverState(this.checker, this.symbols, declaration);
    }

    private runtimeObservedModuleState(
        projectModules: readonly ts.SourceFile[],
        moduleState: ReadonlySet<ts.Symbol>,
    ): Set<ts.Symbol> {
        const observed = new EmissionSet<ts.Symbol>();
        const projectFiles = new Set([this.sourceFile, ...projectModules]);
        const visitedFunctions = new Set<ts.Node>();
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (ts.isFunctionLike(node)) {
                    if (visitedFunctions.has(node)) return "skip";
                    visitedFunctions.add(node);
                }
                if (
                    ts.isIdentifier(node) ||
                    ts.isPropertyAccessExpression(node) ||
                    ts.isElementAccessExpression(node)
                ) {
                    const symbol = moduleContainerSymbol(
                        node,
                        this.checker,
                        this.symbols,
                    );
                    if (symbol && moduleState.has(symbol)) {
                        observed.add(symbol);
                    }
                }
                if (ts.isCallExpression(node)) {
                    const called = this.calledFunction(node.expression);
                    if (
                        called?.body &&
                        projectFiles.has(called.getSourceFile())
                    ) {
                        visit(called);
                    }
                }
            });
        visit(this.sourceFile);
        for (const file of projectModules) {
            const moduleSymbol = declaredSymbol(this.checker, file);
            const exported = new EmissionSet(
                moduleSymbol
                    ? this.checker
                          .getExportsOfModule(moduleSymbol)
                          .map((symbol) => aliasTarget(this.checker, symbol))
                    : [],
            );
            const isExported = (name: ts.Identifier): boolean => {
                const symbol = this.symbols.valueSymbol(name);
                return symbol !== undefined && exported.has(symbol);
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
                for (const declaration of statement.declarationList
                    .declarations) {
                    if (
                        ts.isIdentifier(declaration.name) &&
                        declaration.initializer &&
                        ts.isFunctionLike(declaration.initializer) &&
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
                if (!this.moduleHasObservableInitializer(file, observed)) {
                    continue;
                }
                for (const symbol of this.moduleInitializerStateDependencies(
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
        const activeFunctions = new EmissionSet<ts.FunctionLikeDeclaration>();
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(
                root,
                (node) => {
                    if (
                        ts.isIdentifier(node) ||
                        ts.isPropertyAccessExpression(node) ||
                        ts.isElementAccessExpression(node)
                    ) {
                        const symbol = moduleContainerSymbol(
                            node,
                            this.checker,
                            this.symbols,
                        );
                        if (symbol && moduleState.has(symbol)) {
                            dependencies.add(symbol);
                        }
                    }
                    if (ts.isCallExpression(node)) {
                        const called = this.calledFunction(node.expression);
                        if (called?.body && !activeFunctions.has(called)) {
                            activeFunctions.add(called);
                            visit(called.body);
                        }
                    }
                },
                { functions: "skip" },
            );
        for (const statement of file.statements) {
            if (!isModuleInitializerStatement(statement, this.checker)) {
                continue;
            }
            if (ts.isVariableStatement(statement)) {
                for (const declaration of statement.declarationList
                    .declarations) {
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

    /** @unjournaled Potential host effects depend only on the checked source. */
    private readonly hostInitializerEffects = new Map<ts.SourceFile, boolean>();

    private initializerHasHostEffects(expression: ts.Expression): boolean {
        return this.evaluationOrder.hasModuleEffects(
            this.symbols.pinnedWgslTemplate(expression) ?? expression,
        );
    }

    private moduleHasObservableInitializer(
        file: ts.SourceFile,
        moduleState: ReadonlySet<ts.Symbol>,
    ): boolean {
        // Authored statements run even when their effects target host state
        // instead of a module variable. This also retains static class work,
        // where unsupported forms must be refused by class lowering.
        let hostEffects = this.hostInitializerEffects.get(file);
        if (hostEffects === undefined) {
            hostEffects = file.statements.some((statement) => {
                if (!isModuleInitializerStatement(statement, this.checker))
                    return false;
                if (ts.isClassDeclaration(statement)) return true;
                if (ts.isVariableStatement(statement))
                    return statement.declarationList.declarations.some(
                        (declaration) =>
                            declaration.initializer &&
                            this.initializerHasHostEffects(
                                declaration.initializer,
                            ),
                    );
                if (ts.isExportAssignment(statement))
                    return this.initializerHasHostEffects(statement.expression);
                return (
                    !ts.isEmptyStatement(statement) &&
                    this.evaluationOrder.hasModuleEffects(statement)
                );
            });
            this.hostInitializerEffects.set(file, hostEffects);
        }
        if (hostEffects) return true;
        if (moduleState.size === 0) return false;
        for (const symbol of this.moduleInitializerMutations(file)) {
            if (moduleState.has(symbol)) return true;
        }
        return false;
    }

    private calledFunction(
        expression: ts.Expression,
    ): ts.FunctionLikeDeclaration | undefined {
        return calleeFunction(this.symbols, expression);
    }

    /** @unjournaled A cache of each file's writes, from its source alone. */
    private readonly initializerMutationCache = new Map<
        ts.SourceFile,
        ReadonlySet<ts.Symbol>
    >();

    /** One target-independent walk, reused as the observed-state set grows.
     * Alias origins are copied at the declaration, in the same preorder as
     * the eager call walk. Function bodies are entered only through calls.
     */
    private moduleInitializerMutations(
        file: ts.SourceFile,
    ): ReadonlySet<ts.Symbol> {
        const cached = this.initializerMutationCache.get(file);
        if (cached) return cached;
        const mutations = new Set<ts.Symbol>();
        const aliases = new Map<ts.Symbol, Set<ts.Symbol>>();
        const activeFunctions = new Set<ts.FunctionLikeDeclaration>();
        const expressionSymbol = (
            expression: ts.Expression,
        ): ts.Symbol | undefined => {
            return moduleContainerSymbol(
                expression,
                this.checker,
                this.symbols,
            );
        };
        const record = (expression: ts.Expression, through = false): void => {
            const symbol = expressionSymbol(expression);
            if (
                !symbol ||
                (through &&
                    !typeCanCarryReference(
                        this.checker.getTypeAtLocation(expression),
                    ))
            )
                return;
            mutations.add(symbol);
            for (const origin of aliases.get(symbol) ?? [])
                mutations.add(origin);
        };
        const visit = (node: ts.Node): void =>
            forEachAnalysisNode(
                node,
                (current) => {
                    if (
                        ts.isVariableDeclaration(current) &&
                        ts.isIdentifier(current.name) &&
                        current.initializer
                    ) {
                        const origin = expressionSymbol(current.initializer);
                        const alias = this.symbols.valueSymbol(current.name);
                        if (origin && alias) {
                            const origins =
                                aliases.get(alias) ?? new Set<ts.Symbol>();
                            origins.add(origin);
                            for (const source of aliases.get(origin) ?? [])
                                origins.add(source);
                            aliases.set(alias, origins);
                        }
                    }
                    for (const { target } of writeSites(current))
                        record(target);
                    if (ts.isCallExpression(current)) {
                        const callee = current.expression;
                        if (isMemberAccess(callee)) {
                            record(callee.expression, true);
                        }
                        for (const argument of current.arguments)
                            record(argument, true);
                        const called = this.calledFunction(callee);
                        if (called?.body && !activeFunctions.has(called)) {
                            activeFunctions.add(called);
                            visit(called.body);
                        }
                    }
                },
                { functions: "skip" },
            );
        visit(file);
        this.initializerMutationCache.set(file, mutations);
        return mutations;
    }
}
