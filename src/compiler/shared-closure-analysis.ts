import {
    forEachAnalysisNode,
    findAnalysisNodeWithState,
    someAnalysisNode,
} from "./analysis-walk.js";
import { EmissionMap, EmissionSet, journaled } from "./emission-transaction.js";
import ts from "typescript";
import { schedulerOf } from "./schedulers.js";
import { isRebound } from "./binding-rebinds.js";
import {
    choosesOperand,
    outermostWrapper,
    rootIdentifier,
    writeSites,
    parameterForArgument,
    containsSuspension,
    isAsyncFunction,
    isGeneratorFunction,
    isSupportedFunction,
    type SupportedFunction,
    variableKind,
} from "./syntax.js";
import { presentMembers, callSignatures } from "./type-facts.js";
import { isDeterministicRandomRead } from "./deterministic-random.js";
import type { LoweringServices } from "./lowering-services.js";
import { promiseReactionOf } from "./promises.js";
import { keptArguments } from "./kept-values.js";
import { memberAccessors, namedMember } from "./symbols.js";
import { isListenerRegistration } from "./receiver-methods.js";

interface SharedClosureBindings {
    captured: ReadonlySet<ts.Symbol>;
    forwarded: ReadonlySet<ts.Symbol>;
}

/**
 * Where a value written at `node` lands: past the wrappers and operators
 * that yield it, at the site that consumes it (`register(ready ? f : () =>
 * n)` consumes either closure as an argument). `selected` says the value
 * went through a run-time choice.
 */
function valueSite(node: ts.Expression): {
    value: ts.Expression;
    consumer: ts.Node;
    selected: boolean;
} {
    const value = outermostWrapper(node, { branches: "objects" });
    let selected = false;
    for (
        let current: ts.Node = node;
        current !== value;
        current = current.parent
    )
        selected ||= choosesOperand(current.parent);
    return { value, consumer: value.parent, selected };
}

/** Whether an async function awaits in its own body: a callback it calls can run after its caller resumed. */
function suspendsBeforeReturn(owner: ts.Node): boolean {
    return (
        isSupportedFunction(owner) &&
        owner.body !== undefined &&
        isAsyncFunction(owner) &&
        containsSuspension(owner.body)
    );
}

/**
 * A body a call through its declaration always runs. A record's own method
 * or function-valued property is a slot an assignment can replace.
 */
function isFixedBody(body: ts.Node): body is SupportedFunction {
    return (
        isSupportedFunction(body) &&
        !ts.isObjectLiteralExpression(body.parent) &&
        !ts.isPropertyAssignment(body.parent)
    );
}

/** What the shared-closure analysis reads of the compiler. */
interface SharedClosureContext extends Pick<
    LoweringServices,
    | "bindings"
    | "checker"
    | "dataTypes"
    | "evaluationOrder"
    | "libraryGlobal"
    | "options"
    | "sourceFile"
    | "symbols"
    | "unwrap"
> {
    /** Identity of the C++ lexical scope currently receiving emitted lines. */
    readonly activeEmissionScope: number;
    readonly program: ts.Program;
}

/**
 * Decides which bindings need shared closure storage: the locals a retained or frame callback
 * captures and some code writes, the arguments a call retains, and the identifiers a program
 * rebinds. Answers are cached per file and per frame closure.
 */
export class SharedClosureAnalysis {
    constructor(private readonly context: SharedClosureContext) {}

    /** @unjournaled The answers depend on the program's syntax and types alone. */
    private readonly sharedClosureSymbols = new WeakMap<
        ts.Node,
        SharedClosureBindings
    >();

