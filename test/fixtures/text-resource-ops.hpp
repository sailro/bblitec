#pragma once
#include "upstream_text.hpp"
#include "upstream_text_gpu.hpp"
#include <fstream>
#include <iostream>
#include <sstream>

using namespace bbl;
struct Resource { int id; std::string label; };
using Lease = std::shared_ptr<Resource>;
struct RenderResources { Lease uniform, instances, styles; };
struct AtlasResources { Lease curves, bands, metadata; };
struct Ops {
    int next = 1;
    std::string fail;
    std::ofstream events{"events.txt"}, bytes{"writes.bin", std::ios::binary};
    template<class... T> void event(const T&... values) { ((events << values << ' '), ...); events << '\n'; }
    void failure(const std::string& operation) {
        if (fail == operation) { fail.clear(); event("fail", operation); throw std::runtime_error(operation); }
    }
    Lease resource(const std::string& label, std::size_t size) {
        failure("create:" + label);
        auto lease = std::make_shared<Resource>(Resource{next++,label}); event("create", label, lease->id, size); return lease;
    }
    void destroy(const Lease& lease) { event("destroy", lease->id); }
    void write(const Lease& lease, std::size_t offset, std::span<const std::uint8_t> data) {
        failure("write:" + lease->label); event("write", lease->id, offset, data.size());
        bytes.write(reinterpret_cast<const char*>(data.data()), static_cast<std::streamsize>(data.size()));
    }
    static RenderResources& render(TextGpuState& gpu) {
        if (!gpu.backend) gpu.backend = std::make_shared<RenderResources>();
        return *std::static_pointer_cast<RenderResources>(gpu.backend);
    }
    static const RenderResources& render(const TextGpuState& gpu) { return *std::static_pointer_cast<RenderResources>(gpu.backend); }
    static AtlasResources& atlas(TextAtlasGpuState& gpu) {
        if (!gpu.backend) gpu.backend = std::make_shared<AtlasResources>();
        return *std::static_pointer_cast<AtlasResources>(gpu.backend);
    }
    static const AtlasResources& atlas(const TextAtlasGpuState& gpu) { return *std::static_pointer_cast<AtlasResources>(gpu.backend); }
    void create_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t count) {
        auto& state = render(gpu);
        if (kind == TextBufferKind::uniform) { auto p = resource("text-renderable-ubo",count); state.uniform=p; gpu.destroy_uniform=[this,p]{destroy(p);}; }
        if (kind == TextBufferKind::instances) { auto p = resource("text-instance",count); state.instances=p; gpu.destroy_instances=[this,p]{destroy(p);}; }
        if (kind == TextBufferKind::styles) { auto p = resource("text-styles",count); state.styles=p; gpu.destroy_styles=[this,p]{destroy(p);}; }
    }
    void create_atlas_texture(TextAtlasGpuState& gpu, TextAtlasTextureKind kind, std::size_t width, std::size_t rows) {
        auto& state=atlas(gpu);
        if (kind == TextAtlasTextureKind::curves) { auto p=resource("text-slug-curves",width*rows*16); state.curves=p; gpu.destroy_curves=[this,p]{destroy(p);}; }
        else { auto p=resource("text-slug-bands",width*rows*16); state.bands=p; gpu.destroy_bands=[this,p]{destroy(p);}; }
    }
    void create_atlas_metadata(TextAtlasGpuState& gpu, std::size_t count) {
        auto p=resource("text-glyph-metadata",count); atlas(gpu).metadata=p; gpu.destroy_metadata=[this,p]{destroy(p);};
    }
    void write_renderable_buffer(TextGpuState& gpu, TextBufferKind kind, std::size_t offset, std::span<const std::uint8_t> data) {
        const auto& state=render(gpu); write(kind==TextBufferKind::uniform ? state.uniform : kind==TextBufferKind::instances ? state.instances : state.styles,offset,data);
    }
    void write_atlas_texture(TextAtlasGpuState& gpu, TextAtlasTextureKind kind, std::span<const std::uint8_t> data, std::size_t row_bytes, std::size_t width, std::size_t rows) {
        if (row_bytes!=width*16 || row_bytes*rows>data.size()) throw std::runtime_error("texture extent");
        const auto& state=atlas(gpu); write(kind==TextAtlasTextureKind::curves ? state.curves : state.bands,0,data.first(row_bytes*rows));
    }
    void write_atlas_metadata(TextAtlasGpuState& gpu, std::span<const std::uint8_t> data) { write(atlas(gpu).metadata,0,data); }
    std::shared_ptr<void> create_bind_group(TextGpuState& gpu, const TextAtlasGpuState& atlas_gpu, const std::shared_ptr<void>& layout) {
        failure("group"); auto group=std::make_shared<Resource>(Resource{next++,"group"});
        const auto& r=render(gpu); const auto& a=atlas(atlas_gpu);
        event("group",group->id,id(layout),r.uniform->id,a.curves->id,a.bands->id,a.metadata->id,r.styles->id); return group;
    }
    static int id(const std::shared_ptr<void>& value) { return value ? std::static_pointer_cast<Resource>(value)->id : 0; }
    void set_quad_vertex_buffer(const std::shared_ptr<void>& quad) { event("vertex",0,id(quad)); }
    void set_instance_vertex_buffer(const TextGpuState& gpu) { event("vertex",1,render(gpu).instances->id); }
    void set_pipeline(const std::shared_ptr<void>& pipeline) { event("pipeline",id(pipeline)); }
    void set_bind_group(const std::shared_ptr<void>& group) { event("bind",id(group)); }
    void draw(std::size_t a,std::size_t b,std::size_t c,std::size_t d) { event("draw",a,b,c,d); }
};
std::vector<std::uint8_t> pattern(std::size_t count, std::size_t seed) {
    std::vector<std::uint8_t> bytes(count); for(std::size_t i=0;i<count;++i) bytes[i]=static_cast<std::uint8_t>((i*37+seed)&255); return bytes;
}
