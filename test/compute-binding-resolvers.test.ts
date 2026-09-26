import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeBindingResolvers } from "../src/lowering/compute-binding-resolvers.js";
import { lowerComputeBufferBinding } from "../src/lowering/compute-buffer-binding-lowerer.js";
import { lowerComputeBindingDecl } from "../src/lowering/compute-binding-decl-lowerer.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("installed compute resolvers enforce resource ownership, compatibility and realm isolation", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const context = new LoweringContext(),
        directory = resolve("artifacts/compute-binding-resolvers-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `${lowerComputeBindingDecl(context).source}\n${lowerComputeBufferBinding(context).source}\n${lowerComputeBindingResolvers(context).source}
#include <cassert>
namespace bbl {
void validate_compute_texture_resource(const std::shared_ptr<ComputeTextureResource>&) {}
bool is_compute_texture_sample_type_compatible(const std::string& actual,const std::string& declared){return actual==declared;}
}
struct Image final:bbl::pal::ComputeTextureAllocation{void destroy()override{}};
struct Buffer final:bbl::pal::StorageBufferAllocation{void destroy()override{}void write_buffer_bytes(std::size_t,std::span<const std::uint8_t>) override{}};
struct Device final:bbl::pal::OffscreenDevice{bbl::pal::ComputeShaderLimits compute_shader_limits()const override{return {};}};
template<class F> void error(const char* expected,F fn){try{fn();}catch(const std::exception& e){if(std::string(e.what())==expected)return;throw std::runtime_error(std::string("Expected ")+expected+", got "+e.what());}throw std::runtime_error(std::string("Expected ")+expected+", no error");}
int main(){
 for(int realm=0;realm<2;++realm){bbl::js::RealmScope scope;
  error("#715",[]{bbl::get_compute_binding_resolver(3);});
  auto engine=std::make_shared<bbl::Engine>(), other=std::make_shared<bbl::Engine>();
  engine->offscreen_run=std::make_shared<bbl::pal::OffscreenRun>(std::make_shared<bbl::pal::OffscreenSurface>(1,1),std::make_shared<Device>());
  bbl::ComputeBindingOptions options;auto sampled=bbl::compute_texture_binding("image",options);
  auto texture=std::make_shared<bbl::ComputeTextureResource>();texture->engine=engine;texture->handle=std::make_shared<Image>();texture->sample_type="float";texture->view_dimension="2d";
  auto resolver=bbl::get_compute_binding_resolver(sampled->kind);auto resolved=resolver->resolve(engine,sampled,texture);assert(std::get<std::shared_ptr<bbl::ComputeTextureResource>>(resolved.state)==texture);
  assert(std::get<bbl::pal::ComputeTextureResource>(resolver->get(engine,resolved.state)).role==bbl::pal::ComputeTextureViewRole::sampled);
  error("#781",[&]{resolver->resolve(other,sampled,texture);});
  error("#781",[&]{resolver->resolve(engine,sampled,std::monostate{});});
  error("#786",[&]{resolver->validate(other,resolved.state);});
  texture->sample_type="uint";error("#782",[&]{resolver->resolve(engine,sampled,texture);});texture->sample_type="float";
  texture->multisampled=true;error("#783",[&]{resolver->resolve(engine,sampled,texture);});texture->multisampled=false;
  texture->view_dimension="3d";error("#784",[&]{resolver->resolve(engine,sampled,texture);});texture->view_dimension="2d";
  texture->destroyed=true;error("#785",[&]{resolver->get(engine,resolved.state);});
  auto samplerDecl=bbl::compute_sampler_binding("sampler",options),storageDecl=bbl::compute_storage_buffer_binding("buffer",options);
  auto sampler=std::make_shared<bbl::ComputeSamplerResource>();sampler->engine=engine;sampler->allocation=std::make_shared<Image>();sampler->type="non-filtering";
  auto samplerResolver=bbl::get_compute_binding_resolver(samplerDecl->kind);auto samplerState=samplerResolver->resolve(engine,samplerDecl,sampler).state;
  error("#751",[&]{samplerResolver->get(other,samplerState);});
  sampler->type="comparison";error("#750",[&]{samplerResolver->resolve(engine,samplerDecl,sampler);});
  auto storageResolver=bbl::get_compute_binding_resolver(storageDecl->kind);error("#719",[&]{storageResolver->resolve(engine,storageDecl,sampler);});
  options.format="rgba16float";auto imageDecl=bbl::compute_storage_texture_binding("output",options);
  auto registry=std::make_shared<bbl::ComputeStorageTextureRegistry>();registry->engine=engine;
  auto image=std::make_shared<bbl::ComputeStorageTexture>();image->registry=registry;image->allocation=std::make_shared<Image>();image->descriptor.format="rgba16float";image->descriptor.accesses={"write-only"};registry->resources.insert(image);
  auto imageResolver=bbl::get_compute_binding_resolver(imageDecl->kind);auto imageState=imageResolver->resolve(engine,imageDecl,image).state;
  assert(std::get<bbl::pal::ComputeTextureResource>(imageResolver->get(engine,imageState)).role==bbl::pal::ComputeTextureViewRole::storage);
  image->descriptor.format="rgba32float";error("#766",[&]{imageResolver->resolve(engine,imageDecl,image);});image->descriptor.format="rgba16float";
  image->descriptor.dimension="3d";error("#767",[&]{imageResolver->resolve(engine,imageDecl,image);});image->descriptor.dimension="2d";
  image->descriptor.accesses={"read-only"};error("#768",[&]{imageResolver->resolve(engine,imageDecl,image);});
  registry->resources.erase(image);error("#769",[&]{imageResolver->get(engine,imageState);});
  auto original=resolver;bbl::install_compute_binding_resolver(3,nullptr,nullptr);assert(bbl::get_compute_binding_resolver(3)==original);
 }
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
        "/DBBLITE_COMPUTE_BINDINGS=1",
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
