// Pending activations: which synchronous activations can end at the await
// of a constructed promise that is still pending, and where that ending
// stops. JavaScript suspends such an activation for good when nothing settles
// the promise later; the lowering unwinds it (`js_synchronous_promise.hpp`)
// to the statement that discarded its promise. Every other use of such an
// activation's promise needs a pending value the synchronous lowering does
// not have, so it refuses where the lowering reaches it.
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { libraryGlobal, resolvedSymbol } from "./symbols.js";
import { unwrapExpression } from "./syntax.js";

type Activation = ts.SignatureDeclaration;

/** How an activation's promise is used where the activation starts. */
type PromiseUse = "awaited" | "returned" | "discarded" | "stored";

const PROMISE_REACTIONS: ReadonlySet<string> = new Set([
    "then",
    "catch",
    "finally",
]);

function isTransparentWrapper(node: ts.Node): boolean {
    return (
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isSatisfiesExpression(node) ||
        ts.isNonNullExpression(node)
    );
}

/**
 * The use of the promise `node` produces. A reaction chained on it
 * (`p.then(...)`) is used as the chain is: the reactions run in place in the
 * synchronous lowering, so a pending promise ends the chain with it.
 */
function promiseUse(node: ts.Expression): PromiseUse {
    let current: ts.Node = node;
    for (;;) {
        const parent = current.parent;
        if (isTransparentWrapper(parent)) {
            current = parent;
            continue;
        }
        if (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === current &&
            PROMISE_REACTIONS.has(parent.name.text) &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent
        ) {
            current = parent.parent;
            continue;
        }
        if (ts.isVoidExpression(parent)) {
            let statement: ts.Node = parent.parent;
            while (isTransparentWrapper(statement))
                statement = statement.parent;
            return ts.isExpressionStatement(statement) ? "discarded" : "stored";
        }
        if (ts.isAwaitExpression(parent)) return "awaited";
        if (
            ts.isReturnStatement(parent) ||
            (ts.isArrowFunction(parent) && parent.body === current)
        )
            return "returned";
        return ts.isExpressionStatement(parent) ? "discarded" : "stored";
    }
}

/** The function-like node whose own body contains `node`. */
function owningActivation(node: ts.Node): Activation | undefined {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isFunctionLike(current)) return current;
    }
    return undefined;
}

/** The statement a lowering reaches before any expression inside it. */
function enclosingStatement(node: ts.Node): ts.Statement | undefined {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isStatement(current) && !ts.isBlock(current)) return current;
    }
    return undefined;
}

const STORED_MESSAGE =
    "A call that can await a pending constructed promise is awaited, " +
    "returned or discarded as a statement; the synchronous lowering has no " +
    "pending promise value to store.";
const CALLBACK_MESSAGE =
    "A function that can await a pending constructed promise is called " +
    "where it is named; as a callback, the activation that ends at its " +
    "await has no statement to end at. Start it with `void f()` inside a " +
    "synchronous callback.";

/** The activation of the promise `node` produces, through reaction chains. */
function chainedCall(expression: ts.Expression): ts.CallExpression | undefined {
    let node = unwrapExpression(expression);
    if (ts.isVoidExpression(node)) node = unwrapExpression(node.expression);
    while (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            !PROMISE_REACTIONS.has(callee.name.text)
        )
            return node;
        const receiver = unwrapExpression(callee.expression);
        if (!ts.isCallExpression(receiver)) return undefined;
        node = receiver;
    }
    return undefined;
}

export class PendingActivations {
    private readonly suspending = new Set<Activation>();
    /** Each use that needs a pending promise value, by the node lowering reaches first. */
    private readonly misuses = new Map<
        ts.Node,
        { site: ts.Node; message: string }
    >();

