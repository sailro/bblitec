import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { recordAt } from "../compiler/record-access.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { propertyPath, isOneOfSources } from "../compiler/syntax.js";

/** Source renderable captures, projected onto the retained material variant metadata. */
export function lowerThinInstanceBindingCreation(
    context: LoweringContext,
): string {
    const shaderPath = "src/material/shader/shader-thin-instance.ts";
    const shaderFile = context.sourceFile(shaderPath);
    context.assertExpressionShape(
        context.variableInitializer(shaderFile, "ti"),
        "mesh.thinInstances!",
        "Shader thin-instance pool capture",
    );
    const shaderHasColor = new PinnedNumericLowerer(shaderFile, {
        bindings: new Map([
            ["ti.colors", { cpp: "has_colors", type: "bool" }],
            [
                "material._tic",
                {
                    cpp: "material.shader_thin_instance_colors.value_or(std::numeric_limits<double>::quiet_NaN())",
                    type: "scalar",
                },
            ],
        ]),
        calls: new Map(),
    }).expression(context.variableInitializer(shaderFile, "hasColor"));
    const nodePath = "src/material/node/node-renderable.ts";
    const nodeFile = context.sourceFile(nodePath);
    context.assertExpressionShape(
        context.variableInitializer(nodeFile, "attrNames"),
        "material._vertexAttrNames",
        "Node vertex attribute capture",
    );
    const requiresInstances = new PinnedNumericLowerer(nodeFile, {
        bindings: new Map([
            [
                "material._state?.usesInstanceIndex",
                { cpp: "uses_instance_index", type: "bool" },
            ],
        ]),
        calls: new Map([
            ["attrNames.includes", (args) => `includes(${args[0]})`],
        ]),
        callShapes: new Map([["attrNames.includes", "bool"]]),
    }).expression(context.variableInitializer(nodeFile, "requiresInstances"));
    return `#if BBLITE_NODE_VARIANTS > 0
// ${context.provenance(nodePath, "createNodeRenderable", "requiresInstances")}
template<class Includes>
static bool thin_node_requires_instances(Includes&& includes, bool uses_instance_index) {
    return ${requiresInstances};
}
#endif

// ${context.provenance(shaderPath, "createShaderInstancedRenderable", "thin pool and color captures")}
ThinMaterialBindingOwner create_thin_material_binding(const Engine& engine, MeshHandle handle, MaterialHandle material_handle) {
    const auto& mesh = ${recordAt("engine.meshes", "handle")};
    const auto& material = ${recordAt("engine.materials", "material_handle")};
    auto result = std::make_shared<ThinMaterialBinding>();
    result->pool = mesh.thin_instances;
    const bool has_colors = has_instance_colors(mesh);
    result->mesh_features = upstream::pinned_mesh_features(false, false, false, static_cast<bool>(result->pool), has_colors);
    if (material.shader_material) {
        result->shader_has_color = ${shaderHasColor};
    }
#if BBLITE_NODE_VARIANTS > 0
    if (material.node_material) {
        const auto& variant = upstream::node_variants.at(material.shader_variant);
        result->node_requires_instances = thin_node_requires_instances([&](std::string_view name) {
            for (std::size_t index = 0; index < variant.attribute_count; ++index) {
                if (upstream::node_variant_attributes.at(variant.first_attribute + index).name == name) return true;
            }
            return false;
        }, variant.uses_instance_index);
    }
#endif
    return result;
}
`;
}

