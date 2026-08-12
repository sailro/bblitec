// Dawn (WebGPU) render backend. Renders through the same pinned Dawn
// commit as the Tint shader compiler so native output shares the
// browser reference's compiler and rasterization stack. Generated
// native WGSL is fed to Dawn directly; there is no offline shader
// compilation in this backend.
//
// Current slice: Standard-material opaque scenes without environment
// features. Unreached paths fail explicitly instead of approximating.

#include <bblite/pal.hpp>
#include <bblite/pal_gpu.hpp>
#include <bblite/runtime.hpp>

#if defined(BBLITE_HAS_DAWN) && BBLITE_HAS_DAWN

#include <bblite/upstream/camera_math.hpp>
#include <bblite/upstream/render_capabilities.hpp>
#include <bblite/upstream/renderer_plan.hpp>

#include "pal_gpu_shared.hpp"

#include <SDL3/SDL.h>
#include <SDL3_image/SDL_image.h>
#include <webgpu/webgpu.h>

#include <algorithm>
#include <array>
#include <cstdlib>
#include <cstring>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl::pal {

namespace {

std::string view_text(WGPUStringView view) {
    if (!view.data) return {};
    return view.length == WGPU_STRLEN
        ? std::string(view.data)
        : std::string(view.data, view.length);
}

WGPUStringView string_view(const char* text) {
    return WGPUStringView{text, WGPU_STRLEN};
}

[[noreturn]] void dawn_error(const std::string& message) {
    throw std::runtime_error("Dawn backend: " + message);
}

struct DawnMeshBindings {
    WGPUBindGroup scene = nullptr;
    WGPUBindGroup textures = nullptr;
    WGPUBindGroup material = nullptr;
};

struct DawnMesh {
    WGPUBuffer vertices = nullptr;
    WGPUBuffer indices = nullptr;
    std::uint32_t index_count = 0;
    WGPUBuffer material_uniforms = nullptr;
    std::uint64_t material_uniform_size = 0;
    std::map<upstream::RenderPipelineKind, DawnMeshBindings> bindings;
};

struct DawnPipeline {
    WGPURenderPipeline pipeline = nullptr;
};

struct DawnState {
    SDL_Window* window = nullptr;
    WGPUInstance instance = nullptr;
    WGPUAdapter adapter = nullptr;
    WGPUDevice device = nullptr;
    WGPUQueue queue = nullptr;
    WGPUSurface surface = nullptr;
    WGPUTextureFormat surface_format = WGPUTextureFormat_BGRA8Unorm;
    WGPUTexture msaa_color = nullptr;
    WGPUTextureView msaa_color_view = nullptr;
    WGPUTexture depth = nullptr;
    WGPUTextureView depth_view = nullptr;
    WGPUShaderModule vertex_module = nullptr;
    WGPUShaderModule standard_module = nullptr;
    WGPUBuffer view_projection = nullptr;
    WGPUTexture white_texture = nullptr;
    WGPUTextureView white_view = nullptr;
    WGPUTexture black_texture = nullptr;
    WGPUTextureView black_view = nullptr;
    WGPUTexture black_cube = nullptr;
    WGPUTextureView black_cube_view = nullptr;
    WGPUSampler default_sampler = nullptr;
    std::map<upstream::RenderPipelineKind, DawnPipeline> pipelines;
    std::vector<DawnMesh> meshes;
    std::string uncaptured_error;

