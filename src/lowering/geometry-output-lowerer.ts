import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";

export class GeometryOutputLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerTaskRecords(): LoweredSource {
        const geometryModule = "src/frame-graph/geometry-renderer-task.ts";
        const copyModule = "src/frame-graph/copy-to-texture-task.ts";
        const actionsModule = "src/frame-graph/frame-graph-actions.ts";
        const renderModule = "src/frame-graph/render-task.ts";
        const rttModule = "src/texture/rtt.ts";
        const geometryFile =
            this.context.sourceFile(geometryModule);
        const { declaration: createGeometryTask } =
            this.context.functionDeclaration(
                geometryModule,
                "createGeometryRendererTask",
            );
        if (
            !this.context.hasNode(
                createGeometryTask,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.GreaterThanToken &&
                    ts.isNumericLiteral(node.right) &&
                    Number(node.right.text) === 8 &&
                    ts.isPropertyAccessExpression(node.left) &&
                    node.left.name.text === "length" &&
                    ts.isPropertyAccessExpression(
                        node.left.expression,
                    ) &&
                    node.left.expression.name.text ===
                        "textureDescriptions",
            )
        ) {
            this.context.contractError(
                createGeometryTask,
                "Expected the eight-attachment geometry limit.",
            );
        }
        const hasNamedProperty = (
            root: ts.Node,
            name: string,
        ): boolean =>
            this.context.hasNode(
                root,
                (node) =>
                    (ts.isPropertySignature(node) ||
                        ts.isPropertyAssignment(node)) &&
                    this.context.propertyName(node.name) ===
                        name,
            );
        for (const property of [
            "targetTextureClearColor",
            "geometryLinearVelocityTexture",
        ]) {
            if (!hasNamedProperty(geometryFile, property)) {
                this.context.contractError(
                    geometryFile,
                    `Expected geometry task property '${property}'.`,
                );
            }
        }

        const copyFile = this.context.sourceFile(copyModule);
        for (const property of [
            "resolveTexture",
            "viewport",
            "sourceTexture",
        ]) {
            if (!hasNamedProperty(copyFile, property)) {
                this.context.contractError(
                    copyFile,
                    `Expected copy task property '${property}'.`,
                );
            }
        }
        const { declaration: buildBlitPath } =
            this.context.functionDeclaration(
                copyModule,
                "buildBlitPath",
            );
        for (const [name, expected] of [
            ["x", "Math.floor(v.x * w)"],
            [
                "vw",
                "Math.floor((v.x + v.width) * w) - x",
            ],
            ["yTop", "Math.floor(v.y * h)"],
            [
                "vh",
                "Math.floor((v.y + v.height) * h) - yTop",
            ],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(
                    buildBlitPath,
                    name,
                ),
                expected,
                `Copy viewport '${name}'`,
            );
        }
        const { declaration: createCopyTask } =
            this.context.functionDeclaration(
                copyModule,
                "createCopyToTextureTask",
            );
        if (
            !this.context.hasNode(
                createCopyTask,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                    node.expression.name.text ===
                        "setScissorRect",
            )
        ) {
            this.context.contractError(
                createCopyTask,
                "Expected the copy viewport scissor.",
            );
        }

        const { declaration: addTaskAtStart } =
            this.context.functionDeclaration(
                actionsModule,
                "addTaskAtStart",
            );
        if (
            !this.context.hasNode(
                addTaskAtStart,
                (node) =>
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(
                        node.expression,
                    ) &&
                    node.expression.name.text === "splice" &&
                    node.arguments.length === 3 &&
                    ts.isIdentifier(node.arguments[0]!) &&
                    node.arguments[0].text ===
                        "firstUserTask" &&
                    ts.isNumericLiteral(node.arguments[1]!) &&
                    Number(node.arguments[1].text) === 0 &&
                    ts.isIdentifier(node.arguments[2]!) &&
                    node.arguments[2].text === "task",
            )
        ) {
            this.context.contractError(
                addTaskAtStart,
                "Expected insertion before the first user task.",
            );
        }

