#include "text-resource-ops.hpp"
#include <bblite/upstream_text_renderer.hpp>
#include <numbers>

Lease named(int id){return std::make_shared<Resource>(Resource{id,"named"});}
struct RendererOps:Ops {
    TextPipelineBinding pipelines{named(1001),named(1002),named(1003),named(1004)};
    TextPipelineBinding resolve_text_renderer_pipeline(){return pipelines;}
    std::shared_ptr<void> text_renderer_quad(){return pipelines.quad;}
    std::shared_ptr<void> retain_instance_buffer(const TextGpuState& gpu){return render(gpu).instances;}
    void set_instance_buffer(const std::shared_ptr<void>& buffer){event("vertex",1,id(buffer));}
    void begin_text_renderer_pass(const TextRendererState& renderer){event("pass",renderer.clear,renderer.clear_value.r,renderer.clear_value.g,renderer.clear_value.b,renderer.clear_value.a);}
    void end_text_renderer_pass(){event("end");}
};
int main(){
    RendererOps ops;int device=0;
    auto payload=std::make_shared<TextDataPayload>();
    payload->instances={pattern(192,1),5,12,192};payload->styles={pattern(128,2),1,32,128};
    TextAtlas atlas;atlas.curve_set_id="atlas";atlas.version=1;
    atlas.curves={pattern(131072,3),4096,2,3};atlas.bands={pattern(131072,4),4096,2,7};atlas.metadata={pattern(384,5),3,48,384};payload->atlases.push_back(atlas);
    TextDrawGroup plain;plain.group_key="atlas";plain.slot_count=3;plain.live_count=2;
    auto variant=plain;variant.group_key="variant";variant.slot_start=3;variant.slot_count=2;
    auto empty=plain;empty.slot_count=0;
    auto data=std::make_shared<TextDataState>();data->payload=payload;data->groups={plain,variant,empty};data->atlas_gpu.resize(1);
    data->instance_count=5;data->style_count=1;data->version=1;data->style_version=1;
    auto a=create_text_layer(data),b=create_text_layer(data);
    a->position_px={10,20};a->order=2;b->position_px={250,50};b->scale=.75;b->order=1;
    TextRendererState rr;rr.layers={a,b};rr.clear_value={.1f,.2f,.3f,1};
    double width=1280,height=720;
    const auto update=[&]{update_text_renderer(rr,width,height,&device,ops);};
    const auto draw=[&]{ops.event("draws",record_text_renderer(rr,ops));};
    const auto record=[&]{for(const auto& layer:rr.layers){const auto lg=rr.layer_gpu.at(layer);ops.event("state",layer==a?"a":"b",lg->instance_capacity,lg->uploaded_data_version,lg->uploaded_style_version,lg->uploaded_viewport_w,lg->uploaded_viewport_h,lg->bundle_layout_version,lg->bundle_draw_calls,lg->bind_group_cache.size());}};
#include "actions.hpp"
}
