import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("thin CPU consumers retain live double views", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native) {
        t.skip("Native compiler required for CPU thin-instance consumers.");
        return;
    }
    const vertex = readFileSync("native/src/pal_gpu_vertex.hpp", "utf8");
    const capture = readFileSync("native/src/pal_render_capture.hpp", "utf8");
    const output = runGeneratedProgram(
        native,
        "thin-instance-consumers",
        `#include <bblite/runtime.hpp>
#include <cassert>
#include <iomanip>
#include <iostream>
#include <sstream>
namespace bbl::pal {
${cppFunction(vertex, "inline bool pinned_record_instanced(")}
${cppFunction(capture, "class JsonWriter {")};
${cppFunction(capture, "inline const char* topology_name(")}
${cppFunction(capture, "inline void write_mesh(")}
}
int main() {
    bbl::Engine engine;
    bbl::MeshRecord mesh;
    assert(!bbl::pal::pinned_record_instanced(mesh));
    mesh.thin_instances = std::make_shared<bbl::ThinInstancePoolData>();
    auto backing = bbl::js::F64Array(48);
    auto view = bbl::js::typed_array_subarray(backing, 8, 40);
    mesh.thin_instances->matrices = view;
    mesh.thin_instances->count = 1;
    backing.store(20, 1.0000000000000002);
    const auto view_values = bbl::thin_instance_matrix_values(*mesh.thin_instances);
    assert(view_values.load(12) == 1.0000000000000002);
    auto clone = mesh;
    assert(clone.thin_instances == mesh.thin_instances);
    backing.store(20, 1.0000000000000004);
    assert(view_values.load(12) == 1.0000000000000004);
    assert(bbl::pal::pinned_record_instanced(mesh));
    bbl::pal::JsonWriter json(std::cout);
    bbl::pal::write_mesh(json, 0, clone, engine);
}`,
    );
    const mesh = JSON.parse(output) as {
        thinInstanced: boolean;
        instanceCount: number;
        loaderInstanceCount: number;
        instanceMatrices: number[];
    };
    assert.equal(mesh.thinInstanced, true);
    assert.equal(mesh.instanceCount, 1);
    assert.equal(mesh.loaderInstanceCount, 2);
    assert.equal(mesh.instanceMatrices.length, 16);
    assert.equal(mesh.instanceMatrices[12], 1.0000000000000004);
});
