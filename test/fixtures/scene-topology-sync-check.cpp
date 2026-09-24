// The scene-frame synchronization both scene backends instantiate
// (pal_scene_synchronize.hpp) and the pass-camera resolution every pass
// resolves through (pal_pass_camera.hpp), linked against the generated
// upstream units and driven through recording backend hooks: the one step
// order, the uploads a topology change keeps, the vertex writes a transform
// does not make, the renderables' own delta, and the camera-less pass the pin
// renders with a null camera -- no transparent sort, zero pass matrices, a
// scene block kept as it was, no other scene's camera, a skipped geometry
// task, the scene's own clear colour and the pass viewport it sets.
#include "pal_scene_synchronize.hpp"

#include <algorithm>
#include <array>
#include <cassert>
#include <iostream>
#include <memory>
#include <numbers>
#include <optional>
#include <string>
#include <utility>
#include <vector>

// The free controls ask SDL which keys are down; none are.
const bool* SDL_GetKeyboardState(int* count) {
    static const bool none[1]{false};
    if (count)
        *count = 0;
    return none;
}

// The harness runs with no runtime trace requested.
std::string bbl::pal::environment_variable(const char*) { return {}; }

// The row sync's vertex write is compiled in, as a position-updating scene's.
static_assert(BBLITE_MESH_POSITION_UPDATE);

namespace {

using namespace bbl;
using namespace bbl::pal;

unsigned next_lease = 0;

/** One uploaded row; the rematch moves a lease and never copies one. */
struct Row {
    unsigned lease = 0;
    std::uint64_t position_version = 0;
    explicit Row(unsigned value) : lease(value) {}
    Row(Row&& other) noexcept
        : lease(std::exchange(other.lease, 0u)), position_version(other.position_version) {}
    Row& operator=(Row&& other) noexcept {
        assert(lease == 0);
        lease = std::exchange(other.lease, 0u);
        position_version = other.position_version;
        return *this;
    }
};

/** The per-row GPU writes `sync_plan_mesh_rows` asks for. */
struct RowWrites {
    unsigned blocks = 0, vertex_uploads = 0;
    std::vector<GpuVertex> vertices;
    void write_mesh_blocks(const Scene&, const upstream::RenderItem&, const MeshRecord&, Row&) {
        ++blocks;
    }
    void upload_vertices(Row&, const std::vector<GpuVertex>& uploaded) {
        ++vertex_uploads;
        vertices = uploaded;
    }
};

/** A backend whose every operation records the step it serves. */
struct Hooks {
    std::vector<std::string> steps;
    RowWrites rows;
    unsigned uploads = 0, releases = 0;
    SceneSyncOutcome settled{};
    const CameraRecord* text_camera = nullptr;
    bool capture_saw_topology = false;
    double sprite_delta_ms = -1.0, billboard_delta_ms = -1.0;

    void note(const char* step) { steps.emplace_back(step); }
    void update_sprites(double delta_ms) {
        note("sprites");
        sprite_delta_ms = delta_ms;
    }
    void release_mesh(Row& row) {
        assert(row.lease != 0);
        row.lease = 0;
        ++releases;
    }
    Row upload_mesh(const upstream::RenderItem&) {
        ++uploads;
        return Row{++next_lease};
    }
    void prune_shared_resources() { note("prune"); }
    void reject_unbuilt_family_growth(std::uint32_t) { note("families"); }
    std::size_t shared_shader_geometry_count() const { return 0; }
    std::size_t shared_shader_material_count() const { return 0; }
    void rebuild_task_draw_lists() { note("task lists"); }
    RowWrites& mesh_rows() {
        note("rows");
        return rows;
    }
    void publish_storage() { note("storage"); }
    void submit_uploads() { note("submit"); }
    void mark_uploaded() { note("uploaded"); }
    void settle_pass(const SceneSyncOutcome& outcome) {
        note("pass");
        settled = outcome;
    }
    void stream_bone_palettes() { note("palettes"); }
    void mark_capture(bool topology_updated) {
        note("capture");
        capture_saw_topology = topology_updated;
    }
    void update_clustered_lights(const SceneSyncOutcome&) { note("clusters"); }
    void update_text(const SceneSyncOutcome& outcome) {
        note("text");
        text_camera = outcome.pass.camera;
    }
    void upload_billboards(const SceneSyncOutcome&, double delta_ms) {
        note("billboards");
        billboard_delta_ms = delta_ms;
    }
    void upload_splats(const SceneSyncOutcome&) { note("splats"); }
    void capture_render_state() { note("render capture"); }
    void write_pass_blocks(const SceneSyncOutcome&) { note("pass blocks"); }
};

/** One scene's run state, as a backend's frame session keeps it. */
struct Run {
    Engine engine;
    Scene scene;
    upstream::RenderPlan render_plan;
    std::vector<upstream::RenderPlan> overlay_plans;
    std::vector<std::uint64_t> overlay_versions;
    std::vector<Row> meshes;
    std::vector<std::vector<Row>> overlay_meshes;
    std::uint64_t synced_topology = 0, synced_epoch = 0;
    std::uint32_t synced_families = 0;
    CameraTraceState trace;
    long frame = 0;

