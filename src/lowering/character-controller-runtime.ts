import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    characterControllerModule,
    lowerCharacterControllerKernel,
} from "./character-controller-lowerer.js";

/** The pinned controller class above the existing physics/node APIs. */
export function characterControllerHeader(
    context: LoweringContext,
    thinInstances = false,
): string {
    for (const [name, source] of [
        [
            "createPhysicsCharacterController",
            "return new PhysicsCharacterController(world, position, options);",
        ],
        ["getPhysicsCharacterControllerBody", "return controller.getBody();"],
    ]) {
        const declaration = context.functionDeclaration(
            characterControllerModule,
            name!,
        ).declaration;
        context.assertStatementShapes(
            declaration,
            declaration.body!.statements,
            source!,
            name!,
        );
    }
    const observableSource = characterCollisionObservableSource(context);
    const createNode = context.functionDeclaration(
        "src/scene/transform-node.ts",
        "createTransformNode",
    ).declaration;
    const nodeDefaults = new Map(
        createNode.parameters
            .slice(4)
            .map((parameter) => [
                parameter.name.getText(),
                context.floatLiteral(
                    context.numericValue(
                        parameter.initializer!,
                        createNode.getSourceFile(),
                    ),
                ),
            ]),
    );
    const defaultRotation = ["qx", "qy", "qz", "qw"]
        .map((name) => nodeDefaults.get(name))
        .join(", ");
    const defaultScale = ["sx", "sy", "sz"]
        .map((name) => nodeDefaults.get(name))
        .join(", ");
    const bodyFactory = context.functionDeclaration(
        "src/physics/havok.ts",
        "createPhysicsBody",
    ).declaration;
    const asleep = bodyFactory.parameters[3]!.initializer!;
    if (
        ![ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(
            asleep.kind,
        )
    )
        context.contractError(
            asleep,
            "Character body creation requires the pinned boolean startsAsleep default.",
        );
    return `#pragma once
#include <bblite/upstream/physics.hpp>
#include <unordered_set>
namespace bbl::character {
struct NativeBody { pal::PhysicsBodyHandle handle; };
struct PhysicsBody { upstream::PhysicsBody value; js::Ref<NativeBody> native; };
struct PhysicsWorld { upstream::PhysicsWorldHandle value; };
struct PhysicsShape { upstream::PhysicsShape value; };
struct TransformNode { TransformNodeHandle value; };
struct QueryCollector { double capacity = 0; };
}
${lowerCharacterControllerKernel(context, true)}
namespace bbl::character {
using Query = std::tuple<double, js::Ref<QueryPoint>, js::Ref<QueryPoint>>;
${observableSource}
${characterControllerAdapter(defaultRotation, defaultScale, asleep.kind === ts.SyntaxKind.TrueKeyword, thinInstances)}
} // namespace bbl::character
`;
}

export function characterCollisionObservableSource(
    context: LoweringContext,
): string {
    const observable = context
        .sourceFile(characterControllerModule)
        .statements.find(
            (node): node is ts.ClassDeclaration =>
                ts.isClassDeclaration(node) &&
                node.name?.text === "CharacterCollisionObservable",
        )!;
    for (const [name, source] of [
        [
            "add",
            "this._subs.push(cb); return () => { const i = this._subs.indexOf(cb); if (i >= 0) { this._subs.splice(i, 1); } };",
        ],
        ["notify", "for (const s of this._subs) { s(event); }"],
    ]) {
        const declaration = observable.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                member.name.getText() === name,
        )!;
        context.assertStatementShapes(
            declaration,
            declaration.body!.statements,
            source!,
            `character observable ${name}`,
        );
    }
    const subs = observable.members.find(
        (member): member is ts.PropertyDeclaration =>
            ts.isPropertyDeclaration(member) &&
            member.name.getText() === "_subs",
    )!;
    context.assertExpressionShape(
        subs.initializer!,
        "[]",
        "character observable initial subscriptions",
    );
    return `// ${context.provenance(characterControllerModule, "CharacterCollisionObservable")}
class CharacterCollisionObservable {
    js::Array<js::Callback<void(const CharacterCollisionEvent&)>> subscribers_;
public:
    js::Callback<void()> add(js::Callback<void(const CharacterCollisionEvent&)> callback) {
        subscribers_.push_back(callback);
        return [subscribers = subscribers_, callback]() mutable {
            const double i = js::array_index_of(subscribers, callback);
            if (i >= 0) js::array_splice_one(subscribers, i);
        };
    }
    void notify(const CharacterCollisionEvent& event) {
        for (std::size_t i = 0; i < subscribers_.size(); ++i) {
            auto callback = subscribers_.at(i);
            callback(event);
        }
    }
};
`;
}

