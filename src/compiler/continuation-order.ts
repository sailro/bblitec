import ts from "typescript";
import { findAnalysisNode } from "./analysis-walk.js";
import { sourceFileNodes } from "./analysis-walk.js";
import {
    footprintsConflict,
    handedFunctions,
    lookedUpElementId,
    touchesNoState,
    type Access,
    type CodePart,
} from "./evaluation-order.js";
import type { LoweringServices } from "./lowering-services.js";
import { forEachReturn } from "./loop-control.js";
import { promiseReactionOf, promiseStatic } from "./promises.js";
import {
    callsArgumentInPlace,
    isListenerRegistration,
} from "./receiver-methods.js";
import {
    accessedPropertySymbol,
    calledFunction,
    calledOrigin,
    declarationOrigin,
    declaredSymbol,
    namedMember,
    resolvedSymbol,
} from "./symbols.js";
import {
    containsSuspension,
    functionOfDeclaration,
    isAssignmentExpression,
    isAsyncFunction,
    isMemberAccess,
    isOperandSelection,
    isSupportedFunction,
    isValueReference,
    operandYield,
    outermostWrapper,
    unwrapExpression,
    variableKind,
    type SupportedFunction,
} from "./syntax.js";
import { schedulerOf } from "./schedulers.js";
import { PageNesting } from "./page-nesting.js";

/*
 * The order code JavaScript defers runs in. An activation's code after it
 * first suspends, and a reaction's callbacks, run in JavaScript once the
 * code after their start has run; outside the application realm they run
 * at their start. Both orders agree when nothing of the program runs
 * between, or when the deferred code and the code that runs first touch
 * disjoint state: what each touches is EvaluationOrder's footprint, and
 * what a call or an accessor runs its answer too (overrides and
 * constructor chains included).
 */

type OrderContext = Pick<
    LoweringServices,
    | "checker"
    | "evaluationOrder"
    | "libraryGlobal"
    | "options"
    | "sourceFile"
    | "sourceFiles"
    | "symbols"
    | "unwrap"
>;

/** @unjournaled Pure functions of the checked source, kept across replays. */
const suspendingActivations = new WeakMap<ts.Node, boolean>();

/**
 * Whether calling `declaration` starts an activation JavaScript can
 * suspend: its body awaits (a settled value included), or it returns an
 * activation that can (`return load()`).
 */
export function activationMaySuspend(
    checker: ts.TypeChecker,
    declaration: SupportedFunction,
    active = new Set<ts.Node>(),
): boolean {
    const body = declaration.body;
    if (!isAsyncFunction(declaration) || !body) return false;
    const known = suspendingActivations.get(declaration);
    if (known !== undefined) return known;
    if (active.has(declaration)) return false;
    active.add(declaration);
    const returned: ts.Expression[] = [];
    if (ts.isBlock(body))
        forEachReturn([body], (statement) => {
            if (statement.expression) returned.push(statement.expression);
        });
    else returned.push(body);
    const suspends =
        containsSuspension(body) ||
        returned.some((expression) => {
            const call = unwrapExpression(expression);
            if (!ts.isCallExpression(call)) return false;
            const called = calledFunction(checker, call);
            return (
                called !== undefined &&
                activationMaySuspend(checker, called, active)
            );
        });
    active.delete(declaration);
    if (active.size === 0) suspendingActivations.set(declaration, suspends);
    return suspends;
}

/** @unjournaled Pure functions of the checked source, by entry file and start. */
const answers = new WeakMap<
    ts.SourceFile,
    WeakMap<ts.Node, WeakMap<ts.Node, boolean>>
>();

/** One answer per entry file, start and deferred code. */
function remembered(
    context: OrderContext,
    start: ts.Node,
    deferred: ts.Node,
    answer: () => boolean,
): boolean {
    let byStart = answers.get(context.sourceFile);
    if (!byStart) answers.set(context.sourceFile, (byStart = new WeakMap()));
    let byDeferred = byStart.get(start);
    if (!byDeferred) byStart.set(start, (byDeferred = new WeakMap()));
    let known = byDeferred.get(deferred);
    if (known === undefined) byDeferred.set(deferred, (known = answer()));
    return known;
}

