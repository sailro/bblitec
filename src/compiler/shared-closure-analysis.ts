import {
    forEachAnalysisNode,
    findAnalysisNodeWithState,
} from "./analysis-walk.js";
import {
    EmissionMap,
    EmissionSet,
    EmissionWeakMap,
    journaled,
} from "./emission-transaction.js";
import ts from "typescript";
import { collectReboundSymbols } from "./module-initializers.js";
import {
    isSupportedFunction,
    tryResolveFunctionDeclaration,
} from "./user-functions.js";
import { rootIdentifier } from "./syntax.js";
import { isDeterministicRandomRead } from "./deterministic-random.js";
import type { LoweringServices } from "./lowering-services.js";

interface SharedClosureBindings {
    captured: ReadonlySet<ts.Symbol>;
    forwarded: ReadonlySet<ts.Symbol>;
}

/** What the shared-closure analysis reads of the compiler. */
interface SharedClosureContext extends Pick<
    LoweringServices,
    | "bindings"
    | "checker"
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

    /** One rebound-name walk per file, shared by every `identifierIsRebound`. */
    private readonly reboundSymbolsByFile = new EmissionMap<
        ts.SourceFile,
        ReadonlySet<ts.Symbol>
    >();
    private readonly sharedClosureSymbols = new EmissionWeakMap<
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
                    (declaration.parent.flags & ts.NodeFlags.Const) !== 0))
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
        return (
            this.sharedClosureSymbolsFor(
                owner,
                this.context.bindings.variableScopes.length !== 1 ||
                    this.context.activeEmissionScope !== 0,
            )?.captured.has(symbol) ?? false
        );
    }

    /** Owners under analysis: a helper reached through its own call adds nothing. */
    private readonly sharedClosureAnalysisInProgress =
        new EmissionSet<ts.Node>();
    private readonly sharedFrameClosureSymbols = new EmissionWeakMap<
        ts.Node,
        SharedClosureBindings
    >();

    private sharedClosureSymbolsFor(
        owner: ts.Node,
        includeFrameRegistrations = false,
    ): SharedClosureBindings | undefined {
        const cache = includeFrameRegistrations
            ? this.sharedFrameClosureSymbols
            : this.sharedClosureSymbols;
        const cached = cache.get(owner);
        if (cached) return cached;
        if (this.sharedClosureAnalysisInProgress.has(owner)) return undefined;
        this.sharedClosureAnalysisInProgress.add(owner);
        try {
            const captured = this.collectSharedClosureSymbols(
                owner,
                includeFrameRegistrations,
            );
            cache.set(owner, captured);
            return captured;
        } finally {
            this.sharedClosureAnalysisInProgress.delete(owner);
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
        if (
            ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "addEventListener" &&
            call.arguments.length >= 2
        ) {
            return index === 1;
        }
        const global = this.context.libraryGlobal(call.expression);
        if (
            ts.isPropertyAccessExpression(callee) &&
            ["then", "catch", "finally"].includes(callee.name.text) &&
            this.context.checker.getTypeAtLocation(callee.expression).symbol
                ?.name === "Promise"
        )
            return index === 0 || (callee.name.text === "then" && index === 1);
        return (
            (global === "setTimeout" ||
                global === "setInterval" ||
                global === "queueMicrotask" ||
                (includeFrameRegistrations &&
                    global === "requestAnimationFrame")) &&
            index === 0 &&
            call.arguments.length >= 1
        );
    }

    /**
     * Whether a call keeps its argument at `index` in a retained callback:
     * a listener or timer registration, or a repository helper that invokes
     * that parameter from one of its own stored callbacks (freeciv's
     * `installControls(engine, view, zoomCtl, hover, onMapClick)` calls
     * `onClick` from its pointer-up listener). The helper may live in any
     * repository module; the pinned package has no bodies to resolve.
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
        const callee = this.context.unwrap(call.expression);
        if (!ts.isIdentifier(callee)) return false;
        const target = tryResolveFunctionDeclaration(
            this.context.checker,
            callee,
        );
        if (!target) return false;
        const parameter = target.parameters[index];
        if (!parameter || !ts.isIdentifier(parameter.name)) return false;
        const symbol = this.context.symbols.valueSymbol(parameter.name);
        const info = this.sharedClosureSymbolsFor(
            target,
            includeFrameRegistrations,
        );
        return (
            !!symbol &&
            !!info &&
            (info.captured.has(symbol) || info.forwarded.has(symbol))
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
        const localFunctions = new EmissionMap<
            ts.Symbol,
            ts.FunctionLikeDeclaration
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
        const roots: ts.FunctionLikeDeclaration[] = [];
        const rootSet = new EmissionSet<ts.Node>();
        const isClosure = (
            node: ts.Node,
        ): node is ts.ArrowFunction | ts.FunctionExpression =>
            ts.isArrowFunction(node) || ts.isFunctionExpression(node);
        const isRecordMember = (node: ts.Node): boolean =>
            ((ts.isMethodDeclaration(node) ||
                ts.isGetAccessorDeclaration(node) ||
                ts.isSetAccessorDeclaration(node)) &&
                ts.isObjectLiteralExpression(node.parent)) ||
            (isClosure(node) &&
                ts.isPropertyAssignment(node.parent) &&
                ts.isObjectLiteralExpression(node.parent.parent));
        const localFunctionName = (node: ts.Node): ts.Identifier | undefined =>
            ts.isFunctionDeclaration(node) && node.name
                ? node.name
                : isClosure(node) &&
                    ts.isVariableDeclaration(node.parent) &&
                    ts.isIdentifier(node.parent.name)
                  ? node.parent.name
                  : undefined;
        const storeNamed = (identifier: ts.Identifier): void => {
            const symbol = this.context.symbols.valueSymbol(identifier);
            if (symbol) storedLocalFunctions.add(symbol);
        };
        const isStoredLocal = (identifier: ts.Identifier): boolean => {
            const symbol = this.context.symbols.valueSymbol(identifier);
            return !!symbol && storedLocalFunctions.has(symbol);
        };
        const isDataSinkClosure = (node: ts.Node): boolean => {
            if (!isClosure(node)) return false;
            const parent = node.parent;
            // An explicitly callable local is emitted as a stored callback,
            // including when every use is a direct call. Its helpers must
            // share captured mutable bindings with the surrounding scope.
            if (
                ts.isVariableDeclaration(parent) &&
                parent.type &&
                this.context.checker
                    .getTypeFromTypeNode(parent.type)
                    .getCallSignatures().length > 0
            )
                return true;
            // Constructors and instance fields can retain the function for
            // the object's lifetime, including a callback supplied as a
            // parameter property. Mutable outer bindings remain shared.
            if (
                (ts.isNewExpression(parent) &&
                    parent.arguments?.includes(node) &&
                    this.context.libraryGlobal(parent.expression) ===
                        undefined) ||
                (ts.isPropertyDeclaration(parent) &&
                    parent.initializer === node)
            )
                return true;
            if (
                ts.isCallExpression(parent) &&
                parent.arguments.includes(node)
            ) {
                const callee = this.context.unwrap(parent.expression);
                return (
                    ts.isPropertyAccessExpression(callee) &&
                    ["push", "unshift", "add", "set"].includes(callee.name.text)
                );
            }
            if (
                ts.isBinaryExpression(parent) &&
                parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                parent.right === node
            ) {
                // A property of the program's own data keeps the function;
                // a library global's (`Math.random = () => ...`, which a
                // bake moves to generation) does not.
                const target = this.context.unwrap(parent.left);
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
                        (isDeterministicRandomRead(this.context, parent.left) &&
                            this.sourceUsesNativeParticleProvider()))
                );
            }
            return ts.isArrayLiteralExpression(parent);
        };
        const addRoot = (node: ts.FunctionLikeDeclaration): void => {
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
                    this.context.options.workers &&
                    isSupportedFunction(node) &&
                    ts
                        .getModifiers(node)
                        ?.some(
                            (modifier) =>
                                modifier.kind === ts.SyntaxKind.AsyncKeyword,
                        )
                ) {
                    addRoot(node);
                }
                const name = localFunctionName(node);
                if (name) {
                    localFunctionNames.add(name.text);
                    const symbol = this.context.symbols.valueSymbol(name);
                    if (symbol && isSupportedFunction(node)) {
                        localFunctions.set(symbol, node);
                    }
                }
                if (isClosure(node)) {
                    const call = ts.isCallExpression(node.parent)
                        ? node.parent
                        : undefined;
                    const index = call ? call.arguments.indexOf(node) : -1;
                    if (
                        isRecordMember(node) ||
                        (ts.isReturnStatement(node.parent) &&
                            node.parent.expression === node) ||
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
            (node, depth) =>
                isClosure(node) &&
                ts.isCallExpression(node.parent) &&
                node.parent.arguments.includes(node)
                    ? depth + 1
                    : depth,
            { includeRoot: false },
        );
        // A local function referenced anywhere but as a direct callee is a
        // value the program keeps: passed by name, assigned, pushed, returned
        // or captured. A parameter used as a value may likewise escape through
        // a container or another helper, so its caller must retain the callback's
        // environment. Direct calls alone do not require that ownership.
        forEachAnalysisNode(owner, (node) => {
            if (ts.isShorthandPropertyAssignment(node)) {
                if (localFunctionNames.has(node.name.text)) {
                    storeNamed(node.name);
                    const symbol = this.context.symbols.valueSymbol(node.name);
                    if (symbol && forwardedParameters.has(symbol))
                        forwarded.add(symbol);
                }
            } else if (
                ts.isIdentifier(node) &&
                localFunctionNames.has(node.text)
            ) {
                const parent = node.parent;
                const declared =
                    (ts.isFunctionDeclaration(parent) ||
                        ts.isVariableDeclaration(parent)) &&
                    parent.name === node;
                const callee =
                    ts.isCallExpression(parent) && parent.expression === node;
                const member =
                    ts.isPropertyAccessExpression(parent) &&
                    parent.name === node;
                if (!declared && !callee && !member) {
                    const symbol = this.context.symbols.valueSymbol(node);
                    if (symbol && localFunctions.has(symbol)) storeNamed(node);
                    if (
                        symbol &&
                        forwardedParameters.has(symbol) &&
                        !(ts.isParameter(parent) && parent.name === node)
                    )
                        forwarded.add(symbol);
                }
            }
        });
        for (const symbol of storedLocalFunctions) {
            const declaration = localFunctions.get(symbol);
            if (declaration) addRoot(declaration);
        }
        // A local function a root calls runs from that stored callback.
        const visitedRoots = new EmissionSet<ts.Node>();
        for (let index = 0; index < roots.length; ++index) {
            const root = roots[index]!;
            if (visitedRoots.has(root)) continue;
            visitedRoots.add(root);
            forEachAnalysisNode(root, (node) => {
                if (
                    ts.isIdentifier(node) &&
                    localFunctionNames.has(node.text)
                ) {
                    const symbol = this.context.symbols.valueSymbol(node);
                    const declaration = symbol
                        ? localFunctions.get(symbol)
                        : undefined;
                    if (
                        symbol &&
                        declaration &&
                        !storedLocalFunctions.has(symbol)
                    ) {
                        storedLocalFunctions.add(symbol);
                        addRoot(declaration);
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
     * A non-literal inferred struct needs storage only when its binding
     * changes.
     *
     * The answer is a property of the file, not of the identifier, so the
     * file's assigned names are resolved once and every later question is a
     * set membership -- a scene asks this for most of its declarations, and
     * a walk each turned that into a scan of the whole file per name.
     * `false` keeps `++`/`--` out of the set, which is the answer every
     * caller here has always had.
     */
    public identifierIsRebound(identifier: ts.Identifier): boolean {
        const symbol = this.context.symbols.valueSymbol(identifier);
        if (!symbol) return false;
        const file = identifier.getSourceFile();
        let rebound = this.reboundSymbolsByFile.get(file);
        if (!rebound) {
            rebound = collectReboundSymbols(file, this.context.symbols, false);
            this.reboundSymbolsByFile.set(file, rebound);
        }
        return rebound.has(symbol);
    }
}
