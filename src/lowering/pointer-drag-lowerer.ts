/** The pinned axis/plane dispatcher, with source-translated drag arithmetic.
 * Native handles replace DOM identities; event delivery and synchronous GPU
 * readback are platform seams. Canvas proxies keep their source listeners.
 */
import ts from "typescript";
import { objectProperty } from "../compiler/syntax.js";
import type { LoweringContext } from "./context.js";
import {
    lowerMat4InvertCpp,
    lowerPinnedFunction,
} from "./pinned-function-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCallsWithHypot } from "./pinned-operators.js";
import { lowerRotationPointerDrag } from "./rotation-pointer-drag-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

const POINTER = "src/gizmo/pointer-drag.ts";
const MATH = "src/gizmo/gizmo-math.ts";

export function lowerPointerDrag(
    context: LoweringContext,
    rotation = false,
): string {
    const calls = new Map(pinnedNumericMathCallsWithHypot());
    const materialFactory = context.functionDeclaration(
        "src/gizmo/gizmo-core.ts",
        "createGizmoMaterials",
    ).declaration;
    const hoverColor = context.numericTuple(
        materialFactory.parameters[1]!.initializer!,
        materialFactory.getSourceFile(),
    );
    calls.set(
        "normalizeVec3Obj",
        (args) => `normalize_vec3(${args.join(", ")})`,
    );
    calls.set("dotVec3", (args) => `drag_dot(${args.join(", ")})`);
    const vector = (cpp: string): PinnedBinding => ({ cpp, type: "vec3" });
    const vec3Literal = (x: string, y: string, z: string): string =>
        `Vec3d{${x}, ${y}, ${z}}`;
    const parameters = (names: string[]) =>
        names.map((name) => ({
            pinned: name,
            kind: "record" as const,
            cpp: name,
            cppType: "Vec3d",
            annotation: "Vec3",
            binding: vector(name),
        }));
    const dot = lowerPinnedFunction(
        context,
        "src/math/dot-vec3.ts",
        "dotVec3",
        parameters(["a", "b"]),
        { cppName: "drag_dot", calls, returns: "double" },
    );
    const ray = context.functionDeclaration(MATH, "rayPlaneIntersect");
    const rayLowerer: PinnedNumericLowerer = new PinnedNumericLowerer(
        ray.file,
        {
            bindings: new Map(
                ["rayOrigin", "rayDir", "planePoint", "planeNormal"].map(
                    (name) => [name, vector(name)],
                ),
            ),
            calls,
            vec3Literal,
            returnValue: (expression) =>
                expression?.kind === ts.SyntaxKind.NullKeyword
                    ? "std::nullopt"
                    : rayLowerer.expression(expression!),
        },
    );
    const normal = context.functionDeclaration(POINTER, "pickDragPlaneNormal");
    const normalStart = normal.declaration.body!.statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations[0]?.name.getText(
                normal.file,
            ) === "dx",
    );
    if (normalStart < 0)
        context.contractError(
            normal.declaration,
            "Missing camera-facing drag plane arithmetic.",
        );
    const normalLowerer: PinnedNumericLowerer = new PinnedNumericLowerer(
        normal.file,
        {
            bindings: new Map(
                ["camPos", "ref", "axis"].map((name) => [name, vector(name)]),
            ),
            calls,
            vec3Literal,
            returnValue: (expression) => normalLowerer.expression(expression!),
        },
    );
    const move = context.functionDeclaration(POINTER, "handlePointerMove");
    const statements = [...move.declaration.body!.statements];
    const begin = statements.findIndex(
        (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations[0]?.name.getText(
                move.file,
            ) === "delta",
    );
    const end = statements.findIndex(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            statement.expression.left.getText(move.file) ===
                "active.lastPlanePoint",
    );
    if (begin < 0 || end <= begin)
        context.contractError(
            move.declaration,
            "Missing pinned drag delta/projection slice.",
        );
    const planeIndex = statements.findIndex(
        (statement) =>
            ts.isIfStatement(statement) &&
            context
                .propertyPath(
                    ts.isBinaryExpression(statement.expression)
                        ? statement.expression.left
                        : statement.expression,
                )
                ?.join(".") === "active.drag.options.updateDragPlane",
    );
    if (planeIndex <= begin || planeIndex >= end)
        context.contractError(
            move.declaration,
            "Missing pinned drag plane update.",
        );
    const planeUpdate = statements[planeIndex]!;
    const planeLowerer = new PinnedNumericLowerer(move.file, {
        bindings: new Map<string, PinnedBinding>([
            [
                "active.drag.options.updateDragPlane",
                { cpp: "drag.update_drag_plane", type: "bool" },
            ],
            [
                "active.drag.options.dragPlaneNormal",
                { ...vector("axis"), absentCpp: "!drag.plane_drag" },
            ],
            ["active.planeNormal", vector("state.plane_normal")],
            ["active.planePoint", vector("state.plane_point")],
            ["active.drag", { cpp: "drag", type: "opaque" }],
            ["state.layer.scene", { cpp: "state", type: "opaque" }],
            ["hit", vector("hit")],
            ["livePlanePoint", vector("livePlanePoint")],
        ]),
        calls: new Map([
            ...calls,
            [
                "pickDragPlaneNormal",
                (args) => `drag_plane(${args[1]}, ${args[0]}, ${args[2]})`,
            ],
        ]),
        expression: (expression) => {
            if (
                ts.isCallExpression(expression) &&
                context.propertyPath(expression.expression)?.join(".") ===
                    "active.drag.options.getPlanePoint"
            ) {
                context.assertExpressionShape(
                    expression,
                    "active.drag.options.getPlanePoint?.()",
                    "Pointer drag plane anchor callback",
                );
                return "drag_anchor(*state.engine, drag)";
            }
            return undefined;
        },
        statement: (statement, lowerer, indent) => {
            if (
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations[0]?.name.getText(
                    move.file,
                ) === "livePlanePoint"
            ) {
                context.assertStatementShapes(
                    statement,
                    [statement],
                    "const livePlanePoint = active.drag.options.getPlanePoint?.();",
                    "Pointer drag live anchor",
                );
                return [
                    `${indent}const Vec3d livePlanePoint = ${lowerer.expression(statement.declarationList.declarations[0].initializer!)};`,
                ];
            }
            return undefined;
        },
        vec3Literal,
    });
    // Every native pointer gizmo supplies its root position as the live anchor.
    // Read each factory's update option; absent options retain the source default.
    const updatesPlane = (modulePath: string, factory: string): string => {
        const declaration = context.functionDeclaration(
            modulePath,
            factory,
        ).declaration;
        const call = context.callExpression(declaration, "createPointerDrag");
        if (call.arguments.length !== 1)
            return context.contractError(
                call,
                "Expected one pointer drag options argument.",
            );
        const options = context.callObjectArgument(call, "createPointerDrag");
        const anchor = objectProperty(options, "getPlanePoint");
        if (!anchor)
            return context.contractError(
                options,
                "Native gizmos require a live root anchor.",
            );
        context.assertExpressionShape(
            anchor,
            "() => ({ x: root.position.x, y: root.position.y, z: root.position.z })",
            "Pointer gizmo anchor",
        );
        const update = objectProperty(options, "updateDragPlane");
        if (!update) return "true";
        if (update.kind === ts.SyntaxKind.TrueKeyword) return "true";
        if (update.kind === ts.SyntaxKind.FalseKeyword) return "false";
        return context.contractError(
            update,
            "Expected literal pointer plane update option.",
        );
    };
    const axisUpdates = updatesPlane(
        "src/gizmo/axis-drag-gizmo.ts",
        "createAxisDragGizmo",
    );
    const planeUpdates = updatesPlane(
        "src/gizmo/plane-drag-gizmo.ts",
        "createPlaneDragGizmo",
    );
    if (
        rotation &&
        updatesPlane(
            "src/gizmo/plane-rotation-gizmo.ts",
            "createPlaneRotationGizmo",
        ) !== planeUpdates
    )
        context.contractError(
            move.declaration,
            "Rotation and plane gizmos need distinct update profiles.",
        );
    const moveLowerer = new PinnedNumericLowerer(move.file, {
        bindings: new Map([
            ["hit", vector("hit")],
            ["axis", { ...vector("axis"), absentCpp: "!axis_mode" }],
            ["active.lastPlanePoint", vector("last")],
            ["active.startPlanePoint", vector("start")],
            ...["x", "y", "z"].flatMap(
                (component): [string, PinnedBinding][] => [
                    [
                        `active.lastPlanePoint.${component}`,
                        { cpp: `last.${component}`, type: "scalar" },
                    ],
                    [
                        `active.startPlanePoint.${component}`,
                        { cpp: `start.${component}`, type: "scalar" },
                    ],
                ],
            ),
        ]),
        calls,
        vec3Literal,
    });
    const local = context.functionDeclaration(MATH, "worldDeltaToLocal");
    const localReturn = local.declaration.body!.statements.at(-1)!;
    if (!ts.isReturnStatement(localReturn))
        context.contractError(localReturn, "Expected local delta return.");
    const localLowerer: PinnedNumericLowerer = new PinnedNumericLowerer(
        local.file,
        {
            bindings: new Map<string, PinnedBinding>([
                ["inv", { cpp: "(*inverse)", type: "f32" }],
                ...["dx", "dy", "dz"].map((name): [string, PinnedBinding] => [
                    name,
                    { cpp: name, type: "scalar" },
                ]),
            ]),
            calls,
            vec3Literal,
            returnValue: (expression) => localLowerer.expression(expression!),
        },
    );
    for (const symbol of [
        "registerPointerDrag",
        "installDispatcher",
        "handlePointerDown",
        "handlePointerUp",
        "handleHoverMove",
        "findDragForMesh",
        "canvasRayFromPointer",
    ]) {
        context.functionDeclaration(POINTER, symbol);
    }
    return `
namespace {
${lowerMat4InvertCpp(context)}
${dot}
${rotation ? lowerRotationPointerDrag(context) : ""}
// ${context.provenance(MATH, "rayPlaneIntersect")}
std::optional<Vec3d> drag_ray_plane(const Vec3d& rayOrigin, const Vec3d& rayDir,
    const Vec3d& planePoint, const Vec3d& planeNormal) {
${ray.declaration.body!.statements.flatMap((statement) => rayLowerer.statement(statement, "    ")).join("\n")}
}
// ${context.provenance(POINTER, "pickDragPlaneNormal")}
Vec3d drag_axis_plane(const Vec3d& camPos, const Vec3d& ref, const Vec3d& axis) {
${normal.declaration
    .body!.statements.slice(normalStart)
    .flatMap((statement) => normalLowerer.statement(statement, "    "))
    .join("\n")}
}
struct DragStep { Vec3d delta; double distance; };
// ${context.provenance(POINTER, "handlePointerMove")}
DragStep drag_step(const Vec3d& hit, const Vec3d& last, const Vec3d& start,
    const Vec3d& axis, bool axis_mode) {
${statements
    .slice(begin, planeIndex)
    .flatMap((statement) => moveLowerer.statement(statement, "    "))
    .join("\n")}
    return {delta, dragDistance};
}
// ${context.provenance(MATH, "worldDeltaToLocal")}
Vec3d drag_local_delta(Engine& engine, const MeshRecord& node, const Vec3d& delta) {
    std::optional<std::array<float, 16>> parent;
    if (node.parent.value < engine.meshes.size()) {
        parent = upstream::mesh_world_matrix(engine, ${recordAt("engine.meshes", "node.parent")});
    } else if (node.transform_parent.value < engine.transform_nodes.size()) {
        parent = upstream::transform_node_world(engine, node.transform_parent);
    }
    if (!parent) return delta;
    const auto inverse = mat4_invert(*parent);
    if (!inverse) return delta;
    const double dx = delta.x, dy = delta.y, dz = delta.z;
${localLowerer.statement(localReturn, "    ").join("\n")}
}

Vec3d drag_axis(Engine& engine, const EditGizmoRecord& drag) {
    return drag.use_local_coordinates && drag.attached_node.value < engine.meshes.size()
        ? transform_direction_by_world(upstream::mesh_world_matrix(engine, ${recordAt("engine.meshes", "drag.attached_node")}), drag.local_axis)
        : drag.local_axis;
}
Vec3d drag_anchor(const Engine& engine, const EditGizmoRecord& drag) {
    return ${recordAt("engine.transform_nodes", "drag.root")}.position;
}
Vec3d drag_plane(PointerDragDispatcher& state, const EditGizmoRecord& drag, const Vec3d& hit) {
    Engine& engine = *state.engine;
    const auto& scene = utility_layer_scene(engine, state.layer);
    const auto axis = drag_axis(engine, drag);
    return drag.plane_drag ? normalize_vec3(axis)
        : drag_axis_plane(upstream::camera_position(${recordAt("engine.cameras", "scene.camera")}), hit, axis);
}
void drag_update_plane(PointerDragDispatcher& state, const EditGizmoRecord& drag, const Vec3d& hit) {
    const auto axis = drag_axis(*state.engine, drag);
${planeLowerer.statement(planeUpdate, "    ").join("\n")}
}
// ${context.provenance(POINTER, "canvasRayFromPointer")}
std::optional<Vec3d> drag_pointer_hit(PointerDragDispatcher& state, const PlatformMouseEvent& event) {
    Engine& engine = *state.engine;
    const Scene& scene = utility_layer_scene(engine, state.layer);
    if (scene.camera.value >= engine.cameras.size()) return std::nullopt;
    const auto& camera = ${recordAt("engine.cameras", "scene.camera")};
    const double width = engine.options.width, height = engine.options.height;
    const auto viewport = upstream::resolve_camera_viewport(camera, width, height);
    if (viewport.width == 0 || viewport.height == 0) return std::nullopt;
    const double client_width = engine.canvas_client_width > 0 ? engine.canvas_client_width : width;
    const double client_height = engine.canvas_client_height > 0 ? engine.canvas_client_height : height;
    PickingInfo info;
    populate_pick_ray(info, upstream::build_view_projection(camera, static_cast<double>(viewport.width) / viewport.height),
        event.client_x * width / client_width - viewport.x,
        event.client_y * height / client_height - viewport.y, viewport.width, viewport.height);
    if (!info.ray) return std::nullopt;
    const auto& origin = info.ray->origin;
    const auto& direction = info.ray->direction;
    return drag_ray_plane({origin[0], origin[1], origin[2]}, {direction[0], direction[1], direction[2]}, state.plane_point, state.plane_normal);
}
PointerDragHandle drag_pick(PointerDragDispatcher& state, const PickingInfo& info) {
    if (!info.hit || info.picked_kind != PickedNodeKind::mesh) return {};
    for (const auto drag : state.drags) {
        if (pointer_drag_has_collider(*state.engine, drag, MeshHandle{info.picked_index, info.state->picked_generation})) return drag;
    }
    return {};
}
void drag_clear_hover(PointerDragDispatcher& state) {
    if (state.hovered.value < state.engine->edit_gizmos.size()) {
        ${recordAt("state.engine->edit_gizmos", "state.hovered")}.hovering = false;
        pointer_drag_hover(*state.engine, state.hovered, false);
    }
    state.hovered = {};
}
void drag_end(PointerDragDispatcher& state) {
    if (state.active.value < state.engine->edit_gizmos.size()) {
        ${recordAt("state.engine->edit_gizmos", "state.active")}.dragging = false;
        pointer_drag_hover(*state.engine, state.active, false);
    }
    state.active = {};
    state.pick_pending = false;
}
// ${context.provenance(POINTER, "installDispatcher", "handlePointerDown/Move/Up and handleHoverMove")}
void drag_event(PointerDragDispatcher& state, unsigned event_kind, const PlatformMouseEvent& event) {
    Engine& engine = *state.engine;
    if (state.drags.empty()) return;
    const bool active = state.active.value < engine.edit_gizmos.size();
    if (event_kind == 4) { drag_clear_hover(state); return; }
    if (event_kind == 2 || event_kind == 3) { if (active) drag_end(state); return; }
    if (event_kind == 0) {
        if (active || event.button != 0) return;
        state.pick_pending = true;
        PickingInfo info;
        try { info = gpu_pick(engine, state.picker, event.client_x, event.client_y); }
        catch (...) { state.pick_pending = false; throw; }
        state.pick_pending = false;
        const auto handle = drag_pick(state, info);
        if (handle.value >= engine.edit_gizmos.size() || !${recordAt("engine.edit_gizmos", "handle")}.enabled) return;
        const auto& drag = ${recordAt("engine.edit_gizmos", "handle")};
        const Scene& scene = utility_layer_scene(engine, state.layer);
        if (scene.camera.value >= engine.cameras.size()) return;
        const Vec3d hit = info.picked_point ? Vec3d{(*info.picked_point)[0], (*info.picked_point)[1], (*info.picked_point)[2]} : Vec3d{};
        state.plane_normal = drag_plane(state, drag, hit);
        state.plane_point = drag_anchor(engine, drag);
        state.start_point = drag_pointer_hit(state, event).value_or(state.plane_point);
        state.last_point = state.start_point;
        drag_clear_hover(state);
        state.active = handle;
        ${recordAt("engine.edit_gizmos", "handle")}.dragging = true;
        pointer_drag_hover(engine, handle, true);
        return;
    }
    if (active) {
        auto& drag = ${recordAt("engine.edit_gizmos", "state.active")};
        const auto hit = drag_pointer_hit(state, event);
        if (!hit) return;
        drag_update_plane(state, drag, *hit);
${
    rotation
        ? `        if (drag.rotation_drag) {
            if (drag.attached_node.value < engine.meshes.size()) {
                drag_rotate(engine, drag.attached_node, state.last_point, *hit, drag_axis(engine, drag));
            }
            state.last_point = *hit;
            return;
        }`
        : ""
}
        const auto step = drag_step(*hit, state.last_point, state.start_point, drag_axis(engine, drag), !drag.plane_drag);
        state.last_point = *hit;
        if (drag.attached_node.value < engine.meshes.size()) {
            auto& node = ${recordAt("engine.meshes", "drag.attached_node")};
            const auto delta = drag_local_delta(engine, node, step.delta);
            node.position = {node.position.x + delta.x, node.position.y + delta.y, node.position.z + delta.z};
            mark_mesh_dirty(engine, drag.attached_node);
        }
        return;
    }
    PointerDragHandle next{};
    if (std::any_of(state.drags.begin(), state.drags.end(), [&](auto drag) { return ${recordAt("engine.edit_gizmos", "drag")}.enabled; })) {
        next = drag_pick(state, gpu_pick(engine, state.picker, event.client_x, event.client_y));
        if (next.value < engine.edit_gizmos.size() && !${recordAt("engine.edit_gizmos", "next")}.enabled) next = {};
    }
    if (next.value == state.hovered.value) return;
    drag_clear_hover(state);
    state.hovered = next;
    if (next.value < engine.edit_gizmos.size()) {
        ${recordAt("engine.edit_gizmos", "next")}.hovering = true;
        pointer_drag_hover(engine, next, true);
    }
}
} // namespace

void pointer_drag_hover(Engine& engine, PointerDragHandle handle, bool hovered) {
    if (handle.value >= engine.edit_gizmos.size()) return;
    const auto& drag = ${recordAt("engine.edit_gizmos", "handle")};
    for (const auto mesh : drag.visible_meshes) {
        ${recordAt("engine.meshes", "mesh")}.material = hovered ? drag.hover_material : drag.colored_material;
    }
}
void initialize_pointer_gizmo(Engine& engine, UtilityLayerHandle layer, EditGizmoHandle handle, MaterialHandle material, bool plane) {
    auto& drag = ${recordAt("engine.edit_gizmos", "handle")};
    drag.plane_drag = plane;
    drag.update_drag_plane = plane ? ${planeUpdates} : ${axisUpdates};
    drag.colored_material = material;
    drag.hover_material = create_standard_material(engine);
    set_material_diffuse_color(engine, drag.hover_material,
        js::Array<double>{${hoverColor.map((value) => context.doubleLiteral(value)).join(", ")}});
    ${recordAt("engine.materials", "drag.hover_material")}.double_sided = plane;
    for (const auto mesh : utility_layer_scene(engine, layer).meshes) {
        if (${recordAt("engine.meshes", "mesh")}.transform_parent.value == drag.root.value && ${recordAt("engine.meshes", "mesh")}.visible) drag.visible_meshes.push_back(mesh);
    }
    drag.dispose_pointer = register_pointer_drag(create_pointer_drag_dispatcher(engine, layer, true), PointerDragHandle{handle.value});
}

std::shared_ptr<PointerDragDispatcher> create_pointer_drag_dispatcher(Engine& engine, UtilityLayerHandle layer, bool host_canvas) {
    if (host_canvas) {
        auto existing = engine.canvas_pointer_dispatcher.lock();
        if (existing && !existing->drags.empty()) return existing;
    }
    auto state = js::make_gc_shared<PointerDragDispatcher>();
    state->engine = &engine;
    state->layer = layer;
    state->picker = create_gpu_picker(utility_layer_scene(engine, layer));
    if (host_canvas) {
        engine.canvas_pointer_dispatcher = state;
        const auto identity = js::next_callback_identity();
        std::weak_ptr<PointerDragDispatcher> weak = state;
        const auto listener = [weak](unsigned kind) {
            return [weak, kind](const PlatformMouseEvent& event) { if (auto live = weak.lock()) drag_event(*live, kind, event); };
        };
        on_mouse_down(engine, identity, listener(0));
        on_mouse_move(engine, identity, listener(1));
        on_mouse_up(engine, identity, listener(2));
        on_mouse_cancel(engine, identity, listener(3));
        state->cleanup = [&engine, identity]() {
            off_mouse_down(engine, identity); off_mouse_move(engine, identity);
            off_mouse_up(engine, identity); off_mouse_cancel(engine, identity);
        };
    }
    return state;
}
js::Callback<void(js::BorrowedEvent)> pointer_drag_listener(const std::shared_ptr<PointerDragDispatcher>& state, unsigned kind) {
    return [weak = std::weak_ptr<PointerDragDispatcher>(state), kind](js::BorrowedEvent event) {
        if (auto live = weak.lock()) drag_event(*live, kind, event.as<PlatformMouseEvent>());
    };
}
void set_pointer_drag_cleanup(const std::shared_ptr<PointerDragDispatcher>& state, js::Callback<void()> cleanup) {
    state->cleanup = std::move(cleanup);
}
js::Callback<void()> register_pointer_drag(const std::shared_ptr<PointerDragDispatcher>& state, PointerDragHandle drag) {
    state->drags.push_back(drag);
    return js::make_closure(std::tuple{state, drag}, [](auto& captures) {
        const auto& state = std::get<0>(captures);
        const auto drag = std::get<1>(captures);
        auto& drags = state->drags;
        const auto found = std::find_if(drags.begin(), drags.end(), [drag](auto item) { return item.value == drag.value; });
        if (found == drags.end()) return;
        drags.erase(found);
        if (state->active.value == drag.value) drag_end(*state);
        if (state->hovered.value == drag.value) drag_clear_hover(*state);
        if (drags.empty()) {
            auto cleanup = std::move(state->cleanup);
            if (cleanup) cleanup();
            dispose_picker(*state->engine, state->picker);
        }
    });
}
`;
}
