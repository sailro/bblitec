import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { computeDispatchDescriptorCpp } from "../src/lowering/compute-dispatch-descriptor.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import { doubleLiteral } from "../src/cpp-literals.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute dispatch dimensions match pinned defaults and limit validation", async (t) => {
    const pin = await importPinnedModule<{
        createComputeDispatch(
            shader: object,
            bindings: object,
            options: { size: { x: number; y?: number; z?: number } },
        ): { _x: number; _y: number; _z: number };
    }>("compute/compute-dispatch.js");
    const checks: string[] = [];
    const scalar = (value: number): string =>
        Number.isNaN(value)
            ? "std::numeric_limits<double>::quiet_NaN()"
            : value === Infinity
              ? "std::numeric_limits<double>::infinity()"
              : doubleLiteral(value);
    for (const limit of [0, NaN, 4, 65535]) {
        const device = { limits: { maxComputeWorkgroupsPerDimension: limit } };
        const shader = {
            _destroyed: false,
            _device: device,
            _engine: { _device: device },
            name: "validation",
        };
        const bindings = { shader };
        const cases = [
            { x: 0 },
            { x: 1 },
            { x: 4 },
            { x: 65535 },
            { x: 65536 },
            { x: -1 },
            { x: 1.5 },
            { x: NaN },
            { x: Infinity },
            { x: 1, y: 0, z: 0 },
            { x: 1, y: 4, z: 4 },
            { x: 1, y: 5 },
            { x: 1, z: 5 },
            { x: 1, y: -1 },
            { x: 1, z: 1.5 },
        ];
        for (const size of cases) {
            const optional = (value: number | undefined) =>
                value === undefined
                    ? "std::nullopt"
                    : `std::optional<double>{${scalar(value)}}`;
            const call = `bbl::upstream::compute_dispatch_dimensions(${scalar(size.x)},${optional(size.y)},${optional(size.z)},${scalar(limit)})`;
            try {
                const value = pin.createComputeDispatch(shader, bindings, {
                    size,
                });
                checks.push(
                    `{const auto value=${call};assert(value[0]==${doubleLiteral(value._x)}&&value[1]==${doubleLiteral(value._y)}&&value[2]==${doubleLiteral(value._z)});}`,
                );
            } catch (error) {
                assert.ok(error instanceof Error);
                checks.push(
                    `{bool failed=false;try{(void)${call};}catch(const std::exception& error){failed=std::string(error.what())==${JSON.stringify(error.message)};}assert(failed);}`,
                );
            }
        }
    }
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-dispatch-descriptor-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/js_data.hpp>
#include <cassert>
#include <limits>
namespace bbl::upstream {${computeDispatchDescriptorCpp(new LoweringContext())}}
int main(){${checks.join("\n")}}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
