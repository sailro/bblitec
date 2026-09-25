import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";
import { bufferAlignmentCpp } from "./gpu-buffer-adapters.js";

/** Allocation size and role flags from the pinned storage-buffer factory. */
export function storageBufferDescriptorCpp(context: LoweringContext): string {
    const path = "src/resource/storage-buffer.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "createStorageBuffer",
    );
    const statements = declaration.body!.statements;
    const declares = (node: ts.Statement, name: string): boolean =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
            (entry) => ts.isIdentifier(entry.name) && entry.name.text === name,
        );
    const start = statements.findIndex((node) => declares(node, "requested"));
    const end = statements.findIndex((node) => declares(node, "usage"));
    if (start < 0 || end < start)
        return context.contractError(
            declaration,
            "Storage allocation shape is missing.",
        );
    const bindings = new Map<string, PinnedBinding>([
        ["isByteLength", { cpp: "is_byte_length", type: "bool" }],
        ["source", { cpp: "requested_input", type: "scalar" }],
        ["source.byteLength", { cpp: "requested_input", type: "scalar" }],
        [
            "engine._device.limits.maxBufferSize",
            { cpp: "maximum_size", type: "scalar" },
        ],
        ...["writable", "vertex", "index", "indirect"].map(
            (name) => [name, { cpp: name, type: "bool" }] as const,
        ),
        ...["STORAGE", "VERTEX", "INDEX", "INDIRECT", "COPY_SRC"].map(
            (name) =>
                [
                    `BU.${name}`,
                    {
                        cpp: `static_cast<double>(pal::StorageBufferRole::${name.toLowerCase()})`,
                        type: "scalar",
                    },
                ] as const,
        ),
    ]);
    const calls = pinnedNumericMathCalls();
    calls.set("align", (args) => `storage_buffer_align(${args.join(", ")})`);
    calls.set(
        "Number.isSafeInteger",
        (args) => `js::number_is_safe_integer(${args.join(", ")})`,
    );
    const body = lowerPinnedBody(file, statements.slice(start, end + 1), {
        bindings,
        calls,

        callShapes: new Map([["Number.isSafeInteger", "bool"]]),
    });
    return `${bufferAlignmentCpp(context, "storage_buffer_align")}
// ${context.provenance(path, "createStorageBuffer")}
std::array<double,2> storage_buffer_shape(double requested_input,bool is_byte_length,double maximum_size,bool writable,bool vertex,bool index,bool indirect) {
${body}
    return {byteLength,usage};
}
`;
}
