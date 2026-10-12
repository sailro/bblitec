// Runs the lowered splat-stream core (test/splat-stream-core.test.ts) over a
// scenario and the real manifest, printing what the pinned modules print for
// the same scenario under Node: option normalization, the parsed manifest,
// SOG metadata and image validation, frustum planes, selection plans, the
// source cache's admission/eviction/protection and the GPU ledger.

#include "splat-stream-core.hpp"

#include <cmath>
#include <cstdio>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <string>
#include <type_traits>
#include <vector>

// ── A deterministic URL: RFC 3986 resolution over the http(s) subset the
// scenario uses, serialized as WHATWG serializes it. ──────────────────────

namespace bbl::splat_stream_platform {

struct UrlState {
    std::string protocol;
    std::string host;
    std::string pathname;
    std::string search;
    std::string hash;
    bool special = true;
};

namespace {

[[noreturn]] void invalid_url() { throw js::NamedError("TypeError", "Invalid URL"); }

std::string lower(std::string value) {
    for (char& character : value)
        if (character >= 'A' && character <= 'Z')
            character = static_cast<char>(character - 'A' + 'a');
    return value;
}

/** The scheme of an absolute reference, without its colon, or empty. */
std::string scheme_of(const std::string& input) {
    if (input.empty() || !std::isalpha(static_cast<unsigned char>(input[0])))
        return {};
    for (std::size_t index = 1; index < input.size(); ++index) {
        const char character = input[index];
        if (character == ':')
            return input.substr(0, index);
        if (!std::isalnum(static_cast<unsigned char>(character)) && character != '+' &&
            character != '-' && character != '.')
            return {};
    }
    return {};
}

/** Split `rest` into path, query and fragment. */
void split_tail(const std::string& rest, UrlState& url) {
    const std::size_t hash = rest.find('#');
    const std::string before = hash == std::string::npos ? rest : rest.substr(0, hash);
    url.hash = hash == std::string::npos ? "" : rest.substr(hash);
    const std::size_t query = before.find('?');
    url.pathname = query == std::string::npos ? before : before.substr(0, query);
    url.search = query == std::string::npos ? "" : before.substr(query);
    if (url.search == "?")
        url.search.clear();
    if (url.hash == "#")
        url.hash.clear();
}

std::string remove_dot_segments(const std::string& path) {
    std::vector<std::string> segments;
    std::size_t start = 1;
    while (start <= path.size()) {
        const std::size_t end = path.find('/', start);
        const std::string segment =
            path.substr(start, end == std::string::npos ? std::string::npos : end - start);
        const bool last = end == std::string::npos;
        if (segment == "..") {
            if (!segments.empty())
                segments.pop_back();
            if (last)
                segments.emplace_back();
        } else if (segment == ".") {
            if (last)
                segments.emplace_back();
        } else
            segments.push_back(segment);
        if (last)
            break;
        start = end + 1;
    }
    std::string result;
    for (const auto& segment : segments)
        result += "/" + segment;
    return result.empty() ? "/" : result;
}

Url parse_absolute(const std::string& input) {
    const std::string scheme = scheme_of(input);
    if (scheme.empty())
        invalid_url();
    auto url = std::make_shared<UrlState>();
    url->protocol = lower(scheme) + ":";
    url->special = url->protocol == "http:" || url->protocol == "https:";
    std::string rest = input.substr(scheme.size() + 1);
    if (!url->special) {
        split_tail(rest, *url);
        return url;
    }
    if (rest.rfind("//", 0) != 0)
        invalid_url();
    rest = rest.substr(2);
    const std::size_t end = rest.find_first_of("/?#");
    url->host = lower(rest.substr(0, end));
    if (url->host.empty())
        invalid_url();
    split_tail(end == std::string::npos ? "" : rest.substr(end), *url);
    url->pathname = remove_dot_segments(url->pathname.empty() ? "/" : url->pathname);
    return url;
}

} // namespace

Url url_parse(const std::string& input) { return parse_absolute(input); }

Url url_parse(const std::string& input, const std::string& base) {
    if (!scheme_of(input).empty())
        return parse_absolute(input);
    const Url resolved_base = parse_absolute(base);
    auto url = std::make_shared<UrlState>(*resolved_base);
    if (!url->special)
        invalid_url();
    if (input.rfind("//", 0) == 0)
        return parse_absolute(url->protocol + input);
    UrlState reference;
    split_tail(input, reference);
    url->hash = reference.hash;
    if (reference.pathname.empty()) {
        if (input.rfind('#', 0) != 0)
            url->search = reference.search;
        return url;
    }
    url->search = reference.search;
    if (reference.pathname[0] == '/')
        url->pathname = remove_dot_segments(reference.pathname);
    else
        url->pathname = remove_dot_segments(url->pathname.substr(0, url->pathname.rfind('/') + 1) +
                                            reference.pathname);
    return url;
}

std::string url_href(const Url& url) {
    return url->protocol + (url->special ? "//" + url->host : "") + url->pathname + url->search +
           url->hash;
}
std::string url_protocol(const Url& url) { return url->protocol; }
std::string url_pathname(const Url& url) { return url->pathname; }
void url_set_pathname(const Url& url, const std::string& pathname) {
    url->pathname = pathname.empty() || pathname[0] != '/' ? "/" + pathname : pathname;
}

} // namespace bbl::splat_stream_platform

