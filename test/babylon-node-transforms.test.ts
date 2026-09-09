import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { lowerBabylonNodeTransforms } from "../src/lowering/babylon-node-transforms.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import { LoweringContext } from "../src/lowering/context.js";
import { importPinnedModuleFetching } from "../src/pinned-shader-composer.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("Babylon mesh and container transforms preserve source defaults and world composition", async t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const inputs = [
        {}, { position: null, rotation: null, scaling: null },
        { position: [16777217, -.1234567890123, .7], rotation: [.37, -.71, 1.19], scaling: [2.5, -1, .25] },
        { position: [5, 7], rotation: [.125], scaling: [0, .5] },
    ];
    const document = { meshes: inputs.flatMap((input, index) => [
        { ...input, id: `m${index}`, name: `m${index}`, positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] },
        { ...input, id: `c${index}`, name: `c${index}` },
    ]) };
    const imported = await importPinnedModuleFetching<{
        loadBabylon(engine: object, url: string, options: object): Promise<{ entities: Array<{
            name: string; position: { x: number; y: number; z: number }; worldMatrix: Float32Array;
        }> }>;
    }>("loader-babylon/load-babylon.js", () => Buffer.from(JSON.stringify(document)));
    let expected: Record<string, { position: number[]; world: number[] }>;
    try {
        const loaded = await imported.module.loadBabylon({ _device: { createBuffer({ size }: { size: number }) {
            const bytes = new ArrayBuffer(size); return { getMappedRange: () => bytes, unmap() {} };
        } } }, "https://fixture/transforms.babylon", { loadTextures: false });
        expected = Object.fromEntries(loaded.entities.map(node => [node.name, {
            position: [node.position.x, node.position.y, node.position.z], world: [...node.worldMatrix],
        }]));
        assert.equal(Object.keys(expected).length, 8);
    } finally { imported.release(); }
    const context = new LoweringContext();
    const loader = new BabylonLowerer(context).lowerLoaderAdapter().source;
    const changed = cppFunction(lowerBabylonNodeTransforms(doctoredContext("src/loader-babylon/load-babylon.ts",
        "md.scaling?.[2] ?? 1\n                    );", "md.scaling?.[2] ?? 2\n                    );")),
        "upstream::TrsLanes babylon_mesh_transform(").replace("babylon_mesh_transform(", "changed_mesh_transform(");
    const directory = resolve("artifacts/test-babylon-node-transforms");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "world.hpp"), pinnedWorldTransformHeader(context));
    writeFileSync(join(directory, "inputs.json"), JSON.stringify(inputs));
    writeFileSync(join(directory, "expected.json"), JSON.stringify(expected));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include "world.hpp"
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
namespace bbl {
using Json=nlohmann::json;
${cppFunction(loader, "double double_at(")}
${lowerBabylonNodeTransforms(context)}
${changed}
}
int main() {
    using namespace bbl;
    Json inputs, expected;
    std::ifstream("inputs.json") >> inputs;
    std::ifstream("expected.json") >> expected;
    for(std::size_t row=0;row<inputs.size();++row) for(const auto kind:{'m','c'}) {
        const auto transform=kind=='m'?babylon_mesh_transform(inputs[row]):babylon_container_transform(inputs[row]);
        const auto& want=expected.at(std::string(1,kind)+std::to_string(row));
        assert(transform.position.x==want.at("position")[0].get<double>());
        assert(transform.position.y==want.at("position")[1].get<double>());
        assert(transform.position.z==want.at("position")[2].get<double>());
        const auto world=upstream::trs_matrix(transform);
        for(std::size_t cell=0;cell<16;++cell) {
            const auto wanted=want.at("world")[cell].get<double>();
            assert(std::abs(double(world[cell])-wanted)<=1e-6*std::max(1.0,std::abs(wanted)));
        }
    }
    assert(changed_mesh_transform(Json::object()).scaling.z==2);
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});
