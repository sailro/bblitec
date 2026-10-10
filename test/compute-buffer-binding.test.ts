import test from "node:test";
import { LoweringContext } from "../src/lowering/context.js";
import { lowerComputeBufferBinding } from "../src/lowering/compute-buffer-binding-lowerer.js";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("compute buffer bindings retain ranges, dynamic limits and live registrations", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "compute-buffer-binding-check",
        `${lowerComputeBufferBinding(new LoweringContext()).source}
#include <cassert>
struct Allocation final:bbl::pal::StorageBufferAllocation{
 void destroy()override{}void write_buffer_bytes(std::size_t,std::span<const std::uint8_t>) override{}
};
int main(){
 auto engine=std::make_shared<bbl::Engine>();
 auto uniform=std::make_shared<bbl::UniformBuffer>();uniform->engine=engine;uniform->byte_length=512;uniform->allocation=std::make_shared<Allocation>();
 auto registry=std::make_shared<bbl::UniformBufferRegistry>();registry->engine=engine;registry->buffers.insert(uniform);uniform->registry=registry;
 auto ref=bbl::compute_buffer_reference(uniform);
 auto decl=std::make_shared<bbl::ComputeBindingDecl>();decl->name="params";
 const bbl::ComputeBufferPredicate expected=[](const auto& value){return !value->storage;};
 const bbl::ComputeBufferPredicate writable=[](const auto&){return true;};
 const bbl::ComputeBufferMembership registered=[](const auto& owner,const auto& value){return value->engine==owner&&value->registered();};
 bbl::ComputeBufferRange range{ref,256,{}};
 auto resolved=bbl::resolve_compute_buffer_binding(engine,decl,range,expected,writable,false,false,0,512,256);
 assert(resolved.state.buffer==ref&&resolved.state.offset==256&&!resolved.state.size&&!resolved.dynamic);
 auto resource=bbl::get_compute_buffer_binding_resource(engine,resolved.state,registered);
 assert(resource.allocation==uniform->allocation&&resource.offset==256&&!resource.size);
 resolved=bbl::resolve_compute_buffer_binding(engine,decl,range,expected,writable,false,true,16,512,256);
 assert(resolved.state.size==16&&resolved.dynamic->alignment==256&&resolved.dynamic->max_offset==240);
 const auto reject=[&](const bbl::ComputeBufferRange& value,bool dynamic,double minimum,double maximum,const char* code){bool failed=false;try{(void)bbl::resolve_compute_buffer_binding(engine,decl,value,expected,writable,false,dynamic,minimum,maximum,256);}catch(const std::exception& error){failed=std::string(error.what())==code;}assert(failed);};
 reject({},false,0,512,"#856");
 uniform->destroyed=true;reject(range,false,0,512,"#857");uniform->destroyed=false;
 auto other=std::make_shared<bbl::Engine>();ref->engine=other;reject(range,false,0,512,"#858");ref->engine=engine;
 for(double offset:{-256.0,1.0,0.5})reject({ref,offset,{}},false,0,512,"#860");
 reject(range,true,0,512,"#861");
 for(double size:{0.0,-4.0,3.0,4.5})reject({ref,0,size},false,0,512,"#862");
 reject({ref,512,{}},false,0,512,"#863");
 reject({ref,0,4},false,8,512,"#864");
 reject({ref,0,16},false,0,8,"#865");
 reject({ref,256,260},false,0,512,"#866");
 registry->buffers.erase(uniform);bool dead=false;try{(void)bbl::get_compute_buffer_binding_resource(engine,resolved.state,registered);}catch(const std::exception& error){dead=std::string(error.what())=="#867";}assert(dead);
}
`,
        {
            flags: ["/DBBLITE_WORKERS=1", "/DBBLITE_OFFSCREEN_SURFACES=1"],
            timeoutMs: 10000,
            expectedOutput: "",
        },
    );
});
