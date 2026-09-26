import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BabylonLowerer } from "../src/lowering/babylon-lowerer.js";
import { LoweringContext } from "../src/lowering/context.js";
import { FactoryLowerer } from "../src/lowering/factory/material-factories.js";
import { LightLowerer } from "../src/lowering/light-lowerer.js";
import { pinnedWorldTransformHeader } from "../src/lowering/pinned-world-transform.js";
import type { WindowsBuildTools } from "../src/development-tools.js";
import {
    cppFunction,
    nativeFixtureVcpkgRoot,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

/**
 * Build and run a check over the complete generated `.babylon` loader, as
 * `BabylonLowerer` emits it for a scene, with file reads served from the
 * fixture directory and every other platform call refused. `definitions`
 * lands inside namespace `bbl` after the loader, so it can reach the
 * loader's internal passes; `main` is the check's body.
 */
export function runBabylonLoaderCheck(
    tools: WindowsBuildTools,
    directory: string,
    definitions: string,
    main: string,
): void {
    const context = new LoweringContext();
    const include = join(directory, "include");
    mkdirSync(join(include, "bblite/upstream"), { recursive: true });
    writeFileSync(
        join(include, "bblite/upstream/pinned_world_transform.hpp"),
        pinnedWorldTransformHeader(context),
    );
    const lights = new LightLowerer(context);
    writeFileSync(
        join(include, "bblite/upstream/light_matrix.hpp"),
        lights.lowerMatrix().header,
    );
    const source = join(directory, "check.cpp"),
        executable = join(directory, "check.exe");
    writeFileSync(
        source,
        `#include <bblite/pal_image.hpp>
#include <fstream>
#include <cassert>
${lights.lowerMatrix().source}
${lights.lowerPointFactory().source}
${new BabylonLowerer(context).lowerLoaderAdapter().source}
namespace bbl {
${definitions}
namespace pal {
std::vector<std::uint8_t> read_binary_file(const std::string& path) {
    std::ifstream file(path,std::ios::binary);
    if(!file) throw std::runtime_error("Unexpected fixture path: "+path);
    return {std::istreambuf_iterator<char>(file),std::istreambuf_iterator<char>()};
}
std::string parent_path(const std::string&) { return ""; }
std::string join_path(const std::string& a,const std::string& b) { return a+b; }
DecodedImage decode_image(std::span<const std::uint8_t>) { throw std::runtime_error("Unexpected fixture texture."); }
}
// The refusal reads a volatile flag: a factory MSVC proves always throws makes the
// loader's checked camera writes after it unreachable code (C4702 under /WX).
CameraHandle create_free_camera(Engine&,Vec3d,Vec3d) {
    static volatile bool unexpected = true;
    if (unexpected) throw std::runtime_error("Unexpected fixture camera.");
    return {};
}
${cppFunction(new FactoryLowerer(context).lowerFileTextureFactory().source, "FileTexture load_file_texture(")}
}
int main() {
    using namespace bbl;
${main}
}`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/O2",
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        "/I",
        include,
        "/I",
        "native/include",
        "/I",
        join(nativeFixtureVcpkgRoot, "include"),
        source,
    ]);
    execFileSync(executable, [], { cwd: directory, stdio: "pipe" });
}
