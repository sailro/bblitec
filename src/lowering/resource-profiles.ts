/** Table rows are composition identities, independent of native allocation order. */
export interface MeshProfileTable {
    /** Each scene mesh's row, then profiled glTF containers' rows. */
    sceneRows: readonly number[];
    staticRows: readonly number[];
    rowCount: number;
}

/**
 * Where one glTF document's composed rows start when containers load in a
 * generation-unknown order: its k-th loaded material takes PBR profile
 * `materials + k` and its j-th planned mesh takes mesh profile `meshes + j`.
 */
export interface GltfContainerProfile {
    output: string;
    materials: number;
    meshes: number;
}

/** The loader's lookup from a loaded document's path to its profile bases. */
export function gltfContainerProfilesCpp(
    profiles: readonly GltfContainerProfile[],
): string {
    const rows = profiles
        .map(
            (profile) =>
                `        {asset_path(${JSON.stringify(profile.output)}), ${profile.materials}u, ${profile.meshes}u},`,
        )
        .join("\n");
    return `struct GltfContainerProfile {
    std::string path;
    std::uint32_t materials;
    std::uint32_t meshes;
};

const GltfContainerProfile& gltf_container_profile(const std::string& path) {
    static const std::vector<GltfContainerProfile> profiles{
${rows}
    };
    for (const GltfContainerProfile& profile : profiles) {
        if (profile.path == path) return profile;
    }
    throw std::runtime_error("A glTF load names no generated container profile.");
}
`;
}

/**
 * The statements `create_engine` runs to hand the engine its composition
 * rows (`MeshCompositionRows`), before the program stores any mesh.
 */
export function meshCompositionRowsCpp(table: MeshProfileTable): string {
    const list = (rows: readonly number[]): string =>
        rows.map((row) => `${row}u`).join(", ");
    return `    engine.mesh_composition_rows.static_rows = {${list(table.staticRows)}};
    engine.mesh_composition_rows.profile_rows = {${list(table.sceneRows)}};
    engine.mesh_composition_rows.row_count = ${table.rowCount}u;
`;
}

/** The profile announcement a runtime creation site makes before its factory stores the mesh. */
export const meshProfileBeginCpp = `void begin_scene_mesh_profile(Engine& engine, std::uint32_t profile) {
    store_next_mesh_with_profile(engine, profile);
}
`;
