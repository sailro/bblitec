// bblite-tint: one WGSL stage compiled by the pinned Tint for SDL_GPU.
//
// SDL_GPU addresses a stage's resources by dense per-class slots in fixed
// register spaces (descriptor sets for SPIR-V, flat indices for Metal). The
// slots are assigned here to the resources the lowered entry point reaches and
// handed to Tint's HLSL, MSL and SPIR-V writers as their binding options, so
// every artifact is emitted already addressed; the `.slots` sidecar the native
// loader reads is written from the same assignment.
//
// Each register class is compacted across the module's groups into the
// stage's SDL space (vertex: resources 0, uniforms 1; fragment: 2 and 3;
// compute: read-only 0, read-write 1, uniforms 2), in WGSL group and binding
// order. A native stage already declares its groups at those spaces; a pinned
// stage keeps the pin's groups. Within a class, sampled textures precede the
// textures SDL binds as storage textures (integer and multisampled loads),
// which precede read-only storage buffers; read-write textures precede
// read-write buffers.
//
// SDL_GPU compiles each stage alone, and D3D12 links a fragment whose input
// signature is a prefix of its vertex stage's outputs. A native module's
// stages share one interstage structure that both read the position from, and
// `--position-first` places the position ahead of the locations so a fragment
// may read a prefix of them; a pinned fragment that omits the position reads a
// prefix of Tint's own order, which places the position last.
//
// SDL binds a sampled texture with the sampler of its own slot: Metal and
// SPIR-V bind each sampler at the slot of the first texture it samples (for
// SPIR-V, the combined image sampler the texture and the sampler both
// address), and a texture sampled with two samplers is refused there.

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "spirv-tools/libspirv.hpp"
#include "src/tint/api/common/binding_point.h"
#include "src/tint/api/common/bindings.h"
#include "src/tint/api/common/override_id.h"
#include "src/tint/api/common/substitute_overrides_config.h"
#include "src/tint/api/tint.h"
#include "src/tint/cmd/common/helper.h"
#include "src/tint/lang/core/ir/core_builtin_call.h"
#include "src/tint/lang/core/ir/instruction_result.h"
#include "src/tint/lang/core/ir/load.h"
#include "src/tint/lang/core/ir/module.h"
#include "src/tint/lang/core/ir/transform/direct_variable_access.h"
#include "src/tint/lang/core/ir/transform/resource_table_helper.h"
#include "src/tint/lang/core/ir/transform/single_entry_point.h"
#include "src/tint/lang/core/ir/transform/substitute_overrides.h"
#include "src/tint/lang/core/ir/traverse.h"
#include "src/tint/lang/core/ir/var.h"
#include "src/tint/lang/core/type/depth_multisampled_texture.h"
#include "src/tint/lang/core/type/depth_texture.h"
#include "src/tint/lang/core/type/f32.h"
#include "src/tint/lang/core/type/i32.h"
#include "src/tint/lang/core/type/multisampled_texture.h"
#include "src/tint/lang/core/type/sampled_texture.h"
#include "src/tint/lang/core/type/sampler.h"
#include "src/tint/lang/core/type/storage_texture.h"
#include "src/tint/lang/core/type/texture.h"
#include "src/tint/lang/core/type/u32.h"
#include "src/tint/lang/hlsl/writer/writer.h"
#include "src/tint/lang/msl/writer/writer.h"
#include "src/tint/lang/spirv/writer/writer.h"
#include "src/tint/lang/wgsl/ast/function.h"
#include "src/tint/lang/wgsl/ast/identifier.h"
#include "src/tint/lang/wgsl/ast/module.h"
#include "src/tint/lang/wgsl/ast/variable.h"
#include "src/tint/lang/wgsl/inspector/inspector.h"
#include "src/tint/lang/wgsl/reader/reader.h"
#include "src/tint/lang/wgsl/sem/builtin_fn.h"
#include "src/tint/lang/wgsl/sem/call.h"
#include "src/tint/lang/wgsl/sem/function.h"
#include "src/tint/lang/wgsl/sem/variable.h"

