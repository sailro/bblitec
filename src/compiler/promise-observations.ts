import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import { programObservations } from "./program-observations.js";
import { declaredInDefaultLibrary, declarationOrigin } from "./symbols.js";
import { declaredContextualType, isTypeReference } from "./type-facts.js";
import { unwrapExpression, wrappedParent } from "./syntax.js";
import { ApplicationRealmRequired } from "./worker-modules.js";

type Context = Pick<
    LoweringServices,
    "checker" | "program" | "options" | "dataTypes"
>;

/** Await and async returns consume the promise's settlement, not its object. */
function adoptsPromise(expression: ts.Expression): boolean {
    let current = expression;
    for (;;) {
        const parent = wrappedParent(current);
        if (ts.isAwaitExpression(parent)) return true;
        if (
            (ts.isConditionalExpression(parent) &&
                unwrapExpression(parent.condition) !==
                    unwrapExpression(current)) ||
            (ts.isBinaryExpression(parent) &&
                unwrapExpression(parent.right) === unwrapExpression(current) &&
                [
                    ts.SyntaxKind.AmpersandAmpersandToken,
                    ts.SyntaxKind.BarBarToken,
                    ts.SyntaxKind.QuestionQuestionToken,
                ].includes(parent.operatorToken.kind))
        ) {
            current = parent;
            continue;
        }
        const owner = ts.isReturnStatement(parent)
            ? ts.findAncestor(parent, ts.isFunctionLike)
            : ts.isArrowFunction(parent) &&
                ts.isExpression(parent.body) &&
                unwrapExpression(parent.body) === unwrapExpression(current)
              ? parent
              : undefined;
        return (
            owner !== undefined &&
            ts.canHaveModifiers(owner) &&
            ts
                .getModifiers(owner)
                ?.some(
                    (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
                ) === true
        );
    }
}

/** Reached object observations need promises, even when their settlements are immediate. */
export function requireObservedPromise(
    context: Context,
    expression: ts.Expression,
): void {
    if (context.options.workers) return;
    const concrete = (type: ts.Type): ts.Type =>
        context.dataTypes.resolveTypeParameter(type);
    const promise = (type: ts.Type): boolean => {
        type = concrete(type);
        return type.isUnionOrIntersection()
            ? type.types.some(promise)
            : type.symbol?.name === "Promise" &&
                  declaredInDefaultLibrary(type.symbol);
    };
    const node = unwrapExpression(expression);
    const consumers = programObservations(context.program).identityConsumers;
    const observed = consumers.get(node);
    if (observed)
        for (const type of observed)
            if (promise(type)) throw new ApplicationRealmRequired();

    // TypeScript contextualizes adoption as T | PromiseLike<T>. That
    // PromiseLike arm is not an erased slot retaining the promise itself.
    if (
        promise(context.checker.getTypeAtLocation(node)) &&
        adoptsPromise(expression)
    )
        return;

    // An actual Promise crossing an erased slot must become owned before
    // its source type disappears. Broad slots elsewhere in the program do
    // not establish that this value reaches them.
    const expected =
        ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression)
            ? context.checker.getTypeAtLocation(expression)
            : declaredContextualType(context.checker, expression);
    if (!expected) return;
    const seen = new Map<ts.Type, Set<ts.Type | undefined>>();
    const erases = (source: ts.Type, target: ts.Type | undefined): boolean => {
        source = concrete(source);
        target = target && concrete(target);
        if (source === target) return false;
        const targets = seen.get(source);
        if (targets?.has(target)) return false;
        if (targets) targets.add(target);
        else seen.set(source, new Set([target]));
        if (promise(source)) return !target || !promise(target);
        if (source.isUnionOrIntersection())
            return source.types.some((member) => erases(member, target));
        if (target?.isUnionOrIntersection())
            return target.types.every((member) => erases(source, member));
        if ((source.flags & ts.TypeFlags.Object) === 0) return false;
        if (isTypeReference(source)) {
            const sourceArguments = context.checker.getTypeArguments(source);
            const targetArguments =
                target && isTypeReference(target)
                    ? context.checker.getTypeArguments(target)
                    : [];
            if (
                sourceArguments.some((argument, index) =>
                    erases(argument, targetArguments[index]),
                )
            )
                return true;
        }
        const declarations = source.symbol?.declarations;
        if (
            declarations?.some(
                (declaration) => declarationOrigin(declaration) !== "program",
            )
        )
            return false;
        if (
            source.getCallSignatures().length ||
            source.getConstructSignatures().length
        )
            return false;
        return context.checker.getPropertiesOfType(source).some((property) => {
            const targetProperty =
                target &&
                context.checker.getPropertyOfType(target, property.name);
            return erases(
                context.checker.getTypeOfSymbolAtLocation(property, node),
                targetProperty &&
                    context.checker.getTypeOfSymbolAtLocation(
                        targetProperty,
                        node,
                    ),
            );
        });
    };
    if (erases(context.checker.getTypeAtLocation(node), expected))
        throw new ApplicationRealmRequired();
}
