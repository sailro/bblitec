#pragma once

#include <bblite/gpu_object.hpp>
#include <bblite/js_data.hpp>

#include <memory>
#include <variant>

namespace bbl {

using ThinInstanceMatrices = std::variant<js::F32Array, js::F64Array>;

/** Pinned ThinInstanceData storage. Generated source owns its mutations. */
struct ThinInstancePoolData {
    ThinInstanceMatrices matrices;
    js::Nullable<js::F32Array> colors;
    js::Nullable<js::F32Array> upload_f32;
    double count = 0;
    double capacity = 0;
    double version = 0;
    double gpu_version = 0;
    double dirty_min = 0;
    double dirty_max = 0;
    double color_version = 0;
    double color_gpu_version = 0;
    double color_dirty_min = 0;
    double color_dirty_max = 0;
    bool gpu_culling_enabled = false;
    bool color_gpu_buffer_storage = false;
    GpuHandle gpu_buffer;
    GpuHandle color_gpu_buffer;
    GpuHandle draw_args_buffer;
    js::Nullable<double> draw_args_instance_count;
    js::Nullable<js::U32Array> draw_args_data;
    double cull_bounds_pad = 0;
    js::Nullable<double> ref_count;
};

/** The MeshGPU fields read by the pinned indexed-indirect argument writer. */
struct ThinInstanceGeometry {
    double index_count = 0;
    js::Nullable<double> base_vertex;
};

/** Captures owned by one source material renderable or task override. */
struct ThinMaterialBinding {
    std::shared_ptr<ThinInstancePoolData> pool;
    double mesh_features = 0;
    bool shader_has_color = false;
    bool node_requires_instances = false;
    GpuHandle draw_args;
};
using ThinMaterialBindingOwner = std::shared_ptr<ThinMaterialBinding>;

} // namespace bbl
