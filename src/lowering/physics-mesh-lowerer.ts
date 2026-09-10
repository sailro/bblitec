import ts from "typescript";
import type { LoweringContext } from "./context.js";

import { PinnedNumericLowerer, type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerMat4InvertCpp } from "./pinned-function-lowerer.js";

const modulePath = "src/physics/havok.ts";

const contracts = new Map([
    ["constructor", "this._collectIndices = collectIndices;"],
    ["addNodeMeshes", `
        const invRoot = mat4Invert(root.worldMatrix as Mat4);
        if (!invRoot) { throw new Error("Cannot create physics mesh shape from a singular root transform."); }
        const rootScale = mat4Scale(root.scaling.x, root.scaling.y, root.scaling.z);
        const rootToBody = mat4Multiply(rootScale, invRoot);
        this._addNodeMesh(root, rootToBody);
        if (includeChildren) { for (const child of root.children) { this._addDescendantMeshes(child, rootToBody); } }
        if (this._vertices.length === 0) { throw new Error("Cannot create physics mesh shape without vertex positions."); }
        if (this._collectIndices && this._indices.length === 0) { throw new Error("Cannot create physics mesh shape without triangle indices."); }
    `],
    ["getVertices", `const numObjects = this._vertices.length; const offset = hknp._malloc(numObjects * 4);
        new Float32Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._vertices); return { offset, numObjects };`],
    ["getTriangles", `const numObjects = this._indices.length; const offset = hknp._malloc(numObjects * 4);
        new Int32Array(hknp.HEAPU8.buffer, offset, numObjects).set(this._indices); return { offset, numObjects };`],
    ["freeBuffer", "hknp._free(buffer.offset);"],
    ["_addDescendantMeshes", `this._addNodeMesh(node, rootToBody);
        for (const child of node.children) { this._addDescendantMeshes(child, rootToBody); }`],
    ["_addNodeMesh", `
        if (!isMesh(node)) { return; }
        const positions = node._cpuPositions;
        if (!positions || positions.length === 0) { return; }
        const meshToBody = mat4Multiply(rootToBody, node.worldMatrix as Mat4);
        const indexOffset = this._vertices.length / 3;
        for (let i = 0; i < positions.length; i += 3) {
            transformPositionInto(this._vertices, meshToBody, positions[i]!, positions[i + 1]!, positions[i + 2]!);
        }
        if (!this._collectIndices) { return; }
        const indices = node._cpuIndices;
        if (!indices) { return; }
        for (let i = 0; i < indices.length; i += 3) {
            const a = indices[i]! + indexOffset;
            const b = indices[i + 1]! + indexOffset;
            const c = indices[i + 2]! + indexOffset;
            this._indices.push(c, b, a);
        }
    `],
]);

