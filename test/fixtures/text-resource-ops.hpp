#pragma once
#include "upstream_text.hpp"
#include "upstream_text_gpu.hpp"
#include <fstream>
#include <iostream>
#include <sstream>

using namespace bbl;

/** The event log and failure switch the JavaScript recorder device keeps. */
struct Ops {
    int next = 1;
    std::string fail;
    std::ofstream events{"events.txt"}, bytes{"writes.bin", std::ios::binary};
    template <class T> void part(const T& value) {
        if constexpr (std::is_floating_point_v<T>)
            events << js::number_to_string(static_cast<double>(value)) << ' ';
        else
            events << value << ' ';
    }
    template <class... T> void event(const T&... values) {
        (part(values), ...);
        events << '\n';
    }
    void failure(const std::string& operation) {
        if (fail == operation) {
            fail.clear();
            event("fail", operation);
            throw std::runtime_error(operation);
        }
    }
    void write(std::span<const std::uint8_t> data) {
        bytes.write(reinterpret_cast<const char*>(data.data()),
                    static_cast<std::streamsize>(data.size()));
    }
};

/** A recorded GPU object: its id, label and, for a texture, itself as view. */
struct Resource final : TextGpuObject, std::enable_shared_from_this<Resource> {
    Ops* ops = nullptr;
    int id = 0;
    std::string label;
    void destroy() override { ops->event("destroy", id); }
    TextGpuHandle create_view() override { return shared_from_this(); }
};
inline int id_of(const TextGpuHandle& handle) {
    const auto resource = std::dynamic_pointer_cast<Resource>(handle);
    return resource ? resource->id : 0;
}
inline TextGpuHandle named(int id) {
    auto resource = std::make_shared<Resource>();
    resource->id = id;
    resource->label = "fixed";
    return resource;
}

/** A recorded render bundle: its commands, replayed as events. */
struct Bundle final : TextGpuObject {
    std::vector<std::function<void(Ops&)>> commands;
};
struct RecorderEncoder final : TextGpuEncoder {
    Ops& ops;
    std::shared_ptr<Bundle> bundle;
    explicit RecorderEncoder(Ops& target, bool recording = false) : ops(target) {
        if (recording)
            bundle = std::make_shared<Bundle>();
    }
    void record(std::function<void(Ops&)> command) {
        if (bundle)
            bundle->commands.push_back(std::move(command));
        else
            command(ops);
    }
    void set_pipeline(const TextGpuHandle& pipeline) override {
        const int id = id_of(pipeline);
        record([id](Ops& target) { target.event("pipeline", id); });
    }
    void set_vertex_buffer(double slot, const TextGpuHandle& buffer) override {
        const int id = id_of(buffer);
        record([slot, id](Ops& target) { target.event("vertex", slot, id); });
    }
    void set_bind_group(double index, const TextGpuHandle& group) override {
        if (index != 0)
            throw std::runtime_error("bind group slot");
        const int id = id_of(group);
        record([id](Ops& target) { target.event("bind", id); });
    }
    void draw(double a, double b, double c, double d) override {
        record([a, b, c, d](Ops& target) { target.event("draw", a, b, c, d); });
    }
    TextGpuHandle finish() override { return std::exchange(bundle, nullptr); }
    void execute_bundles(const js::Array<TextGpuHandle>& bundles) override {
        for (const auto& handle : bundles)
            for (const auto& command : std::dynamic_pointer_cast<Bundle>(handle)->commands)
                command(ops);
    }
    void end() override { ops.event("end"); }
};

