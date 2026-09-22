import ts from "typescript";
import type { IntrinsicCallContext } from "./context.js";
import type { LoweringServices } from "../lowering-services.js";
import type { Value } from "../types.js";
import { argumentAt } from "../syntax.js";
import {
    computeUniformLayout,
    type ComputeUniformField,
} from "../../pinned-compute-uniform.js";
import { doubleLiteral, stringLiteral } from "../../cpp-literals.js";

export interface ComputeUniformIntrinsicContext
    extends IntrinsicCallContext, Pick<LoweringServices, "fail"> {}

export function compileComputeUniformIntrinsic(
    context: ComputeUniformIntrinsicContext,
    name: string,
    call: ts.CallExpression,
): Value | undefined {
    if (name !== "createComputeUniformLayout") return undefined;
    context.expectArgumentCount(call, 1, 1);
    const value = context.compileValue(argumentAt(call, 0));
    if (value.kind !== "tuple" || !value.tupleElements)
        return context.fail(
            call,
            "Compute uniform layouts require closed field declarations.",
        );
    const fields: ComputeUniformField[] = value.tupleElements.map((field) => {
        const name = field.recordProperties?.name?.staticString,
            type = field.recordProperties?.type?.staticString;
        if (name === undefined || type === undefined)
            return context.fail(
                call,
                "Compute uniform field names and types must be generation-known strings.",
            );
        return { name, type };
    });
    const result = computeUniformLayout(fields);
    context.reachFeature("compute:uniform-layout", call);
    const type = "std::shared_ptr<const bbl::ComputeUniformLayout>";
    if ("error" in result)
        return {
            kind: "compute-uniform-layout",
            dataType: { kind: "handle", handle: "compute-uniform-layout" },
            cpp: `([]() -> ${type} { throw std::runtime_error(${stringLiteral(result.error)}); })()`,
        };
    const entries = result.layout.fields.map(
        ([name, field]) =>
            `{${stringLiteral(name)}, {${stringLiteral(field.type)}, ${[field.offset, field.byteLength, field.elementCount, field.rowCount, field.columnStride, field.scalar, field.kind].map(doubleLiteral).join(", ")}}}`,
    );
    return {
        kind: "compute-uniform-layout",
        dataType: { kind: "handle", handle: "compute-uniform-layout" },
        cpp: `std::make_shared<const bbl::ComputeUniformLayout>(bbl::ComputeUniformLayout{${doubleLiteral(result.layout.byteLength)}, {${entries.join(", ")}}})`,
    };
}