namespace {

using tint::BindingPoint;
using Resource = tint::inspector::ResourceBinding;
using ResourceType = Resource::ResourceType;

enum class Stage { kVertex, kFragment, kCompute };

struct Arguments {
    std::string input;
    std::string display_name = "source.wgsl";
    std::string entry_point;
    std::optional<Stage> stage;
    std::vector<std::pair<std::string, double>> overrides;
    std::string hlsl;
    std::string msl;
    std::string spirv;
    std::string spirv_demote;
    std::string slots;
    std::string layout_json;
    bool position_first = false;
    std::string binding_layout_of;
};

[[noreturn]] void Fail(const std::string& message) {
    std::cerr << "bblite-tint: " << message << "\n";
    std::exit(1);
}

Arguments Parse(int argc, const char** argv) {
    Arguments arguments;
    for (int index = 1; index < argc; ++index) {
        const std::string flag = argv[index];
        if (flag.rfind("--", 0) != 0) {
            if (!arguments.input.empty()) {
                Fail("more than one input file");
            }
            arguments.input = flag;
            continue;
        }
        if (flag == "--position-first") {
            arguments.position_first = true;
            continue;
        }
        if (index + 1 >= argc) {
            Fail(flag + " needs a value");
        }
        const std::string value = argv[++index];
        if (flag == "--entry-point") {
            arguments.entry_point = value;
        } else if (flag == "--display-name") {
            arguments.display_name = value;
        } else if (flag == "--stage") {
            if (value == "vertex") {
                arguments.stage = Stage::kVertex;
            } else if (value == "fragment") {
                arguments.stage = Stage::kFragment;
            } else if (value == "compute") {
                arguments.stage = Stage::kCompute;
            } else {
                Fail("unknown stage " + value);
            }
        } else if (flag == "--overrides") {
            std::stringstream list(value);
            std::string entry;
            while (std::getline(list, entry, ',')) {
                const auto equals = entry.find('=');
                if (equals == std::string::npos || equals == 0) {
                    Fail("override '" + entry + "' is not NAME=VALUE");
                }
                const std::string number = entry.substr(equals + 1);
                char* end = nullptr;
                const double parsed = std::strtod(number.c_str(), &end);
                if (number.empty() || end != number.c_str() + number.size()) {
                    Fail("override '" + entry + "' has no numeric value");
                }
                arguments.overrides.emplace_back(entry.substr(0, equals), parsed);
            }
        } else if (flag == "--hlsl") {
            arguments.hlsl = value;
        } else if (flag == "--msl") {
            arguments.msl = value;
        } else if (flag == "--spirv") {
            arguments.spirv = value;
        } else if (flag == "--spirv-demote") {
            arguments.spirv_demote = value;
        } else if (flag == "--slots") {
            arguments.slots = value;
        } else if (flag == "--binding-layout-of") {
            arguments.binding_layout_of = value;
        } else if (flag == "--layout-json") {
            arguments.layout_json = value;
        } else {
            Fail("unknown option " + flag);
        }
    }
    if (arguments.input.empty() || arguments.entry_point.empty() || !arguments.stage) {
        Fail("usage: bblite-tint <input.wgsl> --entry-point <name> --stage <stage> ...");
    }
    return arguments;
}

/// A failure as its own stream form (a string or a diagnostic list). Tint
/// writes failures to the stream types its `IsOStream` names.
template <typename FAILURE> std::string Reason(const FAILURE& failure) {
    std::stringstream text;
    text << failure;
    return text.str();
}

std::string ReadText(const std::string& path) {
    std::ifstream file(path, std::ios::binary);
    if (!file) {
        Fail("cannot read " + path);
    }
    std::stringstream text;
    text << file.rdbuf();
    return text.str();
}

void WriteBytes(const std::string& path, const void* data, std::size_t size) {
    std::ofstream file(path, std::ios::binary);
    if (!file || !file.write(static_cast<const char*>(data), static_cast<std::streamsize>(size))) {
        Fail("cannot write " + path);
    }
}

void WriteText(const std::string& path, const std::string& text) {
    WriteBytes(path, text.data(), text.size());
}

/// The HLSL register class a resource occupies.
char RegisterClass(const Resource& resource) {
    switch (resource.resource_type) {
    case ResourceType::kUniformBuffer:
        return 'b';
    case ResourceType::kSampler:
        return 's';
    case ResourceType::kStorageBuffer:
    case ResourceType::kWriteOnlyStorageTexture:
    case ResourceType::kReadWriteStorageTexture:
        return 'u';
    case ResourceType::kReadOnlyStorageBuffer:
    case ResourceType::kSampledTexture:
    case ResourceType::kMultisampledTexture:
    case ResourceType::kDepthTexture:
    case ResourceType::kDepthMultisampledTexture:
        return 't';
    case ResourceType::kReadOnlyStorageTexture:
        // SDL_GPU's Vulkan backend binds its read-only storage textures as
        // sampled images, which a WGSL storage texture never compiles to.
        Fail("resource '" + resource.variable_name +
             "' is a read-only storage texture, which SDL_GPU binds as a sampled image");
    default:
        Fail("resource '" + resource.variable_name +
             "' is a kind SDL_GPU does not bind (external, texel buffer or input attachment)");
    }
}

/// A texture SDL binds as a storage texture: read with textureLoad, never paired
/// with a sampler (multisampled and integer textures).
bool StorageTexture(const Resource& resource) {
    switch (resource.resource_type) {
    case ResourceType::kMultisampledTexture:
    case ResourceType::kDepthMultisampledTexture:
        return true;
    case ResourceType::kSampledTexture:
        return resource.sampled_kind == Resource::SampledKind::kUInt ||
               resource.sampled_kind == Resource::SampledKind::kSInt;
    default:
        return false;
    }
}

bool WritableTexture(const Resource& resource) {
    return resource.resource_type == ResourceType::kWriteOnlyStorageTexture ||
           resource.resource_type == ResourceType::kReadWriteStorageTexture;
}

/// One reached resource and the slot SDL_GPU binds it at.
struct Slot {
    Resource resource;
    char register_class = 't';
    /// The order within its class: sampled textures, storage textures, storage
    /// buffers (`t`); read-write textures before read-write buffers (`u`).
    int order = 0;
    uint32_t space = 0;
    uint32_t index = 0;
    /// The sidecar kind: b, t, s, i (storage texture), r (read-only buffer),
    /// j (read-write texture), w (read-write buffer).
    char kind = 't';
    uint32_t kind_index = 0;
};

uint32_t StageSpace(Stage stage, char register_class) {
    switch (stage) {
    case Stage::kVertex:
        return register_class == 'b' ? 1u : 0u;
    case Stage::kFragment:
        return register_class == 'b' ? 3u : 2u;
    case Stage::kCompute:
        return register_class == 'b' ? 2u : register_class == 'u' ? 1u : 0u;
    }
    return 0;
}

std::vector<Slot> AssignSlots(const std::vector<Resource>& resources, Stage stage) {
    std::vector<Slot> slots;
    for (const auto& resource : resources) {
        Slot slot;
        slot.resource = resource;
        slot.register_class = RegisterClass(resource);
        if (slot.register_class == 't') {
            slot.order = resource.resource_type == ResourceType::kReadOnlyStorageBuffer ? 2
                         : StorageTexture(resource)                                     ? 1
                                                                                        : 0;
        } else if (slot.register_class == 'u') {
            if (stage != Stage::kCompute) {
                Fail("resource '" + resource.variable_name +
                     "' is writable, and SDL_GPU binds writable resources in compute stages only");
            }
            slot.order = WritableTexture(resource) ? 0 : 1;
        }
        slot.space = StageSpace(stage, slot.register_class);
        slots.push_back(slot);
    }
    // Dense indices per class: order, then the WGSL group and binding the
    // resource was declared at.
    std::stable_sort(slots.begin(), slots.end(), [](const Slot& left, const Slot& right) {
        return std::make_tuple(left.register_class, left.order, left.resource.bind_group,
                               left.resource.binding) <
               std::make_tuple(right.register_class, right.order, right.resource.bind_group,
                               right.resource.binding);
    });
    std::map<char, uint32_t> next;
    for (auto& slot : slots) {
        slot.index = next[slot.register_class]++;
    }
    // The sidecar kinds, indexed within their own kind: storage textures follow
    // the sampled textures and read-only buffers every texture; read-write
    // buffers follow the read-write textures.
    const auto count = [&](char register_class, int order) {
        return static_cast<uint32_t>(
            std::count_if(slots.begin(), slots.end(), [&](const Slot& slot) {
                return slot.register_class == register_class && slot.order == order;
            }));
    };
    const uint32_t sampled = count('t', 0);
    const uint32_t storage_textures = count('t', 1);
    const uint32_t writable_textures = count('u', 0);
    for (auto& slot : slots) {
        switch (slot.register_class) {
        case 'b':
        case 's':
            slot.kind = slot.register_class;
            slot.kind_index = slot.index;
            break;
        case 't':
            slot.kind = slot.order == 0 ? 't' : slot.order == 1 ? 'i' : 'r';
            slot.kind_index = slot.index - (slot.order == 0   ? 0u
                                            : slot.order == 1 ? sampled
                                                              : sampled + storage_textures);
            break;
        default:
            slot.kind = slot.order == 0 ? 'j' : 'w';
            slot.kind_index = slot.index - (slot.order == 0 ? 0u : writable_textures);
            break;
        }
    }
    std::stable_sort(slots.begin(), slots.end(), [](const Slot& left, const Slot& right) {
        return std::make_pair(left.kind, left.kind_index) <
               std::make_pair(right.kind, right.kind_index);
    });
    return slots;
}

const Slot* FindSlot(const std::vector<Slot>& slots, const BindingPoint& point) {
    for (const auto& slot : slots) {
        if (slot.resource.bind_group == point.group && slot.resource.binding == point.binding) {
            return &slot;
        }
    }
    return nullptr;
}

/// A texture a sampling builtin reads with a sampler, by WGSL binding points.
struct SampledPair {
    BindingPoint texture_binding_point;
    BindingPoint sampler_binding_point;
};

/// The sampled texture each sampler is paired with that has the lowest slot:
/// SDL binds a sampler with the texture of the same index, and one WGSL sampler
/// serving several textures needs only that one binding.
std::map<std::pair<uint32_t, uint32_t>, const Slot*>
SamplerTextures(const std::vector<Slot>& slots, const std::vector<SampledPair>& pairs) {
    std::map<std::pair<uint32_t, uint32_t>, const Slot*> paired;
    for (const auto& pair : pairs) {
        const Slot* texture = FindSlot(slots, pair.texture_binding_point);
        const Slot* sampler = FindSlot(slots, pair.sampler_binding_point);
        if (!texture || !sampler || texture->kind != 't' || sampler->kind != 's') {
            continue;
        }
        const auto key =
            std::make_pair(pair.sampler_binding_point.group, pair.sampler_binding_point.binding);
        const auto existing = paired.find(key);
        if (existing == paired.end() || texture->kind_index < existing->second->kind_index) {
            paired[key] = texture;
        }
    }
    return paired;
}

/// The sampler each texture is sampled with. SDL_GPU binds one sampler per
/// texture slot, so a texture sampled with two samplers is refused wherever the
/// pairing is the binding (Metal, SPIR-V and compute).
std::map<std::pair<uint32_t, uint32_t>, BindingPoint>
TextureSamplers(const std::vector<SampledPair>& pairs, const std::string& entry_point) {
    std::map<std::pair<uint32_t, uint32_t>, BindingPoint> samplers;
    for (const auto& pair : pairs) {
        const auto key =
            std::make_pair(pair.texture_binding_point.group, pair.texture_binding_point.binding);
        const auto existing = samplers.find(key);
        if (existing != samplers.end() && existing->second != pair.sampler_binding_point) {
            const auto point = [](const BindingPoint& binding) {
                return "[" + std::to_string(binding.group) + "][" +
                       std::to_string(binding.binding) + "]";
            };
            Fail(entry_point + " samples texture " + point(pair.texture_binding_point) +
                 " with samplers " + point(existing->second) + " and " +
                 point(pair.sampler_binding_point) + "; SDL_GPU binds one sampler per texture.");
        }
        samplers[key] = pair.sampler_binding_point;
    }
    return samplers;
}

tint::Bindings BindingsFor(const std::vector<Slot>& slots,
                           const std::function<std::optional<BindingPoint>(const Slot&)>& target) {
    tint::Bindings bindings;
    for (const auto& slot : slots) {
        const std::optional<BindingPoint> destination = target(slot);
        if (!destination) {
            continue;
        }
        const BindingPoint source{slot.resource.bind_group, slot.resource.binding};
        switch (slot.resource.resource_type) {
        case ResourceType::kUniformBuffer:
            bindings.uniform.emplace(source, *destination);
            break;
        case ResourceType::kStorageBuffer:
        case ResourceType::kReadOnlyStorageBuffer:
            bindings.storage.emplace(source, *destination);
            break;
        case ResourceType::kSampler:
            bindings.sampler.emplace(source, *destination);
            break;
        case ResourceType::kWriteOnlyStorageTexture:
        case ResourceType::kReadWriteStorageTexture:
        case ResourceType::kReadOnlyStorageTexture:
            bindings.storage_texture.emplace(source, *destination);
            break;
        default:
            bindings.texture.emplace(source, *destination);
            break;
        }
    }
    return bindings;
}

/// The module `file` holds, its diagnostics printed as the pinned `tint` prints them
/// (`always`) or only when it is invalid.
tint::Program ParseProgram(const tint::Source::File& file, bool always) {
    tint::wgsl::reader::Options options;
    options.allowed_features = tint::wgsl::AllowedFeatures::Everything();
    tint::Program program = tint::wgsl::reader::Parse(&file, options);
    if (program.Diagnostics().Count() > 0 && (always || !program.IsValid())) {
        tint::cmd::PrintDiagnostics(program.Diagnostics(), tint::cmd::DiagnosticsFormat::kPlain,
                                    nullptr);
    }
    if (!program.IsValid()) {
        std::exit(1);
    }
    return program;
}

tint::core::ir::Module LoweredIr(const tint::Program& program) {
    auto ir = tint::wgsl::reader::ProgramToLoweredIR(program);
    if (ir != tint::Success) {
        Fail("cannot lower the program to IR: " + Reason(ir.Failure()));
    }
    return ir.Move();
}

/// What the entry point reaches once lowered, reduced to the entry point and
/// specialized: the bindings every writer emits, and each sampling call's
/// texture and sampler. Tint's AST reflection also counts references the
/// lowering removes, and pairs a helper's texture and sampler parameters
/// across its call sites.
struct ReachedResources {
    std::set<std::pair<uint32_t, uint32_t>> bindings;
    std::vector<SampledPair> pairs;
};

/// The module variable a texture or sampler operand loads.
BindingPoint HandleBinding(const tint::core::ir::Value* value) {
    if (const auto* result = value->As<tint::core::ir::InstructionResult>()) {
        if (const auto* load = result->Instruction()->As<tint::core::ir::Load>()) {
            if (const auto* from = load->From()->As<tint::core::ir::InstructionResult>()) {
                if (const auto* variable = from->Instruction()->As<tint::core::ir::Var>()) {
                    if (const auto point = variable->BindingPoint()) {
                        return *point;
                    }
                }
            }
        }
    }
    Fail("a texture or sampler operand does not load a bound module variable");
}

ReachedResources Reached(const tint::Program& program, const std::string& entry_point,
                         const tint::SubstituteOverridesConfig& overrides) {
    namespace transform = tint::core::ir::transform;
    auto ir = LoweredIr(program);
    if (auto single = transform::SingleEntryPoint(ir, entry_point); single != tint::Success) {
        Fail("cannot reduce the module to " + entry_point + ": " + Reason(single.Failure()));
    }
    if (auto substituted = transform::SubstituteOverrides(ir, overrides);
        substituted != tint::Success) {
        Fail("cannot substitute overrides: " + Reason(substituted.Failure()));
    }
    ReachedResources reached;
    for (auto* instruction : *ir.root_block) {
        if (auto* variable = instruction->As<tint::core::ir::Var>()) {
            if (const auto point = variable->BindingPoint()) {
                reached.bindings.emplace(point->group, point->binding);
            }
        }
    }
    // Specialize every function taking a texture or sampler to the variables
    // each call passes, so each sampling call names its own pair.
    transform::DirectVariableAccessOptions access;
    access.transform_handle = transform::HandleTransformLevel::kFull;
    if (auto direct = transform::DirectVariableAccess(ir, access); direct != tint::Success) {
        Fail("cannot specialize handle parameters: " + Reason(direct.Failure()));
    }
    for (auto* function : ir.functions) {
        tint::core::ir::Traverse(function->Block(), [&](tint::core::ir::CoreBuiltinCall* call) {
            const tint::core::ir::Value* texture = nullptr;
            const tint::core::ir::Value* sampler = nullptr;
            for (const auto* argument : call->Args()) {
                if (argument->Type()->Is<tint::core::type::Sampler>()) {
                    sampler = argument;
                } else if (argument->Type()->Is<tint::core::type::Texture>()) {
                    texture = argument;
                }
            }
            if (texture && sampler) {
                reached.pairs.push_back({HandleBinding(texture), HandleBinding(sampler)});
            }
        });
    }
    return reached;
}

/// The module-scope textures the module passes to a sampling builtin (one taking a sampler:
/// `textureSample*`, `textureGather*`), followed through its functions' parameters: a texture
/// handed to a function is sampled when the function samples the parameter it arrives as. Every
/// function counts, whether an entry point reaches it or not.
std::set<const tint::sem::Variable*> SampledTextures(const tint::Program& program) {
    const auto& sem = program.Sem();
    std::map<const tint::sem::Function*, std::set<const tint::sem::Variable*>> sampled;
    for (bool changed = true; changed;) {
        changed = false;
        for (const auto* declaration : program.AST().Functions()) {
            const tint::sem::Function* function = sem.Get(declaration);
            auto& handles = sampled[function];
            const auto mark = [&](const tint::sem::ValueExpression* argument) {
                const tint::sem::Variable* root = argument->RootIdentifier();
                if (root && root->IsAnyOf<tint::sem::GlobalVariable, tint::sem::Parameter>() &&
                    handles.insert(root).second) {
                    changed = true;
                }
            };
            for (const tint::sem::Call* call : function->DirectCalls()) {
                const auto& arguments = call->Arguments();
                if (const auto* builtin = call->Target()->As<tint::sem::BuiltinFn>()) {
                    const auto& signature = builtin->Signature();
                    const int texture = signature.IndexOf(tint::core::ParameterUsage::kTexture);
                    if (texture >= 0 &&
                        signature.IndexOf(tint::core::ParameterUsage::kSampler) >= 0) {
                        mark(arguments[static_cast<std::size_t>(texture)]);
                    }
                } else if (const auto* callee = call->Target()->As<tint::sem::Function>()) {
                    const auto& reads = sampled[callee];
                    const auto& parameters = callee->Parameters();
                    for (std::size_t index = 0; index < parameters.Length(); ++index) {
                        if (reads.contains(parameters[index])) {
                            mark(arguments[index]);
                        }
                    }
                }
            }
        }
    }
    std::set<const tint::sem::Variable*> textures;
    for (const auto& [function, handles] : sampled) {
        for (const tint::sem::Variable* handle : handles) {
            if (handle->Is<tint::sem::GlobalVariable>()) {
                textures.insert(handle);
            }
        }
    }
    return textures;
}

std::string ViewDimension(tint::core::type::TextureDimension dimension) {
    using tint::core::type::TextureDimension;
    switch (dimension) {
    case TextureDimension::k1d:
        return "1d";
    case TextureDimension::k2d:
        return "2d";
    case TextureDimension::k2dArray:
        return "2d-array";
    case TextureDimension::k3d:
        return "3d";
    case TextureDimension::kCube:
        return "cube";
    case TextureDimension::kCubeArray:
        return "cube-array";
    default:
        Fail("a texture has no view dimension");
    }
}

/// One declared binding's bind-group layout shape, as its `@binding` line spells it.
std::string LayoutResource(const tint::sem::GlobalVariable* variable, const BindingPoint& point,
                           const std::string& name,
                           const std::set<const tint::sem::Variable*>& sampled) {
    namespace type = tint::core::type;
    const type::Type* store = variable->Type()->UnwrapRef();
    const auto refuse = [&]() -> std::string {
        Fail("binding '" + name + "' (@group(" + std::to_string(point.group) + ") @binding(" +
             std::to_string(point.binding) + ")) declares " + store->FriendlyName() +
             ", which no bind-group layout represents");
    };
    const auto element = [&](const type::Type* type, bool filterable) -> std::string {
        if (type->Is<type::I32>()) {
            return "sint";
        }
        if (type->Is<type::U32>()) {
            return "uint";
        }
        if (type->Is<type::F32>()) {
            return filterable ? "float" : "unfilterable-float";
        }
        return refuse();
    };
    switch (variable->AddressSpace()) {
    case tint::core::AddressSpace::kUniform:
        return "uniform";
    case tint::core::AddressSpace::kStorage:
        return variable->Access() == tint::core::Access::kReadWrite ? "storage read_write"
                                                                    : "storage read";
    default:
        break;
    }
    if (const auto* sampler = store->As<type::Sampler>()) {
        return sampler->IsComparison() ? "sampler comparison" : "sampler filtering";
    }
    if (const auto* texture = store->As<type::StorageTexture>()) {
        const tint::core::Access access = texture->Access();
        const std::string mode = access == tint::core::Access::kWrite  ? "write-only"
                                 : access == tint::core::Access::kRead ? "read-only"
                                                                       : "read-write";
        return "storage-texture " + mode + " " +
               std::string(tint::core::ToString(texture->TexelFormat())) + " " +
               ViewDimension(texture->Dim());
    }
    if (const auto* texture = store->As<type::DepthTexture>()) {
        return "texture depth " + ViewDimension(texture->Dim()) + " single";
    }
    if (const auto* texture = store->As<type::DepthMultisampledTexture>()) {
        return "texture depth " + ViewDimension(texture->Dim()) + " multisampled";
    }
    if (const auto* texture = store->As<type::SampledTexture>()) {
        return "texture " + element(texture->Type(), sampled.contains(variable)) + " " +
               ViewDimension(texture->Dim()) + " single";
    }
    if (const auto* texture = store->As<type::MultisampledTexture>()) {
        return "texture " + element(texture->Type(), false) + " " + ViewDimension(texture->Dim()) +
               " multisampled";
    }
    return refuse();
}

/// The bind-group layout of every binding a module declares, read or not, one
/// `@binding <group> <binding> <name> <resource>` line each in group and binding order. SDL_GPU
/// binds by the compacted slots; WebGPU binds by the module's own group and binding numbers, so
/// the Dawn PAL lays each group out from these lines and serves each binding by the name the
/// module declares it under. The resource is `uniform`, `storage
/// read|read_write`, `sampler filtering|comparison`, `texture <sample type> <view dimension>
/// single|multisampled`, or `storage-texture <access> <format> <view dimension>`; an f32 texture
/// is `float` when the module samples it and `unfilterable-float` otherwise.
std::vector<std::string> LayoutLines(const tint::Program& program) {
    const auto sampled = SampledTextures(program);
    std::vector<std::pair<BindingPoint, std::string>> lines;
    for (const auto* declaration : program.AST().GlobalVariables()) {
        const auto* variable = program.Sem().Get<tint::sem::GlobalVariable>(declaration);
        if (!variable || !variable->Attributes().binding_point) {
            continue;
        }
        const BindingPoint point = *variable->Attributes().binding_point;
        const std::string name = declaration->name->symbol.Name();
        lines.emplace_back(point, "@binding " + std::to_string(point.group) + " " +
                                      std::to_string(point.binding) + " " + name + " " +
                                      LayoutResource(variable, point, name, sampled));
    }
    std::stable_sort(lines.begin(), lines.end(), [](const auto& left, const auto& right) {
        return std::make_pair(left.first.group, left.first.binding) <
               std::make_pair(right.first.group, right.first.binding);
    });
    std::vector<std::string> result;
    for (auto& [point, line] : lines) {
        result.push_back(std::move(line));
    }
    return result;
}

std::string JsonString(const std::string& text) {
    std::string quoted = "\"";
    for (const char character : text) {
        if (character == '"' || character == '\\') {
            quoted += '\\';
        }
        quoted += character;
    }
    return quoted + "\"";
}

} // namespace

