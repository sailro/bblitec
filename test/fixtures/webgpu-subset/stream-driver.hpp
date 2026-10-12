#pragma once

// Drives the pinned splat-stream GPU work (splat-stream-gpu.ts) through the
// backend-neutral WebGPU device interface (gpu.hpp), with the pin's own
// layouts, pipelines, buffers, passes and dispatch order, then compares the
// results with CPU evaluations of the pinned WGSL.

#include <bblite/gpu.hpp>
#include <bblite/js_promise.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace stream_check {

using bbl::GpuHandle;
using bbl::js::Nullable;
namespace js = bbl::js;

inline void require(bool condition, const std::string& message) {
    if (!condition)
        throw std::runtime_error("stream check: " + message);
}

// gpu-flags.ts
namespace BU {
constexpr std::uint32_t MAP_READ = 1, COPY_SRC = 4, COPY_DST = 8, UNIFORM = 64, STORAGE = 128,
                        INDIRECT = 256;
}
namespace TU {
constexpr std::uint32_t COPY_DST = 2, TEXTURE_BINDING = 4, RENDER_ATTACHMENT = 16;
}
namespace SS {
constexpr std::uint32_t VERTEX = 1, FRAGMENT = 2, COMPUTE = 4;
}

// splat-stream-gpu.ts
constexpr double RECORD_BYTES = 64, KEY_BYTES = 8, INDIRECT_BYTES = 16, RUNTIME_BYTES = 128,
                 RUNTIME_DISPATCH_OFFSET = 16, PARAM_SLOT_BYTES = 256, WORKGROUP_SIZE = 256;
constexpr int RADIX_PARAM_FIRST_SLOT = 16, RADIX_PASSES = 8;

