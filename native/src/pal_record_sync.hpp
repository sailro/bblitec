#pragma once

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <type_traits>
#include <utility>
#include <vector>

namespace bbl::pal {

template<class Buffer>
struct VersionedGpuBuffer {
    Buffer buffer = nullptr;
    std::size_t size = 0;
    std::uint64_t version = 0;
};

/** Invalidate dependent bindings before retiring buffers; publish versions after upload. */
template<class Source, class Buffer, class Invalidate, class Release, class Create, class Update>
void sync_storage_records(const std::vector<Source>& sources, std::vector<VersionedGpuBuffer<Buffer>>& targets,
    Invalidate&& invalidate, Release&& release, Create&& create, Update&& update) {
    bool changed = targets.size() != sources.size();
    for (std::size_t index = 0; index < sources.size(); ++index) {
        const auto& source = sources[index];
        if (!source.disposed && source.bytes.empty()) {
            throw std::runtime_error("A shader storage buffer cannot be empty.");
        }
        if (index < targets.size()) {
            const auto& target = targets[index];
            changed = changed || (target.buffer && (source.disposed || target.size != source.bytes.size()));
        }
    }
    if (changed) invalidate();
    for (std::size_t index = sources.size(); index < targets.size(); ++index) {
        if (targets[index].buffer) release(targets[index].buffer);
    }
    targets.resize(sources.size());
    for (std::size_t index = 0; index < sources.size(); ++index) {
        const auto& source = sources[index];
        auto& target = targets[index];
        if (source.disposed) {
            if (target.buffer) release(target.buffer);
            target = {};
        } else if (!target.buffer || target.size != source.bytes.size()) {
            auto replacement = create(source.bytes.data(), source.bytes.size());
            if (!replacement) throw std::runtime_error("Shader storage buffer creation returned no resource.");
            if (target.buffer) release(target.buffer);
            target = {replacement, source.bytes.size(), source.version};
        } else if (target.version != source.version) {
            update(target.buffer, source.bytes.data(), source.bytes.size());
            target.version = source.version;
        }
    }
}

/** Preserve surviving resources and clocks in requested handle order, including duplicates. */
template<class Handle, class Resource, class Key, class Create, class Release>
void reconcile_ordered_records(const std::vector<Handle>& handles, std::vector<Resource>& resources,
    Key&& key, Create&& create, Release&& release) {
    static_assert(std::is_nothrow_move_constructible_v<Resource>);
    const auto missing = resources.size();
    std::vector<std::size_t> previous(handles.size(), missing);
    std::vector<bool> used(resources.size(), false);
    std::vector<std::optional<Resource>> added(handles.size());
    std::vector<Resource> next;
    next.reserve(handles.size());
    try {
        for (std::size_t index = 0; index < handles.size(); ++index) {
            for (std::size_t old = 0; old < resources.size(); ++old) {
                if (!used[old] && key(resources[old]).value == handles[index].value) {
                    previous[index] = old;
                    used[old] = true;
                    break;
                }
            }
            if (previous[index] == missing) added[index].emplace(create(handles[index]));
        }
    } catch (...) {
        for (auto& resource : added) if (resource) release(*resource);
        throw;
    }
    for (std::size_t index = 0; index < handles.size(); ++index) {
        next.push_back(previous[index] == missing
            ? std::move(*added[index]) : std::move(resources[previous[index]]));
    }
    for (std::size_t index = 0; index < resources.size(); ++index) {
        if (!used[index]) release(resources[index]);
    }
    resources = std::move(next);
}

template<class Resource, class Used, class Release>
void retire_unreferenced_records(std::vector<Resource>& resources, Used&& used, Release&& release) {
    for (auto entry = resources.begin(); entry != resources.end();) {
        if (used(*entry)) ++entry;
        else { release(*entry); entry = resources.erase(entry); }
    }
}

template<class Source, class Exists, class Validate, class Release, class Create>
void sync_retained_textures(const std::vector<Source>& sources, Exists&& exists,
    Validate&& validate_retired, Release&& release, Create&& create) {
    if (std::any_of(sources.begin(), sources.end(), [](const Source& source) { return source.disposed; })) {
        validate_retired();
    }
    for (std::size_t index = 0; index < sources.size(); ++index) {
        if (sources[index].disposed) release(index);
        else if (!exists(index)) create(index, sources[index]);
    }
}

} // namespace bbl::pal