    /**
     * JavaScript stored callbacks capture mutable bindings, not snapshots of
     * their current values. A `let` read by a function-valued object member or
     * retained file-change listener therefore needs a shared native cell:
     * separately emitted callbacks all dereference the same storage.
     */
    public needsSharedClosureStorage(
        declaration: ts.VariableDeclaration | ts.ParameterDeclaration,
        binding = ts.isIdentifier(declaration.name)
            ? declaration.name
            : undefined,
    ): boolean {
        if (
            !binding ||
            !declaration.parent ||
            (ts.isVariableDeclaration(declaration) &&
                (!ts.isVariableDeclarationList(declaration.parent) ||
                    variableKind(declaration.parent) === "const"))
        ) {
            return false;
        }
        if (
            ts.isVariableDeclaration(declaration) &&
            ts.isVariableStatement(declaration.parent.parent) &&
            ts.isSourceFile(declaration.parent.parent.parent) &&
            declaration.getSourceFile() !== this.context.sourceFile
        ) {
            return true;
        }
        const symbol = this.context.symbols.valueSymbol(binding);
        if (!symbol) return false;
        let owner: ts.Node = declaration;
        while (owner.parent && !ts.isFunctionLike(owner.parent)) {
            owner = owner.parent;
        }
        if (owner.parent) owner = owner.parent;
        const info = this.sharedClosureSymbolsFor(
            owner,
            this.context.bindings.variableScopes.length !== 1 ||
                this.context.activeEmissionScope !== 0,
        );
        return info === "in-cycle" || info.captured.has(symbol);
    }

    /** @unjournaled The owners under analysis, outermost first. */
    private readonly analysisStack: ts.Node[] = [];
    /** @unjournaled Owners whose analysis read an in-cycle answer: analyzed again when asked again. */
    private readonly provisionalAnalyses = new Set<ts.Node>();
    /** @unjournaled The answers depend on the program's syntax and types alone. */
    private readonly sharedFrameClosureSymbols = new WeakMap<
        ts.Node,
        SharedClosureBindings
    >();

    /**
     * An owner's closure bindings. An owner reached again through its own
     * calls (`this.a(cb)` <-> `this.b(cb)`) answers "in-cycle", which keeps
     * every argument conservatively; the analyses that read that answer are
     * not cached, so a later question outside the cycle is answered whole.
     */
    private sharedClosureSymbolsFor(
        owner: ts.Node,
        includeFrameRegistrations = false,
    ): SharedClosureBindings | "in-cycle" {
        const cache = includeFrameRegistrations
            ? this.sharedFrameClosureSymbols
            : this.sharedClosureSymbols;
        const cached = cache.get(owner);
        if (cached) return cached;
        const position = this.analysisStack.indexOf(owner);
        if (position >= 0) {
            for (const pending of this.analysisStack.slice(position))
                this.provisionalAnalyses.add(pending);
            return "in-cycle";
        }
        this.analysisStack.push(owner);
        try {
            const captured = this.collectSharedClosureSymbols(
                owner,
                includeFrameRegistrations,
            );
            if (!this.provisionalAnalyses.delete(owner))
                cache.set(owner, captured);
            return captured;
        } finally {
            this.analysisStack.pop();
        }
    }

    /**
     * The argument a call keeps past its own return: a listener
     * registration its second, a browser timer or RAF its first.
     * Frame registrations also retain callbacks past a helper/block's end.
     */
    private retainsCallbackArgument(
        call: ts.CallExpression,
        index: number,
        includeFrameRegistrations: boolean,
    ): boolean {
        const callee = this.context.unwrap(call.expression);
        if (ts.isIdentifier(callee)) {
            switch (this.context.symbols.importedName(callee)) {
                case "withNodeParticleEmitterProvider":
                    return index === 0;
                case "onBeforeRender":
                case "onPhysicsAfterStep":
                case "onCsmReceiverUpdate":
                    return includeFrameRegistrations && index === 1;
            }
        }
        if (isListenerRegistration(this.context.checker, call))
            return index === 1;
        const reaction = promiseReactionOf(callee, this.context.checker);
        if (reaction)
            return index === 0 || (reaction === "then" && index === 1);
        const scheduler = schedulerOf(this.context.checker, call.expression);
        return (
            scheduler !== undefined &&
            (scheduler !== "frame" || includeFrameRegistrations) &&
            index === 0 &&
            call.arguments.length >= 1
        );
    }