    ~DawnState() {
        for (DawnMesh& mesh : meshes) {
            for (auto& [kind, binding] : mesh.bindings) {
                if (binding.scene) wgpuBindGroupRelease(binding.scene);
                if (binding.textures) {
                    wgpuBindGroupRelease(binding.textures);
                }
                if (binding.material) {
                    wgpuBindGroupRelease(binding.material);
                }
            }
            if (mesh.material_uniforms) {
                wgpuBufferRelease(mesh.material_uniforms);
            }
            if (mesh.vertices) wgpuBufferRelease(mesh.vertices);
            if (mesh.indices) wgpuBufferRelease(mesh.indices);
        }
        for (auto& [kind, pipeline] : pipelines) {
            if (pipeline.pipeline) {
                wgpuRenderPipelineRelease(pipeline.pipeline);
            }
        }
        if (default_sampler) wgpuSamplerRelease(default_sampler);
        if (black_cube_view) wgpuTextureViewRelease(black_cube_view);
        if (black_cube) wgpuTextureRelease(black_cube);
        if (black_view) wgpuTextureViewRelease(black_view);
        if (black_texture) wgpuTextureRelease(black_texture);
        if (white_view) wgpuTextureViewRelease(white_view);
        if (white_texture) wgpuTextureRelease(white_texture);
        if (view_projection) wgpuBufferRelease(view_projection);
        if (standard_module) wgpuShaderModuleRelease(standard_module);
        if (vertex_module) wgpuShaderModuleRelease(vertex_module);
        if (depth_view) wgpuTextureViewRelease(depth_view);
        if (depth) wgpuTextureRelease(depth);
        if (msaa_color_view) wgpuTextureViewRelease(msaa_color_view);
        if (msaa_color) wgpuTextureRelease(msaa_color);
        if (surface) wgpuSurfaceRelease(surface);
        if (queue) wgpuQueueRelease(queue);
        if (device) wgpuDeviceRelease(device);
        if (adapter) wgpuAdapterRelease(adapter);
        if (instance) wgpuInstanceRelease(instance);
        if (window) SDL_DestroyWindow(window);
    }
};

void wait_for(WGPUInstance instance, WGPUFuture future) {
    WGPUFutureWaitInfo wait_info{};
    wait_info.future = future;
    const WGPUWaitStatus status =
        wgpuInstanceWaitAny(instance, 1, &wait_info, UINT64_MAX);
    if (status != WGPUWaitStatus_Success) {
        dawn_error("wgpuInstanceWaitAny failed.");
    }
}

WGPUShaderModule load_wgsl_module(
    DawnState& state,
    const std::string& base_name) {
    const std::string shader_override =
        environment_variable("BBLITE_GPU_SHADER_DIR");
    const std::string shader_root = shader_override.empty()
        ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
        : shader_override;
    const std::vector<std::uint8_t> bytes = read_binary_file(
        join_path(shader_root, base_name + ".native.wgsl"));
    const std::string source(
        reinterpret_cast<const char*>(bytes.data()),
        bytes.size());
    WGPUShaderSourceWGSL wgsl = WGPU_SHADER_SOURCE_WGSL_INIT;
    wgsl.code = WGPUStringView{source.c_str(), source.size()};
    WGPUShaderModuleDescriptor descriptor{};
    descriptor.nextInChain = &wgsl.chain;
    descriptor.label = string_view(base_name.c_str());
    WGPUShaderModule module =
        wgpuDeviceCreateShaderModule(state.device, &descriptor);
    if (!module) {
        dawn_error("wgpuDeviceCreateShaderModule " + base_name);
    }
    return module;
}

WGPUBuffer create_buffer(
    DawnState& state,
    WGPUBufferUsage usage,
    const void* data,
    std::uint64_t size) {
    WGPUBufferDescriptor descriptor = WGPU_BUFFER_DESCRIPTOR_INIT;
    descriptor.usage = usage | WGPUBufferUsage_CopyDst;
    descriptor.size = (size + 3) & ~3ull;
    WGPUBuffer buffer =
        wgpuDeviceCreateBuffer(state.device, &descriptor);
    if (!buffer) dawn_error("wgpuDeviceCreateBuffer");
    if (data) {
        wgpuQueueWriteBuffer(state.queue, buffer, 0, data, size);
    }
    return buffer;
}

WGPUTexture create_solid_texture(
    DawnState& state,
    const std::array<std::uint8_t, 4>& color,
    WGPUTextureFormat format,
    std::uint32_t layers) {
    WGPUTextureDescriptor descriptor = WGPU_TEXTURE_DESCRIPTOR_INIT;
    descriptor.usage =
        WGPUTextureUsage_TextureBinding | WGPUTextureUsage_CopyDst;
    descriptor.size = {1, 1, layers};
    descriptor.format = format;
    WGPUTexture texture =
        wgpuDeviceCreateTexture(state.device, &descriptor);
    if (!texture) dawn_error("wgpuDeviceCreateTexture solid");
    for (std::uint32_t layer = 0; layer < layers; ++layer) {
        WGPUTexelCopyTextureInfo destination =
            WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
        destination.texture = texture;
        destination.origin = {0, 0, layer};
        WGPUTexelCopyBufferLayout layout{};
        layout.offset = 0;
        layout.bytesPerRow = 256;
        layout.rowsPerImage = 1;
        const WGPUExtent3D size{1, 1, 1};
        std::array<std::uint8_t, 256> row{};
        std::memcpy(row.data(), color.data(), color.size());
        wgpuQueueWriteTexture(
            state.queue,
            &destination,
            row.data(),
            row.size(),
            &layout,
            &size);
    }
    return texture;
}

struct PipelineKindTraits {
    bool standard = false;
    bool transparent = false;
    WGPUCullMode cull = WGPUCullMode_Back;
    WGPUFrontFace front = WGPUFrontFace_CCW;
};

PipelineKindTraits pipeline_traits(upstream::RenderPipelineKind kind) {
    using Kind = upstream::RenderPipelineKind;
    switch (kind) {
        case Kind::standard_opaque_back:
            return {true, false, WGPUCullMode_Back, WGPUFrontFace_CCW};
        case Kind::standard_opaque_none:
            return {true, false, WGPUCullMode_None, WGPUFrontFace_CCW};
        default:
            dawn_error(
                "render pipeline kind " +
                std::to_string(static_cast<int>(kind)) +
                " is not implemented yet.");
    }
}

DawnPipeline& pipeline_for(
    DawnState& state,
    upstream::RenderPipelineKind kind) {
    const auto existing = state.pipelines.find(kind);
    if (existing != state.pipelines.end()) return existing->second;
    const PipelineKindTraits traits = pipeline_traits(kind);

    std::array<WGPUVertexAttribute, 8> attributes{};
    const auto attribute = [&](
                               std::uint32_t location,
                               WGPUVertexFormat format,
                               std::uint64_t offset) {
        attributes[location] = WGPUVertexAttribute{};
        attributes[location].format = format;
        attributes[location].offset = offset;
        attributes[location].shaderLocation = location;
    };
    attribute(0, WGPUVertexFormat_Float32x3, 0);
    attribute(1, WGPUVertexFormat_Float32x3, 12);
    attribute(2, WGPUVertexFormat_Float32x4, 24);
    attribute(3, WGPUVertexFormat_Float32x2, 40);
    attribute(4, WGPUVertexFormat_Float32x3, 48);
    attribute(5, WGPUVertexFormat_Float32x2, 60);
    attribute(6, WGPUVertexFormat_Float32x4, 68);
    attribute(7, WGPUVertexFormat_Float32x3, 84);
    WGPUVertexBufferLayout vertex_layout{};
    vertex_layout.stepMode = WGPUVertexStepMode_Vertex;
    vertex_layout.arrayStride = sizeof(GpuVertex);
    vertex_layout.attributeCount = attributes.size();
    vertex_layout.attributes = attributes.data();

    WGPURenderPipelineDescriptor descriptor =
        WGPU_RENDER_PIPELINE_DESCRIPTOR_INIT;
    descriptor.vertex.module = state.vertex_module;
    descriptor.vertex.entryPoint = string_view("mainVertex");
    descriptor.vertex.bufferCount = 1;
    descriptor.vertex.buffers = &vertex_layout;

    descriptor.primitive.topology =
        WGPUPrimitiveTopology_TriangleList;
    descriptor.primitive.frontFace = traits.front;
    descriptor.primitive.cullMode = traits.cull;

    WGPUDepthStencilState depth_stencil =
        WGPU_DEPTH_STENCIL_STATE_INIT;
    depth_stencil.format = WGPUTextureFormat_Depth24PlusStencil8;
    depth_stencil.depthWriteEnabled =
        traits.transparent
            ? WGPUOptionalBool_False
            : WGPUOptionalBool_True;
    depth_stencil.depthCompare = WGPUCompareFunction_Less;
    descriptor.depthStencil = &depth_stencil;

    descriptor.multisample.count = 4;
    descriptor.multisample.mask = ~0u;

    WGPUColorTargetState color_target = WGPU_COLOR_TARGET_STATE_INIT;
    color_target.format = state.surface_format;
    WGPUBlendState blend{};
    if (traits.transparent) {
        blend.color.operation = WGPUBlendOperation_Add;
        blend.color.srcFactor = WGPUBlendFactor_SrcAlpha;
        blend.color.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
        blend.alpha.operation = WGPUBlendOperation_Add;
        blend.alpha.srcFactor = WGPUBlendFactor_One;
        blend.alpha.dstFactor = WGPUBlendFactor_OneMinusSrcAlpha;
        color_target.blend = &blend;
    }
    WGPUFragmentState fragment = WGPU_FRAGMENT_STATE_INIT;
    fragment.module = state.standard_module;
    fragment.entryPoint = string_view("mainFragment");
    fragment.targetCount = 1;
    fragment.targets = &color_target;
    descriptor.fragment = &fragment;

    WGPURenderPipeline pipeline =
        wgpuDeviceCreateRenderPipeline(state.device, &descriptor);
    if (!pipeline) dawn_error("wgpuDeviceCreateRenderPipeline");
    DawnPipeline& slot = state.pipelines[kind];
    slot.pipeline = pipeline;
    return slot;
}

DawnMeshBindings& bindings_for(
    DawnState& state,
    DawnMesh& mesh,
    upstream::RenderPipelineKind kind) {
    const auto existing = mesh.bindings.find(kind);
    if (existing != mesh.bindings.end()) return existing->second;
    DawnPipeline& pipeline = pipeline_for(state, kind);
    DawnMeshBindings bindings;

    WGPUBindGroupLayout scene_layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline.pipeline, 1);
    WGPUBindGroupEntry scene_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    scene_entry.binding = 0;
    scene_entry.buffer = state.view_projection;
    scene_entry.size = 64;
    WGPUBindGroupDescriptor scene_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    scene_descriptor.layout = scene_layout;
    scene_descriptor.entryCount = 1;
    scene_descriptor.entries = &scene_entry;
    bindings.scene =
        wgpuDeviceCreateBindGroup(state.device, &scene_descriptor);
    wgpuBindGroupLayoutRelease(scene_layout);