/**
 * Whether the activation of `declaration` that `start` begins may run to
 * its end where it starts: what it runs after first suspending and what
 * JavaScript runs before that touch disjoint state. `start` is the call,
 * a call that runs `declaration` once per element (`items.map(load)`),
 * or `declaration` itself when the platform runs it (a listener).
 */
export function activationOrderIsUnobservable(
    context: OrderContext,
    start: ts.Node,
    declaration: SupportedFunction,
): boolean {
    return remembered(context, start, declaration, () => {
        const later = afterSuspension(context, declaration);
        if (touchesNoState(later)) return true;
        const first = new InterveningCode(context);
        const direct =
            start === declaration ||
            (ts.isCallExpression(start) &&
                calledFunction(context.checker, start) === declaration);
        // Each element's run starts before an earlier one resumes.
        if (!direct) first.code.push({ node: declaration });
        first.after(start);
        return (
            !first.open &&
            !footprintsConflict(
                later,
                context.evaluationOrder.footprint(first.code),
            )
        );
    });
}

/**
 * Whether a reaction `call` registers may run its callbacks at once:
 * they and what JavaScript runs before them touch disjoint state.
 */
export function reactionOrderIsUnobservable(
    context: OrderContext,
    call: ts.CallExpression,
): boolean {
    return remembered(context, call, call, () => {
        const callbacks = call.arguments.map((argument) =>
            functionValue(context.checker, argument),
        );
        if (callbacks.includes(undefined)) return false;
        const later = context.evaluationOrder.footprint(
            callbacks.flatMap((node) => (node ? [{ node }] : [])),
        );
        if (touchesNoState(later)) return true;
        const first = new InterveningCode(context);
        first.after(call);
        return (
            !first.open &&
            !footprintsConflict(
                later,
                context.evaluationOrder.footprint(first.code),
            )
        );
    });
}

/** @unjournaled Pure functions of the checked source, kept across replays. */
const deferredFootprints = new WeakMap<ts.Node, Access>();

/**
 * What an activation runs from its first suspension on: the statement
 * that first suspends, less the operand it first awaits when no loop runs
 * that again, and every statement after it. What runs before is the
 * start's.
 */
function afterSuspension(
    context: OrderContext,
    declaration: SupportedFunction,
): Access {
    const known = deferredFootprints.get(declaration);
    if (known) return known;
    const body = declaration.body;
    const statements = body
        ? ts.isBlock(body)
            ? body.statements
            : [body]
        : [];
    const index = statements.findIndex((statement) =>
        containsSuspension(statement),
    );
    const first = statements[index];
    let parts: CodePart[] = [{ node: declaration }];
    if (first) {
        const awaited = findAnalysisNode(first, ts.isAwaitExpression, {
            functions: "skip",
            types: "skip",
        });
        const repeated =
            awaited !== undefined &&
            ts.findAncestor(awaited, (node) =>
                node === first.parent
                    ? "quit"
                    : ts.isIterationStatement(node, false),
            ) !== undefined;
        parts = [
            {
                node: first,
                owner: declaration,
                without: awaited && !repeated ? awaited.expression : undefined,
            },
            ...statements
                .slice(index + 1)
                .map((node) => ({ node, owner: declaration })),
        ];
    }
    const result = context.evaluationOrder.footprint(parts);
    deferredFootprints.set(declaration, result);
    return result;
}

/** A binding no code can assign: a `const`, a function, class, enum or import. */
function isImmutableBinding(declaration: ts.Declaration): boolean {
    if (ts.isVariableDeclaration(declaration))
        return variableKind(declaration) === "const";
    return (
        ts.isFunctionDeclaration(declaration) ||
        ts.isClassDeclaration(declaration) ||
        ts.isEnumDeclaration(declaration) ||
        ts.isModuleDeclaration(declaration) ||
        ts.isImportSpecifier(declaration) ||
        ts.isImportClause(declaration) ||
        ts.isNamespaceImport(declaration) ||
        ts.isImportEqualsDeclaration(declaration)
    );
}

/** @unjournaled A whole-program analysis of compiler inputs, built on first use. */
const pageNestings = new WeakMap<ts.TypeChecker, PageNesting>();

