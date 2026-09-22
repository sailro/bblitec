#pragma once
#include <bblite/runtime.hpp>
#include <bblite/pal_compute_binding.hpp>
#include <bblite/pal_compute_pipeline.hpp>
#include <bblite/pal_offscreen.hpp>
#include <bblite/js_promise.hpp>
#include <map>

namespace bbl {
namespace pal {
struct ComputePipelinePreparation {
    js::Promise<std::shared_ptr<ComputePipeline>> result;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(result); }
};
inline std::shared_ptr<ComputePipelinePreparation>
prepare_compute_pipeline(const std::shared_ptr<OffscreenDevice>& device,
                         const ComputePipelineDescriptor& descriptor) {
    auto operation = js::make_gc_shared<ComputePipelinePreparation>();
    try {
        operation->result.resolve(device->create_compute_pipeline(descriptor));
    } catch (const WorkerTerminated&) {
        throw;
    } catch (...) {
        operation->result.reject(std::current_exception());
    }
    return operation;
}
} // namespace pal
struct ComputeShaderOptions {
    std::optional<std::string> name;
    std::string source;
    std::optional<std::string> entry_point;
    std::vector<ComputeBindingDeclPtr> bindings;
};
struct ComputeBindingSlot {
    ComputeBindingDeclPtr decl;
    double dynamic_index = -1;
};
struct ComputeShader {
    std::string name, source, entry_point, artifact;
    std::shared_ptr<Engine> engine;
    std::vector<ComputeBindingDeclPtr> decls;
    std::map<std::string, ComputeBindingSlot> slots;
    std::vector<double> dynamic_counts;
    std::shared_ptr<pal::OffscreenDevice> device;
    std::shared_ptr<pal::ComputeShaderModule> module;
    std::shared_ptr<pal::ComputeGroupLayouts> layouts;
    std::shared_ptr<pal::ComputePipelineLayout> pipeline_layout;
    std::shared_ptr<pal::ComputePipeline> pipeline;
    std::shared_ptr<pal::ComputePipelinePreparation> pending;
    bool destroyed = false;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(engine);
        visitor(pending);
    }
};
std::shared_ptr<ComputeShader> create_compute_shader(std::shared_ptr<Engine>,
                                                     const ComputeShaderOptions&);
void assert_compute_shader_live(const std::shared_ptr<ComputeShader>&);
std::shared_ptr<pal::ComputeGroupLayouts>
get_compute_group_layouts(const std::shared_ptr<ComputeShader>&);
std::shared_ptr<pal::ComputePipeline> get_compute_pipeline(const std::shared_ptr<ComputeShader>&);
js::Promise<js::PromiseVoid> prepare_compute_shader(std::shared_ptr<ComputeShader>);
void dispose_compute_shader(const std::shared_ptr<ComputeShader>&);
inline const std::string& compute_shader_name(const std::shared_ptr<ComputeShader>& shader) {
    return shader->name;
}
inline bool compute_shader_destroyed(const std::shared_ptr<ComputeShader>& shader) {
    return shader->destroyed;
}
} // namespace bbl
