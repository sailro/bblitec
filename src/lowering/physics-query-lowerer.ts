import ts from "typescript";
import type { LoweringContext } from "./context.js";

const module = "src/physics/havok-queries.ts";

/** The query result slots belong to the pin; collision queries belong to the PAL. */
export function lowerPhysicsQueries(context: LoweringContext): { header: string; source: string } {
  for (const [name, operation, scalar] of [
    ["shapeProximity", "HP_World_ShapeProximityWithCollector", "distance"],
    ["shapeCast", "HP_World_ShapeCastWithCollector", "fraction"],
  ] as const) {
    const { declaration } = context.functionDeclaration(module, name);
    const texts: string[] = [];
    const visit = (node: ts.Node): void => {
      texts.push(node.getText());
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    for (const expected of [
      `hknp.${operation}(world._hkWorld, collector, hkQuery)`,
      "query.shouldHitTriggers ?? false",
      "hknp.HP_QueryCollector_GetNumHits(collector)[1] > 0",
      `hasHit: true`, scalar,
      "inputHitPoint: hitVec(hitInputData[3])",
      "hitPoint: hitVec(hitShapeData[3])",
      "inputHitNormal: hitVec(hitInputData[4])",
      "hitNormal: hitVec(hitShapeData[4])",
    ]) {
      if (!texts.includes(expected)) context.contractError(declaration, `${name} no longer has its admitted query/result contract: ${expected}`);
    }
  }
  const empty = context.returnObject(context.functionDeclaration(module, "emptyResult").declaration);
  for (const field of ["distance", "fraction"]) {
    if (context.propertyInitializer(empty, field).getText() !== "0") {
      context.contractError(empty, `Physics no-hit ${field} must be zero.`);
    }
  }
  const header = `
struct PhysicsShapeQueryResult {
    bool has_hit = false;
    double distance_or_fraction = 0.0;
    Vec3d input_point{};
    Vec3d point{};
    Vec3d input_normal{};
    Vec3d normal{};
};
[[nodiscard]] PhysicsShapeQueryResult shape_proximity(
    PhysicsWorldHandle world, PhysicsShape shape, Vec3d position,
    std::array<double, 4> rotation, double max_distance, bool should_hit_triggers);
[[nodiscard]] PhysicsShapeQueryResult shape_cast(
    PhysicsWorldHandle world, PhysicsShape shape, std::array<double, 4> rotation,
    Vec3d from, Vec3d to, bool should_hit_triggers, pal::PhysicsBodyHandle ignored_body);
`;
  const source = `
// ${context.provenance(module, "shapeProximity", "query assembly and result slots; PAL supplies the collector")}
namespace {
PhysicsShapeQueryResult shape_query_result(const pal::PhysicsShapeQueryResult& hit) {
    const auto vector = [](const std::array<double, 3>& slot) {
        return Vec3d{slot[0], slot[1], slot[2]};
    };
    return PhysicsShapeQueryResult{hit.has_hit, hit.distance_or_fraction,
        vector(hit.input_point), vector(hit.point), vector(hit.input_normal), vector(hit.normal)};
}
}
PhysicsShapeQueryResult shape_proximity(
    PhysicsWorldHandle world, PhysicsShape shape, Vec3d position,
    std::array<double, 4> rotation, double max_distance, bool should_hit_triggers) {
    return shape_query_result(pal::physics_world_shape_proximity(
        physics_world_record(world).handle, shape.handle,
        pal::PhysicsTransform{{position.x, position.y, position.z}, rotation},
        max_distance, should_hit_triggers));
}
// ${context.provenance(module, "shapeCast", "query assembly and result slots; PAL supplies the collector")}
PhysicsShapeQueryResult shape_cast(
    PhysicsWorldHandle world, PhysicsShape shape, std::array<double, 4> rotation,
    Vec3d from, Vec3d to, bool should_hit_triggers, pal::PhysicsBodyHandle ignored_body) {
    return shape_query_result(pal::physics_world_shape_cast(
        physics_world_record(world).handle, shape.handle, rotation,
        {from.x, from.y, from.z}, {to.x, to.y, to.z}, should_hit_triggers, ignored_body));
}
`;
  return { header, source };
}
