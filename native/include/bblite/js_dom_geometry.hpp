#pragma once

#include <bblite/js_data.hpp>

#include <cmath>
#include <limits>

namespace bbl::js {

/**
 * A 2D DOMMatrix: `a`..`f` of the affine matrices `getScreenCTM` and `inverse` give, read only.
 * Each is its own object.
 */
struct DomMatrix {
    double a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;
};

/** A DOMPoint: `x`, `y`, `z` and `w`, each writable. */
struct DomPoint {
    double x = 0, y = 0, z = 0, w = 1;
};

using DomMatrixHandle = Ref<DomMatrix>;
using DomPointHandle = Ref<DomPoint>;

/** `matrix.inverse()`: a new matrix; every member NaN where the matrix is not invertible. */
[[nodiscard]] inline DomMatrixHandle dom_matrix_inverse(const DomMatrixHandle& matrix) {
    const DomMatrix& m = *matrix;
    const double determinant = m.a * m.d - m.b * m.c;
    if (determinant == 0 || !std::isfinite(determinant)) {
        const double nan = std::numeric_limits<double>::quiet_NaN();
        return make_ref<DomMatrix>(DomMatrix{nan, nan, nan, nan, nan, nan});
    }
    return make_ref<DomMatrix>(DomMatrix{m.d / determinant, -m.b / determinant, -m.c / determinant,
                                         m.a / determinant, (m.c * m.f - m.d * m.e) / determinant,
                                         (m.b * m.e - m.a * m.f) / determinant});
}

/** `point.matrixTransform(matrix)`: a new point, the 2D matrix applied to the homogeneous point. */
[[nodiscard]] inline DomPointHandle dom_point_matrix_transform(const DomPointHandle& point,
                                                               const DomMatrixHandle& matrix) {
    const DomPoint& p = *point;
    const DomMatrix& m = *matrix;
    return make_ref<DomPoint>(
        DomPoint{m.a * p.x + m.c * p.y + m.e * p.w, m.b * p.x + m.d * p.y + m.f * p.w, p.z, p.w});
}

/** `svg.createSVGPoint()`: the origin. */
[[nodiscard]] inline DomPointHandle dom_point_origin() { return make_ref<DomPoint>(); }

} // namespace bbl::js
