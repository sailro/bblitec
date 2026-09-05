import assert from "node:assert/strict";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { PhysicsLowerer } from "../src/lowering/physics-lowerer.js";

/**
 * The focused test `docs/fidelity.md` requires for a high-risk adaptation.
 *
 * `substituted-physics-solver` is the one divergence in this repository that
 * is not bit-faithful by construction, so what has to be pinned is
 * everything the port DOES take from upstream: the constants that flow out
 * of the pinned declarations into the emission, and the contract battery
 * that refuses generation when one of the rules the emitted template
 * restates moves.
 *
 * These assertions are the flowed results. The structural contracts inside
 * the lowerer are what stop generation when the pin itself moves; this test
 * is what catches an extraction that silently starts reading the wrong
 * declaration and hands back a plausible number.
 */

const lowered = new PhysicsLowerer(new LoweringContext()).lowerPhysics();

/**
 * One emitted function's body, from its signature to its own closing brace.
 *
 * An ordering assertion over the whole file is satisfied by whichever
 * occurrence happens to sit in the right order, and the standalone entry
 * points now make the same PAL calls the aggregate does.
 */
function emittedBody(signature: string): string {
    const start = lowered.source.indexOf(signature);
    assert.ok(start >= 0, `expected the emitted source to define ${signature}`);
    const end = lowered.source.indexOf("\n}\n", start);
    assert.ok(end > start, `expected ${signature} to close`);
    return lowered.source.slice(start, end);
}

test("the step clamp flows from the pinned MAX_STEP_MS", () => {
    // A 100 ms ceiling is a 10 fps floor: the pin caps a hitch so a single
    // huge dt cannot tunnel a fast body through thin geometry.
    assert.match(
        lowered.header,
        /inline constexpr double physics_max_step_ms = 100\.0;/,
    );
});

