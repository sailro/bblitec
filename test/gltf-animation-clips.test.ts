import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf/loader.js";
import { lowerGltfAnimationClips } from "../src/lowering/gltf/animation-clips.js";
import { lowerGltfAnimationSamplers } from "../src/lowering/gltf/animation-samplers.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { lowerGltfMaterialAssembly } from "../src/lowering/gltf/material-assembly.js";
import { lowerGltfMaterialTextures } from "../src/lowering/gltf/material-textures.js";
import { lowerGltfFactorBake } from "../src/lowering/gltf/factor-bake.js";
import { gltfMaterialValueRuntime } from "../src/lowering/gltf/material-value-runtime.js";
import { lowerGltfSamplers } from "../src/lowering/gltf/sampler-resolver.js";
import { lowerGltfDefaultSampler } from "../src/lowering/gltf/sampler-mapping.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, cppRecord, cppSection, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const module = "src/loader-gltf/gltf-animation.ts";
const converterModule = "src/loader-gltf/gltf-sampler-denorm.ts";
type Sampler = { input: Float32Array; output: Float32Array; interpolation: number };
type Channel = { samplerIdx: number; nodeIdx: number; path: number };
type Clip = { name: string; samplers: Sampler[]; channels: Channel[]; duration: number };

test("native animation clips execute pinned sampling, filtering, order and unused-sampler duration", async t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(module, "duration = last;", "duration = last + 0.25;"),
        doctoredContext(module, 's.interpolation ?? "LINEAR"', 's.interpolation ?? "STEP"'),
        doctoredContext(module, "samplerIdx: c.sampler,", "samplerIdx: c.sampler + 1,"),
        doctoredContext(module, 'name: anim.name ?? ""', 'name: anim.name ?? "unnamed"'),
        doctoredContext(module, "inputAcc._count, inNorm", "inputAcc._count - 1, inNorm"),
        doctoredContext(converterModule, "src instanceof I8 ? 127", "src instanceof I8 ? 63"),
        doctoredContext(module, "_parsePointerChannel(ptr, c,", '_parsePointerChannel("/ignored", c,'),
    ];
    const constants = await importPinnedModule<Record<string, number>>("animation/types.js");
    const parser = await importPinnedModule<{ resolveAccessor: (json: object, bin: DataView, index: number) => object }>("loader-gltf/gltf-parser.js");
    const arrays = [new Float32Array([0, 1]), new Float32Array([1, 2, 3, 4, 5, 6]),
        new Float32Array([0, 9]), new Int8Array([-128, -64, 0, 127, -127, 64, 32, -32]), new Uint16Array([0, 65535])];
    const bytes = new Uint8Array(256);
    const types = ["SCALAR", "VEC3", "SCALAR", "VEC4", "SCALAR"];
    const componentTypes = [5126, 5126, 5126, 5120, 5123];
    let offset = 8;
    const views = arrays.map(array => {
        const view = { buffer: 0, byteOffset: offset, byteLength: array.byteLength };
        bytes.set(new Uint8Array(array.buffer), offset); offset = Math.ceil((offset + array.byteLength) / 4) * 4; return view;
    });
    const document = {
        nodes: [{}], bufferViews: views,
        accessors: arrays.map((array, index) => ({ bufferView: index, componentType: componentTypes[index], type: types[index], count: array.length / (index === 1 ? 3 : index === 3 ? 4 : 1), normalized: index >= 3 })),
        animations: [{ samplers: [{ input: 0, output: 1 }, { input: 2, output: 3, interpolation: "UNKNOWN" }, { input: 0, output: 4, interpolation: "STEP" }],
            channels: [{ sampler: 0, target: { node: 0, path: "translation" } }, { sampler: 0, target: { path: "translation" } },
                { sampler: 0, target: { node: 0, path: "unused" } }, { sampler: 0, target: { node: 0 } },
                { sampler: 2, target: { extensions: { KHR_animation_pointer: { pointer: "/enabled" } } } },
                { sampler: 2, target: { extensions: { KHR_animation_pointer: { pointer: "/ignored" } } } }] },
            { name: "second", samplers: [{ input: 0, output: 3, interpolation: "CUBICSPLINE" }], channels: [{ sampler: 0, target: { node: 0, path: "rotation" } }] }],
    };
    const expected = contexts.map(context => {
        const file = context.sourceFile(module);
        const source = ["INTERP_MAP", "PATH_MAP"].map(name => `const ${name} = ${context.moduleScopeConstant(file, name)!.getText()};`).join("\n") +
            ["toSamplerFloat32", "hasWritableNodeChannel", "parseAnimationData"].map(name => context.functionDeclaration(module, name).declaration.getText()).join("\n");
        const registration = context.findNodes(context.sourceFile(converterModule), (node): node is ts.CallExpression => ts.isCallExpression(node) && context.expressionMatchesShape(node.expression, "_installSamplerConverter"))[0]!;
        const convert = new Function("F32", "I8", "I16", "U8", transpileCommonJs(`const convert = ${registration.arguments[0]!.getText()};`, converterModule) + "\nreturn convert;")(Float32Array, Int8Array, Int16Array, Uint8Array) as (src: ArrayBufferView, length: number, normalized: boolean) => Float32Array;
        const parse = new Function("exports", "F32", "_convertSampler", "_parsePointerChannel", "resolveAccessor", "findParent", ...Object.keys(constants),
            transpileCommonJs(source, module) + "\nreturn parseAnimationData;")({}, Float32Array, convert,
                (ptr: string, channel: { sampler: number }) => ptr === "/ignored" ? null : { samplerIdx: channel.sampler, nodeIdx: -1, path: -1 },
                parser.resolveAccessor, () => -1, ...Object.values(constants)) as
                (json: object, bin: DataView, meshes: object[], parents: object, worlds: object, nodes: object[]) => { clips: Clip[] } | null;
        const result = parse(document, new DataView(bytes.buffer), [], new Map(), new Map(), [{}]);
        assert.ok(result);
        return result.clips.map(clip => ({ ...clip, samplers: clip.samplers.map(sampler => ({ ...sampler, input: [...sampler.input], output: [...sampler.output] })) }));
    });
    const context = contexts[0]!;
    const loader = new GltfLowerer(context).lowerLoaderAdapter().source;
    const helpers = cppSection(loader, "std::size_t component_count(", "Vec4 normalize_quaternion(");
    const output = resolve("artifacts/gltf-animation-clips"); mkdirSync(output, { recursive: true });
    writeFileSync(join(output, "cases.json"), JSON.stringify({ document, bytes: [...bytes], expected }));
    const source = join(output, "check.cpp"), executable = join(output, "check.exe");
    writeFileSync(source, `#include <bblite/ts_runtime.hpp>
        #include <bblite/runtime.hpp>
        #include <bblite/pal_image_canvas.hpp>
        #include <cassert>
        #include <fstream>
        #include <iostream>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object; using JsonArray = ts::JsonValue::Array;
            namespace upstream { ${cppRecord(new GltfLowerer(context).lowerGlbParser().header, "struct ParsedGlbContainer {")} }
            ${loader.slice(loader.indexOf("struct BufferViewInfo {"), loader.indexOf("using Matrix ="))}
            ${["const ts::JsonValue& required(", "const ts::JsonValue* optional(", "std::size_t unsigned_value(", "std::size_t unsigned_or(", "float float_or(", "std::string string_or(", "std::vector<double> double_array("].map(signature => cppFunction(loader, signature)).join("\n")}
            ${lowerGltfParserJson(context)}
            ${helpers}
            ${lowerGltfMaterialAssembly(context)}
            ${lowerGltfFactorBake(context.sourceFile("src/math/color.ts"))}
            ${lowerGltfMaterialTextures(context)}
            ${gltfMaterialValueRuntime}
            ${lowerGltfDefaultSampler(context)}
            ${lowerGltfSamplers(context)}
            ${contexts.map((context, index) => `namespace variant${index} { ${lowerGltfAnimationSamplers(context)}\n${lowerGltfAnimationClips(context)} }`).join("\n")}
        }
        int main() try {
            using namespace bbl;
            nlohmann::json cases; std::ifstream("cases.json") >> cases;
            upstream::ParsedGlbContainer container; container.json = ts::JsonValue::from_native(cases.at("document"));
            const ts::ArrayBuffer buffer(cases.at("bytes").get<std::vector<std::uint8_t>>());
            container.bin_length = buffer.byte_length();
            std::vector<BufferViewInfo> views;
            for (const auto& row : cases.at("document").at("bufferViews")) { BufferViewInfo view; view.offset = row.at("byteOffset").get<std::size_t>(); view.length = row.at("byteLength").get<std::size_t>(); views.push_back(view); }
            std::vector<AccessorInfo> accessors;
            for (const auto& row : cases.at("document").at("accessors")) { AccessorInfo acc; acc.buffer_view = row.at("bufferView").get<std::size_t>(); acc.component_type = row.at("componentType").get<std::uint32_t>(); acc.count = row.at("count").get<std::size_t>(); acc.type = row.at("type").get<std::string>(); acc.normalized = row.at("normalized").get<bool>(); accessors.push_back(acc); }
            ${contexts.map((_context, index) => `{
                using namespace variant${index};
                const auto resolve_accessor = [&](double index) { return GltfAccessorView{buffer, container, views, accessors.at(gltf_checked_index(index))}; };
                const auto to_float32 = [&](const GltfAccessorView& view, double length, bool normalized) {
                    auto values = gltf_animation_sampler_float32(view, length, normalized, true);
                    return GltfAnimationSamples{std::move(values), view.accessor.type};
                };
                const auto pointer = [](GltfPbrValue ptr, GltfPbrValue channel) {
                    if (ptr.string() == "/ignored") return js::Ref<GltfParsedChannel>{};
                    auto result = js::make_ref<GltfParsedChannel>(); result->samplerIdx = channel.get("sampler").number(); result->nodeIdx = -1; result->path = -1; return result;
                };
                const auto result = gltf_animation_clips(GltfPbrValue{&container.json}, resolve_accessor, to_float32, true, pointer);
                auto actual = nlohmann::json::array();
                for (const auto& clip : result.clips) {
                    auto channels = nlohmann::json::array(), samplers = nlohmann::json::array();
                    for (const auto& channel : clip->channels) channels.push_back({{"samplerIdx", channel->samplerIdx}, {"nodeIdx", channel->nodeIdx}, {"path", channel->path}});
                    for (const auto& sampler : clip->samplers) samplers.push_back({{"input", sampler->input.values}, {"output", sampler->output.values}, {"interpolation", sampler->interpolation}});
                    actual.push_back({{"name", clip->name}, {"duration", clip->duration}, {"channels", channels}, {"samplers", samplers}});
                }
                if (actual != cases.at("expected")[${index}]) { std::cerr << "variant ${index}: " << actual.dump() << '\\n'; return 1; }
                assert(result.pointer_channel_count == ${expected[index]!.flatMap(clip => clip.channels).filter(channel => channel.path === -1).length});
                const auto disabled = gltf_animation_clips(GltfPbrValue{&container.json}, resolve_accessor, to_float32, false, pointer);
                assert(disabled.pointer_channel_count == 0 && disabled.clips.at(0)->channels.size() == 1);
                for (const auto& value : {nlohmann::json::object(), nlohmann::json{{"animations", nullptr}}, nlohmann::json{{"animations", nlohmann::json::array()}}}) {
                    const auto empty = ts::JsonValue::from_native(value);
                    assert(gltf_animation_clips(GltfPbrValue{&empty}, resolve_accessor, to_float32, true, pointer).clips.empty());
                }
                assert(gltf_needs_animation_sampler_converter(GltfPbrValue{&container.json}).truthy());
                const auto float_view = resolve_accessor(0);
                assert(gltf_animation_sampler_float32(float_view, 2, false, false) == std::vector<float>({0, 1}));
                assert(gltf_animation_sampler_float32(float_view, 2, true, true) == std::vector<float>({0, 1}));
                bool refused = false;
                try { gltf_animation_sampler_float32(float_view, 3, false, false); } catch (const std::exception&) { refused = true; }
                assert(refused);
                views[0].stride = 8;
                refused = false;
                try { gltf_animation_sampler_float32(float_view, 2, false, true); } catch (const std::exception&) { refused = true; }
                assert(refused);
                views[0].stride = 0;
                refused = false;
                try { GltfAnimationSamples incomplete({1, 2}, "VEC3"); } catch (const std::exception&) { refused = true; }
                assert(refused);
            }`).join("\n")}
        } catch (const std::exception& error) { std::cerr << error.what() << '\\n'; return 2; }`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD", "/O2",
        `/Fo:${output}/`, `/Fe:${executable}`, "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    assert.equal(execFileSync(executable, { cwd: output, encoding: "utf8" }), "");
});

test("unrepresented animation clip ownership and fields refuse", () => {
    assert.throws(() => lowerGltfAnimationClips(doctoredContext(module, "resolveAccessor(json, binChunk, s.input)", "resolveAccessor(otherJson, binChunk, s.input)")), /Animation accessor document/);
    assert.throws(() => lowerGltfAnimationClips(doctoredContext(module, "ptr, c, nodeMap, json, meshes", "ptr, c, otherNodes, json, meshes")), /Animation pointer owner/);
    assert.throws(() => lowerGltfAnimationClips(doctoredContext(module, "samplerIdx: c.sampler,", "extra: 1, samplerIdx: c.sampler,")), /complete declared shape/);
    assert.throws(() => lowerGltfAnimationSamplers(doctoredContext(converterModule, "src.byteOffset, length", "0, length")), /Animation sampler offset/);
});
