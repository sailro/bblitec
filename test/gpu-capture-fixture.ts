import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cppFunction } from "./native-fixture.js";

/** Production JSON writers without the unrelated renderer dependency graph. */
export function gpuCaptureSerializer(kind: "text" | "node"): string {
    const source = readFileSync("native/src/pal_render_capture.hpp", "utf8").replaceAll("\r\n", "\n");
    const start = source.indexOf("class JsonWriter {");
    const end = source.indexOf("\n};", start) + 3;
    assert.ok(start >= 0 && end > start);
    return `#include <bblite/runtime.hpp>
#include <cmath>
#include <iomanip>
#include <sstream>
namespace bbl::pal {
${source.slice(start, end)}
${["bytes", "resources"].map(name => cppFunction(source, `inline void write_gpu_capture_${name}(`)).join("\n")}
${cppFunction(source, `inline void write_${kind}_gpu_capture(`)}
}
`;
}