    // Standard fragment texture pairs mirror the SDL_GPU slot order:
    // base color, metallic-roughness, normal, emissive, reflection
    // cube, standard emissive.
    const std::array<WGPUTextureView, 6> views{
        state.white_view,
        state.white_view,
        state.white_view,
        state.white_view,
        state.black_cube_view,
        state.black_view,
    };
    std::array<WGPUBindGroupEntry, 12> texture_entries{};
    for (std::uint32_t slot = 0; slot < views.size(); ++slot) {
        texture_entries[slot * 2] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[slot * 2].binding = slot * 2;
        texture_entries[slot * 2].textureView = views[slot];
        texture_entries[slot * 2 + 1] = WGPU_BIND_GROUP_ENTRY_INIT;
        texture_entries[slot * 2 + 1].binding = slot * 2 + 1;
        texture_entries[slot * 2 + 1].sampler = state.default_sampler;
    }
    WGPUBindGroupLayout texture_layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline.pipeline, 2);
    WGPUBindGroupDescriptor texture_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    texture_descriptor.layout = texture_layout;
    texture_descriptor.entryCount = texture_entries.size();
    texture_descriptor.entries = texture_entries.data();
    bindings.textures =
        wgpuDeviceCreateBindGroup(state.device, &texture_descriptor);
    wgpuBindGroupLayoutRelease(texture_layout);

    WGPUBindGroupLayout material_layout =
        wgpuRenderPipelineGetBindGroupLayout(pipeline.pipeline, 3);
    WGPUBindGroupEntry material_entry = WGPU_BIND_GROUP_ENTRY_INIT;
    material_entry.binding = 0;
    material_entry.buffer = mesh.material_uniforms;
    material_entry.size = mesh.material_uniform_size;
    WGPUBindGroupDescriptor material_descriptor =
        WGPU_BIND_GROUP_DESCRIPTOR_INIT;
    material_descriptor.layout = material_layout;
    material_descriptor.entryCount = 1;
    material_descriptor.entries = &material_entry;
    bindings.material =
        wgpuDeviceCreateBindGroup(state.device, &material_descriptor);
    wgpuBindGroupLayoutRelease(material_layout);

    return mesh.bindings.emplace(kind, bindings).first->second;
}

