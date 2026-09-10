import type {GltfLoaderOptions} from "./loader.js";

/** Native record and Float32 buffer transport around the source animation bodies. */
export function gltfAnimationRuntimeTypesCpp(options: GltfLoaderOptions): string {
    return `
struct GltfAnimationMask {
    std::vector<std::string> names;
    double mode=0;
    bool disabled=false;
};
struct AnimationClip {
    std::string name;
    double time=0,duration=0,frame_rate=0,speed_ratio=0,weight=0;
    bool playing=false,stopped=false,loop=false,additive=false;
    double additive_reference_time=0;
    GltfAnimationControllerPlayback controller;
    std::shared_ptr<GltfAnimationPoseState> pose;
    std::shared_ptr<GltfAnimationMask> mask;
${options.animationMask ? "    GltfAnimationControllerMaskCache<GltfAnimationMask> mask_cache;" : ""}
    std::vector<std::optional<std::string>> target_names;
};
struct GltfAnimationPointerRuntime;
struct AnimationRuntime {
    GltfAnimationObjectRows<GltfAnimationPoseSkeleton> source_skeletons;
    GltfAnimationObjectRows<GltfAnimationPoseMorph> source_morphs;
    std::vector<GltfAnimationPoseNode> source_nodes;
    std::shared_ptr<GltfAnimationPointerRuntime> pointers;
    bool paused=false;
    std::size_t asset_index=0;
    std::vector<std::optional<std::string>> node_names;
    std::vector<AnimationClip> clips;
    std::vector<AnimatedNode> nodes;
    std::vector<SkinRuntime> skins;
    std::vector<AnimatedMeshBinding> meshes;
${options.animationPointer ? "    std::vector<AnimatedLightBinding> light_nodes;" : ""}
${options.gltfCameras ? "    std::vector<AnimatedCameraBinding> camera_nodes;" : ""}
    std::function<void(std::size_t,double,bool)> evaluate_pose;
    std::function<void(std::size_t,double,bool)> tick_group;
    std::function<void(GltfAnimationPoseSkeleton&,const GltfAnimationFloats&,double)> upload_bones;
    std::function<void()> publish_pose;
};
struct GltfAnimationOverrideRows {
    const std::vector<BoneOverride>* values=nullptr;
    struct Iterator {
        const std::vector<BoneOverride>* values;std::size_t index;
        void advance(){while(values&&index<values->size()&&values->at(index).mask==0)++index;}
        auto operator*()const{return std::pair<std::size_t,const BoneOverride&>{index,values->at(index)};}
        Iterator& operator++(){++index;advance();return *this;}
        bool operator!=(const Iterator& other)const{return index!=other.index;}
    };
    auto begin()const{Iterator it{values,0};it.advance();return it;}
    auto end()const{return Iterator{values,values?values->size():0};}
    std::size_t size()const{return values?static_cast<std::size_t>(std::count_if(values->begin(),values->end(),[](const auto& value){return value.mask!=0;})):0;}
};
GltfAnimationOverrideRows gltf_animation_override_rows(const Engine& engine,std::size_t asset_index){
    return {asset_index<engine.assets.size()?&engine.assets[asset_index].bone_overrides:nullptr};
}
`;
}

export function gltfAnimationMatrixTransportCpp(): string {
    return `
void gltf_animation_compose(GltfAnimationFloats& out,double offset,
    double tx,double ty,double tz,double rx,double ry,double rz,double rw,double sx,double sy,double sz) {
    const auto matrix=trs_matrix({tx,ty,tz},{rx,ry,rz,rw},{sx,sy,sz});
    std::copy(matrix.begin(),matrix.end(),out.begin()+static_cast<std::size_t>(offset));
}
void gltf_animation_multiply(GltfAnimationFloats& out,double offset,
    const GltfAnimationFloats& left,double left_offset,const GltfAnimationFloats& right,double right_offset) {
    Matrix matrix{};
    upstream::mat4_multiply_into(matrix,0,left,static_cast<std::int64_t>(left_offset),right,static_cast<std::int64_t>(right_offset));
    std::copy(matrix.begin(),matrix.end(),out.begin()+static_cast<std::size_t>(offset));
}
Matrix gltf_animation_matrix(const GltfAnimationFloats& values,std::size_t index) {
    Matrix result{};
    for(std::size_t lane=0;lane<result.size();++lane)result[lane]=values.at(index*16+lane);
    return result;
}
`;
}

