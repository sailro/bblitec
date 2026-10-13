import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type { PinnedBinding } from "./pinned-numeric-lowerer.js";

const taskModule = "src/frame-graph/render-task.ts";
const baseModule = "src/frame-graph/render-task-base.ts";
const refreshModule = "src/frame-graph/render-task-mesh-refresh.ts";
const transactionModule = "src/frame-graph/render-task-transaction.ts";

/** The refreshed task's `_removeMesh` closure: tracked removal, then a dirty generation. */
export function refreshedRemovalCpp(context: LoweringContext): string {
    const { declaration } = context.functionDeclaration(
        refreshModule,
        "enableRenderTaskMeshRefresh",
    );
    const install = declaration.body?.statements.find(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            ts.isBinaryExpression(statement.expression) &&
            context.expressionMatchesShape(
                statement.expression.left,
                "task._removeMesh",
            ),
    );
    const closure =
        install && ts.isExpressionStatement(install)
            ? unwrapExpression(
                  (install.expression as ts.BinaryExpression).right,
              )
            : undefined;
    if (!closure || !ts.isArrowFunction(closure) || !ts.isBlock(closure.body))
        return context.contractError(
            declaration,
            "Expected the refreshed task's mesh removal closure.",
        );
    // The base removal this closure forwards to: no render task installs one
    // before the refresh does, so `removeMesh` is always absent here.
    context.assertExpressionShape(
        context.variableInitializer(declaration, "removeMesh"),
        "task._removeMesh?.bind(task)",
        "Forwarded base mesh removal",
    );
    context.assertWrittenOnlyBy(
        "_removeMesh",
        refreshModule,
        "enableRenderTaskMeshRefresh",
    );
    context.assertStatementShapes(
        closure.body,
        closure.body.statements,
        `
        removeMesh?.(mesh);
        const index = tracked.indexOf(mesh as Mesh);
        if (index >= 0) {
            tracked.splice(index, 1);
        }
        dirty = true;
    `,
        "Refreshed task mesh removal",
    );
    // Tracked meshes are the `follows_material` entries of `render_meshes`,
    // which the shared erase below drops with the explicit ones; `dirty`
    // rebinds the task at its next execute, which a recorded native task
    // reaches through its next draw-list rebuild.
    return `    if (task.render_mesh_refresh) {
        task.render_meshes_dirty = true;
        if (task.render_recorded) ++engine.draw_list_epoch;
    }`;
}

/**
 * `removeMeshFromTask` over the native task record.
 *
 * The pin keeps a task's queued requests (`_pendingMeshes`), its refreshed
 * meshes (`tracked`), its built renderables and their bucketed bindings in
 * four lists. Native `render_meshes` holds every entry, built once the task
 * is recorded (`render_recorded`), and each backend rebuilds its draw lists
 * from it when the draw-list epoch moves. So the queued and the built
 * removals erase the same list, the source's `removed` is that erase on a
 * recorded task, and the bindings follow at the next rebuild.
 */
