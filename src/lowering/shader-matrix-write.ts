import type { LoweringContext } from "./context.js";

/** Matrix writes share the pin's ordinary uniform setter body. */
export function shaderMatrixWriteProvenance(context: LoweringContext): string {
    const module = "src/material/shader/shader-material.ts";
    const wrapper = context.functionDeclaration(
        module,
        "setShaderMatrix",
    ).declaration;
    context.assertStatementShapes(
        wrapper,
        wrapper.body!.statements,
        "setUniformValue(material, name, value);",
        "Matrix uniform writer",
    );
    return context.provenance(module, "setShaderMatrix");
}