/** Scene-node and PAL storage projection of the pinned MeshAccumulator. */
export function lowerPhysicsMesh(context: LoweringContext): { helpers: string; source: string } {
    const file = context.sourceFile(modulePath);
    const owner = file.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "MeshAccumulator");
    if (!owner) context.contractError(file, "Physics MeshAccumulator class changed.");
    const fields = new Map([["_vertices", "[]"], ["_indices", "[]"], ["_collectIndices", undefined]]);
    if (owner.members.length !== fields.size + contracts.size) context.contractError(owner, "Physics MeshAccumulator member inventory changed.");
    const seen = new Set<string>();
    const parameters = new Map([
        ["constructor", "collectIndices"], ["addNodeMeshes", "root,includeChildren"],
        ["getVertices", "hknp"], ["getTriangles", "hknp"], ["freeBuffer", "hknp,buffer"],
        ["_addDescendantMeshes", "node,rootToBody"], ["_addNodeMesh", "node,rootToBody"],
    ]);
    for (const member of owner.members) {
        const name = ts.isConstructorDeclaration(member) ? "constructor" : member.name?.getText(file);
        if (!name || seen.has(name)) context.contractError(member, "Physics accumulator member identity changed.");
        seen.add(name);
        if (ts.isPropertyDeclaration(member) && fields.has(name!)) {
            const expected = fields.get(name!);
            if (expected && member.initializer) context.assertExpressionShape(member.initializer, expected, `Physics accumulator ${name} initialization`);
            else if (expected || member.initializer) context.contractError(member, `Physics accumulator ${name} initialization changed.`);
        } else if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) && member.body && contracts.has(name!)) {
            if (member.parameters.map(p => p.name.getText(file)).join(",") !== parameters.get(name) || member.parameters.some(p => p.initializer || p.questionToken || p.dotDotDotToken)) {
                context.contractError(member, `Physics accumulator ${name} parameters changed.`);
            }
            context.assertStatementShapes(member, member.body.statements, contracts.get(name!)!, `Physics accumulator ${name} traversal and PAL transport`);
        } else context.contractError(member, "Physics MeshAccumulator gained an unrepresented member.");
    }
    const meshTest = context.functionDeclaration(modulePath, "isMesh").declaration;
    context.assertStatementShapes(meshTest, meshTest.body!.statements, 'return "_gpu" in node && "_cpuPositions" in node;', "Physics mesh node representation");
    const transform = context.functionDeclaration(modulePath, "transformPositionInto").declaration;
    context.assertStatementShapes(transform, transform.body!.statements, `dst.push(
        m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
        m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
        m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);`, "Physics position projection");
    const bindings = new Map<string, PinnedBinding>([
        ["m", { cpp: "mesh_to_body", type: "f32" }],
        ...["x", "y", "z"].map(name => [name, { cpp: name, type: "scalar" as const }] as const),
    ]);
    const numeric = new PinnedNumericLowerer(file, { bindings, calls: new Map() });
    const statement = transform.body!.statements[0]! as ts.ExpressionStatement;
    const lanes = (statement.expression as ts.CallExpression).arguments.map(node => `static_cast<float>(${numeric.expression(node)})`);
    const scale = context.functionDeclaration("src/math/mat4-scale.ts", "mat4Scale");
    context.assertExpressionShape(context.variableInitializer(scale.declaration, "out"), "allocateMat4() as unknown as Mat4Storage", "Physics root scale allocation");

    const scaleBody = lowerPinnedBody(scale.file, scale.declaration.body!.statements, {
        bindings: new Map([...bindings].filter(([key]) => key !== "m").concat([["out", { cpp: "out", type: "f32", mutable: true }]])),
        calls: new Map(),
        returnValue: (expression) => {
            if (!expression) context.contractError(scale.declaration, "Physics scale return changed.");
            context.assertExpressionShape(expression, "out as unknown as Mat4", "Physics scale result");
            return "out";
        },
    });
    return {
        helpers: `
${lowerMat4InvertCpp(context)}
std::array<float, 16> physics_matrix_product(const std::array<float, 16>& a, const std::array<float, 16>& b) {
    std::array<float, 16> result{};
    mat4_multiply_into(result, 0, a, 0, b, 0);
    return result;
}
std::array<float, 16> physics_root_scale(double x, double y, double z) {
    std::array<float, 16> out{};
${scaleBody}
}
void append_physics_mesh_geometry(
    const Engine& engine, PhysicsNodeRef node, const std::array<float, 16>& root_to_body,
    bool include_children, bool collect_indices,
    std::vector<std::array<double, 3>>& positions, std::vector<std::uint32_t>& indices) {
    if (node.kind == PhysicsNodeKind::mesh) {
        const auto& record = engine.meshes.at(node.value);
        if (record.geometry < engine.geometries.size()) {
            const auto& geometry = engine.geometries.at(record.geometry);
            if (!geometry.vertices.empty()) {
                if (geometry.vertex_space != VertexSpace::local && !record.detached_imported_mesh) {
                    throw std::runtime_error("Physics mesh accumulation requires source-local geometry and a represented source world matrix.");
                }
                const auto mesh_to_body = physics_matrix_product(root_to_body, physics_node_world(engine, node));
                const std::uint32_t index_offset = static_cast<std::uint32_t>(positions.size());
                positions.reserve(positions.size() + geometry.vertices.size());
                for (const auto& vertex : geometry.vertices) {
                    const auto& position = record.detached_imported_mesh ? vertex.local_position : vertex.position;
                    const double x = position.x, y = position.y, z = position.z;
                    // getVertices writes through Float32Array before the PAL consumes its span.
                    positions.push_back({${lanes.join(", ")}});
                }
                if (collect_indices && !geometry.indices.empty()) {
                    if (geometry.topology != MeshTopology::triangles || geometry.indices.size() % 3) {
                        throw std::runtime_error("Physics mesh shape requires complete triangle indices.");
                    }
                    indices.reserve(indices.size() + geometry.indices.size());
                    for (std::size_t i = 0; i < geometry.indices.size(); i += 3) {
                        const auto a = geometry.indices[i] + index_offset;
                        const auto b = geometry.indices[i + (geometry.source_indices_reversed ? 2 : 1)] + index_offset;
                        const auto c = geometry.indices[i + (geometry.source_indices_reversed ? 1 : 2)] + index_offset;
                        indices.push_back(c); indices.push_back(b); indices.push_back(a);
                    }
                }
            }
        }
        if (include_children) for (const auto child : record.children) {
            append_physics_mesh_geometry(engine, physics_node(child), root_to_body, true, collect_indices, positions, indices);
        }
    } else if (include_children) {
        for (const auto& child : engine.transform_nodes.at(node.value).children) {
            std::visit([&](auto value) {
                append_physics_mesh_geometry(engine, physics_node(value), root_to_body, true, collect_indices, positions, indices);
            }, child);
        }
    }
}
`,
        source: `
std::array<float, 16> physics_node_world(const Engine& engine, PhysicsNodeRef node) {
    if (node.kind == PhysicsNodeKind::mesh) return mesh_world_matrix(engine, engine.meshes.at(node.value));
    if (node.value >= engine.transform_nodes.size()) throw std::runtime_error("Physics geometry requires a live node.");
    return transform_node_world(engine, TransformNodeHandle{node.value});
}
PhysicsShape create_physics_mesh_shape(
    PhysicsWorldHandle handle, PhysicsShapeType type, PhysicsNodeRef root, bool include_child_meshes) {
    const bool collect_indices = type == PhysicsShapeType::MESH;
    const Engine& engine = *physics_world_record(handle).engine;
    const auto inverse = mat4_invert(physics_node_world(engine, root));
    if (!inverse) throw std::runtime_error("Cannot create physics mesh shape from a singular root transform.");
    const auto& scale = root.kind == PhysicsNodeKind::mesh ? engine.meshes.at(root.value).scaling : engine.transform_nodes.at(root.value).scaling;
    const auto root_to_body = physics_matrix_product(physics_root_scale(scale.x, scale.y, scale.z), *inverse);
    std::vector<std::array<double, 3>> positions;
    std::vector<std::uint32_t> indices;
    append_physics_mesh_geometry(engine, root, root_to_body, include_child_meshes, collect_indices, positions, indices);
    if (positions.empty()) throw std::runtime_error("Cannot create physics mesh shape without vertex positions.");
    if (collect_indices) {
        if (indices.empty()) throw std::runtime_error("Cannot create physics mesh shape without triangle indices.");
        return PhysicsShape{pal::physics_shape_create_mesh(positions, indices)};
    }
    return PhysicsShape{pal::physics_shape_create_convex_hull(positions)};
}
`,
    };
}
