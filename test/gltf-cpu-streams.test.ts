import assert from "node:assert/strict";
import test from "node:test";
import {
    packageGltfMeshPlan,
    packagedGltfMeshPlan,
} from "../src/gltf-mesh-plan.js";
import { BinaryBuilder } from "../src/glb-binary-builder.js";
import { readGlb } from "../src/glb-container.js";
import { packageGltfLoadPlan } from "../src/gltf-load-plan.js";
import { GltfGeometryPacker } from "../src/gltf-mesh-geometry.js";
import { type JsonObject } from "../src/json-fields.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { gltfCpuStreamsCpp } from "../src/lowering/gltf/cpu-streams.js";
import { doctoredContext } from "./doctored-store.js";
import { buildGlb } from "./glb-fixture.js";
import {
    meshPlanFixture,
    readPackedGltfAttribute,
} from "./gltf-mesh-fixture.js";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("glTF CPU capture uses source owners independently of GPU uploads", async () => {
    const fixture = meshPlanFixture({
        nodes: [{ mesh: 0 }, { mesh: 0 }],
        meshes: [{ primitives: [{}] }],
        scenes: [{ nodes: [0, 1] }],
    });
    const binary = await packageGltfMeshPlan(
        fixture.document,
        fixture.bin,
        doctoredContext(
            "src/loader-gltf/load-gltf.ts",
            "positionBuffer: createMappedBuffer(engine, meshData._positions!, BU.VERTEX)",
            "positionBuffer: createMappedBuffer(engine, meshData._positions!.map(value => value * 2), BU.VERTEX)",
        ),
        { cpuGeometry: true },
    );
    const plan = packagedGltfMeshPlan(fixture.document);
    const first = plan.meshes[0]!.cpu!,
        second = plan.meshes[1]!.cpu!;
    assert.deepEqual(
        first,
        second,
        "source clones retain the same CPU array owners",
    );
    assert.deepEqual(
        readPackedGltfAttribute(fixture.document, binary, first.positions!),
        [0, 0, 0, 1, 0, 0, 0, 1, 0],
    );
    assert.deepEqual(
        readPackedGltfAttribute(
            fixture.document,
            binary,
            plan.geometries[0]!.attributes.POSITION!,
        ),
        [0, 0, 0, 2, 0, 0, 0, 2, 0],
    );
    assert.deepEqual(
        readPackedGltfAttribute(fixture.document, binary, first.indices!),
        [0, 1, 2],
    );
    assert.equal(first.tangents, undefined);
    const plain = meshPlanFixture({
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{}] }],
        scenes: [{ nodes: [0] }],
    });
    await packageGltfMeshPlan(plain.document, plain.bin);
    assert.equal(
        packagedGltfMeshPlan(plain.document).meshes[0]!.cpu,
        undefined,
    );
});

test("packaged glTF CPU streams carry only their asset's bytes", async () => {
    // A small binary chunk is what Node would copy into its shared slab.
    const fixture = meshPlanFixture({
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{}] }],
        scenes: [{ nodes: [0] }],
    });
    const glb = buildGlb(fixture.document, Buffer.from(fixture.bin.buffer));
    const packaged: Buffer[] = [];
    for (const fill of ["a", "b"]) {
        // Earlier unrelated allocations differ from run to run (and from
        // checkout to checkout); the packaged asset must not.
        for (let length = 1; length < 64; ++length)
            Buffer.from(fill.repeat(length));
        packaged.push(
            Buffer.from(
                await packageGltfLoadPlan(glb, "small", { cpuGeometry: true }),
            ),
        );
    }
    assert.deepEqual(packaged[0], packaged[1]);
    for (const chunk of [
        readGlb(glb)!.binary,
        new BinaryBuilder(Buffer.from("tiny")).build(),
    ]) {
        assert.equal(chunk.byteOffset, 0);
        assert.equal(chunk.buffer.byteLength, chunk.byteLength);
    }
});

