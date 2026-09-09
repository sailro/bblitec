import { EmissionSet } from "./emission-transaction.js";
import type { LoweringServices } from "./lowering-services.js";
// `Math.random = <arrow>`: the deterministic seed a scene installs before
// stepping a node-particle simulation.
//
// For frozen simulations, this is the one place scene text travels to
// generation rather than being lowered, and the reason is specific: the
// simulation it seeds is EXECUTED by the pin under the browser
// (`src/pinned-node-particle.ts`), so the sequence has to be drawn by the
// same function in the same engine. An arrow moved verbatim into the driver
// draws an identical sequence by construction; anything restated here --
// even a faithful transcription -- would only agree until the scene changed
// it, and the corpus seeds through `Math.sin`, which is not reproducible off
// V8 anyway.
//
// In that path the assignment lowers to nothing native. It parameterizes the bake and
// nothing else, which is only sound while no lowered code answers
// `Math.random`: the native runtime would answer with the pinned mulberry32
// and disagree with the browser. `assertDeterministicRandomUnreached` is
// that check, run once the whole entry has been walked.
// Provider-backed sets instead run the authored callback and simulation
// natively, so their random assignments install native closures and saved
// random functions retain their JavaScript identity and captured state.
// `Math.random = <arrow>`: the deterministic seed a scene installs before
// stepping a node-particle simulation.
//
// For frozen simulations, this is the one place scene text travels to
// generation rather than being lowered, and the reason is specific: the
// simulation it seeds is EXECUTED by the pin under the browser
// (`src/pinned-node-particle.ts`), so the sequence has to be drawn by the
// same function in the same engine. An arrow moved verbatim into the driver
// draws an identical sequence by construction; anything restated here --
// even a faithful transcription -- would only agree until the scene changed
// it, and the corpus seeds through `Math.sin`, which is not reproducible off
// V8 anyway.
//
// In that path the assignment lowers to nothing native. It parameterizes the bake and
// nothing else, which is only sound while no lowered code answers
// `Math.random`: the native runtime would answer with the pinned mulberry32
// and disagree with the browser. `assertDeterministicRandomUnreached` is
// that check, run once the whole entry has been walked.
// Provider-backed sets instead run the authored callback and simulation
// natively, so their random assignments install native closures and saved
// random functions retain their JavaScript identity and captured state.
import ts from "typescript";
import { transpileForBrowser } from "../typescript-transpile.js";

export interface DeterministicRandomContext
    extends Pick<LoweringServices,
        | "isDefaultLibraryIdentifier"
        | "reachedNodeParticles"
        | "lookup"
        | "compileForDataSink"
        | "emit"
        | "fail"
    > {}

