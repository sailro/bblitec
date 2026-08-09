import { LoweredSource, LoweringContext } from "./context.js";

export class GeometryOutputLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerTaskRecords(): LoweredSource {
        const geometryModule = "src/frame-graph/geometry-renderer-task.ts";
        const copyModule = "src/frame-graph/copy-to-texture-task.ts";
        const actionsModule = "src/frame-graph/frame-graph-actions.ts";
        const renderModule = "src/frame-graph/render-task.ts";
        const rttModule = "src/texture/rtt.ts";
        const geometry = this.context.store.getSource(geometryModule);
        const copy = this.context.store.getSource(copyModule);
        const actions = this.context.store.getSource(actionsModule);
        const render = this.context.store.getSource(renderModule);
        const rtt = this.context.store.getSource(rttModule);
        for (const marker of [
            "textureDescriptions.length > 8",
            "targetTextureClearColor",
            "geometryLinearVelocityTexture",
        ]) {
            if (!geometry.includes(marker)) {
                throw new Error(`Pinned geometry renderer contract changed: ${marker}.`);
            }
        }
        for (const marker of ["resolveTexture", "viewport", "sourceTexture"]) {
            if (!copy.includes(marker)) {
                throw new Error(`Pinned copy task contract changed: ${marker}.`);
            }
        }
        if (!actions.includes("fg._tasks.splice(firstUserTask, 0, task)")) {
            throw new Error("Pinned addTaskAtStart ordering changed.");
        }
        for (const marker of [
            "const material = opts?.material ?? mesh.material",
            "const camera = task._config.cam ?? sc.camera",
            "task._config.cs ? eng.canvas.width / eng.canvas.height",
        ]) {
            if (!render.includes(marker)) {
                throw new Error(`Pinned render task contract changed: ${marker}.`);
            }
        }
        for (const marker of [
            'aspect: "depth-only"',
            '_sampleType: "depth"',
            "getNearestSampler(engine)",
        ]) {
            if (!rtt.includes(marker)) {
                throw new Error(`Pinned render-target texture contract changed: ${marker}.`);
            }
        }

