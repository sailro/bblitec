import { EmissionSet, EmissionMap } from "./emission-transaction.js";
import ts from "typescript";
import { typeCanCarryReference } from "./type-facts.js";
import { moduleImportKind } from "../module-imports.js";
import { findAnalysisNode, forEachAnalysisNode } from "./analysis-walk.js";
import { isInstantiatedNamespace } from "./namespace-declarations.js";
import { receiverWritingMethods } from "./receiver-methods.js";
import { callArgumentProjectionIsReadOnly } from "./parameter-projection-effects.js";
import { isSupportedFunction } from "./user-functions.js";
import {
    callArgumentIsReadOnly,
    libraryArgumentIsReadOnly,
    parameterIsReadOnly,
} from "./parameter-effects.js";
import { engineBodies, isEngineDeclaration } from "./engine-bodies.js";
import {
    accessedPropertySymbol,
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
    assignmentTargets,
    isAssignmentExpression,
    isUpdateExpression,
    mutatingCallTarget,
    propertyNameText,
    unwrapExpression,
} from "./syntax.js";

/** The owning binding beneath ordinary members and imported namespace exports. */
export function moduleContainerSymbol(
    expression: ts.Expression,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
): ts.Symbol | undefined {
    const current = unwrapExpression(expression);
    let symbol: ts.Symbol | undefined;
    if (ts.isIdentifier(current)) symbol = symbols.valueSymbol(current);
    else if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
    ) {
        const owner = checker.getTypeAtLocation(current.expression).getSymbol();
        if (owner?.declarations?.some(ts.isSourceFile)) {
            const exported = accessedPropertySymbol(checker, current);
            symbol = exported && aliasTarget(checker, exported);
        } else
            return moduleContainerSymbol(current.expression, checker, symbols);
    }
    return symbol?.declarations?.some(ts.isSourceFile) ? undefined : symbol;
}

/** Checked-source references are immutable across storage-demand replays. */
const moduleContainerFiles = new WeakMap<
    ts.Program,
    ReadonlyMap<ts.Symbol, readonly ts.SourceFile[]>
>();

/**
 * Files whose alias analysis can start from this binding. A file with no
 * occurrence of the original symbol cannot grow that analysis's alias set.
 * Keep its full traversal policy, including function bodies and type nodes.
 */
export function moduleContainerReferenceFiles(
    program: ts.Program,
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
    symbol: ts.Symbol,
): readonly ts.SourceFile[] {
    let indexed = moduleContainerFiles.get(program);
    if (!indexed) {
        const files = new Map<ts.Symbol, ts.SourceFile[]>();
        for (const file of program.getSourceFiles()) {
            if (file.isDeclarationFile) continue;
            const referenced = new Set<ts.Symbol>();
            forEachAnalysisNode(file, (node) => {
                if (
                    !ts.isIdentifier(node) &&
                    !ts.isPropertyAccessExpression(node) &&
                    !ts.isElementAccessExpression(node)
                )
                    return;
                const owner = moduleContainerSymbol(node, checker, symbols);
                if (owner) referenced.add(owner);
            });
            for (const owner of referenced) {
                const references = files.get(owner);
                if (references) references.push(file);
                else files.set(owner, [file]);
            }
        }
        indexed = files;
        moduleContainerFiles.set(program, indexed);
    }
    return indexed.get(symbol) ?? [];
}

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
            moduleImportKind(statement) === "type"
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
            assignmentTargets(node.left).forEach(record);
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