test("gravity and the material defaults flow from their own `??` arms", () => {
    assert.match(
        lowered.header,
        /pinned_default_gravity\(\) \{\n    return Vec3d\{0\.0, -9\.81, 0\.0\};/,
    );
    assert.match(
        lowered.header,
        /physics_default_friction = 0\.2;/,
    );
    assert.match(
        lowered.header,
        /physics_default_restitution = 0\.2;/,
    );
});

test("the three pinned enumerations keep the pin's own numbering", () => {
    // Read from the `const enum` declarations, which are the only place the
    // numbers exist -- the TypeScript emitter inlines them, so nothing at
    // run time could be consulted instead.
    assert.match(
        lowered.header,
        /enum class PhysicsShapeType : std::int32_t \{\n    SPHERE = 0,\n    CAPSULE = 1,\n    CYLINDER = 2,\n    BOX = 3,\n    CONVEX_HULL = 4,\n    CONTAINER = 5,\n    MESH = 6,\n    HEIGHTFIELD = 7,\n\};/,
    );
    assert.match(
        lowered.header,
        /enum class PhysicsMotionType : std::int32_t \{\n    STATIC = 0,\n    ANIMATED = 1,\n    DYNAMIC = 2,\n\};/,
    );
    assert.match(
        lowered.header,
        /enum class PhysicsPrestepType : std::int32_t \{\n    DISABLED = 0,\n    TELEPORT = 1,\n    ACTION = 2,\n\};/,
    );
});

test("the pin's own motion-type mapping is emitted, not left to the PAL", () => {
    // Upstream does not hand its enum to the solver either: it maps
    // STATIC/ANIMATED/DYNAMIC onto the back end's own three. Keeping that
    // mapping in generated code is what makes a renumbering upstream a
    // change here rather than a silent swap inside whichever solver links.
    for (const arm of [
        /case PhysicsMotionType::STATIC:\n            return pal::PhysicsMotionType::immovable;/,
        /case PhysicsMotionType::ANIMATED:\n            return pal::PhysicsMotionType::node_driven;/,
        /case PhysicsMotionType::DYNAMIC:\n            return pal::PhysicsMotionType::simulated;/,
    ]) {
        assert.match(lowered.header, arm);
    }
});

test("the step gate and its four phases are emitted in the pin's order", () => {
    assert.match(
        lowered.source,
        /world\.fixed_delta_ms > 0\.0 \? world\.fixed_delta_ms : delta_ms/,
    );
    assert.match(
        lowered.source,
        /if \(!std::isfinite\(step_ms\) \|\| step_ms <= 0\.0\)/,
    );
    assert.match(
        lowered.source,
        /std::min\(step_ms, physics_max_step_ms\) \/ 1000\.0/,
    );
    const order = [
        "sync_node_to_body(",
        "pal::physics_world_step(",
        "sync_body_to_node(",
        "world.after_step",
    ];
    let cursor = -1;
    for (const marker of order) {
        const at = lowered.source.indexOf(marker, cursor + 1);
        assert.ok(
            at > cursor,
            `expected the emitted step to run ${order.join(
                " then ",
            )}; '${marker}' is out of that order`,
        );
        cursor = at;
    }
});

test("the aggregate keeps the pinned ordering mass derivation depends on", () => {
    // Scoped to the aggregate's own emitted body: the same call names occur
    // in the standalone entry points beside it, and a whole-file scan would
    // be satisfied by those instead.
    const body = emittedBody("PhysicsAggregate create_physics_aggregate(");
    const order = [
        "create_physics_body(",
        "set_physics_body_shape(",
        "pal::physics_shape_set_material(",
        "pal::physics_shape_build_mass_properties(",
        "pal::physics_body_set_mass_properties(",
    ];
    let cursor = -1;
    for (const marker of order) {
        const at = body.indexOf(marker, cursor + 1);
        assert.ok(
            at > cursor,
            `expected the emitted aggregate to run ${order.join(
                " then ",
            )}; '${marker}' is out of that order`,
        );
        cursor = at;
    }
    // The body factory itself keeps the pin's own add-then-transform order,
    // which is observable: the solver resets a body's transform on add.
    const factory = emittedBody("PhysicsBody create_physics_body(");
    let inner = -1;
    for (const marker of [
        "pal::physics_body_create(",
        "pal::physics_body_set_motion_type(",
        "pal::physics_world_add_body(",
        "sync_node_to_body(",
    ]) {
        const at = factory.indexOf(marker, inner + 1);
        assert.ok(at > inner, `'${marker}' is out of order in the factory`);
        inner = at;
    }
    // `mass === 0` is what selects the motion type, and a mass is written
    // only for a positive one -- both the pin's own rules.
    assert.match(
        body,
        /options\.mass == 0\.0 \? PhysicsMotionType::STATIC\n *: PhysicsMotionType::DYNAMIC/,
    );
    assert.match(body, /if \(options\.mass > 0\.0\)/);
});

test("the material carries the pin's own per-channel combine modes", () => {
    // MINIMUM for friction and MAXIMUM for restitution is upstream's
    // choice, not the linked solver's default, so it crosses the PAL
    // surface as data.
    assert.match(
        lowered.source,
        /pal::PhysicsMaterialCombine::minimum,\n *pal::PhysicsMaterialCombine::maximum,/,
    );
});

test("shape parameters are translated from _buildShapeParams", () => {
    assert.match(lowered.source, /havok\.ts#_buildShapeParams/);
    // The prelude: each scale term from its own pinned `const`, the
    // optional bound pair specialized onto `MeshBounds::present` with the
    // pin's own literal fallback, and the scaled extents.
    assert.match(
        lowered.source,
        /shape\.scale_x = std::abs\(static_cast<double>\(scaling\.x\)\);/,
    );
    assert.match(
        lowered.source,
        /shape\.scale_y = \(\(\(\(static_cast<double>\(scaling\.x\) \* static_cast<double>\(scaling\.y\)\) \* static_cast<double>\(scaling\.z\)\) < 0\.0\) \? \(-shape\.scale_y_magnitude\) : shape\.scale_y_magnitude\);/,
    );
    assert.match(
        lowered.source,
        /shape\.minimum = Vec3d\{box\.present \? static_cast<double>\(box\.minimum\.x\) : -0\.5,/,
    );
    assert.match(
        lowered.source,
        /shape\.maximum = Vec3d\{box\.present \? static_cast<double>\(box\.maximum\.x\) : 0\.5,/,
    );
    assert.match(
        lowered.source,
        /shape\.extents = Vec3d\{\(\(shape\.maximum\.x - shape\.minimum\.x\) \* shape\.scale_x\),/,
    );
    // The per-case derivations, each the right arm of the pin's own `??`.
    assert.match(
        lowered.source,
        /Vec3d bounding_center[\s\S]*?return Vec3d\{\(\(\(shape\.minimum\.x \+ shape\.maximum\.x\) \* 0\.5\) \* shape\.scale_x\), \(\(\(shape\.minimum\.y \+ shape\.maximum\.y\) \* 0\.5\) \* shape\.scale_y\)/,
    );
    assert.match(
        lowered.source,
        /double sphere_radius[\s\S]*?return \(std::max<double>\(\{shape\.extents\.x, shape\.extents\.y, shape\.extents\.z\}\) \* 0\.5\);/,
    );
    assert.match(
        lowered.source,
        /Vec3d box_extents[\s\S]*?return shape\.extents;/,
    );
    // A capsule and a cylinder span the mesh's own Y range: the pin gave
    // both the unit segment before 1.25.0, and reading the derivation is
    // what moved them.
    assert.match(
        lowered.source,
        /PinnedSegmentShape capsule_shape[\s\S]*?const double radius = \(shape\.extents\.x \* 0\.5\);[\s\S]*?Vec3d\{0\.0, \(\(shape\.minimum\.y \* shape\.scale_y\) \+ radius\), 0\.0\},\n *Vec3d\{0\.0, \(\(\(shape\.minimum\.y \* shape\.scale_y\) \+ shape\.extents\.y\) - radius\), 0\.0\}\}/,
    );
    assert.match(
        lowered.source,
        /PinnedSegmentShape cylinder_shape[\s\S]*?\(shape\.extents\.x \* 0\.5\),\n *Vec3d\{0\.0, \(shape\.minimum\.y \* shape\.scale_y\), 0\.0\},\n *Vec3d\{0\.0, \(\(shape\.minimum\.y \* shape\.scale_y\) \+ shape\.extents\.y\), 0\.0\}\}/,
    );
    // Each shape reads the prelude the aggregate built from the record's
    // own scaling, rather than a second derivation.
    assert.match(
        lowered.source,
        /const PinnedShapeBounds sized =\n *pinned_shape_bounds\(bounds, record\.scaling\);/,
    );
});

test("every aggregate arm takes its explicit override through the pin's `??`", () => {
    // `_buildShapeParams` resolves five geometry members as overrides of the
    // bounds-derived value, and the derived half above is only the RIGHT arm
    // of each `??`. The left arm lives here, at the one caller with an
    // options bag: an override accepted at generation and dropped here would
    // size the collider from the mesh instead and rest the body somewhere
    // else, which is what `examples/regression-physics-aggregate-options.ts`
    // measures.
    const body = emittedBody("PhysicsAggregate create_physics_aggregate(");
    for (const arm of [
        // The centre is written BEFORE the switch upstream, so a capsule or
        // a cylinder carries an explicit one too even though neither case
        // states one.
        /if \(options\.center\) \{\n *params\.center = \*options\.center;\n *\}\n *switch \(type\)/,
        /params\.radius =\n? *options\.radius \? \*options\.radius : sphere_radius\(sized\)/,
        /params\.extents = options\.extents\n? *\? \*options\.extents\n? *: box_extents\(sized\)/,
        // The pin's two segment cases stay two cases; what they do with the
        // segment their own arm derived is one helper.
        /apply_segment_params\(params, options, capsule_shape\(sized\)\)/,
        /apply_segment_params\(params, options, cylinder_shape\(sized\)\)/,
    ]) {
        assert.match(body, arm);
    }
    const segment = emittedBody("void apply_segment_params(");
    for (const arm of [
        /params\.radius = options\.radius \? \*options\.radius : segment\.radius;/,
        /params\.point_a = options\.point_a \? \*options\.point_a : segment\.point_a;/,
        /params\.point_b = options\.point_b \? \*options\.point_b : segment\.point_b;/,
    ]) {
        assert.match(segment, arm);
    }
    // Only the two cases that state a centre take the derived one, and only
    // when the options bag left it absent -- the pin's `params.center ??`.
    assert.equal(
        body.match(/if \(!params\.center\) \{\n *params\.center = bounding_center\(sized\);/g)
            ?.length,
        2,
    );
    // Both bags declare the same five members in the same order, because the
    // intrinsic fills the aggregate's positionally from that one table. The
    // doc line is what marks a table-generated lane: the scalar options
    // beside them are `js::Nullable<double>` too.
    const lanes = (struct: string): string[] => {
        const start = lowered.header.indexOf(`struct ${struct} {`);
        assert.ok(start >= 0, `expected the header to declare ${struct}`);
        return [
            ...lowered.header
                .slice(start, lowered.header.indexOf("\n};", start))
                .matchAll(
                    /\/\*\* `\w+\.(\w+)`\. \*\/\n *js::Nullable<(\w+)> (\w+)\{\}/g,
                ),
        ].map(([, pinned, storage, field]) => `${pinned} ${storage} ${field}`);
    };
    assert.deepEqual(lanes("PhysicsAggregateOptions"), [
        "center Vec3d center",
        "radius double radius",
        "pointA Vec3d point_a",
        "pointB Vec3d point_b",
        "extents Vec3d extents",
    ]);
    assert.deepEqual(
        lanes("PhysicsShapeParameters"),
        lanes("PhysicsAggregateOptions"),
    );
});

test("a prestep type turns pre-step syncing on, as the pin's own body does", () => {
    // `setPhysicsBodyPrestepType` is two statements upstream: the type write
    // and `if (type !== DISABLED) body._preStep = true`. That second one is
    // the whole reason a scene naming a type never calls
    // `setPhysicsBodyPreStep` beside it, and dropping it would leave the
    // pre-step gate closed on every body but an ANIMATED one.
    const setter = emittedBody("void set_physics_body_prestep_type(");
    assert.match(setter, /live\.prestep_type = type;/);
    assert.match(
        setter,
        /if \(type != PhysicsPrestepType::DISABLED\) \{\n *live\.pre_step = true;\n *\}/,
    );
    // Both setters that take no world find their body the same way, since
    // the pin reaches it through `body._world` in both.
    for (const signature of [
        "void set_physics_body_pre_step(",
        "void set_physics_body_prestep_type(",
    ]) {
        assert.match(emittedBody(signature), /owning_body_record\(body\)/);
    }
});

test("mesh bounds apply scene-code overrides before sizing an aggregate", () => {
    const helper = lowered.source.slice(
        lowered.source.indexOf("MeshBounds mesh_bounds"),
        lowered.source.indexOf("struct PinnedShapeBounds"),
    );
    assert.match(
        helper,
        /MeshBounds bounds\{true, geometry\.bounds_min, geometry\.bounds_max\};/,
    );
    assert.match(
        helper,
        /apply_mesh_bound_overrides\(mesh, bounds\.minimum, bounds\.maximum\);/,
    );
    assert.match(helper, /return bounds;/);
});

test("a body's integrated pose writes the two fields the pin writes", () => {
    // The translation is the record's own width: the pin holds a node's
    // position as three JavaScript numbers, so an integrated pose writes
    // them without narrowing first.
    assert.match(
        // The solver's own doubles, unnarrowed: the record's translation is
        // that width, so a cast here would throw the pose's precision away
        // and widen the rounded value straight back.
        emittedBody("void sync_body_to_node("),
        /Vec3d\{\s*transform\.position\[0\],\s*transform\.position\[1\],\s*transform\.position\[2\],\s*\},/,
    );
    // The quaternion is the one place the pose DOES narrow, because the
    // record holds it at float width.
    assert.match(
        emittedBody("[[nodiscard]] Vec4 transform_rotation("),
        /static_cast<float>\(t\.rotation\[0\]\),/,
    );
    // Both fields land on the record, and the transform version the
    // renderer re-reads is bumped with them.
    const writer = emittedBody("void write_node_pose(");
    assert.match(writer, /mesh\.position = position;/);
    assert.match(writer, /mesh\.rotation_quaternion = rotation;/);
    assert.match(
        writer,
        /mark_mesh_runtime_transform\(engine, MeshHandle\{node\.value\}\);/,
    );
    assert.doesNotMatch(lowered.source, /mark_physics_mesh_dirty/);
});

test("a body follows either kind of pinned scene node", () => {
    // `createPhysicsBody` takes a `SceneNode` upstream, which is a mesh or
    // a bare transform node; this port keeps the two in separate arenas, so
    // the body records which one its handle addresses and both syncs read
    // the same two properties off either.
    assert.match(
        lowered.header,
        /enum class PhysicsNodeKind : std::int32_t \{\n    mesh,\n    transform_node,\n\};/,
    );
    assert.match(lowered.header, /PhysicsNodeRef node\{\};/);
    for (const record of ["TransformNodeRecord", "MeshRecord"]) {
        assert.ok(
            lowered.source.includes(`const ${record}&`),
            `expected physics_node_pose to read a ${record}`,
        );
    }
});

test("both shape paths route through the pin's own primitive factory", () => {
    // `createPhysicsShape` and `createPhysicsAggregate` each build a
    // primitive by calling `createPrimitivePhysicsShapeHandle` and forking
    // on its null, so the emitted port has ONE translation of those four
    // arms and two callers -- not a second copy of the `??` defaults at
    // each call site.
    assert.match(lowered.source, /havok\.ts#createPrimitivePhysicsShapeHandle/);
    const calls = lowered.source.match(
        /primitive_physics_shape_handle\(type, /g,
    );
    assert.equal(calls?.length, 2);
    assert.match(lowered.source, /default:\n            return std::nullopt;/);
});

test("the two mesh arms share one accumulator and split on the pin's own boolean", () => {
    // `createPhysicsShape` runs ONE `MeshAccumulator` for CONVEX_HULL and
    // MESH and separates them with `options.type === PhysicsShapeType.MESH`.
    // The emitted factory folds that comparison into `collect_indices` and
    // reaches a different back-end factory on each side, so a port that
    // quietly sent MESH down the hull arm -- which every reached scene's
    // box-shaped collider would hide, since a box's soup and its hull are
    // the same surface -- shows up here.
    const body = emittedBody("PhysicsShape create_physics_mesh_shape(");
    assert.match(
        body,
        /const bool collect_indices = type == PhysicsShapeType::MESH;/,
    );
    assert.match(body, /pal::physics_shape_create_mesh\(positions, indices\)/);
    assert.match(body, /pal::physics_shape_create_convex_hull\(positions\)/);
    // Both of the pin's own accumulator throws, and only on the arm that
    // states each: a hull needs points, a soup needs points AND triangles.
    assert.match(
        body,
        /Cannot create physics mesh shape without vertex positions\./,
    );
    assert.match(
        body,
        /Cannot create physics mesh shape without triangle indices\./,
    );
});

test("the accumulator addresses and winds each triangle the pin's way", () => {
    // `const indexOffset = this._vertices.length / 3` is read BEFORE the
    // node's own vertices join the list, which is what makes a child's
    // triangles address the child's vertices; and `push(c, b, a)` is the
    // pin's own reversal of each triangle. Both are restated here, so both
    // are asserted against the emitted text as well as against the pin.
    const body = emittedBody("void append_physics_mesh_geometry(");
    const offsetAt = body.indexOf("const std::uint32_t index_offset");
    const verticesAt = body.indexOf("positions.push_back({");
    assert.ok(offsetAt >= 0 && verticesAt > offsetAt);
    assert.match(
        body,
        /indices\.push_back\(geometry\.indices\[i \+ 2\] \+ index_offset\);\n\s*indices\.push_back\(geometry\.indices\[i \+ 1\] \+ index_offset\);\n\s*indices\.push_back\(geometry\.indices\[i\] \+ index_offset\);/,
    );
});

test("each primitive arm keeps the pin's own parameter defaults", () => {
    // Every one of these is a `params.<member> ?? <default>` read out of
    // the pinned factory: a sphere is half a unit, a segment spans the unit
    // Y axis, a box is the unit cube, and a box's rotation is the identity
    // quaternion the pin writes rather than one typed here.
    for (const arm of [
        /const Vec3d c = params\.center \? \*params\.center : Vec3d\{0\.0, 0\.0, 0\.0\};/,
        /const double r = params\.radius \? \*params\.radius : 0\.5;/,
        /const std::array<double, 4> q = \{0\.0, 0\.0, 0\.0, 1\.0\};/,
        /const Vec3d e = params\.extents \? \*params\.extents : Vec3d\{1\.0, 1\.0, 1\.0\};/,
        /const Vec3d a = params\.point_a \? \*params\.point_a : Vec3d\{0\.0, 0\.0, 0\.0\};/,
        /const Vec3d b = params\.point_b \? \*params\.point_b : Vec3d\{0\.0, 1\.0, 0\.0\};/,
    ]) {
        assert.match(lowered.source, arm);
    }
});

test("the trigger stream carries the pin's own two event names", () => {
    // `havok-trigger.ts` reports `"ENTERED"` and `"EXITED"`; scene code
    // compares against those strings, so the generated name function is
    // what a comparison reads and it must spell them the pin's way.
    assert.match(
        lowered.header,
        /enum class PhysicsTriggerType \{\n    ENTERED,\n    EXITED,\n\};/,
    );
    assert.match(
        lowered.source,
        /case PhysicsTriggerType::ENTERED: return "ENTERED";/,
    );
    assert.match(
        lowered.source,
        /case PhysicsTriggerType::EXITED: return "EXITED";/,
    );
    // `registerTriggerDrain` drains through the post-step hook rather than
    // through a channel of its own, which is what orders a trigger event
    // after the step that produced it.
    assert.match(
        lowered.source,
        /void on_physics_trigger\([\s\S]*?on_physics_after_step\(/,
    );
});

test("the floating-origin radius flows from the pin's own parameter", () => {
    // `enableHavokFloatingOrigin(world, floatingOriginWorldRadius = 100000)`.
    // The intrinsic emits this constant at every call site that omits the
    // argument, which is where the pin applies the default too, so a bump
    // that moved the radius would move every far-from-origin simulation.
    assert.match(
        lowered.header,
        /inline constexpr double pinned_floating_origin_radius = 100000\.0;/,
    );
});

test("a floating-origin world replaces the single-world frame", () => {
    // `_stepWorld`'s `_fo` arm RETURNS, so a region-stepped world runs
    // neither the prestep gate nor the after-step hooks. Both are the pin's
    // and both are observable, so the emitted arm has to return too.
    assert.match(
        emittedBody("void step_world(PhysicsWorld& world, double delta_ms)"),
        /if \(world\.fo\) \{\n        fo_step_world\(world, dt\);\n        return;\n    \}/,
    );
    // `createPhysicsBody`'s own `_fo` arm: `placeBody` REPLACES the plain
    // add-then-transform pair rather than running before it.
    const factory = emittedBody(
        "PhysicsBody create_physics_body(",
    );
    assert.match(
        factory,
        /if \(world\.fo\) \{[\s\S]*?place_body\(world, body, starts_asleep\);\n\s+\} else \{[\s\S]*?physics_world_add_body\(/,
    );
});

test("the region phases keep the pin's own order", () => {
    // `_step`: re-region, then the ANIMATED pre-step sync, then one step
    // per region, then the DYNAMIC post-step sync, then the reclaim. A body
    // re-based after its node sync would be stepped from the previous
    // region's frame, so the first edge is as observable as the last.
    assert.match(
        emittedBody("void fo_step_world(PhysicsWorld& world, double dt)"),
        /re_region_body\([\s\S]*?fo_sync_node_to_body\([\s\S]*?physics_world_step\([\s\S]*?fo_sync_body_to_node\([\s\S]*?gc_regions\(world\);/,
    );
    // `_getOrCreateRegion` seeds a new region from the CONTEXT's gravity
    // and from the BASE world's speed limits -- not from the backend's
    // defaults, which is what makes both PAL entry points reached.
    assert.match(
        emittedBody(
            "[[nodiscard]] pal::PhysicsWorldHandle get_or_create_region(",
        ),
        /physics_world_create\(\);\n    pal::physics_world_set_gravity\(new_world, fo\.gravity\);\n[\s\S]*?physics_world_get_speed_limit\(world\.handle\);\n    pal::physics_world_set_speed_limit\(/,
    );
});

test("a migrating body carries its velocity and the 20% margin", () => {
    const body = emittedBody(
        "void re_region_body(PhysicsWorld& world, PhysicsBody& body)",
    );
    // `const margin = fo.radius * 1.2` and the squared test it feeds: the
    // hysteresis is what stops a body on a boundary re-regioning every step.
    assert.match(body, /const double margin = fo\.radius \* 1\.2;/);
    // `HP_World_AddBody` does not carry velocity, so the pin reads both
    // vectors before the move and writes them back after it.
    assert.match(
        body,
        /physics_body_get_linear_velocity\([\s\S]*?physics_body_get_angular_velocity\([\s\S]*?physics_world_remove_body\([\s\S]*?physics_world_add_body\([\s\S]*?physics_body_set_linear_velocity\([\s\S]*?physics_body_set_angular_velocity\(/,
    );
});

test("the node keeps true world coordinates under floating origin", () => {
    // The whole point of the feature: the SOLVER holds a small local pose
    // and the node holds the real one, so the render path -- which
    // subtracts the camera's own offset -- is untouched.
    assert.match(
        emittedBody("void fo_sync_body_to_node("),
        /transform\.position\[0\] \+ origin\.x,\n            transform\.position\[1\] \+ origin\.y,\n            transform\.position\[2\] \+ origin\.z,/,
    );
    assert.match(
        emittedBody("void fo_sync_node_to_body("),
        /pose\.position\.x - origin\.x,\n             pose\.position\.y - origin\.y,\n             pose\.position\.z - origin\.z/,
    );
});

test("no solver is named in generated code", () => {
    // The whole point of the seam: swapping the implementation is dropping
    // in a different PAL translation unit, so no generated CODE may know
    // which one is linked. Comment lines are excluded deliberately -- the
    // emitted provenance cites the pin's own `hknp` parameter, which is
    // the boundary being described rather than a dependency on it.
    const code = (text: string): string =>
        text
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join("\n");
    for (const text of [lowered.header, lowered.source]) {
        assert.doesNotMatch(
            code(text),
            /bullet|btRigidBody|btVector3|hknp/i,
        );
    }
});
