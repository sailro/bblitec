#pragma once

#include "pal_ui_length_math.hpp"
#include <RmlUi/Core/Element.h>
#include <RmlUi/Core/ElementUtilities.h>
#include <RmlUi/Core/Math.h>
#include <RmlUi/Core/Transform.h>
#include <RmlUi/Core/TransformPrimitive.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <numbers>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::pal {
namespace detail {

/** A 4x4 matrix in CSS pixels, column-major as `matrix3d()` lists it. */
using CssMatrix = std::array<double, 16>;

inline CssMatrix css_matrix_from_rows(const std::array<double, 16>& rows) {
    CssMatrix matrix{};
    for (std::size_t row = 0; row < 4; ++row)
        for (std::size_t column = 0; column < 4; ++column)
            matrix[column * 4 + row] = rows[row * 4 + column];
    return matrix;
}

inline CssMatrix css_matrix_product(const CssMatrix& left, const CssMatrix& right) {
    CssMatrix product{};
    for (std::size_t column = 0; column < 4; ++column)
        for (std::size_t row = 0; row < 4; ++row)
            for (std::size_t inner = 0; inner < 4; ++inner)
                product[column * 4 + row] += left[inner * 4 + row] * right[column * 4 + inner];
    return product;
}

inline CssMatrix css_translation(double x, double y, double z) {
    return css_matrix_from_rows({1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1});
}

inline CssMatrix css_scaling(double x, double y, double z) {
    return css_matrix_from_rows({x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1});
}

/**
 * The sine and cosine of an angle RmlUi holds as single-precision radians: exact for one it
 * converted from a multiple of 90deg, as Chromium makes them (gfx::SinCosDegrees).
 */
inline std::pair<double, double> css_sin_cos(float radians) {
    const double quarters = std::round(static_cast<double>(radians) / (std::numbers::pi / 2));
    if (std::abs(quarters) < 1e6 &&
        Rml::Math::DegreesToRadians(static_cast<float>(quarters * 90)) == radians) {
        static constexpr std::array<std::pair<double, double>, 4> exact{
            {{0, 1}, {1, 0}, {0, -1}, {-1, 0}}};
        const auto turn = static_cast<long long>(quarters) % 4;
        return exact[static_cast<std::size_t>(turn < 0 ? turn + 4 : turn)];
    }
    return {std::sin(static_cast<double>(radians)), std::cos(static_cast<double>(radians))};
}

/**
 * A rotation about an axis (CSS Transforms 2 rotate3d()): none about a zero axis, and about a
 * major axis the plane rotation Chromium uses for it.
 */
inline CssMatrix css_rotation(double x, double y, double z, float radians) {
    const double length = std::sqrt(x * x + y * y + z * z);
    if (length == 0)
        return css_scaling(1, 1, 1);
    x /= length;
    y /= length;
    z /= length;
    const auto [s, c] = css_sin_cos(radians);
    if (z == 1)
        return css_matrix_from_rows({c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1});
    if (y == 1)
        return css_matrix_from_rows({c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1});
    if (x == 1)
        return css_matrix_from_rows({1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1});
    const double t = 1 - c;
    return css_matrix_from_rows(
        {t * x * x + c, t * x * y - s * z, t * x * z + s * y, 0, t * x * y + s * z, t * y * y + c,
         t * y * z - s * x, 0, t * x * z - s * y, t * y * z + s * x, t * z * z + c, 0, 0, 0, 0, 1});
}

inline CssMatrix css_skew(float x, float y) {
    return css_matrix_from_rows({1, std::tan(static_cast<double>(x)), 0, 0,
                                 std::tan(static_cast<double>(y)), 1, 0, 0, 0, 0, 1, 0, 0, 0, 0,
                                 1});
}

/**
 * One transform function's matrix, in the CSS pixels of `element`, in double precision as
 * Chromium resolves it (RmlUi's own resolver is internal and single-precision).
 */
inline CssMatrix css_transform_function(const Rml::TransformPrimitive& primitive,
                                        Rml::Element& element) {
    using Type = Rml::TransformPrimitive;
    // The density projection writes CSS pixels as dp; RmlUi resolves other lengths, and an
    // animation's prepared ones, in drawable pixels.
    const double ratio = Rml::ElementUtilities::GetDensityIndependentPixelRatio(&element);
    const Rml::Vector2f box = element.GetBox().GetSize(Rml::BoxArea::Border);
    const auto pixels = [&](Rml::NumericValue value, std::optional<float> base) -> double {
        if (value.unit == Rml::Unit::DP)
            return value.number;
        if (value.unit == Rml::Unit::PX || value.unit == Rml::Unit::NUMBER)
            return value.number / ratio;
        return (base ? element.ResolveNumericValue(value, *base) : element.ResolveLength(value)) /
               ratio;
    };
    switch (primitive.type) {
    case Type::MATRIX2D: {
        const auto& v = primitive.matrix_2d.values;
        return css_matrix_from_rows(
            {v[0], v[2], 0, v[4], v[1], v[3], 0, v[5], 0, 0, 1, 0, 0, 0, 0, 1});
    }
    case Type::MATRIX3D: {
        CssMatrix matrix{};
        std::copy(primitive.matrix_3d.values.begin(), primitive.matrix_3d.values.end(),
                  matrix.begin());
        return matrix;
    }
    case Type::TRANSLATEX:
        return css_translation(pixels(primitive.translate_x.values[0], box.x), 0, 0);
    case Type::TRANSLATEY:
        return css_translation(0, pixels(primitive.translate_y.values[0], box.y), 0);
    case Type::TRANSLATEZ:
        return css_translation(0, 0, pixels(primitive.translate_z.values[0], std::nullopt));
    case Type::TRANSLATE2D: {
        const auto& v = primitive.translate_2d.values;
        return css_translation(pixels(v[0], box.x), pixels(v[1], box.y), 0);
    }
    case Type::TRANSLATE3D: {
        const auto& v = primitive.translate_3d.values;
        return css_translation(pixels(v[0], box.x), pixels(v[1], box.y),
                               pixels(v[2], std::nullopt));
    }
    case Type::SCALEX:
        return css_scaling(primitive.scale_x.values[0], 1, 1);
    case Type::SCALEY:
        return css_scaling(1, primitive.scale_y.values[0], 1);
    case Type::SCALEZ:
        return css_scaling(1, 1, primitive.scale_z.values[0]);
    case Type::SCALE2D:
        return css_scaling(primitive.scale_2d.values[0], primitive.scale_2d.values[1], 1);
    case Type::SCALE3D: {
        const auto& v = primitive.scale_3d.values;
        return css_scaling(v[0], v[1], v[2]);
    }
    case Type::ROTATEX:
        return css_rotation(1, 0, 0, primitive.rotate_x.values[0]);
    case Type::ROTATEY:
        return css_rotation(0, 1, 0, primitive.rotate_y.values[0]);
    case Type::ROTATEZ:
        return css_rotation(0, 0, 1, primitive.rotate_z.values[0]);
    case Type::ROTATE2D:
        return css_rotation(0, 0, 1, primitive.rotate_2d.values[0]);
    case Type::ROTATE3D: {
        const auto& v = primitive.rotate_3d.values;
        return css_rotation(v[0], v[1], v[2], v[3]);
    }
    case Type::SKEWX:
        return css_skew(primitive.skew_x.values[0], 0);
    case Type::SKEWY:
        return css_skew(0, primitive.skew_y.values[0]);
    case Type::SKEW2D:
        return css_skew(primitive.skew_2d.values[0], primitive.skew_2d.values[1]);
    case Type::PERSPECTIVE: {
        // A depth below 1px is 1px (CSS Transforms 2 perspective()).
        const double depth = std::max(1.0, pixels(primitive.perspective.values[0], std::nullopt));
        return css_matrix_from_rows({1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -1 / depth, 1});
    }
    case Type::DECOMPOSEDMATRIX4: {
        // An interpolated list, recomposed in drawable pixels: its translation over the ratio, its
        // projective row times it.
        const auto& d = primitive.decomposed_matrix_4;
        const Rml::Matrix4f composed =
            Rml::Matrix4f::Compose(d.translation, d.scale, d.skew, d.perspective, d.quaternion);
        CssMatrix matrix{};
        for (int column = 0; column < 4; ++column)
            for (int row = 0; row < 4; ++row) {
                const double scale = column == 3 && row < 3   ? 1 / ratio
                                     : row == 3 && column < 3 ? ratio
                                                              : 1;
                matrix[static_cast<std::size_t>(column * 4 + row)] =
                    composed.GetColumn(column)[row] * scale;
            }
        return matrix;
    }
    }
    throw std::logic_error("Unknown transform function.");
}

/** A matrix as Chromium serializes one: `matrix()` when it is 2D, else `matrix3d()`. */
inline std::string css_matrix_text(const CssMatrix& matrix) {
    const bool flat = matrix[2] == 0 && matrix[3] == 0 && matrix[6] == 0 && matrix[7] == 0 &&
                      matrix[8] == 0 && matrix[9] == 0 && matrix[11] == 0 && matrix[14] == 0 &&
                      matrix[10] == 1 && matrix[15] == 1;
    std::string text = flat ? "matrix(" : "matrix3d(";
    const auto append = [&text](double value) {
        if (text.back() != '(')
            text += ", ";
        text += css_serialized_number(value);
    };
    static constexpr std::array<std::size_t, 6> affine{0, 1, 4, 5, 12, 13};
    if (flat)
        for (const std::size_t index : affine)
            append(matrix[index]);
    else
        for (const double value : matrix)
            append(value);
    return text + ")";
}

} // namespace detail

