#include <cassert>
#include <iostream>

namespace bbl {
int picking_calls = 0;
Engine create_engine(EngineOptions options) {
    Engine engine;
    engine.options = options;
    if (options.title == "Babylon Lite Native") engine.options.title="first";
    engine.meshes.emplace_back();
    engine.meshes.back().name = engine.options.title;
    engine.pick_hook = [](GpuPickerHandle, double x, double) {
        ++picking_calls;
        PickingInfo info;
        if (x == 0) return info;
        info.hit = true;
        info.picked_kind = PickedNodeKind::mesh;
        info.picked_index = 0;
        info.picked_point = std::array<double,3>{1,2,3};
        info.face_id = 0;
        info.bu = 1.0/3.0;
        info.bv = 1.0/7.0;
        return info;
    };
    return engine;
}
Scene create_scene_context(Engine& engine) { Scene scene; scene.engine=&engine; return scene; }
std::vector<float> mesh_cpu_positions(const Engine&, MeshHandle) { return {0,0,0,1,0,0,0,1,0}; }
std::vector<float> mesh_cpu_normals(const Engine& engine, MeshHandle) {
    return engine.options.title=="first"?std::vector<float>{1,0,0,1,0,0,1,0,0}:std::vector<float>{0,1,0,0,1,0,0,1,0};
}
std::vector<std::uint32_t> mesh_cpu_indices(const Engine&, MeshHandle) { return {0,1,2}; }
namespace upstream {
std::array<float,16> mesh_world_matrix(const Engine&, const MeshRecord&) { return {1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1}; }
}
}

template<class F> void expired(F read) {
    bool failed=false;
    try { read(); } catch(const std::runtime_error& error) { failed=std::string(error.what()).find("original live engine")!=std::string::npos; }
    assert(failed);
}
int main() {
    using namespace bbl;
    assert(generated_scene_main()==0);
    assert(picking_calls==10); // two successful searches, one miss, one repeat
    {
        Engine first=create_engine({"first",1280,720});
        Engine second=create_engine({"second",1280,720});
        Scene first_scene=create_scene_context(first);
        Scene second_scene=create_scene_context(second);
        const auto first_info=gpu_pick(first,create_gpu_picker(first_scene),1,0);
        const auto second_info=gpu_pick(second,create_gpu_picker(second_scene),1,0);
        const js::Array<PickingInfo> rows{first_info,second_info};
        const js::Nullable<PickingInfo> retained{rows[1]};
        assert(picked_node_name(*retained)=="second");
        assert(picked_node_name(rows[0])=="first");
        assert((*picked_normal(rows[0],false))[1]==0);
        assert((*picked_normal(*retained,false))[1]==1);
    }
    PickingInfo result;
    {
        Engine first=create_engine({"first",1280,720});
        Scene scene=create_scene_context(first);
        result=gpu_pick(first,create_gpu_picker(scene),1,0);
        PickingInfo alias=result;
        assert(alias==result);
        alias.bu=0.75;
        assert(result.bu==0.75);
        first.meshes[0].name="renamed";
        assert(picked_node_name(result)=="renamed");
        const PickingInfo other=gpu_pick(first,create_gpu_picker(scene),1,0);
        assert(other!=result);
        Engine moved=std::move(first);
        expired([&]{static_cast<void>(picked_node_name(result));});
        expired([&]{static_cast<void>(picked_normal(result,false));});
        Scene moved_scene=create_scene_context(moved);
        result=gpu_pick(moved,create_gpu_picker(moved_scene),1,0);
        assert(&picking_engine(result)==&moved);
        Engine assigned;
        assigned=std::move(moved);
        expired([&]{static_cast<void>(picking_engine(result));});
        Scene assigned_scene=create_scene_context(assigned);
        result=gpu_pick(assigned,create_gpu_picker(assigned_scene),1,0);
        assert(&picking_engine(result)==&assigned);
    }
    assert(result.hit && result.bu==1.0/3.0);
    expired([&]{static_cast<void>(picked_node_name(result));});
    expired([&]{static_cast<void>(picked_normal(result,false));});
    js::collect_cycles();
    std::cout<<"picking-info-check: ok\n";
}