struct Shaders {
    std::string compact, gather, project, radix, render;
};
inline std::string read_text(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    require(file.good(), "missing " + path);
    return {std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
}
inline Shaders read_shaders(const std::string& directory) {
    const auto at = [&](const char* name) {
        return read_text(directory + "/splat-stream-" + name + ".wgsl");
    };
    return {at("compact"), at("gather"), at("project"), at("radix"), at("render")};
}

inline bbl::GpuBindGroupLayoutEntry buffer_entry(double binding, double visibility,
                                                 const char* type, bool dynamic = false,
                                                 Nullable<double> minimum = {}) {
    bbl::GpuBindGroupLayoutEntry entry;
    entry.binding = binding;
    entry.visibility = visibility;
    entry.buffer = bbl::GpuBufferBindingLayout{std::string(type), dynamic, minimum};
    return entry;
}
inline bbl::GpuBindGroupLayoutEntry texture_entry(double binding) {
    bbl::GpuBindGroupLayoutEntry entry;
    entry.binding = binding;
    entry.visibility = SS::COMPUTE;
    entry.texture = bbl::GpuTextureBindingLayout{std::string("float"), {}, {}};
    return entry;
}
inline GpuHandle layout(bbl::GpuDevice& device, std::vector<bbl::GpuBindGroupLayoutEntry> entries) {
    bbl::GpuBindGroupLayoutDescriptor descriptor;
    for (auto& entry : entries)
        descriptor.entries.push_back(entry);
    return device.create_bind_group_layout(descriptor);
}
inline GpuHandle buffer(bbl::GpuDevice& device, double size, double usage, bool mapped = false,
                        const char* label = nullptr) {
    bbl::GpuBufferDescriptor descriptor;
    if (label)
        descriptor.label = std::string(label);
    descriptor.size = size;
    descriptor.usage = usage;
    descriptor.mapped_at_creation = mapped;
    return device.create_buffer(descriptor);
}
inline bbl::GpuBindGroupEntry buffer_binding(double binding, const GpuHandle& target,
                                             Nullable<double> size = {}) {
    return {binding, bbl::GpuBufferBinding{target, {}, size}};
}
inline GpuHandle group(bbl::GpuDevice& device, const GpuHandle& layout,
                       std::vector<bbl::GpuBindGroupEntry> entries) {
    bbl::GpuBindGroupDescriptor descriptor;
    descriptor.layout = layout;
    for (auto& entry : entries)
        descriptor.entries.push_back(entry);
    return device.create_bind_group(descriptor);
}

/** createPipelines(device). */
struct Pipelines {
    GpuHandle gather, project, compactScan, compactAdd, compactSetup, compactScatter, histogram,
        scan, add, bases, scatter, gatherLayout, projectLayout, compactLayout, radixLayout;
};
inline Pipelines create_pipelines(bbl::GpuDevice& device, const Shaders& wgsl) {
    Pipelines p;
    p.gatherLayout =
        layout(device, {texture_entry(0), texture_entry(1), texture_entry(2), texture_entry(3),
                        texture_entry(4), buffer_entry(5, SS::COMPUTE, "read-only-storage"),
                        buffer_entry(6, SS::COMPUTE, "storage"),
                        buffer_entry(7, SS::COMPUTE, "uniform", true, 48.0)});
    p.projectLayout = layout(device, {buffer_entry(0, SS::COMPUTE, "read-only-storage"),
                                      buffer_entry(1, SS::COMPUTE, "storage"),
                                      buffer_entry(2, SS::COMPUTE, "storage"),
                                      buffer_entry(3, SS::COMPUTE, "storage"),
                                      buffer_entry(4, SS::COMPUTE, "uniform", true, 192.0)});
    p.compactLayout = layout(
        device,
        {buffer_entry(0, SS::COMPUTE, "read-only-storage"), buffer_entry(1, SS::COMPUTE, "storage"),
         buffer_entry(2, SS::COMPUTE, "read-only-storage"), buffer_entry(3, SS::COMPUTE, "storage"),
         buffer_entry(4, SS::COMPUTE, "storage"), buffer_entry(5, SS::COMPUTE, "read-only-storage"),
         buffer_entry(6, SS::COMPUTE, "storage"), buffer_entry(7, SS::COMPUTE, "storage"),
         buffer_entry(8, SS::COMPUTE, "uniform", true, 48.0)});
    p.radixLayout = layout(
        device,
        {buffer_entry(0, SS::COMPUTE, "read-only-storage"), buffer_entry(1, SS::COMPUTE, "storage"),
         buffer_entry(2, SS::COMPUTE, "storage"), buffer_entry(3, SS::COMPUTE, "storage"),
         buffer_entry(4, SS::COMPUTE, "storage"), buffer_entry(5, SS::COMPUTE, "storage"),
         buffer_entry(6, SS::COMPUTE, "uniform", true, 32.0),
         buffer_entry(7, SS::COMPUTE, "read-only-storage")});
    const auto module = [&](const char* label, const std::string& code) {
        return device.create_shader_module({std::string(label), code});
    };
    const auto gatherModule = module("splat stream gather", wgsl.gather);
    const auto projectModule = module("splat stream projection", wgsl.project);
    const auto compactModule = module("splat stream compaction", wgsl.compact);
    const auto radixModule = module("splat stream radix", wgsl.radix);
    const auto compute = [&](const GpuHandle& shader, const GpuHandle& group_layout,
                             const char* entry) {
        bbl::GpuPipelineLayoutDescriptor pipeline_layout;
        pipeline_layout.bind_group_layouts.push_back(group_layout);
        bbl::GpuComputePipelineDescriptor descriptor;
        descriptor.layout = device.create_pipeline_layout(pipeline_layout);
        descriptor.compute = {shader, std::string(entry)};
        return device.create_compute_pipeline(descriptor);
    };
    p.gather = compute(gatherModule, p.gatherLayout, "main");
    p.project = compute(projectModule, p.projectLayout, "main");
    p.compactScan = compute(compactModule, p.compactLayout, "scanMain");
    p.compactAdd = compute(compactModule, p.compactLayout, "addMain");
    p.compactSetup = compute(compactModule, p.compactLayout, "setupMain");
    p.compactScatter = compute(compactModule, p.compactLayout, "scatterMain");
    p.histogram = compute(radixModule, p.radixLayout, "histogramMain");
    p.scan = compute(radixModule, p.radixLayout, "scanMain");
    p.add = compute(radixModule, p.radixLayout, "addMain");
    p.bases = compute(radixModule, p.radixLayout, "basesMain");
    p.scatter = compute(radixModule, p.radixLayout, "scatterMain");
    return p;
}

inline double ceil_div(double value, double divisor) { return std::ceil(value / divisor); }

struct ScanLevel {
    double count, blocks;
    GpuHandle values, scanned, sums;
};
struct CompactLevel {
    double count, blocks;
    GpuHandle scanned, sums;
};
/** createSplatStreamPassGpu(state). */
struct PassGpu {
    GpuHandle projected;
    std::array<GpuHandle, 2> keys;
    GpuHandle valid, prefix, compactDummy, runtime, indirect, indirectTemplate, projectParams,
        radixParams, digitBases, sorted;
    std::vector<ScanLevel> levels;
    std::vector<CompactLevel> compactLevels;
};
inline std::vector<std::pair<double, double>> scan_level_sizes(double groups) {
    std::vector<std::pair<double, double>> levels;
    for (double count = groups; count > 0; count = ceil_div(count, WORKGROUP_SIZE)) {
        const double blocks = ceil_div(count, WORKGROUP_SIZE);
        levels.push_back({count, blocks});
        if (blocks == 1)
            break;
    }
    return levels;
}
/** `inject` adds COPY_DST to `valid`, so a check can write the projection's outputs. */
inline PassGpu create_pass_gpu(bbl::GpuDevice& device, double capacity, bool inject = false) {
    PassGpu pass;
    const double groups = ceil_div(capacity, WORKGROUP_SIZE);
    pass.projected = buffer(device, capacity * RECORD_BYTES, BU::STORAGE | BU::COPY_SRC);
    for (auto& key : pass.keys)
        key = buffer(device, capacity * KEY_BYTES, BU::STORAGE | BU::COPY_SRC | BU::COPY_DST);
    pass.valid =
        buffer(device, capacity * 4, BU::STORAGE | BU::COPY_SRC | (inject ? BU::COPY_DST : 0));
    pass.prefix = buffer(device, capacity * 4, BU::STORAGE | BU::COPY_SRC);
    pass.compactDummy = buffer(device, 64, BU::STORAGE);
    pass.runtime =
        buffer(device, RUNTIME_BYTES, BU::STORAGE | BU::INDIRECT | BU::COPY_SRC | BU::COPY_DST);
    pass.indirect =
        buffer(device, INDIRECT_BYTES, BU::STORAGE | BU::INDIRECT | BU::COPY_SRC | BU::COPY_DST);
    pass.indirectTemplate = buffer(device, INDIRECT_BYTES, BU::COPY_SRC, true);
    {
        js::TypedArray<std::uint32_t> words(
            bbl::gpu_buffer_mapping(pass.indirectTemplate).get_mapped_range({}, {}));
        const std::uint32_t values[] = {6, 0, 0, 0};
        for (std::size_t index = 0; index < 4; ++index)
            words.store(index, values[index]);
        bbl::gpu_buffer_mapping(pass.indirectTemplate).unmap();
    }
    for (const auto& [count, blocks] : scan_level_sizes(groups)) {
        ScanLevel level{count, blocks, {}, {}, {}};
        level.values = buffer(device, std::max(16 * count * 4, 64.0), BU::STORAGE | BU::COPY_DST);
        level.scanned = buffer(device, std::max(16 * count * 4, 64.0), BU::STORAGE);
        level.sums = buffer(device, std::max(16 * blocks * 4, 64.0), BU::STORAGE | BU::COPY_SRC);
        pass.levels.push_back(level);
    }
    pass.projectParams = buffer(device, PARAM_SLOT_BYTES, BU::UNIFORM | BU::COPY_DST);
    pass.radixParams = buffer(device, PARAM_SLOT_BYTES * 256, BU::UNIFORM | BU::COPY_DST);
    pass.digitBases = buffer(device, 64, BU::STORAGE);
    // makeCompactScanLevels(capacity, prefix, levels)
    double count = capacity;
    for (std::size_t index = 0;; ++index) {
        const double blocks = ceil_div(count, WORKGROUP_SIZE);
        const auto& scratch = pass.levels[index == 0 ? 0 : index - 1];
        pass.compactLevels.push_back({count, blocks, index == 0 ? pass.prefix : scratch.scanned,
                                      index == 0 ? pass.levels[0].values : scratch.sums});
        if (blocks == 1)
            break;
        count = blocks;
    }
    pass.sorted = pass.keys[0];
    return pass;
}

/** A uniform parameter block of the pin's packers, as the ArrayBuffer it writes. */
struct ParamData {
    static constexpr std::size_t slot_words = 64;
    std::vector<std::uint32_t> words = std::vector<std::uint32_t>(slot_words * 256);
    js::ArrayBuffer bytes() const {
        std::vector<std::uint8_t> data(words.size() * 4);
        std::memcpy(data.data(), words.data(), data.size());
        return js::ArrayBuffer(std::move(data));
    }
    double write(int slot, std::initializer_list<double> values) {
        const std::size_t base = static_cast<std::size_t>(slot) * slot_words;
        std::size_t index = base;
        for (const double value : values)
            words[index++] = static_cast<std::uint32_t>(value);
        return slot * PARAM_SLOT_BYTES;
    }
};
inline GpuHandle compact_group(bbl::GpuDevice& device, const Pipelines& p,
                               std::array<GpuHandle, 9> buffers) {
    std::vector<bbl::GpuBindGroupEntry> entries;
    for (std::size_t binding = 0; binding < buffers.size(); ++binding)
        entries.push_back(
            buffer_binding(static_cast<double>(binding), buffers[binding],
                           binding == 8 ? Nullable<double>(48.0) : Nullable<double>{}));
    return group(device, p.compactLayout, entries);
}
inline GpuHandle radix_group(bbl::GpuDevice& device, const Pipelines& p,
                             std::array<GpuHandle, 8> buffers) {
    std::vector<bbl::GpuBindGroupEntry> entries;
    for (std::size_t binding = 0; binding < buffers.size(); ++binding)
        entries.push_back(
            buffer_binding(static_cast<double>(binding), buffers[binding],
                           binding == 6 ? Nullable<double>(32.0) : Nullable<double>{}));
    return group(device, p.radixLayout, entries);
}
inline js::Array<double> offsets(double offset) { return js::Array<double>{offset}; }

/** PendingProjection. */
struct Projection {
    double count = 0;
    std::array<float, 16> worldView{}, projection{};
    double width = 0, height = 0, near = 0;
};
/** packProjectParams(projection). */
inline js::ArrayBuffer pack_project_params(const Projection& projection) {
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(PARAM_SLOT_BYTES));
    std::array<float, 64> f32{};
    for (int i = 0; i < 16; ++i) {
        f32[i] = projection.worldView[i];
        f32[16 + i] = projection.projection[i];
    }
    const auto& wv = projection.worldView;
    for (int column = 0; column < 3; ++column)
        for (int row = 0; row < 3; ++row)
            f32[32 + column * 4 + row] = wv[column * 4 + row];
    std::memcpy(bytes.data(), f32.data(), 44 * 4);
    const auto count = static_cast<std::uint32_t>(projection.count);
    const float tail[] = {static_cast<float>(projection.width),
                          static_cast<float>(projection.height),
                          static_cast<float>(projection.near)};
    std::memcpy(bytes.data() + 44 * 4, &count, 4);
    std::memcpy(bytes.data() + 45 * 4, tail, 12);
    return js::ArrayBuffer(std::move(bytes));
}