function pinnedCallArgumentIsReadOnly(
    declaration: ts.Declaration | undefined,
    index: number,
): boolean {
    if (!declaration || !isEngineDeclaration(declaration)) return false;
    const engine = engineBodies();
    const bodies = engine.bodies(declaration);
    // A missing mutation proof is not a read-only proof: interface members
    // and unsupported parameter bindings retain conservative storage.
    return (
        bodies !== undefined &&
        bodies.length > 0 &&
        bodies.every((body) => {
            const parameter = body.parameters[index];
            return (
                isSupportedFunction(body) &&
                parameter !== undefined &&
                !parameter.dotDotDotToken &&
                ts.isIdentifier(parameter.name) &&
                parameterIsReadOnly(
                    engine.checkerFor(body),
                    body,
                    parameter.name,
                )
            );
        })
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
    checker: ts.TypeChecker,
    symbols: CompilerSymbols,
): Set<ts.Symbol> {
    const mutated = new EmissionSet<ts.Symbol>();
    const aliases = new Map<ts.Symbol, ts.Symbol>();
    const record = (target: ts.Expression): void => {
        const symbol = moduleContainerSymbol(target, checker, symbols);
        if (symbol) mutated.add(symbol);
    };
    const recordThrough = (target: ts.Expression): void => {
        // A write to the name itself is a rebinding, not a write through it.
        const current = unwrapExpression(target);
        if (
            ts.isPropertyAccessExpression(current) ||
            ts.isElementAccessExpression(current)
        )
            record(current.expression);
    };
    forEachAnalysisNode(sourceFile, (node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            typeCanCarryReference(checker.getTypeAtLocation(node.initializer))
        ) {
            const alias = symbols.valueSymbol(node.name);
            const origin = moduleContainerSymbol(
                node.initializer,
                checker,
                symbols,
            );
            if (alias && origin) aliases.set(alias, origin);
        }
        if (ts.isCallExpression(node)) {
            const called = checker.getResolvedSignature(node)?.declaration;
            node.arguments.forEach((argument, index) => {
                if (
                    !typeCanCarryReference(
                        checker.getTypeAtLocation(argument),
                    ) ||
                    libraryArgumentIsReadOnly(checker, node, index) ||
                    pinnedCallArgumentIsReadOnly(called, index) ||
                    callArgumentIsReadOnly(checker, node, index)
                )
                    return;
                const visit = (
                    value: ts.Expression,
                    path: readonly string[],
                    consumer: ts.CallExpression = node,
                    parameterIndex = index,
                ): void => {
                    if (
                        !typeCanCarryReference(checker.getTypeAtLocation(value))
                    )
                        return;
                    if (
                        callArgumentProjectionIsReadOnly(
                            checker,
                            consumer,
                            parameterIndex,
                            path,
                        )
                    )
                        return;
                    const current = unwrapExpression(value);
                    if (
                        ts.isObjectLiteralExpression(current) &&
                        current.properties.every(
                            (property) =>
                                (ts.isPropertyAssignment(property) ||
                                    ts.isShorthandPropertyAssignment(
                                        property,
                                    )) &&
                                (ts.isIdentifier(property.name) ||
                                    ts.isStringLiteralLike(property.name) ||
                                    ts.isNumericLiteral(property.name)),
                        )
                    ) {
                        for (const property of current.properties) {
                            if (
                                ts.isPropertyAssignment(property) ||
                                ts.isShorthandPropertyAssignment(property)
                            )
                                visit(
                                    ts.isPropertyAssignment(property)
                                        ? property.initializer
                                        : property.name,
                                    [...path, propertyNameText(property.name)!],
                                    consumer,
                                    parameterIndex,
                                );
                        }
                        return;
                    }
                    if (
                        ts.isArrayLiteralExpression(current) &&
                        !current.elements.some(ts.isSpreadElement)
                    ) {
                        current.elements.forEach((element, i) => {
                            if (!ts.isOmittedExpression(element))
                                visit(
                                    element,
                                    [...path, String(i)],
                                    consumer,
                                    parameterIndex,
                                );
                        });
                        return;
                    }
                    const collect = (part: ts.Node): "skip" | undefined => {
                        // A copied scalar cannot carry its containing object's
                        // identity. Nested calls still receive their own analysis.
                        if (
                            ts.isExpression(part) &&
                            !typeCanCarryReference(
                                checker.getTypeAtLocation(part),
                            )
                        )
                            return "skip";
                        if (ts.isCallExpression(part)) {
                            // The outer consumer receives this call's result, not
                            // every reference used to compute it. Only inputs the
                            // nested call can retain propagate to that result.
                            part.arguments.forEach((argument, argumentIndex) =>
                                visit(argument, [], part, argumentIndex),
                            );
                            forEachAnalysisNode(part.expression, collect, {
                                functions: "skip",
                            });
                            return "skip";
                        }
                        if (
                            ts.isIdentifier(part) ||
                            ts.isPropertyAccessExpression(part) ||
                            ts.isElementAccessExpression(part)
                        ) {
                            const symbol = moduleContainerSymbol(
                                part,
                                checker,
                                symbols,
                            );
                            if (symbol) mutated.add(symbol);
                        }
                        return undefined;
                    };
                    forEachAnalysisNode(value, collect, { functions: "skip" });
                };
                visit(argument, []);
            });
        }
        if (isAssignmentExpression(node)) {
            assignmentTargets(node.left).forEach(recordThrough);
        } else if (isUpdateExpression(node)) {
            recordThrough(node.operand);
        } else if (ts.isDeleteExpression(node)) {
            recordThrough(node.expression);
        } else {
            const target = mutatingCallTarget(node, (method) =>
                receiverWritingMethods.has(method),
            );
            if (target) record(target);
        }
    });
    for (const symbol of mutated) {
        const origin = aliases.get(symbol);
        if (origin) mutated.add(origin);
    }
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
    return planImportedModuleState(program, sourceFile, checker, symbols)
        .modules;
}

