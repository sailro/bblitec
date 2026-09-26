import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";

const fields = new Map([
    ["_cpuPositions", "positions"], ["_cpuNormals", "normals"],
    ["_cpuUvs", "uvs"], ["_cpuUv2s", "uvs2"],
    ["_cpuTangents", "tangents"], ["_cpuColors", "colors"],
    ["_cpuIndices", "indices"],
]);

export const meshCpuStreamParameters = "const js::F32Array& positions, const js::F32Array& normals, const js::U32Array& indices, const std::optional<js::F32Array>& uvs, const std::optional<js::F32Array>& uvs2, const std::optional<js::F32Array>& tangents, const std::optional<js::F32Array>& colors";
export const meshCpuStreamArguments = "positions, normals, indices, uvs, uvs2, tangents, colors";
export const meshUploadedStreamArguments = "positions, normals, indices, retained_upload_stream(uvs), retained_upload_stream(uvs2), retained_upload_stream(tangents), retained_upload_stream(colors)";

/** The source's CPU owner fields and optional predicates, over retained native arrays. */
export function lowerMeshCpuStreamRetainers(context: LoweringContext): string {
    const module = "src/mesh/mesh-factories.ts";
    return ["createMeshFromData", "retainMeshGeometry"].map((name) => {
        const {file, declaration} = context.functionDeclaration(module, name);
        const bindings = new Map<string, PinnedBinding>();
        for (const field of fields.values()) {
            bindings.set(field, {cpp: field, type: "opaque"});
            if (["uvs", "uvs2", "tangents", "colors"].includes(field))
                bindings.set(`${field}?.length`, {cpp: `(${field} ? static_cast<double>(${field}->size()) : 0.0)`, type: "scalar"});
        }
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: new Map(),
            expression(node) {
                if (node.kind === ts.SyntaxKind.NullKeyword ||
                    (ts.isIdentifier(node) && node.text === "undefined"))
                    return "std::optional<js::F32Array>{}";
                return undefined;
            },
        });
        const writes: string[] = [];
        if (name === "createMeshFromData") {
            for (const property of context.findNodes(declaration, (node): node is ts.PropertyAssignment =>
                ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && fields.has(node.name.text))) {
                const field = fields.get(property.name.getText(file))!;
                writes.push(`    result->${field} = ${lowerer.expression(property.initializer)};`);
            }
        } else {
            for (const statement of declaration.body!.statements) {
                if (!ts.isExpressionStatement(statement) || !ts.isBinaryExpression(statement.expression)) continue;
                const write = statement.expression;
                if (write.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
                    !ts.isPropertyAccessExpression(write.left) ||
                    !ts.isIdentifier(write.left.expression) || write.left.expression.text !== "mesh") continue;
                const field = fields.get(write.left.name.text);
                if (field) writes.push(`    result->${field} = ${lowerer.expression(write.right)};`);
            }
        }
        return `// ${context.provenance(module, name)}
std::shared_ptr<MeshCpuStreams> ${name === "createMeshFromData" ? "factory" : "replacement"}_cpu_streams(${meshCpuStreamParameters.replaceAll("const ", "[[maybe_unused]] const ")}) {
    auto result = std::make_shared<MeshCpuStreams>();
${writes.join("\n")}
    return result;
}`;
    }).join("\n") + `
const std::vector<float>& retained_upload_stream(const std::optional<js::F32Array>& source) {
    static const std::vector<float> empty;
    return source ? static_cast<const std::vector<float>&>(*source) : empty;
}
MeshHandle create_retained_mesh_from_data(Engine& engine, const std::string& name, ${meshCpuStreamParameters}) {
    const auto mesh = create_mesh_from_data(engine, name, ${meshUploadedStreamArguments});
    handle_at(engine.meshes, mesh).cpu_streams = factory_cpu_streams(${meshCpuStreamArguments});
    return mesh;
}
`;
}

export function retainedMeshResizeWrappers(): string {
    return [false, true].map((shared) => `
void resize_${shared ? "shared_" : ""}retained_mesh_geometry(Engine& engine, ${shared ? "std::span<const MeshHandle> meshes" : "MeshHandle mesh"}, ${meshCpuStreamParameters}) {
    resize_${shared ? "shared_" : ""}mesh_geometry(engine, ${shared ? "meshes" : "mesh"}, ${meshUploadedStreamArguments});
    ${shared ? "for (const auto mesh : meshes) " : ""}handle_at(engine.meshes, mesh).cpu_streams = replacement_cpu_streams(${meshCpuStreamArguments});
}
`).join("\n");
}
