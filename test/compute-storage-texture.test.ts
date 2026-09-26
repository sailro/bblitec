import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { compileSource } from "../src/compiler.js";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeTexture } from "../src/lowering/compute-texture-lowerer.js";
import { lowerManagedResources } from "../src/lowering/managed-resource-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute storage texture reach retains asynchronous resource identity", () => {
    const result = compileSource(`
import {createEngine, createComputeStorageTexture, disposeComputeStorageTexture} from "@babylonjs/lite";
async function main() {
 const engine = await createEngine(document.getElementById("renderCanvas") as HTMLCanvasElement);
 const create = async (options: Parameters<typeof createComputeStorageTexture>[1]) => await createComputeStorageTexture(engine, options);
 const texture = await create({width: 13, height: 7, viewDimension: "2d", format: "rgba16float", mipMaps: true, sampler: {maxAnisotropy: 1}});
 const alias = texture;
 if (alias !== texture || texture.width !== 13 || texture.height !== 7) throw new Error("texture identity");
 disposeComputeStorageTexture(texture);
 disposeComputeStorageTexture(alias);
 if (!alias._destroyed) throw new Error("texture lifecycle");
}
void main();`);
    assert.ok(result.manifest.features.includes("compute:storage-texture"));
    assert.match(result.cpp, /create_compute_storage_texture/);
});

test("compute texture GPU validation and source disposal retain realm ownership", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-storage-texture-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${lowerManagedResources(new LoweringContext()).source}
${lowerComputeTexture(new LoweringContext()).source}
#include <bblite/js_realm_state.hpp>
#include <cassert>
struct Image final : bbl::pal::ComputeTextureAllocation {
    int destroys=0;
    void destroy() override { ++destroys; }
};
struct Device final : bbl::pal::OffscreenDevice {
    int mode=0, calls=0;
    std::shared_ptr<Image> last;
    bbl::pal::ComputeTextureDescriptor descriptor;
    bbl::pal::ComputeTextureCapabilities compute_texture_capabilities() const override {return {{32,32,32,8}, false, false};}
    void create_compute_texture(const bbl::pal::ComputeTextureDescriptor& info, bbl::pal::ComputeTextureCreated complete) override {
        ++calls; descriptor=info; last=std::make_shared<Image>();
        if(mode==1) complete(last, std::make_exception_ptr(bbl::pal::ComputeTextureValidationError("invalid GPU usage")));
        else if(mode==2) complete(last, std::make_exception_ptr(std::runtime_error("allocation failure")));
        else complete(last, {});
    }
};
bbl::js::Promise<bbl::js::PromiseVoid> check(bbl::pal::EventLoop& loop, std::shared_ptr<bbl::Engine> engine, std::shared_ptr<Device> device, bool& completed) {
    bbl::ComputeStorageTextureOptions options;
    options.width=13; options.height=7; options.mip_maps=true;
    options.descriptor.format="rgba16float";
    auto texture=co_await bbl::create_compute_storage_texture(engine, options);
    assert(texture && texture->sampled_texture->data.gpu_source->owners==1 && !texture->destroyed);
    assert(device->descriptor.extent[0]==13 && device->descriptor.extent[1]==7 && device->descriptor.mip_levels==4);
    assert(device->descriptor.render_attachment && device->descriptor.sample_type=="float" && device->descriptor.sampler_type=="non-filtering");
    auto image=device->last;
    auto sampled = *texture->sampled_texture;
    auto compute = texture->compute_texture;
    auto sampler = texture->compute_sampler;
    assert(sampled.identity != 0 && sampled.width == 13 && sampled.height == 7);
    assert(sampled.data.gpu_source->allocation == image && compute->handle == image);
    assert(compute->texture == sampled && sampler->allocation == image);
    assert(compute->sample_type == "float" && compute->view_dimension == "2d" && !compute->multisampled);
    bbl::validate_compute_texture_resource(compute);
    assert(bbl::is_compute_texture_sample_type_compatible("float", "unfilterable-float"));
    assert(!bbl::is_compute_texture_sample_type_compatible("unfilterable-float", "float"));
    auto render_lease=std::make_shared<bbl::GpuTextureLease>(sampled.data.gpu_source);
    assert(sampled.data.gpu_source->owners==2);
    bool rejected=false;
    try {bbl::dispose_compute_storage_texture(texture);} catch(const std::exception& e) {rejected=std::string(e.what())=="#905";}
    assert(rejected && !texture->destroyed && image->destroys==0);
    render_lease.reset();
    assert(sampled.data.gpu_source->owners==1);
    bbl::dispose_compute_storage_texture(texture);
    bbl::dispose_compute_storage_texture(texture);
    assert(texture->destroyed && texture->compute_texture->destroyed && image->destroys==1 && engine->resource_epoch==1);
    rejected=false;
    try {bbl::validate_compute_texture_resource(compute);} catch(const std::exception& e) {rejected=std::string(e.what())=="#857";}
    assert(rejected && sampled.data.gpu_source->owners==0);
    for(int mode=1;mode<3;++mode) {
        device->mode=mode; rejected=false;
        try {(void)co_await bbl::create_compute_storage_texture(engine, options);} catch(const std::exception& e) {
            rejected=std::string(e.what()).find(mode==1 ? "#897" : "allocation failure")!=std::string::npos;
        }
        assert(rejected && device->last->destroys==1);
    }
    device->mode=0;
    options.width=33; rejected=false;
    try {(void)co_await bbl::create_compute_storage_texture(engine, options);} catch(const std::exception& e) {rejected=std::string(e.what()).find("#890")!=std::string::npos;}
    assert(rejected && device->calls==3);
    options.width=4;
    texture=co_await bbl::create_compute_storage_texture(engine, options);
    texture->sampled_texture->data.gpu_source->owners=4;
    engine->dispose_managed_resources();
    assert(texture->destroyed && texture->sampled_texture->data.gpu_source->owners==0 && device->last->destroys==1 && engine->native_resource_owners.empty());
    completed=true; loop.close(); co_return bbl::js::PromiseVoid{};
}
int main() {
    bbl::js::RealmScope realm;
    auto device=std::make_shared<Device>();
    auto engine=std::make_shared<bbl::Engine>();
    engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),device);
    bbl::pal::EventLoop loop; bool completed=false;
    loop.run([&] {check(loop,engine,device,completed);});
    assert(completed);
}
`,
    );
    runNativeFixtureCompiler(tools, [
        "/nologo",
        "/std:c++20",
        "/W4",
        "/WX",
        "/EHsc",
        "/MD",
        "/DBBLITE_WORKERS=1",
        "/DBBLITE_OFFSCREEN_SURFACES=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