namespace {

using bbl::js::JsonValue;

std::string num(double value) {
    if (value == 0.0 && std::signbit(value))
        return "-0";
    return bbl::js::number_to_string(value);
}

std::string read_file(const char* path) {
    std::ifstream file(path, std::ios::binary);
    std::stringstream text;
    text << file.rdbuf();
    return text.str();
}

double number(const JsonValue& value, const char* key) { return value.get(key).to_number(); }

/** A JSON list of numbers as the typed array the pin passes. */
bbl::js::TypedArray<float> floats(const JsonValue& list) {
    bbl::js::TypedArray<float> result(static_cast<std::size_t>(list.length()));
    for (std::size_t index = 0; index < result.size(); ++index)
        result.store(index, static_cast<float>(list.at(static_cast<double>(index)).to_number()));
    return result;
}

std::string vector3(const bbl::js::TypedArray<float>& values) {
    return num(values.load(0)) + "," + num(values.load(1)) + "," + num(values.load(2));
}

template <class F> void guarded(const std::string& label, F&& action) {
    try {
        action();
    } catch (const std::exception& error) {
        std::cout << label << ": error " << error.what() << "\n";
    }
}

/** The pinned refs record `setSplatSourceProtection` takes (an anonymous record). */
template <class> struct ThirdParameter;
template <class R, class A, class B, class C> struct ThirdParameter<R (*)(A, B, C)> {
    using type = typename std::remove_cvref_t<C>::element_type;
};
using ProtectionRefs = ThirdParameter<decltype(&bbl::set_splat_source_protection)>::type;

struct FakeGpu final : bbl::GpuObject {
    FakeGpu(std::string label, std::shared_ptr<std::vector<std::string>> destroyed)
        : name(std::move(label)), log(std::move(destroyed)) {}
    void destroy() override { log->push_back(name); }
    std::string name;
    std::shared_ptr<std::vector<std::string>> log;
};

void print_plan(const std::string& label, const std::shared_ptr<bbl::StreamSelectionPlan>& plan) {
    std::cout << label << ": visible=" << num(plan->visible_leaves)
              << " selected=" << num(plan->selected_splats) << " holds="
              << (plan->holds_applied.has_value() ? (*plan->holds_applied ? "true" : "false")
                                                  : "undefined")
              << "\n";
    for (const auto& selection : plan->selections)
        std::cout << "  sel leaf=" << num(*selection->leaf->id)
                  << " lod=" << num(selection->target->lod)
                  << " file=" << num(selection->target->file_id)
                  << " offset=" << num(selection->target->offset)
                  << " count=" << num(selection->target->count)
                  << " projectedError=" << num(selection->projected_error)
                  << " distance=" << num(selection->distance_to_camera)
                  << " projectedRadius=" << num(selection->projected_radius) << "\n";
}

using Targets = bbl::js::Map<double, std::shared_ptr<bbl::StreamRepresentation>>;

Targets targets_of(const std::shared_ptr<bbl::StreamSelectionPlan>& plan) {
    Targets targets;
    for (const auto& selection : plan->selections)
        targets.set(*selection->leaf->id, selection->target);
    return targets;
}

} // namespace

