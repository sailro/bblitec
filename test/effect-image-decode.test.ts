import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG, type ColorType } from "pngjs";
import {
    nativeFixtureVcpkgRoot,
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("standalone effect builds decode RGBA images and refuse unavailable or malformed inputs", (t) => {
    const tools = optionalNativeFixtureTools();
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/effect-image-decode");
    mkdirSync(directory, { recursive: true });
    const pixels = Buffer.from([
        255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 11, 22, 33, 44, 55, 66,
        77, 88, 99, 110, 121, 132,
    ]);
    const raster = new PNG({ width: 3, height: 2 });
    raster.data = pixels;
    const png = PNG.sync.write(raster);
    const png16Cases = ([0, 2, 4, 6] satisfies ColorType[]).map((colorType) => {
        const gray = colorType === 0 || colorType === 4;
        const alpha = colorType === 4 || colorType === 6;
        const samples: number[] = [];
        const expanded: number[] = [];
        const rgba: number[] = [];
        for (let pixel = 0; pixel < 6; ++pixel) {
            const red = [0, 0x1234, 0x80ff, 0xffff, 0xff00, 0x0102][pixel]!;
            const green = gray ? red : 0x3456;
            const blue = gray ? red : 0x789a;
            const opacity = alpha ? 0xabcd : 0xffff;
            samples.push(
                red,
                ...(gray ? [] : [green, blue]),
                ...(alpha ? [opacity] : []),
            );
            expanded.push(red, green, blue, ...(alpha ? [opacity] : []));
            rgba.push(
                ...[red, green, blue, opacity].map((value) =>
                    Math.round(value / 257),
                ),
            );
        }
        const image = new PNG({ width: 3, height: 2 });
        image.data = Buffer.from(new Uint16Array(samples).buffer);
        const encoded = PNG.sync.write(image, {
            bitDepth: 16,
            colorType,
            inputColorType: colorType,
        });
        return `{${alpha ? "true" : "false"}, {${[...encoded].join(",")}}, {${expanded.join(",")}}, {${rgba.join(",")}}}`;
    });
    writeFileSync(
        join(directory, "image.hpp"),
        `const std::vector<std::uint8_t> png_bytes{${[...png].join(",")}};\n` +
            `const std::vector<std::uint8_t> expected_pixels{${[...pixels].join(",")}};\n` +
            "struct Png16Case { bool alpha; std::vector<std::uint8_t> bytes; std::vector<std::uint16_t> samples; std::vector<std::uint8_t> rgba; };\n" +
            `const std::vector<Png16Case> png16_cases{${png16Cases.join(",")}};\n`,
    );
    for (const decoder of [0, 1]) {
        const executable = join(directory, `decoder-${decoder}.exe`);
        runNativeFixtureCompiler(tools, [
            "/nologo",
            "/std:c++20",
            "/W4",
            "/WX",
            "/permissive-",
            "/EHsc",
            "/MD",
            "/O1",
            "/GL",
            "/DBBLITE_HAS_EFFECT_RENDERER=1",
            "/DBBLITE_HAS_PBR_RENDERER=0",
            "/DBBLITE_HAS_SPRITE_RENDERER=0",
            `/DBBLITE_HAS_IMAGE_DECODER=${decoder}`,
            "/I",
            "native/include",
            "/I",
            "native/src",
            "/I",
            join(nativeFixtureVcpkgRoot, "include"),
            "/I",
            directory,
            `/Fo:${directory}/`,
            `/Fe:${executable}`,
            "test/fixtures/effect-image-decode-check.cpp",
            "native/src/pal_image.cpp",
            join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
            ...(decoder
                ? [join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib")]
                : []),
            "/link",
            "/LTCG",
        ]);
        execFileSync(executable, {
            stdio: "pipe",
            env: {
                ...process.env,
                PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}`,
            },
        });
    }
});
