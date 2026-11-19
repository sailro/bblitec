import ts from "typescript";
import type { LoweringServices } from "./lowering-services.js";
import type { Value } from "./types.js";
import { declaredSymbol, namedMember } from "./symbols.js";
import { isAsyncFunction, unwrapExpression, variableKind } from "./syntax.js";

/** The effect task methods scene code can read, bind and replace. */
export function isEffectTaskMethodName(
    name: string,
): name is "record" | "dispose" {
    return name === "record" || name === "dispose";
}

/** Task methods are native slots, never writable temporary callback values. */
export function isTaskMethodWrite(
    context: Pick<
        LoweringServices,
        "checker" | "compileValue" | "dataLowerer" | "probeEmission"
    >,
    target: ts.Expression,
): boolean {
    const member = namedMember(context.checker, unwrapExpression(target));
    if (
        !member ||
        (!isEffectTaskMethodName(member.name) && member.name !== "execute")
    )
        return false;
    return context.probeEmission(
        () =>
            context.dataLowerer.narrowOptional(
                context.compileValue(member.expression),
                member.expression,
            ).kind === "task",
        () => false,
    );
}

/** Base-interface storage erases the task kind; native dispatch checks it. */
export function requireEffectTaskMethodOwner(
    context: Pick<LoweringServices, "fail">,
    owner: Value,
    node: ts.Node,
): void {
    if (
        owner.renderTask ||
        owner.geometryTask ||
        owner.copyTask ||
        owner.postProcessTask ||
        owner.postProcessComposite ||
        owner.screenSpaceTask ||
        owner.ssaoTask
    )
        context.fail(
            node,
            "Task method wrappers require an effect render task.",
        );
}

/** Only a same-receiver bind, followed by an arrow calling that saved method. */
export function requireEffectTaskWrapper(
    context: Pick<LoweringServices, "checker" | "fail">,
    assignment: ts.BinaryExpression,
    owner: ts.Expression,
    method: "record" | "dispose",
): void {
    const receiver = unwrapExpression(owner);
    const wrapper = unwrapExpression(assignment.right);
    const receiverSymbol = ts.isIdentifier(receiver)
        ? declaredSymbol(context.checker, receiver)
        : undefined;
    const sameReceiver = (node: ts.Expression): boolean => {
        const value = unwrapExpression(node);
        return (
            receiverSymbol !== undefined &&
            ts.isIdentifier(value) &&
            receiverSymbol === declaredSymbol(context.checker, value)
        );
    };
    let callsOriginal = false;
    const visit = (node: ts.Node): void => {
        if (callsOriginal || ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) && node.arguments.length === 0) {
            const name = unwrapExpression(node.expression);
            const declaration = ts.isIdentifier(name)
                ? declaredSymbol(context.checker, name)?.valueDeclaration
                : undefined;
            if (
                declaration &&
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                variableKind(declaration) === "const" &&
                declaration.getSourceFile() === assignment.getSourceFile() &&
                declaration.end < assignment.pos
            ) {
                const binding = unwrapExpression(declaration.initializer);
                const bind = ts.isCallExpression(binding)
                    ? namedMember(context.checker, binding.expression)
                    : undefined;
                const saved =
                    bind && namedMember(context.checker, bind.expression);
                if (
                    ts.isCallExpression(binding) &&
                    bind?.name === "bind" &&
                    saved?.name === method &&
                    binding.arguments.length === 1 &&
                    sameReceiver(saved.expression) &&
                    sameReceiver(binding.arguments[0]!)
                )
                    callsOriginal = true;
            }
        }
        ts.forEachChild(node, visit);
    };
    if (
        ts.isArrowFunction(wrapper) &&
        wrapper.parameters.length === 0 &&
        !isAsyncFunction(wrapper)
    )
        visit(wrapper.body);
    if (!callsOriginal)
        context.fail(
            assignment,
            `Task.${method} replacement requires a synchronous zero-argument arrow calling a preceding const original = task.${method}.bind(task).`,
        );
}

/** Methods record bind groups and scene disposal releases their owned targets. */
export function reachEffectTaskMethod(
    context: Pick<LoweringServices, "reachFeature">,
    node: ts.Node,
): void {
    context.reachFeature("frame-graph:task-method-slots", node);
}