/** Native module activation and the content writes requiring owned declarations. */
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
): {
    modules: ts.SourceFile[];
    mutatedContainers: ReadonlySet<ts.Symbol>;
} {
    const planner = new ModuleInitializerPlanner(
        program,
        sourceFile,
        checker,
        symbols,
        evaluationOrder,
    );
    const modules = planner.plan(retainedDeclarations);
    return {
        modules,
        mutatedContainers: planner.mutatedContainerSymbols(),
    };
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

class ModuleInitializerPlanner {
    public constructor(
        private readonly program: ts.Program,
        private readonly sourceFile: ts.SourceFile,
        private readonly checker: ts.TypeChecker,
        private readonly symbols: CompilerSymbols,
        private readonly evaluationOrder = new EvaluationOrder(
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
        // `true`: at module scope an incremented name is storage too.
        const rebound = collectReboundSymbols(
            this.sourceFile,
            this.symbols,
            true,
        );
        const mutated = collectMutatedContainerSymbols(
            this.sourceFile,
            this.checker,
            this.symbols,
        );
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
            const isConst =
                (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
            const selected = statement.declarationList.declarations.some(
                (declaration) => {
                    if (retained.has(declaration)) return true;
                    if (!ts.isIdentifier(declaration.name)) return false;
                    const symbol = this.symbols.valueSymbol(declaration.name);
                    if (symbol === undefined) return false;
                    if (!isConst) return rebound.has(symbol);
                    // A record carrying methods binds here too, so its
                    // methods have a receiver to run against.
                    return (
                        isMutatedContainer(declaration, symbol, mutated) ||
                        hasArraySnapshot(declaration) ||
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
            subset === "mutable" ? this.mutatedContainerSymbols() : undefined;
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
            const isConst =
                (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) {
                    continue;
                }
                const symbol = this.symbols.valueSymbol(declaration.name);
                if (!symbol) {
                    continue;
                }
                if (
                    mutatedContainers &&
                    isConst &&
                    !isMutatedContainer(
                        declaration,
                        symbol,
                        mutatedContainers,
                    ) &&
                    !hasArraySnapshot(declaration) &&
                    !this.createsReceiverState(declaration)
                ) {
                    continue;
                }
                result.add(symbol);
            }
        }
        return result;
    }

    /**
     * A `const` whose initializer creates an object its members need, so
     * JavaScript's one evaluation in module order is observable: a record
     * whose methods read `this`, or a call whose function leaves closures
     * behind that write its locals. Evaluated again at each use (the static
     * path), every receiver would get another object, and a member call or
     * a member read as a callback, through an element access or a holder
     * would run on state no other use sees.
     */
    private createsReceiverState(declaration: ts.VariableDeclaration): boolean {
        const initializer = declaration.initializer;
        if (!initializer) return false;
        if (isRecordWithReceiverMethods(initializer)) return true;
        const call = unwrapExpression(initializer);
        const called = ts.isCallExpression(call)
            ? this.calledFunction(call.expression)
            : undefined;
        if (!called?.body) return false;
        const owner = (node: ts.Node) =>
            ts.findAncestor(node.parent, ts.isFunctionLike);
        const writesLocal = (target: ts.Expression): boolean => {
            const name = unwrapExpression(target);
            const local = ts.isIdentifier(name)
                ? this.symbols.valueSymbol(name)?.valueDeclaration
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
                    (isAssignmentExpression(node)
                        ? assignmentTargets(node.left).some(writesLocal)
                        : isUpdateExpression(node) &&
                          writesLocal(node.operand)),
            ) !== undefined
        );
    }

    /** @unjournaled Derived from the program alone, on first use. */
    private mutatedContainerCache: Set<ts.Symbol> | undefined;

    /** Container names any project file writes into, entry included. */
    public mutatedContainerSymbols(): Set<ts.Symbol> {
        if (!this.mutatedContainerCache) {
            const mutated = new EmissionSet<ts.Symbol>();
            for (const file of this.runtimeModules()) {
                for (const symbol of collectMutatedContainerSymbols(
                    file,
                    this.checker,
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
        if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
            return current;
        }
        if (
            !ts.isIdentifier(current) &&
            !ts.isPropertyAccessExpression(current)
        ) {
            return undefined;
        }
        const name = ts.isPropertyAccessExpression(current)
            ? current.name
            : current;
        if (!ts.isIdentifier(name)) return undefined;
        const declaration = this.symbols.valueSymbol(name)?.valueDeclaration;
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
                    if (isAssignmentExpression(current)) {
                        assignmentTargets(current.left).forEach((target) =>
                            record(target),
                        );
                    }
                    if (isUpdateExpression(current)) {
                        record(current.operand);
                    }
                    if (ts.isDeleteExpression(current)) {
                        record(current.expression);
                    }
                    if (ts.isCallExpression(current)) {
                        const callee = current.expression;
                        if (
                            ts.isPropertyAccessExpression(callee) ||
                            ts.isElementAccessExpression(callee)
                        ) {
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
