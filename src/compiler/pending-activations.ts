// Pending activations: which synchronous activations can end at the await
// of a constructed promise that is still pending, and where that ending
// stops. JavaScript suspends such an activation for good when nothing settles
// the promise later; the lowering unwinds it (`js_synchronous_promise.hpp`)
// to the statement that discarded its promise. Every other use of such an
// activation's promise needs a pending value the synchronous lowering does
// not have; reaching one compiles the program in the application realm.
import ts from "typescript";
import { forEachAnalysisNode } from "./analysis-walk.js";
import { libraryGlobal, resolvedSymbol, calledDeclaration } from "./symbols.js";
import { outermostWrapper, referenceSite, unwrapExpression } from "./syntax.js";
import { promiseReactionOf } from "./promises.js";

type Activation = ts.SignatureDeclaration;

/** How an activation's promise is used where the activation starts. */
type PromiseUse = "awaited" | "returned" | "discarded" | "stored";

/**
 * The use of the promise `node` produces. A reaction chained on it
 * (`p.then(...)`) is used as the chain is: the reactions run in place in the
 * synchronous lowering, so a pending promise ends the chain with it.
 */
function promiseUse(node: ts.Expression, checker: ts.TypeChecker): PromiseUse {
    let current: ts.Node = node;
    for (;;) {
        current = outermostWrapper(current);
        const parent = current.parent;
        if (
            ts.isPropertyAccessExpression(parent) &&
            parent.expression === current &&
            promiseReactionOf(parent, checker) !== undefined &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression === parent
        ) {
            current = parent.parent;
            continue;
        }
        if (ts.isVoidExpression(parent)) {
            const statement = outermostWrapper(parent).parent;
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

/** The activation of the promise `node` produces, through reaction chains. */
function chainedCall(
    expression: ts.Expression,
    checker: ts.TypeChecker,
): ts.CallExpression | undefined {
    let node = unwrapExpression(expression);
    if (ts.isVoidExpression(node)) node = unwrapExpression(node.expression);
    while (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        if (
            !ts.isPropertyAccessExpression(callee) ||
            promiseReactionOf(callee, checker) === undefined
        )
            return node;
        const receiver = unwrapExpression(callee.expression);
        if (!ts.isCallExpression(receiver)) return undefined;
        node = receiver;
    }
    return undefined;
}

export class PendingActivations {
    /** @unjournaled Filled by the constructor from the program; never written after. */
    private readonly suspending = new Set<Activation>();
    /**
     * Each use that needs a pending promise value (a stored call, a
     * suspending function used as a callback), by the node lowering reaches
     * first. @unjournaled Filled by the constructor from the program; never
     * written after.
     */
    private readonly misuses = new Set<ts.Node>();

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
                    ["awaited", "returned"].includes(
                        promiseUse(node, checker),
                    ) &&
                    !handledElsewhere(node)
                ) {
                    const owner = owningActivation(node);
                    if (owner) this.suspending.add(owner);
                }
                if (!ts.isCallExpression(node)) return;
                calls.push(node);
                const use = promiseUse(node, checker);
                const callee = calledDeclaration(this.checker, node);
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
            const callee = calledDeclaration(this.checker, call);
            if (
                callee &&
                this.suspending.has(callee) &&
                promiseUse(call, this.checker) === "stored"
            )
                this.record(call);
        }
        for (const reference of references) {
            if (this.escapes(reference)) this.record(reference);
        }
    }

    /**
     * Whether lowering `node` reaches a use that needs a pending promise
     * value: the use itself as a value, or the statement around it (a
     * callback registration may lower its argument without evaluating it).
     * Unreached code needs none.
     */
    public needsPendingValue(node: ts.Node): boolean {
        return this.misuses.has(node);
    }

    private record(site: ts.Node): void {
        this.misuses.add(site);
        const statement = enclosingStatement(site);
        if (statement) this.misuses.add(statement);
    }

    /**
     * Whether an expression statement discards the promise of an activation
     * that can end at a pending await: the statement the unwinding stops at.
     */
    public discards(statement: ts.ExpressionStatement): boolean {
        const call = chainedCall(statement.expression, this.checker);
        const callee = call && calledDeclaration(this.checker, call);
        return callee !== undefined && this.suspending.has(callee);
    }

    /** A suspending function used as a value rather than called. */
    private escapes(
        reference: ts.Identifier | ts.FunctionLikeDeclaration,
    ): boolean {
        let activation: Activation | undefined;
        let site: ts.Node = reference;
        if (ts.isIdentifier(reference)) {
            // An export names the function; it does not call it.
            const used = referenceSite(reference);
            if (!used || ts.isExportSpecifier(reference.parent)) return false;
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
            site = used;
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
        const callee = outermostWrapper(site);
        return !(
            ts.isCallExpression(callee.parent) &&
            callee.parent.expression === callee
        );
    }
}
