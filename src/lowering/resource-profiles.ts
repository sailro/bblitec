/** Table rows are composition identities, independent of native allocation order. */
export interface MeshProfileTable {
    sceneRows: readonly number[];
    staticRows: readonly number[];
    rowCount: number;
}

export function meshProfileBindingCpp(table: MeshProfileTable): string {
    return `namespace {
constexpr std::array<std::uint32_t, ${table.sceneRows.length}> scene_mesh_profile_rows{
    ${table.sceneRows.map((row) => `${row}u`).join(", ")}
};
constexpr std::array<std::uint32_t, ${table.staticRows.length}> static_mesh_profile_rows{
    ${table.staticRows.map((row) => `${row}u`).join(", ")}
};
}

MeshHandle bind_scene_mesh_profile(Engine& engine, MeshHandle mesh, std::uint32_t profile) {
    if (mesh.value >= engine.meshes.size() || profile >= scene_mesh_profile_rows.size()) {
        throw std::runtime_error("A runtime mesh names no generated composition profile.");
    }
    engine.meshes[mesh.value].composition_feature_row = scene_mesh_profile_rows[profile];
    return mesh;
}

`;
}
