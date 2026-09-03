/**
 * A pinned mesh builder's own option defaults, read from the factory that
 * states them.
 *
 * Every builder in `src/mesh/create-*.ts` resolves its options the same way
 * — one `const x = options.x ?? <default>` per option — and this port's
 * intrinsics resolve them at GENERATION, because a builder's emitted body
 * binds each option to the present arm of that `??`. So the default has to
 * reach the call site, and reading it here is what keeps it the pin's
 * rather than a second copy typed beside the intrinsic.
 *
 * The shadow family answers the same question through emitted `*_default_*`
 * constants, because its factories are lowered into a header the scene
 * already includes. The mesh factories emit no header, so the value is
 * folded into the call instead — the same fact, at the only place a mesh
 * scene can carry it.
 */
import ts from "typescript";
import { LoweringContext } from "./lowering/context.js";
import { unwrapPin } from "./lowering/gltf/shared.js";
import { sharedUpstreamStore } from "./upstream-source.js";

/** One reader per process; the pin cannot move under a generation. */
let sharedContext: LoweringContext | undefined;

function reader(): LoweringContext {
    sharedContext ??= new LoweringContext(sharedUpstreamStore());
    return sharedContext;
}

/**
 * The right side of the `??` that resolves one option.
 *
 * A builder wraps that operator in whatever its own contract needs — `| 0`
 * for an integer, `Math.max(3, ...)` for a floor, a guard ternary that
 * rejects an out-of-range value — and none of those wrappers is the
 * DEFAULT. The default is what the read falls back to when the option is
 * absent, so the search is for the `??` itself wherever the builder put it.
 *
 * `a ?? b ?? c` parses as `(a ?? b) ?? c`, so the option's own read sits at
 * the bottom of the left spine and the default is the OUTERMOST right
 * operand — `diameterTop ?? diameter ?? 1` defaults to 1, not to
 * `diameter`. Taking the first `??` in pre-order is taking that outermost
 * one, which is why one pass answers for every builder.
 */
function pinnedDefaultExpression(
    modulePath: string,
    factory: string,
    local: string,
): ts.Expression {
    const context = reader();
    const { declaration } = context.functionDeclaration(
        modulePath,
        factory,
    );
    const initializer = context.variableInitializer(declaration, local);
    let found: ts.BinaryExpression | undefined;
    const visit = (node: ts.Node): void => {
        if (found) return;
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken
        ) {
            found = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(initializer);
    return found
        ? unwrapPin(found.right)
        : context.contractError(
              initializer,
              `${modulePath}#${factory} resolves '${local}' without a '??'.`,
          );
}

/** One `const <local> = <options>.<local> ?? <number>` fallback. */
export function pinnedMeshOptionDefault(
    modulePath: string,
    factory: string,
    local: string,
): number {
    return reader().numericValue(
        pinnedDefaultExpression(modulePath, factory, local),
        reader().sourceFile(modulePath),
    );
}

/**
 * Which options one pinned builder resolves, as its own local names in its
 * own declaration order.
 *
 * The same `const <name> = <options>.<name> ?? <default>` head the two
 * readers above take a VALUE out of, read here for the list and the order
 * instead. A builder that declares a closure needs it: a JavaScript closure
 * captures by name and a free C++ function cannot, so what the closure reads
 * becomes parameters — and taking their order from the pin means a builder
 * that adds or reorders an option moves the emitted signature with it rather
 * than compiling against a list typed beside the emitter.
 *
 * Only a fallback keyed to the options record counts, so a local the builder
 * computes for itself is not mistaken for one the caller can name.
 */
export function pinnedMeshOptionLocals(
    modulePath: string,
    factory: string,
): readonly string[] {
    const context = reader();
    const { declaration } = context.functionDeclaration(
        modulePath,
        factory,
    );
    const options = declaration.parameters[0];
    if (!options || !ts.isIdentifier(options.name)) {
        return context.contractError(
            declaration,
            `Expected ${factory} to take an options object.`,
        );
    }
    const record = options.name.text;
    const names: string[] = [];
    for (const statement of declaration.body?.statements ?? []) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declared of statement.declarationList.declarations) {
            const initializer = declared.initializer;
            if (
                !ts.isIdentifier(declared.name) ||
                !initializer ||
                !ts.isBinaryExpression(initializer) ||
                initializer.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionToken
            ) {
                continue;
            }
            // `a ?? b ?? c` parses as `(a ?? b) ?? c`, so the option's
            // own read sits at the BOTTOM of the left spine — the same
            // model `pinnedDefaultExpression` states for finding the
            // default at the top of it. Walking down keeps the two
            // readers agreeing about what counts as an option.
            let left = context.unwrapExpression(initializer.left);
            while (
                ts.isBinaryExpression(left) &&
                left.operatorToken.kind ===
                    ts.SyntaxKind.QuestionQuestionToken
            ) {
                left = context.unwrapExpression(left.left);
            }
            if (
                ts.isPropertyAccessExpression(left) &&
                ts.isIdentifier(left.expression) &&
                left.expression.text === record
            ) {
                names.push(declared.name.text);
            }
        }
    }
    if (names.length === 0) {
        context.contractError(
            declaration,
            `Expected ${factory} to resolve its options through '??'.`,
        );
    }
    return names;
}

