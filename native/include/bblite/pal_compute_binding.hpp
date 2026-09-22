#pragma once
#include <bblite/js_data.hpp>
#include <memory>
#include <optional>
#include <string>

namespace bbl {
struct ComputeBindingOptions {
    double group = 0;
    double binding = 0;
    std::optional<std::string> access;
    std::optional<bool> dynamic_offset;
    std::optional<double> min_binding_size;
    std::optional<std::string> sample_type;
    std::optional<bool> multisampled;
    std::optional<std::string> type;
    std::string format;
    std::string view_dimension;
};
struct ComputeBufferLayout {
    std::string type;
    bool has_dynamic_offset = false;
    std::optional<double> min_binding_size;
};
struct ComputeTextureLayout {
    std::string sample_type;
    std::string view_dimension;
    bool multisampled = false;
};
struct ComputeSamplerLayout {
    std::string type;
};
struct ComputeStorageTextureLayout {
    std::string access, format, view_dimension;
};
struct ComputeResourceLayout {
    std::optional<ComputeBufferLayout> buffer;
    std::optional<ComputeTextureLayout> texture;
    std::optional<ComputeSamplerLayout> sampler;
    std::optional<ComputeStorageTextureLayout> storage_texture;
};
struct ComputeBindingData {
    std::string access, sample_type, view_dimension, format, sampler_type;
    bool dynamic = false;
    bool multisampled = false;
    double min_size = 0;
};
struct ComputeBindingDecl {
    std::string name;
    double group = 0;
    double binding = 0;
    double kind = 0;
    ComputeResourceLayout layout;
    ComputeBindingData data;
};
using ComputeBindingDeclPtr = std::shared_ptr<const ComputeBindingDecl>;
ComputeBindingDeclPtr compute_storage_buffer_binding(const std::string&,
                                                     const ComputeBindingOptions&);
ComputeBindingDeclPtr compute_uniform_buffer_binding(const std::string&,
                                                     const ComputeBindingOptions&);
ComputeBindingDeclPtr compute_texture_binding(const std::string&, const ComputeBindingOptions&);
ComputeBindingDeclPtr compute_texture_view_binding(const std::string&,
                                                   const ComputeBindingOptions&);
ComputeBindingDeclPtr compute_storage_texture_binding(const std::string&,
                                                      const ComputeBindingOptions&);
ComputeBindingDeclPtr compute_storage_texture_view_binding(const std::string&,
                                                           const ComputeBindingOptions&);
ComputeBindingDeclPtr compute_sampler_binding(const std::string&, const ComputeBindingOptions&);
inline const std::string& compute_binding_name(const ComputeBindingDeclPtr& value) {
    return value->name;
}
inline double compute_binding_group(const ComputeBindingDeclPtr& value) { return value->group; }
inline double compute_binding_index(const ComputeBindingDeclPtr& value) { return value->binding; }
} // namespace bbl
