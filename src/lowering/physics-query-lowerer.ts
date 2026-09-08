import type { LoweringContext } from "./context.js";

const module = "src/physics/havok-queries.ts";

/** The query result slots belong to the pin; collision queries belong to the PAL. */
export function lowerPhysicsQueries(context: LoweringContext): { header: string; source: string } {
  context.assertExpressionShape(context.variableInitializer(context.sourceFile(module), "_ignoreNone"), "null", "ignore-none initial state");
  for (const [name, operation, resultOperation, scalar, bindings, query] of [
    ["shapeProximity", "HP_World_ShapeProximityWithCollector", "HP_QueryCollector_GetShapeProximityResult", "distance",
      "const { position: p, rotation: r } = query;",
      "const hkQuery = [query.shape._hkShape, [p.x, p.y, p.z], [r.x, r.y, r.z, r.w], query.maxDistance, query.shouldHitTriggers ?? false, ignoreNone()];"],
    ["shapeCast", "HP_World_ShapeCastWithCollector", "HP_QueryCollector_GetShapeCastResult", "fraction",
      "const { rotation: r, startPosition: s, endPosition: e } = query; const ignoredBody: [bigint] = query.ignoreBody ? [BigInt(query.ignoreBody._hkBody[0])] : ignoreNone();",
      "const hkQuery: HavokShapeCastInput = [query.shape._hkShape, [r.x, r.y, r.z, r.w], [s.x, s.y, s.z], [e.x, e.y, e.z], query.shouldHitTriggers ?? false, ignoredBody];"],
  ] as const) {
    const { declaration } = context.functionDeclaration(module, name);
    context.assertStatementShapes(declaration, declaration.body!.statements, `
      const hknp = world._hknp;
      const collector = getCollector(world);
      ${bindings}
      ${query}
      hknp.${operation}(world._hkWorld, collector, hkQuery);
      if (hknp.HP_QueryCollector_GetNumHits(collector)[1] > 0) {
        const [${scalar}, hitInputData, hitShapeData] = hknp.${resultOperation}(collector, 0)[1];
        return { hasHit: true, ${scalar}, inputHitPoint: hitVec(hitInputData[3]),
          hitPoint: hitVec(hitShapeData[3]), inputHitNormal: hitVec(hitInputData[4]), hitNormal: hitVec(hitShapeData[4]) };
      }
      return emptyResult();
    `, `${name} PAL query assembly, collector extraction and result mapping`);
  }
  for (const [name, body] of [
    ["emptyResult", `const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
      return { hasHit: false, distance: 0, fraction: 0, inputHitPoint: zero(), hitPoint: zero(), inputHitNormal: zero(), hitNormal: zero() };`],
    ["hitVec", "return { x: slot[0], y: slot[1], z: slot[2] };"],
    ["ignoreNone", "return (_ignoreNone ??= [BigInt(0)]);"],
    ["getCollector", `if (!world._queryCollector) { world._queryCollector = world._hknp.HP_QueryCollector_Create(1)[1]; }
      return world._queryCollector;`],
  ]) {
    const { declaration } = context.functionDeclaration(module, name!);
    context.assertStatementShapes(declaration, declaration.body!.statements, body!, `${name} query helper`);
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
