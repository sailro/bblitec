/** Native storage for source-created controllers and aliased deformation resources. */
export function gltfAnimationPoseStorageCpp(): string {
    return `
using GltfAnimationFloats = std::vector<float>;
template<class T> struct GltfAnimationObjectRows {
    std::vector<std::shared_ptr<T>> entries;
    std::size_t size() const { return entries.size(); }
    T& at(std::size_t index) const { return *entries.at(index); }
};
struct GltfAnimationPoseNode {
    double tx=0,ty=0,tz=0,rx=0,ry=0,rz=0,rw=1,sx=1,sy=1,sz=1,parentIdx=-1;
    std::optional<GltfAnimationFloats> matrix;
};
struct GltfAnimationPoseSampler {
    GltfAnimationFloats input,output;
    double interpolation=0;
};
struct GltfAnimationPoseChannel {
    double nodeIdx=-1,samplerIdx=0,path=0,pointerArity=0;
    bool pointerQuaternion=false;
    js::Callback<void(const GltfAnimationFloats&,double)> pointer_writer;
};
struct GltfAnimationPoseSkeleton {
    std::vector<std::size_t> meshes;
    std::vector<double> jointNodes;
    GltfAnimationFloats invMeshWorld,inverseBindMatrices;
    std::shared_ptr<GltfAnimationFloats> boneMatrices=std::make_shared<GltfAnimationFloats>();
    double boneCount=0;
    bool disposed=false;
    std::optional<std::size_t> override_asset;
};
struct GltfAnimationPoseMorph {
    std::vector<std::size_t> meshes;
    GltfAnimationFloats weights;
    double targetCount=0;
    bool disposed=false;
};
struct GltfAnimationPoseBinding { std::size_t target=0; double off=0,mask=0; };
struct GltfAnimationPoseState {
    std::vector<GltfAnimationPoseNode> nodes;
    std::vector<GltfAnimationPoseSampler> samplers;
    std::vector<GltfAnimationPoseChannel> channels;
    std::vector<GltfAnimationPoseBinding> node_trs_bindings;
    std::vector<double> topo_order;
    GltfAnimationObjectRows<GltfAnimationPoseSkeleton> skeletons;
    GltfAnimationObjectRows<GltfAnimationFloats> bone_scratch;
    std::vector<std::optional<GltfAnimationObjectRows<GltfAnimationPoseMorph>>> morphs_by_node;
    GltfAnimationFloats currentTRS,localMat,worldMat,_boneTmp=GltfAnimationFloats(16);
    GltfAnimationFloats RH_TO_LH;
    std::shared_ptr<GltfAnimationFloats> pointerScratch,morphUploadF32;
    std::vector<std::uint8_t> masked_nodes;
    bool mask_active=false,mask_resolver=false,has_bone_overrides=false,requires_engine=false;
    double bone_override_count=0;
};
template<class ReadFloats,class BindPointer>
std::shared_ptr<GltfAnimationPoseState> read_gltf_animation_pose(const JsonObject& clip,
    const std::vector<GltfAnimationPoseNode>& nodes,
    const GltfAnimationObjectRows<GltfAnimationPoseSkeleton>& skeletons,
    const GltfAnimationObjectRows<GltfAnimationPoseMorph>& morphs,
    ReadFloats read_floats,BindPointer bind_pointer,const GltfAnimationFloats& root_flip) {
    auto result=std::make_shared<GltfAnimationPoseState>();
    result->nodes=nodes;
    result->RH_TO_LH=root_flip;
    for(const auto& value:required(clip,"samplers").as_array()) {
        const auto& sampler=value.as_object();
        result->samplers.push_back({read_floats(unsigned_value(required(sampler,"input"))),
            read_floats(unsigned_value(required(sampler,"output"))),required(sampler,"interpolation").as_number()});
    }
    for(const auto& value:required(clip,"channels").as_array()) {
        const auto& channel=value.as_object();
        GltfAnimationPoseChannel target;
        target.nodeIdx=required(channel,"nodeIdx").as_number();
        target.samplerIdx=required(channel,"samplerIdx").as_number();
        target.path=required(channel,"path").as_number();
        if(unsigned_value(required(channel,"samplerIdx"))>=result->samplers.size())
            throw std::runtime_error("Invalid source animation sampler identity.");
        if(const auto* arity=optional(channel,"pointerArity"))target.pointerArity=arity->as_number();
        if(const auto* quaternion=optional(channel,"pointerQuaternion"))target.pointerQuaternion=quaternion->as_boolean();
        if(const auto* writer=optional(channel,"writer"))target.pointer_writer=bind_pointer(*writer);
        result->channels.push_back(std::move(target));
    }
    const auto& controller=required(clip,"controller").as_object();
    result->requires_engine=required(controller,"requiresEngine").as_boolean();
    for(const auto& index:required(controller,"clipSkeletons").as_array()) {
        const auto& skeleton=skeletons.entries.at(unsigned_value(index));
        result->skeletons.entries.push_back(skeleton);
        result->bone_scratch.entries.push_back(skeleton->boneMatrices);
    }
    for(const auto& value:required(controller,"nodeTrsBindings").as_array()) {
        const auto& binding=value.as_object();
        const auto target=unsigned_value(required(binding,"target"));
        if(target>=nodes.size())throw std::runtime_error("Invalid source animation node target.");
        result->node_trs_bindings.push_back({target,required(binding,"off").as_number(),required(binding,"mask").as_number()});
    }
    for(const auto& value:required(controller,"topoOrder").as_array())result->topo_order.push_back(value.as_number());
    for(const auto& value:required(controller,"morphBindingsByNode").as_array()) {
        if(value.is_null()){result->morphs_by_node.emplace_back();continue;}
        GltfAnimationObjectRows<GltfAnimationPoseMorph> bindings;
        for(const auto& index:value.as_array())bindings.entries.push_back(morphs.entries.at(unsigned_value(index)));
        result->morphs_by_node.emplace_back(std::move(bindings));
    }
    const auto& scratch=required(controller,"scratch").as_object();
    result->currentTRS.resize(unsigned_value(required(scratch,"trs")));
    result->localMat.resize(unsigned_value(required(scratch,"localMat")));
    result->worldMat.resize(unsigned_value(required(scratch,"worldMat")));
    result->pointerScratch=std::make_shared<GltfAnimationFloats>(unsigned_value(required(scratch,"pointer")));
    result->morphUploadF32=result->pointerScratch;
    result->masked_nodes.resize(nodes.size());
    return result;
}
`;
}