/** The head of recordProjectionAndSort: the indirect template, the runtime clear, projection. */
inline void record_projection(bbl::GpuDevice& device, const Pipelines& p,
                              const GpuHandle& canonical, PassGpu& pass,
                              const Projection& projection, bbl::GpuCommandEncoder& encoder,
                              bool project = true) {
    encoder.copy_buffer_to_buffer(pass.indirectTemplate, 0, pass.indirect, 0, INDIRECT_BYTES);
    encoder.clear_buffer(pass.runtime);
    if (!project)
        return;
    device.write_buffer(pass.projectParams, 0, pack_project_params(projection));
    const auto projectGroup =
        group(device, p.projectLayout,
              {buffer_binding(0, canonical), buffer_binding(1, pass.projected),
               buffer_binding(2, pass.keys[1]), buffer_binding(3, pass.valid),
               buffer_binding(4, pass.projectParams, 192.0)});
    const auto projectPass = encoder.begin_compute_pass({std::string("splat stream projection")});
    projectPass->set_pipeline(p.project);
    projectPass->set_bind_group(0, projectGroup, offsets(0));
    projectPass->dispatch_workgroups(ceil_div(projection.count, WORKGROUP_SIZE));
    projectPass->end();
}

/** The compaction and radix tail of recordProjectionAndSort. */
inline void record_compact_and_sort(bbl::GpuDevice& device, const Pipelines& p, PassGpu& pass,
                                    double count, bbl::GpuCommandEncoder& encoder) {
    ParamData paramData;
    const auto write_slot = [&](double offset) {
        device.write_buffer(pass.radixParams, offset, paramData.bytes(), offset, PARAM_SLOT_BYTES);
    };
    const double levelCount = static_cast<double>(pass.levels.size());
    int slot = 0;
    double compactCount = count;
    for (std::size_t levelIndex = 0; levelIndex < pass.compactLevels.size(); ++levelIndex) {
        const auto& level = pass.compactLevels[levelIndex];
        const auto input = levelIndex == 0 ? pass.valid : pass.compactLevels[levelIndex - 1].sums;
        const double offset = paramData.write(
            slot++, {count, compactCount, level.blocks, level.count, 0, levelCount});
        write_slot(offset);
        const auto scan = encoder.begin_compute_pass({std::string("splat stream compact scan")});
        scan->set_pipeline(p.compactScan);
        scan->set_bind_group(
            0,
            compact_group(device, p,
                          {pass.keys[1], pass.keys[0], input, level.scanned, level.sums,
                           pass.compactDummy, pass.indirect, pass.runtime, pass.radixParams}),
            offsets(offset));
        scan->dispatch_workgroups(ceil_div(compactCount, WORKGROUP_SIZE));
        scan->end();
        compactCount = ceil_div(compactCount, WORKGROUP_SIZE);
    }
    for (int levelIndex = static_cast<int>(pass.compactLevels.size()) - 2; levelIndex >= 0;
         --levelIndex) {
        const auto& child = pass.compactLevels[static_cast<std::size_t>(levelIndex)];
        const auto& parent = pass.compactLevels[static_cast<std::size_t>(levelIndex) + 1];
        const double childCount = std::ceil(count / std::pow(WORKGROUP_SIZE, levelIndex));
        const double offset = paramData.write(
            slot++, {count, childCount, child.blocks, child.count, parent.count, levelCount});
        write_slot(offset);
        const auto add = encoder.begin_compute_pass({std::string("splat stream compact add")});
        add->set_pipeline(p.compactAdd);
        add->set_bind_group(
            0,
            compact_group(device, p,
                          {pass.keys[1], pass.keys[0], pass.compactDummy, child.scanned, child.sums,
                           parent.scanned, pass.indirect, pass.runtime, pass.radixParams}),
            offsets(offset));
        add->dispatch_workgroups(ceil_div(childCount, WORKGROUP_SIZE));
        add->end();
    }
    const auto& root = pass.compactLevels.back();
    double offset = paramData.write(slot++, {count, 0, root.blocks, root.count, 0, levelCount});
    write_slot(offset);
    const auto setup = encoder.begin_compute_pass({std::string("splat stream compact setup")});
    setup->set_pipeline(p.compactSetup);
    setup->set_bind_group(
        0,
        compact_group(device, p,
                      {pass.keys[1], pass.keys[0], pass.valid, pass.prefix, root.sums,
                       pass.compactDummy, pass.indirect, pass.runtime, pass.radixParams}),
        offsets(offset));
    setup->dispatch_workgroups(1);
    setup->end();
    offset = paramData.write(slot++, {count, count, 0, count, 0, levelCount});
    write_slot(offset);
    const auto compact = encoder.begin_compute_pass({std::string("splat stream compact scatter")});
    compact->set_pipeline(p.compactScatter);
    compact->set_bind_group(
        0,
        compact_group(device, p,
                      {pass.keys[1], pass.keys[0], pass.valid, pass.prefix, root.sums,
                       pass.compactDummy, pass.indirect, pass.runtime, pass.radixParams}),
        offsets(offset));
    compact->dispatch_workgroups(ceil_div(count, WORKGROUP_SIZE));
    compact->end();

    GpuHandle input = pass.keys[0], output = pass.keys[1];
    slot = RADIX_PARAM_FIRST_SLOT;
    const auto dispatchIndirect = [&](const GpuHandle& pipeline, const GpuHandle& bindings,
                                      double at, double dispatchSlot) {
        const auto pass_encoder =
            encoder.begin_compute_pass({std::string("splat stream radix stage")});
        pass_encoder->set_pipeline(pipeline);
        pass_encoder->set_bind_group(0, bindings, offsets(at));
        pass_encoder->dispatch_workgroups_indirect(pass.runtime,
                                                   RUNTIME_DISPATCH_OFFSET + dispatchSlot * 12);
        pass_encoder->end();
    };
    const auto radix_params = [&](double level, double shift, double blocks, double stride,
                                  double parentStride = 0) {
        return paramData.write(slot++, {0, level, shift, blocks, stride, parentStride});
    };
    for (int radixPass = 0; radixPass < RADIX_PASSES; ++radixPass) {
        const double shift = radixPass * 4;
        const auto& level0 = pass.levels[0];
        double at = radix_params(0, shift, level0.blocks, level0.count);
        write_slot(at);
        dispatchIndirect(p.histogram,
                         radix_group(device, p,
                                     {input, output, level0.values, level0.scanned, level0.sums,
                                      pass.digitBases, pass.radixParams, pass.runtime}),
                         at, 0);
        for (std::size_t levelIndex = 0; levelIndex < pass.levels.size(); ++levelIndex) {
            const auto& level = pass.levels[levelIndex];
            const auto values = levelIndex == 0 ? level.values : pass.levels[levelIndex - 1].sums;
            at = radix_params(static_cast<double>(levelIndex), shift, level.blocks, level.count);
            write_slot(at);
            dispatchIndirect(p.scan,
                             radix_group(device, p,
                                         {input, output, values, level.scanned, level.sums,
                                          pass.digitBases, pass.radixParams, pass.runtime}),
                             at, 1 + static_cast<double>(levelIndex));
        }
        for (int levelIndex = static_cast<int>(pass.levels.size()) - 2; levelIndex >= 0;
             --levelIndex) {
            const auto& child = pass.levels[static_cast<std::size_t>(levelIndex)];
            const auto& parent = pass.levels[static_cast<std::size_t>(levelIndex) + 1];
            at = radix_params(levelIndex, shift, child.blocks, child.count, parent.count);
            write_slot(at);
            dispatchIndirect(p.add,
                             radix_group(device, p,
                                         {input, output, parent.scanned, child.scanned, child.sums,
                                          pass.digitBases, pass.radixParams, pass.runtime}),
                             at, 1 + levelCount + levelIndex);
        }
        const auto& radixRoot = pass.levels.back();
        at = radix_params(levelCount - 1, shift, radixRoot.blocks, radixRoot.count);
        write_slot(at);
        const auto bases = encoder.begin_compute_pass({std::string("splat stream radix bases")});
        bases->set_pipeline(p.bases);
        bases->set_bind_group(
            0,
            radix_group(device, p,
                        {input, output, radixRoot.values, radixRoot.scanned, radixRoot.sums,
                         pass.digitBases, pass.radixParams, pass.runtime}),
            offsets(at));
        bases->dispatch_workgroups(1);
        bases->end();
        at = radix_params(0, shift, level0.blocks, level0.count);
        write_slot(at);
        dispatchIndirect(p.scatter,
                         radix_group(device, p,
                                     {input, output, level0.values, level0.scanned, level0.sums,
                                      pass.digitBases, pass.radixParams, pass.runtime}),
                         at, 0);
        std::swap(input, output);
    }
    pass.sorted = input;
}

