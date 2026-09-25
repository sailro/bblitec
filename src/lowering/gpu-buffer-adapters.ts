import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";

export function bufferAlignmentCpp(
    context: LoweringContext,
    name: string,
): string {
    const path = "src/resource/buffer-alignment.ts";
    const { file, declaration } = context.functionDeclaration(path, "align");
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map([
            ["n", { cpp: "n", type: "scalar" }],
            ["to", { cpp: "to", type: "scalar" }],
        ]),
        calls: new Map(),
        returnValue: (node, lowerer) =>
            node
                ? lowerer.expression(node)
                : context.contractError(
                      declaration,
                      "Buffer alignment must return a number.",
                  ),
    });
    return `// ${context.provenance(path, "align")}
inline double ${name}(double n,double to) {
${body}
}
`;
}

/** The PAL owns mapped bytes, COPY_DST transport and unmapping. */
export function assertMappedBufferAdapter(context: LoweringContext): void {
    const { declaration } = context.functionDeclaration(
        "src/resource/mapped-buffer.ts",
        "createMappedBuffer",
    );
    context.assertFunctionBodyShape(
        declaration,
        `{
        const buffer = engine._device.createBuffer({label, size: align(Math.max(data.byteLength, 4), 4), usage: usage | BU.COPY_DST, mappedAtCreation: true});
        new U8(buffer.getMappedRange()).set(new U8(data.buffer, data.byteOffset, data.byteLength));
        buffer.unmap();
        return buffer;
    }`,
        "Mapped buffer PAL allocation and upload",
    );
}
