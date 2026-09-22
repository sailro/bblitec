import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { storageBufferDescriptorCpp } from "../src/lowering/storage-buffer-descriptor.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("storage allocation alignment, limits and role flags match the pinned factory", async (t) => {
    const pin = await importPinnedModule<{
        createStorageBuffer(
            engine: object,
            source: number | Uint8Array,
            options: object,
        ): { byteLength: number; _usage: number };
    }>("resource/storage-buffer.js");
    const cases = [
        { size: 0 },
        { size: 1 },
        { size: 3 },
        { size: 4 },
        { size: 5 },
        { size: 508 },
        { size: 509 },
        { size: 512 },
        { size: 513 },
        { size: -1 },
        { size: 1.5 },
        { size: NaN },
        { size: Infinity },
        { size: Number.MAX_SAFE_INTEGER },
    ];
    const checks: string[] = [];
    const scalar = (value: number) =>
        Number.isNaN(value)
            ? "std::numeric_limits<double>::quiet_NaN()"
            : value === Infinity
              ? "std::numeric_limits<double>::infinity()"
              : String(value);
    for (const { size } of cases) {
        for (const writable of [false, true]) {
            const options = {
                writable,
                vertex: writable,
                index: false,
                indirect: writable,
            };
            const engine = {
                _device: {
                    limits: { maxBufferSize: 512 },
                    createBuffer(descriptor: { size: number }) {
                        const bytes = new ArrayBuffer(descriptor.size);
                        return {
                            getMappedRange: () => bytes,
                            unmap() {},
                            destroy() {},
                        };
                    },
                },
            };
            const call = `bbl::upstream::storage_buffer_shape(${scalar(size)},true,512,${writable},${writable},false,${writable})`;
            let buffer;
            try {
                buffer = pin.createStorageBuffer(engine, size, options);
            } catch {
                checks.push(
                    `{bool failed=false;try{(void)${call};}catch(const std::exception&){failed=true;}assert(failed);}`,
                );
                continue;
            }
            checks.push(
                `{const auto shape=${call};assert(shape[0]==${buffer.byteLength}&&shape[1]==${buffer._usage});}`,
            );
        }
    }
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/storage-buffer-descriptor-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <bblite/pal_storage_buffer.hpp>
#include <cassert>
#include <limits>
namespace bbl::upstream {${storageBufferDescriptorCpp(new LoweringContext())}}
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
