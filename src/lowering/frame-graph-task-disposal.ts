import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { recordAt } from "../compiler/record-access.js";
import { pinnedErrorCode } from "./pinned-error.js";

const baseModule = "src/frame-graph/render-task-base.ts";
const refreshModule = "src/frame-graph/render-task-mesh-refresh.ts";
const effectModule = "src/effect/effect-renderer.ts";

/**
 * The pin's `task._disposed` for the task record `record`: its own
 * `dispose()` when a program reaches it, else its scene's disposal.
 */
export function taskDisposedCpp(record: string, taskDisposal: boolean): string {
    const scene = `(${record}.source_scene && ${record}.source_scene->disposed)`;
    return taskDisposal ? `(${record}.disposed || ${scene})` : scene;
}

/**
 * `RenderTask.dispose()`. Native `render_meshes` holds the pending
 * requests, the renderables and their bindings, so emptying it is the
 * pin's clearing; a built renderable's owners stay shared with the backend
 * draw list naming them until the next build replaces it. Owned targets go
 * through `dispose_render_target`. A refreshed task's override (`tracked`,
 * `dirty`) clears the same list.
 */
export function lowerRenderTaskDisposal(context: LoweringContext): string {
    const dispose = context.propertyFunction(
        baseModule,
        "_createAutomaticRenderTask",
        "dispose",
        { unique: true },
    ).declaration;
    context.assertStatementShapes(
        dispose.body,
        dispose.body.statements,
        `
        if (task._disposed) {
            return;
        }
        task._disposed = true;
        const pending = task._pendingMeshes;
        if (pending) {
            pending.length = 0;
        }
        for (const renderable of task._renderables) {
            task._retireRenderable?.(task.engine, renderable);
        }
        task._passes.length = task._opaqueBindings.length = task._directBindings.length = 0;
        task._transparentBindings.length = task._renderables.length = task._ob.length = 0;
        if (task._ownsTargets) {
            disposeRenderTarget(config.rt);
            disposeRenderTarget(config.rst);
        }
        if (!config.depth?._eager) {
            disposeRenderTarget(config.depth);
        }
        const buffer = task._sceneUBO;
        retireGpuResources(task.engine, () => buffer.destroy());
        task._batchState?._release(task.engine);
        task._batchState = undefined;
    `,
        "Render task disposal",
    );
    const automatic = context.functionDeclaration(
        baseModule,
        "_createAutomaticRenderTask",
    ).declaration;
    const owns = context.findNodes(
        automatic,
        (node): node is ts.PropertyAssignment =>
            ts.isPropertyAssignment(node) &&
            context.propertyName(node.name) === "_ownsTargets",
    );
    if (owns.length !== 1)
        context.contractError(automatic, "Expected one target ownership.");
    context.assertExpressionShape(
        owns[0]!.initializer,
        "!config.sharedRt",
        "Render task target ownership",
    );
    const refresh = context.functionDeclaration(
        refreshModule,
        "enableRenderTaskMeshRefresh",
    ).declaration;
    const override = context.findNodes(
        refresh,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            context.expressionMatchesShape(node.left, "task.dispose"),
    );
    const closure = override[0]?.right;
    if (
        override.length !== 1 ||
        !closure ||
        !ts.isArrowFunction(closure) ||
        !ts.isBlock(closure.body)
    )
        return context.contractError(
            refresh,
            "Expected the refreshed task's dispose override.",
        );
    context.assertStatementShapes(
        closure.body,
        closure.body.statements,
        `
        tracked.length = 0;
        dirty = false;
        dispose();
    `,
        "Refreshed task disposal",
    );
    return `// ${context.provenance(baseModule, "_createAutomaticRenderTask dispose", `${refreshModule}#enableRenderTaskMeshRefresh`)}
void dispose_render_task(Engine& engine, TaskHandle handle) {
    FrameTaskRecord& task = ${recordAt("engine.frame_tasks", "handle")};
    if (task.kind != FrameTaskKind::render) throw std::runtime_error("RenderTask.dispose requires a render task.");
    if (task.disposed) return;
    task.disposed = true;
    task.render_meshes.clear();
    ++engine.draw_list_epoch;
    // \`_ownsTargets\`.
    if (!task.render.shared_target) {
        dispose_render_target(engine, task.render.target);
        dispose_render_target(engine, task.render.resolve_target);
    }
    // \`config.depth\` is only a geometry task's eager depth, which
    // disposeRenderTarget skips. No native target signature installs the
    // \`_batchState\` collector. A backend keeps the task's pass block
    // (\`_sceneUBO\`) until teardown, since task handles are never reused,
    // and refuses to execute the disposed task.
}
`;
}

/**
 * `EffectRenderTask.dispose()`: the target goes through
 * `dispose_render_target` (the swapchain's is kept); the cleared pipeline
 * makes the next execute throw the pin's #37 until a record restores it.
 */
export function lowerEffectTaskDisposal(context: LoweringContext): string {
    const method = (name: string) =>
        context.propertyFunction(effectModule, "createEffectRenderTask", name, {
            unique: true,
        }).declaration;
    const dispose = method("dispose");
    context.assertStatementShapes(
        dispose.body,
        dispose.body.statements,
        `
        task._passes.length = 0;
        disposeRenderTarget(task._rt);
        task._pipeline = null;
        task._bindGroup = null;
    `,
        "Effect render task disposal",
    );
    const execute = method("execute");
    const code = pinnedErrorCode(context, execute);
    return `// ${context.provenance(effectModule, "createEffectRenderTask dispose")}
void dispose_effect_render_task(Engine& engine, TaskHandle handle) {
    FrameTaskRecord& task = ${recordAt("engine.frame_tasks", "handle")};
    if (task.kind != FrameTaskKind::effect) throw std::runtime_error("EffectRenderTask.dispose requires an effect task.");
    dispose_render_target(engine, task.effect.target);
    // \`_pipeline = null\`: execute throws #${code} until the next record.
    task.disposed = true;
}
`;
}