/** The same, where the pin's own default is a flag rather than a number. */
export function pinnedMeshOptionFlag(
    modulePath: string,
    factory: string,
    local: string,
): boolean {
    const fallback = pinnedDefaultExpression(modulePath, factory, local);
    if (fallback.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (fallback.kind === ts.SyntaxKind.FalseKeyword) return false;
    return reader().contractError(
        fallback,
        `${modulePath}#${factory} resolves '${local}' to something this ` +
            "port does not read as a flag.",
    );
}

/**
 * A pinned function's own boolean parameter default.
 *
 * `enableThinInstanceGpuCulling(mesh, enabled = true)` states what an
 * omitted argument means in its declaration rather than through the `??`
 * the builders use, so an intrinsic folding that call site reads it here.
 * Same contract as the readers above: a pin that retunes the default moves
 * the emitted call with it, and a pin that renames the parameter fails
 * naming the one it no longer has.
 */
export function pinnedParameterFlag(
    modulePath: string,
    functionName: string,
    parameter: string,
): boolean {
    const context = reader();
    const { declaration } = context.functionDeclaration(
        modulePath,
        functionName,
    );
    const declared = declaration.parameters.find(
        (candidate) =>
            ts.isIdentifier(candidate.name) &&
            candidate.name.text === parameter,
    );
    const initializer = declared?.initializer;
    if (initializer?.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (initializer?.kind === ts.SyntaxKind.FalseKeyword) return false;
    return context.contractError(
        declared ?? declaration,
        `${modulePath}#${functionName} does not default '${parameter}' ` +
            "to a flag.",
    );
}

/**
 * `createTransformNode`'s own parameter defaults.
 *
 * A different read from the `??` one above, and the same question: the
 * factory takes a name and ten optional numbers — the TRS triple, the
 * rotation as a quaternion — so what an unparameterised node composes is
 * decided by the pinned declaration's own parameter initializers
 * (`createTransformNode(name, px = 0, ..., qw = 1, sx = 1, sy = 1, sz = 1)`).
 * Reading them means a pin that retunes one regenerates, and a pin that
 * reorders the list fails naming the parameter it no longer has.
 */
const transformNodeModule = "src/scene/transform-node.ts";
const transformNodeFactory = "createTransformNode";

/** The parameter list, in the pin's own order after the leading name. */
const transformParameters = [
    "px",
    "py",
    "pz",
    "qx",
    "qy",
    "qz",
    "qw",
    "sx",
    "sy",
    "sz",
] as const;

export type TransformNodeParameter =
    (typeof transformParameters)[number];

let transformDefaults:
    | ReadonlyMap<TransformNodeParameter, number>
    | undefined;

export function transformNodeDefaults(): ReadonlyMap<
    TransformNodeParameter,
    number
> {
    if (transformDefaults) return transformDefaults;
    const context = reader();
    const { file, declaration } = context.functionDeclaration(
        transformNodeModule,
        transformNodeFactory,
    );
    const name = declaration.parameters[0];
    if (
        !name ||
        !ts.isIdentifier(name.name) ||
        name.name.text !== "name"
    ) {
        context.contractError(
            name ?? declaration,
            "Expected createTransformNode to take a name first.",
        );
    }
    const defaults = new Map<TransformNodeParameter, number>();
    for (const [index, parameter] of transformParameters.entries()) {
        const declared = declaration.parameters[index + 1];
        const initializer = declared?.initializer;
        if (
            !declared ||
            !ts.isIdentifier(declared.name) ||
            declared.name.text !== parameter ||
            initializer === undefined
        ) {
            return context.contractError(
                declared ?? declaration,
                `Expected createTransformNode parameter '${parameter}' ` +
                    "with a default.",
            );
        }
        defaults.set(
            parameter,
            context.numericValue(initializer, file),
        );
    }
    transformDefaults = defaults;
    return defaults;
}
