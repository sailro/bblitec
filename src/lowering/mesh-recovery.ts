import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { meshCpuStreamFields } from "./mesh-cpu-streams.js";
import { lowerMeshAttributeCapacities } from "./mesh-attribute-capacities.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/** Retained data uploads use the pin's eligibility and attribute-presence predicates. */
export function lowerRetainedMeshRecovery(context: LoweringContext): string {
    const module = "src/engine/recovery-rebuild.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "_rebuildMeshes",
    );
    const loop = declaration.body!.statements.find(ts.isForOfStatement);
    const guard =
        loop && ts.isBlock(loop.statement)
            ? loop.statement.statements[0]
            : undefined;
    if (!guard || !ts.isIfStatement(guard))
        return context.contractError(
            declaration,
            "Expected retained mesh eligibility before recovery uploads.",
        );
    const bindings = new Map<string, PinnedBinding>();
    for (const [field, member] of meshCpuStreamFields) {
        const stream = `retained.${member}`;
        for (const name of [`mesh.${field}`, member]) {
            bindings.set(name, {
                cpp: stream,
                type: "opaque",
                absentCpp: `!${stream}`,
            });
            bindings.set(`${name}.length`, {
                cpp: `static_cast<double>(${stream}.size())`,
                type: "scalar",
            });
        }
    }
    const boolean = (expression: ts.Expression): string => {
        const numeric = new PinnedNumericLowerer(file, {
            bindings,
            calls: new Map(),
        });
        numeric.bindPorts(bindings, expression);
        return numeric.expression(
            ts.factory.createConditionalExpression(
                expression,
                undefined,
                ts.factory.createTrue(),
                undefined,
                ts.factory.createFalse(),
            ),
        );
    };
    const { declaration: upload } = context.functionDeclaration(
        module,
        "uploadRetainedMesh",
    );
    const returned = upload.body!.statements.find(
        ts.isReturnStatement,
    )?.expression;
    if (!returned || !ts.isObjectLiteralExpression(returned))
        return context.contractError(
            upload,
            "Expected a fresh retained mesh GPU record.",
        );
    const flags = new Map([
        ["hasUv", "has_uvs"],
        ["hasUv2", "cpu_uv2s"],
        ["hasTangent", "has_tangents"],
        ["hasColor", "has_vertex_colors"],
    ]);
    const writes: string[] = [];
    for (const [name, member] of flags) {
        const property = returned.properties.find(
            (item) =>
                ts.isPropertyAssignment(item) &&
                item.name.getText(file) === name,
        );
        if (!property || !ts.isPropertyAssignment(property))
            return context.contractError(
                returned,
                `Expected retained ${name} predicate.`,
            );
        writes.push(
            `    replacement.${member} = ${boolean(property.initializer)};`,
        );
    }
    return `${lowerMeshAttributeCapacities(context, true)}
// ${context.provenance(module, "_rebuildMeshes, uploadRetainedMesh")}
static void recover_retained_mesh(Engine& engine, MeshHandle mesh) {
    auto& record = handle_at(engine.meshes, mesh);
    const auto old = record.geometry;
    // Imported interleaved resources retain their existing transport path.
    // This boundary owns source data factories and their GPU-only writes.
    const auto& previous = engine.geometries.at(old);
    if (!previous.owned_packed_geometry) return;
    const MeshCpuStreamsView retained(record, &previous);
    if (!(${boolean(guard.expression)})) return;
    // Preserve mesh metadata without copying buffers the new upload replaces.
    ModelGeometry replacement;
    replacement.owned_packed_geometry = previous.owned_packed_geometry;
    replacement.attribute_capacities = recovered_mesh_attribute_capacities(
        static_cast<double>(retained.positions.size()), static_cast<double>(retained.normals.size()),
        ${["uvs", "uvs2", "tangents", "colors"].map((stream) => `retained.${stream} ? std::optional<double>{static_cast<double>(retained.${stream}.size())} : std::nullopt`).join(",\n        ")});
    replacement.source_indices_reversed = previous.source_indices_reversed;
    replacement.morph_positions = previous.morph_positions;
    replacement.morph_bounds = previous.morph_bounds;
    replacement.morph_normals = previous.morph_normals;
    replacement.morph_tangents = previous.morph_tangents;
    replacement.topology = previous.topology;
    replacement.bounds_min = previous.bounds_min;
    replacement.bounds_max = previous.bounds_max;
    replacement.vertices = pal::pack_mesh_vertices(
        retained.positions.copy(), retained.normals.copy(),
        retained.uvs ? retained.uvs.copy() : std::vector<float>{},
        retained.uvs2 ? retained.uvs2.copy() : std::vector<float>{},
        retained.tangents ? retained.tangents.copy() : std::vector<float>{},
        retained.colors ? retained.colors.copy() : std::vector<float>{});
    replacement.indices = retained.indices.copy_raw();
${writes.join("\n")}
    replacement.cpu_tangents = replacement.has_tangents;
    replacement.cpu_colors = replacement.has_vertex_colors;
    // uploadRetainedMesh returns a fresh wrapper, not the clone's old count.
    // CPU owners and bounds remain the mesh's original source objects.
    replacement.owners = 1;
    replacement.attribute_version = previous.attribute_version + 1;
    const auto next = store_geometry_record(engine, std::move(replacement));
    record.geometry = next;
    if (--engine.geometries.at(old).owners == 0) release_unowned_geometry(engine, old);
}
static void recover_retained_meshes(Engine& engine) {
    for (const auto& scene : engine.scenes()) {
        if (scene->state->disposed) continue;
        for (const auto mesh : scene->meshes) recover_retained_mesh(engine, mesh);
        ++scene->render_topology_version;
    }
}
`;
}
