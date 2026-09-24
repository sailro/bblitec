import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

/** Source tracking decisions; native scene generations own binding replacement/retirement. */
export function renderTaskMeshRefreshCpp(context: LoweringContext): string {
    const path = "src/frame-graph/render-task-mesh-refresh.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "enableRenderTaskMeshRefresh",
    );
    if (!declaration.body)
        return context.contractError(
            declaration,
            "Expected mesh-refresh factory.",
        );
    const install = declaration.body.statements.findIndex(
        (statement) =>
            ts.isExpressionStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "_enableTaskMeshPopulation(task)",
            ),
    );
    if (install < 0)
        return context.contractError(
            declaration,
            "Expected explicit mesh population installation.",
        );
    let add: ts.ArrowFunction | undefined;
    for (const statement of declaration.body.statements) {
        if (!ts.isExpressionStatement(statement)) continue;
        const expression = unwrapExpression(statement.expression);
        if (
            ts.isBinaryExpression(expression) &&
            expression.left.getText(file) === "task._addMesh"
        ) {
            const value = unwrapExpression(expression.right);
            if (ts.isArrowFunction(value)) add = value;
        }
    }
    if (!add || !ts.isBlock(add.body))
        return context.contractError(
            declaration,
            "Expected retained mesh-refresh add callback.",
        );
    const bindings = new Map<string, PinnedBinding>([
        [
            "task._prepareTaskMeshes",
            { cpp: "record.render_mesh_refresh", type: "bool" },
        ],
        ["task._sceneBG", { cpp: "record.render_recorded", type: "bool" }],
        [
            "task._config.autoMirror",
            { cpp: "record.render.auto_mirror", type: "bool" },
        ],
        [
            "task._disposed",
            {
                cpp: "(record.source_scene && record.source_scene->disposed)",
                type: "bool",
            },
        ],
        [
            "task._pendingMeshes.length",
            {
                cpp: "static_cast<double>(record.render_meshes.size())",
                type: "scalar",
            },
        ],
        ["mesh", { cpp: "mesh", type: "opaque" }],
        [
            "mesh.material",
            {
                cpp: `(${recordAt("engine.meshes", "mesh")}.material.value != invalid_handle)`,
                type: "bool",
            },
        ],
        ["options", { cpp: "material", type: "opaque" }],
        ["task", { cpp: "record", type: "opaque" }],
        ["dirty", { cpp: "record.render_meshes_dirty", type: "bool" }],
    ]);
    const calls = new Map<string, (args: readonly string[]) => string>([
        [
            "tracked.includes",
            (args) =>
                `std::any_of(record.render_meshes.begin(), record.render_meshes.end(), [&](const RenderTaskMesh& entry) { return entry.follows_material && entry.mesh == ${args[0]}; })`,
        ],
        [
            "tracked.push",
            (args) =>
                `record.render_meshes.push_back(RenderTaskMesh{${args[0]}, ${recordAt("engine.meshes", args[0]!)}.material, true})`,
        ],
        [
            "addMesh",
            () =>
                `throw std::runtime_error("Mesh refresh with per-task material overrides is not supported.")`,
        ],
        ["_rebindRenderTask", () => "(++engine.draw_list_epoch)"],
        ["finishReplacements", () => "(void)0"],
    ]);
    const scope: PinnedNumericScope = {
        bindings,
        calls,
        callShapes: new Map([["tracked.includes", "bool"]]),
        expression(node) {
            if (context.expressionMatchesShape(node, "options?.material"))
                return "material_override";
            return undefined;
        },
        statement(statement, lowerer, indent) {
            if (
                ts.isTryStatement(statement) &&
                statement.catchClause &&
                !statement.finallyBlock
            ) {
                return [
                    `${indent}try {`,
                    ...lowerer.statements(
                        statement.tryBlock.statements,
                        `${indent}    `,
                    ),
                    `${indent}} catch (...) {`,
                    ...lowerer.statements(
                        statement.catchClause.block.statements,
                        `${indent}    `,
                    ),
                    `${indent}}`,
                ];
            }
            if (
                ts.isThrowStatement(statement) &&
                ts.isIdentifier(statement.expression) &&
                statement.expression.text === "error"
            )
                return [`${indent}throw;`];
            if (!ts.isExpressionStatement(statement)) return undefined;
            const expression = unwrapExpression(statement.expression);
            if (
                !ts.isBinaryExpression(expression) ||
                expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken
            )
                return undefined;
            const name = expression.left.getText(file);
            if (name === "replacedRenderables") {
                context.assertExpressionShape(
                    expression.right,
                    "[]",
                    "Discard uncommitted binding replacements",
                );
                return [`${indent}(void)0;`];
            }
            if (name === "trackedEntryCount") {
                context.assertExpressionShape(
                    expression.right,
                    "0",
                    "Reset uncommitted binding replacement count",
                );
                return [`${indent}(void)0;`];
            }
            return undefined;
        },
    };
    const guards = lowerPinnedBody(
        file,
        declaration.body.statements.slice(0, install),
        scope,
    );
    const body = lowerPinnedBody(file, add.body.statements, scope);
    return `// ${context.provenance(path, "enableRenderTaskMeshRefresh")}
void enable_render_task_mesh_refresh(Engine& engine, TaskHandle task) {
    auto& record = task_record(engine, task);
    if (record.kind != FrameTaskKind::render) throw std::runtime_error("Mesh refresh requires a render task.");
${guards}
    if (!record.render_meshes.empty()) throw std::runtime_error("Mesh refresh must be enabled before explicit native mesh population.");
    record.render_mesh_refresh = true;
}

void add_refreshed_render_task_mesh(Engine& engine, FrameTaskRecord& record,
                                  MeshHandle mesh, MaterialHandle material, bool material_override) {
    (void)material;
${body}
}
`;
}
