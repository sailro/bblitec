import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

export const meshCpuStreamFields: ReadonlyMap<string, string> = new Map([
    ["_cpuPositions", "positions"],
    ["_cpuNormals", "normals"],
    ["_cpuUvs", "uvs"],
    ["_cpuUv2s", "uvs2"],
    ["_cpuTangents", "tangents"],
    ["_cpuColors", "colors"],
    ["_cpuIndices", "indices"],
]);

export const meshCpuStreamParameters =
    "const js::F32Array& positions, const js::F32Array& normals, const js::U32Array& indices, const std::optional<js::F32Array>& uvs, const std::optional<js::F32Array>& uvs2, const std::optional<js::F32Array>& tangents, const std::optional<js::F32Array>& colors";
const meshCpuStreamArguments =
    "positions, normals, indices, uvs, uvs2, tangents, colors";
const meshUploadedStreamArguments =
    "positions, normals, indices, retained_upload_stream(uvs), retained_upload_stream(uvs2), retained_upload_stream(tangents), retained_upload_stream(colors)";

/** The optional source capture hook retains additional aliases only while enabled. */
function lowerFactoryRecoveryCapture(context: LoweringContext): string {
    const module = "src/engine/device-lost-recovery-capture.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "attachRecoveryCapture",
    );
    const method = context.findNodes(
        declaration,
        (node): node is ts.MethodDeclaration =>
            ts.isMethodDeclaration(node) && node.name.getText(file) === "m",
    )[0];
    if (!method?.body)
        return context.contractError(
            declaration,
            "Expected mesh recovery capture hook.",
        );
    const bindings = new Map<string, PinnedBinding>([
        [
            "engine._deviceLostRecovery?._meshCaptureRefs",
            {
                cpp: '(engine.device_recovery && std::ranges::any_of(engine.device_recovery->registrations, [](const auto& registration) { return registration->kind == "scene"; }))',
                type: "bool",
            },
        ],
        ["gpuIndices", { cpp: "indices", type: "opaque" }],
        ["indexFormat", { cpp: 'std::string("uint32")', type: "string" }],
        ["mesh._cpuGpuIndices", { cpp: "retained.indices", type: "opaque" }],
        ["mesh._cpuIndexFormat", { cpp: "index_format", type: "string" }],
    ]);
    for (const [source, member] of [
        ["uv2s", "uvs2"],
        ["tangents", "tangents"],
        ["colors", "colors"],
    ] as const) {
        bindings.set(source, {
            cpp: member,
            type: "opaque",
            absentCpp: `!${member}`,
        });
        const field = [...meshCpuStreamFields].find(
            ([, value]) => value === member,
        )![0];
        bindings.set(`mesh.${field}`, {
            cpp: `retained.${member}`,
            type: "opaque",
        });
    }
    const factory = context.functionDeclaration(
        "src/mesh/mesh-factories.ts",
        "createMeshFromData",
    );
    const call = context.findNodes(
        factory.declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            node.expression.getText(factory.file) === "engine._dlr?.m",
    )[0];
    if (!call)
        return context.contractError(
            factory.declaration,
            "Expected data mesh recovery capture.",
        );
    context.assertExpressionShape(
        call,
        'engine._dlr?.m(mesh, uvs2 ?? null, tangents ?? null, colors ?? null, indices, "uint32")',
        "data mesh capture arguments",
    );
    return `// ${context.provenance(module, "attachRecoveryCapture", "mesh hook")}
void capture_factory_cpu_streams(Engine& engine, MeshCpuStreams& retained, const js::U32Array& indices, const std::optional<js::F32Array>& uvs2, const std::optional<js::F32Array>& tangents, const std::optional<js::F32Array>& colors) {
    [[maybe_unused]] std::string index_format;
${lowerPinnedBody(file, method.body.statements, {
    bindings,
    calls: new Map(),
    expression(node) {
        return node.kind === ts.SyntaxKind.NullKeyword
            ? "std::optional<js::F32Array>{}"
            : undefined;
    },
})}
}
`;
}

