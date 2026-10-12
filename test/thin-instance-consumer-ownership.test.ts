import assert from "node:assert/strict";
import test from "node:test";
import { doubleCpp } from "../src/cpp-literals.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerHierarchyInstanceOperations } from "../src/lowering/hierarchy-instance-lowerer.js";
import { lowerThinInstanceApi } from "../src/lowering/thin-instance-lowerer.js";
import { lowerWorldAabbHelpers } from "../src/lowering/world-bounds-lowerer.js";
import { lowerPhysicsThinInstances } from "../src/lowering/physics-thin-instance-lowerer.js";
import {
    importPinnedModule,
    importPinnedModuleWithExports,
} from "../src/pinned-shader-composer.js";
import {
    cppFunction,
    cppSection,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const literal = (values: ArrayLike<number>) =>
    `{${Array.from(values, doubleCpp).join(",")}}`;

interface PinPoolData {
    matrices: Float32Array | Float64Array;
    count: number;
    _version: number;
    _dirtyMin: number;
    _dirtyMax: number;
}
interface PinMesh {
    name: string;
    worldMatrix: Float32Array;
    children: PinMesh[];
    _gpu: object;
    material: object;
    thinInstances?: PinPoolData;
}
interface PinHierarchy {
    count: number;
    _bindings: { matrices: Float32Array }[];
}

test("hierarchy bindings retain their original array while dirty/count writes address the current pool", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    const pin = await importPinnedModule<{
        createHierarchyInstancePool(
            this: void,
            mesh: PinMesh,
            capacity: number,
        ): PinHierarchy;
        addHierarchyInstance(
            this: void,
            pool: PinHierarchy,
            matrix: Float32Array,
        ): number;
        setHierarchyInstanceMatrix(
            this: void,
            pool: PinHierarchy,
            index: number,
            matrix: Float32Array,
        ): void;
        removeHierarchyInstance(
            this: void,
            pool: PinHierarchy,
            index: number,
        ): void;
    }>("mesh/hierarchy-instance-pool.js");
    const { setThinInstances } = await importPinnedModule<{
        setThinInstances(
            this: void,
            mesh: PinMesh,
            matrices: Float32Array | Float64Array,
            count: number,
        ): void;
    }>("mesh/thin-instance.js");
    const mesh: PinMesh = {
        name: "carrier",
        worldMatrix: new Float32Array(identity),
        children: [],
        _gpu: {},
        material: {},
    };
    const pool = pin.createHierarchyInstancePool(mesh, 3);
    const original = pool._bindings[0]!.matrices;
    const first = new Float32Array(identity),
        second = new Float32Array(identity),
        changed = new Float32Array(identity);
    first[12] = 2;
    second[12] = 5;
    changed[12] = 11;
    pin.addHierarchyInstance(pool, first);
    pin.addHierarchyInstance(pool, second);
    const owner = mesh.thinInstances;
    const replacement = new Float64Array([
        ...identity,
        ...identity,
        ...identity,
    ]);
    replacement[12] = 300000000.125;
    setThinInstances(mesh, replacement, 2);
    assert.equal(mesh.thinInstances, owner);
    mesh.thinInstances!._dirtyMin = Infinity;
    mesh.thinInstances!._dirtyMax = 0;
    pin.setHierarchyInstanceMatrix(pool, 1, changed);
    assert.equal(pool._bindings[0]!.matrices, original);
    assert.equal(mesh.thinInstances!.matrices, replacement);
    assert.equal(original[28], 11);
    const marked = {
        version: mesh.thinInstances!._version,
        min: mesh.thinInstances!._dirtyMin,
        max: mesh.thinInstances!._dirtyMax,
    };
    pin.removeHierarchyInstance(pool, 0);
    const context = new LoweringContext();
    const api = lowerThinInstanceApi(context, []);
    runGeneratedProgram(
        native,
        "thin-hierarchy-owner-native",
        `
#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
#include <cassert>
namespace bbl {
${cppFunction(api, "void set_thin_instances(")}
${cppFunction(api, "void set_thin_instance_count(")}
${lowerHierarchyInstanceOperations(context)}
}
int main() {
    bbl::js::F32Array retained;
    const void* retained_identity = nullptr;
    {
        const bbl::js::F32Array readonly_receiver{1,2,3,4};
        retained_identity = readonly_receiver.identity();
        auto same = bbl::copy_hierarchy_binding_matrices(readonly_receiver,1,0,3);
        assert(same.identity()==retained_identity && readonly_receiver[1]==1 && readonly_receiver[3]==3);
        retained = bbl::copy_hierarchy_binding_matrices(bbl::js::F32Array(same),0,2,4);
        assert(retained.identity()==retained_identity);
    }
    assert(retained.identity()==retained_identity && retained[0]==2 && retained[1]==3);
    bbl::Engine engine; engine.meshes.emplace_back(); const bbl::MeshHandle mesh{0};
    bbl::js::F32Array original(48); bbl::set_thin_instances(engine,mesh,original,3); bbl::set_thin_instance_count(engine,mesh,0);
    const std::array<float,16> identity${literal(identity)};
    bbl::HierarchyInstancePoolRecord pool; pool.capacity=3; pool.bindings.push_back({mesh,original,identity,identity});
    bbl::add_hierarchy_pool_instance(engine,pool,std::array<float,16>${literal(first)});
    bbl::add_hierarchy_pool_instance(engine,pool,std::array<float,16>${literal(second)});
    const auto owner=engine.meshes[0].thin_instances;
    bbl::js::F64Array replacement${literal(replacement)}; bbl::set_thin_instances(engine,mesh,replacement,2);
    assert(engine.meshes[0].thin_instances==owner);
    owner->dirty_min=std::numeric_limits<double>::infinity(); owner->dirty_max=0;
    bbl::set_hierarchy_pool_matrix(engine,pool,1,std::array<float,16>${literal(changed)});
    assert(original.identity()==pool.bindings[0].matrices.identity());
    assert(std::get<bbl::js::F64Array>(owner->matrices).identity()==replacement.identity());
    assert(original[28]==11 && replacement[12]==300000000.125);
    assert(owner->version==${marked.version} && owner->dirty_min==${marked.min} && owner->dirty_max==${marked.max});
    bbl::remove_hierarchy_pool_instance(engine,pool,0);
    assert(original.identity()==pool.bindings[0].matrices.identity());
    const std::array<float,48> expected${literal(original)};
    for(std::size_t i=0;i<expected.size();++i) assert(original[i]==expected[i]);
    assert(pool.count==${pool.count} && owner->count==${mesh.thinInstances!.count});
    assert(owner->version==${mesh.thinInstances!._version} && owner->dirty_min==${mesh.thinInstances!._dirtyMin} && owner->dirty_max==${mesh.thinInstances!._dirtyMax});
    assert(replacement[12]==300000000.125);
}
`,
        { expectedOutput: "" },
    );
});

