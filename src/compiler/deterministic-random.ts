// `Math.random = <arrow>`: the deterministic seed a scene installs before
// stepping a node-particle simulation.
//
// This is the one place a piece of the scene's own text travels to
// generation rather than being lowered, and the reason is specific: the
// simulation it seeds is EXECUTED by the pin under the browser
// (`src/pinned-node-particle.ts`), so the sequence has to be drawn by the
// same function in the same engine. An arrow moved verbatim into the driver
// draws an identical sequence by construction; anything restated here --
// even a faithful transcription -- would only agree until the scene changed
// it, and the corpus seeds through `Math.sin`, which is not reproducible off
// V8 anyway.
//
// So the assignment lowers to NOTHING native. It parameterizes the bake and
// nothing else, which is only sound while no lowered code answers
// `Math.random`: the native runtime would answer with the pinned mulberry32
// and disagree with the browser. `assertDeterministicRandomUnreached` is
// that check, run once the whole entry has been walked.
import ts from "typescript";
import type { CompiledNodeParticles, Value } from "./types.js";

export interface DeterministicRandomContext {
    readonly reachedNodeParticles: CompiledNodeParticles;
    /** The native name a source identifier is bound to in this scope. */
    lookup(identifier: ts.Identifier): Value;
    /** Mark an emitted local whose only reader moved to generation. */
    markEmittedLocalUnused(cppName: string, site: ts.Node): void;
    fail(node: ts.Node, message: string): never;
}

/** Whether an expression is the bare `Math.random` function reference. */
export function isDeterministicRandomRead(
    expression: ts.Expression,
): boolean {
    return (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "Math" &&
        expression.name.text === "random"
    );
}

/** TypeScript-only expression forms an arrow's text may not carry. */
function refuseTypeSyntax(
    context: DeterministicRandomContext,
    arrow: ts.ArrowFunction,
): void {
    const visit = (node: ts.Node): void => {
        if (
            ts.isAsExpression(node) ||
            ts.isSatisfiesExpression(node) ||
            ts.isTypeAssertionExpression(node) ||
            ts.isNonNullExpression(node) ||
            ts.isTypeNode(node)
        ) {
            context.fail(
                node,
                "A deterministic Math.random arrow travels to generation as " +
                    "the JavaScript it is; TypeScript-only syntax inside it " +
                    "is not lowered.",
            );
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(arrow, visit);
}

/**
 * The locals an arrow closes over, in declaration order, each as the `let`
 * the driver re-declares.
 *
 * The seed is state: `seed++` inside the arrow reads and writes a variable
 * the scene declared beside it, so the driver needs that declaration too.
 * Only a numeric literal initializer is accepted -- anything else is a value
 * this compiler would have to compute, which is lowering rather than
 * moving.
 */
function capturedDeclarations(
    context: DeterministicRandomContext,
    arrow: ts.ArrowFunction,
    checker: ts.TypeChecker,
): string[] {
    const captured: ts.VariableDeclaration[] = [];
    const declared = new Set<ts.Symbol>();
    const collectDeclared = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) declared.add(symbol);
        }
        ts.forEachChild(node, collectDeclared);
    };
    collectDeclared(arrow);

    const visit = (node: ts.Node): void => {
        if (
            ts.isPropertyAccessExpression(node)
        ) {
            visit(node.expression);
            return;
        }
        if (ts.isIdentifier(node)) {
            if (node.text === "Math") return;
            const symbol = checker.getSymbolAtLocation(node);
            if (!symbol || declared.has(symbol)) return;
            const declaration = symbol.valueDeclaration;
            if (
                !declaration ||
                !ts.isVariableDeclaration(declaration) ||
                !declaration.initializer ||
                !ts.isNumericLiteral(declaration.initializer)
            ) {
                context.fail(
                    node,
                    `A deterministic Math.random arrow may close over ` +
                        `numeric locals only; '${node.text}' is not one.`,
                );
            }
            if (!captured.includes(declaration)) {
                captured.push(declaration);
            }
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(arrow, visit);

    return captured
        .sort((left, right) => left.pos - right.pos)
        .map((declaration) => {
            const name = declaration.name as ts.Identifier;
            // The lowered program no longer reads it: the arrow that did is
            // the driver's now.
            context.markEmittedLocalUnused(
                context.lookup(name).cpp,
                name,
            );
            return (
                `let ${name.text} = ` +
                `${(declaration.initializer as ts.NumericLiteral).text};`
            );
        });
}

/**
 * Record `Math.random = <arrow>` as the bake's seed, or return false when
 * the assignment is not that.
 */
export function emitDeterministicRandomInstall(
    context: DeterministicRandomContext,
    expression: ts.BinaryExpression,
    left: ts.PropertyAccessExpression,
    checker: ts.TypeChecker,
): boolean {
    if (
        !ts.isIdentifier(left.expression) ||
        left.expression.text !== "Math" ||
        left.name.text !== "random"
    ) {
        return false;
    }
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        context.fail(
            expression,
            "Math.random is replaced by an arrow function or not at all.",
        );
    }
    // `Math.random = original`: the scene closing the seeded window it
    // opened. The driver restores the generator it saved, so pinned code
    // after this point draws from the browser's own again.
    if (
        ts.isIdentifier(expression.right) &&
        context.lookup(expression.right).kind === "js-random"
    ) {
        context.reachedNodeParticles.steps.push({ op: "random-restore" });
        return true;
    }
    if (!ts.isArrowFunction(expression.right)) {
        context.fail(
            expression,
            "Math.random is replaced by an arrow function or not at all.",
        );
    }
    if (context.reachedNodeParticles.sets.length === 0) {
        context.fail(
            expression,
            "Math.random is replaceable only as the deterministic seed of a " +
                "node-particle simulation generation executes; nothing else " +
                "reads it at generation.",
        );
    }
    const arrow = expression.right;
    if (arrow.parameters.length > 0 || arrow.typeParameters) {
        context.fail(
            arrow,
            "A deterministic Math.random arrow takes no parameters.",
        );
    }
    refuseTypeSyntax(context, arrow);
    context.reachedNodeParticles.steps.push({
        op: "random",
        declarations: capturedDeclarations(context, arrow, checker),
        arrow: arrow.getText(),
    });
    return true;
}

/**
 * A scene that replaced `Math.random` must not also reach the lowered one.
 *
 * The replacement is compile-time only: it seeds the executed bake and emits
 * no native code. If lowered code also drew from `Math.random`, the native
 * runtime would answer with the pinned mulberry32 while the browser answered
 * with the scene's own arrow, and the two would silently disagree.
 */
export function assertDeterministicRandomUnreached(
    context: DeterministicRandomContext,
    jsRandomReached: boolean,
    site: ts.Node,
): void {
    const installed = context.reachedNodeParticles.steps.some(
        (step) => step.op === "random",
    );
    if (installed && jsRandomReached) {
        context.fail(
            site,
            "This scene replaces Math.random for its node-particle bake and " +
                "also calls Math.random from lowered code; the native " +
                "runtime would answer with the pinned sequence instead.",
        );
    }
}
