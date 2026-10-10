import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerRetainedMeshRecovery } from "../src/lowering/mesh-recovery.js";
import { FactoryLowerer } from "../src/lowering/factory-lowerer.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface BufferFixture {
    bytes: ArrayBuffer;
    getMappedRange(): ArrayBuffer;
    unmap(): void;
}
interface GpuFixture {
    positionBuffer?: BufferFixture;
    normalBuffer?: BufferFixture;
    uvBuffer?: BufferFixture;
    uv2Buffer?: BufferFixture;
    tangentBuffer?: BufferFixture;
    colorBuffer?: BufferFixture;
    indexBuffer?: BufferFixture;
    hasUv?: boolean;
    hasUv2?: boolean;
    hasTangent?: boolean;
    hasColor?: boolean;
    _refCount?: number;
    indexFormat: string;
}
interface MeshFixture {
    _gpu: GpuFixture;
    _cpuPositions: Float32Array;
    _cpuNormals: Float32Array;
    _cpuUvs: Float32Array;
    _cpuUv2s?: Float32Array | null;
    _cpuTangents?: Float32Array | null;
    _cpuColors?: Float32Array | null;
    _cpuIndices?: Uint32Array;
    boundMin: number[];
    boundMax: number[];
}

async function pinnedRecoveryResult(): Promise<object> {
    const { _rebuildMeshes } = await importPinnedModule<{
        _rebuildMeshes(
            this: void,
            engine: object,
            scene: { meshes: MeshFixture[] },
        ): Promise<void>;
    }>("engine/recovery-rebuild.js");
    const device = {
        createBuffer({ size }: { size: number }): BufferFixture {
            const bytes = new ArrayBuffer(size);
            return { bytes, getMappedRange: () => bytes, unmap() {} };
        },
    };
    const capture = await importPinnedModule<{
        _retainDeviceLostRecoveryCapture(
            engine: object,
            includeMeshes: boolean,
        ): void;
        _releaseDeviceLostRecoveryCapture(
            engine: object,
            includeMeshes: boolean,
        ): void;
    }>("engine/device-lost-recovery-capture.js");
    const engine: {
        _device: typeof device;
        _deviceLostRecovery: object;
        _dlr?: {
            m(
                mesh: MeshFixture,
                uvs2: Float32Array,
                tangents: Float32Array,
                colors: Float32Array,
                indices: Uint32Array,
                format: string,
            ): void;
        };
    } = {
        _device: device,
        _deviceLostRecovery: { _captureRefs: 0, _meshCaptureRefs: 0 },
    };
    capture._retainDeviceLostRecoveryCapture(engine, true);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const indices = new Uint32Array([0, 1, 2]);
    const uvs2 = new Float32Array([0, 0, 1, 0, 0, 1]);
    const tangents = new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    const colors = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const old: GpuFixture = { _refCount: 3, indexFormat: "uint32" };
    const mesh: MeshFixture = {
        _gpu: old,
        _cpuPositions: positions,
        _cpuNormals: normals,
        _cpuUvs: uvs,
        _cpuIndices: indices,
        boundMin: [0, 0, 0],
        boundMax: [1, 1, 0],
    };
    engine._dlr!.m(mesh, uvs2, tangents, colors, indices, "uint32");
    const clone = { ...mesh },
        inactive = { ...mesh };
    const skipped: MeshFixture = { ...mesh, _gpu: { indexFormat: "uint32" } };
    delete skipped._cpuIndices;
    positions[0] = 2;
    normals[0] = 3;
    uvs[0] = 0.5;
    indices[0] = 2;
    uvs2[0] = 0.25;
    tangents[0] = 2;
    colors[0] = 0.5;
    await _rebuildMeshes(
        { _device: device },
        { meshes: [mesh, clone, skipped] },
    );
    const floats = (buffer: BufferFixture | undefined): number[] =>
        buffer ? Array.from(new Float32Array(buffer.bytes)) : [];
    positions[0] = 4;
    const once = {
        positions: floats(mesh._gpu.positionBuffer),
        normals: floats(mesh._gpu.normalBuffer),
        uvs: floats(mesh._gpu.uvBuffer),
        uvs2: floats(mesh._gpu.uv2Buffer),
        tangents: floats(mesh._gpu.tangentBuffer),
        colors: floats(mesh._gpu.colorBuffer),
        indices: Array.from(new Uint32Array(mesh._gpu.indexBuffer!.bytes)),
        flags: [
            mesh._gpu.hasUv,
            mesh._gpu.hasUv2,
            mesh._gpu.hasTangent,
            mesh._gpu.hasColor,
        ],
        owners: [mesh._gpu._refCount ?? 1, clone._gpu._refCount ?? 1],
        separate: mesh._gpu !== clone._gpu,
        cpuAlias:
            mesh._cpuPositions === clone._cpuPositions &&
            clone._cpuPositions[0] === 4 &&
            mesh._cpuUv2s === uvs2 &&
            mesh._cpuColors === colors,
        inactive: inactive._gpu === old,
        skipped: skipped._gpu.indexBuffer === undefined,
        bounds: [mesh.boundMin, mesh.boundMax],
    };
    capture._releaseDeviceLostRecoveryCapture(engine, true);
    assert.equal(engine._dlr, undefined);
    await _rebuildMeshes(
        { _device: device },
        { meshes: [mesh, clone, skipped] },
    );
    return { once, twicePositions: floats(mesh._gpu.positionBuffer) };
}