test("F64 thin-instance bounds and physics retain source precision through array views", async (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required.");
        return;
    }
    interface Box {
        boundMin: Float32Array;
        boundMax: Float32Array;
        worldMatrix: Float32Array;
        thinInstances: { matrices: Float64Array; count: number };
    }
    const boundsPin = await importPinnedModule<{
        emptyWorldAabb(this: void): Record<string, number>;
        expandWorldAabbForMesh(
            this: void,
            bounds: Record<string, number>,
            mesh: Box,
        ): void;
    }>("mesh/mesh-world-bounds.js");
    const { enableThinInstanceWorldBounds } = await importPinnedModule<{
        enableThinInstanceWorldBounds(this: void, mesh: Box): void;
    }>("mesh/enable-thin-instance-world-bounds.js");
    const matrix = new Float64Array(new ArrayBuffer(18 * 8), 8, 16);
    matrix.set(identity);
    matrix[12] = 300000000.125;
    matrix[13] = -14.3333333333333;
    const box: Box = {
        boundMin: new Float32Array([-1, -2, -3]),
        boundMax: new Float32Array([1, 2, 3]),
        worldMatrix: new Float32Array(identity),
        thinInstances: { matrices: matrix, count: 1 },
    };
    enableThinInstanceWorldBounds(box);
    const bounds = boundsPin.emptyWorldAabb();
    boundsPin.expandWorldAabbForMesh(bounds, box);
    const physicsPin = await importPinnedModuleWithExports<{
        thinInstanceTransform(
            this: void,
            matrix: Float64Array,
            index: number,
            carrier: Float32Array,
            carrierIdentity: boolean,
            scratch: Float64Array,
            transform: [number[], number[]],
            rotation: { x: number; y: number; z: number; w: number },
            scales: Float64Array,
        ): [number[], number[]];
        writeInstanceMatrix(
            this: void,
            state: unknown[],
            matrix: Float64Array,
            index: number,
            position: number[],
            rotation: number[],
        ): void;
    }>("physics/havok-thin-instances.js", [
        "thinInstanceTransform",
        "writeInstanceMatrix",
    ]);
    const transform = physicsPin.thinInstanceTransform(
        matrix,
        0,
        new Float32Array(identity),
        true,
        new Float64Array(16),
        [
            [0, 0, 0],
            [0, 0, 0, 1],
        ],
        { x: 0, y: 0, z: 0, w: 1 },
        new Float64Array(3),
    );
    const position = [300000000.375, -10.3333333333333, 0.1000000000003];
    const rotation = [0, 0, 0, 1];
    const sourceState = [
        null,
        null,
        null,
        null,
        null,
        new Float64Array([1, 1, 1]),
        new Float64Array(16),
        new Float64Array(identity),
        0,
        true,
    ];
    physicsPin.writeInstanceMatrix(sourceState, matrix, 0, position, rotation);
    const context = new LoweringContext();
    const thin = lowerPhysicsThinInstances(context, false);
    const numericHelpers = cppSection(
        thin.helpers,
        "std::array<double, 4> thin_quat_from_basis(",
        "std::array<float, 16> thin_update_carrier_impl(",
    );
    runGeneratedProgram(
        native,
        "thin-consumer-f64-native",
        `
#include <bblite/runtime.hpp>
#include <bblite/thin_instance.hpp>
#include <bblite/pal_physics.hpp>
#include <cassert>
#include <span>
namespace bbl {
${lowerWorldAabbHelpers(context, { emptyAccumulator: true })}
struct ThinPhysicsState { std::vector<double> scales,scratch,inverse; bool carrier_identity=false; };
${numericHelpers}
}
int main(){
    bbl::js::ArrayBuffer buffer(std::vector<std::uint8_t>(18*8)); bbl::js::F64Array matrices(buffer,8,16);
    const std::array<double,16> initial${literal([...identity.slice(0, 12), 300000000.125, -14.3333333333333, 0, 1])};
    for(std::size_t i=0;i<16;++i) matrices.store(i,initial[i]);
    bbl::MeshRecord record; record.thin_instances=std::make_shared<bbl::ThinInstancePoolData>(); record.thin_instances->matrices=matrices; record.thin_instances->count=1; record.thin_instance_world_bounds=true;
    bbl::WorldAabbMesh mesh; mesh.bound_min=std::array<float,3>{-1,-2,-3}; mesh.bound_max=std::array<float,3>{1,2,3}; mesh.world_matrix=std::array<float,16>${literal(identity)};
    bbl::read_thin_instance_world_bounds(mesh,record); assert(mesh.instance_matrices.identity()==matrices.identity());
    auto bounds=bbl::empty_world_aabb(); bbl::expand_world_aabb_for_mesh(bounds,mesh); const std::array<double,6> expected_bounds${literal(Object.values(bounds))};
    assert(bounds==expected_bounds);
    auto view=bbl::thin_instance_matrix_values(*record.thin_instances); std::vector<double> scratch(16),scales(3); bbl::pal::PhysicsTransform transform{}; std::array<double,4> rotation{};
    const std::array<float,16> carrier${literal(identity)};
    bbl::thin_instance_transform(view,0,carrier,true,scratch,transform,rotation,scales);
    assert((transform.position==std::array<double,3>${literal(transform[0])})); assert((transform.rotation==std::array<double,4>${literal(transform[1])}));
    bbl::ThinPhysicsState state; state.scales={1,1,1}; state.scratch.resize(16); state.inverse=${literal(identity)}; state.carrier_identity=true;
    bbl::thin_write_matrix(state,view,0,std::array<double,3>${literal(position)},std::array<double,4>${literal(rotation)});
    const std::array<double,16> expected_matrix${literal(matrix)};
    for(std::size_t i=0;i<16;++i) assert(matrices.load(i)==expected_matrix[i]);
}
`,
        { expectedOutput: "" },
    );
});
