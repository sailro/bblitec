import ts from "typescript";
import {
    localSyncFunction,
    requiredParameterCount,
    restParameterIndex,
    unwrapExpression,
    writeSites,
    isSuspensionPoint,
    variableKind,
} from "./syntax.js";
import {
    accessedPropertySymbol,
    libraryGlobal,
    type CompilerSymbols,
} from "./symbols.js";

/**
 * Pinned exports whose only effect the native realm does not represent.
 * The browser pool counts texture ownership; native records retain their
 * CPU texture and each backend counts its own bindings, so both lower to
 * nothing (`compileAcquireTexture`).
 */
const inertPinnedExports = new Set(["acquireTexture", "releaseTexture"]);

/** Methods that change only the local collection they are called on. */
const localCollectionMethods = new Set([
    "add",
    "delete",
    "get",
    "has",
    "push",
    "set",
]);

const localCollectionConstructors = new Set([
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
]);

const inertStatementKinds: ReadonlySet<ts.SyntaxKind> = new Set([
    ts.SyntaxKind.Block,
    ts.SyntaxKind.EmptyStatement,
    ts.SyntaxKind.VariableStatement,
    ts.SyntaxKind.ExpressionStatement,
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.ReturnStatement,
    ts.SyntaxKind.BreakStatement,
    ts.SyntaxKind.ContinueStatement,
    ts.SyntaxKind.FunctionDeclaration,
]);

interface NativeInertContext {
    readonly checker: ts.TypeChecker;
    readonly symbols: Pick<
        CompilerSymbols,
        "babylonImportName" | "valueSymbol"
    >;
}

/**
 * Whether a statement-level call to a local function can change only state
 * the native realm does not represent, so erasing it is the whole lowering.
 *
 * The helper (and every local closure it calls) may read its inputs, build
 * and update local collections, iterate arrays, and call the inert pinned
 * exports above; anything else -- a write outside its own locals, another
 * call, an accessor, `await`, `throw` -- keeps the call on the ordinary
 * lowering. Like C++ forward progress, a walk is assumed to terminate.
 */
export function isNativeInertCall(
    context: NativeInertContext,
    expression: ts.Expression,
): boolean {
    const call = unwrapExpression(expression);
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) {
        return false;
    }
    if (!call.arguments.every(isPlainRead)) return false;
    const root = localSyncFunction(
        context.symbols.valueSymbol(call.expression)?.valueDeclaration,
    );
    // Too few arguments, or one no parameter receives, keeps the call on
    // the ordinary lowering.
    if (
        root === undefined ||
        call.arguments.length < requiredParameterCount(root.parameters) ||
        (restParameterIndex(root) === undefined &&
            call.arguments.length > root.parameters.length)
    )
        return false;
    let answers = inertFunctions.get(context.checker);
    if (!answers)
        inertFunctions.set(context.checker, (answers = new WeakMap()));
    let inert = answers.get(root);
    if (inert === undefined)
        answers.set(root, (inert = InertWalk.erases(context, root)));
    return inert;
}

/** Per program, whether each local function is inert (it depends on nothing else). */
const inertFunctions = new WeakMap<
    ts.TypeChecker,
    WeakMap<LocalFunction, boolean>
>();

type LocalFunction =
    ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** An argument whose evaluation has no effect: a literal or a property path. */
function isPlainRead(expression: ts.Expression): boolean {
    const value = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(value))
        return isPlainRead(value.expression);
    return (
        ts.isIdentifier(value) ||
        ts.isLiteralExpression(value) ||
        value.kind === ts.SyntaxKind.TrueKeyword ||
        value.kind === ts.SyntaxKind.FalseKeyword ||
        value.kind === ts.SyntaxKind.NullKeyword
    );
}

class InertWalk {
    /** @unjournaled One proof's walk, over the program alone. */
    private readonly visited = new Set<LocalFunction>();
    /** @unjournaled Whether the walk met an inert pinned export. */
    private reachesInertExport = false;

    /**
     * Only a helper that reaches an inert pinned export is erased: erasing
     * any other effect-free helper would also hide what its body refuses.
     */
    public static erases(
        context: NativeInertContext,
        root: LocalFunction,
    ): boolean {
        const walk = new InertWalk(context, root);
        return walk.body(root) && walk.reachesInertExport;
    }

    private constructor(
        private readonly context: NativeInertContext,
        private readonly root: LocalFunction,
    ) {}

    private body(fn: LocalFunction): boolean {
        // Recursion is coinductive: a closure already being proved is
        // assumed inert while its own body is checked.
        if (this.visited.has(fn)) return true;
        this.visited.add(fn);
        return this.inert(fn.body!);
    }