int main(int argc, char** argv) {
    if (argc != 3)
        return 2;
    const JsonValue scenario = bbl::js::json_parse(read_file(argv[1]));
    const std::string manifest_text = read_file(argv[2]);
    const std::string manifest_url = scenario.get("manifestUrl").string_value();

    // Option normalization.
    const JsonValue options = scenario.get("options");
    for (std::size_t index = 0; index < static_cast<std::size_t>(options.length()); ++index) {
        const JsonValue given = options.at(static_cast<double>(index));
        const std::string label = "options " + std::to_string(index);
        guarded(label, [&] {
            bbl::GaussianSplatStreamOptions input;
            const auto optional = [&](const char* key) {
                const JsonValue value = given.get(key);
                return value.is_undefined() ? bbl::js::Nullable<double>{}
                                            : bbl::js::Nullable<double>(value.to_number());
            };
            input.max_splats = optional("maxSplats");
            input.max_capacity_splats = optional("maxCapacitySplats");
            input.max_gpu_bytes = optional("maxGpuBytes");
            input.max_cpu_bytes = optional("maxCpuBytes");
            input.max_concurrent_requests = optional("maxConcurrentRequests");
            input.max_concurrent_decodes = optional("maxConcurrentDecodes");
            input.screen_error = optional("screenError");
            input.lod_hysteresis = optional("lodHysteresis");
            input.lod_cooldown_ms = optional("lodCooldownMs");
            input.max_retries = optional("maxRetries");
            const auto normalized = bbl::normalize_splat_stream_options(input);
            std::cout << label << ": maxSplats=" << num(normalized.max_splats)
                      << " maxCapacitySplats=" << num(normalized.max_capacity_splats)
                      << " maxGpuBytes=" << num(normalized.max_gpu_bytes)
                      << " maxCpuBytes=" << num(normalized.max_cpu_bytes)
                      << " maxConcurrentRequests=" << num(normalized.max_concurrent_requests)
                      << " maxConcurrentDecodes=" << num(normalized.max_concurrent_decodes)
                      << " screenError=" << num(normalized.screen_error)
                      << " lodHysteresis=" << num(normalized.lod_hysteresis)
                      << " lodCooldownMs=" << num(normalized.lod_cooldown_ms)
                      << " maxRetries=" << num(normalized.max_retries) << "\n";
        });
    }

    // The real manifest.
    const auto manifest =
        bbl::parse_splat_stream_manifest(bbl::js::json_parse(manifest_text), manifest_url);
    std::cout << "manifest: lodLevels=" << num(manifest->lod_levels)
              << " leaves=" << manifest->leaves.size() << " sources=" << manifest->sources.size()
              << " environment="
              << (manifest->environment_url ? *manifest->environment_url : std::string("null"))
              << "\n";
    for (const auto& leaf : manifest->leaves) {
        std::cout << "leaf " << num(*leaf->id) << ": min=" << vector3(leaf->bound_min)
                  << " max=" << vector3(leaf->bound_max) << " center=" << vector3(leaf->center)
                  << " radius=" << num(leaf->radius) << "\n";
        for (const auto& representation : *leaf->alternatives)
            std::cout << "  rep leaf=" << num(representation->leaf_id)
                      << " lod=" << num(representation->lod)
                      << " file=" << num(representation->file_id)
                      << " offset=" << num(representation->offset)
                      << " count=" << num(representation->count)
                      << " error=" << num(representation->error) << "\n";
    }
    for (const auto& source : manifest->sources)
        std::cout << "source " << num(source->id) << ": " << source->url
                  << " consumers=" << source->consumers.size() << "\n";
    std::string tree;
    const auto walk = [&](const auto& self,
                          const std::shared_ptr<bbl::StreamTreeNode>& node) -> void {
        if (node->kind == "leaf") {
            tree += " l" + num(*node->id);
            return;
        }
        tree += " b(" + num(node->radius);
        for (const auto& child : *node->children)
            self(self, child);
        tree += " )";
    };
    walk(walk, manifest->root);
    std::cout << "tree:" << tree << "\n";

    const JsonValue invalid = scenario.get("invalidManifests");
    for (std::size_t index = 0; index < static_cast<std::size_t>(invalid.length()); ++index) {
        const std::string label = "invalid " + std::to_string(index);
        guarded(label, [&] {
            const auto parsed = bbl::parse_splat_stream_manifest(
                bbl::js::json_parse(invalid.at(static_cast<double>(index)).string_value()),
                manifest_url);
            std::cout << label << ": ok leaves=" << parsed->leaves.size()
                      << " sources=" << parsed->sources.size() << "\n";
        });
    }

    // SOG metadata and decoded-image validation.
    const JsonValue sog = scenario.get("sog");
    const std::string sog_url = sog.get("url").string_value();
    std::vector<std::shared_ptr<bbl::SogV2SourceMetadata>> metas;
    const JsonValue sog_metas = sog.get("metas");
    for (std::size_t index = 0; index < static_cast<std::size_t>(sog_metas.length()); ++index) {
        const std::string label = "sog " + std::to_string(index);
        metas.emplace_back();
        guarded(label, [&] {
            const auto metadata = bbl::parse_loose_sog_v2_metadata(
                bbl::js::json_parse(sog_metas.at(static_cast<double>(index)).string_value()),
                sog_url);
            metas.back() = metadata;
            std::cout << label << ": count=" << num(metadata->count)
                      << " meansMin=" << vector3(metadata->means_min)
                      << " meansMax=" << vector3(metadata->means_max)
                      << " scale0=" << num(metadata->scale_codebook.load(0))
                      << " sh0last=" << num(metadata->sh0_codebook.load(255)) << " urls=";
            for (std::size_t url = 0; url < metadata->image_urls.size(); ++url)
                std::cout << (url ? "|" : "") << metadata->image_urls[url];
            std::cout << "\n";
        });
    }
    const JsonValue image_cases = sog.get("images");
    for (std::size_t index = 0; index < static_cast<std::size_t>(image_cases.length()); ++index) {
        const JsonValue given = image_cases.at(static_cast<double>(index));
        const std::string label = "images " + std::to_string(index);
        guarded(label, [&] {
            bbl::js::Array<std::shared_ptr<bbl::SogImageInfo>> images;
            const JsonValue list = given.get("images");
            for (std::size_t image = 0; image < static_cast<std::size_t>(list.length()); ++image) {
                const JsonValue info = list.at(static_cast<double>(image));
                auto record = bbl::js::make_gc_shared<bbl::SogImageInfo>();
                record->width = number(info, "width");
                record->height = number(info, "height");
                if (info.get("mimeType").is_string())
                    record->mime_type = info.get("mimeType").string_value();
                if (info.get("url").is_string())
                    record->url = info.get("url").string_value();
                images.push_back(record);
            }
            bbl::js::Array<std::shared_ptr<bbl::SogInterval>> intervals;
            const JsonValue spans = given.get("intervals");
            for (std::size_t span = 0; span < static_cast<std::size_t>(spans.length()); ++span) {
                auto interval = bbl::js::make_gc_shared<bbl::SogInterval>();
                interval->offset = number(spans.at(static_cast<double>(span)), "offset");
                interval->count = number(spans.at(static_cast<double>(span)), "count");
                intervals.push_back(interval);
            }
            const double bytes = bbl::validate_loose_sog_v2_images(
                metas.at(static_cast<std::size_t>(number(given, "meta"))), images,
                number(given, "maxCpuBytes"), intervals);
            std::cout << label << ": " << num(bytes) << "\n";
        });
    }

    // Selection over camera frames.
    const JsonValue frames = scenario.get("frames");
    std::vector<std::shared_ptr<bbl::StreamSelectionPlan>> plans;
    for (std::size_t index = 0; index < static_cast<std::size_t>(frames.length()); ++index) {
        const JsonValue frame = frames.at(static_cast<double>(index));
        const std::string label = "plan " + std::to_string(index);
        plans.emplace_back();
        guarded(label, [&] {
            const auto view_projection = floats(frame.get("viewProjection"));
            if (index == 0) {
                const auto planes = bbl::extract_stream_frustum_planes(view_projection);
                std::cout << "planes:";
                for (const auto& plane : planes)
                    std::cout << " " << num(plane->x) << "," << num(plane->y) << ","
                              << num(plane->z) << "," << num(plane->w);
                std::cout << "\n";
            }
            bbl::StreamSelectionInput input;
            input.root = manifest->root;
            input.world_matrix = floats(frame.get("world"));
            input.view_projection_matrix = view_projection;
            input.projection_p11 = number(frame, "p11");
            const JsonValue camera = frame.get("camera");
            input.camera_position = bbl::js::Tuple<3>{
                camera.at(0.0).to_number(), camera.at(1.0).to_number(), camera.at(2.0).to_number()};
            input.target_height = number(frame, "targetHeight");
            input.near = number(frame, "near");
            input.max_splats = number(frame, "maxSplats");
            input.screen_error = number(frame, "screenError");
            input.lod_hysteresis = number(frame, "lodHysteresis");
            const double previous = number(frame, "previous");
            if (previous >= 0.0)
                input.previous_targets = targets_of(plans.at(static_cast<std::size_t>(previous)));
            const double held = number(frame, "held");
            if (held >= 0.0)
                input.held_targets = targets_of(plans.at(static_cast<std::size_t>(held)));
            if (frame.get("hardBudgetPressure").is_boolean())
                input.hard_budget_pressure = frame.get("hardBudgetPressure").truthy();
            if (frame.get("perspective").is_boolean())
                input.perspective = frame.get("perspective").truthy();
            plans.back() = bbl::plan_stream_selection(input);
            print_plan(label, plans.back());
        });
    }
    const JsonValue merged = scenario.get("merged");
    guarded("merged", [&] {
        bbl::js::Array<std::shared_ptr<bbl::StreamSelectionPlan>> sources;
        const JsonValue indices = merged.get("plans");
        for (std::size_t index = 0; index < static_cast<std::size_t>(indices.length()); ++index)
            sources.push_back(plans.at(
                static_cast<std::size_t>(indices.at(static_cast<double>(index)).to_number())));
        print_plan("merged",
                   bbl::plan_merged_stream_selection(
                       sources, number(merged, "maxSplats"), number(merged, "screenError"),
                       number(merged, "lodHysteresis"),
                       targets_of(plans.at(static_cast<std::size_t>(number(merged, "previous")))),
                       merged.get("hard").truthy()));
    });
    std::cout << "bootstrap: "
              << num(bbl::select_bootstrap_source(manifest->leaves, manifest->sources)->id) << "\n";
    {
        const auto world = floats(frames.at(0.0).get("world"));
        const auto bound = bbl::transform_stream_bound(manifest->leaves[0], world);
        std::cout << "bound: min=" << vector3(bound->bound_min)
                  << " max=" << vector3(bound->bound_max) << " center=" << vector3(bound->center)
                  << " radius=" << num(bound->radius) << " distance="
                  << num(bbl::distance_to_stream_bound(bound, bbl::js::Tuple<3>{1.5, -2.25, 40.0}))
                  << "\n";
    }

    // The source cache.
    const JsonValue cache_case = scenario.get("cache");
    auto destroyed = std::make_shared<std::vector<std::string>>();
    auto retirements = std::make_shared<std::vector<bbl::js::Callback<void()>>>();
    auto distances = std::make_shared<bbl::js::Map<std::string, double>>();
    const JsonValue initial = cache_case.get("distances");
    for (const auto& key : initial.own_keys())
        distances->set(key, initial.get(key).to_number());
    const JsonValue budgets = cache_case.get("invalidBudgets");
    for (std::size_t index = 0; index < static_cast<std::size_t>(budgets.length()); ++index)
        guarded("budget " + std::to_string(index), [&] {
            const JsonValue pair = budgets.at(static_cast<double>(index));
            static_cast<void>(
                bbl::create_splat_source_cache(pair.at(0.0).to_number(), pair.at(1.0).to_number()));
            std::cout << "budget " << index << ": ok\n";
        });
    const auto cache = bbl::create_splat_source_cache(
        number(cache_case, "maxGpuBytes"), number(cache_case, "maxCpuBytes"),
        bbl::js::Callback<void(bbl::js::Callback<void()>)>(
            [retirements](bbl::js::Callback<void()> dispose) { retirements->push_back(dispose); }),
        {}, bbl::js::Callback<double(std::string)>([distances](std::string url) {
            const auto found = distances->get(url);
            return found ? *found : std::numeric_limits<double>::infinity();
        }));
    const auto state = [&](const std::string& label) {
        std::cout << label << " state: resident=" << num(cache->resident_gpu_bytes)
                  << " allocated=" << num(cache->allocated_gpu_bytes)
                  << " retiring=" << num(cache->retiring_gpu_bytes)
                  << " cpu=" << num(cache->resident_cpu_bytes)
                  << " version=" << num(cache->admission_version)
                  << " disposed=" << (cache->disposed ? "true" : "false")
                  << " ledger=" << num(cache->ledger->resident_bytes) << ","
                  << num(cache->ledger->allocated_bytes) << "," << num(cache->ledger->held_bytes)
                  << " entries=";
        bool first = true;
        for (const auto& entry : cache->entries) {
            std::cout << (first ? "" : "|") << entry.first;
            first = false;
        }
        std::cout << " destroyed=";
        for (std::size_t index = 0; index < destroyed->size(); ++index)
            std::cout << (index ? "|" : "") << (*destroyed)[index];
        std::cout << "\n";
    };
    const JsonValue operations = cache_case.get("ops");
    for (std::size_t index = 0; index < static_cast<std::size_t>(operations.length()); ++index) {
        const JsonValue operation = operations.at(static_cast<double>(index));
        const std::string kind = operation.get("op").string_value();
        const std::string label = "cache " + std::to_string(index) + " " + kind;
        guarded(label, [&] {
            if (kind == "admit") {
                auto entry = bbl::js::make_gc_shared<bbl::SplatSourceCacheEntry>();
                entry->url = operation.get("url").string_value();
                entry->generation = number(operation, "generation");
                entry->width = number(operation, "width");
                entry->height = number(operation, "height");
                entry->count = number(operation, "count");
                entry->gpu_bytes = number(operation, "gpuBytes");
                entry->cpu_bytes = number(operation, "cpuBytes");
                if (operation.get("gpuReserved").is_boolean())
                    entry->gpu_reserved = operation.get("gpuReserved").truthy();
                entry->last_used_frame = number(operation, "lastUsedFrame");
                entry->resources = bbl::js::make_gc_shared<bbl::SplatSourceGpuResources>();
                const std::string name = entry->url + "#" + num(entry->generation);
                entry->resources->textures.push_back(
                    std::make_shared<FakeGpu>(name + ":texture", destroyed));
                entry->resources->metadata_buffer =
                    std::make_shared<FakeGpu>(name + ":metadata", destroyed);
                std::cout << label << ": "
                          << (bbl::admit_splat_source(cache, entry) ? "true" : "false") << "\n";
            } else if (kind == "protect") {
                auto refs = bbl::js::make_gc_shared<ProtectionRefs>();
                const JsonValue given = operation.get("refs");
                const auto field = [&](const char* key, bbl::js::Nullable<double>& slot) {
                    if (!given.get(key).is_undefined())
                        slot = given.get(key).to_number();
                };
                field("pinCount", refs->pin_count);
                field("displayedRefs", refs->displayed_refs);
                field("pendingRefs", refs->pending_refs);
                field("activeRefs", refs->active_refs);
                field("lastUsedFrame", refs->last_used_frame);
                bbl::set_splat_source_protection(cache, operation.get("url").string_value(), refs);
                std::cout << label << ": done\n";
            } else if (kind == "canReserve") {
                std::cout << label << ": "
                          << (bbl::can_reserve_splat_source_gpu_bytes(cache,
                                                                      number(operation, "bytes"))
                                  ? "true"
                                  : "false")
                          << "\n";
            } else if (kind == "reserve") {
                std::string evicted;
                const bool reserved = bbl::reserve_splat_source_gpu_bytes(
                    cache, number(operation, "bytes"),
                    bbl::js::Callback<void(std::shared_ptr<bbl::SplatSourceCacheEntry>)>(
                        [&evicted](std::shared_ptr<bbl::SplatSourceCacheEntry> entry) {
                            evicted += (evicted.empty() ? "" : "|") + entry->url;
                        }));
                std::cout << label << ": " << (reserved ? "true" : "false")
                          << " evicted=" << evicted << "\n";
            } else if (kind == "evict") {
                std::cout << label << ": "
                          << (bbl::evict_splat_source(cache, operation.get("url").string_value())
                                  ? "true"
                                  : "false")
                          << "\n";
            } else if (kind == "flush") {
                const auto pending = std::move(*retirements);
                retirements->clear();
                for (const auto& dispose : pending)
                    dispose();
                std::cout << label << ": " << pending.size() << "\n";
            } else if (kind == "distance") {
                distances->set(operation.get("url").string_value(), number(operation, "value"));
                std::cout << label << ": done\n";
            } else if (kind == "dispose") {
                bbl::dispose_splat_source_cache(cache);
                std::cout << label << ": done\n";
            }
        });
        state(label);
    }

    // The GPU ledger.
    const JsonValue ledger_case = scenario.get("ledger");
    auto ledger_retirements = std::make_shared<std::vector<bbl::js::Callback<void()>>>();
    auto ledger_log = std::make_shared<std::vector<std::string>>();
    const auto ledger = bbl::create_splat_stream_gpu_ledger(
        number(ledger_case, "maxBytes"),
        bbl::js::Callback<void(bbl::js::Callback<void()>)>(
            [ledger_retirements](bbl::js::Callback<void()> dispose) {
                ledger_retirements->push_back(dispose);
            }));
    const JsonValue steps = ledger_case.get("ops");
    for (std::size_t index = 0; index < static_cast<std::size_t>(steps.length()); ++index) {
        const JsonValue step = steps.at(static_cast<double>(index));
        const std::string kind = step.get("op").string_value();
        const std::string label = "ledger " + std::to_string(index) + " " + kind;
        guarded(label, [&] {
            const double bytes = step.get("bytes").is_number() ? number(step, "bytes") : 0.0;
            std::string result = "done";
            if (kind == "tryReserve")
                result = ledger->try_reserve(bytes) ? "true" : "false";
            else if (kind == "tryHold")
                result = ledger->try_hold(bytes) ? "true" : "false";
            else if (kind == "commitHold")
                ledger->commit_hold(bytes);
            else if (kind == "restoreHold")
                ledger->restore_hold(bytes);
            else if (kind == "releaseHold")
                ledger->release_hold(bytes);
            else if (kind == "release")
                ledger->release(bytes);
            else if (kind == "retire" || kind == "retireToHold") {
                const std::string name = step.get("name").string_value();
                const bool failing = step.get("throws").truthy();
                const auto dispose = bbl::js::Callback<void()>([ledger_log, name, failing] {
                    ledger_log->push_back(name);
                    if (failing)
                        throw std::runtime_error("dispose " + name);
                });
                if (kind == "retire")
                    ledger->retire(bytes, dispose);
                else
                    ledger->retire_to_hold(bytes, dispose);
            } else if (kind == "flush") {
                const auto pending = std::move(*ledger_retirements);
                ledger_retirements->clear();
                for (const auto& dispose : pending)
                    guarded(label, [&] { dispose(); });
                result = std::to_string(pending.size());
            }
            std::cout << label << ": " << result << "\n";
        });
        std::cout << label << " state: resident=" << num(ledger->resident_bytes)
                  << " allocated=" << num(ledger->allocated_bytes)
                  << " held=" << num(ledger->held_bytes) << " log=";
        for (std::size_t entry = 0; entry < ledger_log->size(); ++entry)
            std::cout << (entry ? "|" : "") << (*ledger_log)[entry];
        std::cout << "\n";
    }
    return 0;
}