    Run() { engine.registered_scenes.push_back(std::make_shared<Scene>(scene)); }

    SceneSyncOutcome synchronize(Hooks& hooks) {
        SceneSyncState<Row> sync{engine,
                                 scene,
                                 ++frame,
                                 16.0,
                                 640,
                                 480,
                                 render_plan,
                                 overlay_plans,
                                 overlay_versions,
                                 meshes,
                                 overlay_meshes,
                                 synced_topology,
                                 synced_epoch,
                                 synced_families,
                                 trace};
        return synchronize_scene(sync, hooks);
    }
};

bool all_zero(const CameraPassMatrices& matrices) {
    const auto zero = [](const auto& lanes) {
        return std::all_of(lanes.begin(), lanes.end(), [](float lane) { return lane == 0.0f; });
    };
    return matrices.aspect == 0.0 && zero(matrices.view_projection) && zero(matrices.view) &&
           zero(matrices.projection) && zero(matrices.camera_position);
}

/** A camera on the origin's near side, looking down +Z. */
CameraRecord looking_down_z() {
    CameraRecord camera;
    camera.kind = CameraKind::arc_rotate;
    camera.alpha = -std::numbers::pi / 2.0;
    camera.beta = std::numbers::pi / 2.0;
    camera.radius = 1.0;
    camera.fov = 0.8;
    camera.near_plane = 0.1;
    camera.far_plane = 100.0;
    return camera;
}

bool same_color(const Color4& left, const Color4& right) {
    return left.r == right.r && left.g == right.g && left.b == right.b && left.a == right.a;
}

/**
 * The pass resolution: each scene's own pass renders through its own
 * camera and clears to its own colour, with no fallback to another scene's
 * camera; a task through its configured camera, else its scene's; a pass
 * without a camera builds the zero matrices and writes no scene block.
 */
void check_pass_resolution() {
    Engine engine;
    engine.cameras.push_back(looking_down_z());
    engine.cameras.push_back(looking_down_z());
    Scene base, layer;
    base.camera = CameraHandle{0};
    base.clear_color = Color4{0.25f, 0.5f, 0.75f, 1.0f};
    layer.clear_color = Color4{0.0f, 0.0f, 0.0f, 0.0f};
    assert(scene_pass_camera(engine, base) == &engine.cameras[0]);
    assert(scene_pass_camera(engine, layer) == nullptr);
    assert(same_color(scene_pass_clear_color(base), base.clear_color));
    assert(same_color(scene_pass_clear_color(layer), layer.clear_color));
    assert(geometry_pass_camera(engine, base) == &engine.cameras[0]);
    assert(!upstream::geometry_task_skips(geometry_pass_camera(engine, base)));
    assert(!geometry_pass_camera(engine, layer));
    assert(upstream::geometry_task_skips(geometry_pass_camera(engine, layer)));

    FrameTaskRecord task;
    task.source_scene = layer.state;
    assert(task_pass_camera(engine, task) == nullptr);
    assert(same_color(task_pass_clear_color(task), layer.clear_color));
    task.render.has_camera = true;
    task.render.camera = CameraHandle{1};
    task.render.clear_color = Color4{1.0f, 0.0f, 0.0f, 1.0f};
    assert(task_pass_camera(engine, task) == &engine.cameras[1]);
    assert(same_color(task_pass_clear_color(task), *task.render.clear_color));
    task.source_scene = base.state;
    task.render.has_camera = false;
    assert(task_pass_camera(engine, task) == &engine.cameras[0]);

    assert(upstream::pass_scene_block_skips(nullptr));
    assert(!upstream::pass_scene_block_skips(&engine.cameras[0]));
    const PassCamera none = build_pass_camera(layer, engine, nullptr, 640, 480);
    assert(!none.camera && all_zero(none.matrices));
    const PassCamera some = build_pass_camera(base, engine, &engine.cameras[0], 640, 480);
    assert(some.camera == &engine.cameras[0] && !all_zero(some.matrices));
    assert(some.matrices.aspect == 640.0 / 480.0);

    // `_applyCameraViewport`: nothing without a camera viewport, and the
    // pin's unclamped rectangle with one.
    assert(!upstream::pass_camera_viewport(nullptr, 640, 480));
    assert(!upstream::pass_camera_viewport(&engine.cameras[0], 640, 480));
    engine.cameras[1].viewport = NormalizedViewport{0.5, 0.0, 0.5, 1.0};
    const std::optional<PixelViewport> right =
        upstream::pass_camera_viewport(&engine.cameras[1], 640, 480);
    assert(right && right->x == 320 && right->y == 0 && right->width == 320 &&
           right->height == 480);
    engine.cameras[1].viewport = NormalizedViewport{-0.25, 0.0, 0.5, 1.0};
    const std::optional<PixelViewport> past =
        upstream::pass_camera_viewport(&engine.cameras[1], 640, 480);
    assert(past && past->x == -160 && past->width == 320);
    // A scene's own pass without a surface pane resolves the same rectangle.
    Scene own;
    own.camera = CameraHandle{1};
    const std::optional<PixelViewport> scene_pass =
        scene_camera_viewport(engine, own, &engine.cameras[1], 640, 480);
    assert(scene_pass && scene_pass->x == -160 && scene_pass->width == 320);
}

/**
 * The pass block the pin keeps (`task._sceneUBO`): written through a pass
 * camera, left as it was without one, zero until first written; one entry
 * per scene pass by identity and per frame task by handle.
 */
void check_retained_blocks() {
    using Block = std::array<float, 2>;
    const CameraRecord camera = looking_down_z();
    unsigned writes = 0;
    const auto writer = [&](const CameraRecord& written) {
        ++writes;
        return Block{static_cast<float>(written.radius), 1.0f};
    };
    RetainedBlock<Block> retained;
    assert(retained.write(nullptr, writer) == Block{} && writes == 0);
    assert(retained.write(&camera, writer) == (Block{1.0f, 1.0f}) && writes == 1);
    assert(retained.write(nullptr, writer) == (Block{1.0f, 1.0f}) && writes == 1);

    PassBlocks<RetainedBlock<Block>> blocks;
    Scene first, second;
    RetainedBlock<Block>& scene_block = blocks.scene(first);
    scene_block.write(&camera, writer);
    assert(&blocks.scene(first) == &scene_block && blocks.scene(second).block() == Block{});
    RetainedBlock<Block>& task_block = blocks.task(TaskHandle{3});
    task_block.write(&camera, writer);
    blocks.task(TaskHandle{40});
    assert(&blocks.task(TaskHandle{3}) == &task_block && task_block.block()[1] == 1.0f);
    assert(&blocks.pass(first, std::nullopt) == &scene_block);
    assert(&blocks.pass(first, TaskHandle{3}) == &task_block);
    // A disposed scene's entry goes with it: a later scene starts at zero.
    {
        Scene gone;
        blocks.scene(gone).write(&camera, writer);
    }
    Scene later;
    assert(blocks.scene(later).block() == Block{});
}

const std::vector<std::string> steady_steps{
    "sprites", "rows",     "storage", "submit",     "uploaded", "pass",           "palettes",
    "capture", "clusters", "text",    "billboards", "splats",   "render capture", "pass blocks"};

/**
 * A camera-less scene still runs every step, through a null pass; the
 * renderables' clocks step by the engine's `_currentDelta`, whatever the
 * scene's `fixedDeltaMs`.
 */
void check_camera_less_frame() {
    Run run;
    run.scene.fixed_delta_ms = 1000.0 / 60.0;
    run.engine.current_delta_ms = 7.25;
    Hooks hooks;
    const SceneSyncOutcome outcome = run.synchronize(hooks);
    assert(hooks.steps == steady_steps);
    assert(hooks.sprite_delta_ms == 7.25 && hooks.billboard_delta_ms == 7.25);
    assert(!outcome.topology_updated && !hooks.capture_saw_topology);
    assert(outcome.surface_extent.width == 640 && outcome.surface_extent.height == 480);
    assert(!outcome.pass.camera && !hooks.settled.pass.camera && !hooks.text_camera);
    assert(all_zero(outcome.pass.matrices) && all_zero(hooks.settled.pass.matrices));
}

/**
 * `sortTransparentBindings` returns without a camera: the list keeps the
 * order it was built in, and a camera sorts it back to front.
 */
void check_transparent_sort() {
    Run run;
    run.engine.meshes.resize(3);
    run.engine.meshes[0].position = {0, 0, 5};
    run.engine.meshes[1].position = {0, 0, 10};
    run.engine.meshes[2].position = {0, 0, 20};
    run.engine.meshes[2].visible = false;
    auto& transparent = run.render_plan.draw_lists.transparent;
    for (std::uint32_t index = 0; index < 3; ++index) {
        upstream::RenderDrawCommand command{};
        command.item.mesh = MeshHandle{index};
        command.item.order = index;
        command.item_index = index;
        transparent.visibility_candidates.push_back(command);
    }
    Hooks camera_less;
    run.synchronize(camera_less);
    // The hidden mesh leaves the drawn list whether or not the pass sorted.
    assert(transparent.commands.size() == 2 && transparent.commands[0].item.mesh.value == 0 &&
           transparent.commands[1].item.mesh.value == 1);
    run.engine.cameras.push_back(looking_down_z());
    run.scene.camera = CameraHandle{0};
    Hooks sorted;
    const SceneSyncOutcome outcome = run.synchronize(sorted);
    assert(outcome.pass.camera == &run.engine.cameras[0]);
    assert(sorted.text_camera == outcome.pass.camera && !all_zero(outcome.pass.matrices));
    assert(transparent.commands.size() == 2 && transparent.commands[0].item.mesh.value == 1 &&
           transparent.commands[1].item.mesh.value == 0);
}

/**
 * A topology change rebuilds the plan and keeps each surviving row's
 * upload; a moved visibility epoch rebuilds only the draw lists; a
 * transform uploads no vertices, and a position update uploads the
 * geometry's own lanes.
 */
void check_topology_and_rows() {
    next_lease = 0;
    Run run;
    run.engine.geometries.resize(1);
    ModelVertex vertex;
    vertex.position = {1, 2, 3};
    run.engine.geometries[0].vertices.push_back(vertex);
    run.engine.meshes.resize(4);
    for (MeshRecord& mesh : run.engine.meshes)
        mesh.geometry = 0;
    for (std::uint32_t index = 0; index < 3; ++index)
        run.scene.meshes.push_back(MeshHandle{index});
    ++run.scene.render_topology_version;
    Hooks built;
    const SceneSyncOutcome first = run.synchronize(built);
    assert(first.topology_updated && built.capture_saw_topology && built.uploads == 3);
    assert(run.meshes.size() == 3 && run.meshes[0].lease == 1 && run.meshes[2].lease == 3);
    assert(std::count(built.steps.begin(), built.steps.end(), "task lists") == 1);
    assert(built.rows.blocks == 3);

    // Remove the middle mesh and add another: the other two leases survive.
    run.scene.meshes = {MeshHandle{0}, MeshHandle{2}, MeshHandle{3}};
    ++run.scene.render_topology_version;
    Hooks rebuilt;
    run.synchronize(rebuilt);
    assert(rebuilt.uploads == 1 && rebuilt.releases == 1);
    assert(run.meshes.size() == 3 && run.meshes[0].lease == 1 && run.meshes[1].lease == 3 &&
           run.meshes[2].lease == 4);

    // A visibility epoch rebuilds the lists and the task lists, no rows.
    ++run.engine.draw_list_epoch;
    Hooks epoch;
    const SceneSyncOutcome moved = run.synchronize(epoch);
    assert(!moved.topology_updated && epoch.uploads == 0 && epoch.releases == 0);
    assert(std::count(epoch.steps.begin(), epoch.steps.end(), "task lists") == 1);
    assert(run.synced_epoch == run.engine.draw_list_epoch);
    Hooks steady;
    run.synchronize(steady);
    assert(steady.steps == steady_steps);

    // The first sync above uploaded every row's lanes once; a transform
    // reaches the draw through the mesh block alone.
    for (Row& row : run.meshes)
        row.position_version = run.engine.geometries[0].position_version;
    run.engine.meshes[0].position.x += 5;
    set_mesh_rotation_quaternion(run.engine, MeshHandle{0}, {0, 0.6f, 0, 0.8f});
    Hooks transformed;
    run.synchronize(transformed);
    assert(transformed.rows.vertex_uploads == 0 && transformed.rows.blocks == 3);
    run.engine.geometries[0].vertices[0].position = {4, 5, 6};
    ++run.engine.geometries[0].position_version;
    Hooks updated;
    run.synchronize(updated);
    assert(updated.rows.vertex_uploads == 3 && updated.rows.vertices.size() == 1);
    const GpuVertex& lane = updated.rows.vertices[0];
    assert(lane.position[0] == 4 && lane.position[1] == 5 && lane.position[2] == 6);
    Hooks settled;
    run.synchronize(settled);
    assert(settled.rows.vertex_uploads == 0);
}

} // namespace

int main() {
    check_pass_resolution();
    check_retained_blocks();
    check_camera_less_frame();
    check_transparent_sort();
    check_topology_and_rows();
    std::cout << "scene-topology-sync-check: ok\n";
}
