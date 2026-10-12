#pragma once

#include <bblite/runtime.hpp>
#include <span>
#include <variant>

namespace bbl {

/** Borrow retained arrays or typed interleaved lanes; copying is an explicit API boundary. */
template <class Vector> class MeshCpuFloatView {
    struct Packed {
        std::span<const ModelVertex> vertices;
        Vector ModelVertex::* member = nullptr;
        bool present = false;
    };
    using Dense = js::F32Array;
    std::variant<std::monostate, Dense, Packed> source_;
    static constexpr std::size_t width =
        2 + requires(Vector v) { v.z; } + requires(Vector v) { v.w; };

public:
    MeshCpuFloatView() = default;
    MeshCpuFloatView(const std::optional<js::F32Array>* retained,
                     std::span<const ModelVertex> vertices, Vector ModelVertex::* member,
                     bool present) {
        if (retained) {
            if (*retained)
                source_ = **retained;
        } else {
            source_ = Packed{vertices, member, present};
        }
    }
    explicit operator bool() const {
        if (const auto* packed = std::get_if<Packed>(&source_))
            return packed->present;
        return std::holds_alternative<Dense>(source_);
    }
    std::size_t size() const {
        if (const auto* dense = std::get_if<Dense>(&source_))
            return dense->size();
        if (const auto* packed = std::get_if<Packed>(&source_))
            return packed->vertices.size() * width;
        return 0;
    }
    bool empty() const { return size() == 0; }
    float operator[](std::size_t index) const {
        if (index >= size())
            throw std::out_of_range("Mesh CPU stream index is out of range.");
        if (const auto* dense = std::get_if<Dense>(&source_))
            return dense->load(index);
        const auto& packed = std::get<Packed>(source_);
        const auto& value = packed.vertices[index / width].*packed.member;
        const auto component = index % width;
        if (component == 0)
            return value.x;
        if (component == 1)
            return value.y;
        if constexpr (requires { value.z; })
            if (component == 2)
                return value.z;
        if constexpr (requires { value.w; })
            if (component == 3)
                return value.w;
        throw std::logic_error("Unrepresented mesh CPU component.");
    }
    // Raw CPU accessors still expose packed lanes whose optional source stream is absent.
    std::vector<float> copy() const {
        if (const auto* dense = std::get_if<Dense>(&source_)) {
            std::vector<float> result;
            result.reserve(dense->size());
            for (std::size_t index = 0; index < dense->size(); ++index)
                result.push_back(dense->load(index));
            return result;
        }
        std::vector<float> result;
        if (const auto* packed = std::get_if<Packed>(&source_)) {
            result.reserve(packed->vertices.size() * width);
            for (const auto& vertex : packed->vertices) {
                const auto& value = vertex.*packed->member;
                result.push_back(value.x);
                result.push_back(value.y);
                if constexpr (requires { value.z; })
                    result.push_back(value.z);
                if constexpr (requires { value.w; })
                    result.push_back(value.w);
            }
        }
        return result;
    }
};

class MeshCpuIndexView {
    std::optional<std::span<const std::uint32_t>> source_;
    std::optional<js::U32Array> retained_;
    bool reversed_ = false;

public:
    MeshCpuIndexView() = default;
    MeshCpuIndexView(const std::optional<js::U32Array>* retained, const ModelGeometry* geometry) {
        if (retained) {
            if (*retained)
                retained_ = **retained;
        } else if (geometry) {
            source_ = geometry->indices;
            reversed_ = geometry->source_indices_reversed;
        }
    }
    explicit operator bool() const { return retained_.has_value() || source_.has_value(); }
    std::size_t size() const {
        return retained_ ? retained_->size() : source_ ? source_->size() : 0;
    }
    bool empty() const { return size() == 0; }
    std::uint32_t source_at(std::size_t index) const {
        if (index >= size())
            throw std::out_of_range("Mesh CPU index is out of range.");
        const auto base = index - index % 3;
        if (reversed_ && base + 2 < size() && index % 3)
            index = base + 3 - index % 3;
        return retained_ ? retained_->load(index) : (*source_)[index];
    }
    std::vector<std::uint32_t> copy_raw() const {
        if (retained_) {
            std::vector<std::uint32_t> result;
            result.reserve(retained_->size());
            for (std::size_t index = 0; index < retained_->size(); ++index)
                result.push_back(retained_->load(index));
            return result;
        }
        const auto values = source_.value_or(std::span<const std::uint32_t>{});
        return {values.begin(), values.end()};
    }
    std::vector<std::uint32_t> copy_source() const {
        auto result = copy_raw();
        if (reversed_)
            for (std::size_t index = 0; index + 2 < result.size(); index += 3)
                std::swap(result[index + 1], result[index + 2]);
        return result;
    }
};

struct MeshCpuStreamsView {
    MeshCpuFloatView<Vec3> positions, normals;
    MeshCpuFloatView<Vec2> uvs, uvs2;
    MeshCpuFloatView<Vec4> tangents, colors;
    MeshCpuIndexView indices;

    MeshCpuStreamsView(const MeshRecord& mesh, const ModelGeometry* geometry) {
        const auto* retained = mesh.cpu_streams.get();
        const auto vertices = geometry ? std::span<const ModelVertex>{geometry->vertices}
                                       : std::span<const ModelVertex>{};
        positions = {retained ? &retained->positions : nullptr, vertices, &ModelVertex::position,
                     geometry != nullptr};
        normals = {retained ? &retained->normals : nullptr, vertices, &ModelVertex::normal,
                   geometry != nullptr};
        uvs = {retained ? &retained->uvs : nullptr, vertices, &ModelVertex::uv,
               geometry && geometry->has_uvs};
        uvs2 = {retained ? &retained->uvs2 : nullptr, vertices, &ModelVertex::uv2,
                geometry && geometry->cpu_uv2s};
        tangents = {retained ? &retained->tangents : nullptr, vertices, &ModelVertex::tangent,
                    geometry && geometry->cpu_tangents};
        colors = {retained ? &retained->colors : nullptr, vertices, &ModelVertex::color,
                  geometry && geometry->cpu_colors};
        indices = {retained ? &retained->indices : nullptr, geometry};
    }
};

} // namespace bbl
