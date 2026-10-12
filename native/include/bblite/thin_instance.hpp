#pragma once

#include <bblite/js_error.hpp>
#include <bblite/thin_instance_data.hpp>

#include <array>
#include <cstddef>
#include <type_traits>

namespace bbl {

inline ThinInstancePoolData& thin_instance_data(const std::shared_ptr<ThinInstancePoolData>& pool) {
    if (!pool)
        throw js::NamedError("TypeError", "Cannot read properties of undefined.");
    return *pool;
}

inline js::NumericArrayView thin_instance_matrix_values(const ThinInstancePoolData& pool) {
    return std::visit([](const auto& values) { return js::NumericArrayView(values); },
                      pool.matrices);
}

inline std::array<double, 16> thin_instance_matrix(const ThinInstancePoolData& pool,
                                                   std::size_t index) {
    return std::visit(
        [index](const auto& values) {
            std::array<double, 16> result{};
            for (std::size_t lane = 0; lane < result.size(); ++lane)
                result[lane] = static_cast<double>(values.load(index * 16 + lane));
            return result;
        },
        pool.matrices);
}

/** Preserve the ordinary typed-array set conversion and overlap handling. */
template <typename Target, typename Source>
void thin_instance_array_set(Target& target, const Source& source, double offset) {
    if constexpr (std::is_same_v<Target, ThinInstanceMatrices>) {
        std::visit([&](auto& values) { thin_instance_array_set(values, source, offset); }, target);
    } else if constexpr (std::is_same_v<Source, ThinInstanceMatrices>) {
        std::visit([&](const auto& values) { thin_instance_array_set(target, values, offset); },
                   source);
    } else if constexpr (std::is_same_v<Target, Source>) {
        js::typed_array_set(target, source, offset);
    } else {
        const auto converted = js::typed_array_from_values<Target>(source, [](double value) {
            return js::numeric_store_value<typename Target::value_type>(value);
        });
        js::typed_array_set(target, converted, offset);
    }
}

inline void thin_instance_array_copy_within(ThinInstanceMatrices& values, double target,
                                            double start, double end) {
    std::visit([&](auto& lanes) { js::array_copy_within(lanes, target, start, end); }, values);
}

} // namespace bbl
