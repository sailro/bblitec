#pragma once

/**
 * The navigation-toolset boundary.
 *
 * Like the rigid-body seam, this is a third-party library behind a fixed
 * entry-point list — and the list is upstream's own: the pinned
 * `src/navigation/navigation.ts` reaches Recast/Detour only through the
 * `@recast-navigation` wrapper this surface mirrors, and the wasm that
 * wrapper loads is compiled from the very recastnavigation sources the
 * native library links (the overlay port pins the wrapper's own fork
 * commit). Unlike physics, the two sides therefore run the *same*
 * algorithms: the navmesh a build produces and the answers queries give
 * are expected to match the browser reference up to float rounding, not
 * merely by trajectory.
 *
 * The functions below carry the wrapper's semantics exactly where they
 * add any: the solo-build pipeline is `generateSoloNavMesh`'s sequence
 * with its config defaults and unit transforms; the debug geometry is
 * the wrapper's detached-triangle flat-normal build with its reversed
 * stored winding; the raycast is `findNearestPoly` (±1 half-extents,
 * include-all filter) then `dtNavMeshQuery::raycast`, hit exactly when
 * `0 < t < 1`. Nothing generated names Recast — swapping the toolset is
 * dropping in a different translation unit.
 */

#include <cstdint>
#include <optional>
#include <vector>

namespace bbl::pal {

/** One navigation plugin: a navmesh, its query, and later a crowd. */
struct NavigationHandle {
    std::uint32_t value = 0;
};

/**
 * The build parameters a reached `createNavMesh` may carry. Absent
 * fields take the wrapper's `recastConfigDefaults` inside the build,
 * exactly as its `{...defaults, ...cfg}` spread does.
 */
struct NavMeshBuildParams {
    std::optional<double> cs;
    std::optional<double> ch;
    std::optional<double> walkable_slope_angle;
    std::optional<double> walkable_height;
    std::optional<double> walkable_climb;
    std::optional<double> walkable_radius;
    std::optional<double> max_edge_len;
    std::optional<double> max_simplification_error;
    std::optional<double> min_region_area;
    std::optional<double> merge_region_area;
    std::optional<double> max_verts_per_poly;
    std::optional<double> detail_sample_dist;
    std::optional<double> detail_sample_max_error;
};

/** One merged-geometry source: world-space positions, reversed winding
 *  already applied by the caller (the generated merge mirrors the
 *  wrapper's `_mergeMeshes`). */
struct NavMeshGeometry {
    std::vector<float> positions;
    std::vector<std::uint32_t> indices;
};

/** `createDebugNavMeshGeometry`'s detached-triangle result. */
struct NavDebugGeometry {
    std::vector<float> positions;
    std::vector<float> normals;
    std::vector<std::uint32_t> indices;
};

struct NavRaycastHit {
    bool hit = false;
    float x = 0.0f;
    float y = 0.0f;
    float z = 0.0f;
};

/** `createNavigationPluginAsync`: a fresh plugin slot. */
NavigationHandle navigation_create_plugin();

/**
 * The solo-navmesh build (`generateSoloNavMesh` semantics): bounds from
 * the indexed positions, the wrapper's defaults and unit transforms,
 * the sample build sequence, area/flag normalization, and the query
 * (2048 nodes, include-all filter). Throws with the wrapper's own
 * failure spelling when a stage fails.
 */
void navigation_create_solo_nav_mesh(
    NavigationHandle plugin,
    const NavMeshGeometry& geometry,
    const NavMeshBuildParams& params);

/** The wrapper's detail-mesh walk + detached-triangle rebuild. */
NavDebugGeometry navigation_debug_geometry(NavigationHandle plugin);

/** `raycast(plugin, start, end)`: hit iff `0 < t < 1`, point lerped. */
NavRaycastHit navigation_raycast(
    NavigationHandle plugin,
    float start_x, float start_y, float start_z,
    float end_x, float end_y, float end_z);

} // namespace bbl::pal