    /**
     * `handledElsewhere` answers the Promise constructions another lowering
     * owns (frame waits and polls); every other library `new Promise`
     * awaited or returned where it is created is a constructed promise.
     */
    public constructor(
        private readonly checker: ts.TypeChecker,
        files: readonly ts.SourceFile[],
        handledElsewhere: (construction: ts.NewExpression) => boolean,
    ) {
        const callers = new Map<Activation, Set<Activation>>();
        const calls: ts.CallExpression[] = [];
        const references: (ts.Identifier | ts.FunctionLikeDeclaration)[] = [];
        for (const file of files) {
            if (file.isDeclarationFile) continue;
            forEachAnalysisNode(file, (node) => {
                if (ts.isTypeNode(node)) return "skip";
                if (ts.isIdentifier(node)) references.push(node);
                if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
                    references.push(node);
                if (
                    ts.isNewExpression(node) &&
                    libraryGlobal(checker, node.expression) === "Promise" &&
                    ["awaited", "returned"].includes(promiseUse(node)) &&
                    !handledElsewhere(node)
                ) {
                    const owner = owningActivation(node);
                    if (owner) this.suspending.add(owner);
                }
                if (!ts.isCallExpression(node)) return;
                calls.push(node);
                const use = promiseUse(node);
                const callee = this.calledActivation(node);
                const owner = owningActivation(node);
                if (
                    callee &&
                    owner &&
                    (use === "awaited" || use === "returned")
                ) {
                    const known = callers.get(callee) ?? new Set<Activation>();
                    known.add(owner);
                    callers.set(callee, known);
                }
            });
        }
        const pending = [...this.suspending];
        for (let next = pending.pop(); next; next = pending.pop()) {
            for (const caller of callers.get(next) ?? []) {
                if (this.suspending.has(caller)) continue;
                this.suspending.add(caller);
                pending.push(caller);
            }
        }
        if (this.suspending.size === 0) return;
        for (const call of calls) {
            const callee = this.calledActivation(call);
            if (
                callee &&
                this.suspending.has(callee) &&
                promiseUse(call) === "stored"
            )
                this.record(call, STORED_MESSAGE);
        }
        for (const reference of references) {
            if (this.escapes(reference))
                this.record(reference, CALLBACK_MESSAGE);
        }
    }

    /**
     * Refuses a use that needs a pending promise value once the lowering
     * reaches it: the use itself as a value, or the statement around it
     * (a callback registration may lower its argument without evaluating
     * it). Unreached code refuses nothing.
     */
    public refuseReached(
        node: ts.Node,
        fail: (node: ts.Node, message: string) => never,
    ): void {
        const misuse = this.misuses.get(node);
        if (misuse) fail(misuse.site, misuse.message);
    }

    private record(site: ts.Node, message: string): void {
        const misuse = { site, message };
        this.misuses.set(site, misuse);
        const statement = enclosingStatement(site);
        if (statement && !this.misuses.has(statement))
            this.misuses.set(statement, misuse);
    }

    /**
     * Whether an expression statement discards the promise of an activation
     * that can end at a pending await: the statement the unwinding stops at.
     */
    public discards(statement: ts.ExpressionStatement): boolean {
        const call = chainedCall(statement.expression);
        const callee = call && this.calledActivation(call);
        return callee !== undefined && this.suspending.has(callee);
    }

    private calledActivation(call: ts.CallExpression): Activation | undefined {
        const declaration =
            this.checker.getResolvedSignature(call)?.declaration;
        return declaration && !ts.isJSDocSignature(declaration)
            ? declaration
            : undefined;
    }

    /** A suspending function used as a value rather than called. */
    private escapes(
        reference: ts.Identifier | ts.FunctionLikeDeclaration,
    ): boolean {
        let activation: Activation | undefined;
        let site: ts.Node = reference;
        if (ts.isIdentifier(reference)) {
            const parent = reference.parent;
            if (
                ts.isImportSpecifier(parent) ||
                ts.isExportSpecifier(parent) ||
                ts.isImportClause(parent) ||
                ((ts.isFunctionDeclaration(parent) ||
                    ts.isFunctionExpression(parent) ||
                    ts.isMethodDeclaration(parent) ||
                    ts.isVariableDeclaration(parent) ||
                    ts.isPropertyAssignment(parent) ||
                    ts.isPropertyDeclaration(parent)) &&
                    parent.name === reference)
            )
                return false;
            const declaration = resolvedSymbol(
                this.checker,
                reference,
            )?.valueDeclaration;
            const initializer =
                declaration &&
                (ts.isVariableDeclaration(declaration) ||
                    ts.isPropertyAssignment(declaration) ||
                    ts.isPropertyDeclaration(declaration)) &&
                declaration.initializer
                    ? unwrapExpression(declaration.initializer)
                    : undefined;
            activation =
                declaration && ts.isFunctionLike(declaration)
                    ? declaration
                    : initializer && ts.isFunctionLike(initializer)
                      ? initializer
                      : undefined;
            if (
                ts.isPropertyAccessExpression(parent) &&
                parent.name === reference
            )
                site = parent;
        } else {
            activation = reference;
            const parent = reference.parent;
            if (
                (ts.isVariableDeclaration(parent) ||
                    ts.isPropertyAssignment(parent) ||
                    ts.isPropertyDeclaration(parent)) &&
                parent.initializer === reference
            )
                return false;
        }
        if (!activation || !this.suspending.has(activation)) return false;
        let callee: ts.Node = site;
        while (isTransparentWrapper(callee.parent)) callee = callee.parent;
        return !(
            ts.isCallExpression(callee.parent) &&
            callee.parent.expression === callee
        );
    }
}
