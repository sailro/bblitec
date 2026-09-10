import type { LoweringContext } from "./context.js";
import { lowerMat4InvertCpp } from "./pinned-function-lowerer.js";
import { pinnedHeader } from "./pinned-header.js";

/** Scene-facing storage and nullability around the shared pinned inverse. */
export function pinnedMat4InvertHeader(context: LoweringContext): string {
    return pinnedHeader(["<array>","<cmath>","<limits>","<optional>","<bblite/js_data.hpp>"], `${lowerMat4InvertCpp(context, { inline: true, cppName: "mat4_invert_storage" })}

[[nodiscard]] inline js::Nullable<js::F32Array> mat4_invert_array(const js::F32Array& input) {
    std::array<float, 16> lanes{};
    for (std::size_t i = 0; i < lanes.size(); ++i) {
        // An out-of-range typed-array read is undefined, hence NaN in the
        // pin's arithmetic. Extra lanes are never read by mat4Invert.
        lanes[i] = i < input.size() ? input[i] : std::numeric_limits<float>::quiet_NaN();
    }
    const auto inverse = mat4_invert_storage(lanes);
    if (!inverse) return std::nullopt;
    return js::F32Array(inverse->begin(), inverse->end());
}`, { compactPragma: true });
}
