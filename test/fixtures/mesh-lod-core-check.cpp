// Runs the lowered MeshLoD core (test/mesh-lod-core.test.ts) over the statue's
// three `.mlod` primitives and a scenario, printing what the pinned modules
// print for the same scenario under Node: the parsed containers, decoded pages,
// stable failures, CPU selection frames, the CPU page cache and the geometry
// arena with residency eviction.

#include "mesh-lod-core.hpp"

#include <cmath>
#include <fstream>
#include <functional>
#include <iostream>
#include <iterator>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace {

using bbl::js::JsonValue;
using Bytes = bbl::js::TypedArray<std::uint8_t>;

std::string num(double value) {
    if (value == 0.0 && std::signbit(value))
        return "-0";
    return bbl::js::number_to_string(value);
}

template <class Values> std::string list(const Values& values) {
    std::string text;
    for (std::size_t index = 0; index < values.size(); ++index)
        text += (index ? "," : "") + num(values[index]);
    return text;
}

Bytes read_bytes(const char* path) {
    std::ifstream file(path, std::ios::binary);
    std::vector<std::uint8_t> bytes((std::istreambuf_iterator<char>(file)),
                                    std::istreambuf_iterator<char>());
    return Bytes(std::move(bytes));
}

std::string read_text(const char* path) {
    std::ifstream file(path, std::ios::binary);
    std::stringstream text;
    text << file.rdbuf();
    return text.str();
}

Bytes view(const Bytes& bytes, double begin, double end) {
    return bbl::js::typed_array_subarray(bytes, begin, end);
}

std::size_t count(const JsonValue& values) { return static_cast<std::size_t>(values.length()); }
JsonValue at(const JsonValue& values, std::size_t index) {
    return values.at(static_cast<double>(index));
}

template <class F> void guarded(const std::string& label, F&& action) {
    try {
        action();
    } catch (...) {
        const bbl::js::Error error(std::current_exception());
        if (const auto thrown = bbl::pinned::error_instance<bbl::MeshLoDError>(error))
            std::cout << label << ": error " << thrown->code << " " << thrown->message << "\n";
        else
            std::cout << label << ": error - " << bbl::js::error_message(error) << "\n";
    }
}

/** `records.reduce((total, record) => total + field(record), 0)` for each field. */
template <class Records, class... Fields>
std::string sums(const Records& records, const Fields&... fields) {
    std::string text;
    const auto sum = [&](const auto& field) {
        double total = 0;
        for (const auto& record : records)
            total += field(record);
        text += (text.empty() ? "" : ",") + num(total);
    };
    (sum(fields), ...);
    return text;
}

double flag(bool value) { return value ? 1 : 0; }

