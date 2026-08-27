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
