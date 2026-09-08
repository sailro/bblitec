#include "text-resource-ops.hpp"
#include "statement-probe.hpp"
int main() {
    Ops ops;
    auto payload=std::make_shared<TextDataPayload>();
    payload->instances={pattern(192,1),3,12,192}; payload->styles={pattern(128,2),1,32,128};
    TextAtlas atlas; atlas.curve_set_id="atlas"; atlas.version=1;
    atlas.curves={pattern(131072,3),4096,2,3}; atlas.bands={pattern(131072,4),4096,2,7};
    atlas.metadata={pattern(384,5),3,48,384}; payload->atlases.push_back(atlas);
    TextDrawGroup plain; plain.group_key="atlas"; plain.slot_count=3; plain.live_count=2;
    TextDrawGroup variant=plain; variant.group_key="variant"; variant.slot_start=3; variant.slot_count=2;
    TextDrawGroup empty=plain; empty.slot_count=0;
    payload->groups={plain,variant,empty}; payload->version=1; payload->style_version=1;
    auto data=create_text_data(*payload);
    // A mutable test owner drives growth/failure inputs; source layouts remain static.
    data->payload=payload;
    auto r=create_text_renderable(data); auto second=create_text_renderable(data);
    auto named=[](int id){return std::make_shared<Resource>(Resource{id,"fixed"});};
    TextPipelineBinding pipelines{named(1001),named(1002),named(1003),named(1004)};
    TextTargetSignature target{std::string("rgba8unorm"),4u,std::string("depth24plus")};
    int device_a=0,device_b=0; const void* device=&device_a;
    std::shared_ptr<TextGpuState> gpu;
    auto ensure=[&]{gpu=ensure_text_gpu(*r,device,target,pipelines,ops);};
    auto update=[&]{update_text_resources(*r,*gpu,pipelines.layout,ops);};
    auto draw=[&]{ops.event("draws",draw_text_renderable(*gpu,*data,pipelines.quad,ops));};
    auto record=[&]{
        const auto& a=*data->atlas_gpu.at(0);
        ops.event("state",gpu->instance_capacity,gpu->style_buffer_bytes,gpu->uploaded_data_version,gpu->uploaded_style_version,
            data->dirty_start,data->dirty_end,a.curve_rows,a.band_rows,a.metadata_capacity,a.uploaded_version,
            Ops::id(data->groups.at(0).bind_group),data->groups.at(0).bind_group_version);
    };
    #include "actions.hpp"
    return 0;
}
