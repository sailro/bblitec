import assert from "node:assert/strict";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerPhysicsQueries } from "../src/lowering/physics-query-lowerer.js";
import { lowerRotationPointerDrag } from "../src/lowering/rotation-pointer-drag-lowerer.js";
import { UpstreamSourceStore } from "../src/upstream-source.js";

const queries = "src/physics/havok-queries.ts";
const rotation = "src/gizmo/plane-rotation-gizmo.ts";
const pointer = "src/gizmo/pointer-drag.ts";
const math = "src/gizmo/gizmo-math.ts";
const store = new UpstreamSourceStore();
class ChangedContext extends LoweringContext {
    public constructor(private readonly module: string, private readonly before: string, private readonly after: string) { super(store); }
    public override sourceFile(module: string): ts.SourceFile {
        if (module !== this.module) return super.sourceFile(module);
        const source = store.getSource(module);
        assert(source.includes(this.before), "The mutation must reach the pin.");
        return ts.createSourceFile(module, source.replace(this.before, this.after), ts.ScriptTarget.Latest, true);
    }
}

test("query contracts reject tuple, result, collector and no-hit drift", () => {
    for (const [before, after] of [
        ["[p.x, p.y, p.z], [r.x, r.y, r.z, r.w]", "[r.x, r.y, r.z, r.w], [p.x, p.y, p.z]"],
        ["HP_QueryCollector_GetShapeCastResult(collector, 0)[1]", "HP_QueryCollector_GetShapeCastResult(collector, 1)[1]"],
        ["inputHitPoint: hitVec(hitInputData[3])", "inputHitPoint: hitVec(hitShapeData[3])"],
        ["HP_QueryCollector_Create(1)[1]", "HP_QueryCollector_Create(2)[1]"],
        ["query.shouldHitTriggers ?? false", "query.shouldHitTriggers ?? true"],
        ["BigInt(query.ignoreBody._hkBody[0])", "BigInt(query.ignoreBody._hkBody[1])"],
        ["const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });", "const zero = (): Vec3 => ({ x: 1, y: 0, z: 0 });"],
        ["const collector = getCollector(world);", "const collector = getCollector(world); console.log(collector);"],
        ["_ignoreNone: [bigint] | null = null", "_ignoreNone: [bigint] | null = [BigInt(1)]"],
    ]) assert.throws(() => lowerPhysicsQueries(new ChangedContext(queries, before!, after!)), /changed|exactly/, before);
    assert.deepEqual(lowerPhysicsQueries(new ChangedContext(queries, "const collector", "const    collector")), lowerPhysicsQueries(new LoweringContext(store)));
});

test("rotation contracts reject skipped state and lifecycle changes", () => {
    for (const [module, before, after] of [
        [rotation, "moveAttached: false", "moveAttached: true"],
        [rotation, "drag._colliders = [ring, collider]", "drag._colliders = [ring]"],
        [rotation, "attachedNode: null", "attachedNode: root"],
        [rotation, "if (!node || !lastDragPoint)", "if (!node)"],
        [rotation, "const wm = node.worldMatrix", "const wm = root.worldMatrix"],
        [rotation, "const rq = node.rotationQuaternion", "const rq = root.rotationQuaternion"],
        [rotation, "onRotationChanged.notify(out);", "onRotationChanged.notify(out); setMeshesMaterial([ring], materials.colored);"],
        [rotation, 'if ("setAttribute" in canvas)', 'if ("addEventListener" in canvas)'],
        [rotation, "registerPointerDrag(layer, canvas, drag)", "registerPointerDrag(layer, canvas, gizmo)"],
        [rotation, "gizmo.drag.enabled = node !== null", "gizmo.drag.enabled = true"],
        [rotation, "gizmo.drag.onDragStart.clear();", "gizmo.drag.onDragStart.clear(); gizmo.drag.onHoverStart.clear();"],
        [pointer, "enabled: true", "enabled: false"],
        [math, "if (!parent || !parent.worldMatrix) {\n        return [dqx, dqy, dqz, dqw];", "if (!parent) {\n        return [dqx, dqy, dqz, dqw];"],
    ]) assert.throws(() => lowerRotationPointerDrag(new ChangedContext(module!, before!, after!)), /changed|exactly/, before);
});

test("rotation arithmetic changes remain translated from source", () => {
    const source = lowerRotationPointerDrag(new ChangedContext(rotation, "Math.abs(angle) < 1e-7", "Math.abs(angle) < 0.002"));
    assert.match(source, /std::abs\(angle\) < 0\.002/);
});