/** Source update guards and material-specific color selection, before pass visibility filtering. */
export function lowerThinInstanceBindingUpdate(
    context: LoweringContext,
): string {
    const standardPath = "src/material/standard/standard-renderable.ts";
    const pbrPath = "src/material/pbr/pbr-renderable.ts";
    const shaderPath = "src/material/shader/shader-thin-instance.ts";
    const nodePath = "src/material/node/node-renderable.ts";
    const arrow = (
        path: string,
        name: string,
    ): { file: ts.SourceFile; body: ts.Block } => {
        const file = context.sourceFile(path);
        const value = context.variableInitializer(file, name);
        if (!ts.isArrowFunction(value) || !ts.isBlock(value.body))
            return context.contractError(
                value,
                "Expected a thin-instance update closure.",
            );
        return { file, body: value.body };
    };
    const standard = arrow(standardPath, "_baseUpdate");
    const pbr = arrow(pbrPath, "_baseUpdate");
    const shader = arrow(shaderPath, "update");
    const node = arrow(nodePath, "_baseUpdate");
    const nodeSync = arrow(nodePath, "syncPacketThinInstances");
    const bindings = new Map<string, PinnedBinding>([
        ["meshFeatures", { cpp: "mesh_features", type: "scalar" }],
        ["hasThinInstances", { cpp: "has_instances", type: "bool" }],
        ["hasTI", { cpp: "has_instances", type: "bool" }],
        ["hasInstanceColor", { cpp: "has_color", type: "bool" }],
        ["hasTIColor", { cpp: "has_color", type: "bool" }],
        ["hasColor", { cpp: "has_color", type: "bool" }],
        ["tiUpdate", { cpp: "true", type: "bool" }],
        ["requiresInstances", { cpp: "node_requires_instances", type: "bool" }],
        ["mesh.thinInstances", { cpp: "has_pool", type: "bool" }],
        ["pkt._mesh.thinInstances", { cpp: "has_pool", type: "bool" }],
        ["packet._disposed", { cpp: "disposed", type: "bool" }],
        ["pkt._disposed", { cpp: "disposed", type: "bool" }],
        ["isOverride", { cpp: "false", type: "bool" }],
        ["materialOverride", { cpp: "false", type: "bool" }],
        ["mesh.material", { cpp: "material_matches", type: "bool" }],
        ["pkt._mesh.material", { cpp: "material_matches", type: "bool" }],
        ["pkt._mesh.visible", { cpp: "visible", type: "bool" }],
        ["material", { cpp: "true", type: "bool" }],
    ]);
    for (const name of ["MSH_HAS_THIN_INSTANCES", "MSH_HAS_INSTANCE_COLOR"])
        bindings.set(name, {
            cpp: `${context.pinnedNumber("src/material/mesh-features.ts", name)}.0`,
            type: "scalar",
        });
    const lowerExpression = (file: ts.SourceFile, node: ts.Expression) =>
        new PinnedNumericLowerer(file, {
            bindings,
            calls: new Map(),
        }).expression(node);
    const expression = (path: string, name: string) => {
        const file = context.sourceFile(path);
        return lowerExpression(file, context.variableInitializer(file, name));
    };
    // The shader update and draw share one inactive-packet closure over the
    // renderable's packet, material and override captures.
    const shaderSource = context.sourceFile(shaderPath);
    const inactive = context.variableInitializer(shaderSource, "isInactive");
    if (
        !ts.isArrowFunction(inactive) ||
        inactive.parameters.length !== 0 ||
        ts.isBlock(inactive.body)
    )
        return context.contractError(
            inactive,
            "Expected the shader thin-instance inactive-packet closure.",
        );
    const inactiveCpp = lowerExpression(shaderSource, inactive.body);
    const lower = (file: ts.SourceFile, statements: readonly ts.Statement[]) =>
        lowerPinnedBody(
            file,
            statements,
            {
                bindings,
                calls: new Map(),
                foldConditions: false,
                expression(node) {
                    if (context.expressionMatchesShape(node, "isInactive()"))
                        return inactiveCpp;
                    return node.kind === ts.SyntaxKind.NullKeyword
                        ? "false"
                        : undefined;
                },
                statement(statement, lowerer, indent) {
                    if (!ts.isExpressionStatement(statement)) return undefined;
                    const value = statement.expression;
                    if (ts.isCallExpression(value)) {
                        const target = propertyPath(value.expression)?.join(
                            ".",
                        );
                        if (target === "updateCustomUbo")
                            return [`${indent}update_custom();`];
                        if (target === "updatePacket")
                            return [`${indent}update_system();`];
                    }
                    if (
                        ts.isBinaryExpression(value) &&
                        value.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        ts.isCallExpression(value.right)
                    ) {
                        const call = value.right;
                        if (
                            isOneOfSources(call.expression, [
                                "tiUpdate",
                                "syncThinInstanceForDraw",
                                "material._syncThinInstanceForDraw",
                            ])
                        ) {
                            if (call.arguments.length !== 4)
                                return context.contractError(
                                    call,
                                    "Expected four thin-instance synchronization arguments.",
                                );
                            return [
                                `${indent}draw_args = sync(${lowerer.expression(call.arguments[2]!)});`,
                            ];
                        }
                    }
                    return undefined;
                },
            },
            "        ",
        );
    const standardTail = standard.body.statements.slice(-2);
    context.assertStatementShapes(
        standard.body,
        standardTail,
        `const ti = hasThinInstances ? mesh.thinInstances : null;
        if (ti && tiUpdate) { thinDrawArgs = tiUpdate(engine, ti, hasInstanceColor, mesh._gpu); }`,
        "Standard thin-instance update tail",
    );
    const pbrTail = pbr.body.statements.slice(-1);
    context.assertStatementShapes(
        pbr.body,
        pbrTail,
        `if (hasTI) { thinDrawArgs = syncThinInstanceForDraw!(engine, mesh.thinInstances!, hasTIColor, mesh._gpu); }`,
        "PBR thin-instance update tail",
    );
    const shaderHead = shader.body.statements.slice(0, 4);
    context.assertStatementShapes(
        shader.body,
        shaderHead,
        `
        if (isInactive()) { return; }
        updateCustomUbo(scene.surface.engine, material, uniformBatch);
        updatePacket(scene, material, packet, context, uniformBatch);
        drawArgs = syncThinInstanceForDraw(scene.surface.engine, ti, hasColor, mesh._gpu);`,
        "Shader thin-instance update order",
    );
    const nodeGuard = node.body.statements[0]!;
    context.assertStatementShapes(
        node.body,
        [nodeGuard],
        `if (pkt._disposed || pkt._mesh.visible === false || (!materialOverride && pkt._mesh.material !== material)) { return; }`,
        "Node thin-instance update guard",
    );
    const nodeDraw = arrow(nodePath, "draw");
    const nodeDrawGuard = nodeDraw.body.statements[0];
    if (
        !nodeDrawGuard ||
        !ts.isIfStatement(nodeDrawGuard) ||
        !ts.isIfStatement(nodeGuard)
    )
        return context.contractError(
            nodeDraw.body,
            "Expected the Node packet draw guard.",
        );
    context.assertExpressionShape(
        nodeDrawGuard.expression,
        nodeGuard.expression.getText(node.file),
        "Node draw and update ownership guards",
    );
    const drawPacket = arrow(nodePath, "drawPacket");
    context.assertStatementShapes(
        drawPacket.body,
        drawPacket.body.statements.slice(0, 3),
        `const g = pkt._mesh._gpu; const ti = pkt._mesh.thinInstances; syncPacketThinInstances(pkt);`,
        "Node draw-time thin synchronization",
    );
    return `// ${context.provenance(shaderPath, "createShaderInstancedRenderable", "Standard/PBR/Node binding updates")}
template<class Custom, class System, class Sync>
void update_thin_binding(RenderMaterialKind kind, bool disposed, bool visible, bool material_matches,
    bool has_pool, double mesh_features, bool shader_has_color, bool node_requires_instances,
    GpuHandle& draw_args, Custom&& update_custom, System&& update_system, Sync&& sync) {
    switch (kind) {
    case RenderMaterialKind::standard: {
        const bool has_instances = ${expression(standardPath, "hasThinInstances")};
        const bool has_color = ${expression(standardPath, "hasInstanceColor")};
${lower(standard.file, standardTail)}
        return;
    }
    case RenderMaterialKind::pbr: {
        const bool has_instances = ${expression(pbrPath, "hasTI")};
        const bool has_color = ${expression(pbrPath, "hasTIColor")};
${lower(pbr.file, pbrTail)}
        return;
    }
    case RenderMaterialKind::shader: {
        const bool has_color = shader_has_color;
${lower(shader.file, shaderHead)}
        return;
    }
    case RenderMaterialKind::node: {
${lower(node.file, [nodeGuard])}
${lower(nodeSync.file, nodeSync.body.statements)}
        return;
    }
    }
}

// ${context.provenance(nodePath, "createNodeRenderable", "drawPacket thin synchronization")}
template<class Sync>
void sync_node_thin_binding_for_draw(bool disposed, bool visible, bool material_matches,
    bool has_pool, bool node_requires_instances, GpuHandle& draw_args, Sync&& sync) {
${lower(node.file, [nodeGuard])}
${lower(nodeSync.file, nodeSync.body.statements)}
}
`;
}