test("glTF CPU transport retains subviews, shared backing bytes and private aliases", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler unavailable");
        return;
    }
    const document: JsonObject = {};
    const packer = new GltfGeometryPacker(
        document,
        new DataView(new ArrayBuffer(0)),
    );
    const data = new Float32Array([99, 1, 2, 3, 4, 99]);
    const positions = data.subarray(1, 4),
        normals = data.subarray(2, 5),
        indices = new Uint32Array([0, 1, 2]);
    const p = packer.cpuArray(positions),
        n = packer.cpuArray(normals),
        i = packer.cpuArray(indices);
    assert.equal(packer.cpuArray(positions), p);
    const binary = packer.build();
    const source = new GltfLowerer(new LoweringContext()).lowerLoaderAdapter({
        cpuGeometry: true,
    }).source;
    const views = packer.bufferViews
        .map((v) => `{${Number(v.byteOffset)},${Number(v.byteLength)},0}`)
        .join(",");
    const accessors = packer.accessors
        .map(
            (a) =>
                `{${Number(a.bufferView)},${Number(a.byteOffset ?? 0)},${Number(a.count)},${Number(a.componentType)},"SCALAR",false}`,
        )
        .join(",");
    runGeneratedProgram(
        tools,
        "gltf-cpu-owner-check",
        `#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <cassert>
namespace bbl {
using JsonObject=ts::JsonValue::Object;
namespace upstream {struct ParsedGlbContainer {std::size_t bin_offset=0,bin_length=0;};}
${cppFunction(source, "const ts::JsonValue* optional(")}
${cppFunction(source, "std::size_t unsigned_value(")}
${cppRecord(source, "struct BufferViewInfo {")}
${cppRecord(source, "struct AccessorInfo {")}
${gltfCpuStreamsCpp()}
}
int main(){using namespace bbl;
ts::ArrayBuffer binary(std::vector<std::uint8_t>{${[...binary].join(",")}});
upstream::ParsedGlbContainer container{0,${binary.length}};
std::vector<BufferViewInfo> views{${views}};
std::vector<AccessorInfo> accessors{${accessors}};
const auto cpu=ts::json_parse(R"json({"positions":${p},"normals":${n},"indices":${i}})json");
GltfCpuStreamCache cache;
Engine engine;
MeshRecord a;a.cpu_streams=read_gltf_cpu_streams(cpu.as_object(),cache,binary,container,views,accessors);
MeshRecord b;b.cpu_streams=read_gltf_cpu_streams(cpu.as_object(),cache,binary,container,views,accessors);
const auto ah=store_mesh_record(engine,std::move(a)),bh=store_mesh_record(engine,std::move(b));
auto pa=mesh_cpu_stream_owner(engine,ah,&MeshCpuStreams::positions).value();
auto pb=mesh_cpu_stream_owner(engine,bh,&MeshCpuStreams::positions).value();
auto normal=mesh_cpu_stream_owner(engine,ah,&MeshCpuStreams::normals).value();
assert(pa.identity()==pb.identity());assert(pa.byte_offset()==4);assert(normal.byte_offset()==8);
assert(pa.buffer().identity()==normal.buffer().identity());assert(pa.buffer().byte_length()==24);
pa.store(1,77);assert(pb.load(1)==77);assert(normal.load(0)==77);
assert(!mesh_cpu_stream_owner(engine,ah,&MeshCpuStreams::uvs).has_value());
auto index=mesh_cpu_stream_owner(engine,ah,&MeshCpuStreams::indices).value();assert(index.load(1)==1);
GltfCpuStreamCache independent;auto other=read_gltf_cpu_streams(cpu.as_object(),independent,binary,container,views,accessors);
assert(other->positions->identity()!=pa.identity());assert(other->positions->load(1)==2);
}
`,
        { flags: ["/Gy"], timeoutMs: 10000 },
    );
    assert.match(source, /record.cpu_streams = read_gltf_cpu_streams/);
    assert.doesNotMatch(
        new GltfLowerer(new LoweringContext()).lowerLoaderAdapter().source,
        /record.cpu_streams = read_gltf_cpu_streams/,
    );
});
