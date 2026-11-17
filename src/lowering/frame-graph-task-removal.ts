import type { LoweringContext } from "./context.js";

const actionsModule = "src/frame-graph/frame-graph-actions.ts";

/**
 * `removeTask`: the pin compacts the graph's `_tasks` in place, dropping
 * every registration of the task and keeping the others' order, and says
 * whether it held one. It disposes nothing: the task keeps its passes and
 * resources, and a graph executes only the tasks it lists. Native graph
 * membership is the scene's (or a frame-graph context's) task list.
 */
export function lowerTaskRemoval(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        actionsModule,
        "removeTask",
    );
    context.assertStatementShapes(
        declaration.body!,
        declaration.body!.statements,
        `
        const tasks = resolveFg(target)._tasks;
        let count = 0;
        for (const current of tasks) {
            if (current !== task) {
                tasks[count++] = current;
            }
        }
        const removed = count !== tasks.length;
        tasks.length = count;
        return removed;
    `,
        "Task removal",
    );
    return `// ${context.provenance(actionsModule, "removeTask")}
static bool remove_task_registrations(std::vector<TaskHandle>& tasks, TaskHandle task) {
    return std::erase(tasks, task) != 0;
}

bool remove_task(Scene& scene, TaskHandle task) {
    return remove_task_registrations(scene.tasks, task);
}

bool remove_task(FrameGraphContext& context, TaskHandle task) {
    return remove_task_registrations(context.tasks, task);
}

`;
}
