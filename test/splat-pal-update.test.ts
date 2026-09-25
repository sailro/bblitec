import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { SplatLowerer } from "../src/lowering/splat-lowerer.js";
import {
    cppFunction,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const nativeTools = optionalNativeFixtureTools(false);
test(
    "splat PAL updates reuse payloads and invalidate sorting only after a successful upload",
    { skip: !nativeTools },
    () => {
        const output = resolve("artifacts/splat-pal-update");
        const headers = join(output, "bblite/upstream");
        mkdirSync(headers, { recursive: true });
        const lowerer = new SplatLowerer(new LoweringContext());
        const geometry = lowerer.lowerGeometry();
        const sort = lowerer.lowerSort();
        writeFileSync(join(headers, "splat_geometry.hpp"), geometry.header);
        writeFileSync(join(headers, "splat_sort.hpp"), sort.header);
        writeFileSync(join(output, "splat_sort.cpp"), sort.source);
        const sdl = readFileSync("native/src/pal_sdl_gpu_splat.hpp", "utf8");
        const dawn = readFileSync("native/src/pal_dawn_splat.hpp", "utf8");
        writeFileSync(
            join(output, "pal_update.hpp"),
            [
                readFileSync("test/fixtures/gpu-writer-recorder.hpp", "utf8"),
                cppFunction(sdl, "inline void sync_splat_data("),
                cppFunction(sdl, "inline void upload_splat_pass("),
                cppFunction(dawn, "inline void write_dawn_splat_texture("),
                cppFunction(dawn, "inline void sync_dawn_splat_data("),
                cppFunction(dawn, "inline void upload_dawn_splat_pass("),
            ].join("\n"),
        );
        // Each backend's frame loop, lifted from the synchronization hook
        // that runs it; `camera` is the scene's, null for a camera-less one.
        const frameLoops = ["sdl_gpu", "dawn"].map((backend) => {
            const pass = backend === "dawn" ? "DawnSplatPass" : "SplatPass";
            const source = cppFunction(
                readFileSync(`native/src/pal_${backend}.cpp`, "utf8"),
                "void upload_splats(",
            );
            return `void frame_${backend}(Recorder& recorder, const Engine& engine, ${pass}& pass,
            const std::array<float, 16>& frame_view, const CameraRecord* camera) {
            struct { Recorder* device; Recorder* queue; std::span<${pass}> splat_passes; } state{&recorder, &recorder, {&pass, 1}};
            const struct {
                std::array<float, 16> view, projection;
                std::array<float, 4> camera_position;
            } matrices{frame_view, frame_view, {}};
            [[maybe_unused]] const std::uint32_t width = 1280;
            [[maybe_unused]] const std::uint32_t height = 720;
            ${cppFunction(source, `for (${pass}& splat : state.splat_passes)`)}
        }`;
        });
        writeFileSync(join(output, "frame_uploads.hpp"), frameLoops.join("\n"));
        const source = join(output, "check.cpp");
        writeFileSync(
            source,
            readFileSync("test/fixtures/splat-pal-update-check.cpp"),
        );
        const executable = join(output, "check.exe");
        runNativeFixtureCompiler(nativeTools!, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/EHsc",
            "/MD",
            "/O2",
            "/Gy",
            "/I",
            "native/include",
            "/I",
            output,
            `/Fo:${output}\\`,
            `/Fe:${executable}`,
            source,
            join(output, "splat_sort.cpp"),
            "/link",
            "/OPT:REF",
        ]);
        assert.match(
            execFileSync(executable, { encoding: "utf8" }),
            /splat-pal-update: ok/,
        );
    },
);