double tuple_sum(const bbl::js::Tuple<4>& values) {
    double total = 0;
    for (const double value : values)
        total += value;
    return total;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 5)
        return 2;
    const JsonValue s = bbl::js::json_parse(read_text(argv[1]));
    const std::vector<Bytes> files = {read_bytes(argv[2]), read_bytes(argv[3]),
                                      read_bytes(argv[4])};
    const bbl::pal::MeshoptDecoder decoder;

    // The containers.
    std::vector<std::shared_ptr<bbl::ParsedMeshLoDContainer>> parsed_files;
    for (std::size_t index = 0; index < files.size(); ++index) {
        const Bytes& bytes = files[index];
        const std::string label = "file " + std::to_string(index);
        const auto extent = bbl::read_bootstrap_extent(view(bytes, 0, 256));
        std::cout << label << ": extent total=" << num(extent->total_file_bytes)
                  << " bootstrap=" << num(extent->bootstrap_bytes) << "\n";
        const auto parsed = bbl::parse_mesh_lo_d_container(view(bytes, 0, extent->bootstrap_bytes));
        parsed_files.push_back(parsed);
        const bbl::MeshLoDMetadata meta = bbl::to_mesh_lo_d_metadata(parsed);
        std::cout << label << ": meta formatMajor=" << num(meta.format_major)
                  << " formatMinor=" << num(meta.format_minor)
                  << " toolVersion=" << meta.tool_version
                  << " meshoptimizerRevision=" << meta.meshoptimizer_revision
                  << " cgltfRevision=" << meta.cgltf_revision
                  << " sourceSha256=" << meta.source_sha256
                  << " buildFingerprintSha256=" << meta.build_fingerprint_sha256
                  << " meshIndex=" << num(meta.mesh_index)
                  << " primitiveIndex=" << num(meta.primitive_index)
                  << " sourceTriangleCount=" << num(meta.source_triangle_count)
                  << " hierarchyTriangleCount=" << num(meta.hierarchy_triangle_count)
                  << " clusterCount=" << num(meta.cluster_count)
                  << " groupCount=" << num(meta.group_count)
                  << " hierarchyNodeCount=" << num(meta.hierarchy_node_count)
                  << " hierarchyDepth=" << num(meta.hierarchy_depth)
                  << " pageCount=" << num(meta.page_count)
                  << " pinnedPageCount=" << num(meta.pinned_page_count)
                  << " boundsMin=" << list(meta.bounds_min)
                  << " boundsMax=" << list(meta.bounds_max) << "\n";
        const bbl::MeshLoDHeader& header = parsed->header;
        std::cout << label << ": header flags=" << num(header.container_flags)
                  << " directory=" << num(header.directory_offset) << "+"
                  << num(header.directory_bytes) << " hierarchy=" << header.hierarchy_id
                  << " levels=" << num(header.level_count)
                  << " attributes=" << num(header.attribute_mask)
                  << " stride=" << num(header.vertex_stride)
                  << " maxError=" << num(header.max_nonterminal_error) << "\n";
        std::cout << label << ": sections";
        for (const auto& section : parsed->sections)
            std::cout << " " << num(section.type) << ":" << num(section.flags) << ":"
                      << num(section.offset) << ":" << num(section.stored_bytes) << ":"
                      << num(section.decoded_bytes) << ":" << num(section.element_count) << ":"
                      << num(section.crc);
        std::cout << "\n";
        using Group = bbl::MeshLoDGroup;
        std::cout << label << ": groups " << parsed->groups.size() << " "
                  << sums(
                         parsed->groups, [](const Group& g) { return g.center[0]; },
                         [](const Group& g) { return g.center[1]; },
                         [](const Group& g) { return g.center[2]; },
                         [](const Group& g) { return g.radius; },
                         [](const Group& g) {
                             return std::isfinite(g.simplified_error) ? g.simplified_error : 0;
                         },
                         [](const Group& g) { return g.depth; },
                         [](const Group& g) { return g.first_cluster; },
                         [](const Group& g) { return g.cluster_count; },
                         [](const Group& g) { return g.first_page_ref; },
                         [](const Group& g) { return g.page_ref_count; },
                         [](const Group& g) { return flag(g.terminal); },
                         [](const Group& g) { return flag(g.pinned); },
                         [](const Group& g) { return g.source_triangle_count; },
                         [](const Group& g) { return g.output_triangle_count; })
                  << "\n";
        using Cluster = bbl::MeshLoDCluster;
        std::cout << label << ": clusters " << parsed->clusters.size() << " "
                  << sums(
                         parsed->clusters, [](const Cluster& c) { return c.center[0]; },
                         [](const Cluster& c) { return c.center[1]; },
                         [](const Cluster& c) { return c.center[2]; },
                         [](const Cluster& c) { return c.radius; },
                         [](const Cluster& c) { return c.error; },
                         [](const Cluster& c) { return c.group_id; },
                         [](const Cluster& c) { return c.refined_group_id; },
                         [](const Cluster& c) { return c.page_id; },
                         [](const Cluster& c) { return c.vertex_offset; },
                         [](const Cluster& c) { return c.index_offset; },
                         [](const Cluster& c) { return c.vertex_count; },
                         [](const Cluster& c) { return c.triangle_count; },
                         [](const Cluster& c) { return c.source_triangle_count; },
                         [](const Cluster& c) { return flag(c.normal_cone.has_value()); },
                         [](const Cluster& c) {
                             return c.normal_cone ? tuple_sum(*c.normal_cone) : 0;
                         })
                  << "\n";
        using Node = bbl::MeshLoDHierarchyNode;
        std::cout << label << ": nodes " << parsed->hierarchy_nodes.size() << " "
                  << sums(
                         parsed->hierarchy_nodes, [](const Node& n) { return n.center[0]; },
                         [](const Node& n) { return n.center[1]; },
                         [](const Node& n) { return n.center[2]; },
                         [](const Node& n) { return n.radius; },
                         [](const Node& n) { return n.error; },
                         [](const Node& n) { return n.group_id; },
                         [](const Node& n) { return n.child_offset; },
                         [](const Node& n) { return n.child_count; })
                  << "\n";
        using Page = bbl::MeshLoDPageRecord;
        std::cout << label << ": pages " << parsed->page_records.size() << " "
                  << sums(
                         parsed->page_records, [](const Page& p) { return p.offset; },
                         [](const Page& p) { return p.stored_bytes; },
                         [](const Page& p) { return p.meaningful_bytes; },
                         [](const Page& p) { return p.decoded_bytes; },
                         [](const Page& p) { return p.crc; },
                         [](const Page& p) { return p.vertex_count; },
                         [](const Page& p) { return p.local_index_count; },
                         [](const Page& p) { return p.vertex_byte_offset; },
                         [](const Page& p) { return p.index_byte_offset; },
                         [](const Page& p) { return p.first_cluster; },
                         [](const Page& p) { return p.cluster_count; },
                         [](const Page& p) { return flag(p.pinned); },
                         [](const Page& p) { return flag(p.coarse); },
                         [](const Page& p) { return p.min_depth; },
                         [](const Page& p) { return p.max_depth; })
                  << "\n";
        double refs = 0;
        for (std::size_t ref = 0; ref < parsed->group_page_refs.size(); ++ref)
            refs += parsed->group_page_refs.load(ref);
        std::cout << label << ": refs " << parsed->group_page_refs.size() << " " << num(refs)
                  << " pinnedAllocation=" << num(bbl::pinned_allocation_bytes(parsed->page_records))
                  << "\n";
        const JsonValue decode = at(s.get("decode"), index);
        for (std::size_t entry = 0; entry < count(decode); ++entry) {
            const double id = at(decode, entry).to_number();
            const bbl::MeshLoDPageRecord& record =
                parsed->page_records[static_cast<std::size_t>(id)];
            const std::string page = "page " + std::to_string(index) + "." + num(id);
            guarded(page, [&] {
                const bbl::DecodedMeshLoDPage decoded = bbl::decode_mesh_lo_d_page(
                    view(bytes, record.offset, record.offset + record.stored_bytes), record,
                    decoder);
                std::cout << page << ": vertices=" << num(decoded.vertex_count)
                          << " indices=" << num(decoded.index_count)
                          << " bytes=" << decoded.decoded.size()
                          << " crc=" << num(bbl::crc32c(decoded.decoded)) << "\n";
            });
        }
    }

    // Failures the pin reports with stable codes.
    const Bytes& first = files[0];
    guarded("truncated", [&] { bbl::parse_mesh_lo_d_container(view(first, 0, 200)); });
    guarded("bad magic", [&] {
        Bytes head = bbl::js::typed_array_slice(first, 0, 256);
        head.store(0, 0);
        bbl::read_bootstrap_extent(head);
    });
    const bbl::MeshLoDPageRecord& page0 = parsed_files[0]->page_records[0];
    guarded("short bootstrap",
            [&] { bbl::parse_mesh_lo_d_container(view(first, 0, page0.offset)); });
    guarded("corrupt page", [&] {
        Bytes stored =
            bbl::js::typed_array_slice(first, page0.offset, page0.offset + page0.stored_bytes);
        stored.store(stored.size() - 1,
                     static_cast<std::uint8_t>(stored.load(stored.size() - 1) ^ 0xff));
        bbl::decode_mesh_lo_d_page(stored, page0, decoder);
    });
    guarded("wrong record", [&] {
        bbl::decode_mesh_lo_d_page(view(first, page0.offset, page0.offset + page0.stored_bytes),
                                   parsed_files[0]->page_records[1], decoder);
    });

    // The CPU selector, each primitive's frames carrying its fine bits.
    std::map<std::size_t, Bytes> fine_bits;
    const JsonValue frames = s.get("frames");
    for (std::size_t index = 0; index < count(frames); ++index) {
        const JsonValue frame = at(frames, index);
        const auto file = static_cast<std::size_t>(frame.get("file").to_number());
        const auto parsed = parsed_files[file];
        bbl::js::Array<double> matrix;
        for (std::size_t entry = 0; entry < 16; ++entry)
            matrix.push_back(at(frame.get("matrix"), entry).to_number());
        const auto planes = bbl::extract_frustum_planes(matrix);
        std::cout << "frame " << index << ": planes";
        for (const auto& plane : planes)
            std::cout << " " << list(plane);
        std::cout << "\n";
        bbl::MeshLoDSelectionInput input;
        input.groups = parsed->groups;
        input.clusters = parsed->clusters;
        input.nodes = parsed->hierarchy_nodes;
        input.page_records = parsed->page_records;
        input.group_page_refs = parsed->group_page_refs;
        input.level_count = parsed->header.level_count;
        input.world_matrix = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
        for (std::size_t axis = 0; axis < 3; ++axis)
            input.camera.position[axis] = at(frame.get("position"), axis).to_number();
        input.camera.vertical_fov = 0.8;
        input.camera.near = 0.1;
        input.camera.target_width = 1920;
        input.camera.target_height = 1080;
        input.frustum_planes = planes;
        input.screen_space_error = 1;
        input.lod_hysteresis = 0.1;
        const double modulo = frame.get("residentModulo").to_number();
        input.is_page_resident = [records = parsed->page_records, modulo](double page_id) {
            return records[static_cast<std::size_t>(page_id)].pinned ||
                   std::fmod(page_id, modulo) == 0;
        };
        const auto previous = fine_bits.find(file);
        input.was_fine_required =
            previous != fine_bits.end() ? previous->second : Bytes(parsed->groups.size());
        input.cone_cull = frame.get("coneCull").truthy();
        const auto result = bbl::select_mesh_lo_d_cpu(input);
        fine_bits[file] = result->fine_required;
        double ids = 0;
        for (std::size_t entry = 0; entry < result->selected_cluster_ids.size(); ++entry)
            ids += result->selected_cluster_ids.load(entry);
        double benefits = 0;
        for (const auto& entry : result->page_benefits)
            benefits += entry.second;
        double fine = 0;
        for (std::size_t entry = 0; entry < result->fine_required.size(); ++entry)
            fine += result->fine_required.load(entry);
        std::cout << "frame " << index << ": selected=" << result->selected_cluster_ids.size()
                  << " ids=" << num(ids) << " desired=" << result->desired_pages.size() << " ";
        for (std::size_t entry = 0; entry < result->desired_pages.size() && entry < 8; ++entry)
            std::cout << (entry ? " " : "") << num(result->desired_pages[entry].page_id) << ":"
                      << num(result->desired_pages[entry].priority);
        std::cout << " benefits=" << result->page_benefits.size() << ":" << num(benefits)
                  << " fine=" << num(fine) << " visible=" << num(result->visible_group_count)
                  << " fallback=" << num(result->fallback_group_count)
                  << " triangles=" << num(result->rendered_triangle_count)
                  << " meshlets=" << num(result->selected_meshlet_count)
                  << " maxSelected=" << num(result->maximum_selected_error_pixels)
                  << " maxUnmet=" << num(result->maximum_unmet_error_pixels) << "\n";
    }

    // The CPU page cache over the first primitive's stored pages.
    const auto& records = parsed_files[0]->page_records;
    const auto stored_page = [&](double id) {
        const auto& record = records[static_cast<std::size_t>(id)];
        return view(first, record.offset, record.offset + record.stored_bytes);
    };
    const auto cache = bbl::create_mesh_lo_d_cpu_page_cache(s.get("cacheBudget").to_number());
    const JsonValue cache_ops = s.get("cache");
    for (std::size_t index = 0; index < count(cache_ops); ++index) {
        const JsonValue op = at(cache_ops, index);
        const std::string kind = op.get("op").string_value();
        std::string result;
        if (kind == "put")
            bbl::put_mesh_lo_d_cpu_page(cache, op.get("page").to_number(),
                                        stored_page(op.get("page").to_number()),
                                        op.get("pinned").truthy(), op.get("frame").to_number());
        else if (kind == "get") {
            const auto bytes = bbl::get_mesh_lo_d_cpu_page(cache, op.get("page").to_number(),
                                                           op.get("frame").to_number());
            result = " got=" + (bytes ? std::to_string(bytes->size()) : std::string("null"));
        } else if (kind == "touch")
            bbl::touch_mesh_lo_d_cpu_page(cache, op.get("page").to_number(),
                                          op.get("frame").to_number());
        else if (kind == "budget")
            bbl::set_mesh_lo_d_cpu_cache_budget(cache, op.get("bytes").to_number());
        else
            bbl::clear_mesh_lo_d_cpu_page_cache(cache);
        std::string ids;
        for (const auto& entry : cache->entries)
            ids += (ids.empty() ? "" : ",") + num(entry.first);
        std::cout << "cache " << index << " " << kind << ":" << result
                  << " used=" << num(bbl::cpu_cache_used_bytes(cache)) << " ids=" << ids << "\n";
    }

    // The geometry arena and residency eviction over the first primitive's pages.
    const double blocks = s.get("arenaBlocks").to_number();
    const auto arena = bbl::js::make_gc_shared<bbl::MeshLoDArena>();
    arena->capacity_bytes = blocks * 65536;
    arena->block_count = blocks;
    arena->blocks = Bytes(static_cast<std::size_t>(blocks));
    arena->pinned_blocks = Bytes(static_cast<std::size_t>(blocks));
    bbl::js::Array<std::shared_ptr<bbl::MeshLoDPageRuntime>> pages;
    for (std::size_t id = 0; id < records.size(); ++id) {
        auto page = bbl::js::make_gc_shared<bbl::MeshLoDPageRuntime>();
        page->id = static_cast<double>(id);
        page->state = "unrequested";
        page->arena_offset = -1;
        page->priority = static_cast<double>(id % 3);
        pages.push_back(page);
    }
    const JsonValue arena_ops = s.get("arena");
    for (std::size_t index = 0; index < count(arena_ops); ++index) {
        const JsonValue op = at(arena_ops, index);
        const std::string kind = op.get("op").string_value();
        const auto id = kind == "evict" ? 0 : static_cast<std::size_t>(op.get("page").to_number());
        std::string result;
        if (kind == "alloc") {
            const auto offset = bbl::allocate_arena_run(arena, records[id].decoded_bytes,
                                                        op.get("pinned").truthy());
            if (offset) {
                pages[id]->state = "gpu-resident";
                pages[id]->arena_offset = *offset;
                pages[id]->arena_bytes = records[id].decoded_bytes;
                pages[id]->last_used_frame = static_cast<double>(index);
            }
            result = "offset=" + (offset ? num(*offset) : std::string("null"));
        } else if (kind == "free") {
            bbl::free_arena_run(arena, pages[id]->arena_offset, pages[id]->arena_bytes);
            pages[id]->state = "unrequested";
            pages[id]->arena_offset = -1;
            pages[id]->arena_bytes = 0;
        } else {
            bbl::js::Array<double> evicted;
            bbl::MeshLoDEvictionPolicy policy;
            policy.budget_bytes = op.get("budget").to_number();
            policy.current_frame = op.get("frame").to_number();
            policy.residency_hold_frames = 120;
            if (kind == "reserve") {
                const auto offset = bbl::reserve_mesh_lo_d_arena_run(
                    arena, pages, records, records[id].decoded_bytes, policy, evicted);
                result = "offset=" + (offset ? num(*offset) : std::string("null")) + " ";
            } else
                bbl::evict_mesh_lo_d_to_budget(arena, pages, records, policy, evicted);
            std::string ids;
            for (const double evicted_id : evicted)
                ids += (ids.empty() ? "" : ",") + num(evicted_id);
            result += "evicted=" + ids;
        }
        std::string occupancy;
        for (std::size_t block = 0; block < arena->blocks.size(); ++block)
            occupancy += std::to_string(arena->blocks.load(block));
        std::cout << "arena " << index << " " << kind << ": " << result
                  << " used=" << num(bbl::arena_used_bytes(arena))
                  << " committed=" << num(arena->committed_blocks)
                  << " pinned=" << num(arena->pinned_count) << " blocks=" << occupancy << "\n";
    }
    return 0;
}
