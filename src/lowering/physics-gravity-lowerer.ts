import type { LoweringContext } from "./context.js";

/** The public setter and floating-origin dispatch retain their pinned branch order. */
export function lowerPhysicsGravity(context: LoweringContext): { header: string; source: string } {
    const contracts = [
        ["src/physics/havok.ts", "setPhysicsGravity", `
            if (world._fo) {
                world._fo.setGravity(world, [gravity.x, gravity.y, gravity.z], worldPosition);
                return;
            }
            world._hknp.HP_World_SetGravity(world._hkWorld, [gravity.x, gravity.y, gravity.z]);
        `],
        ["src/physics/havok-floating-origin.ts", "_setGravity", `
            const fo = world._fo!;
            const hknp = world._hknp;
            if (worldPosition) {
                const region = _getOrCreateRegion(world, worldPosition);
                region.gravity = gravity;
                hknp.HP_World_SetGravity(region._world, gravity);
                return;
            }
            fo.gravity = gravity;
            for (const region of fo.regions) {
                region.gravity = gravity;
                hknp.HP_World_SetGravity(region._world, gravity);
            }
        `],
        ["src/physics/havok-floating-origin.ts", "createHavokFloatingOriginContext", `
            return {
                regions: [{ _world: hkWorld, origin: { x: 0, y: 0, z: 0 }, gravity: [...gravity] }],
                radius, gravity: [...gravity], placeBody: _placeBody, step: _step,
                setGravity: _setGravity, getRegionGravity: _getRegionGravity,
                setVelocityLimits: _setVelocityLimits, dispose: _dispose,
            };
        `],
    ] as const;
    for (const [module, symbol, body] of contracts) {
        const declaration = context.functionDeclaration(module, symbol).declaration;
        context.assertStatementShapes(declaration, declaration.body!.statements, body, "physics gravity dispatch");
    }
    return {
        header: "void set_physics_gravity(PhysicsWorldHandle world, Vec3d gravity, js::Nullable<Vec3d> world_position);\n",
        source: `
// ${context.provenance("src/physics/havok.ts", "setPhysicsGravity", "ordinary world and floating-origin gravity dispatch")}
void set_physics_gravity(PhysicsWorldHandle handle, Vec3d gravity, js::Nullable<Vec3d> world_position) {
    PhysicsWorld& world = physics_world_record(handle);
    const std::array<double, 3> values{gravity.x, gravity.y, gravity.z};
    if (world.fo) {
        if (world_position) {
            pal::physics_world_set_gravity(get_or_create_region(world, *world_position), values);
            return;
        }
        world.fo->gravity = values;
        for (const auto& region : world.fo->regions) pal::physics_world_set_gravity(region.world, values);
        return;
    }
    pal::physics_world_set_gravity(world.handle, values);
}
`,
    };
}
