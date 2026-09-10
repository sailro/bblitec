import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { GltfLowerer } from "../src/lowering/gltf-lowerer.js";
import { lowerAccessorNormalizationCpp } from "../src/lowering/gltf/accessor-normalization.js";
import { lowerGltfAccessorShape } from "../src/lowering/gltf/accessor-shape.js";
import { lowerGltfParserJson } from "../src/lowering/gltf/parser-json.js";
import { transpileCommonJs } from "../src/typescript-transpile.js";
import { doctoredContext } from "./doctored-store.js";
import { cppFunction, nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

const parserModule = "src/loader-gltf/gltf-parser.ts";
const quantizationModule = "src/loader-gltf/gltf-ext-quantization.ts";
const context = new LoweringContext();

/** Execute the pinned declaration with its module constants and typed-array imports. */
function pinned<T>(ctx: LoweringContext, module: string, symbol: string): T {
    const { file, declaration } = ctx.functionDeclaration(module, symbol);
    const constants = ["FLOAT", "UNSIGNED_SHORT", "UNSIGNED_INT", "UNSIGNED_BYTE", "BYTE", "SHORT", "TYPE_SIZES"]
        .flatMap(name => {
            const value = ctx.moduleScopeConstant(file, name);
            return value ? [`const ${name} = ${value.getText(file)};`] : [];
        });
    const code = transpileCommonJs([...constants, declaration.getText(file)].join("\n"), module);
    return new Function("exports", "F32", "U32", "U16", "U8", "I16", "I8", `${code}\nreturn ${symbol};`)(
        {}, Float32Array, Uint32Array, Uint16Array, Uint8Array, Int16Array, Int8Array) as T;
}

type NumericArray = Float32Array | Uint32Array | Uint16Array | Uint8Array | Int16Array | Int8Array;
type AccessorResolver = (json: object, bin: DataView, index: number) => { _data: NumericArray; _count: number; _componentCount: number };
type ComponentReader = (view: DataView, offset: number, componentType: number, normalized: boolean) => number;

const arrayTypes = [
    [5120, Int8Array, [-128, -127, -1, 0, 1, 127]],
    [5121, Uint8Array, [0, 1, 127, 128, 254, 255]],
    [5122, Int16Array, [-32768, -32767, -1, 0, 1, 32767]],
    [5123, Uint16Array, [0, 1, 32767, 32768, 65534, 65535]],
    [5125, Uint32Array, [0, 1, 16777217, 2147483649, 4294967294, 4294967295]],
    [5126, Float32Array, [-123.75, -.01, 0, .1, .7, 123.75]],
] as const;

test("accessor constructors cannot diverge from native binary reads", () => {
    assert.throws(() => lowerGltfAccessorShape(doctoredContext(parserModule, "Ctor = U32;", "Ctor = U16;")), /constructor does not match its native binary read/);
});

test("glTF accessors preserve pinned widths, normalization and zero-filled storage", t => {
    const native = optionalNativeFixtureTools();
    if (!native) { t.skip("Native fixture compiler unavailable."); return; }
    const resolveAccessor = pinned<AccessorResolver>(context, parserModule, "resolveAccessor");
    const readComponent = pinned<ComponentReader>(context, quantizationModule, "readComponent");
    const readerContexts = [context,
        doctoredContext(quantizationModule, "c / 65535 : c", "c / 65534 : c"),
        doctoredContext(quantizationModule, "Math.max(c / 127, -1)", "Math.max(c / 127, 0)"),
        doctoredContext(quantizationModule, "Math.max(c / 127, -1)", "Math.min(c / 127, -1)"),
    ];
    const readers = readerContexts.map(ctx => pinned<ComponentReader>(ctx, quantizationModule, "readComponent"));
    const rows = arrayTypes.flatMap(([type, Ctor, values]) => [false, true].map(normalized => {
        const bytes = new Uint8Array(28 + values.length * Ctor.BYTES_PER_ELEMENT);
        new Ctor(bytes.buffer, 28, values.length).set(values);
        const accessor = { bufferView: 0, byteOffset: 4, componentType: type, type: "SCALAR", count: values.length, normalized };
        const resolved = resolveAccessor({ accessors: [accessor], bufferViews: [{ byteOffset: 8 }] }, new DataView(bytes.buffer, 16), 0);
        assert.equal(resolved._componentCount, 1);
        return { type, normalized, bytes: [...bytes], count: values.length, raw: [...resolved._data],
            expected: [...resolved._data].map((raw, index) => type === 5125 ? raw : readComponent(new DataView(bytes.buffer), 28 + index * Ctor.BYTES_PER_ELEMENT, type, normalized)),
            readers: type === 5125 ? [] : readers.map(reader => [...resolved._data].map((_raw, index) => reader(new DataView(bytes.buffer), 28 + index * Ctor.BYTES_PER_ELEMENT, type, normalized))),
        };
    }));
    const zeroRows = ["SCALAR", "VEC2", "VEC3", "VEC4", "MAT2", "MAT3", "MAT4", "unknown"].map(type => {
        const result = resolveAccessor({ accessors: [{ type, componentType: 5126, count: 2 }] }, new DataView(new ArrayBuffer(0)), 0);
        return { type, components: result._componentCount, values: [...result._data] };
    });
    const loader = new GltfLowerer(context).lowerLoaderAdapter().source;
    const records = loader.slice(loader.indexOf("struct BufferViewInfo {"), loader.indexOf("using Matrix ="));
    const helpers = loader.slice(loader.indexOf("std::size_t component_count("), loader.indexOf("// src/loader-gltf/gltf-feature-lights-punctual.ts applyAsset:"));
    const changedReaders = readerContexts.map((ctx, index) =>
        lowerAccessorNormalizationCpp(ctx.sourceFile(quantizationModule)).replace("read_quantized_component(", `reader_${index}(`));
    const changedShape = lowerGltfAccessorShape(doctoredContext(parserModule, "MAT3: 9", "MAT3: 8"))
        .replace("component_count(", "changed_component_count(").replace("component_size(", "changed_component_size(");
    const directory = resolve("artifacts/test-gltf-accessor");
    const parserHeader = new GltfLowerer(context).lowerGlbParser().header;
    const containerStart = parserHeader.indexOf("struct ParsedGlbContainer {");
    assert.ok(containerStart >= 0);
    const containerRecord = parserHeader.slice(containerStart, parserHeader.indexOf("\n};", containerStart) + 3);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "expected.json"), JSON.stringify({ rows, zeroRows }));
    const source = join(directory, "check.cpp"), executable = join(directory, "check.exe");
    writeFileSync(source, `#include <bblite/ts_runtime.hpp>
#include <nlohmann/json.hpp>
#include <cassert>
#include <fstream>
#include <unordered_map>
namespace bbl { namespace upstream {
${containerRecord}
}
${records}
using JsonObject = ts::JsonValue::Object; using JsonArray = ts::JsonValue::Array;
${["const ts::JsonValue& required(", "const ts::JsonValue* optional("].map(signature => cppFunction(loader, signature)).join("\n")}
${lowerGltfParserJson(context)}
${helpers}
${changedReaders.join("\n")}
${changedShape}
}
int main() {
    using namespace bbl;
    using Json=nlohmann::json;
    Json expected; std::ifstream("expected.json") >> expected;
    const auto reject=[](auto operation) { bool rejected=false; try { operation(); } catch(const std::exception&) { rejected=true; } assert(rejected); };
    {
        std::vector<std::uint8_t> bytes(16 + 32 * sizeof(float));
        for (std::size_t index = 0; index < 32; ++index) {
            const float value = static_cast<float>(index) / 8.0f;
            std::memcpy(bytes.data() + 16 + index * sizeof(float), &value, sizeof(float));
        }
        const ts::ArrayBuffer buffer(bytes);
        upstream::ParsedGlbContainer container; container.bin_offset = 4; container.bin_length = buffer.byte_length() - 4;
        std::vector<BufferViewInfo> views{{8, buffer.byte_length() - 12, 0}};
        AccessorInfo accessor{0, 4, 2, 5126, "MAT4", false};
        const GltfAccessorView view{buffer, container, views, accessor};
        for (double count : {0.0, 16.0, 32.0}) {
            const auto values = gltf_skin_float32_view(view, count);
            assert(values.size() == static_cast<std::size_t>(count));
            for (std::size_t index = 0; index < values.size(); ++index) assert(values[index] == static_cast<float>(index) / 8.0f);
        }
        for (double count : {-1.0, 1.5, 33.0}) reject([&] { gltf_skin_float32_view(view, count); });
        accessor.normalized = true; reject([&] { gltf_skin_float32_view(view, 16); }); accessor.normalized = false;
        accessor.component_type = 5123; reject([&] { gltf_skin_float32_view(view, 16); }); accessor.component_type = 5126;
        views[0].stride = 80; reject([&] { gltf_skin_float32_view(view, 16); }); views[0].stride = 64;
        assert(gltf_skin_float32_view(view, 16).size() == 16);
        views[0].length = 20; reject([&] { gltf_skin_float32_view(view, 16); });
        accessor.buffer_view = std::numeric_limits<std::size_t>::max();
        assert(gltf_skin_float32_view(view, 32) == std::vector<float>(32));
    }
    for(const auto& row:expected.at("rows")) {
        const ts::ArrayBuffer buffer(row.at("bytes").get<std::vector<std::uint8_t>>());
        upstream::ParsedGlbContainer container; container.bin_offset=16; container.bin_length=buffer.byte_length()-16;
        const std::vector<BufferViewInfo> views{{8, buffer.byte_length()-24, 0}};
        AccessorInfo accessor{0,4,row.at("count").get<std::size_t>(),row.at("type").get<std::uint32_t>(),"SCALAR",row.at("normalized").get<bool>()};
        for(std::size_t index=0;index<accessor.count;++index) {
            const auto wanted=row.at("expected")[index].get<double>();
            assert(read_accessor_component(buffer,container,views,accessor,index,0,accessor.normalized)==wanted);
            assert(read_component(buffer,container,views,accessor,index,0)==static_cast<float>(wanted));
            assert(read_index(buffer,container,views,accessor,index)==js::to_uint32(row.at("raw")[index].get<double>()));
            if(accessor.component_type!=5125) {
                using Reader=double(*)(const std::uint8_t*,double,double,bool);
                const Reader readers[]={reader_0,reader_1,reader_2,reader_3};
                for(std::size_t reader=0;reader<4;++reader)
                    assert(readers[reader](buffer.data(),double(28+index*component_size(accessor.component_type)),double(accessor.component_type),accessor.normalized)==row.at("readers")[reader][index].get<double>());
            }
        }
        reject([&]{read_component(buffer,container,views,accessor,accessor.count,0);});
        reject([&]{read_component(buffer,container,views,accessor,0,1);});
        auto bad=views; bad[0].length=4;
        reject([&]{read_component(buffer,container,bad,accessor,0,0);});
        bad=views; bad[0].offset=container.bin_length;
        reject([&]{read_component(buffer,container,bad,accessor,0,0);});
    }
    for(const auto& row:expected.at("zeroRows")) {
        AccessorInfo accessor; accessor.component_type=5126; accessor.type=row.at("type").get<std::string>(); accessor.count=2;
        assert(component_count(accessor.type)==row.at("components").get<std::size_t>());
        for(std::size_t index=0;index<row.at("values").size();++index)
            assert(read_component(ts::ArrayBuffer{},upstream::ParsedGlbContainer{}, {},accessor,index/component_count(accessor.type),index%component_count(accessor.type))==0);
    }
    assert(changed_component_count("MAT3")==8);
    reject([&]{component_size(9999);});
    const ts::ArrayBuffer strided(std::vector<std::uint8_t>{1,2,99,99,3,4});
    upstream::ParsedGlbContainer container; container.bin_length=6;
    const AccessorInfo accessor{0,0,2,5121,"VEC2",false};
    assert(read_component(strided,container,{{0,6,4}},accessor,1,0)==3);
    assert(read_component(strided,container,{{0,6,4}},accessor,1,1)==4);
    reject([&]{read_component(strided,container,{{0,6,1}},accessor,0,0);});
}`);
    runNativeFixtureCompiler(native, ["/nologo", "/std:c++20", "/W4", "/WX", "/EHsc", "/O2", `/Fo:${directory}/`, `/Fe:${executable}`,
        "/I", "native/include", "/I", join(nativeFixtureVcpkgRoot, "include"), source]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
});