/** Which page elements may sit inside which ({@link PageNesting}), once per program. */
function pageNesting(context: OrderContext): PageNesting {
    let nesting = pageNestings.get(context.checker);
    if (!nesting) {
        nesting = new PageNesting(
            context.checker,
            context.sourceFiles(),
            context.options.nativeHostUi,
        );
        pageNestings.set(context.checker, nesting);
    }
    return nesting;
}

/**
 * Whether no event dispatched to the element `targetId` finds reaches a
 * listener of `other`: an element found by another id that the page never
 * puts around the target.
 */
function unreachedTarget(
    context: OrderContext,
    targetId: string | undefined,
    other: ts.Expression,
): boolean {
    const otherId = lookedUpElementId(context.checker, other);
    return (
        targetId !== undefined &&
        otherId !== undefined &&
        !pageNesting(context).mayContain(otherId, targetId)
    );
}

/**
 * The code JavaScript runs after a start and before what the start
 * defers: the rest of the expression and statements around it, and once
 * the function holding it returns, its callers' code after each call, up
 * to where the job ends. An `await` ends it there: the activation holding
 * it is a start of its own.
 */
class InterveningCode {
    /** @unjournaled One query's walk over checked source, discarded with it. */
    public readonly code: CodePart[] = [];
    /** @unjournaled One query's walk over checked source, discarded with it. */
    public open = false;
    /** @unjournaled One query's walk over checked source, discarded with it. */
    private readonly returned = new Set<ts.Node>();

    public constructor(private readonly context: OrderContext) {}

    /**
     * After `start`: an expression, or a function whoever holds it runs
     * (a listener the platform calls), which returns where it is used.
     */
    public after(start: ts.Node): void {
        if (ts.isFunctionLike(start)) this.afterUses(start);
        else if (ts.isExpression(start)) this.afterExpression(start);
        else this.open = true;
    }

    private afterExpression(start: ts.Expression): void {
        const { checker } = this.context;
        let node: ts.Expression = outermostWrapper(start);
        for (;;) {
            const parent = node.parent;
            if (ts.isAwaitExpression(parent)) return;
            if (
                ts.isReturnStatement(parent) ||
                (ts.isArrowFunction(parent) && parent.body === node)
            ) {
                const owner = ts.isArrowFunction(parent)
                    ? parent
                    : ts.findAncestor(parent.parent, ts.isFunctionLike);
                // An activation that returns it is a start of its own.
                if (
                    owner &&
                    isSupportedFunction(owner) &&
                    activationMaySuspend(checker, owner)
                )
                    return;
                if (owner) this.afterReturn(owner);
                else this.open = true;
                return;
            }
            if (ts.isVoidExpression(parent)) {
                node = outermostWrapper(parent);
                continue;
            }
            if (
                namedMember(checker, parent)?.expression === node &&
                ts.isCallExpression(parent.parent) &&
                parent.parent.expression === parent &&
                promiseReactionOf(parent, checker) !== undefined
            ) {
                node = outermostWrapper(parent.parent);
                continue;
            }
            if (!ts.isArrayLiteralExpression(parent)) break;
            const aggregate = this.aggregateOf(parent);
            if (!aggregate) break;
            const index = parent.elements.indexOf(node);
            for (const element of parent.elements.slice(index + 1))
                this.code.push({ node: element });
            node = outermostWrapper(aggregate);
        }
        this.continueAfter(node);
    }

    /** The `Promise.all` (or sibling) call an array literal is the argument of. */
    private aggregateOf(
        elements: ts.ArrayLiteralExpression,
    ): ts.CallExpression | undefined {
        const position = outermostWrapper(elements);
        const call = position.parent;
        return ts.isCallExpression(call) &&
            call.arguments[0] !== undefined &&
            outermostWrapper(call.arguments[0]) === position &&
            promiseStatic(this.context.checker, call) !== undefined
            ? call
            : undefined;
    }