    /**
     * Whether a call keeps its argument at `index` in a retained callback:
     * a listener or timer registration, or a repository function or class
     * method that invokes that parameter from one of its own stored
     * callbacks or hands it on (freeciv's
     * `installControls(engine, view, zoomCtl, hover, onMapClick)` calls
     * `onClick` from its pointer-up listener). The function may live in any
     * repository module; the pinned package and the language library have
     * no bodies to resolve. A repository function value whose body cannot be
     * named -- an interface or record member (`hub.on(cb)` on a factory's
     * returned record), a function-typed parameter -- may keep it.
     */
    public callRetainsArgument(
        call: ts.CallExpression,
        index: number,
        includeFrameRegistrations: boolean,
    ): boolean {
        if (
            this.retainsCallbackArgument(call, index, includeFrameRegistrations)
        )
            return true;
        const targets = this.callTargets(call);
        if (targets === "library") return false;
        if (targets === "unnamed") return true;
        return targets.some((target) => {
            // A spread before it may hand the callback to any parameter.
            const bound = parameterForArgument(call, target, index);
            if (bound === "unknown") return true;
            const parameter = bound?.parameter;
            if (!parameter || !ts.isIdentifier(parameter.name)) return false;
            const symbol = this.context.symbols.valueSymbol(parameter.name);
            const info = this.sharedClosureSymbolsFor(
                target,
                includeFrameRegistrations,
            );
            return (
                info === "in-cycle" ||
                (!!symbol &&
                    (info.captured.has(symbol) || info.forwarded.has(symbol)))
            );
        });
    }

    /**
     * The repository bodies a call runs, as evaluation order resolves them:
     * a named function, or every implementation a class method dispatches
     * to. "library" for a declaration file's function; "unnamed" for a
     * repository function value whose body its declaration does not fix.
     */
    private callTargets(
        call: ts.CallExpression,
    ): readonly SupportedFunction[] | "library" | "unnamed" {
        const bodies = this.context.evaluationOrder.callBodies(call);
        if (bodies === "library") return "library";
        // A class method reached through a structural view of its object
        // (`Pick<C, "m">`, a record type the class satisfies) is whatever
        // function the viewed object holds.
        const callee = this.context.unwrap(call.expression);
        const member = namedMember(this.context.checker, callee);
        if (
            member &&
            bodies?.some(
                (body) =>
                    ts.isMethodDeclaration(body) && ts.isClassLike(body.parent),
            ) &&
            !this.receivesClassInstance(member.expression)
        )
            return "unnamed";
        return bodies !== undefined && bodies.every(isFixedBody)
            ? bodies
            : "unnamed";
    }

