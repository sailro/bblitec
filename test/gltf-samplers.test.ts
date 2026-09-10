import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf/loader.js";
import { gltfSamplerDeclarations, lowerGltfSamplers } from "../src/lowering/gltf/sampler-resolver.js";
import { lowerGltfDefaultSampler } from "../src/lowering/gltf/sampler-mapping.js";
import { gltfMaterialValueRuntime } from "../src/lowering/gltf/material-value-runtime.js";
import { lowerGltfMaterialTextures } from "../src/lowering/gltf/material-textures.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const module = "src/loader-gltf/gltf-sampler-desc.ts";

test("glTF sampler lookup, descriptors and sharing execute the pinned source", t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const contexts = [new LoweringContext(),
        doctoredContext(module, "m === 33071", "m === 33099"),
        doctoredContext(module, "minF === 9984 || minF === 9985", "minF === 9987 || minF === 9985"),
        doctoredContext(module, "desc.lodMaxClamp === 0", "desc.lodMaxClamp === 1000"),
        doctoredContext(module, "json.samplers?.[json.textures[texInfo.index].sampler]", "json.samplers?.[0]"),
        doctoredContext("src/resource/gpu-pool.ts", 'desc.addressModeU ?? "clamp-to-edge"', '"repeat"'),
    ];
    const inputs: { textures?: object[] | null; samplers?: object[] | null }[] = [
        {}, { textures: null, samplers: null }, { textures: [{}, { sampler: null }, { sampler: 4 }], samplers: [] },
        { textures: [{ sampler: 0 }, { sampler: 1 }, { sampler: 2 }], samplers: [{}, { minFilter: 9728 }, { wrapS: 33071 }] },
    ];
    for (const minFilter of [undefined, 0, 1.5, -2, 9728, 9729, 9984, 9985, 9986, 9987]) {
        inputs.push({ textures: [{ sampler: 0 }, { sampler: 1 }, { sampler: 2 }, {}, { sampler: 0 }],
            samplers: [{ minFilter, magFilter: 9729 }, { minFilter, magFilter: 9728, wrapS: 33071, wrapT: 33648 },
                { minFilter, magFilter: 9729, wrapS: 33099, wrapT: 33071 }] });
    }
    const directory = resolve("artifacts/gltf-samplers");
    mkdirSync(directory, { recursive: true });
    const outputs = contexts.map(context => {
        const { declaration } = context.functionDeclaration("src/loader-gltf/load-gltf.ts", "uploadMeshes");
        const sampler = context.findNodes(declaration, (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "sampler")[0];
        assert.ok(sampler?.initializer && ts.isCallExpression(sampler.initializer));
        const source = [context.functionDeclaration(module, "gltfTexSamplerDesc").declaration.getText(),
            context.functionDeclaration(module, "makeSamplerFor").declaration.getText(),
            context.functionDeclaration("src/resource/gpu-pool.ts", "samplerKey").declaration.getText(),
            `function defaults() { return ${sampler.initializer.arguments[1]!.getText()}; }`].join("\n");
        const js = transpileCommonJs(source, module);
        const execute = new Function("exports", "getOrCreateSampler", `${js}\nreturn {gltfTexSamplerDesc,makeSamplerFor,samplerKey,defaults};`)({},
            (_engine: object, descriptor: object) => cached(descriptor)) as {
                gltfTexSamplerDesc(json: object, info: object): object;
                makeSamplerFor(engine: object, json: object, defaultSampler: object): (info: object | null) => object;
                samplerKey(descriptor: object): string; defaults(): object;
            };
        let serial = 0;
        let pool = new Map<string, { serial: number; descriptor: object }>();
        const create = (descriptor: object) => ({ serial: ++serial, descriptor });
        const cached = (descriptor: object) => {
            const key = execute.samplerKey(descriptor);
            let sampler = pool.get(key);
            if (!sampler) { sampler = create(descriptor); pool.set(key, sampler); }
            return sampler;
        };
        return inputs.map(input => {
            serial = 0; pool = new Map();
            const registered: object[] = [], defaultSampler = cached(execute.defaults());
            const resolver = execute.makeSamplerFor({ _device: { createSampler: create },
                _deviceLostRecovery: { _samplerDescriptors: { set(sampler: object) { registered.push(sampler); } } } }, input, defaultSampler);
            const infos = [null, { index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }, { index: 4 }, { index: 0 }, { index: 1 }];
            const identities: object[] = [];
            const samplers = infos.map(info => {
                const sampler = resolver(info);
                if (!identities.includes(sampler)) identities.push(sampler);
                return identities.indexOf(sampler);
            });
            return { input, infos, descriptors: infos.slice(1).map(info => execute.gltfTexSamplerDesc(input, info!)),
                samplers, serial, registered: registered.length };
        });
    });
    writeFileSync(join(directory, "cases.json"), JSON.stringify(outputs));
    const file = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(file, `#include <bblite/runtime.hpp>
        #include <bblite/ts_runtime.hpp>
        #include <fstream>
        namespace bbl {
            using JsonObject = ts::JsonValue::Object;
            using JsonArray = ts::JsonValue::Array;
            using GltfMaterialImage = std::shared_ptr<int>;
            ${cppFunction(new GltfLowerer(contexts[0]!).lowerLoaderAdapter().source, "const ts::JsonValue* optional(")}
            ${gltfSamplerDeclarations}
            struct GltfPbrObject;
            ${cppFunction(lowerGltfMaterialTextures(contexts[0]!), "struct GltfTextureIdentity {")};
            ${cppFunction(lowerGltfMaterialTextures(contexts[0]!), "struct GltfMaterialTexture {")};
            ${gltfMaterialValueRuntime}
            ${contexts.map((context, variant) => `namespace variant${variant} {
                ${lowerGltfDefaultSampler(context)}
                ${lowerGltfSamplers(context).slice(0, lowerGltfSamplers(context).indexOf("GltfSamplerContext::GltfSamplerContext"))}
                void check(const nlohmann::json& rows) {
                    for (const auto& row : rows) {
                        const auto document = ts::JsonValue::from_native(row.at("input"));
                        unsigned creates = 0, registrations = 0;
                        const auto create = [&](const GltfPbrValue& descriptor) -> GltfMaterialSampler {
                            ++creates; return std::make_shared<TextureSamplerState>(gltf_project_sampler(descriptor));
                        };
                        std::unordered_map<std::string, GltfMaterialSampler> pool;
                        const auto cached = [&](const GltfPbrValue& descriptor) {
                            const auto key = gltf_source_sampler_key(descriptor).string();
                            const auto found = pool.find(key);
                            if (found != pool.end()) return found->second;
                            const auto sampler = create(descriptor); pool.emplace(key, sampler); return sampler;
                        };
                        const auto default_sampler = cached(gltf_default_sampler_descriptor());
                        std::vector<GltfMaterialSampler> identities;
                        for (std::size_t index = 0; index < row.at("infos").size(); ++index) {
                            const auto info = ts::JsonValue::from_native(row.at("infos")[index]);
                            const auto sampler = gltf_sampler_for(GltfPbrValue{&document}, index ? &info : nullptr,
                                default_sampler, create, cached, [&](const GltfMaterialSampler&, const GltfPbrValue&) { ++registrations; });
                            auto found = std::find(identities.begin(), identities.end(), sampler);
                            if (found == identities.end()) { identities.push_back(sampler); found = identities.end() - 1; }
                            assert(std::distance(identities.begin(), found) == row.at("samplers")[index]);
                            if (!index) continue;
                            const auto descriptor = gltf_source_sampler_desc(GltfPbrValue{&document}, GltfPbrValue{&info});
                            const auto& wanted = row.at("descriptors")[index - 1];
                            assert(descriptor.size() == wanted.size());
                            for (const auto& [key, value] : wanted.items()) {
                                const auto actual = descriptor.get(key);
                                if (value.is_number()) assert(actual.number() == value.get<double>());
                                else assert(actual.string() == value.get<std::string>());
                            }
                        }
                        assert(creates == row.at("serial") && registrations == row.at("registered"));
                    }
                }
            }`).join("\n")}
        }
        int main() {
            nlohmann::json cases; std::ifstream("cases.json") >> cases;
            ${contexts.map((_context, index) => `bbl::variant${index}::check(cases[${index}]);`).join("\n")}
        }`);
    runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
        "/I", "native/include", `/external:I${join(nativeFixtureVcpkgRoot, "include")}`, "/external:W0", `/Fo:${directory}/`, `/Fe:${executable}`, file]);
    execFileSync(executable, { cwd: directory, stdio: "pipe" });
});

test("glTF sampler lowering refuses descriptor fields without native storage", () => {
    assert.throws(() => lowerGltfSamplers(doctoredContext(module, "maxAnisotropy: magLinear", "lodMinClamp: 0, maxAnisotropy: magLinear")),
        /Unrepresented glTF sampler descriptor property/);
    assert.throws(() => lowerGltfSamplers(doctoredContext(module, 'mipmapFilter: mipNearest ? "nearest" : "linear",', "")),
        /Incomplete glTF sampler descriptor/);
});