    /** Everything that runs once `node` is done, up to where the job ends. */
    private continueAfter(node: ts.Node): void {
        let child = node;
        for (;;) {
            const parent = child.parent;
            if (ts.isSourceFile(parent)) {
                this.following(parent.statements, child);
                // An imported module's code runs on into its importer's.
                if (parent !== this.context.sourceFile) this.open = true;
                return;
            }
            if (ts.isFunctionLike(parent)) {
                this.afterReturn(parent);
                return;
            }
            if (ts.isClassLike(parent)) {
                this.open = true;
                return;
            }
            if (
                ts.isBlock(parent) ||
                ts.isModuleBlock(parent) ||
                ts.isCaseClause(parent) ||
                ts.isDefaultClause(parent)
            )
                this.following(parent.statements, child);
            else if (ts.isCaseBlock(parent))
                this.following(parent.clauses, child);
            else if (ts.isIterationStatement(parent, false))
                this.code.push({ node: parent });
            else if (runsLastIn(parent, child)) {
                // Nothing more of `parent` runs.
            } else if (ts.isTryStatement(parent)) {
                if (child === parent.tryBlock && parent.catchClause)
                    this.code.push({ node: parent.catchClause });
                if (child !== parent.finallyBlock && parent.finallyBlock)
                    this.code.push({ node: parent.finallyBlock });
            } else this.code.push({ node: parent, without: child });
            child = parent;
        }
    }

    /** The statements after `child` that run: a declared function does not. */
    private following(statements: readonly ts.Node[], child: ts.Node): void {
        for (const statement of statements.slice(statements.indexOf(child) + 1))
            if (
                !ts.isFunctionDeclaration(statement) &&
                !ts.isInterfaceDeclaration(statement) &&
                !ts.isTypeAliasDeclaration(statement) &&
                !ts.isImportDeclaration(statement) &&
                !ts.isEmptyStatement(statement)
            )
                this.code.push({ node: statement });
    }

    /** What runs once `fn` returns: after each of its calls, or its event. */
    private afterReturn(fn: ts.SignatureDeclaration): void {
        if (this.returned.has(fn)) return;
        this.returned.add(fn);
        // An activation that suspends is a start of its own.
        if (
            isSupportedFunction(fn) &&
            activationMaySuspend(this.context.checker, fn)
        )
            return;
        this.afterUses(fn);
    }

    private afterUses(fn: ts.SignatureDeclaration): void {
        const uses = functionUses(this.context, fn);
        if (!uses) {
            this.open = true;
            return;
        }
        for (const use of uses) this.afterUse(fn, use);
    }

    private afterUse(fn: ts.SignatureDeclaration, use: ts.Expression): void {
        const position = outermostWrapper(use);
        const parent = position.parent;
        if (ts.isCallExpression(parent) && parent.expression === position) {
            this.afterExpression(parent);
            return;
        }
        if (
            (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
            parent.arguments?.some(
                (argument) => outermostWrapper(argument) === position,
            )
        ) {
            this.afterCallback(fn, parent, position);
            return;
        }
        const handler = handlerRegistration(
            this.context.checker,
            parent,
            position,
        );
        if (handler !== undefined) {
            this.dispatchRest(fn, handler.type, handler.target);
            return;
        }
        if (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent))
            return;
        this.open = true;
    }

    /** `fn` handed to a call: the call runs it, or the platform does later. */
    private afterCallback(
        fn: ts.SignatureDeclaration,
        call: ts.CallExpression | ts.NewExpression,
        position: ts.Expression,
    ): void {
        const invoker = invokerOf(this.context, call, position);
        switch (invoker.kind) {
            case "listener":
                this.dispatchRest(fn, invoker.type, invoker.target);
                return;
            case "iteration":
                this.code.push({ node: fn });
                this.afterExpression(call);
                return;
            case "construction":
                this.afterExpression(call);
                return;
            case "task":
                return;
            case "engine": {
                const index = programIndex(this.context);
                for (const callback of index.engineCallbacks)
                    if (callback !== fn) this.code.push({ node: callback });
                if (index.engineCallbacksOpen) this.open = true;
                return;
            }
            case "unknown":
                this.open = true;
        }
    }

    /**
     * The rest of an event's dispatch: every other listener of its type on
     * its target or on an element the target may sit inside.
     */
    private dispatchRest(
        fn: ts.Node,
        type: string | undefined,
        target: ts.Expression | undefined,
    ): void {
        const targetId =
            target && lookedUpElementId(this.context.checker, target);
        let own = 0;
        for (const listener of programIndex(this.context).listeners) {
            if (
                (type !== undefined &&
                    listener.type !== undefined &&
                    listener.type !== type) ||
                (listener.target !== undefined &&
                    unreachedTarget(this.context, targetId, listener.target))
            )
                continue;
            if (!listener.fn) {
                this.open = true;
                return;
            }
            if (listener.fn === fn && own++ === 0) continue;
            this.code.push({ node: listener.fn });
        }
    }
}

