import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { taskDisposedCpp } from "./frame-graph-task-disposal.js";

const graphModule = "src/frame-graph/frame-graph.ts";
const baseModule = "src/frame-graph/render-task-base.ts";
const effectModule = "src/effect/effect-renderer.ts";

/**
 * `buildFrameGraphTask`: record one task already in a live graph. Native
 * graph membership is the scene's task list. A render task records as
 * registration records it (`renderTaskRecord`, the queued renderables'
 * construction); an effect task's record builds the wrapper's bind group,
 * which throws for an unset slot. Target allocation, pipelines and pass
 * initialization belong to each backend's next draw-list build, which the
 * epoch moves.
 */
export function lowerFrameGraphTaskBuild(
    context: LoweringContext,
    renderTaskRecord: string,
    effectTasks: boolean,
): string {
    const { file, declaration: build } = context.functionDeclaration(
        graphModule,
        "buildFrameGraphTask",
    );
    const statements = build.body!.statements;
    context.assertStatementShapes(
        build.body!,
        statements,
        `
        if (!fg._tasks.includes(task)) {
            ThrowLiteError(121, task.name);
        }
        recordTask(fg, task);
        for (const pass of task._passes) {
            pass._initialize();
        }
    `,
        "Live frame-graph task build",
    );
    const record = context.functionDeclaration(
        graphModule,
        "recordTask",
    ).declaration;
    context.assertStatementShapes(
        record.body!,
        record.body!.statements,
        `
        task._passes.length = 0;
        fg._currentProcessedTask = task;
        try {
            task.record();
        } finally {
            fg._currentProcessedTask = null;
        }
    `,
        "Single task record",
    );
    const renderRecord = context.propertyFunction(
        baseModule,
        "_createAutomaticRenderTask",
        "record",
        { unique: true },
    ).declaration;
    context.assertStatementShapes(
        renderRecord.body,
        renderRecord.body.statements,
        `
        if (task._disposed) {
            throw new Error("RenderTask has been disposed.");
        }
        if (task._recordExplicit) {
            task._recordExplicit(task, true);
        } else {
            _buildBindings(task, config.autoMirror !== false ? scene._renderables.slice() : task._renderables, true);
        }
    `,
        "Render task record",
    );
    if (effectTasks) {
        const effectRecord = context.propertyFunction(
            effectModule,
            "createEffectRenderTask",
            "record",
            { unique: true },
        ).declaration;
        context.assertStatementShapes(
            effectRecord.body,
            effectRecord.body.statements,
            `
            buildRenderTarget(rt, eng);
            task._pipeline = getEffectPipeline(effect, task._targetSignature);
            task._bindGroup = getEffectBindGroup(effect);
        `,
            "Effect render task record",
        );
    }
    const [, recordCall, initialize] = statements;
    const body = lowerPinnedBody(file, statements, {
        bindings: new Map(),
        calls: new Map(),
        expression(expression) {
            if (
                context.expressionMatchesShape(
                    expression,
                    "fg._tasks.includes(task)",
                )
            )
                return "(std::find(scene.tasks.begin(), scene.tasks.end(), handle) != scene.tasks.end())";
            if (context.expressionMatchesShape(expression, "task.name"))
                return "frame_task_name(task)";
            return undefined;
        },
        statement(node, _lowerer, indent) {
            if (node === recordCall)
                return [
                    `${indent}if (task.kind == FrameTaskKind::render) {`,
                    `${indent}    if ${taskDisposedCpp("task", true)}`,
                    `${indent}        throw std::runtime_error("RenderTask has been disposed.");`,
                    // Registration records each queued task once; a
                    // recorded task's next draw-list build re-records it.
                    `${indent}    if (!task.render_recorded) record_render_task(scene, task);`,
                    ...(effectTasks
                        ? [
                              `${indent}} else if (task.kind == FrameTaskKind::effect) {`,
                              `${indent}    require_effect_bind_group(engine, task.effect.effect);`,
                              // The record restores the pipeline dispose cleared.
                              `${indent}    task.disposed = false;`,
                          ]
                        : []),
                    `${indent}} else {`,
                    `${indent}    throw std::runtime_error("buildFrameGraphTask lowers render tasks and effect render tasks.");`,
                    `${indent}}`,
                ];
            if (node === initialize)
                return [
                    `${indent}task.pending_record = false;`,
                    `${indent}++engine.draw_list_epoch;`,
                ];
            return undefined;
        },
    });
    return `// ${context.provenance(baseModule, "_createAutomaticRenderTask record", "src/frame-graph/render-task-transaction.ts#resolvePendingTaskMeshes")}
static void record_render_task(Scene& scene, FrameTaskRecord& task) {
${renderTaskRecord}
}

static std::string frame_task_name(const FrameTaskRecord& task) {
    if (task.kind == FrameTaskKind::render) return task.render.name;
${effectTasks ? "    if (task.kind == FrameTaskKind::effect) return task.effect.name;\n" : ""}\
    return {};
}

// ${context.provenance(graphModule, "buildFrameGraphTask", `${graphModule}#recordTask`)}
void build_frame_graph_task(Scene& scene, TaskHandle handle) {
    require_scene_engine(scene);
    Engine& engine = *scene.engine;
    FrameTaskRecord& task = ${recordAt("engine.frame_tasks", "handle")};
${body}
}
`;
}