export function lowerRenderTaskMeshRemoval(context: LoweringContext): string {
    const remove = context.functionDeclaration(
        taskModule,
        "removeMeshFromTask",
    ).declaration;
    context.assertStatementShapes(
        remove.body!,
        remove.body!.statements,
        `
        const pending = task._pendingMeshes;
        if (pending) {
            for (let index = pending.length - 1; index >= 0; index--) {
                if (pending[index]!.mesh === mesh) {
                    pending.splice(index, 1);
                }
            }
        }
        _removeMeshFromRenderTask(task, mesh);
    `,
        "Render-task mesh removal",
    );
    // Explicit population turns mirroring off at the transaction that
    // publishes it. Native population publishes at registration or at a
    // later add, so a recorded task that lists entries has taken that write
    // and an emptied explicit task draws nothing rather than the scene.
    const transaction = context.functionDeclaration(
        transactionModule,
        "transactRenderTask",
    ).declaration;
    context.expectShapeCount(
        transaction,
        "task._config.autoMirror = false",
        "explicit population disabling scene mirroring",
    );
    context.assertExpressionShape(
        context.variableInitializer(transaction, "pending"),
        "task._pendingMeshes.length > 0",
        "Explicit population publication",
    );
    const { file, declaration: base } = context.functionDeclaration(
        baseModule,
        "_removeMeshFromRenderTask",
    );
    const automatic = context.functionDeclaration(
        baseModule,
        "_createAutomaticRenderTask",
    ).declaration;
    if (
        context.hasNode(
            automatic,
            (node) =>
                (ts.isPropertyAssignment(node) ||
                    ts.isMethodDeclaration(node)) &&
                context.propertyName(node.name) === "_removeMesh",
        )
    )
        context.contractError(
            automatic,
            "Render tasks now install a base mesh removal.",
        );
    const statements = base.body!.statements;
    const [guard, hook, flag, renderables, bindings, published] = statements;
    context.assertStatementShapes(
        base.body!,
        [guard!, hook!, flag!],
        `
        if (!task._renderables) {
            return;
        }
        task._removeMesh?.(mesh);
        let removed = false;
    `,
        "Task renderable removal guard",
    );
    context.assertStatementShapes(
        base.body!,
        [renderables!, bindings!],
        `
        for (let i = task._renderables.length - 1; i >= 0; i--) {
            if (task._renderables[i]!.mesh === mesh) {
                task._retireRenderable?.(task.engine, task._renderables[i]!);
                task._renderables.splice(i, 1);
                removed = true;
            }
        }
        for (const arr of [task._opaqueBindings, task._directBindings, task._transparentBindings]) {
            for (let i = arr.length - 1; i >= 0; i--) {
                if (arr[i]!.renderable.mesh === mesh) {
                    arr.splice(i, 1);
                    removed = true;
                }
            }
        }
    `,
        "Task renderable and binding removal",
    );
    if (
        !published ||
        !ts.isIfStatement(published) ||
        !ts.isBlock(published.thenStatement) ||
        published.elseStatement ||
        statements.length !== 6
    )
        return context.contractError(
            base,
            "Expected the removed-generation publication.",
        );
    context.assertStatementShapes(
        published.thenStatement,
        published.thenStatement.statements,
        `
        const previous = task._batchState;
        task._batchState = previous?._select([task._opaqueBindings, task._directBindings, task._transparentBindings]);
        previous?._release(task.engine, [task._batchState]);
        task._ob.length = 0;
        task._lastVersion = -1;
    `,
        "Removed-generation publication",
    );
    const [, , , bundles] = published.thenStatement.statements;
    const body = lowerPinnedBody(file, statements, {
        bindings: new Map<string, PinnedBinding>([
            [
                "task._renderables",
                {
                    cpp: "(task.kind == FrameTaskKind::render)",
                    type: "bool",
                },
            ],
            [
                "task._lastVersion",
                { cpp: "task.shader_packet_scene_version", type: "scalar" },
            ],
        ]),
        calls: new Map(),
        statement(node, _lowerer, indent) {
            if (node === hook) return [refreshedRemovalCpp(context)];
            // A built renderable's lifetime owners (`shader_packet`,
            // `thin_binding`) are shared with the backend draw list that
            // still names them; that list is replaced at the next frame's
            // rebuild, so the owners outlive every submission reading them.
            if (node === renderables)
                return [
                    `${indent}if (task.render_recorded && std::erase_if(task.render_meshes, [mesh](const RenderTaskMesh& entry) { return entry.mesh == mesh; }) != 0)`,
                    `${indent}    removed = true;`,
                ];
            // Each backend rebuilds its bucketed draw lists from
            // `render_meshes`; the batch state is the pin's optional
            // instancing collector, which no native target signature installs.
            if (node === bindings) return [];
            if (ts.isVariableStatement(node) && node.parent !== base.body)
                return [];
            if (
                ts.isExpressionStatement(node) &&
                node.parent === published.thenStatement &&
                node !== bundles &&
                !context.expressionMatchesShape(
                    node.expression,
                    "task._lastVersion = -1",
                )
            )
                return [];
            if (node === bundles) return [`${indent}++engine.draw_list_epoch;`];
            return undefined;
        },
    });
    return `// ${context.provenance(taskModule, "removeMeshFromTask", `${baseModule}#_removeMeshFromRenderTask and ${refreshModule}#enableRenderTaskMeshRefresh`)}
void remove_render_task_mesh(Engine& engine, TaskHandle handle, MeshHandle mesh) {
    FrameTaskRecord& task = task_record(engine, handle);
    if (task.render_recorded && !task.render_meshes.empty()) task.render.auto_mirror = false;
    // The queued requests a task has not recorded yet.
    if (task.kind == FrameTaskKind::render && !task.render_recorded)
        std::erase_if(task.render_meshes, [mesh](const RenderTaskMesh& entry) { return entry.mesh == mesh; });
${body}
}
`;
}