int main(int argc, const char** argv) {
    tint::Initialize();
    const Arguments arguments = Parse(argc, argv);

    tint::Source::File file(arguments.display_name, ReadText(arguments.input));
    const tint::Program program = ParseProgram(file, true);

    tint::inspector::Inspector inspector(program);
    // The reflection record: every entry point's bindings, as Tint reports them.
    tint::cmd::PrintInspectorBindings(inspector);

    // Overrides by numeric id or by name, as the pinned `tint --overrides` takes them.
    const auto names = inspector.GetNamedOverrideIds();
    tint::SubstituteOverridesConfig overrides;
    for (const auto& [name, value] : arguments.overrides) {
        if (std::all_of(name.begin(), name.end(), [](char c) { return c >= '0' && c <= '9'; })) {
            const unsigned long id = std::strtoul(name.c_str(), nullptr, 10);
            if (id > 0xffffu) {
                Fail("override id " + name + " is out of range");
            }
            overrides.map.emplace(tint::OverrideId{static_cast<uint16_t>(id)}, value);
            continue;
        }
        const auto id = names.find(name);
        if (id == names.end()) {
            Fail("unknown override '" + name + "'");
        }
        overrides.map.emplace(id->second, value);
    }

    const std::string& entry_point = arguments.entry_point;
    const ReachedResources reached = Reached(program, entry_point, overrides);
    std::vector<Resource> resources = inspector.GetResourceBindings(entry_point);
    if (!inspector.error().empty()) {
        Fail("inspector: " + inspector.error());
    }
    std::erase_if(resources, [&](const Resource& resource) {
        return !reached.bindings.contains({resource.bind_group, resource.binding});
    });
    const std::vector<Slot> slots = AssignSlots(resources, *arguments.stage);
    const std::vector<SampledPair>& pairs = reached.pairs;
    const auto sampler_textures = SamplerTextures(slots, pairs);

    const auto count = [&](char kind) {
        return static_cast<uint32_t>(std::count_if(
            slots.begin(), slots.end(), [&](const Slot& slot) { return slot.kind == kind; }));
    };
    const uint32_t uniforms = count('b');
    const uint32_t readonly_buffers = count('r');
    const uint32_t sampled = count('t');
    const uint32_t readonly_textures = count('i');

    // HLSL: the register each slot compacts to, in its SDL space.
    tint::hlsl::writer::Output hlsl;
    {
        auto ir = LoweredIr(program);
        tint::hlsl::writer::Options options;
        options.entry_point_name = entry_point;
        options.position_first_interstage = arguments.position_first;
        options.extensions.polyfill_dot_4x8_packed = true;
        options.extensions.polyfill_pack_unpack_4x8 = true;
        options.compiler = tint::hlsl::writer::Options::Compiler::kDXC_2021;
        options.bindings = BindingsFor(slots, [](const Slot& slot) -> std::optional<BindingPoint> {
            return BindingPoint{slot.space, slot.index};
        });
        options.resource_table = tint::core::ir::transform::GenerateResourceTableConfig(ir, false);
        options.substitute_overrides_config = overrides;
        auto result = tint::hlsl::writer::Generate(ir, options);
        if (result != tint::Success) {
            Fail("HLSL: " + Reason(result.Failure()));
        }
        hlsl = result.Move();
        if (!arguments.hlsl.empty()) {
            WriteText(arguments.hlsl, hlsl.hlsl);
        }
    }

    // MSL: SDL's flat indices -- uniforms, then read-only and read-write
    // buffers; sampled, storage and writable textures; each sampler at its
    // first texture's index -- and the storage-buffer lengths SDL publishes at
    // buffer(30), one per storage slot.
    if (!arguments.msl.empty()) {
        TextureSamplers(pairs, entry_point);
        auto ir = LoweredIr(program);
        tint::msl::writer::Options options;
        options.entry_point_name = entry_point;
        options.remapped_entry_point_name = "main0";
        options.bindings = BindingsFor(slots, [&](const Slot& slot) -> std::optional<BindingPoint> {
            switch (slot.kind) {
            case 'b':
            case 't':
                return BindingPoint{0, slot.kind_index};
            case 'r':
                return BindingPoint{0, slot.kind_index + uniforms};
            case 'w':
                return BindingPoint{0, slot.kind_index + uniforms + readonly_buffers};
            case 'i':
                return BindingPoint{0, slot.kind_index + sampled};
            case 'j':
                return BindingPoint{0, slot.kind_index + sampled + readonly_textures};
            default: {
                const auto texture =
                    sampler_textures.find({slot.resource.bind_group, slot.resource.binding});
                if (texture == sampler_textures.end()) {
                    Fail("Metal sampler " + slot.resource.variable_name +
                         " has no sampled texture pair");
                }
                return BindingPoint{0, texture->second->kind_index};
            }
            }
        });
        options.immediate_binding_point = BindingPoint{0u, 30u};
        options.array_length_from_constants.ubo_binding = 30u;
        for (const auto& slot : slots) {
            if (slot.kind == 'r' || slot.kind == 'w') {
                options.array_length_from_constants.bindpoint_to_size_index.emplace(
                    BindingPoint{slot.resource.bind_group, slot.resource.binding},
                    slot.kind_index + (slot.kind == 'w' ? readonly_buffers : 0u));
            }
        }
        options.substitute_overrides_config = overrides;
        auto result = tint::msl::writer::Generate(ir, options);
        if (result != tint::Success) {
            Fail("MSL: " + Reason(result.Failure()));
        }
        WriteText(arguments.msl, result->msl);
    }

    // SPIR-V: SDL's descriptor sets, each binding its HLSL register; a sampled
    // texture and its sampler share the binding of the combined image sampler
    // SDL binds there.
    const auto write_spirv = [&](const std::string& path, bool demote) {
        TextureSamplers(pairs, entry_point);
        auto ir = LoweredIr(program);
        tint::spirv::writer::Options options;
        options.entry_point_name = entry_point;
        options.emit_vertex_point_size = false;
        options.extensions.use_demote_to_helper_invocation = demote;
        options.bindings = BindingsFor(slots, [&](const Slot& slot) -> std::optional<BindingPoint> {
            if (slot.kind == 's') {
                const auto texture =
                    sampler_textures.find({slot.resource.bind_group, slot.resource.binding});
                if (texture == sampler_textures.end()) {
                    Fail("SPIR-V sampler " + slot.resource.variable_name +
                         " has no sampled texture pair");
                }
                return BindingPoint{slot.space, texture->second->index};
            }
            return BindingPoint{slot.space, slot.index};
        });
        for (const auto& entry : sampler_textures) {
            const Slot* texture = entry.second;
            options.statically_paired_texture_binding_points.insert(
                BindingPoint{texture->resource.bind_group, texture->resource.binding});
        }
        options.substitute_overrides_config = overrides;
        auto result = tint::spirv::writer::Generate(ir, options);
        if (result != tint::Success) {
            Fail("SPIR-V: " + Reason(result.Failure()));
        }
        spvtools::SpirvTools tools(SPV_ENV_VULKAN_1_1);
        std::string errors;
        tools.SetMessageConsumer([&](spv_message_level_t, const char*,
                                     const spv_position_t& position, const char* message) {
            errors += std::to_string(position.index) + ": " + message + "\n";
        });
        if (!tools.Validate(result->spirv)) {
            Fail("SPIR-V validation failed:\n" + errors);
        }
        WriteBytes(path, result->spirv.data(), result->spirv.size() * sizeof(uint32_t));
    };
    if (!arguments.spirv.empty()) {
        write_spirv(arguments.spirv, false);
    }
    if (!arguments.spirv_demote.empty()) {
        write_spirv(arguments.spirv_demote, true);
    }

    // The slot sidecar: `<kind><index> <name>` per slot; a compute stage leads
    // with its workgroup size and carries each resource's WGSL group and binding
    // with those of its sampler. A render stage's opens with its entry point and
    // closes with the layout lines of the module Dawn compiles: the input, or
    // `--binding-layout-of` when the input is SDL's adaptation of it.
    std::string sidecar;
    if (*arguments.stage == Stage::kCompute) {
        const auto samplers = TextureSamplers(pairs, entry_point);
        sidecar += "@workgroup " + std::to_string(hlsl.workgroup_info.x) + " " +
                   std::to_string(hlsl.workgroup_info.y) + " " +
                   std::to_string(hlsl.workgroup_info.z) + "\n";
        for (const auto& slot : slots) {
            const auto sampler = samplers.find({slot.resource.bind_group, slot.resource.binding});
            sidecar += std::string(1, slot.kind) + std::to_string(slot.kind_index) + " " +
                       slot.resource.variable_name + " " +
                       std::to_string(slot.resource.bind_group) + " " +
                       std::to_string(slot.resource.binding) + " " +
                       (sampler == samplers.end() ? std::string("-1 -1")
                                                  : std::to_string(sampler->second.group) + " " +
                                                        std::to_string(sampler->second.binding)) +
                       "\n";
        }
    } else {
        sidecar += "@entry " + entry_point + "\n";
        for (const auto& slot : slots) {
            sidecar += std::string(1, slot.kind) + std::to_string(slot.kind_index) + " " +
                       slot.resource.variable_name + "\n";
        }
        std::optional<tint::Source::File> layout_file;
        std::optional<tint::Program> layout_program;
        if (!arguments.binding_layout_of.empty()) {
            layout_file.emplace(arguments.display_name, ReadText(arguments.binding_layout_of));
            layout_program.emplace(ParseProgram(*layout_file, false));
        }
        for (const std::string& line : LayoutLines(layout_program ? *layout_program : program)) {
            sidecar += line + "\n";
        }
    }
    if (!arguments.slots.empty()) {
        WriteText(arguments.slots, sidecar);
    }

    // What the offline compiler checks: the stage's uniform blocks in slot
    // order (SDL_GPU caps four) and every binding any entry point reaches.
    if (!arguments.layout_json.empty()) {
        std::string json = "{\"uniformBuffers\":[";
        bool first = true;
        for (const auto& slot : slots) {
            if (slot.kind == 'b') {
                json += std::string(first ? "" : ",") + JsonString(slot.resource.variable_name);
                first = false;
            }
        }
        json += "],\"bindings\":[";
        first = true;
        for (const auto& point : inspector.GetEntryPoints()) {
            for (const auto& resource : inspector.GetResourceBindings(point.name)) {
                json += std::string(first ? "" : ",") +
                        "{\"group\":" + std::to_string(resource.bind_group) +
                        ",\"binding\":" + std::to_string(resource.binding) +
                        ",\"name\":" + JsonString(resource.variable_name) + "}";
                first = false;
            }
        }
        json += "]}";
        WriteText(arguments.layout_json, json);
    }
    return 0;
}