/** The JavaScript recorder device, as the pinned functions call it. */
struct RecorderDevice final : TextGpuDevice {
    Ops& ops;
    TextPipelineSet pipelines;
    int bundles = 0;
    RecorderDevice(Ops& target, TextPipelineSet set) : ops(target), pipelines(std::move(set)) {}
    std::shared_ptr<Resource> resource(const std::optional<std::string>& label, double size) {
        const std::string name = label.value_or("");
        ops.failure("create:" + name);
        auto created = std::make_shared<Resource>();
        created->ops = &ops;
        created->id = ops.next++;
        created->label = name;
        ops.event("create", name, created->id, size);
        return created;
    }
    TextGpuHandle create_buffer(const TextBufferDescriptor& descriptor) override {
        auto created = resource(descriptor.label, descriptor.size);
        created->size = descriptor.size;
        return created;
    }
    TextGpuHandle create_texture(const TextTextureDescriptor& descriptor) override {
        return resource(descriptor.label, descriptor.size.width * descriptor.size.height * 16);
    }
    TextGpuHandle create_bind_group(const TextBindGroupDescriptor& descriptor) override {
        ops.failure("group");
        auto group = std::make_shared<Resource>();
        group->ops = &ops;
        group->id = ops.next++;
        std::ostringstream line;
        line << "group " << group->id << ' ' << id_of(descriptor.layout) << ' ';
        for (const auto& entry : descriptor.entries) {
            const auto* binding = std::get_if<TextBufferBinding>(&entry.resource);
            line << id_of(binding ? binding->buffer : std::get<TextGpuHandle>(entry.resource))
                 << ' ';
        }
        ops.events << line.str() << '\n';
        return group;
    }
    TextGpuEncoderHandle
    create_render_bundle_encoder(const TextRenderBundleEncoderDescriptor& descriptor) override {
        if (descriptor.color_formats.size() != 1 || descriptor.sample_count != 1.0)
            throw std::runtime_error("bundle descriptor");
        ++bundles;
        return std::make_shared<RecorderEncoder>(ops, true);
    }
    void write_buffer(const TextGpuHandle& buffer, double offset, const js::ArrayBuffer& data,
                      double data_offset, double size) override {
        const auto target = std::dynamic_pointer_cast<Resource>(buffer);
        ops.failure("write:" + target->label);
        ops.event("write", target->id, offset, size);
        ops.write(
            {data.data() + static_cast<std::size_t>(data_offset), static_cast<std::size_t>(size)});
    }
    void write_texture(const TextTexelCopyTextureInfo& destination, const js::ArrayBuffer& data,
                       const TextTexelCopyBufferLayout& layout, const TextExtent3D& size) override {
        const auto target = std::dynamic_pointer_cast<Resource>(destination.texture);
        const double count = layout.bytes_per_row.value_or(0) * size.height;
        ops.failure("write:" + target->label);
        ops.event("write", target->id, 0.0, count);
        ops.write({data.data() + static_cast<std::size_t>(layout.offset.value_or(0)),
                   static_cast<std::size_t>(count)});
    }
    TextPipelineSet text_pipeline(const std::string&, double, const std::optional<std::string>&,
                                  bool, const std::shared_ptr<const void>&,
                                  const std::string&) override {
        return pipelines;
    }
    TextPipelineDeviceCacheHandle text_pipeline_cache() override { return pipelines.cache; }
};

/** The pin's records, filled as the fixtures' JavaScript twins are. */
js::TypedArray<float> pattern_floats(std::size_t count, std::size_t seed) {
    std::vector<std::uint8_t> bytes(count);
    for (std::size_t i = 0; i < count; ++i)
        bytes[i] = static_cast<std::uint8_t>((i * 37 + seed) & 255);
    return js::TypedArray<float>(js::ArrayBuffer(std::move(bytes)));
}
std::shared_ptr<SharedAtlas> text_atlas() {
    auto atlas = std::make_shared<SharedAtlas>();
    atlas->curve_tex_data = pattern_floats(131072, 3);
    atlas->band_tex_data = pattern_floats(131072, 4);
    atlas->meta_data = pattern_floats(384, 5);
    atlas->curve_texels_used = 3;
    atlas->band_texels_used = 7;
    atlas->slot_count = 3;
    atlas->version = 1;
    return atlas;
}
std::shared_ptr<TextDataDrawGroup> text_group(const std::shared_ptr<SharedAtlas>& atlas,
                                              const char* key, double start, double count) {
    auto group = std::make_shared<TextDataDrawGroup>();
    group->curve_set = std::make_shared<GlyphStorageCurveSet>();
    group->curve_set->atlas = atlas;
    group->curve_set_id = "atlas";
    group->group_key = TextGroupKey(key);
    group->slot_start = start;
    group->slot_count = count;
    group->live_count = 2;
    group->bind_group_version = -1;
    return group;
}