/**
 * Whether nothing of `parent` runs after `child`: a branch of a test, or
 * an operator's right operand (an assignment still writes after it).
 */
function runsLastIn(parent: ts.Node, child: ts.Node): boolean {
    if (ts.isIfStatement(parent)) return child !== parent.expression;
    if (isOperandSelection(parent)) {
        // A branch, or a right operand: the selection is whatever it yields.
        const passed = operandYield(parent, child);
        return (
            passed !== undefined &&
            passed.has("truthy") &&
            passed.has("falsy") &&
            passed.has("nullish")
        );
    }
    return (
        ts.isBinaryExpression(parent) &&
        child === parent.right &&
        !isAssignmentExpression(parent)
    );
}

/**
 * The event type and target an `element.on<type> = handler` assignment
 * registers `position` for: a property of a page object, nothing else.
 */
function handlerRegistration(
    checker: ts.TypeChecker,
    parent: ts.Node,
    position: ts.Expression,
): { readonly type: string; readonly target: ts.Expression } | undefined {
    if (
        !ts.isBinaryExpression(parent) ||
        parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        outermostWrapper(parent.right) !== position
    )
        return undefined;
    const property = unwrapExpression(parent.left);
    const member = namedMember(checker, property);
    const declaration =
        isMemberAccess(property) &&
        accessedPropertySymbol(checker, property)?.declarations?.[0];
    return member?.name.startsWith("on") &&
        declaration &&
        declarationOrigin(declaration) === "dom"
        ? { type: member.name.slice(2), target: member.expression }
        : undefined;
}

type Invoker =
    | {
          readonly kind: "listener";
          readonly type: string | undefined;
          readonly target: ts.Expression | undefined;
      }
    | { readonly kind: "iteration" }
    | { readonly kind: "construction" }
    | { readonly kind: "task" }
    | { readonly kind: "engine" }
    | { readonly kind: "unknown" };

/** How a call runs the function it is handed at `position`. */
function invokerOf(
    context: OrderContext,
    call: ts.CallExpression | ts.NewExpression,
    position: ts.Expression,
): Invoker {
    const { checker } = context;
    const origin = calledOrigin(checker, call);
    if (origin === "babylon") return { kind: "engine" };
    if (origin !== "default-lib" && origin !== "dom")
        return { kind: "unknown" };
    const target = unwrapExpression(call.expression);
    if (ts.isCallExpression(call) && isListenerRegistration(checker, call))
        return {
            kind: "listener",
            type: eventType(call.arguments[0]),
            target: namedMember(checker, target)?.expression,
        };
    // A promise executor runs once; an iteration once per element.
    if (callsArgumentInPlace(checker, call, position))
        return ts.isNewExpression(call)
            ? { kind: "construction" }
            : { kind: "iteration" };
    // A timer or frame callback runs as a task of its own; a microtask
    // runs among others the analysis does not follow.
    const scheduler = schedulerOf(checker, target);
    if (scheduler !== undefined && scheduler !== "microtask")
        return { kind: "task" };
    return { kind: "unknown" };
}

/**
 * Where a function's value is used: each reference to the binding naming
 * it, the function literal itself where it sits, or the callee of each
 * call that may run a class's method (reverse dispatch). Undefined for an
 * accessor, a constructor, or a method a use no call names may run.
 */
function functionUses(
    context: OrderContext,
    fn: ts.SignatureDeclaration,
): readonly ts.Expression[] | undefined {
    if (ts.isMethodDeclaration(fn))
        return context.evaluationOrder
            .methodCallers(fn)
            ?.map((call) => call.expression);
    const index = programIndex(context);
    if (ts.isFunctionDeclaration(fn) && fn.name) {
        const symbol = declaredSymbol(context.checker, fn.name);
        return symbol ? (index.references.get(symbol) ?? []) : undefined;
    }
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn))
        return undefined;
    const position = outermostWrapper(fn);
    const parent = position.parent;
    if (
        ts.isVariableDeclaration(parent) &&
        parent.initializer === position &&
        ts.isIdentifier(parent.name) &&
        isImmutableBinding(parent)
    ) {
        const symbol = declaredSymbol(context.checker, parent.name);
        return symbol ? (index.references.get(symbol) ?? []) : undefined;
    }
    return [position];
}

