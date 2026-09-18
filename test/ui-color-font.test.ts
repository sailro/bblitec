import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { discoverDevelopmentTools } from "../src/development-tools.js";
import { selectIosSimulator } from "../src/ios-simulator.js";

test("iOS system emoji produce visible premultiplied glyphs with stable metrics, cache and ownership", {
    skip: process.platform !== "darwin" || !process.env.BBLITE_IOS_TEST_DEVICE,
}, () => {
    const tools = discoverDevelopmentTools();
    assert.ok(tools.cmake && tools.cxx && tools.vcpkgToolchain, "CMake, Clang and vcpkg are required.");
    const device = selectIosSimulator(execFileSync("xcrun", ["simctl", "list", "devices", "available", "--json"], { encoding: "utf8" }),
        process.env.BBLITE_IOS_TEST_DEVICE!);
    assert.equal(device.state, "Booted", "Boot the selected Simulator before running the font fixture.");
    const sdk = execFileSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], { encoding: "utf8" }).trim();
    const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    const triplet = architecture === "arm64" ? "arm64-ios-simulator-bblite" : "x64-ios-simulator-bblite";
    const output = resolve("artifacts/ui-color-font-check", architecture);
    mkdirSync(output, { recursive: true });
    const run = (command: string, args: string[]): string => execFileSync(command, args,
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const configure = run(tools.cmake, ["-S", "test/fixtures/ui-color-font", "-B", output, "-G", "Ninja",
        `-DCMAKE_CXX_COMPILER=${tools.cxx}`, "-DCMAKE_SYSTEM_NAME=iOS", `-DCMAKE_OSX_SYSROOT=${sdk}`,
        `-DCMAKE_SYSROOT=${sdk}`, `-DCMAKE_OSX_ARCHITECTURES=${architecture}`, "-DCMAKE_OSX_DEPLOYMENT_TARGET=16.0",
        "-DCMAKE_BUILD_TYPE=Release", `-DCMAKE_TOOLCHAIN_FILE=${tools.vcpkgToolchain}`,
        `-DVCPKG_TARGET_TRIPLET=${triplet}`, `-DVCPKG_OVERLAY_TRIPLETS=${resolve("native/triplets")}`,
        `-DVCPKG_INSTALLED_DIR=${resolve("artifacts/ios-vcpkg")}`, "-DVCPKG_MANIFEST_INSTALL=OFF",
        `-DBBLITE_RMLUI_DIR=${resolve(`artifacts/tools/rmlui-ios-iphonesimulator-${architecture}`)}`]);
    writeFileSync(join(output, "configure.log"), configure);
    writeFileSync(join(output, "build.log"), run(tools.cmake, ["--build", output, "--parallel", "3"]));
    const executable = join(output, "ui_color_font_check");
    run("codesign", ["--force", "--sign", "-", executable]);
    const result = run("xcrun", ["simctl", "spawn", device.udid, executable]);
    writeFileSync(join(output, "run.log"), result);
    assert.equal(result.match(/^emoji=/gm)?.length, 12, "Each of four menu emoji must render at all three sizes.");
    assert.match(result, /ui-color-font-check: ok/);
});
