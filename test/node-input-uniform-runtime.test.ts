import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerNodeInputScalarSetter } from "../src/lowering/node-input-uniform-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("Dawn node draw buffers refresh each changed owner once while scalar slots retain source rounding", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native compiler required");
        return;
    }
    const output = resolve("artifacts/node-input-uniform-runtime");
    mkdirSync(output, { recursive: true });
    const code = `
    #include <bblite/node_material.hpp>
    #include <cassert>
    #include <cstring>
    #define BBLITE_NODE_GEOMETRY_VARIANTS 0
    namespace bbl {${lowerNodeInputScalarSetter(new LoweringContext())}}
    namespace bbl::upstream {
    struct NodeMeshUniforms {float values[4];};
    struct NodeVariantEntry {std::size_t first_uniform_float=0, ubo_bytes=16;};
    const std::array<float,4> node_variant_uniform_floats{1,2,3,4};
    bool has_node_ubo(const NodeVariantEntry& view) {return view.ubo_bytes != 0;}
    }
    namespace bbl::pal {
    ${cppFunction(readFileSync("native/src/pal_gpu_materials.hpp", "utf8"), "inline std::span<const float> node_uniform_values(")}
    struct Buffer {std::vector<float> values; int writes=0;};
    using WGPUBuffer=Buffer*;
    struct WGPUBufferDescriptor {std::uint64_t size=0; int usage=0;};
    #define WGPU_BUFFER_DESCRIPTOR_INIT {}
    constexpr int WGPUBufferUsage_Uniform=1, WGPUBufferUsage_CopyDst=2;
    std::vector<std::unique_ptr<Buffer>> buffers;
    WGPUBuffer wgpuDeviceCreateBuffer(int,const WGPUBufferDescriptor* descriptor) {
        auto value=std::make_unique<Buffer>();value->values.resize(static_cast<std::size_t>(descriptor->size)/sizeof(float));
        const auto result=value.get();buffers.push_back(std::move(value));return result;
    }
    struct DawnBuffer {WGPUBuffer value; operator bool() const{return value!=nullptr;} WGPUBuffer release(){return std::exchange(value,nullptr);}};
    struct DawnState {int device=0, queue=0;};
    struct DawnDrawState {WGPUBuffer mesh_uniforms=nullptr,material_uniforms=nullptr; NodeUniformUploadState node_uniform_upload;};
    struct DawnGpuDevice {
        int queue;
        void write_buffer(WGPUBuffer target,std::size_t,const void* source,std::size_t size) {
            assert(size==target->values.size()*sizeof(float));std::memcpy(target->values.data(),source,size);++target->writes;
        }
    };
    [[noreturn]] void dawn_error(const char* message){throw std::runtime_error(message);}
    ${cppFunction(readFileSync("native/src/pal_dawn_scene_variants.cpp", "utf8"), "void fill_node_draw_buffers(")}
    }
    int main() {
        using namespace bbl;using namespace bbl::pal;
        MaterialRecord material;material.node_inputs=std::make_shared<NodeMaterialInputsState>();
        auto uniforms=material.node_inputs->uniforms=std::make_shared<NodeUniformState>();uniforms->values={1,2,3,4};
        const auto input=std::make_shared<NodeInputState>();input->uniforms=uniforms;input->values=std::span<float>{uniforms->values}.subspan(1,1);
        DawnState state;DawnDrawState first,second;const upstream::NodeVariantEntry view;
        fill_node_draw_buffers(state,first,view,&material);fill_node_draw_buffers(state,second,view,&material);
        assert(first.material_uniforms->writes==1 && second.material_uniforms->writes==1);
        fill_node_draw_buffers(state,first,view,&material);assert(first.material_uniforms->writes==1);
        set_node_input_scalar(input, 1.0/3.0);
        assert(first.node_uniform_upload.pending(uniforms) && second.node_uniform_upload.pending(uniforms) && uniforms->values[1]==static_cast<float>(1.0/3.0));
        fill_node_draw_buffers(state,first,view,&material);assert(!first.node_uniform_upload.pending(uniforms) && second.node_uniform_upload.pending(uniforms) && first.material_uniforms->writes==2);
        fill_node_draw_buffers(state,second,view,&material);assert(second.material_uniforms->writes==2);
        assert(first.material_uniforms->values==second.material_uniforms->values);
        set_node_input_scalar(input,-4);
        set_node_input_scalar(input,-5);
        fill_node_draw_buffers(state,first,view,&material);assert(first.material_uniforms->writes==3 && first.material_uniforms->values[1]==-5);
        auto replacement=std::make_shared<NodeUniformState>();replacement->values={4,3,2,1};material.node_inputs->uniforms=replacement;
        fill_node_draw_buffers(state,first,view,&material);assert(first.material_uniforms->writes==4 && first.material_uniforms->values[0]==4);
        DawnDrawState geometry;fill_node_draw_buffers(state,geometry,view,nullptr);fill_node_draw_buffers(state,geometry,view,nullptr);assert(geometry.material_uniforms->writes==1);
    }
    `;
    const path = join(output, "check.cpp"),
        exe = join(output, "check.exe");
    writeFileSync(path, code);
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        path,
        `/Fo${output}/`,
        `/Fe${exe}`,
    ]);
    execFileSync(exe, { encoding: "utf8", timeout: 10000 });
});
