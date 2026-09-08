import type { LoweringContext } from "./context.js";

export const physicsViewerModule = "src/physics/physics-viewer.ts";

/** Body overlays retain the pin's membership and before-render lifecycle. */
export function lowerPhysicsViewer(context: LoweringContext): { header: string; source: string } {
    const factory = context.functionDeclaration(physicsViewerModule, "createPhysicsViewer").declaration;
    const options = factory.parameters[2]?.initializer;
    if (!options) context.contractError(factory, "Physics viewer options default changed.");
    context.assertExpressionShape(options, "{}", "Physics viewer options default");
    const debug = context.functionDeclaration("src/physics/havok.ts", "getPhysicsBodyDebugGeometry").declaration;
    context.assertStatementShapes(debug, debug.body!.statements, `
        const hknp = world._hknp;
        const shapeResult = hknp.HP_Body_GetShape(body._hkBody);
        const ok = hknp.Result?.RESULT_OK ?? 0;
        if (shapeResult[0] !== ok || !shapeResult[1]) { return { positions: new Float32Array(0), indices: new Uint32Array(0) }; }
        const geometryResult = hknp.HP_Shape_CreateDebugDisplayGeometry(shapeResult[1]);
        if (geometryResult[0] !== ok) { return { positions: new Float32Array(0), indices: new Uint32Array(0) }; }
        const geometryInfo = hknp.HP_DebugGeometry_GetInfo(geometryResult[1])[1];
        const positionsInPlugin = new Float32Array(hknp.HEAPU8.buffer, geometryInfo[0], geometryInfo[1] * 3);
        const indicesInPlugin = new Uint32Array(hknp.HEAPU8.buffer, geometryInfo[2], geometryInfo[3] * 3);
        const positions = positionsInPlugin.slice(0); const indices = indicesInPlugin.slice(0);
        hknp.HP_DebugGeometry_Release(geometryResult[1]); return { positions, indices };
    `, "Physics debug geometry PAL ownership, shape identity and geometry spans");
    for (const [name, body] of bodyContracts) {
        const { declaration } = context.functionDeclaration(physicsViewerModule, name);
        context.assertStatementShapes(declaration, declaration.body!.statements, body, `${name} body viewer lifecycle`);
    }
    const header = `
struct PhysicsViewer {
    Scene scene;
    PhysicsWorldHandle world;
    std::uint32_t material_variant;
    std::vector<PhysicsBody> bodies;
    std::vector<MeshHandle> meshes;
    js::Callback<void(float)> update;
    bool registered = false;
    PhysicsViewer(Scene source_scene, PhysicsWorldHandle source_world, std::uint32_t variant)
        : scene(std::move(source_scene)), world(source_world), material_variant(variant) {}
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(scene); visitor(update); }
};
using PhysicsViewerHandle = std::shared_ptr<PhysicsViewer>;
PhysicsViewerHandle create_physics_viewer(Scene scene, PhysicsWorldHandle world, std::uint32_t material_variant);
std::optional<MeshHandle> show_physics_body(const PhysicsViewerHandle& viewer, PhysicsBody body, std::uint32_t mesh_profile);
bool hide_physics_body(const PhysicsViewerHandle& viewer, PhysicsBody body);
void dispose_physics_viewer(const PhysicsViewerHandle& viewer);
`;
    const source = `
namespace {
void copy_physics_body_debug_transform(PhysicsBody body, Engine& engine, MeshHandle mesh) {
    const PhysicsNodePose pose = physics_node_pose(engine, body.node);
    MeshRecord& record = engine.meshes.at(mesh.value);
    record.position = pose.position;
    record.rotation_quaternion = pose.rotation;
    record.has_rotation_quaternion = true;
    record.scaling = Vec3{1.0f, 1.0f, 1.0f};
    mark_mesh_runtime_transform(engine, mesh);
}
void unregister_physics_viewer_update(PhysicsViewer& viewer) {
    if (!viewer.registered) return;
    auto& hooks = viewer.scene.before_render;
    const auto found = std::find(hooks.begin(), hooks.end(), viewer.update);
    if (found != hooks.end()) hooks.erase(found, found + 1);
    viewer.registered = false;
}
void register_physics_viewer_update(PhysicsViewer& viewer) {
    if (viewer.registered) return;
    viewer.scene.before_render.push_back(viewer.update);
    viewer.registered = true;
}
} // namespace

PhysicsViewerHandle create_physics_viewer(Scene scene, PhysicsWorldHandle world, std::uint32_t material_variant) {
    auto viewer = js::make_gc_shared<PhysicsViewer>(std::move(scene), world, material_variant);
    viewer->update = js::make_closure(viewer, [](const PhysicsViewerHandle& current, float) {
        Engine& engine = *physics_world_record(current->world).engine;
        for (std::size_t i = 0; i < current->bodies.size(); ++i) {
            copy_physics_body_debug_transform(current->bodies[i], engine, current->meshes[i]);
        }
    });
    return viewer;
}

std::optional<MeshHandle> show_physics_body(const PhysicsViewerHandle& viewer, PhysicsBody body, std::uint32_t mesh_profile) {
    for (const auto& shown : viewer->bodies) {
        if (shown.handle.value == body.handle.value) return std::nullopt;
    }
    const auto geometry = pal::physics_body_debug_geometry(body.handle);
    if (geometry.positions.empty() || geometry.indices.empty()) return std::nullopt;
    std::vector<std::uint32_t> lines(geometry.indices.size() * 2);
    std::size_t output = 0;
    for (std::size_t i = 0; i < geometry.indices.size(); i += 3) {
        const auto a = geometry.indices[i], b = geometry.indices[i + 1], c = geometry.indices[i + 2];
        lines[output++] = a; lines[output++] = b;
        lines[output++] = b; lines[output++] = c;
        lines[output++] = c; lines[output++] = a;
    }
    Engine& engine = *physics_world_record(viewer->world).engine;
    const std::vector<float> positions(geometry.positions.begin(), geometry.positions.end());
    const std::vector<float> normals(positions.size());
    const MeshHandle mesh = bind_scene_mesh_profile(engine,
        create_mesh_from_data(engine, "physicsBodyDebug", positions, normals, lines, {}, {}, {}, {}), mesh_profile);
    const MaterialHandle material = create_shader_material(engine, viewer->material_variant);
    engine.meshes.at(mesh.value).material = material;
    engine.meshes.at(mesh.value).pickable = false;
    engine.meshes.at(mesh.value).has_render_order = true;
    engine.meshes.at(mesh.value).render_order = 1000.0;
    copy_physics_body_debug_transform(body, engine, mesh);
    viewer->bodies.push_back(body);
    viewer->meshes.push_back(mesh);
    add_to_scene(viewer->scene, mesh);
    register_physics_viewer_update(*viewer);
    return mesh;
}

bool hide_physics_body(const PhysicsViewerHandle& viewer, PhysicsBody body) {
    const auto found = std::find_if(viewer->bodies.begin(), viewer->bodies.end(),
        [body](const PhysicsBody& shown) { return shown.handle.value == body.handle.value; });
    if (found == viewer->bodies.end()) return false;
    const auto index = static_cast<std::size_t>(found - viewer->bodies.begin());
    const MeshHandle mesh = viewer->meshes[index];
    viewer->bodies.erase(found);
    viewer->meshes.erase(viewer->meshes.begin() + static_cast<std::ptrdiff_t>(index));
    remove_from_scene(viewer->scene, mesh);
    if (viewer->bodies.empty()) unregister_physics_viewer_update(*viewer);
    return true;
}

void dispose_physics_viewer(const PhysicsViewerHandle& viewer) {
    while (!viewer->bodies.empty()) hide_physics_body(viewer, viewer->bodies.front());
    unregister_physics_viewer_update(*viewer);
}
`;
    return { header, source };
}

