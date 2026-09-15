import type { LoweringContext } from "./context.js";
import type ts from "typescript";
import type { PinnedNumericLowerer } from "./pinned-numeric-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";

/** Matrix allocation and stores come from the pinned bodies; F32Array supplies JS storage identity. */
export function pinnedMat4CreateHeader(context: LoweringContext): string {
    const allocator = "src/math/_matrix-allocator.ts";
    const allocate = context.functionDeclaration(allocator, "allocateMat4").declaration;
    context.assertStatementShapes(allocate, allocate.body!.statements,
        "return (_allocate ?? _defaultAllocate)();", "Matrix allocator dispatch");
    const defaultAllocate = context.functionDeclaration(allocator, "_defaultAllocate").declaration;
    context.assertStatementShapes(defaultAllocate, defaultAllocate.body!.statements,
        "return new F32(16);", "Default matrix storage");
    const names = ["tx", "ty", "tz", "qx", "qy", "qz", "qw", "sx", "sy", "sz"];
    const numeric = (parameters: readonly string[]) => parameters.map(pinned => ({ pinned, cpp: pinned, kind: "number" as const }));
    const writer = lowerPinnedFunction(context, "src/math/compose-mat4-into-buffer.ts", "composeMat4IntoBuffer", [
        { pinned: "dst", cpp: "dst", kind: "mat4", cppType: "js::F32Array", mutableRecord: true },
        { pinned: "off", cpp: "off", kind: "number" }, ...numeric(names),
    ], { cppName: "compose_mat4_into_buffer", returns: "void", inline: true });
    const returned = (name: string) => ({
        type: "js::F32Array",
        value: (_lowerer: PinnedNumericLowerer, expression: ts.Expression | undefined): string => {
            if (!expression) return context.contractError(allocate, "Expected a matrix result.");
            context.assertExpressionShape(expression, name, "Matrix result identity");
            return name;
        },
    });
    const identity = lowerPinnedFunction(context, "src/math/create-identity-mat4.ts", "createIdentityMat4", [], {
        cppName: "create_identity_mat4", inline: true, returns: returned("m"),
        localStorage: [{ pinned: "m", initializer: "allocateMat4()", binding: { cpp: "m", type: "f32" }, declaration: "js::F32Array m(16);" }],
    });
    const compose = lowerPinnedFunction(context, "src/math/compose-mat4.ts", "composeMat4", numeric(names), {
        cppName: "compose_mat4", inline: true, returns: returned("out"),
        localStorage: [{ pinned: "out", initializer: "allocateMat4()", binding: { cpp: "out", type: "f32" }, declaration: "js::F32Array out(16);" }],
        calls: new Map([["composeMat4IntoBuffer", args => `compose_mat4_into_buffer(${args.join(", ")})`]]),
    });
    const translation = lowerPinnedFunction(context, "src/math/create-translation-mat4.ts", "createTranslationMat4", numeric(["x", "y", "z"]), {
        cppName: "create_translation_mat4", inline: true, returns: returned("out"),
        localStorage: [
            { pinned: "out", initializer: "createIdentityMat4()", binding: { cpp: "out", type: "f32" }, declaration: "js::F32Array out = create_identity_mat4();" },
            { pinned: "s", initializer: "out", binding: { cpp: "out", type: "f32" } },
        ],
    });
    return pinnedHeader(["<bblite/js_data.hpp>"], [writer, identity, compose, translation].join("\n\n"));
}
