import ts from "typescript";
import { type LoweringContext, unwrapExpression } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";
import { shaderUniformPublication } from "./shader-uniforms.js";

/** Packet storage follows the explicit task's source renderable generations. */
export function renderTaskShaderPacketOwnersCpp(
    context: LoweringContext,
    thinBindings = false,
): string {
    const path = "src/frame-graph/render-task-mesh-refresh.ts";
    const { file, declaration } = context.functionDeclaration(
        path,
        "enableRenderTaskMeshRefresh",
    );
    const assignments = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            context.expressionMatchesShape(node.left, "task.execute"),
    );
    if (assignments.length !== 1)
        return context.contractError(
            declaration,
            "Expected one refreshed task execute callback.",
        );
    const execute = unwrapExpression(assignments[0]!.right);
    if (!ts.isArrowFunction(execute) || !ts.isBlock(execute.body))
        return context.contractError(
            execute,
            "Expected the refreshed task execute body.",
        );
    const guard = execute.body.statements[0];
    if (
        !guard ||
        !ts.isIfStatement(guard) ||
        !ts.isBlock(guard.thenStatement) ||
        guard.elseStatement
    )
        return context.contractError(
            execute,
            "Expected the task renderable replacement guard.",
        );
    const replacementBody = guard.thenStatement;
    const owned =
        "task._renderables.some((renderable) => !!renderable._lifetimeDisposers)";
    const condition = lowerPinnedBody(file, [guard], {
        bindings: new Map<string, PinnedBinding>([
            ["dirty", { cpp: "task.render_meshes_dirty", type: "bool" }],
            [
                "task._lastVersion",
                { cpp: "task.shader_packet_scene_version", type: "scalar" },
            ],
            [
                "task.scene._renderableVersion",
                {
                    cpp: "static_cast<double>(task.source_scene->renderable_version)",
                    type: "scalar",
                },
            ],
            [
                "tracked.length",
                {
                    cpp: "static_cast<double>(std::count_if(task.render_meshes.begin(), task.render_meshes.end(), [](const auto& entry) { return entry.follows_material; }))",
                    type: "scalar",
                },
            ],
        ]),
        calls: new Map(),
        expression(node) {
            if (context.expressionMatchesShape(node, owned))
                return `std::any_of(task.render_meshes.begin(), task.render_meshes.end(), [](const auto& entry) { return static_cast<bool>(entry.shader_packet${thinBindings ? " || entry.thin_binding" : ""}); })`;
            return undefined;
        },
        statement(node, _lowerer, indent) {
            if (node.parent === replacementBody)
                return node === replacementBody.statements[0]
                    ? [`${indent}return true;`]
                    : [];
            return undefined;
        },
    });
    const ownerType = thinBindings
        ? "RenderTaskBindingOwners"
        : "ShaderPacketSystemOwner";
    return `${thinBindings ? "struct RenderTaskBindingOwners { ShaderPacketSystemOwner shader_packet; ThinMaterialBindingOwner thin_binding; };\n" : ""}// ${context.provenance(path, "enableRenderTaskMeshRefresh")}
static bool replace_render_task_shader_packets(const FrameTaskRecord& task) {
${condition}
    return false;
}

static std::vector<${ownerType}> prepare_render_task_shader_packets(const FrameTaskRecord& task${thinBindings ? ", const Engine& engine" : ""}) {
    const bool replace_tracked = task.render_mesh_refresh &&
        (task.shader_packet_rebuild_pending || replace_render_task_shader_packets(task));
    if (replace_tracked && !task.shader_packet_rebuild_pending) {
        auto scene = Scene::from_state(task.source_scene);
        if (!scene.engine) throw std::runtime_error("Shader task refresh requires its source scene engine.");
        for (const auto& entry : task.render_meshes) {
            if (!entry.follows_material) continue;
            const auto material = render_task_mesh_material(*scene.engine, entry);
            if (material.value == invalid_handle) continue;
            const auto& record = handle_at(scene.engine->materials, material);
            ${shaderUniformPublication(context, "record")}
        }
    }
    std::vector<${ownerType}> owners;
    owners.reserve(task.render_meshes.size());
    for (const auto& entry : task.render_meshes) {
${
    thinBindings
        ? `        const auto material = render_task_mesh_material(engine, entry);
        const auto* record = material.value == invalid_handle ? nullptr : handle_find(engine.materials, material);
        const bool shader = record && (record->shader_uniform_snapshot || record->shader_packet_initialize);
        const auto packet = shader && (!entry.shader_packet || (replace_tracked && entry.follows_material))`
        : "        const auto packet = !entry.shader_packet || (replace_tracked && entry.follows_material)"
}
            ? std::make_shared<std::shared_ptr<ShaderPacketSystemState>>() : entry.shader_packet;
${
    thinBindings
        ? `        auto thin = entry.thin_binding;
        if (!thin || (replace_tracked && entry.follows_material && !task.shader_packet_rebuild_pending)) {
            if (material.value != invalid_handle) thin = create_thin_material_binding(engine, entry.mesh, material);
        }
        owners.push_back({packet, std::move(thin)});`
        : "        owners.push_back(packet);"
}
    }
    return owners;
}

static void publish_render_task_shader_packets(const FrameTaskRecord& task, const std::vector<${ownerType}>& owners) {
    for (std::size_t index = 0; index < owners.size(); ++index) {
        task.render_meshes.at(index).shader_packet = owners[index]${thinBindings ? ".shader_packet" : ""};
${thinBindings ? "        task.render_meshes.at(index).thin_binding = owners[index].thin_binding;\n" : ""}    }
    if (task.source_scene)
        task.shader_packet_scene_version = static_cast<double>(task.source_scene->renderable_version);
    task.shader_packet_rebuild_pending = false;
}
`;
}

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
        [
            "_rebindRenderTask",
            () =>
                "initialize_refreshed_render_task_shader_materials(engine, record)",
        ],
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
