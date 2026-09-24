/** Table rows are composition identities, independent of native allocation order. */
export interface MeshProfileTable {
    sceneRows: readonly number[];
    staticRows: readonly number[];
    rowCount: number;
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