export function gltfAnimationPoseTransportCpp(options: GltfLoaderOptions, cameraRefresh: string): string {
    return `
        const auto refresh_live_worlds=[animation_runtime=animation_runtime.get()${cameraRefresh || options.animationPointer ? ",&engine" : ""}]() {
            for(auto& node:animation_runtime->nodes){node.computed=false;node.computing=false;}
            std::function<const Matrix&(std::size_t)> compute_animated_world=[&](std::size_t index)->const Matrix& {
                auto& node=animation_runtime->nodes.at(index);
                if(node.computed)return node.world;
                if(node.computing)throw std::runtime_error("glTF animated node hierarchy contains a cycle.");
                node.computing=true;
                const auto local=node.has_matrix?node.matrix:trs_matrix(node.translation,node.rotation,node.scale);
                node.world=node.parent<0?local:upstream::matrix_product(compute_animated_world(static_cast<std::size_t>(node.parent)),local);
                node.computing=false;node.computed=true;
                return node.world;
            };
            for(std::size_t index=0;index<animation_runtime->nodes.size();++index)compute_animated_world(index);
${options.animationPointer ? `            for(const auto& binding:animation_runtime->light_nodes) {
                auto& light=engine.lights.at(binding.light.value);
                const auto& world=compute_animated_world(binding.node);
                light.position={-world[12],world[13],world[14]};
                light.direction=normalize({world[8],-world[9],-world[10]});
            }` : ""}
${cameraRefresh}
        };
        const auto publish_mesh=[animation_runtime=animation_runtime.get(),&engine](std::size_t index) {
            const auto& binding=animation_runtime->meshes.at(index);
            auto& mesh=engine.meshes.at(binding.mesh);
${options.vat ? `            if(mesh.has_vat)return;` : ""}
            auto& geometry=engine.geometries.at(binding.geometry);
            const auto& world=animation_runtime->nodes.at(binding.node).world;
            publish_gltf_deformation(mesh,geometry,world,binding.initial_joint_matrices,
                binding.skin<animation_runtime->skins.size(),binding.morph_default_weights);
        };
        animation_runtime->publish_pose=[animation_runtime=animation_runtime.get(),refresh_live_worlds,publish_mesh]() {
            refresh_live_worlds();
            for(std::size_t index=0;index<animation_runtime->meshes.size();++index)publish_mesh(index);
        };
        animation_runtime->upload_bones=[animation_runtime=animation_runtime.get()](GltfAnimationPoseSkeleton& skeleton,
            const GltfAnimationFloats& values,double) {
            for(const auto index:skeleton.meshes) {
                auto& binding=animation_runtime->meshes.at(index);
                auto& matrices=binding.initial_joint_matrices;
                matrices.resize(static_cast<std::size_t>(skeleton.boneCount));
                for(std::size_t bone=0;bone<matrices.size();++bone)
                    matrices[bone]=upstream::matrix_product(binding.initial_mesh_world,gltf_animation_matrix(values,bone));
            }
        };
        animation_runtime->evaluate_pose=[animation_runtime=animation_runtime.get(),&engine]
            (std::size_t clip_index,double time,bool upload_gpu) {
            auto& pose=*animation_runtime->clips.at(clip_index).pose;
            bool wrote_live_node=false;
            const auto overrides=gltf_animation_override_rows(engine,animation_runtime->asset_index);
            pose.has_bone_overrides=${options.boneControl === true};
            pose.bone_override_count=static_cast<double>(overrides.size());
            auto apply_overrides=[&](auto& trs,double count,bool hidden_only) {
                gltf_apply_animation_bone_overrides(overrides,trs,count,hidden_only);
            };
            const auto write_translation=[&](std::size_t target,double x,double y,double z){
                wrote_live_node=true;
                auto& node=animation_runtime->nodes.at(target);node.translation={x,y,z};
            };
            const auto write_rotation=[&](std::size_t target,double x,double y,double z,double w){
                wrote_live_node=true;
                auto& node=animation_runtime->nodes.at(target);node.rotation={x,y,z,w};
            };
            const auto write_scale=[&](std::size_t target,double x,double y,double z){
                wrote_live_node=true;
                auto& node=animation_runtime->nodes.at(target);node.scale={x,y,z};
            };
            gltf_evaluate_animation_pose(pose,time,upload_gpu,
                [](const auto& sampler,double t,double arity,bool quaternion,auto& output,double offset){
                    gltf_evaluate_animation_sampler(sampler,t,arity,quaternion,output,offset);
                },gltf_animation_compose,gltf_animation_multiply,
                [&](double node)->GltfAnimationObjectRows<GltfAnimationPoseMorph>* {
                    const auto index=static_cast<std::size_t>(node);
                    if(index>=pose.morphs_by_node.size()||!pose.morphs_by_node[index])return nullptr;
                    return &*pose.morphs_by_node[index];
                },apply_overrides,
                [](const auto& channel,const auto& values,double offset){channel.pointer_writer(values,offset);},
                write_translation,write_rotation,write_scale,
                [&](auto& morph,const auto& values,double count){
                    for(const auto index:morph.meshes) {
                        auto& binding=animation_runtime->meshes.at(index);
                        binding.morph_default_weights.assign(values.begin(),values.begin()+static_cast<std::size_t>(count));
                    }
                },animation_runtime->upload_bones);
            if(upload_gpu||wrote_live_node)animation_runtime->publish_pose();
        };
`;
}