/** A listener registration: its event type and target, and the function it runs. */
interface ListenerRegistration {
    readonly type: string | undefined;
    readonly target: ts.Expression | undefined;
    readonly fn: ts.Node | undefined;
}

/** What the order analysis reads of the whole program, built once. */
interface ProgramIndex {
    /** Value references to each binding and member. */
    readonly references: Map<ts.Symbol, ts.Expression[]>;
    readonly listeners: readonly ListenerRegistration[];
    /** The functions the program hands the engine. */
    readonly engineCallbacks: readonly ts.Node[];
    /** A function value handed to the engine is not followed. */
    readonly engineCallbacksOpen: boolean;
}

/** @unjournaled A whole-program analysis of compiler inputs, built on first use. */
const programIndexes = new WeakMap<ts.TypeChecker, ProgramIndex>();

function programIndex(context: OrderContext): ProgramIndex {
    const { checker } = context;
    const known = programIndexes.get(checker);
    if (known) return known;
    const references = new Map<ts.Symbol, ts.Expression[]>();
    const listeners: ListenerRegistration[] = [];
    const engineCallbacks: ts.Node[] = [];
    let engineCallbacksOpen = false;
    const reference = (
        symbol: ts.Symbol | undefined,
        node: ts.Expression,
    ): void => {
        if (!symbol) return;
        const list = references.get(symbol);
        if (list) list.push(node);
        else references.set(symbol, [node]);
    };
    for (const file of context.sourceFiles()) {
        if (file.isDeclarationFile) continue;
        for (const node of sourceFileNodes(file)) {
            if (ts.isIdentifier(node) && isValueReference(node))
                reference(resolvedSymbol(checker, node), node);
            else if (isMemberAccess(node))
                reference(accessedPropertySymbol(checker, node), node);
            if (ts.isCallExpression(node)) {
                const origin = calledOrigin(checker, node);
                if (origin === "dom" && isListenerRegistration(checker, node))
                    listeners.push({
                        type: eventType(node.arguments[0]),
                        target: namedMember(
                            checker,
                            unwrapExpression(node.expression),
                        )?.expression,
                        fn: functionValue(checker, node.arguments[1]!),
                    });
                if (origin === "babylon") {
                    const handed = handedFunctions(checker, node.arguments);
                    if (!handed) engineCallbacksOpen = true;
                    for (const argument of handed ?? []) {
                        const fn = functionValue(checker, argument);
                        if (fn) engineCallbacks.push(fn);
                        else engineCallbacksOpen = true;
                    }
                }
            }
            if (ts.isBinaryExpression(node)) {
                const handler = handlerRegistration(
                    checker,
                    node,
                    outermostWrapper(node.right),
                );
                if (handler)
                    listeners.push({
                        type: handler.type,
                        target: handler.target,
                        fn: functionValue(checker, node.right),
                    });
            }
        }
    }
    const index: ProgramIndex = {
        references,
        listeners,
        engineCallbacks,
        engineCallbacksOpen,
    };
    programIndexes.set(checker, index);
    return index;
}

/** A listener's event type, when a string literal names it. */
function eventType(argument: ts.Expression | undefined): string | undefined {
    const type = argument && unwrapExpression(argument);
    return type && ts.isStringLiteralLike(type) ? type.text : undefined;
}

/** The function a value names: a literal or method, or a binding of one. */
function functionValue(
    checker: ts.TypeChecker,
    expression: ts.Node,
): ts.Node | undefined {
    if (!ts.isExpression(expression))
        return ts.isFunctionLike(expression) ? expression : undefined;
    const value = unwrapExpression(expression);
    if (ts.isFunctionLike(value)) return value;
    if (!ts.isIdentifier(value)) return undefined;
    const declaration = resolvedSymbol(checker, value)?.valueDeclaration;
    return declaration && isImmutableBinding(declaration)
        ? functionOfDeclaration(declaration)
        : undefined;
}