/** One SOG source: five rgba8 textures and the codebooks (uploadSplatStreamSourceBytes). */
struct SourceGpu {
    std::array<GpuHandle, 5> textures, views;
    GpuHandle codebooks;
    double width = 0, height = 0, count = 0;
    std::array<float, 3> meansMin{}, meansMax{};
};
struct Interval {
    const SourceGpu* source;
    double sourceOffset, count, destinationOffset;
};

/** recordGather(state, encoder), with submission-local parameters as the pin creates them. */
inline void record_gather(bbl::GpuDevice& device, const Pipelines& p, const GpuHandle& canonical,
                          const std::vector<Interval>& intervals, double maxGroups,
                          bbl::GpuCommandEncoder& encoder, std::vector<GpuHandle>& retired) {
    struct Dispatch {
        const Interval* interval;
        double consumed, count, groups;
    };
    std::vector<Dispatch> dispatches;
    for (const auto& interval : intervals) {
        for (double consumed = 0; consumed < interval.count;) {
            const double count = std::min(interval.count - consumed, maxGroups * WORKGROUP_SIZE);
            dispatches.push_back({&interval, consumed, count, ceil_div(count, WORKGROUP_SIZE)});
            consumed += count;
        }
    }
    if (dispatches.empty())
        return;
    const auto pass = encoder.begin_compute_pass({std::string("splat stream gather")});
    pass->set_pipeline(p.gather);
    const double bytes = static_cast<double>(dispatches.size()) * PARAM_SLOT_BYTES;
    const auto params =
        buffer(device, bytes, BU::UNIFORM, true, "splat stream submission-local gather parameters");
    const auto mapped = bbl::gpu_buffer_mapping(params).get_mapped_range({}, {});
    js::TypedArray<std::uint32_t> u32(mapped);
    js::TypedArray<float> f32(mapped);
    for (std::size_t slot = 0; slot < dispatches.size(); ++slot) {
        const auto& dispatch = dispatches[slot];
        const std::size_t base = slot * static_cast<std::size_t>(PARAM_SLOT_BYTES) / 4;
        const double words[] = {dispatch.interval->sourceOffset + dispatch.consumed, dispatch.count,
                                dispatch.interval->destinationOffset + dispatch.consumed,
                                dispatch.interval->source->width};
        for (std::size_t i = 0; i < 4; ++i)
            u32.store(base + i, static_cast<std::uint32_t>(words[i]));
        for (std::size_t i = 0; i < 3; ++i) {
            f32.store(base + 4 + i, dispatch.interval->source->meansMin[i]);
            f32.store(base + 8 + i, dispatch.interval->source->meansMax[i]);
        }
    }
    bbl::gpu_buffer_mapping(params).unmap();
    for (std::size_t slot = 0; slot < dispatches.size(); ++slot) {
        const auto& dispatch = dispatches[slot];
        std::vector<bbl::GpuBindGroupEntry> entries;
        for (std::size_t binding = 0; binding < 5; ++binding)
            entries.push_back({static_cast<double>(binding),
                               bbl::GpuBindingResource{dispatch.interval->source->views[binding]}});
        entries.push_back(buffer_binding(5, dispatch.interval->source->codebooks));
        entries.push_back(buffer_binding(6, canonical));
        entries.push_back(buffer_binding(7, params, 48.0));
        pass->set_bind_group(0, group(device, p.gatherLayout, entries),
                             offsets(static_cast<double>(slot) * PARAM_SLOT_BYTES));
        pass->dispatch_workgroups(dispatch.groups);
    }
    pass->end();
    retired.push_back(params);
}

