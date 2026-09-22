#pragma once
#include <bblite/pal_compute_buffer_binding.hpp>
#include <bblite/pal_compute_shader.hpp>
#include <bblite/js_realm_state.hpp>
#include <variant>
#include <map>

namespace bbl {
struct ComputeTextureResource;
struct ComputeSamplerResource;
struct ComputeStorageTexture;
using ComputeBindingInput =
    std::variant<std::monostate, ComputeBufferRange, std::shared_ptr<ComputeTextureResource>,
                 std::shared_ptr<ComputeSamplerResource>, std::shared_ptr<ComputeStorageTexture>>;
using ComputeBindingState =
    std::variant<std::monostate, ComputeBufferBindingState, std::shared_ptr<ComputeTextureResource>,
                 std::shared_ptr<ComputeSamplerResource>, std::shared_ptr<ComputeStorageTexture>>;
using ComputeBindingResources = std::map<std::string, ComputeBindingInput>;
struct ComputeResolvedBinding {
    ComputeBindingState state;
    std::optional<ComputeDynamicBindingInfo> dynamic;
};
struct ComputeBindingResolver {
    using Resolve = ComputeResolvedBinding (*)(const std::shared_ptr<Engine>&,
                                               const ComputeBindingDeclPtr&,
                                               const ComputeBindingInput&);
    using Get = pal::ComputeBindingResource (*)(const std::shared_ptr<Engine>&,
                                                const ComputeBindingState&);
    using Validate = void (*)(const std::shared_ptr<Engine>&, const ComputeBindingState&);
    Resolve resolve = nullptr;
    Get get = nullptr;
    Validate validate = nullptr;
};
struct ResolvedComputeBinding {
    ComputeBindingDeclPtr decl;
    std::shared_ptr<const ComputeBindingResolver> resolver;
    ComputeBindingState state;
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(state); }
};
struct ComputeDynamicBindingSlot {
    double group = 0, index = 0, alignment = 0, max_offset = 0;
};
using ComputeDynamicBindingSlots = std::map<std::string, ComputeDynamicBindingSlot>;
using ComputeBindGroups = std::vector<std::shared_ptr<pal::ComputeBindGroup>>;
struct ComputeBindingSet {
    std::shared_ptr<ComputeShader> shader;
    std::vector<ResolvedComputeBinding> entries;
    std::optional<std::vector<ResolvedComputeBinding>> volatile_entries;
    std::optional<ComputeDynamicBindingSlots> dynamic_slots;
    std::optional<std::vector<std::vector<double>>> zero_dynamic_offsets;
    std::shared_ptr<pal::OffscreenDevice> device;
    std::shared_ptr<ComputeBindGroups> groups;
    double resource_epoch = -1;
    bool destroyed = false;
    void gc_trace(const js::TraceVisitor& visitor) const {
        visitor(shader);
        visitor(entries);
        visitor(volatile_entries);
    }
};
struct ComputeResolverRegistry {
    std::map<double, std::shared_ptr<const ComputeBindingResolver>> values;
};
void install_compute_binding_resolver(double, ComputeBindingResolver::Resolve,
                                      ComputeBindingResolver::Get,
                                      ComputeBindingResolver::Validate = nullptr);
std::shared_ptr<const ComputeBindingResolver> get_compute_binding_resolver(double);
std::shared_ptr<ComputeBindingSet> create_compute_binding_set(const std::shared_ptr<ComputeShader>&,
                                                              const ComputeBindingResources&);
std::shared_ptr<ComputeBindGroups>
ensure_compute_binding_groups(const std::shared_ptr<ComputeBindingSet>&,
                              bool validate_volatile = true);
void dispose_compute_binding_set(const std::shared_ptr<ComputeBindingSet>&);

ComputeResolvedBinding resolve_compute_storage_buffer_input(const std::shared_ptr<Engine>&,
                                                            const ComputeBindingDeclPtr&,
                                                            const ComputeBindingInput&);
ComputeResolvedBinding resolve_compute_uniform_buffer_input(const std::shared_ptr<Engine>&,
                                                            const ComputeBindingDeclPtr&,
                                                            const ComputeBindingInput&);
ComputeResolvedBinding resolve_compute_texture_input(const std::shared_ptr<Engine>&,
                                                     const ComputeBindingDeclPtr&,
                                                     const ComputeBindingInput&);
ComputeResolvedBinding resolve_compute_sampler_input(const std::shared_ptr<Engine>&,
                                                     const ComputeBindingDeclPtr&,
                                                     const ComputeBindingInput&);
ComputeResolvedBinding resolve_compute_storage_texture_input(const std::shared_ptr<Engine>&,
                                                             const ComputeBindingDeclPtr&,
                                                             const ComputeBindingInput&);
pal::ComputeBindingResource get_compute_storage_buffer_input(const std::shared_ptr<Engine>&,
                                                             const ComputeBindingState&);
pal::ComputeBindingResource get_compute_uniform_buffer_input(const std::shared_ptr<Engine>&,
                                                             const ComputeBindingState&);
pal::ComputeBindingResource get_compute_texture_input(const std::shared_ptr<Engine>&,
                                                      const ComputeBindingState&);
pal::ComputeBindingResource get_compute_sampler_input(const std::shared_ptr<Engine>&,
                                                      const ComputeBindingState&);
pal::ComputeBindingResource get_compute_storage_texture_input(const std::shared_ptr<Engine>&,
                                                              const ComputeBindingState&);
void validate_compute_texture_binding(const std::shared_ptr<Engine>&, const ComputeBindingState&);
} // namespace bbl