/** Hydrate source-created identities once, then expose native ABI entry points. */
export function gltfAnimationLoadingCpp(options: GltfLoaderOptions, rootFlip: string): string {
    const syncMask=options.animationMask ? "gltf_sync_animation_mask(clip,animation_runtime->node_names);" : "";
    return `
        animation_runtime->asset_index=engine.assets.size();
        asset.source_animation=std::make_shared<GltfAnimationRuntimeState>(GltfAnimationRuntimeState{animation_runtime});
        const auto read_animation_floats=[&](std::size_t index) {
            const auto& accessor=accessors.at(index);
            if(accessor.component_type!=5126)throw std::runtime_error("Invalid source animation Float32 storage.");
            GltfAnimationFloats result;
            const auto components=component_count(accessor.type);
            result.reserve(accessor.count*components);
            for(std::size_t element=0;element<accessor.count;++element)
                for(std::size_t component=0;component<components;++component)
                    result.push_back(static_cast<float>(read_accessor_component(buffer,container,views,accessor,element,component,false)));
            return result;
        };
        const auto animation_bindings=read_gltf_animation_bindings(required(mesh_plan,"animationBindings"),
            planned_meshes.size(),node_json.size(),[&](std::size_t index,std::size_t count) {
                const auto values=read_animation_floats(index);
                if(values.size()!=count*16)throw std::runtime_error("Invalid source animation matrix storage.");
                std::vector<Matrix> matrices;
                for(std::size_t matrix=0;matrix<count;++matrix)matrices.push_back(gltf_animation_matrix(values,matrix));
                return matrices;
            });
        for(std::size_t index=0;index<animation_bindings.skeletons.size();++index) {
            const auto& source=animation_bindings.skeletons[index];
            auto skeleton=std::make_shared<GltfAnimationPoseSkeleton>();
${options.boneControl ? "            skeleton->override_asset=animation_runtime->asset_index;" : ""}
            skeleton->boneCount=static_cast<double>(source.joints.size());
            for(const auto node:source.joints)skeleton->jointNodes.push_back(static_cast<double>(node));
            skeleton->invMeshWorld.assign(source.inv_mesh_world.begin(),source.inv_mesh_world.end());
            for(const auto& matrix:source.inverse_bind_matrices)
                skeleton->inverseBindMatrices.insert(skeleton->inverseBindMatrices.end(),matrix.begin(),matrix.end());
            for(const auto mesh:source.meshes) {
                const auto target=animation_mesh_indices.at(mesh);
                auto& binding=animation_runtime->meshes.at(target);
                binding.skeleton_binding=index;
                skeleton->meshes.push_back(target);
            }
            if(source.meshes.empty())throw std::runtime_error("Source animation skeleton has no native resource.");
            const auto& skin=required(planned_meshes.at(source.meshes.front()).as_object(),"skin").as_object();
            *skeleton->boneMatrices=read_animation_floats(unsigned_value(required(skin,"matrices")));
            if(skeleton->boneMatrices->size()!=source.joints.size()*16)
                throw std::runtime_error("Source animation bone storage differs from its resource.");
            animation_runtime->source_skeletons.entries.push_back(std::move(skeleton));
        }
        for(const auto& source:animation_bindings.morphs) {
            auto morph=std::make_shared<GltfAnimationPoseMorph>();
            morph->targetCount=static_cast<double>(source.count);
            for(const auto mesh:source.meshes) {
                const auto target=animation_mesh_indices.at(mesh);
                auto& binding=animation_runtime->meshes.at(target);
                binding.morph_node=source.node;
                if(binding.morph_default_weights.size()!=source.count)
                    throw std::runtime_error("Source animation morph storage differs from its resource.");
                if(morph->meshes.empty())morph->weights=binding.morph_default_weights;
                morph->meshes.push_back(target);
            }
            animation_runtime->source_morphs.entries.push_back(std::move(morph));
        }
        for(const auto& value:required(source_animation.as_object(),"nodeNames").as_array())
            animation_runtime->node_names.push_back(value.is_null()?std::nullopt:std::optional<std::string>{value.as_string()});
        for(const auto& value:required(source_animation.as_object(),"clips").as_array()) {
            const auto& source=value.as_object();
            const auto index=animation_runtime->clips.size();
            AnimationClip clip;
            const auto* frame_rate=optional(source,"frameRate");
            gltf_initialize_animation_group(clip,required(source,"name").as_string(),required(source,"duration").as_number(),
                frame_rate?frame_rate->as_number():std::numeric_limits<double>::quiet_NaN(),static_cast<double>(index));
            clip.pose=read_gltf_animation_pose(source,animation_runtime->source_nodes,animation_runtime->source_skeletons,
                animation_runtime->source_morphs,read_animation_floats,
                ${options.animationPointer ? "[&](const ts::JsonValue& writer){return gltf_bind_animation_pointer(animation_runtime->pointers,writer);}" : "[](const ts::JsonValue&)->js::Callback<void(const GltfAnimationFloats&,double)>{throw std::runtime_error(\"Animation pointer feature is absent.\");}"},${rootFlip});
            clip.pose->mask_resolver=${options.animationMask === true};
            for(const auto& targeted:required(source,"targetedAnimations").as_array()) {
                const auto* name=optional(targeted.as_object(),"targetName");
                clip.target_names.push_back(name?std::optional<std::string>{name->as_string()}:std::nullopt);
            }
            engine.animation_groups.push_back(AnimationGroupRecord{clip.name,static_cast<std::uint32_t>(engine.assets.size()),index,static_cast<float>(clip.weight),{}});
            asset.animation_groups.push_back(AnimationGroupHandle{static_cast<std::uint32_t>(engine.animation_groups.size()-1)});
            animation_runtime->clips.push_back(std::move(clip));
        }
        animation_runtime->tick_group=[animation_runtime=animation_runtime.get()](std::size_t index,double delta_ms,bool with_engine) {
            auto& clip=animation_runtime->clips.at(index);
            gltf_tick_animation_core(clip,delta_ms,clip.speed_ratio,with_engine,clip.pose->requires_engine,true,
                [&](){${syncMask}},
                [&](double time,bool active_engine){animation_runtime->evaluate_pose(index,time,active_engine);});
        };
        asset.animation_tick_group=[animation_runtime](std::size_t index,double delta_ms,bool with_engine){animation_runtime->tick_group(index,delta_ms,with_engine);};
        asset.set_clip_playing=[animation_runtime](std::size_t index,bool value){animation_runtime->clips.at(index).playing=value;};
        asset.set_clip_stopped=[animation_runtime](std::size_t index,bool value){animation_runtime->clips.at(index).stopped=value;};
        asset.set_clip_time=[animation_runtime](std::size_t index,float value){animation_runtime->clips.at(index).time=value;};
        asset.set_clip_loop=[animation_runtime](std::size_t index,bool value){animation_runtime->clips.at(index).loop=value;};
        asset.set_clip_speed_ratio=[animation_runtime](std::size_t index,float value){animation_runtime->clips.at(index).speed_ratio=value;};
        asset.apply_clip_pose=[animation_runtime](std::size_t index,bool with_engine) {
            auto& clip=animation_runtime->clips.at(index);
            gltf_animation_go_to_frame(clip,clip.time*clip.frame_rate,clip.frame_rate,clip.speed_ratio,with_engine,
                clip.pose->requires_engine,true,[&](){${syncMask}},
                [&](double time,bool active_engine){animation_runtime->evaluate_pose(index,time,active_engine);});
        };
        asset.animation_seek=[animation_runtime](float time) {
            animation_runtime->paused=true;
            for(std::size_t index=0;index<animation_runtime->clips.size();++index) {
                auto& clip=animation_runtime->clips[index];
                if(clip.stopped||!clip.playing)continue;
                clip.time=time;clip.playing=false;
                animation_runtime->tick_group(index,0,true);
            }
        };
        asset.animation_tick=[animation_runtime,&engine](float delta_ms) {
            if(animation_runtime->paused)return;
            const auto& groups=engine.assets.at(animation_runtime->asset_index).animation_groups;
            for(std::size_t index=0;index<animation_runtime->clips.size();++index) {
                auto& clip=animation_runtime->clips[index];
                const auto manager_owned=!engine.animation_groups.at(groups.at(index).value).animation_owner.expired();
                gltf_tick_animation(clip,delta_ms,clip.speed_ratio,manager_owned,true,clip.pose->requires_engine,true,
                    [&](){${syncMask}},
                    [&](double time,bool active_engine){animation_runtime->evaluate_pose(index,time,active_engine);});
            }
        };
${options.vat ? `        asset.clip_duration=[animation_runtime](std::size_t index){return static_cast<float>(animation_runtime->clips.at(index).duration);};
        const auto skeleton_binding=[animation_runtime,&engine](MeshHandle mesh)->std::pair<GltfAnimationPoseSkeleton*,AnimatedMeshBinding*> {
            if(mesh.value>=engine.meshes.size()||engine.meshes[mesh.value].has_vat)return {};
            for(const auto& skeleton:animation_runtime->source_skeletons.entries)
                for(const auto index:skeleton->meshes) {
                    auto& binding=animation_runtime->meshes.at(index);
                    if(binding.mesh==mesh.value)return {skeleton.get(),&binding};
                }
            return {};
        };
        asset.animation_has_skeleton=[skeleton_binding](MeshHandle mesh){return skeleton_binding(mesh).first!=nullptr;};
        asset.animation_bone_palette=[skeleton_binding](MeshHandle mesh) {
            const auto [skeleton,binding]=skeleton_binding(mesh);
            if(!skeleton)throw std::runtime_error("VAT source skeleton binding is absent.");
            std::vector<Matrix> result;
            result.reserve(static_cast<std::size_t>(skeleton->boneCount));
            for(std::size_t bone=0;bone<static_cast<std::size_t>(skeleton->boneCount);++bone)
                result.push_back(native_matrix(upstream::matrix_product(binding->initial_mesh_world,gltf_animation_matrix(*skeleton->boneMatrices,bone))));
            return result;
        };
        asset.animation_cpu_go_to_frame=[animation_runtime](std::size_t index,double frame) {
            auto& clip=animation_runtime->clips.at(index);
            gltf_vat_go_to_frame(clip,frame,[&](){${syncMask}},[&](double delta) {
                gltf_tick_animation_controller(clip,clip.controller,delta,false,clip.pose->requires_engine,false,
                    [&](double time,bool){animation_runtime->evaluate_pose(index,time,false);});
            });
        };` : ""}
${options.animationMask ? `        asset.set_clip_mask=[animation_runtime](std::size_t index,const std::vector<std::string>& names,bool include) {
            animation_runtime->clips.at(index).mask=gltf_make_animation_mask<GltfAnimationMask>(names,include);
        };` : ""}
${options.animationAdditive ? `        asset.set_clip_additive=[animation_runtime](std::size_t index,float reference_time) {
            auto& clip=animation_runtime->clips.at(index);clip.additive=true;clip.additive_reference_time=reference_time;
        };` : ""}
        asset.clone_mesh_animation=[animation_runtime,&engine](MeshHandle source,MeshHandle clone) {
            const auto found=std::find_if(animation_runtime->meshes.begin(),animation_runtime->meshes.end(),
                [&](const auto& binding){return binding.mesh==source.value;});
            if(found==animation_runtime->meshes.end())return;
            if(found->skin==std::numeric_limits<std::size_t>::max()) {
                if(!engine.geometries.at(found->geometry).morph_positions.empty())
                    throw std::runtime_error("Cloning an animated morph hierarchy requires shared morph weights with an independent node world.");
                return;
            }
            const auto source_index=static_cast<std::size_t>(found-animation_runtime->meshes.begin());
            auto binding=*found;binding.mesh=clone.value;
            const auto index=animation_runtime->meshes.size();
            animation_runtime->meshes.push_back(binding);
            if(binding.skeleton_binding<animation_runtime->source_skeletons.size())
                animation_runtime->source_skeletons.at(binding.skeleton_binding).meshes.push_back(index);
            for(const auto& morph:animation_runtime->source_morphs.entries)
                if(std::find(morph->meshes.begin(),morph->meshes.end(),source_index)!=morph->meshes.end())
                    morph->meshes.push_back(index);
        };
`;
}