/** Whether an expression is the bare `Math.random` function reference. */
export function isDeterministicRandomRead(
    context: Pick<DeterministicRandomContext, "isDefaultLibraryIdentifier">,
    expression: ts.Expression,
): boolean {
    return (
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "Math" &&
        context.isDefaultLibraryIdentifier(expression.expression) &&
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
 * The module-level function a seed factory call names, or a refusal.
 *
 * It must be a plain declaration with a body: the driver runs its text, so
 * an overload, an ambient declaration or an imported binding with no source
 * here has nothing to move.
 */
function seedFactoryDeclaration(
    context: DeterministicRandomContext,
    callee: ts.Identifier,
    checker: ts.TypeChecker,
): ts.FunctionDeclaration {
    // A factory is normally imported from a shared module, so the identifier
    // resolves to the import alias; the declaration is behind it.
    const bound = checker.getSymbolAtLocation(callee);
    const symbol =
        bound && bound.flags & ts.SymbolFlags.Alias
            ? checker.getAliasedSymbol(bound)
            : bound;
    const declaration = symbol?.valueDeclaration;
    if (
        !declaration ||
        !ts.isFunctionDeclaration(declaration) ||
        !declaration.body ||
        !declaration.name
    ) {
        context.fail(
            callee,
            `A deterministic Math.random factory must be a function ` +
                `declaration this compiler can read; '${callee.text}' is ` +
                "not one.",
        );
    }
    const factory = declaration as ts.FunctionDeclaration;
    if (
        factory.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
        )
    ) {
        context.fail(
            callee,
            "A deterministic Math.random factory is not async; the driver " +
                "installs the generator it returns.",
        );
    }
    if (!factory.getSourceFile().fileName.endsWith(".ts")) {
        context.fail(callee, "A deterministic Math.random factory needs its source.");
    }
    return factory;
}

/** A seed factory's declaration as the JavaScript the driver runs. */
function seedFactoryJs(factory: ts.FunctionDeclaration): string {
    // Modifiers precede `function`, and `export` would transpile into an
    // assignment onto a module object the driver's scope does not have.
    const text = factory.getText();
    const bare = text.slice(text.indexOf("function"));
    return transpileForBrowser(bare, "deterministic-seed.ts").trim();
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
    arrow: ts.ArrowFunction | ts.FunctionDeclaration,
    checker: ts.TypeChecker,
): string[] {
    const captured: Array<{ declaration: ts.VariableDeclaration; name: ts.Identifier; initializer: ts.NumericLiteral }> = [];
    const declared = new EmissionSet<ts.Symbol>();
    const collectDeclared = (node: ts.Node): void => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) declared.add(symbol);
        }
        // A factory's parameters are bound by the call, and its own name
        // binds the declaration itself; neither is closed over.
        if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
            const symbol = checker.getSymbolAtLocation(node.name);
            if (symbol) declared.add(symbol);
        }
        if (ts.isFunctionDeclaration(node) && node.name) {
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
            if (node.text === "Math" && context.isDefaultLibraryIdentifier(node)) return;
            const symbol = checker.getSymbolAtLocation(node);
            if (!symbol || declared.has(symbol)) return;
            const declaration = symbol.valueDeclaration;
            if (
                !declaration ||
                !ts.isVariableDeclaration(declaration) ||
                !ts.isIdentifier(declaration.name) ||
                !declaration.initializer ||
                !ts.isNumericLiteral(declaration.initializer)
            ) {
                context.fail(
                    node,
                    `A deterministic Math.random arrow may close over ` +
                        `numeric locals only; '${node.text}' is not one.`,
                );
            }
            if (!captured.some(capture => capture.declaration === declaration)) {
                captured.push({ declaration, name: declaration.name, initializer: declaration.initializer });
            }
            return;
        }
        ts.forEachChild(node, visit);
    };
    ts.forEachChild(arrow, visit);

    return captured
        .sort((left, right) => left.declaration.pos - right.declaration.pos)
        .map(({ name, initializer }) => {
            return (
                `let ${name.text} = ` +
                `${initializer.text};`
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
    if (!isDeterministicRandomRead(context, left)) {
        return false;
    }
    if (expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        context.fail(
            expression,
            "Math.random is replaced by an arrow function or not at all.",
        );
    }
    if (context.reachedNodeParticles.sets.some((set) => set.native)) {
        if (context.reachedNodeParticles.sets.some((set) => !set.native)) {
            context.fail(expression, "A Math.random override cannot span native and generation-only particle systems.");
        }
        const saved = ts.isIdentifier(expression.right) ? context.lookup(expression.right) : undefined;
        const callback = saved?.kind === "js-random"
            ? saved.cpp || "bbl::js::Callback<double()>{}"
            : context.compileForDataSink(expression.right, {
                kind: "function", parameters: [], result: { kind: "number" },
            });
        context.emit(`bbl::js::set_random_override(${callback});`);
        return true;
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
    // `Math.random = makeSeed()`: the generator comes from a module-level
    // factory rather than an arrow written at the assignment. The factory
    // holds the state the returned function steps, so what travels is the
    // declaration plus the call -- the driver already re-declares captures
    // in a scope of its own and returns an expression, so the factory goes
    // in beside them and the call becomes that expression.
    if (
        ts.isCallExpression(expression.right) &&
        ts.isIdentifier(expression.right.expression)
    ) {
        const factory = seedFactoryDeclaration(
            context,
            expression.right.expression,
            checker,
        );
        const call = expression.right;
        const args = call.arguments.map((argument) => {
            if (
                !ts.isNumericLiteral(argument) &&
                !(
                    ts.isPrefixUnaryExpression(argument) &&
                    argument.operator === ts.SyntaxKind.MinusToken &&
                    ts.isNumericLiteral(argument.operand)
                )
            ) {
                context.fail(
                    argument,
                    "A deterministic Math.random factory takes numeric " +
                        "literal arguments only; anything else is a value " +
                        "this compiler would have to compute.",
                );
            }
            return argument.getText();
        });
        context.reachedNodeParticles.steps.push({
            op: "random",
            declarations: [
                ...capturedDeclarations(context, factory, checker),
                // The pin annotates its own factory, and the driver runs
                // JavaScript, so the declaration travels through the same
                // transpile the other pinned-text drivers use rather than
                // refusing the annotation the way a verbatim arrow must.
                ...seedFactoryJs(factory).split("\n"),
            ],
            arrow: `${factory.name!.text}(${args.join(", ")})`,
        });
        return true;
    }
    if (!ts.isArrowFunction(expression.right)) {
        context.fail(
            expression,
            "Math.random is replaced by an arrow function, a call to a " +
                "module-level factory returning one, or not at all.",
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
