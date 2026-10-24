import ts from "typescript";
import { lowerPinnedBody } from "../lowering/pinned-body-lowerer.js";
import type { PinnedBinding } from "../lowering/pinned-numeric-lowerer.js";
import { contractError } from "../lowering/context.js";
import { pinnedMember } from "../pinned-program.js";

/** Preserve the application's complete upload helper; only its queue write is a PAL port. */
export function lowerThinInstanceUploadBody(
    declaration: ts.FunctionDeclaration,
    parameters: readonly [string, string, string],
    engine: string,
    mesh: string,
    matrices: string,
    count: string,
    pool: string,
): string {
    const [meshParameter, bufferParameter, countParameter] = parameters;
    const owner = `bbl::thin_instance_data(${pool})`;
    const bindings = new Map<string, PinnedBinding>([
        [`${meshParameter}.thinInstances`, { cpp: pool, type: "opaque" }],
        [countParameter, { cpp: count, type: "scalar" }],
        [
            `${bufferParameter}.buffer`,
            { cpp: `${matrices}.buffer()`, type: "opaque" },
        ],
        [
            `${bufferParameter}.byteOffset`,
            {
                cpp: `static_cast<double>(${matrices}.byte_offset())`,
                type: "scalar",
            },
        ],
        [
            `${meshParameter}.thinInstances._gpuBuffer`,
            {
                cpp: `${owner}.gpu_buffer`,
                type: "opaque",
                absentCpp: `!${owner}.gpu_buffer`,
            },
        ],
    ]);
    for (const [source, field] of [
        ["_version", "version"],
        ["_dirtyMin", "dirty_min"],
        ["_dirtyMax", "dirty_max"],
    ])
        bindings.set(`${meshParameter}.thinInstances.${source}`, {
            cpp: `${owner}.${field}`,
            type: "scalar",
        });
    const body = lowerPinnedBody(
        declaration.getSourceFile(),
        declaration.body!.statements,
        {
            bindings,
            calls: new Map(),
            expression(node, lowerer) {
                if (
                    !ts.isCallExpression(node) ||
                    pinnedMember(node.expression)?.name !== "writeBuffer"
                )
                    return undefined;
                const expected = [
                    `${owner}.gpu_buffer`,
                    "0.0",
                    `${matrices}.buffer()`,
                    `static_cast<double>(${matrices}.byte_offset())`,
                    `(${count} * 64.0)`,
                ];
                const actual = node.arguments.map((argument) =>
                    lowerer.expression(argument),
                );
                if (
                    actual.length !== expected.length ||
                    actual.some((value, index) => value !== expected[index])
                )
                    return contractError(
                        node,
                        "Direct thin-instance upload requires the pool buffer and the complete Float32Array byte range.",
                    );
                return `bbl::upload_thin_instance_matrices(${engine}, ${mesh}, ${matrices}, ${count})`;
            },
        },
    );
    return `([&]() {\n    const auto ${pool} = bbl::handle_at(${engine}.meshes, ${mesh}).thin_instances;\n${body}\n}())`;
}
