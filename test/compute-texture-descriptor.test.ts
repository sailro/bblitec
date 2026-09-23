import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { computeTextureDescriptorCpp } from "../src/lowering/compute-texture-descriptor.js";
import { importPinnedModule } from "../src/pinned-shader-composer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

interface Options {
    width: number;
    height?: number;
    depthOrArrayLayers?: number;
    viewDimension: "1d" | "2d" | "2d-array" | "3d";
    mipMaps?: boolean;
}
test("compute texture extent and mip arithmetic match pinned allocation", async (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    let mipCount = 0;
    const device = {
        limits: {
            maxTextureDimension1D: 16,
            maxTextureDimension2D: 32,
            maxTextureDimension3D: 16,
            maxTextureArrayLayers: 8,
        },
        pushErrorScope() {},
        async popErrorScope() {
            return null;
        },
        createBindGroupLayout() {
            return {};
        },
        createBindGroup() {
            return {};
        },
        createTexture(descriptor: { mipLevelCount: number }) {
            mipCount = descriptor.mipLevelCount;
            return {
                createView() {
                    return {};
                },
                destroy() {},
            };
        },
    };
    const pin = await importPinnedModule<{
        createComputeStorageTexture(
            engine: { _device: typeof device },
            options: Options & { format: string; sampled: boolean },
        ): Promise<{
            width: number;
            height: number;
            depthOrArrayLayers: number;
        }>;
        disposeComputeStorageTexture(resource: object): void;
    }>("resource/compute-storage-texture-view.js");
    const cases: Options[] = [
        { width: 13, height: 7, viewDimension: "2d", mipMaps: true },
        { width: 16, viewDimension: "1d" },
        {
            width: 8,
            height: 9,
            depthOrArrayLayers: 7,
            viewDimension: "3d",
            mipMaps: true,
        },
        {
            width: 13,
            height: 7,
            depthOrArrayLayers: 8,
            viewDimension: "2d-array",
            mipMaps: true,
        },
        { width: 0, viewDimension: "2d" },
        { width: 33, viewDimension: "2d" },
        { width: 1.5, viewDimension: "2d" },
        { width: NaN, viewDimension: "2d" },
        { width: Infinity, viewDimension: "2d" },
        { width: 2, height: 2, viewDimension: "1d" },
        { width: 2, viewDimension: "1d", mipMaps: true },
        { width: 2, depthOrArrayLayers: 2, viewDimension: "2d" },
        { width: 2, depthOrArrayLayers: 9, viewDimension: "2d-array" },
    ];
    const scalar = (value: number | undefined): string =>
        value === undefined
            ? "std::nullopt"
            : Number.isNaN(value)
              ? "std::numeric_limits<double>::quiet_NaN()"
              : value === Infinity
                ? "std::numeric_limits<double>::infinity()"
                : `${value}`;
    const checks: string[] = [];
    for (const [index, options] of cases.entries()) {
        const call = `bbl::upstream::normalize_compute_texture_extent(${scalar(options.width)}, ${scalar(options.height)}, ${scalar(options.depthOrArrayLayers)}, "${options.viewDimension}", ${options.mipMaps ?? false}, {16,32,16,8})`;
        let resource: {
            width: number;
            height: number;
            depthOrArrayLayers: number;
        };
        try {
            resource = await pin.createComputeStorageTexture(
                { _device: device },
                { ...options, format: "rgba16float", sampled: false },
            );
        } catch (error) {
            assert.ok(index >= 4, String(error));
            checks.push(
                `{bool failed=false; try {(void)${call};} catch(const std::exception&) {failed=true;} assert(failed);}`,
            );
            continue;
        }
        assert.ok(index < 4, "Invalid descriptor was accepted by the pin.");
        checks.push(
            `{const auto size=${call}; assert(size[0]==${resource.width} && size[1]==${resource.height} && size[2]==${resource.depthOrArrayLayers}); assert(bbl::upstream::compute_texture_mip_count(size,"${options.viewDimension}",${options.mipMaps ?? false})==${mipCount});}`,
        );
        pin.disposeComputeStorageTexture(resource);
    }
    const directory = resolve("artifacts/compute-texture-descriptor-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>
#include <cassert>
#include <limits>
namespace bbl::upstream { ${computeTextureDescriptorCpp(new LoweringContext())} }
int main() {${checks.join("\n")}}`,
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
