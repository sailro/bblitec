/** Manager-wide source mixer storage. Node-array identity is the source target key. */
export function gltfWeightedAnimationTransportCpp(rootFlip: string): {types: string; dispatcher: string} {
    return {types: `
using GltfWeightedNodes = std::vector<GltfAnimationPoseNode>;
struct GltfWeightedTarget : GltfAnimationPoseState {
    std::shared_ptr<AnimationRuntime> runtime;
    std::optional<std::size_t> override_asset;
    std::optional<GltfAnimationFloats> baseRot;
    GltfAnimationFloats tWeight,rWeight,sWeight;
    bool active=false;
};
struct GltfWeightedScratch {
    std::set<const GltfWeightedNodes*> keys;
    std::vector<std::pair<const GltfWeightedNodes*,GltfWeightedTarget&>> targets;
    std::vector<std::shared_ptr<GltfWeightedTarget>> owned_targets;
    std::unordered_map<const GltfWeightedNodes*,std::size_t> target_indices;
    GltfAnimationFloats sample,reference,delta;
};
`, dispatcher: `
struct GltfWeightedAnimationRuntimeState { std::shared_ptr<GltfWeightedScratch> value; };
bool update_weighted_gltf_animation_groups(Engine& native_engine,PropertyAnimationManagerRecord& manager,double delta_ms) {
    if(!manager.source_gltf_animation)manager.source_gltf_animation=std::make_shared<GltfWeightedAnimationRuntimeState>();
    auto& scratch=gltf_get_weighted_scratch(manager.source_gltf_animation->value);
    struct Transport {
        Engine& native_engine;
        bool source_engine_present;
        const std::vector<AnimationGroupReference>& groups;
        GltfWeightedScratch& scratch;
        decltype(scratch.keys)& keys;
        decltype(scratch.targets)& targets;
        std::shared_ptr<AnimationRuntime> creating_runtime;
        struct Mixer {
            std::shared_ptr<AnimationRuntime> runtime;
            std::size_t clip=0;
            explicit operator bool()const{return bool(runtime);}
        };
        Mixer mixer(const AnimationGroupReference& reference)const {
            if(reference.kind!=AnimationWeightFadeTargetKind::gltf)return {};
            const auto& record=native_engine.animation_groups.at(reference.gltf_group.value);
            const auto& source=native_engine.assets.at(record.asset).source_animation;
            return source?Mixer{source->value,record.clip}:Mixer{};
        }
        AnimationClip& clip(const Mixer& mixer)const{return mixer.runtime->clips.at(mixer.clip);}
        bool stopped(const AnimationGroupReference& reference)const {
            const auto value=mixer(reference);
            return value?clip(value).stopped:reference.property_group&&reference.property_group->stopped;
        }
        bool additive(const AnimationGroupReference& reference)const {
            const auto value=mixer(reference);return value&&clip(value).additive;
        }
        double weight(const AnimationGroupReference& reference)const {
            return reference.kind==AnimationWeightFadeTargetKind::gltf
                ?native_engine.animation_groups.at(reference.gltf_group.value).weight:reference.property_group->weight;
        }
        const GltfWeightedNodes* nodes_key(const Mixer& mixer)const{return &mixer.runtime->source_nodes;}
        const GltfWeightedNodes& nodes(const Mixer& mixer)const{return mixer.runtime->source_nodes;}
        const auto& skeletons(const Mixer& mixer)const{return mixer.runtime->source_skeletons;}
        auto overrides(const GltfAnimationPoseSkeleton& skeleton)const{return skeleton.override_asset;}
        bool engine()const{return source_engine_present;}
        std::shared_ptr<GltfWeightedTarget> lookup(const GltfWeightedNodes& nodes)const {
            const auto found=scratch.target_indices.find(&nodes);
            return found==scratch.target_indices.end()?std::shared_ptr<GltfWeightedTarget>{}:scratch.owned_targets.at(found->second);
        }
        void publish(const GltfWeightedNodes& nodes,const std::shared_ptr<GltfWeightedTarget>& target) {
            const auto index=targets.size();
            try {
                scratch.owned_targets.push_back(target);
                targets.emplace_back(&nodes,*target);
                scratch.target_indices.emplace(&nodes,index);
            } catch(...) {
                if(targets.size()>index)targets.pop_back();
                if(scratch.owned_targets.size()>index)scratch.owned_targets.pop_back();
                throw;
            }
        }
        std::shared_ptr<GltfWeightedTarget> create_target(const GltfWeightedNodes& nodes,
            const GltfAnimationObjectRows<GltfAnimationPoseSkeleton>& skeletons,std::optional<std::size_t> overrides,
            std::optional<GltfAnimationFloats> base_rotation,GltfAnimationFloats trs,GltfAnimationFloats local,
            GltfAnimationFloats world,std::vector<std::int32_t> order,GltfAnimationFloats translation_weights,
            GltfAnimationFloats rotation_weights,GltfAnimationFloats scale_weights,bool active) {
            auto result=std::make_shared<GltfWeightedTarget>();
            result->runtime=creating_runtime;result->nodes=nodes;result->skeletons=skeletons;
            result->override_asset=overrides;result->has_bone_overrides=overrides.has_value();
            result->baseRot=std::move(base_rotation);result->currentTRS=std::move(trs);
            result->localMat=std::move(local);result->worldMat=std::move(world);
            result->topo_order.assign(order.begin(),order.end());
            result->tWeight=std::move(translation_weights);result->rWeight=std::move(rotation_weights);result->sWeight=std::move(scale_weights);
            result->active=active;result->RH_TO_LH=${rootFlip};
            return result;
        }
        GltfAnimationOverrideRows override_rows(const GltfWeightedTarget& target)const {
            return target.override_asset?gltf_animation_override_rows(native_engine,*target.override_asset):GltfAnimationOverrideRows{};
        }
        void reset_target(GltfWeightedTarget& target) {
            const auto overrides=override_rows(target);target.bone_override_count=static_cast<double>(overrides.size());
            gltf_reset_weighted_target(target,[&](auto& trs,double count,bool hidden){
                gltf_apply_animation_bone_overrides(overrides,trs,count,hidden);
            });
        }
        GltfWeightedTarget& get_target(const Mixer& mixer) {
            creating_runtime=mixer.runtime;
            return gltf_get_weighted_target(*this,mixer);
        }
        void advance_group_time(const AnimationGroupReference&,const Mixer& mixer,double delta) {
            auto& group=clip(mixer);gltf_advance_weighted_animation(group,delta,group.speed_ratio);
        }
        void tick_animation_core(const AnimationGroupReference& reference,double delta) {
            tick_animation_group_reference(native_engine,reference,delta);
        }
        void accumulate_group(const AnimationGroupReference& reference,const Mixer& mixer,double delta) {
            auto& group=clip(mixer);group.weight=weight(reference);
            gltf_accumulate_weighted_group(scratch,group,*group.pose,delta,group.speed_ratio,engine(),
                [&]()->GltfWeightedTarget&{return get_target(mixer);},
                [](const auto& sampler,double time,double arity,bool quaternion,auto& out,double offset){
                    gltf_evaluate_animation_sampler(sampler,time,arity,quaternion,out,offset);
                });
        }
        void accumulate_additive_group(const AnimationGroupReference& reference,const Mixer& mixer) {
            auto& group=clip(mixer);group.weight=weight(reference);
            gltf_accumulate_additive_group(scratch,group,*group.pose,
                [&]()->GltfWeightedTarget&{return get_target(mixer);},
                [](const auto& sampler,double time,double arity,bool quaternion,auto& out,double offset){
                    gltf_evaluate_animation_sampler(sampler,time,arity,quaternion,out,offset);
                });
        }
        void upload_target(GltfWeightedTarget& target) {
            const auto overrides=override_rows(target);target.bone_override_count=static_cast<double>(overrides.size());
            gltf_upload_weighted_target(target,engine(),[&](auto& trs,double count,bool hidden){
                gltf_apply_animation_bone_overrides(overrides,trs,count,hidden);
            },gltf_animation_compose,gltf_animation_multiply,target.runtime->upload_bones);
            target.runtime->publish_pose();
        }
    };
    Transport transport{native_engine,manager.source_engine_present,manager.ordered_groups,scratch,scratch.keys,scratch.targets,{}};
    return gltf_update_weighted_animation_passes(transport,delta_ms);
}
`};
}
