import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { computeTaskDispatchRecordingCpp } from "../src/lowering/compute-task-recording.js";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("compute task recording preserves dispatch order, binding caches and dynamic offsets", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    const directory = resolve("artifacts/compute-task-recording-check");
    mkdirSync(directory, { recursive: true });
    const cpp = resolve(directory, "check.cpp"),
        exe = resolve(directory, "check.exe");
    writeFileSync(
        cpp,
        `#include <bblite/js_data.hpp>
#include <cassert>
#include <functional>
namespace bbl {${computeTaskDispatchRecordingCpp(new LoweringContext())}}
using Offsets=bbl::js::Array<double>;
using OffsetGroups=bbl::js::Array<std::optional<Offsets>>;
using Handle=std::shared_ptr<int>;
struct Engine{int current_compute_encoder=31;};
struct Shader{Handle object=std::make_shared<int>(1);Handle pipeline(){return object;}};
struct Bindings{
    OffsetGroups zero_offsets;
    std::vector<bool> validation;
    bbl::js::Array<Handle> handles;
    auto groups(bool validate){validation.push_back(validate);return handles;}
};
struct Encoder{
    std::vector<std::string> events;
    void set_pipeline(Handle){events.push_back("pipeline");}
    void set_bind_group(std::uint32_t group,Handle){events.push_back("group"+std::to_string(group));}
    void set_bind_group(std::uint32_t group,Handle,const Offsets& offsets){events.push_back("group"+std::to_string(group)+"@"+std::to_string(static_cast<int>(offsets[0])));}
    void dispatch(std::uint32_t x,std::uint32_t y,std::uint32_t z){assert(y==1&&z==1);events.push_back("dispatch"+std::to_string(x));}
};
struct Dispatch{
    bool enabled=true;
    std::shared_ptr<Shader> shader;
    std::shared_ptr<Bindings> bindings;
    OffsetGroups dynamic_offsets;
    std::array<double,3> dimensions{1,1,1};
    std::function<Handle()> get_pipeline;
    std::function<void(Encoder&,const std::shared_ptr<Dispatch>&)> record;
};
struct Task{bbl::js::Array<std::shared_ptr<Dispatch>> dispatches;std::shared_ptr<Engine> engine=std::make_shared<Engine>();std::function<void(int)> one_shot_recorded;};
struct Cache{std::set<std::shared_ptr<Bindings>> validated_bindings;bbl::js::Array<Handle> last_groups;OffsetGroups last_offsets;};
int main(){
    Task task;Encoder encoder;Cache cache;
    const auto shader=std::make_shared<Shader>();
    const auto bindings=std::make_shared<Bindings>();
    bindings->handles.push_back(std::make_shared<int>(1));bindings->handles.push_back(std::make_shared<int>(2));
    bindings->zero_offsets.resize(2);bindings->zero_offsets[0]=Offsets{0};
    for(int index=0;index<5;++index){
        auto dispatch=std::make_shared<Dispatch>();dispatch->shader=shader;dispatch->bindings=bindings;dispatch->dimensions[0]=index+1;
        task.dispatches.push_back(dispatch);
    }
    task.dispatches[1]->enabled=false;
    task.dispatches[2]->dynamic_offsets.push_back(Offsets{16});
    task.dispatches[3]->shader=std::make_shared<Shader>();task.dispatches[3]->shader->object=shader->object;
    task.dispatches[4]->shader=task.dispatches[3]->shader;
    task.dispatches[4]->record=[](Encoder& target,const auto&){target.events.push_back("indirect");};
    task.one_shot_recorded=[&](int id){assert(id==31);encoder.events.push_back("submitted");};
    std::function<void(Encoder&,const std::shared_ptr<Dispatch>&)> prepare=[](Encoder& target,const auto&){target.events.push_back("prepare");};
    bbl::record_compute_dispatches(task,encoder,cache,prepare);
    assert(encoder.events==std::vector<std::string>({"pipeline","group0@0","group1","prepare","dispatch1","group0@16","prepare","dispatch3","group0@0","group1","prepare","dispatch4","prepare","indirect","submitted"}));
    assert(bindings->validation==std::vector<bool>({true,false,false,false}));
    const auto expected=encoder.events;encoder.events.clear();bindings->validation.clear();
    bbl::record_compute_dispatches(task,encoder,cache,prepare);
    assert(encoder.events==expected&&bindings->validation==std::vector<bool>({true,false,false,false}));
    assert(!bbl::compute_offsets_equal(std::optional<Offsets>{},Offsets{}));
    assert(bbl::compute_offsets_equal(std::optional<Offsets>{Offsets{}},Offsets{}));
    assert(!bbl::compute_offsets_equal(std::optional<Offsets>{Offsets{0,1}},Offsets{0}));
    assert(bbl::compute_offsets_equal(std::optional<Offsets>{Offsets{-0.0}},Offsets{0}));
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
        `/I${resolve("native/include")}`,
        cpp,
        `/Fo${directory}/`,
        `/Fe${exe}`,
    ]);
    assert.equal(execFileSync(exe, { encoding: "utf8", timeout: 10000 }), "");
});