/** The source's CPU owner fields and optional predicates, over retained native arrays. */
export function lowerMeshCpuStreamRetainers(context: LoweringContext): string {
    const module = "src/mesh/mesh-factories.ts";
    return (
        ["createMeshFromData", "retainMeshGeometry"]
            .map((name) => {
                const { file, declaration } = context.functionDeclaration(
                    module,
                    name,
                );
                const bindings = new Map<string, PinnedBinding>();
                for (const field of meshCpuStreamFields.values()) {
                    bindings.set(field, { cpp: field, type: "opaque" });
                    if (["uvs", "uvs2", "tangents", "colors"].includes(field))
                        bindings.set(`${field}?.length`, {
                            cpp: `(${field} ? static_cast<double>(${field}->size()) : 0.0)`,
                            type: "scalar",
                        });
                }
                const lowerer = new PinnedNumericLowerer(file, {
                    bindings,
                    calls: new Map(),
                    expression(node) {
                        if (
                            node.kind === ts.SyntaxKind.NullKeyword ||
                            (ts.isIdentifier(node) && node.text === "undefined")
                        )
                            return "std::optional<js::F32Array>{}";
                        return undefined;
                    },
                });
                const writes: string[] = [];
                if (name === "createMeshFromData") {
                    for (const property of context.findNodes(
                        declaration,
                        (node): node is ts.PropertyAssignment =>
                            ts.isPropertyAssignment(node) &&
                            ts.isIdentifier(node.name) &&
                            meshCpuStreamFields.has(node.name.text),
                    )) {
                        const field = meshCpuStreamFields.get(
                            property.name.getText(file),
                        )!;
                        writes.push(
                            `    result->${field} = ${lowerer.expression(property.initializer)};`,
                        );
                    }
                } else {
                    for (const statement of declaration.body!.statements) {
                        if (
                            !ts.isExpressionStatement(statement) ||
                            !ts.isBinaryExpression(statement.expression)
                        )
                            continue;
                        const write = statement.expression;
                        if (
                            write.operatorToken.kind !==
                                ts.SyntaxKind.EqualsToken ||
                            !ts.isPropertyAccessExpression(write.left) ||
                            !ts.isIdentifier(write.left.expression) ||
                            write.left.expression.text !== "mesh"
                        )
                            continue;
                        const field = meshCpuStreamFields.get(
                            write.left.name.text,
                        );
                        if (field)
                            writes.push(
                                `    result->${field} = ${lowerer.expression(write.right)};`,
                            );
                    }
                }
                return `// ${context.provenance(module, name)}
std::shared_ptr<MeshCpuStreams> ${name === "createMeshFromData" ? "factory" : "replacement"}_cpu_streams(${meshCpuStreamParameters.replaceAll("const ", "[[maybe_unused]] const ")}) {
    auto result = std::make_shared<MeshCpuStreams>();
${writes.join("\n")}
    return result;
}`;
            })
            .join("\n") +
        `
${lowerFactoryRecoveryCapture(context)}
const std::vector<float>& retained_upload_stream(const std::optional<js::F32Array>& source) {
    static const std::vector<float> empty;
    return source ? static_cast<const std::vector<float>&>(*source) : empty;
}
MeshHandle create_retained_mesh_from_data(Engine& engine, const std::string& name, ${meshCpuStreamParameters}) {
    const auto mesh = create_mesh_from_data(engine, name, ${meshUploadedStreamArguments});
    handle_at(engine.meshes, mesh).cpu_streams = factory_cpu_streams(${meshCpuStreamArguments});
    capture_factory_cpu_streams(engine, *handle_at(engine.meshes, mesh).cpu_streams, indices, uvs2, tangents, colors);
    return mesh;
}
`
    );
}

export function retainedMeshResizeWrappers(): string {
    return [false, true]
        .map(
            (shared) => `
void resize_${shared ? "shared_" : ""}retained_mesh_geometry(Engine& engine, ${shared ? "std::span<const MeshHandle> meshes" : "MeshHandle mesh"}, ${meshCpuStreamParameters}) {
    resize_${shared ? "shared_" : ""}mesh_geometry(engine, ${shared ? "meshes" : "mesh"}, ${meshUploadedStreamArguments});
    ${shared ? "for (const auto mesh : meshes) " : ""}handle_at(engine.meshes, mesh).cpu_streams = replacement_cpu_streams(${meshCpuStreamArguments});
}
`,
        )
        .join("\n");
}