    /** Whether a receiver's type is a class's instance type (nullable included). */
    private receivesClassInstance(receiver: ts.Expression): boolean {
        const node = this.context.unwrap(receiver);
        if (
            node.kind === ts.SyntaxKind.ThisKeyword ||
            node.kind === ts.SyntaxKind.SuperKeyword
        )
            return true;
        return presentMembers(
            this.context.checker.getTypeAtLocation(node),
        ).every(
            (member) =>
                ((member.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0,
        );
    }

    @journaled private accessor nativeParticleProviderUse: boolean | undefined;

    /** Closure ownership is decided before the first resource is emitted. */
    private sourceUsesNativeParticleProvider(): boolean {
        if (this.nativeParticleProviderUse !== undefined)
            return this.nativeParticleProviderUse;
        let found = false;
        const visit = (root: ts.Node): void =>
            forEachAnalysisNode(root, (node) => {
                if (found) return "skip";
                if (ts.isCallExpression(node)) {
                    const callee = this.context.unwrap(node.expression);
                    if (
                        ts.isIdentifier(callee) &&
                        this.context.symbols.importedName(callee) ===
                            "withNodeParticleEmitterProvider"
                    ) {
                        found = true;
                        return "skip";
                    }
                }
            });
        for (const file of this.context.program.getSourceFiles()) {
            if (!file.isDeclarationFile) visit(file);
        }
        return (this.nativeParticleProviderUse = found);
    }

    /**
     * The bindings a stored callback of `owner` closes over; every closure
     * over one of them must share a single cell, because a stored
     * closure's environment owns its captures by value. A callback is
     * stored when the program keeps the function value past the statement
     * naming it: a local function referenced anywhere but as a direct
     * callee (the rule `recursiveStorageEscapes` applies), a record member
     * or accessor, a returned function, an argument the call retains, a
     * function pushed into a container or assigned to a property, and any
     * callback registered from inside another callback, whose environment
     * the emitter copies whatever registers it. A local function a stored
     * callback calls runs from it and is stored with it. The owner itself
     * is never a root: its own locals live in its frame.
     */
    private collectSharedClosureSymbols(
        owner: ts.Node,
        includeFrameRegistrations: boolean,
    ): SharedClosureBindings {
        const captured = new EmissionSet<ts.Symbol>();
        const forwarded = new EmissionSet<ts.Symbol>();
        const storedLocalFunctions = new EmissionSet<ts.Symbol>();
        // A name can be bound to either of two closures (`const cb = ready
        // ? f : () => n`).
        const localFunctions = new EmissionMap<
            ts.Symbol,
            ts.FunctionLikeDeclaration[]
        >();
        const localFunctionNames = new EmissionSet<string>();
        const forwardedParameters = new EmissionSet<ts.Symbol>();
        if (isSupportedFunction(owner)) {
            for (const parameter of owner.parameters) {
                if (!ts.isIdentifier(parameter.name)) continue;
                const symbol = this.context.symbols.valueSymbol(parameter.name);
                if (symbol) {
                    localFunctionNames.add(parameter.name.text);
                    forwardedParameters.add(symbol);
                }
            }
        }
        const roots: ts.Node[] = [];
        const rootSet = new EmissionSet<ts.Node>();
        const isClosure = (
            node: ts.Node,
        ): node is ts.ArrowFunction | ts.FunctionExpression =>
            ts.isArrowFunction(node) || ts.isFunctionExpression(node);
        const isRecordMember = (node: ts.Node): boolean => {
            if (
                ts.isMethodDeclaration(node) ||
                ts.isGetAccessorDeclaration(node) ||
                ts.isSetAccessorDeclaration(node)
            )
                return ts.isObjectLiteralExpression(node.parent);
            if (!isClosure(node)) return false;
            const { consumer } = valueSite(node);
            return (
                ts.isPropertyAssignment(consumer) &&
                ts.isObjectLiteralExpression(consumer.parent)
            );
        };
        const localFunctionName = (
            node: ts.Node,
        ): ts.Identifier | undefined => {
            if (ts.isFunctionDeclaration(node)) return node.name;
            if (!isClosure(node)) return undefined;
            const { consumer } = valueSite(node);
            return ts.isVariableDeclaration(consumer) &&
                ts.isIdentifier(consumer.name)
                ? consumer.name
                : undefined;
        };
        const isStoredLocal = (identifier: ts.Identifier): boolean => {
            const symbol = this.context.symbols.valueSymbol(identifier);
            return !!symbol && storedLocalFunctions.has(symbol);
        };
        const isDataSinkClosure = (node: ts.Node): boolean => {
            if (!isClosure(node)) return false;
            const { value, consumer: parent, selected } = valueSite(node);
            // A function a run-time choice selects is a callback object
            // wherever it lands, called in place or not.
            if (selected) return true;
            // Recursive local arrows use native callback storage even when all
            // source uses are direct calls, so their mutable captures are shared.
            if (
                ts.isVariableDeclaration(parent) &&
                ts.isIdentifier(parent.name)
            ) {
                const symbol = this.context.symbols.valueSymbol(parent.name);
                if (
                    symbol &&
                    someAnalysisNode(
                        node.body,
                        (call) =>
                            ts.isCallExpression(call) &&
                            ts.isIdentifier(call.expression) &&
                            this.context.symbols.valueSymbol(
                                call.expression,
                            ) === symbol,
                        { functions: "skip" },
                    )
                )
                    return true;
            }
            // An explicitly callable local is emitted as a stored callback,
            // including when every use is a direct call. Its helpers must
            // share captured mutable bindings with the surrounding scope.
            if (
                ts.isVariableDeclaration(parent) &&
                parent.type &&
                callSignatures(
                    this.context.checker,
                    this.context.checker.getTypeFromTypeNode(parent.type),
                    "exact",
                ).length > 0
            )
                return true;
            // A construction (a parameter property, a field), a storing call
            // (a container) and an instance field keep the function past the
            // call. Mutable outer bindings remain shared.
            if (
                keptArguments(this.context.checker, parent).includes(value) ||
                (ts.isPropertyDeclaration(parent) &&
                    parent.initializer === value)
            )
                return true;
            if (ts.isCallExpression(parent) && parent.arguments.includes(value))
                return false;
            // `o.cb = fn` and `o.cb ??= fn` store the function whole.
            const store = writeSites(parent).find(
                ({ stored }) => stored === value,
            );
            if (store) {
                // A property of the program's own data keeps the function;
                // a library global's (`Math.random = () => ...`, which a
                // bake moves to generation) does not.
                const target = this.context.unwrap(store.target);
                const root = rootIdentifier(target, (chain) =>
                    this.context.unwrap(chain),
                );
                return (
                    (ts.isIdentifier(target) ||
                        ts.isPropertyAccessExpression(target) ||
                        ts.isElementAccessExpression(target)) &&
                    (!(
                        root && this.context.libraryGlobal(root) !== undefined
                    ) ||
                        (isDeterministicRandomRead(
                            this.context,
                            store.target,
                        ) &&
                            this.sourceUsesNativeParticleProvider()))
                );
            }
            return ts.isArrayLiteralExpression(parent);
        };
        const addRoot = (node: ts.Node): void => {
            roots.push(node);
            rootSet.add(node);
        };
        // Local functions and inline roots. `callbackDepth` counts the
        // enclosing callback arguments: below one, every callback argument
        // is a root.
        findAnalysisNodeWithState(
            owner,
            0,
            (node, callbackDepth) => {
                // A realm activation owns its environment even for a direct call
                // or IIFE: it can suspend past the caller's return. Its mutable
                // outer bindings must therefore use the same cells as callbacks.
                if (
                    isSupportedFunction(node) &&
                    (isGeneratorFunction(node) ||
                        (this.context.options.workers && isAsyncFunction(node)))
                ) {
                    addRoot(node);
                }
                const name = localFunctionName(node);
                if (name) {
                    localFunctionNames.add(name.text);
                    const symbol = this.context.symbols.valueSymbol(name);
                    if (symbol && isSupportedFunction(node)) {
                        localFunctions.set(symbol, [
                            ...(localFunctions.get(symbol) ?? []),
                            node,
                        ]);
                    }
                }
                if (isClosure(node)) {
                    const { value, consumer } = valueSite(node);
                    const call = ts.isCallExpression(consumer)
                        ? consumer
                        : undefined;
                    const index = call ? call.arguments.indexOf(value) : -1;
                    if (
                        isRecordMember(node) ||
                        ts.isReturnStatement(consumer) ||
                        (ts.isArrowFunction(consumer) &&
                            consumer.body === value) ||
                        isDataSinkClosure(node) ||
                        (call !== undefined &&
                            index >= 0 &&
                            (callbackDepth > 0 ||
                                this.callRetainsArgument(
                                    call,
                                    index,
                                    includeFrameRegistrations,
                                )))
                    ) {
                        addRoot(node);
                    }
                } else if (
                    isRecordMember(node) &&
                    (ts.isMethodDeclaration(node) ||
                        ts.isGetAccessorDeclaration(node) ||
                        ts.isSetAccessorDeclaration(node))
                ) {
                    addRoot(node);
                }
                return false;
            },
            (node, depth) => {
                if (!isClosure(node)) return depth;
                const { value, consumer } = valueSite(node);
                return ts.isCallExpression(consumer) &&
                    consumer.arguments.includes(value)
                    ? depth + 1
                    : depth;
            },
            { includeRoot: false },
        );
        // A local function referenced anywhere but as a direct callee is a
        // value the program keeps: passed by name, assigned, pushed, returned
        // or captured. A parameter used as a value may likewise escape through
        // a container or another helper, so its caller must retain the callback's
        // environment. Direct calls alone do not require that ownership,
        // except in an async body that awaits: its caller resumes first.
        const suspends = suspendsBeforeReturn(owner);
        forEachAnalysisNode(
            owner,
            (node) => {
                if (
                    !ts.isIdentifier(node) ||
                    !localFunctionNames.has(node.text)
                )
                    return;
                const callee =
                    ts.isCallExpression(node.parent) &&
                    node.parent.expression === node;
                if (callee && !suspends) return;
                const symbol = this.context.symbols.valueSymbol(node);
                if (!symbol) return;
                if (!callee && localFunctions.has(symbol))
                    storedLocalFunctions.add(symbol);
                if (forwardedParameters.has(symbol)) forwarded.add(symbol);
            },
            { names: "references" },
        );
        for (const symbol of storedLocalFunctions)
            localFunctions.get(symbol)?.forEach(addRoot);
        // A local function a root calls runs from that stored callback, as
        // does any code declared in the owner that a root reaches: a call's
        // bodies (each override included), a construction's constructors and
        // field initializers, an accessed property's getter and setter.
        const visitedRoots = new EmissionSet<ts.Node>();
        for (let index = 0; index < roots.length; ++index) {
            const root = roots[index]!;
            if (visitedRoots.has(root)) continue;
            visitedRoots.add(root);
            forEachAnalysisNode(root, (node) => {
                const reached =
                    ts.isCallExpression(node) || ts.isNewExpression(node)
                        ? this.context.evaluationOrder.callUnits(node)
                        : ts.isPropertyAccessExpression(node) ||
                            ts.isElementAccessExpression(node)
                          ? memberAccessors(
                                this.context.checker,
                                node,
                                "either",
                            )
                          : undefined;
                if (reached !== undefined && reached !== "library")
                    for (const unit of reached)
                        if (
                            !rootSet.has(unit) &&
                            unit.pos >= owner.pos &&
                            unit.end <= owner.end &&
                            unit.getSourceFile() === owner.getSourceFile()
                        )
                            addRoot(unit);
                if (
                    ts.isIdentifier(node) &&
                    localFunctionNames.has(node.text)
                ) {
                    const symbol = this.context.symbols.valueSymbol(node);
                    const declarations = symbol
                        ? localFunctions.get(symbol)
                        : undefined;
                    if (
                        symbol &&
                        declarations &&
                        !storedLocalFunctions.has(symbol)
                    ) {
                        storedLocalFunctions.add(symbol);
                        declarations.forEach(addRoot);
                    }
                }
            });
        }
        const insideStoredClosure = (
            node: ts.Node,
            inside: boolean,
        ): boolean => {
            const name = localFunctionName(node);
            return (
                inside || rootSet.has(node) || (!!name && isStoredLocal(name))
            );
        };
        findAnalysisNodeWithState(
            owner,
            false,
            (node, inside) => {
                if (
                    insideStoredClosure(node, inside) &&
                    ts.isIdentifier(node)
                ) {
                    const symbol = this.context.symbols.valueSymbol(node);
                    if (symbol) captured.add(symbol);
                }
                return false;
            },
            insideStoredClosure,
            { includeRoot: false },
        );
        return { captured, forwarded };
    }

    public isSharedClosureScalar(kind: string): boolean {
        return (
            kind === "number" ||
            kind === "boolean" ||
            kind === "string" ||
            kind === "enum" ||
            kind === "promise"
        );
    }

    /**
     * Whether anything gives the binding a new value, `++` and `--` included:
     * they rebind a number (a browser value read once is no longer it), and
     * cannot apply to the objects most callers ask about.
     */
    public identifierIsRebound(identifier: ts.Identifier): boolean {
        const symbol = this.context.symbols.valueSymbol(identifier);
        return (
            symbol !== undefined &&
            isRebound(
                this.context.checker,
                this.context.program.getSourceFiles(),
                symbol,
            )
        );
    }
}
