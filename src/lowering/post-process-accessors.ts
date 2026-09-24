import ts from "typescript";
import {
    postProcessComposite,
    postProcessEffect,
} from "../post-process-effects.js";
import { sharedPinnedContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

/** The composite's own scalar state used by one inline pass's writer. */
export interface CompositeScalarAccessor {
    property: string;
    effect: string;
    slot: number;
    getter: string;
    setter: string;
}

export function compositeScalarAccessors(
    intrinsic: string,
    properties: readonly string[],
    context = sharedPinnedContext(),
): CompositeScalarAccessor[] {
    const composite = postProcessComposite(intrinsic);
    if (!composite?.inlinePasses) return [];
    const { file, declaration } = context.functionDeclaration(
        composite.module,
        intrinsic,
    );
    const result: CompositeScalarAccessor[] = [];
    for (const effectName of Object.values(composite.inlinePasses.effects)) {
        const effect = postProcessEffect(effectName);
        if (!effect || effect.declaredIn !== intrinsic) continue;
        for (const [slot, param] of effect.params.entries()) {
            if (!properties.includes(param.path)) continue;
            if (
                param.owner ||
                typeof param.fallback !== "number" ||
                !/^[A-Za-z_$][\w$]*$/.test(param.path)
            )
                continue;
            const getters = context.findNodes(
                declaration,
                (node): node is ts.GetAccessorDeclaration =>
                    ts.isGetAccessorDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === param.path,
            );
            const setters = context.findNodes(
                declaration,
                (node): node is ts.SetAccessorDeclaration =>
                    ts.isSetAccessorDeclaration(node) &&
                    ts.isIdentifier(node.name) &&
                    node.name.text === param.path,
            );
            if (!getters.length || !setters.length) continue;
            const getter = getters[0]!;
            const setter = setters[0]!;
            const argument = setter.parameters[0]?.name;
            if (
                getters.length !== 1 ||
                setters.length !== 1 ||
                !getter.body ||
                !setter.body ||
                setter.parameters.length !== 1 ||
                !argument ||
                !ts.isIdentifier(argument)
            )
                return context.contractError(
                    declaration,
                    `Expected one scalar accessor pair for ${intrinsic}.${param.path}.`,
                );
            if (result.some((entry) => entry.property === param.path))
                context.contractError(
                    declaration,
                    `Composite scalar ${param.path} belongs to more than one inline pass.`,
                );
            const bindings = new Map([
                [
                    `params.${param.path}`,
                    { cpp: "parameter", type: "scalar" as const },
                ],
                [argument.text, { cpp: "value", type: "scalar" as const }],
            ]);
            result.push({
                property: param.path,
                effect: effectName,
                slot,
                getter: lowerPinnedBody(file, getter.body.statements, {
                    bindings,
                    calls: new Map(),
                    returnValue: (expression, lowerer) =>
                        expression
                            ? lowerer.expression(expression)
                            : context.contractError(
                                  getter,
                                  "Scalar getter must return a value.",
                              ),
                }),
                setter: lowerPinnedBody(file, setter.body.statements, {
                    bindings,
                    calls: new Map(),
                }),
            });
        }
    }
    return result;
}

export function compositeScalarFunction(
    index: number,
    property: string,
    write: boolean,
): string {
    return `${write ? "set" : "get"}_composite_post_process_${index}_${property}`;
}