const bodyContracts: readonly (readonly [string, string])[] = [
    ["createPhysicsViewer", `const viewer: PhysicsViewer = {
        scene, world, _bodies: [], _meshes: [], _constraintMeshes: [], _constraintLines: [], _constraintDisks: [], _constraintArrowheads: [],
        _color: options.color ?? [1, 1, 1, 1], _registered: false, _update: () => { updatePhysicsViewer(viewer); },
    }; return viewer;`],
    ["showPhysicsBody", `
        for (let i = 0; i < viewer._bodies.length; i++) { if (viewer._bodies[i] === body) { return null; } }
        const geometry = getPhysicsBodyDebugGeometry(viewer.world, body);
        if (geometry.positions.length === 0 || geometry.indices.length === 0) { return null; }
        const lineIndices = createLineListIndices(geometry.indices);
        const normals = new Float32Array(geometry.positions.length);
        const debugMesh = createMeshFromData(viewer.scene.surface.engine, "physicsBodyDebug", geometry.positions, normals, lineIndices);
        debugMesh.material = createPhysicsDebugLineMaterial(viewer._color);
        debugMesh.pickable = false; debugMesh.renderOrder = 1000;
        copyBodyTransform(body, debugMesh);
        viewer._bodies.push(body); viewer._meshes.push(debugMesh);
        addToScene(viewer.scene, debugMesh); registerViewerUpdate(viewer); return debugMesh;
    `],
    ["hidePhysicsBody", `const index = viewer._bodies.indexOf(body);
        if (index < 0) { return false; } const mesh = viewer._meshes[index]!;
        viewer._bodies.splice(index, 1); viewer._meshes.splice(index, 1);
        removeFromScene(viewer.scene, mesh); unregisterViewerUpdateIfEmpty(viewer); return true;`],
    ["disposePhysicsViewer", `while (viewer._bodies.length > 0) { hidePhysicsBody(viewer, viewer._bodies[0]!); }
        while (viewer._constraintMeshes.length > 0) { removeFromScene(viewer.scene, viewer._constraintMeshes.pop()!); }
        viewer._constraintLines.length = 0; viewer._constraintDisks.length = 0; viewer._constraintArrowheads.length = 0;
        unregisterViewerUpdate(viewer);`],
    ["registerViewerUpdate", `if (viewer._registered) { return; } viewer.scene._beforeRender.push(viewer._update); viewer._registered = true;`],
    ["unregisterViewerUpdate", `if (!viewer._registered) { return; }
        const index = viewer.scene._beforeRender.indexOf(viewer._update);
        if (index >= 0) { viewer.scene._beforeRender.splice(index, 1); } viewer._registered = false;`],
    ["unregisterViewerUpdateIfEmpty", `if (viewer._bodies.length === 0 && viewer._constraintLines.length === 0 && viewer._constraintDisks.length === 0 && viewer._constraintArrowheads.length === 0) { unregisterViewerUpdate(viewer); }`],
    ["updatePhysicsViewer", `
        for (let i = 0; i < viewer._bodies.length; i++) { copyBodyTransform(viewer._bodies[i]!, viewer._meshes[i]!); }
        for (let i = 0; i < viewer._constraintLines.length; i++) { updateConstraintLine(viewer, viewer._constraintLines[i]!); }
        for (let i = 0; i < viewer._constraintDisks.length; i++) { updateConstraintDisk(viewer._constraintDisks[i]!); }
        for (let i = 0; i < viewer._constraintArrowheads.length; i++) { updateConstraintArrowhead(viewer._constraintArrowheads[i]!); }
    `],
    ["copyBodyTransform", `const node = body.node;
        mesh.position.set(node.position.x, node.position.y, node.position.z);
        mesh.rotationQuaternion.set(node.rotationQuaternion.x, node.rotationQuaternion.y, node.rotationQuaternion.z, node.rotationQuaternion.w);
        mesh.scaling.set(1, 1, 1);`],
    ["createLineListIndices", `const lines = new Uint32Array(triangleIndices.length * 2); let o = 0;
        for (let i = 0; i < triangleIndices.length; i += 3) {
            const a = triangleIndices[i]!; const b = triangleIndices[i + 1]!; const c = triangleIndices[i + 2]!;
            lines[o++] = a; lines[o++] = b; lines[o++] = b; lines[o++] = c; lines[o++] = c; lines[o++] = a;
        } return lines;`],
];
