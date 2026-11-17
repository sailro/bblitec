import type ts from "typescript";
import { blendFactorByPin } from "../lowering/pinned-blend-table.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "./option-helpers.js";
import { staticTableOption, type TableOption } from "./table-options.js";
import type { CompiledBlendState } from "./types.js";

const blendFactor: TableOption = {
    table: blendFactorByPin,
    refusal: (factor) =>
        `Pinned blend uses factor '${factor}', which this runtime has no enumerator for.`,
    name: "blend factor",
    label: "blend_factor",
};

const blendOperation: TableOption = {
    table: { add: "add" },
    refusal: "A blend state supports the add operation only.",
    name: "blend operation",
    label: "blend_operation",
};

export interface BlendStateContext
    extends
        ObjectValidationContext,
        Pick<
            LoweringServices,
            "expectObjectLiteral" | "objectProperty" | "compileStringLiteral"
        > {}

/**
 * A descriptor's `GPUBlendState`: its color and alpha components replace
 * both defaults, a component's own defaults being `one`, `zero` and `add`.
 */
export function compileBlendState(
    context: BlendStateContext,
    expression: ts.Expression,
): CompiledBlendState {
    const object = context.expectObjectLiteral(expression);
    validateObjectProperties(
        context,
        object,
        ["color", "alpha"],
        "A blend state requires color and alpha components.",
    );
    const component = (side: "color" | "alpha"): [string, string] => {
        const value = context.objectProperty(object, side);
        if (!value) context.fail(object, `A blend state requires ${side}.`);
        const literal = context.expectObjectLiteral(value);
        validateObjectProperties(
            context,
            literal,
            ["operation", "srcFactor", "dstFactor"],
            "Blend components accept operation, srcFactor and dstFactor.",
        );
        const operation = context.objectProperty(literal, "operation");
        if (operation) staticTableOption(context, blendOperation, operation);
        const factor = (name: "srcFactor" | "dstFactor"): string => {
            const field = context.objectProperty(literal, name);
            return field
                ? staticTableOption(context, blendFactor, field)
                : name === "srcFactor"
                  ? "one"
                  : "zero";
        };
        return [factor("srcFactor"), factor("dstFactor")];
    };
    return [...component("color"), ...component("alpha")];
}
