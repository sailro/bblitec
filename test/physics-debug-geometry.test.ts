import assert from "node:assert/strict";
import test from "node:test";
import { materializePhysicsDebugGeometry, physicsDebugShapeIdentity, type PhysicsDebugShape } from "../src/physics-debug-geometry.js";

const box: PhysicsDebugShape = { type: "BOX", center: [0, 0, 0], rotation: [0, 0, 0, 1], extents: [2, 3, 4] };

test("Havok debug geometry retains its rounded primitive boundary and cold determinism", async () => {
    const geometry = await materializePhysicsDebugGeometry(box);
    assert.deepEqual(await materializePhysicsDebugGeometry(box), geometry);
    assert.equal(geometry.positions.length, 8 * 3);
    assert.equal(geometry.indices.length, 12 * 3);
    for (let i = 0; i < geometry.positions.length; ++i) {
        assert.equal(Math.abs(geometry.positions[i]!), Math.fround([0.985, 1.485, 1.985][i % 3]!));
    }
    const shapes: PhysicsDebugShape[] = [
        { type: "SPHERE", center: [0, 0, 0], radius: 1 },
        { type: "CAPSULE", pointA: [0, -0.5, 0], pointB: [0, 0.5, 0], radius: 0.5 },
        { type: "CYLINDER", pointA: [0, -1, 0], pointB: [0, 1, 0], radius: 0.5 },
    ];
    const expectedCounts = [[162, 320], [225, 446], [32, 60]];
    for (const [index, shape] of shapes.entries()) {
        const result = await materializePhysicsDebugGeometry(shape);
        assert.deepEqual([result.positions.length / 3, result.indices.length / 3], expectedCounts[index]);
        assert.ok(result.positions.every(Number.isFinite));
        assert.ok(result.indices.every(value => value >= 0 && value < result.positions.length / 3));
    }
});

test("mesh, hull and heightfield geometry use complete supplied topology", async () => {
    const mesh = await materializePhysicsDebugGeometry({ type: "MESH", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] });
    assert.deepEqual(mesh, { positions: [1, 0, 0, 0, 1, 0, 0, 0, 0], indices: [0, 1, 2] });
    const hull = await materializePhysicsDebugGeometry({ type: "CONVEX_HULL", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] });
    assert.deepEqual([hull.positions.length, hull.indices.length], [12, 12]);
    const heightfield = await materializePhysicsDebugGeometry({ type: "HEIGHTFIELD", samplesX: 2, samplesZ: 2, scale: [2, 1, 3], heights: [0, 1, 2, 3] });
    assert.deepEqual(heightfield, { positions: [-1, 0, -1.5, 1, 2, -1.5, -1, 1, 1.5, 1, 3, 1.5], indices: [2, 1, 0, 3, 1, 2] });
});

test("compound debug geometry applies child scale before its library margin", async () => {
    const compound: PhysicsDebugShape = { type: "CONTAINER", children: [{
        shape: { type: "BOX", center: [0, 0, 0], rotation: [0, 0, 0, 1], extents: [2, 2, 2] },
        position: [2, 3, 4], rotation: [0, 0, 0, 1], scale: [1, 2, 3],
    }] };
    const geometry = await materializePhysicsDebugGeometry(compound);
    for (let axis = 0; axis < 3; ++axis) {
        const values = geometry.positions.filter((_, index) => index % 3 === axis);
        assert.ok(Math.abs(Math.min(...values) - 1.015) < 1e-6);
        assert.ok(Math.abs(Math.max(...values) - [2.985, 4.985, 6.985][axis]!) < 1e-6);
    }
    const changed: PhysicsDebugShape = { ...compound, children: [{ ...compound.children[0]!, scale: [1, 1, 1] }] };
    assert.notEqual(physicsDebugShapeIdentity(compound), physicsDebugShapeIdentity(changed));
    assert.notDeepEqual(await materializePhysicsDebugGeometry(changed), geometry);
});

test("descriptor identities ignore property spelling order and retain all geometry inputs", async () => {
    assert.equal(physicsDebugShapeIdentity(box), physicsDebugShapeIdentity({ extents: [2, 3, 4], rotation: [0, 0, 0, 1], center: [0, 0, 0], type: "BOX" }));
    const changes: PhysicsDebugShape[] = [
        { ...box, center: [1, 0, 0] }, { ...box, rotation: [0, 0, 1, 0] }, { ...box, extents: [2, 3, 5] },
    ];
    for (const changed of changes) assert.notEqual(physicsDebugShapeIdentity(box), physicsDebugShapeIdentity(changed));
    await assert.rejects(materializePhysicsDebugGeometry({ ...box, bodyPose: [0, 0, 0] } as PhysicsDebugShape), /unrepresented BOX field/);
    await assert.rejects(materializePhysicsDebugGeometry({ type: "MESH", positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 3] }), /triangle indices/);
    await assert.rejects(materializePhysicsDebugGeometry({ type: "HEIGHTFIELD", samplesX: 2, samplesZ: 2, scale: [1, 1, 1], heights: [0, 1, 2] }), /finite values/);
    await assert.rejects(materializePhysicsDebugGeometry({ type: "HEIGHTFIELD", samplesX: 3, samplesZ: 2, scale: [1, 1, 1], heights: [0, 1, 2, 3, 4, 5] }), /square/);
    await assert.rejects(materializePhysicsDebugGeometry({ type: "SPHERE", center: [0, 0, 0], radius: Infinity }), /positive and finite/);
});