        return {
            modulePath: geometryModule,
            symbolName:
                "createGeometryRendererTask,createRenderTarget,createRenderTargetTexture,createRenderTask,createCopyToTextureTask,addTask,addTaskAtStart,RenderTask.addMesh",
            header: "",
            source: `// ${this.context.provenance(
                geometryModule,
                "createGeometryRendererTask",
                `${renderModule}#createRenderTask,RenderTask.addMesh, ${rttModule}#createRenderTargetTexture, ${copyModule}#createCopyToTextureTask, and ${actionsModule}#addTask,addTaskAtStart`,
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <stdexcept>
#include <utility>

namespace bbl {

namespace {

FrameTaskRecord& task_record(Engine& engine, TaskHandle handle) {
    if (handle.value >= engine.frame_tasks.size()) {
        throw std::runtime_error("Invalid frame task handle.");
    }
    return engine.frame_tasks[handle.value];
}

TaskHandle append_task(Engine& engine, FrameTaskRecord task) {
    engine.frame_tasks.push_back(std::move(task));
    return TaskHandle{
        static_cast<std::uint32_t>(engine.frame_tasks.size() - 1)};
}

} // namespace

RenderTargetHandle create_render_target(
    Engine& engine,
    RenderTargetOptions options) {
    if (!options.has_color && !options.has_depth) {
        throw std::runtime_error(
            "Render target requires a color or depth attachment.");
    }
    if ((options.width == 0) != (options.height == 0)) {
        throw std::runtime_error(
            "Render target fixed dimensions must both be non-zero.");
    }
    engine.render_targets.push_back(RenderTargetRecord{
        options.samples == 4 ? 4u : 1u,
        options.has_color,
        options.has_depth,
        options.sampled_depth,
        false,
        options.width,
        options.height,
    });
    return RenderTargetHandle{
        static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
}

RenderTargetTexture create_render_target_texture(
    Engine& engine,
    RenderTargetOptions options) {
    if (options.width == 0 || options.height == 0) {
        throw std::runtime_error(
            "Render target textures require fixed dimensions.");
    }
    if (!options.has_color && options.has_depth) {
        options.sampled_depth = true;
    }
    const RenderTargetHandle target =
        create_render_target(engine, options);
    return RenderTargetTexture{
        target,
        render_target_texture(target),
    };
}

RenderTargetHandle swapchain_render_target(Engine& engine) {
    if (engine.swapchain_target.value == invalid_handle) {
        RenderTargetRecord target;
        target.samples = 1u;
        target.has_color = true;
        target.swapchain = true;
        engine.render_targets.push_back(target);
        engine.swapchain_target = RenderTargetHandle{
            static_cast<std::uint32_t>(engine.render_targets.size() - 1)};
    }
    return engine.swapchain_target;
}

TaskHandle create_render_task(
    Engine& engine,
    Scene&,
    RenderTaskOptions options) {
    if (options.target.value >= engine.render_targets.size()) {
        throw std::runtime_error("Render task target is invalid.");
    }
    FrameTaskRecord task;
    task.kind = FrameTaskKind::render;
    task.render = std::move(options);
    return append_task(engine, std::move(task));
}

TaskHandle create_geometry_renderer_task(
    Engine& engine,
    Scene&,
    GeometryTaskOptions options) {
    if (options.attachments.empty() || options.attachments.size() > 8) {
        throw std::runtime_error(
            "Geometry task requires between one and eight attachments.");
    }
    for (std::size_t index = 0; index < options.attachments.size(); ++index) {
        if (std::find_if(
                options.attachments.begin(),
                options.attachments.begin() +
                    static_cast<std::ptrdiff_t>(index),
                [&](const GeometryTextureDescription& description) {
                    return description.type == options.attachments[index].type;
                }) != options.attachments.begin() +
                    static_cast<std::ptrdiff_t>(index)) {
            throw std::runtime_error(
                "Geometry task attachment types must be unique.");
        }
    }
    if (
        options.target.value != invalid_handle &&
        options.target.value >= engine.render_targets.size()) {
        throw std::runtime_error("Geometry task target is invalid.");
    }
    FrameTaskRecord task;
    task.kind = FrameTaskKind::geometry;
    task.geometry = std::move(options);
    return append_task(engine, std::move(task));
}

TaskHandle create_copy_to_texture_task(
    Engine& engine,
    Scene&,
    CopyTaskOptions options) {
    if (
        options.target.value == invalid_handle &&
        options.resolve_target.value == invalid_handle) {
        throw std::runtime_error(
            "Copy task requires a target or resolve target.");
    }
    FrameTaskRecord task;
    task.kind = FrameTaskKind::copy;
    task.copy = std::move(options);
    return append_task(engine, std::move(task));
}

RenderTextureRef render_target_texture(RenderTargetHandle target) {
    RenderTextureRef result;
    result.source = RenderTextureSource::render_target;
    result.target = target;
    return result;
}

RenderTextureRef geometry_task_texture(
    TaskHandle task,
    GeometryTextureType type) {
    RenderTextureRef result;
    result.source = RenderTextureSource::geometry;
    result.task = task;
    result.geometry_type = type;
    return result;
}

RenderTextureRef geometry_task_output_texture(TaskHandle task) {
    RenderTextureRef result;
    result.source = RenderTextureSource::geometry_output;
    result.task = task;
    return result;
}

void add_task(Scene& scene, TaskHandle task) {
    if (!scene.engine) {
        throw std::runtime_error("Scene is not associated with an engine.");
    }
    task_record(*scene.engine, task);
    scene.tasks.push_back(task);
}

void add_task_at_start(Scene& scene, TaskHandle task) {
    if (!scene.engine) {
        throw std::runtime_error("Scene is not associated with an engine.");
    }
    task_record(*scene.engine, task);
    scene.tasks.insert(scene.tasks.begin(), task);
}

void add_render_task_mesh(
    Engine& engine,
    TaskHandle task,
    MeshHandle mesh,
    MaterialHandle material) {
    FrameTaskRecord& record = task_record(engine, task);
    if (record.kind != FrameTaskKind::render) {
        throw std::runtime_error("addMesh requires a render task.");
    }
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Render task mesh is invalid.");
    }
    if (material.value >= engine.materials.size()) {
        throw std::runtime_error("Render task material override is invalid.");
    }
    record.render_meshes.push_back(RenderTaskMesh{mesh, material});
}

} // namespace bbl
`,
        };
    }
}