function characterControllerAdapter(
    defaultRotation: string,
    defaultScale: string,
    startsAsleep: boolean,
    thinInstances: boolean,
): string {
    return `
class PhysicsCharacterController final : public CharacterControllerKernel {
    Engine* engine_;
    js::Map<double, js::Ref<PhysicsBody>> body_wrappers_;
${thinInstances ? "    js::Map<double, js::Ref<NativeBody>> instance_wrappers_;" : ""}
    js::Array<Query> proximity_, casts_;
    template<std::size_t N> static std::array<double, N> lanes(const js::Array<double>& values) {
        if (values.size() != N) throw std::runtime_error("Character PAL vector has an invalid lane count.");
        std::array<double, N> result{};
        std::copy(values.begin(), values.end(), result.begin());
        return result;
    }
    template<std::size_t N> static js::Array<double> array(const std::array<double, N>& values) { return {values.begin(), values.end()}; }
    js::Ref<PhysicsBody> wrap_body(upstream::PhysicsBody value) {
        auto result = body_wrappers_.get(value.handle.value);
        if (!result) { result = js::make_ref<PhysicsBody>(); body_wrappers_.set(value.handle.value, result); }
        result->value = value;
        return result;
    }
    static js::Array<Query> hits(const std::vector<pal::PhysicsShapeQueryResult>& source) {
        js::Array<Query> result;
        result.reserve(source.size());
        for (const auto& hit : source) {
            auto input = js::make_ref<QueryPoint>(), target = js::make_ref<QueryPoint>();
            input->identity = {0}; input->position = array(hit.input_point); input->normal = array(hit.input_normal);
            target->identity = {static_cast<double>(hit.body_identity)}; target->position = array(hit.point); target->normal = array(hit.normal);
            result.push_back({hit.distance_or_fraction, input, target});
        }
        return result;
    }
public:
    CharacterCollisionObservable onTriggerCollisionObservable;
    explicit PhysicsCharacterController(Engine& engine) : engine_(&engine) {}
    void dispose() {
        CharacterControllerKernel::dispose();
        body_wrappers_.clear();
${thinInstances ? "        instance_wrappers_.clear();" : ""}
    }
    js::Ref<PhysicsShape> _create_shape(js::Ref<PhysicsWorld> world, js::Ref<ShapeDescription> shape) override {
        auto result = js::make_ref<PhysicsShape>();
        upstream::PhysicsShapeParameters parameters;
        const auto& p = shape->parameters;
        parameters.point_a = Vec3d{p->pointA->x, p->pointA->y, p->pointA->z};
        parameters.point_b = Vec3d{p->pointB->x, p->pointB->y, p->pointB->z}; parameters.radius = p->radius;
        result->value = upstream::create_physics_primitive_shape(world->value, static_cast<upstream::PhysicsShapeType>(shape->type), parameters);
        return result;
    }
    js::Ref<TransformNode> _create_node(std::string name, double x, double y, double z) override {
        auto result = js::make_ref<TransformNode>();
        result->value = create_transform_node(*engine_, std::move(name), {x,y,z}, {${defaultRotation}}, {${defaultScale}});
        return result;
    }
    js::Ref<PhysicsBody> _create_body(js::Ref<PhysicsWorld> world, js::Ref<TransformNode> node, double motion) override {
        return wrap_body(upstream::create_physics_body(world->value, upstream::physics_node(node->value), static_cast<upstream::PhysicsMotionType>(motion), ${startsAsleep}));
    }
    void _set_body_shape(js::Ref<PhysicsWorld> world, js::Ref<PhysicsBody> body, js::Ref<PhysicsShape> shape) override { upstream::set_physics_body_shape(world->value, body->value, shape->value); }
    void _set_body_mass_properties(js::Ref<PhysicsWorld> world, js::Ref<PhysicsBody> body, js::Ref<InertiaOverride> properties) override {
        upstream::PhysicsMassPropertyOverrides overrides;
        overrides.inertia = Vec3d{properties->inertia->x, properties->inertia->y, properties->inertia->z};
        upstream::set_physics_body_mass_properties(world->value, body->value, overrides);
    }
    void _set_body_pre_step(js::Ref<PhysicsBody> body, bool enabled) override { upstream::set_physics_body_pre_step(body->value, enabled); }
    void _remove_body(js::Ref<PhysicsWorld> world, js::Ref<PhysicsBody> body) override { upstream::remove_physics_body(world->value, body->value); }
    void _release_shape(js::Ref<PhysicsShape> shape) override { shape->value.handle = {}; }
    js::Ref<QueryCollector> _create_collector(double capacity) override {
        if (capacity <= 0 || !std::isfinite(capacity) || std::floor(capacity) != capacity) throw std::runtime_error("Character collector capacity is invalid.");
        auto result = js::make_ref<QueryCollector>(); result->capacity = capacity; return result;
    }
    void _release_collector(js::Ref<QueryCollector> collector) override { collector->capacity = 0; }
    js::Array<js::Ref<PhysicsBody>> _world_bodies() override {
        js::Array<js::Ref<PhysicsBody>> result;
        std::unordered_set<double> live_bodies;
        for (const auto& body : upstream::physics_world_state(_world->value).bodies) {
            result.push_back(wrap_body(body));
            live_bodies.insert(body.handle.value);
        }
        for (const auto& [id, wrapper] : body_wrappers_) {
            static_cast<void>(wrapper);
            if (!live_bodies.contains(id)) static_cast<void>(body_wrappers_.erase(id));
        }
${
    thinInstances
        ? `        std::unordered_set<double> live_instances;
        for (const auto& [id, state] : upstream::physics_world_state(_world->value).thin_states) {
            static_cast<void>(id);
            for (const auto& handle : state.handles) live_instances.insert(handle.value);
        }
        for (const auto& [id, wrapper] : instance_wrappers_) {
            static_cast<void>(wrapper);
            if (!live_instances.contains(id)) static_cast<void>(instance_wrappers_.erase(id));
        }`
        : ""
}
        return result;
    }
    double _world_step_seconds() override { return upstream::physics_world_step_seconds(_world->value); }
    double _body_motion_type(js::Ref<PhysicsBody> body) override { return static_cast<double>(upstream::owning_body_record(body->value).motion_type); }
    std::optional<double> _body_identity(js::Ref<PhysicsBody> body) override { return body->value.handle.value; }
    js::Ref<NativeBody> _native_body(js::Ref<PhysicsBody> body) override {
        if (!body->native) body->native = js::make_ref<NativeBody>();
        body->native->handle = body->value.handle;
        return body->native;
    }
    std::optional<std::tuple<js::Ref<PhysicsBody>, js::Ref<NativeBody>, double>> _thin_resolve([[maybe_unused]] std::optional<double> id) override {
${
    thinInstances
        ? `        if (!id) return std::nullopt;
        const auto resolved = upstream::resolve_physics_thin_instance(_world->value, *id);
        if (!resolved) return std::nullopt;
        auto native = instance_wrappers_.get(*id);
        if (!native) { native = js::make_ref<NativeBody>(); native->handle = resolved->handle; instance_wrappers_.set(*id, native); }
        return std::tuple{wrap_body(resolved->body), native, resolved->index};`
        : "        return std::nullopt;"
}
    }
    js::Ref<Vec3> _thin_com([[maybe_unused]] js::Ref<PhysicsBody> body, [[maybe_unused]] js::Ref<NativeBody> native, [[maybe_unused]] js::Array<double> center) override {
${
    thinInstances
        ? `        const auto value = upstream::physics_thin_center(_world->value, body->value, native->handle, lanes<3>(center));
        return value ? v(value->x, value->y, value->z) : js::Ref<Vec3>{};`
        : "        return {};"
}
    }
    std::optional<js::Array<double>> _thin_matrix([[maybe_unused]] js::Ref<PhysicsBody> body, [[maybe_unused]] js::Ref<NativeBody> native) override {
${
    thinInstances
        ? `        const auto value = upstream::physics_thin_world_matrix(_world->value, body->value, native->handle);
        if (!value) return std::nullopt;
        return js::Array<double>{value->begin(), value->end()};`
        : "        return std::nullopt;"
}
    }
    js::Array<double> _body_world_matrix(js::Ref<PhysicsBody> body) override {
        const auto& live = upstream::owning_body_record(body->value);
        const auto& engine = *live.owner.lock()->engine;
        const auto matrix = upstream::physics_node_world(engine, live.node);
        return {matrix.begin(), matrix.end()};
    }
    std::tuple<js::Array<double>, double, js::Array<double>, js::Array<double>> _mass_properties(js::Ref<NativeBody> body) override {
        auto properties = pal::physics_body_get_mass_properties(body->handle);
        for (double& inertia : properties.inertia) inertia = properties.mass > 0 ? inertia / properties.mass : 0;
        return {array(properties.center_of_mass), properties.mass, array(properties.inertia), array(properties.inertia_orientation)};
    }
    js::Array<double> _angular_velocity(js::Ref<NativeBody> body) override { return array(pal::physics_body_get_angular_velocity(body->handle)); }
    js::Array<double> _linear_velocity(js::Ref<NativeBody> body) override { return array(pal::physics_body_get_linear_velocity(body->handle)); }
    void _apply_impulse(js::Ref<NativeBody> body, js::Array<double> position, js::Array<double> impulse) override { pal::physics_body_apply_impulse(body->handle, lanes<3>(position), lanes<3>(impulse)); }
    void _set_node_position(double x, double y, double z) override { set_transform_node_position(*engine_, _node->value, {x,y,z}, true); }
    void _notify(js::Ref<CharacterCollisionEvent> event) override { onTriggerCollisionObservable.notify(*event); }
    js::Array<Query> _start_hits() override { return proximity_; }
    js::Array<Query> _cast_hits() override { return casts_; }
    void _collect_proximity(js::Array<double> start, js::Array<double> rotation, double distance, bool triggers) override {
        proximity_ = hits(pal::physics_world_collect_shape_proximity(upstream::physics_world_state(_world->value).handle, _shape->value.handle,
            {lanes<3>(start), lanes<4>(rotation)}, distance, triggers, _body->value.handle, js::array_index(_startCollector->capacity)));
    }
    void _collect_cast(js::Array<double> rotation, js::Array<double> start, js::Array<double> end, bool triggers) override {
        casts_ = hits(pal::physics_world_collect_shape_cast(upstream::physics_world_state(_world->value).handle, _shape->value.handle,
            lanes<4>(rotation), lanes<3>(start), lanes<3>(end), triggers, _body->value.handle, js::array_index(_castCollector->capacity)));
    }
};
inline std::shared_ptr<PhysicsCharacterController> create_physics_character_controller(upstream::PhysicsWorldHandle world, Vec3d position, js::Ref<PhysicsCharacterControllerOptions> options) {
    auto controller = std::make_shared<PhysicsCharacterController>(*upstream::physics_world_state(world).engine);
    auto owner = js::make_ref<PhysicsWorld>(); owner->value = world;
    controller->initialize(owner, v(position.x, position.y, position.z), options);
    return controller;
}
inline js::Ref<Vec3> vector(Vec3d value) { return v(value.x, value.y, value.z); }
inline js::Ref<PhysicsCharacterControllerOptions> options(std::optional<double> height, std::optional<double> radius) {
    auto result = js::make_ref<PhysicsCharacterControllerOptions>(); result->capsuleHeight=height;result->capsuleRadius=radius;return result;
}
`;
}
