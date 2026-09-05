import type { LoweringContext } from "./context.js";
import { lowerMat4MultiplyWriterCpp } from "./pinned-function-lowerer.js";

/** One pinned matrix writer shared by generated code and both GPU PALs. */
export function pinnedMatrixHeader(context: LoweringContext): string {
    return `#pragma once

#include <array>
#include <cstdint>

namespace bbl::upstream {

${lowerMat4MultiplyWriterCpp(context)}

template <typename MatA, typename MatB>
std::array<float, 16> matrix_product(const MatA& left, const MatB& right) {
    std::array<float, 16> result{};
    mat4_multiply_into(result, 0, left, 0, right, 0);
    return result;
}

} // namespace bbl::upstream
`;
}