void save_capture_png(
    const std::vector<std::uint8_t>& pixels,
    std::uint32_t width,
    std::uint32_t height,
    std::uint32_t bytes_per_row,
    bool bgra,
    const std::string& path) {
    SDL_Surface* surface = SDL_CreateSurface(
        static_cast<int>(width),
        static_cast<int>(height),
        bgra ? SDL_PIXELFORMAT_ARGB8888 : SDL_PIXELFORMAT_ABGR8888);
    if (!surface) {
        dawn_error(std::string("SDL_CreateSurface: ") + SDL_GetError());
    }
    for (std::uint32_t row = 0; row < height; ++row) {
        std::memcpy(
            static_cast<std::uint8_t*>(surface->pixels) +
                static_cast<std::size_t>(row) * surface->pitch,
            pixels.data() +
                static_cast<std::size_t>(row) * bytes_per_row,
            static_cast<std::size_t>(width) * 4);
    }
    const bool saved = IMG_SavePNG(surface, path.c_str());
    SDL_DestroySurface(surface);
    if (!saved) {
        dawn_error(std::string("IMG_SavePNG: ") + SDL_GetError());
    }
}

} // namespace

bool run_dawn_engine(Engine& engine) {
#if BBLITE_GPU_DEFORMATION || BBLITE_GPU_INSTANCING || BBLITE_GPU_MORPH_STORAGE
    dawn_error(
        "GPU deformation, instancing, and storage morphing are not "
        "implemented yet.");
#else
    if (engine.registered_scenes.empty() || !engine.registered_scenes.front()) {
        throw std::runtime_error("Dawn renderer requires a registered scene.");
    }
    Scene& scene = *engine.registered_scenes.front();
    if (scene.transmission_enabled) {
        dawn_error("transmission is not implemented yet.");
    }
    if (!scene.tasks.empty()) {
        dawn_error("frame-graph tasks are not implemented yet.");
    }
    const std::string animation_seek =
        environment_variable("BBLITE_ANIMATION_SEEK_SECONDS");
    if (!animation_seek.empty()) {
        const float time = std::strtof(animation_seek.c_str(), nullptr);
        for (const auto& seek : scene.animation_seekers) {
            seek(time);
        }
    }
    const std::string background_flag =
        environment_variable("BBLITE_BACKGROUND");
    const bool background_enabled =
        background_flag == "1" ||
        background_flag == "true" ||
        (background_flag.empty() &&
         scene.environment.background_enabled_by_default);
    if (background_enabled && scene.environment.has_skybox) {
        dawn_error("skyboxes are not implemented yet.");
    }
    if (
        scene.environment.has_ground &&
        environment_variable("BBLITE_GROUND") != "0") {
        dawn_error("environment grounds are not implemented yet.");
    }
    if (!SDL_Init(SDL_INIT_VIDEO | SDL_INIT_EVENTS)) {
        dawn_error(std::string("SDL_Init: ") + SDL_GetError());
    }

    DawnState state;
    const bool hidden_test_pass =
        environment_variable("BBLITE_TEST_PASS") == "1";
    state.window = SDL_CreateWindow(
        engine.options.title.c_str(),
        engine.options.width,
        engine.options.height,
        hidden_test_pass
            ? SDL_WINDOW_RESIZABLE | SDL_WINDOW_NOT_FOCUSABLE
            : SDL_WINDOW_RESIZABLE);
    if (!state.window) {
        dawn_error(std::string("SDL_CreateWindow: ") + SDL_GetError());
    }

    static const WGPUInstanceFeatureName instance_features[] = {
        WGPUInstanceFeatureName_TimedWaitAny,
    };
    WGPUInstanceDescriptor instance_descriptor =
        WGPU_INSTANCE_DESCRIPTOR_INIT;
    instance_descriptor.requiredFeatureCount = 1;
    instance_descriptor.requiredFeatures = instance_features;
    state.instance = wgpuCreateInstance(&instance_descriptor);
    if (!state.instance) dawn_error("wgpuCreateInstance failed.");

    void* hwnd = SDL_GetPointerProperty(
        SDL_GetWindowProperties(state.window),
        SDL_PROP_WINDOW_WIN32_HWND_POINTER,
        nullptr);
    void* hinstance = SDL_GetPointerProperty(
        SDL_GetWindowProperties(state.window),
        SDL_PROP_WINDOW_WIN32_INSTANCE_POINTER,
        nullptr);
    if (!hwnd) dawn_error("SDL window exposes no Win32 HWND.");
    WGPUSurfaceSourceWindowsHWND surface_source =
        WGPU_SURFACE_SOURCE_WINDOWS_HWND_INIT;
    surface_source.hinstance = hinstance;
    surface_source.hwnd = hwnd;
    WGPUSurfaceDescriptor surface_descriptor{};
    surface_descriptor.nextInChain = &surface_source.chain;
    state.surface =
        wgpuInstanceCreateSurface(state.instance, &surface_descriptor);
    if (!state.surface) dawn_error("wgpuInstanceCreateSurface failed.");

    WGPURequestAdapterOptions adapter_options =
        WGPU_REQUEST_ADAPTER_OPTIONS_INIT;
    adapter_options.powerPreference = WGPUPowerPreference_HighPerformance;
    adapter_options.backendType = WGPUBackendType_D3D12;
    adapter_options.compatibleSurface = state.surface;
    WGPURequestAdapterCallbackInfo adapter_callback =
        WGPU_REQUEST_ADAPTER_CALLBACK_INFO_INIT;
    adapter_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    adapter_callback.callback = [](
                                    WGPURequestAdapterStatus status,
                                    WGPUAdapter adapter,
                                    WGPUStringView message,
                                    void* userdata1,
                                    void*) {
        auto* dawn_state = static_cast<DawnState*>(userdata1);
        if (status == WGPURequestAdapterStatus_Success) {
            dawn_state->adapter = adapter;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    adapter_callback.userdata1 = &state;
    wait_for(
        state.instance,
        wgpuInstanceRequestAdapter(
            state.instance,
            &adapter_options,
            adapter_callback));
    if (!state.adapter) {
        dawn_error("no D3D12 adapter: " + state.uncaptured_error);
    }

    WGPUDeviceDescriptor device_descriptor = WGPU_DEVICE_DESCRIPTOR_INIT;
    device_descriptor.uncapturedErrorCallbackInfo.callback =
        [](
            WGPUDevice const*,
            WGPUErrorType,
            WGPUStringView message,
            void* userdata1,
            void*) {
            auto* error = static_cast<std::string*>(userdata1);
            if (error->empty()) *error = view_text(message);
        };
    device_descriptor.uncapturedErrorCallbackInfo.userdata1 =
        &state.uncaptured_error;
    WGPURequestDeviceCallbackInfo device_callback =
        WGPU_REQUEST_DEVICE_CALLBACK_INFO_INIT;
    device_callback.mode = WGPUCallbackMode_WaitAnyOnly;
    device_callback.callback = [](
                                   WGPURequestDeviceStatus status,
                                   WGPUDevice device,
                                   WGPUStringView message,
                                   void* userdata1,
                                   void*) {
        auto* dawn_state = static_cast<DawnState*>(userdata1);
        if (status == WGPURequestDeviceStatus_Success) {
            dawn_state->device = device;
        } else {
            dawn_state->uncaptured_error = view_text(message);
        }
    };
    device_callback.userdata1 = &state;
    wait_for(
        state.instance,
        wgpuAdapterRequestDevice(
            state.adapter,
            &device_descriptor,
            device_callback));
    if (!state.device) {
        dawn_error("device creation failed: " + state.uncaptured_error);
    }
    state.queue = wgpuDeviceGetQueue(state.device);

    const std::uint32_t width =
        static_cast<std::uint32_t>(engine.options.width);
    const std::uint32_t height =
        static_cast<std::uint32_t>(engine.options.height);
    WGPUSurfaceConfiguration surface_configuration =
        WGPU_SURFACE_CONFIGURATION_INIT;
    surface_configuration.device = state.device;
    surface_configuration.format = state.surface_format;
    surface_configuration.usage =
        WGPUTextureUsage_RenderAttachment | WGPUTextureUsage_CopySrc;
    surface_configuration.width = width;
    surface_configuration.height = height;
    surface_configuration.presentMode = WGPUPresentMode_Immediate;
    wgpuSurfaceConfigure(state.surface, &surface_configuration);

    // Shared frame targets: 4x MSAA color resolving into the surface
    // texture, and the browser's depth24plus-stencil8 depth buffer.
    {
        WGPUTextureDescriptor color_descriptor =
            WGPU_TEXTURE_DESCRIPTOR_INIT;
        color_descriptor.usage = WGPUTextureUsage_RenderAttachment;
        color_descriptor.size = {width, height, 1};
        color_descriptor.format = state.surface_format;
        color_descriptor.sampleCount = 4;
        state.msaa_color =
            wgpuDeviceCreateTexture(state.device, &color_descriptor);
        state.msaa_color_view =
            wgpuTextureCreateView(state.msaa_color, nullptr);
        WGPUTextureDescriptor depth_descriptor =
            WGPU_TEXTURE_DESCRIPTOR_INIT;
        depth_descriptor.usage = WGPUTextureUsage_RenderAttachment;
        depth_descriptor.size = {width, height, 1};
        depth_descriptor.format =
            WGPUTextureFormat_Depth24PlusStencil8;
        depth_descriptor.sampleCount = 4;
        state.depth =
            wgpuDeviceCreateTexture(state.device, &depth_descriptor);
        state.depth_view = wgpuTextureCreateView(state.depth, nullptr);
    }

    state.vertex_module = load_wgsl_module(state, "pbr.vert");
    state.standard_module = load_wgsl_module(state, "standard.frag");

    state.view_projection = create_buffer(
        state,
        WGPUBufferUsage_Uniform,
        nullptr,
        64);
    state.white_texture = create_solid_texture(
        state,
        {255, 255, 255, 255},
        WGPUTextureFormat_RGBA8Unorm,
        1);
    state.white_view =
        wgpuTextureCreateView(state.white_texture, nullptr);
    state.black_texture = create_solid_texture(
        state,
        {0, 0, 0, 255},
        WGPUTextureFormat_RGBA8Unorm,
        1);
    state.black_view =
        wgpuTextureCreateView(state.black_texture, nullptr);
    state.black_cube = create_solid_texture(
        state,
        {0, 0, 0, 255},
        WGPUTextureFormat_RGBA8Unorm,
        6);
    {
        WGPUTextureViewDescriptor cube_descriptor =
            WGPU_TEXTURE_VIEW_DESCRIPTOR_INIT;
        cube_descriptor.dimension = WGPUTextureViewDimension_Cube;
        cube_descriptor.arrayLayerCount = 6;
        state.black_cube_view =
            wgpuTextureCreateView(state.black_cube, &cube_descriptor);
    }
    {
        WGPUSamplerDescriptor sampler_descriptor =
            WGPU_SAMPLER_DESCRIPTOR_INIT;
        sampler_descriptor.addressModeU = WGPUAddressMode_Repeat;
        sampler_descriptor.addressModeV = WGPUAddressMode_Repeat;
        sampler_descriptor.addressModeW = WGPUAddressMode_Repeat;
        sampler_descriptor.magFilter = WGPUFilterMode_Linear;
        sampler_descriptor.minFilter = WGPUFilterMode_Linear;
        sampler_descriptor.mipmapFilter = WGPUMipmapFilterMode_Linear;
        state.default_sampler =
            wgpuDeviceCreateSampler(state.device, &sampler_descriptor);
    }

    upstream::RenderPlan render_plan =
        upstream::build_render_plan(scene, engine);
    for (const upstream::RenderItem& item : render_plan.items) {
        if (
            item.material_kind !=
            upstream::RenderMaterialKind::standard) {
            dawn_error("only Standard materials are implemented yet.");
        }
        const ModelGeometry& geometry = engine.geometries[item.geometry];
        const MeshRecord& mesh_record = engine.meshes[item.mesh.value];
        const std::vector<GpuVertex> vertices =
            transformed_vertices(geometry, mesh_record);
        DawnMesh mesh;
        mesh.vertices = create_buffer(
            state,
            WGPUBufferUsage_Vertex,
            vertices.data(),
            vertices.size() * sizeof(GpuVertex));
        mesh.indices = create_buffer(
            state,
            WGPUBufferUsage_Index,
            geometry.indices.data(),
            geometry.indices.size() * sizeof(std::uint32_t));
        mesh.index_count =
            static_cast<std::uint32_t>(geometry.indices.size());
        mesh.material_uniform_size =
            (sizeof(upstream::StandardUniforms) + 15) & ~15ull;
        mesh.material_uniforms = create_buffer(
            state,
            WGPUBufferUsage_Uniform,
            nullptr,
            mesh.material_uniform_size);
        state.meshes.push_back(std::move(mesh));
    }

    CameraRecord fallback_camera;
    CameraRecord& camera =
        scene.camera.value < engine.cameras.size()
            ? engine.cameras[scene.camera.value]
            : fallback_camera;

    const std::string screenshot_path =
        environment_variable("BBLITE_SCREENSHOT");
    const long screenshot_frame = [&] {
        const std::string value =
            environment_variable("BBLITE_SCREENSHOT_FRAME");
        return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
    }();
    const long limit = [&] {
        const std::string value = environment_variable("BBLITE_MAX_FRAMES");
        return value.empty() ? 0L : std::strtol(value.c_str(), nullptr, 10);
    }();

    bool screenshot_saved = false;
    bool running = true;
    long frame = 0;
    constexpr long capture_grace_frames = 8;
    while (running &&
           (limit <= 0 || frame < limit ||
            (!screenshot_path.empty() && !screenshot_saved &&
             frame < limit + capture_grace_frames))) {
        SDL_Event event;
        while (SDL_PollEvent(&event)) {
            if (event.type == SDL_EVENT_QUIT) running = false;
        }
        const float delta_ms =
            scene.fixed_delta_ms > 0.0f ? scene.fixed_delta_ms : 16.0f;
        for (const auto& callback : scene.before_render) {
            callback(delta_ms);
        }
        upstream::sort_transparent_draws(
            render_plan.draw_lists.transparent,
            engine,
            camera);

        const std::array<float, 16> matrix =
            upstream::build_view_projection(
                camera,
                static_cast<float>(width) / height);
        wgpuQueueWriteBuffer(
            state.queue,
            state.view_projection,
            0,
            matrix.data(),
            sizeof(matrix));
        for (
            const upstream::RenderDrawCommand& draw :
            render_plan.draw_lists.opaque.commands) {
            const upstream::StandardUniforms fragment =
                upstream::build_standard_uniforms(
                    scene,
                    engine,
                    camera,
                    draw.item);
            wgpuQueueWriteBuffer(
                state.queue,
                state.meshes[draw.item_index].material_uniforms,
                0,
                &fragment,
                sizeof(fragment));
        }
        if (!render_plan.draw_lists.transparent.commands.empty()) {
            dawn_error("transparent draws are not implemented yet.");
        }

        WGPUSurfaceTexture surface_texture = WGPU_SURFACE_TEXTURE_INIT;
        wgpuSurfaceGetCurrentTexture(state.surface, &surface_texture);
        if (
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessOptimal &&
            surface_texture.status !=
                WGPUSurfaceGetCurrentTextureStatus_SuccessSuboptimal) {
            dawn_error("wgpuSurfaceGetCurrentTexture failed.");
        }
        WGPUTextureView surface_view =
            wgpuTextureCreateView(surface_texture.texture, nullptr);

        WGPUCommandEncoder encoder =
            wgpuDeviceCreateCommandEncoder(state.device, nullptr);
        WGPURenderPassColorAttachment color_attachment =
            WGPU_RENDER_PASS_COLOR_ATTACHMENT_INIT;
        color_attachment.view = state.msaa_color_view;
        color_attachment.resolveTarget = surface_view;
        color_attachment.loadOp = WGPULoadOp_Clear;
        color_attachment.storeOp = WGPUStoreOp_Discard;
        color_attachment.clearValue = WGPUColor{
            scene.clear_color.r,
            scene.clear_color.g,
            scene.clear_color.b,
            scene.clear_color.a,
        };
        WGPURenderPassDepthStencilAttachment depth_attachment{};
        depth_attachment.view = state.depth_view;
        depth_attachment.depthLoadOp = WGPULoadOp_Clear;
        depth_attachment.depthStoreOp = WGPUStoreOp_Discard;
        depth_attachment.depthClearValue = 1.0f;
        depth_attachment.stencilLoadOp = WGPULoadOp_Clear;
        depth_attachment.stencilStoreOp = WGPUStoreOp_Discard;
        WGPURenderPassDescriptor pass_descriptor =
            WGPU_RENDER_PASS_DESCRIPTOR_INIT;
        pass_descriptor.colorAttachmentCount = 1;
        pass_descriptor.colorAttachments = &color_attachment;
        pass_descriptor.depthStencilAttachment = &depth_attachment;
        WGPURenderPassEncoder pass =
            wgpuCommandEncoderBeginRenderPass(encoder, &pass_descriptor);
        WGPURenderPipeline bound_pipeline = nullptr;
        for (
            const upstream::RenderDrawCommand& draw :
            render_plan.draw_lists.opaque.commands) {
            DawnMesh& mesh = state.meshes[draw.item_index];
            DawnPipeline& pipeline = pipeline_for(state, draw.pipeline);
            DawnMeshBindings& bindings =
                bindings_for(state, mesh, draw.pipeline);
            if (pipeline.pipeline != bound_pipeline) {
                wgpuRenderPassEncoderSetPipeline(pass, pipeline.pipeline);
                bound_pipeline = pipeline.pipeline;
            }
            wgpuRenderPassEncoderSetBindGroup(
                pass, 1, bindings.scene, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 2, bindings.textures, 0, nullptr);
            wgpuRenderPassEncoderSetBindGroup(
                pass, 3, bindings.material, 0, nullptr);
            wgpuRenderPassEncoderSetVertexBuffer(
                pass, 0, mesh.vertices, 0, WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderSetIndexBuffer(
                pass,
                mesh.indices,
                WGPUIndexFormat_Uint32,
                0,
                WGPU_WHOLE_SIZE);
            wgpuRenderPassEncoderDrawIndexed(
                pass, mesh.index_count, 1, 0, 0, 0);
        }
        wgpuRenderPassEncoderEnd(pass);
        wgpuRenderPassEncoderRelease(pass);

        const bool capture_frame =
            frame >= screenshot_frame &&
            !screenshot_saved &&
            !screenshot_path.empty();
        WGPUBuffer readback = nullptr;
        const std::uint32_t bytes_per_row = (width * 4 + 255) & ~255u;
        if (capture_frame) {
            WGPUBufferDescriptor readback_descriptor =
                WGPU_BUFFER_DESCRIPTOR_INIT;
            readback_descriptor.usage =
                WGPUBufferUsage_CopyDst | WGPUBufferUsage_MapRead;
            readback_descriptor.size =
                static_cast<std::uint64_t>(bytes_per_row) * height;
            readback =
                wgpuDeviceCreateBuffer(state.device, &readback_descriptor);
            WGPUTexelCopyTextureInfo copy_source =
                WGPU_TEXEL_COPY_TEXTURE_INFO_INIT;
            copy_source.texture = surface_texture.texture;
            WGPUTexelCopyBufferInfo copy_destination =
                WGPU_TEXEL_COPY_BUFFER_INFO_INIT;
            copy_destination.layout.bytesPerRow = bytes_per_row;
            copy_destination.layout.rowsPerImage = height;
            copy_destination.buffer = readback;
            const WGPUExtent3D copy_size{width, height, 1};
            wgpuCommandEncoderCopyTextureToBuffer(
                encoder,
                &copy_source,
                &copy_destination,
                &copy_size);
        }

        WGPUCommandBuffer command =
            wgpuCommandEncoderFinish(encoder, nullptr);
        wgpuQueueSubmit(state.queue, 1, &command);
        wgpuCommandBufferRelease(command);
        wgpuCommandEncoderRelease(encoder);

        if (capture_frame) {
            WGPUBufferMapCallbackInfo map_callback =
                WGPU_BUFFER_MAP_CALLBACK_INFO_INIT;
            map_callback.mode = WGPUCallbackMode_WaitAnyOnly;
            map_callback.callback = [](
                                        WGPUMapAsyncStatus status,
                                        WGPUStringView message,
                                        void* userdata1,
                                        void*) {
                if (status != WGPUMapAsyncStatus_Success) {
                    auto* error = static_cast<std::string*>(userdata1);
                    if (error->empty()) *error = view_text(message);
                }
            };
            map_callback.userdata1 = &state.uncaptured_error;
            wait_for(
                state.instance,
                wgpuBufferMapAsync(
                    readback,
                    WGPUMapMode_Read,
                    0,
                    static_cast<std::size_t>(bytes_per_row) * height,
                    map_callback));
            const void* mapped = wgpuBufferGetConstMappedRange(
                readback,
                0,
                static_cast<std::size_t>(bytes_per_row) * height);
            if (!mapped) dawn_error("buffer map returned no data.");
            std::vector<std::uint8_t> pixels(
                static_cast<const std::uint8_t*>(mapped),
                static_cast<const std::uint8_t*>(mapped) +
                    static_cast<std::size_t>(bytes_per_row) * height);
            wgpuBufferUnmap(readback);
            save_capture_png(
                pixels,
                width,
                height,
                bytes_per_row,
                state.surface_format == WGPUTextureFormat_BGRA8Unorm,
                screenshot_path);
            screenshot_saved = true;
        }
        if (readback) wgpuBufferRelease(readback);

        wgpuSurfacePresent(state.surface);
        wgpuTextureViewRelease(surface_view);
        wgpuTextureRelease(surface_texture.texture);
        wgpuInstanceProcessEvents(state.instance);
        if (!state.uncaptured_error.empty()) {
            dawn_error("uncaptured error: " + state.uncaptured_error);
        }
        ++frame;
    }
    SDL_DestroyWindow(state.window);
    state.window = nullptr;
    return true;
#endif
}

} // namespace bbl::pal

#endif
