import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { composePinnedPbrVariant } from "../src/pinned-pbr-variants.js";
import { pinnedPbrVariantsHeader } from "../src/pinned-pbr-variant-cpp.js";
import {
    enablePinnedMaterialPlugins,
    pinnedPlugins,
} from "../src/pinned-material-plugins.js";
import { inlineCpp } from "./generated-cpp.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("PBR plugin writers use live closures, byte offsets and retained UBO views", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    await enablePinnedMaterialPlugins([]);
    const variant = await composePinnedPbrVariant({
        plugins: pinnedPlugins([
            {
                name: "values",
                uniforms: [
                    { name: "pluginScalar", type: "f32" },
                    { name: "pluginVector", type: "vec3<f32>" },
                ],
            },
        ]),
    });
    const spec = variant.materialUboSpec as {
        _offsets: Map<string, number>;
        _totalBytes: number;
        _structBody: string;
    };
    const header = inlineCpp(
        pinnedPbrVariantsHeader(
            new LoweringContext(),
            variant.vertexWgsl,
            368,
            20,
            4,
            "test",
            [
                {
                    fragmentKey: variant.fragmentKey,
                    pipeline: "test",
                    selectors: [],
                    vertex: "",
                    fragment: "",
                    vertexWgsl: variant.vertexWgsl,
                    fragmentWgsl: variant.fragmentWgsl,
                    materialUbo: {
                        ...spec,
                        _offsets: Object.fromEntries(spec._offsets),
                    },
                    pluginUniformFields: ["pluginScalar", "pluginVector"],
                },
            ],
            [],
            [],
        ),
    );
    const start = header.indexOf("struct PbrTestMaterialUniforms"),
        end = header.indexOf("inline void write_PbrTest_material", start);
    assert.ok(start >= 0 && end > start);
    const directory = resolve("artifacts/material-plugin-uniforms-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/pal_material_plugin.hpp>\n#include <cassert>\nnamespace bbl::upstream {\n${header.slice(start, end)}\n${cppFunction(header, "inline void write_PbrTest_material(")}\n${cppFunction(header, "void write_pbr_variant_material(")}\n}
int main(){
 bbl::MaterialRecord material;material.alpha=0.75f;
 material.plugin_uniform_writers=std::make_shared<std::vector<bbl::MaterialRecord::PluginUniformWriter>>();
 bbl::js::F32Array retained; bbl::js::Map<std::string,double> retainedOffsets; double value=2;
 material.plugin_uniform_writers->push_back([&](bbl::js::F32Array data,bbl::js::Map<std::string,double> offsets){retained=data;retainedOffsets=offsets;data[static_cast<std::size_t>(offsets.get("pluginScalar").value()/4)]=static_cast<float>(value);material.plugin_uniform_writers.reset();material.plugin_uniform_states.clear();});
 auto list=material.plugin_uniform_writers;
 list->push_back([&](bbl::js::F32Array data,bbl::js::Map<std::string,double> offsets){const auto base=static_cast<std::size_t>(offsets.get("pluginVector").value()/4);data[base]=3;data[base+1]=4;data[base+2]=5;});
 bbl::upstream::PbrTestMaterialUniforms block{};
 bbl::upstream::write_pbr_variant_material(0,material,&block,sizeof(block));
 assert(block.pluginScalar==2&&block.pluginVector[0]==3&&block.pluginVector[2]==5&&block.materialAlpha==0.75f);
 assert(retained[static_cast<std::size_t>(retainedOffsets.get("pluginScalar").value()/4)]==2);
 material.plugin_uniform_writers=list;value=7;
 bbl::upstream::write_pbr_variant_material(0,material,&block,sizeof(block));assert(block.pluginScalar==7);
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