/**
 * The resolved `transform` of `element` (CSS Transforms 1, serialization of the computed value):
 * `none`, or the matrix of its transform list in CSS pixels without transform-origin, percentages
 * of the border box. The list is the transform property's own (`bbl-transform`) at its current
 * animated value; the individual `scale` property is not part of it.
 */
inline std::string ui_serialized_transform(Rml::Element& element) {
    const auto transform = element.GetProperty<Rml::TransformPtr>("bbl-transform");
    if (!transform || transform->GetPrimitives().empty())
        return "none";
    detail::CssMatrix matrix = detail::css_scaling(1, 1, 1);
    for (const auto& primitive : transform->GetPrimitives())
        matrix =
            detail::css_matrix_product(matrix, detail::css_transform_function(primitive, element));
    return detail::css_matrix_text(matrix);
}

/**
 * Each matrix() and matrix3d() of `value` with a translation, as that translation in CSS pixels
 * (a translate() or translate3d() of px, which the density projection writes as dp) before the
 * matrix without it: RmlUi reads a matrix's translation in drawable pixels. A matrix3d() whose
 * last row is not (0, 0, 0, 1) has lengths no dp form carries and refuses; a matrix of other
 * arguments stays for RmlUi's parser.
 */
inline std::string rml_css_matrix_translations(std::string value) {
    detail::scan_css_value(value, [&value](std::size_t index) {
        const bool deep = detail::css_function_at(value, index, "matrix3d(");
        if (!deep && !detail::css_function_at(value, index, "matrix("))
            return index;
        const std::size_t open = value.find('(', index);
        const std::size_t end = detail::css_function_end(value, open);
        if (end == value.size())
            return end;
        std::vector<std::string> arguments;
        std::vector<double> numbers;
        for (std::size_t start = open + 1; start <= end;) {
            const std::size_t comma = std::min(value.find(',', start), end);
            std::string argument(
                detail::trim_css_token(std::string_view(value).substr(start, comma - start)));
            const bool negative = argument.starts_with('-');
            if (argument.starts_with('+'))
                argument.erase(0, 1);
            std::size_t offset = negative ? 1 : 0;
            const auto number = detail::css_decimal(argument, offset);
            if (!number || offset != argument.size())
                return end;
            numbers.push_back(negative ? -*number : *number);
            arguments.push_back(std::move(argument));
            start = comma + 1;
        }
        if (numbers.size() != (deep ? 16U : 6U))
            return end;
        if (deep && (numbers[3] != 0 || numbers[7] != 0 || numbers[11] != 0 || numbers[15] != 1))
            throw std::runtime_error("A matrix3d() with perspective terms is not represented: " +
                                     value.substr(index, end + 1 - index));
        const std::size_t first = deep ? 12 : 4;
        const std::size_t axes = deep ? 3 : 2;
        if (std::all_of(numbers.begin() + static_cast<std::ptrdiff_t>(first),
                        numbers.begin() + static_cast<std::ptrdiff_t>(first + axes),
                        [](double number) { return number == 0; }))
            return end;
        std::string replacement = deep ? "translate3d(" : "translate(";
        for (std::size_t axis = 0; axis < axes; ++axis) {
            replacement += arguments[first + axis] + "px" + (axis + 1 < axes ? ", " : ") ");
            arguments[first + axis] = "0";
        }
        replacement += deep ? "matrix3d(" : "matrix(";
        for (std::size_t argument = 0; argument < arguments.size(); ++argument)
            replacement += arguments[argument] + (argument + 1 < arguments.size() ? ", " : ")");
        value.replace(index, end + 1 - index, replacement);
        return index + replacement.size() - 1;
    });
    return value;
}

} // namespace bbl::pal
