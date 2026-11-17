/**
 * `captureScreenshot`'s readback (`src/engine/screenshot-readback.ts`),
 * lowered from the pinned bodies: the row stride the frame's copy lands at
 * (`alignBytesPerRow`) and `finish`'s unpack of the mapped copy into tightly
 * packed opaque RGBA8. The copy, its submit and the map are the backends'.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

const readbackModule = "src/engine/screenshot-readback.ts";

export function lowerScreenshotReadback(
    context: LoweringContext,
): LoweredSource {
    const { file } = context.functionDeclaration(
        readbackModule,
        "alignBytesPerRow",
    );
    const stride = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            ["width", { cpp: "width", type: "scalar" }],
        ]),
        calls: new Map(),
    }).expression(
        context.returnedExpression(readbackModule, "alignBytesPerRow"),
    );
    const { declaration: finish } = context.functionDeclaration(
        readbackModule,
        "finish",
    );
    context.assertExpressionShape(
        context.variableInitializer(finish, "src"),
        "new Uint8Array(buffer.getMappedRange())",
        "Screenshot readback source",
    );
    const allocation = context.variableInitializer(finish, "out");
    if (
        !ts.isNewExpression(allocation) ||
        !context.expressionMatchesShape(
            allocation.expression,
            "Uint8ClampedArray",
        ) ||
        allocation.arguments?.length !== 1
    )
        context.contractError(
            allocation,
            "Expected the screenshot unpack to allocate one Uint8ClampedArray.",
        );
    context.assertExpressionShape(
        context.variableInitializer(finish, "shot"),
        "{ width, height, data: out }",
        "Screenshot record",
    );
    const loops = context.findNodes(finish, ts.isForStatement);
    const rows = loops[0];
    if (!rows || loops.length !== 2)
        context.contractError(
            finish,
            "Expected the screenshot unpack to walk rows, then each row's pixels.",
        );
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: new Map<string, PinnedBinding>([
            ["width", { cpp: "width", type: "scalar" }],
            ["height", { cpp: "height", type: "scalar" }],
            ["bytesPerRow", { cpp: "bytes_per_row", type: "scalar" }],
            ["bgra", { cpp: "bgra", type: "bool" }],
            ["src", { cpp: "src", type: "u8" }],
            [
                "out",
                {
                    cpp: "out",
                    type: "u8",
                    mutable: true,
                    // A Uint8ClampedArray store converts by ToUint8Clamp.
                    indexedStore: (owner, index, value) =>
                        `${owner}[static_cast<std::size_t>(${index})] = js::to_uint8_clamp(${value})`,
                },
            ],
        ]),
        calls: new Map(),
    });
    const size = lowerer.expression(allocation.arguments[0]!);
    const unpack = lowerer.statement(rows, "    ");
    return {
        modulePath: readbackModule,
        symbolName: "alignBytesPerRow,finish",
        header: "",
        source: `// ${context.provenance(readbackModule, "alignBytesPerRow", `${readbackModule}#finish`)}
#include <bblite/pal_screenshot.hpp>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <span>

namespace bbl::upstream {

std::uint32_t screenshot_bytes_per_row(double width) {
    return gpu_u32(gpu_size(${stride}));
}

js::U8CArray unpack_screenshot(
    std::span<const std::uint8_t> src,
    double width,
    double height,
    double bytes_per_row,
    bool bgra) {
    js::U8CArray out(gpu_size(${size}));
${unpack.join("\n")}
    return out;
}

} // namespace bbl::upstream
`,
    };
}
