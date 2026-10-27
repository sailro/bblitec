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
import {
    type LoweringContext,
    sharedPinnedContext,
} from "./lowering/context.js";
import { sourceFunctionName, writeSites } from "./compiler/syntax.js";
import {
    pinnedOptionFlag,
    pinnedOptionNumber,
} from "./lowering/pinned-option-defaults.js";

/**
 * One `const <local> = wrap(<options>.<local> ?? <number>)` fallback.
 *
 * A builder wraps that operator in whatever its own contract needs, and the
 * lowered body keeps the wrapper, so the read is the shared `wrapped`
 * placement: `diameterTop ?? diameter ?? 1` defaults to 1, not to
 * `diameter`.
 */
export function pinnedMeshOptionDefault(
    modulePath: string,
    factory: string,
    local: string,
): number {
    const context = sharedPinnedContext();
    const { file, declaration } = context.functionDeclaration(
        modulePath,
        factory,
    );
    return pinnedOptionNumber(context, declaration, { wrapped: local }, file);
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
    const context = sharedPinnedContext();
    const { declaration } = context.functionDeclaration(modulePath, factory);
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
            // model the shared `wrapped` placement states for finding the
            // default at the top of it. Walking down keeps the two
            // readers agreeing about what counts as an option.
            let left = context.unwrapExpression(initializer.left);
            while (
                ts.isBinaryExpression(left) &&
                left.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
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
    const context = sharedPinnedContext();
    const { declaration } = context.functionDeclaration(modulePath, factory);
    return pinnedOptionFlag(context, declaration, { wrapped: local });
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
    const context = sharedPinnedContext();
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
 * `createTransformNode`'s parameter defaults, wherever the pin states them.
 *
 * A different read from the `??` one above, and the same question: the
 * factory takes a name and ten optional numbers — the TRS triple, the
 * rotation as a quaternion — so what an unparameterised node composes is
 * decided by pinned parameter initializers. The factory forwards the ten,
 * unwritten and in order, down a chain of calls to the one declaration that
 * initializes them (`initSceneNodeTransform(node, px = 0, ..., sz = 1)`), so
 * the read follows that chain. A pin that retunes one regenerates; a pin
 * that reorders, writes or stops forwarding one fails naming it.
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

export type TransformNodeParameter = (typeof transformParameters)[number];

let transformDefaults: ReadonlyMap<TransformNodeParameter, number> | undefined;

export function transformNodeDefaults(): ReadonlyMap<
    TransformNodeParameter,
    number
> {
    if (transformDefaults) return transformDefaults;
    const context = sharedPinnedContext();
    let { declaration } = context.functionDeclaration(
        transformNodeModule,
        transformNodeFactory,
    );
    const name = declaration.parameters[0];
    if (!name || !ts.isIdentifier(name.name) || name.name.text !== "name") {
        context.contractError(
            name ?? declaration,
            "Expected createTransformNode to take a name first.",
        );
    }
    let first = 1;
    for (;;) {
        const declared = transformParameters.map((parameter, index) => {
            const candidate = declaration.parameters[first + index];
            return candidate &&
                ts.isIdentifier(candidate.name) &&
                candidate.name.text === parameter
                ? candidate
                : context.contractError(
                      candidate ?? declaration,
                      `Expected ${functionName(declaration)} parameter ` +
                          `'${parameter}' at position ${first + index}.`,
                  );
        });
        const initializers = declared.flatMap(({ initializer }) =>
            initializer ? [initializer] : [],
        );
        if (initializers.length === declared.length) {
            transformDefaults = new Map(
                transformParameters.map((parameter, index) => [
                    parameter,
                    context.numericValue(
                        initializers[index]!,
                        declaration.getSourceFile(),
                    ),
                ]),
            );
            return transformDefaults;
        }
        if (initializers.length > 0)
            context.contractError(
                declaration,
                `Expected ${functionName(declaration)} to default all of ` +
                    `${transformParameters.join(", ")} or none.`,
            );
        const forward = transformForward(context, declaration);
        ({ declaration } = context.functionOf(forward.callee));
        first = forward.first;
    }
}

function functionName(declaration: ts.FunctionDeclaration): string {
    return sourceFunctionName(declaration) ?? "<anonymous>";
}

/**
 * The one call through which a declaration without the defaults forwards
 * the ten parameters, unwritten, as consecutive arguments in pinned order.
 */
function transformForward(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
): { callee: ts.Identifier; first: number } {
    const names = new Set<string>(transformParameters);
    const forwards: { callee: ts.Identifier; first: number }[] = [];
    const visit = (node: ts.Node): void => {
        for (const site of writeSites(node))
            if (ts.isIdentifier(site.target) && names.has(site.target.text))
                context.contractError(
                    site.node,
                    `Expected ${functionName(declaration)} to forward ` +
                        `'${site.target.text}' unwritten.`,
                );
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const first = node.arguments.findIndex(
                (argument) =>
                    ts.isIdentifier(argument) &&
                    argument.text === transformParameters[0],
            );
            if (
                first >= 0 &&
                transformParameters.every((parameter, index) => {
                    const argument = node.arguments[first + index];
                    return (
                        argument !== undefined &&
                        ts.isIdentifier(argument) &&
                        argument.text === parameter
                    );
                })
            )
                forwards.push({ callee: node.expression, first });
        }
        ts.forEachChild(node, visit);
    };
    if (declaration.body) visit(declaration.body);
    const [forward, ...others] = forwards;
    return forward && others.length === 0
        ? forward
        : context.contractError(
              declaration,
              `Expected ${functionName(declaration)} to forward ` +
                  `${transformParameters.join(", ")} through exactly one call.`,
          );
}
