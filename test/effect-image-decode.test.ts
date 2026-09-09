import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { PNG } from "pngjs";
import { nativeFixtureVcpkgRoot, optionalNativeFixtureTools, runNativeFixtureCompiler } from "./native-fixture.js";

test("standalone effect builds decode RGBA images and refuse unavailable or malformed inputs", t => {
    const tools = optionalNativeFixtureTools();
    if (!tools) { t.skip("Native fixture compiler unavailable."); return; }
    const directory = resolve("artifacts/effect-image-decode");
    mkdirSync(directory, { recursive: true });
    const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0,
        11, 22, 33, 44, 55, 66, 77, 88, 99, 110, 121, 132]);
    const raster = new PNG({ width: 3, height: 2 });
    raster.data = pixels;
    const png = PNG.sync.write(raster);
    writeFileSync(join(directory, "image.hpp"),
        `const std::vector<std::uint8_t> png_bytes{${[...png].join(",")}};\n` +
        `const std::vector<std::uint8_t> expected_pixels{${[...pixels].join(",")}};\n`);
    for (const decoder of [0, 1]) {
        const executable = join(directory, `decoder-${decoder}.exe`);
        runNativeFixtureCompiler(tools, ["/nologo", "/std:c++20", "/W4", "/WX", "/permissive-", "/EHsc", "/MD",
            "/DBBLITE_HAS_EFFECT_RENDERER=1", "/DBBLITE_HAS_PBR_RENDERER=0", "/DBBLITE_HAS_SPRITE_RENDERER=0",
            `/DBBLITE_HAS_IMAGE_DECODER=${decoder}`, "/I", "native/include", "/I", "native/src",
            "/I", join(nativeFixtureVcpkgRoot, "include"), "/I", directory, `/Fo:${directory}/`, `/Fe:${executable}`,
            "test/fixtures/effect-image-decode-check.cpp", join(nativeFixtureVcpkgRoot, "lib/SDL3.lib"),
            ...(decoder ? [join(nativeFixtureVcpkgRoot, "lib/SDL3_image.lib")] : [])]);
        execFileSync(executable, { stdio: "pipe", env: { ...process.env,
            PATH: `${join(nativeFixtureVcpkgRoot, "bin")};${process.env.PATH ?? ""}` } });
    }
});