        const path = (
            expression: ts.Expression,
        ): string[] | undefined => {
            if (ts.isIdentifier(expression)) {
                return [expression.text];
            }
            if (ts.isPropertyAccessExpression(expression)) {
                const owner = path(expression.expression);
                return owner
                    ? [...owner, expression.name.text]
                    : undefined;
            }
            return undefined;
        };
        const hasNullishFallback = (
            declaration: ts.FunctionDeclaration,
            left: string,
            right: string,
        ): boolean =>
            this.context.hasNode(
                declaration,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken &&
                    path(node.left)?.join(".") === left &&
                    path(node.right)?.join(".") === right,
            );
        const { declaration: createRenderTask } =
            this.context.functionDeclaration(
                renderModule,
                "createRenderTask",
            );
        if (
            !hasNullishFallback(
                createRenderTask,
                "opts.material",
                "mesh.material",
            )
        ) {
            this.context.contractError(
                createRenderTask,
                "Expected task material override fallback.",
            );
        }
        const { declaration: prepareRenderTaskPass } =
            this.context.functionDeclaration(
                renderModule,
                "prepareRenderTaskPass",
            );
        if (
            !hasNullishFallback(
                prepareRenderTaskPass,
                "task._config.cam",
                "sc.camera",
            )
        ) {
            this.context.contractError(
                prepareRenderTaskPass,
                "Expected task camera fallback.",
            );
        }
        const { declaration: writePassSceneUbo } =
            this.context.functionDeclaration(
                renderModule,
                "_writePassSceneUBO",
            );
        if (
            !this.context.hasNode(
                writePassSceneUbo,
                (node) =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.SlashToken &&
                    path(node.left)?.join(".") ===
                        "eng.canvas.width" &&
                    path(node.right)?.join(".") ===
                        "eng.canvas.height",
            )
        ) {
            this.context.contractError(
                writePassSceneUbo,
                "Expected canvas aspect selection.",
            );
        }

        const { declaration: createRenderTargetTexture } =
            this.context.functionDeclaration(
                rttModule,
                "createRenderTargetTexture",
            );
        for (const [property, value] of [
            ["aspect", "depth-only"],
            ["_sampleType", "depth"],
        ] as const) {
            if (
                !this.context.hasNode(
                    createRenderTargetTexture,
                    (node) =>
                        ts.isPropertyAssignment(node) &&
                        this.context.propertyName(node.name) ===
                            property &&
                        ts.isStringLiteral(node.initializer) &&
                        node.initializer.text === value,
                )
            ) {
                this.context.contractError(
                    createRenderTargetTexture,
                    `Expected ${property}: '${value}'.`,
                );
            }
        }
        if (
            !this.context.hasCall(
                createRenderTargetTexture,
                "getNearestSampler",
            )
        ) {
            this.context.contractError(
                createRenderTargetTexture,
                "Expected nearest sampling for depth views.",
            );
        }

        return {
            modulePath: geometryModule,
            symbolName:
                "createGeometryRendererTask,createRenderTarget,createRenderTargetTexture,createRenderTask,createCopyToTextureTask,addTask,addTaskAtStart,RenderTask.addMesh",
            header: `#pragma once

#include <bblite/runtime.hpp>

#include <cstdint>

namespace bbl::upstream {

struct PixelViewport {
    std::int32_t x = 0;
    std::int32_t y = 0;
    std::int32_t width = 0;
    std::int32_t height = 0;
};

PixelViewport resolve_copy_viewport(
    const NormalizedViewport& viewport,
    std::uint32_t target_width,
    std::uint32_t target_height);

} // namespace bbl::upstream
`,
            source: `// ${this.context.provenance(
                geometryModule,
                "createGeometryRendererTask",
                `${renderModule}#createRenderTask,RenderTask.addMesh, ${rttModule}#createRenderTargetTexture, ${copyModule}#createCopyToTextureTask, and ${actionsModule}#addTask,addTaskAtStart`,
            )}
#include <bblite/upstream/frame_graph_geometry.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl::upstream {

PixelViewport resolve_copy_viewport(
    const NormalizedViewport& viewport,
    std::uint32_t target_width,
    std::uint32_t target_height) {
    const auto pixel = [](
                           double coordinate,
                           std::uint32_t extent) -> std::int32_t {
        return static_cast<std::int32_t>(
            std::floor(
                coordinate *
                static_cast<double>(extent)));
    };
    const std::int32_t x = pixel(viewport.x, target_width);
    const std::int32_t right =
        pixel(viewport.x + viewport.width, target_width);
    const std::int32_t y_top =
        pixel(viewport.y, target_height);
    const std::int32_t bottom =
        pixel(viewport.y + viewport.height, target_height);
    const std::int32_t viewport_height = bottom - y_top;
    return PixelViewport{
        x,
        static_cast<std::int32_t>(target_height) -
            y_top -
            viewport_height,
        right - x,
        viewport_height,
    };
}

} // namespace bbl::upstream

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