    private inert(node: ts.Node): boolean {
        // Only the statements this walk models; any other (`debugger`, a
        // label, `switch`, `try`) keeps the call on the ordinary lowering.
        if (ts.isStatement(node) && !inertStatementKinds.has(node.kind))
            return false;
        // A write stays inert only into the call's own locals; `delete`
        // and loop targets included.
        if (writeSites(node).some(({ target }) => !this.isOwnLocal(target)))
            return false;
        if (
            isSuspensionPoint(node, { yield: true }) ||
            ts.isTaggedTemplateExpression(node) ||
            ts.isNonNullExpression(node) ||
            ts.isClassLike(node) ||
            // Both read every property through its accessor, if any.
            ts.isObjectBindingPattern(node) ||
            ts.isSpreadAssignment(node)
        ) {
            return false;
        }
        if (ts.isCallExpression(node)) {
            if (!this.call(node)) return false;
        } else if (ts.isNewExpression(node)) {
            if (!this.construction(node)) return false;
        } else if (ts.isForOfStatement(node)) {
            if (isSuspensionPoint(node) || !this.isArray(node.expression)) {
                return false;
            }
        } else if (
            ts.isPropertyAccessExpression(node) ||
            ts.isElementAccessExpression(node)
        ) {
            if (this.readsAccessor(node)) return false;
        }
        return (
            ts.forEachChild(node, (child) =>
                this.inert(child) ? undefined : true,
            ) !== true
        );
    }

    private call(call: ts.CallExpression): boolean {
        const callee = unwrapExpression(call.expression);
        if (ts.isIdentifier(callee)) {
            const pinned = this.context.symbols.babylonImportName(callee);
            if (pinned !== undefined) {
                if (!inertPinnedExports.has(pinned)) return false;
                this.reachesInertExport = true;
                return true;
            }
            const closure = localSyncFunction(
                this.context.symbols.valueSymbol(callee)?.valueDeclaration,
            );
            return (
                closure !== undefined &&
                this.isInsideRoot(closure) &&
                this.body(closure)
            );
        }
        if (!ts.isPropertyAccessExpression(callee)) return false;
        const owner = unwrapExpression(callee.expression);
        if (
            libraryGlobal(this.context.checker, owner) === "Object" &&
            ["entries", "keys", "values"].includes(callee.name.text)
        ) {
            return true;
        }
        return (
            localCollectionMethods.has(callee.name.text) &&
            this.isLocalCollection(owner)
        );
    }

    private construction(construction: ts.NewExpression): boolean {
        const callee = unwrapExpression(construction.expression);
        return (
            localCollectionConstructors.has(
                libraryGlobal(this.context.checker, callee) ?? "",
            ) && (construction.arguments ?? []).every(isPlainRead)
        );
    }

    /** A collection the walk itself constructed into one of its own consts. */
    private isLocalCollection(expression: ts.Expression): boolean {
        if (!ts.isIdentifier(expression)) return false;
        const declaration = this.declarationOf(expression);
        if (
            !declaration ||
            !ts.isVariableDeclaration(declaration) ||
            !this.isInsideRoot(declaration) ||
            !declaration.initializer ||
            variableKind(declaration) !== "const"
        ) {
            return false;
        }
        const initializer = unwrapExpression(declaration.initializer);
        return (
            ts.isArrayLiteralExpression(initializer) ||
            (ts.isNewExpression(initializer) && this.construction(initializer))
        );
    }

    private isOwnLocal(target: ts.Expression): boolean {
        const value = unwrapExpression(target);
        if (!ts.isIdentifier(value)) return false;
        const declaration = this.declarationOf(value);
        return (
            declaration !== undefined &&
            (ts.isVariableDeclaration(declaration) ||
                ts.isParameter(declaration)) &&
            this.isInsideRoot(declaration)
        );
    }

    private isArray(expression: ts.Expression): boolean {
        const type = this.context.checker.getTypeAtLocation(expression);
        const parts = type.isUnion() ? type.types : [type];
        return parts.every(
            (part) =>
                this.context.checker.isArrayType(part) ||
                this.context.checker.isTupleType(part),
        );
    }

    private readsAccessor(
        access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    ): boolean {
        const symbol = accessedPropertySymbol(this.context.checker, access);
        return (
            symbol?.declarations?.some(
                (declaration) =>
                    ts.isGetAccessorDeclaration(declaration) ||
                    ts.isSetAccessorDeclaration(declaration),
            ) === true
        );
    }

    private declarationOf(
        identifier: ts.Identifier,
    ): ts.Declaration | undefined {
        return this.context.symbols.valueSymbol(identifier)?.valueDeclaration;
    }

    private isInsideRoot(node: ts.Node): boolean {
        for (
            let current: ts.Node | undefined = node;
            current;
            current = current.parent
        ) {
            if (current === this.root) return true;
        }
        return false;
    }
}
