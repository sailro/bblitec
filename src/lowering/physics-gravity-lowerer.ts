import type { LoweringContext } from "./context.js";

/**
 * The public setter retains its pinned branch order. The `_fo` arm is
 * emitted only for a tree that reaches `physics:floating-origin`, where it
 * calls the lowered `_setGravity`; every other tree takes the pin's absent
 * arm, where `worldPosition` selects nothing.
 */
export function lowerPhysicsGravity(
    context: LoweringContext,
    floatingOrigin: boolean,
): { header: string; source: string } {
    const contracts = [
        [
            "src/physics/havok.ts",
            "setPhysicsGravity",
            `
            if (world._fo) {
                world._fo.setGravity(world, [gravity.x, gravity.y, gravity.z], worldPosition);
                return;
            }
            world._hknp.HP_World_SetGravity(world._hkWorld, [gravity.x, gravity.y, gravity.z]);
        `,
        ],
    ] as const;
    for (const [module, symbol, body] of contracts) {
        const declaration = context.functionDeclaration(
            module,
            symbol,
        ).declaration;
        context.assertStatementShapes(
            declaration,
            declaration.body!.statements,
            body,
            "physics gravity dispatch",
        );
    }
    const dispatch = floatingOrigin
        ? `    if (world.fo) {
        fo_set_gravity(world, values, world_position);
        return;
    }
`
        : `    // The pin's \`_fo\` arm is the one reader of \`worldPosition\`; this tree
    // never reaches it, so the position selects nothing.
    static_cast<void>(world_position);
`;
    return {
        header: "void set_physics_gravity(PhysicsWorldHandle world, Vec3d gravity, js::Nullable<Vec3d> world_position);\n",
        source: `
// ${context.provenance("src/physics/havok.ts", "setPhysicsGravity", "ordinary world and floating-origin gravity dispatch")}
void set_physics_gravity(PhysicsWorldHandle handle, Vec3d gravity, js::Nullable<Vec3d> world_position) {
    PhysicsWorld& world = physics_world_record(handle);
    const std::array<double, 3> values{gravity.x, gravity.y, gravity.z};
${dispatch}    pal::physics_world_set_gravity(world.handle, values);
}
`,
    };
}