/** Copies a range into a MAP_READ buffer, maps it on the realm and returns its bytes. */
inline js::Promise<js::ArrayBuffer> read_back(bbl::GpuDevice& device, GpuHandle source,
                                              double offset, double size) {
    const auto readback = buffer(device, size, BU::COPY_DST | BU::MAP_READ);
    const auto encoder = device.create_command_encoder();
    encoder->copy_buffer_to_buffer(source, offset, readback, 0, size);
    device.submit(js::Array<GpuHandle>{encoder->finish()});
    auto& mapping = bbl::gpu_buffer_mapping(readback);
    require(mapping.map_state() == "unmapped", "readback starts unmapped");
    auto mapped = mapping.map_async(bbl::gpu_map_mode_read, {}, {});
    require(mapping.map_state() == "pending", "mapAsync is pending until the realm settles it");
    co_await mapped;
    require(mapping.map_state() == "mapped", "mapAsync settles mapped");
    const auto range = mapping.get_mapped_range({}, {});
    std::vector<std::uint8_t> bytes(range.data(), range.data() + range.byte_length());
    mapping.unmap();
    require(mapping.map_state() == "unmapped", "unmap");
    readback->destroy();
    co_return js::ArrayBuffer(std::move(bytes));
}

template <class T> std::vector<T> values_of(const js::ArrayBuffer& bytes) {
    std::vector<T> result(bytes.byte_length() / sizeof(T));
    std::memcpy(result.data(), bytes.data(), result.size() * sizeof(T));
    return result;
}

/** A deterministic sequence, so both backends see the same inputs. */
struct Random {
    std::uint32_t state;
    std::uint32_t next() {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return state;
    }
    float unit() { return static_cast<float>(next() >> 8) / 16777216.0f; }
};

/** A line of hexadecimal words the test compares across backends. */
inline std::string hex_words(const std::vector<std::uint32_t>& words) {
    std::string text;
    char digits[10];
    for (const auto word : words) {
        std::snprintf(digits, sizeof(digits), "%08x", word);
        text += digits;
    }
    return text;
}

} // namespace stream_check