test("retained mesh recovery matches pinned uploads, clone ownership and unchanged bounds", async (t) => {
    const native = optionalNativeFixtureTools();
    if (!native) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const expected = await pinnedRecoveryResult();
    const context = new LoweringContext();
    const factories = new FactoryLowerer(context).lowerMeshFactories([
        "mesh:from-data",
        "mesh:update-attributes",
    ]).source;
    const directory = resolve("artifacts/mesh-recovery-check");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        resolve(directory, "expected.json"),
        JSON.stringify(expected),
    );
    const file = resolve(directory, "check.cpp"),
        executable = resolve(directory, "check.exe");
    writeFileSync(
        file,
        `#include <bblite/mesh_cpu_streams.hpp>
#include <bblite/mesh_vertex_packing.hpp>
#include <nlohmann/json.hpp>
#include <fstream>
#include <cassert>
#include <iostream>
${factories}
namespace bbl {
${lowerRetainedMeshRecovery(context)}
}
int main() {
    using namespace bbl;
    Engine engine;
    engine.device_recovery = std::make_shared<Engine::DeviceRecoveryState>();
    auto registration = std::make_shared<DeviceRecoveryRegistration>(); registration->kind = "scene";
    engine.device_recovery->registrations.push_back(registration);
    auto scene = std::make_shared<Scene>(); scene->engine = &engine;
    engine.rendering_contexts.push_back("scene", scene);
    js::F32Array positions{0,0,0,1,0,0,0,1,0}, normals{0,1,0,0,1,0,0,1,0}, uvs{0,0,1,0,0,1};
    js::U32Array indices{0,1,2};
    js::F32Array uvs2{0,0,1,0,0,1}, tangents{1,0,0,1,1,0,0,1,1,0,0,1}, colors{1,1,1,1,1,1,1,1,1,1,1,1};
    const auto mesh = create_retained_mesh_from_data(engine, "owned", positions, normals, indices, uvs, uvs2, tangents, colors);
    update_mesh_positions(engine, mesh, {9,8,7}, 0, 1, 0);
    update_mesh_uvs(engine, mesh, {0.75f,0.25f}, 0, 1, 0);
    const auto old = handle_at(engine.meshes, mesh).geometry;
    assert(engine.geometries.at(old).render_vertices_override->at(0).position.x == 9);
    const auto clone = store_mesh_record(engine, handle_at(engine.meshes, mesh));
    const auto inactive = store_mesh_record(engine, handle_at(engine.meshes, mesh));
    engine.geometries.at(old).owners = 3;
    const auto skipped = create_retained_mesh_from_data(engine, "missing", positions, normals, indices, uvs, {}, {}, {});
    handle_at(engine.meshes, skipped).cpu_streams->indices.reset();
    const auto skippedGeometry = handle_at(engine.meshes, skipped).geometry;
    scene->meshes = {mesh, clone, skipped};
    auto& metadata = engine.geometries.at(old);
    metadata.source_indices_reversed = true;
    metadata.topology = MeshTopology::lines;
    metadata.morph_positions = {{Vec3{1,2,3}}};
    metadata.morph_normals = {{Vec3{4,5,6}}};
    metadata.morph_tangents = {{Vec3{7,8,9}}};
    metadata.morph_bounds = {std::array<Vec3,2>{Vec3{-1,-2,-3}, Vec3{1,2,3}}};
    const auto oldVersion = metadata.attribute_version;
    positions[0] = 2; normals[0] = 3; uvs[0] = 0.5f; indices[0] = 2;
    uvs2[0] = 0.25f; tangents[0] = 2; colors[0] = 0.5f;
    recover_retained_meshes(engine);
    const auto geometryIndex = handle_at(engine.meshes, mesh).geometry;
    const auto& geometry = engine.geometries.at(geometryIndex);
    assert(!geometry.render_vertices_override);
    const auto verifyMetadata = [](const ModelGeometry& value, std::uint64_t version) {
        assert(value.owned_packed_geometry && value.source_indices_reversed);
        assert(value.topology == MeshTopology::lines && value.attribute_version == version);
        assert(value.morph_positions.size() == 1 && value.morph_positions[0][0].x == 1);
        assert(value.morph_normals.size() == 1 && value.morph_normals[0][0].y == 5);
        assert(value.morph_tangents.size() == 1 && value.morph_tangents[0][0].z == 9);
        assert(value.morph_bounds.size() == 1 && value.morph_bounds[0][0].x == -1 && value.morph_bounds[0][1].z == 3);
    };
    verifyMetadata(geometry, oldVersion + 1);
    verifyMetadata(engine.geometries.at(handle_at(engine.meshes, clone).geometry), oldVersion + 1);
    verifyMetadata(engine.geometries.at(old), oldVersion);
    assert(geometry.morph_positions[0].data() != engine.geometries.at(old).morph_positions[0].data());
    positions[0] = 4;
    const MeshCpuStreamsView uploaded(MeshRecord{}, &geometry);
    nlohmann::json once{
        {"positions", uploaded.positions.copy()}, {"normals", uploaded.normals.copy()}, {"uvs", uploaded.uvs.copy()}, {"indices", geometry.indices},
        {"uvs2", uploaded.uvs2.copy()}, {"tangents", uploaded.tangents.copy()}, {"colors", uploaded.colors.copy()},
        {"flags", {geometry.has_uvs, geometry.cpu_uv2s, geometry.has_tangents, geometry.has_vertex_colors}},
        {"owners", {geometry.owners, engine.geometries.at(handle_at(engine.meshes, clone).geometry).owners}},
        {"separate", geometryIndex != handle_at(engine.meshes, clone).geometry},
        {"cpuAlias", handle_at(engine.meshes, mesh).cpu_streams == handle_at(engine.meshes, clone).cpu_streams && handle_at(engine.meshes, clone).cpu_streams->positions->at(0) == 4 && handle_at(engine.meshes, mesh).cpu_streams->uvs2->at(0) == 0.25f && handle_at(engine.meshes, mesh).cpu_streams->colors->at(0) == 0.5f},
        {"inactive", handle_at(engine.meshes, inactive).geometry == old},
        {"skipped", handle_at(engine.meshes, skipped).geometry == skippedGeometry},
        {"bounds", {{geometry.bounds_min.x, geometry.bounds_min.y, geometry.bounds_min.z}, {geometry.bounds_max.x, geometry.bounds_max.y, geometry.bounds_max.z}}}
    };
    assert(engine.geometries.at(old).owners == 1);
    engine.device_recovery->registrations.clear();
    const auto uncaptured = create_retained_mesh_from_data(engine, "uncaptured", positions, normals, indices, uvs, uvs2, tangents, colors);
    assert(!handle_at(engine.meshes, uncaptured).cpu_streams->uvs2 && !handle_at(engine.meshes, uncaptured).cpu_streams->colors);
    update_mesh_positions(engine, mesh, {8,8,8}, 0, 1, 0);
    recover_retained_meshes(engine);
    verifyMetadata(engine.geometries.at(handle_at(engine.meshes, mesh).geometry), oldVersion + 3);
    const MeshCpuStreamsView twice(MeshRecord{}, &engine.geometries.at(handle_at(engine.meshes, mesh).geometry));
    nlohmann::json actual{{"once", once}, {"twicePositions", twice.positions.copy()}};
    nlohmann::json expected; std::ifstream("expected.json") >> expected;
    if (actual != expected) std::cerr << actual.dump() << " expected=" << expected.dump() << '\\n';
    assert(actual == expected);
}
`,
    );
    runNativeFixtureCompiler(native, [
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        file,
    ]);
    assert.equal(
        execFileSync(executable, {
            cwd: directory,
            encoding: "utf8",
            timeout: 10_000,
        }),
        "",
    );
});
