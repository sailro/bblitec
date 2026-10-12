import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";

/** The shader packet's system upload gate, separate from custom material slots. */
export function lowerShaderSystemCache(context: LoweringContext): string {
    const module = "src/material/shader/shader-renderable.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "updatePacket",
    );
    const statements = declaration.body!.statements;
    const gate = statements.find(
        (statement): statement is ts.IfStatement =>
            ts.isIfStatement(statement) &&
            statement.expression.getText(file).includes("packet._lastCamera"),
    );
    if (!gate || !ts.isBlock(gate.thenStatement) || gate.elseStatement)
        context.contractError(
            declaration,
            "Expected the shader packet system publication gate.",
        );
    const fields = [
        ["_lastCamera", "camera", "opaque"],
        ["_lastCameraVersion", "camera_version", "scalar"],
        ["_lastMeshWmVersion", "mesh_version", "scalar"],
        ["_lastTargetWidth", "target_width", "scalar"],
        ["_lastTargetHeight", "target_height", "scalar"],
        ["_lastAspect", "aspect", "scalar"],
        ["_lastAlphaCutoff", "alpha_cutoff", "scalar"],
    ] as const;
    const factory = context.functionDeclaration(
        module,
        "createPacket",
    ).declaration;
    const packet = context.objectInitializer(factory, "packet");
    for (const [name] of fields)
        if (
            packet.properties.some(
                (property) => property.name?.getText(file) === name,
            )
        )
            context.contractError(
                packet,
                `Expected initially absent shader packet stamp '${name}'.`,
            );
    const bindings = new Map<string, PinnedBinding>([
        [
            "camera",
            { cpp: "camera", type: "opaque", absentCpp: "camera == nullptr" },
        ],
        [
            "packet.mesh.worldMatrixVersion",
            {
                cpp: "static_cast<double>(mesh.transform_version)",
                type: "scalar",
            },
        ],
        ["context.targetWidth", { cpp: "target_width", type: "scalar" }],
        ["context.targetHeight", { cpp: "target_height", type: "scalar" }],
        [
            'material._uniformValues.get("alphaCutoff")?.value[0] ?? 0.4',
            { cpp: "alpha_cutoff", type: "scalar" },
        ],
        ...fields.map(([source, native, type]): [string, PinnedBinding] => [
            `packet.${source}`,
            { cpp: `cache.${native}`, type },
        ]),
    ]);
    const prefix = statements.slice(0, statements.indexOf(gate) + 1);
    const body = lowerPinnedBody(file, prefix, {
        bindings,
        calls: new Map([
            ["_cameraChangeKey", () => "scene_camera_change_key(*camera)"],
            [
                "getEffectiveAspectRatio",
                () =>
                    "effective_aspect_ratio(*camera, target_width, target_height)",
            ],
            ["systemUniformWriter", () => "write_system()"],
        ]),
        expression(expression) {
            if (
                context.expressionMatchesShape(
                    expression,
                    "packet._lastCamera !== camera",
                )
            )
                return "(cache.camera != camera)";
            return undefined;
        },
        statement(statement) {
            if (ts.isVariableStatement(statement)) {
                const local = statement.declarationList.declarations[0];
                if (local && ts.isIdentifier(local.name)) {
                    const elided = new Map([
                        ["engine", "scene.surface.engine"],
                        ["state", "material as ShaderMaterialState"],
                        ["camera", "context._camera ?? scene.camera"],
                    ]).get(local.name.text);
                    if (elided && local.initializer) {
                        context.assertExpressionShape(
                            local.initializer,
                            elided,
                            "Shader packet PAL inputs",
                        );
                        return [];
                    }
                }
            }
            if (
                ts.isIfStatement(statement) &&
                context.expressionMatchesShape(
                    statement.expression,
                    "uniformBatch",
                )
            ) {
                context.assertStatementShapes(
                    statement,
                    [statement],
                    "if (uniformBatch) { uniformBatch.queue(packet.systemUBO, packet.systemData); } else { engine._device.queue.writeBuffer(packet.systemUBO, 0, packet.systemData); }",
                    "Shader packet system upload transport",
                );
                return [];
            }
            if (
                ts.isExpressionStatement(statement) &&
                ts.isCallExpression(statement.expression) &&
                context.expressionMatchesShape(
                    statement.expression.expression,
                    "systemUniformWriter",
                )
            ) {
                context.assertExpressionShape(
                    statement.expression,
                    "systemUniformWriter(packet.systemData, state._shaderBindings!.systemSpec, material, packet.mesh, camera, context.targetWidth, context.targetHeight)",
                    "Shader packet system writer boundary",
                );
                return ["        write_system();"];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(module, "updatePacket", "system packet publication")}
template<class Cache, class WriteSystem>
void update_shader_packet_system(Cache& cache, const CameraRecord* camera, const MeshRecord& mesh,
    double target_width, double target_height, double alpha_cutoff, WriteSystem&& write_system) {
${body}
}
`;
}

/** Preserve the source's zero-fill and absent-camera product guards. */
export function lowerShaderSystemProducts(context: LoweringContext): string {
    const module = "src/material/shader/shader-renderable.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "writeSystemUniforms",
    );
    const clear = declaration.body!.statements[0]!;
    context.assertStatementShapes(
        clear,
        [clear],
        "data.fill(0);",
        "Shader system block zero initialization",
    );
    const products = ["worldView", "worldViewProjection"] as const;
    const conditions = products.map((name) => {
        const clause = context.findNodes(
            declaration,
            (node): node is ts.CaseClause =>
                ts.isCaseClause(node) &&
                ts.isStringLiteral(node.expression) &&
                node.expression.text === name,
        )[0];
        const guard = clause?.statements[0];
        if (!guard || !ts.isIfStatement(guard))
            return context.contractError(
                declaration,
                `Expected the '${name}' camera guard.`,
            );
        return guard;
    });
    const body = lowerPinnedBody(file, [clear, ...conditions], {
        bindings: new Map<string, PinnedBinding>([
            [
                "view",
                {
                    cpp: "camera",
                    type: "opaque",
                    absentCpp: "camera == nullptr",
                },
            ],
            [
                "viewProjection",
                {
                    cpp: "camera",
                    type: "opaque",
                    absentCpp: "camera == nullptr",
                },
            ],
        ]),
        calls: new Map([["data.fill", () => "clear_products()"]]),
        statement(node, _lowerer, indent) {
            if (!ts.isExpressionStatement(node)) return undefined;
            for (const [matrix, writer] of [
                ["view", "write_view"],
                ["viewProjection", "write_view_projection"],
            ]) {
                if (
                    context.expressionMatchesShape(
                        node.expression,
                        `multiplyMat4IntoBuffer(data, f, ${matrix}, 0, world, 0)`,
                    )
                )
                    return [`${indent}${writer}();`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(module, "writeSystemUniforms", "world-view product guards")}
template<class Clear, class WriteView, class WriteViewProjection>
void write_shader_packet_products(const CameraRecord* camera, Clear&& clear_products,
    WriteView&& write_view, WriteViewProjection&& write_view_projection) {
${body}
}
`;
}

/** Camera reads stay inside the source writer call, after its publication gate. */
export function lowerShaderPacketCameraReads(context: LoweringContext): string {
    const module = "src/material/shader/shader-renderable.ts";
    const { file, declaration } = context.functionDeclaration(
        module,
        "writeSystemUniforms",
    );
    const reads = declaration.body!.statements.slice(2, 6);
    context.assertStatementShapes(
        declaration,
        reads,
        `
        const aspect = camera ? getEffectiveAspectRatio(camera, targetWidth, targetHeight) : 1;
        const view = camera ? (getViewMatrix(camera) as unknown as Float32Array) : null;
        const projection = camera ? (getProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;
        const viewProjection = camera ? (getViewProjectionMatrix(camera, aspect) as unknown as Float32Array) : null;`,
        "Shader packet camera initialization reads",
    );
    const body = lowerPinnedBody(file, reads, {
        bindings: new Map([
            [
                "camera",
                {
                    cpp: "camera",
                    type: "opaque",
                    absentCpp: "camera == nullptr",
                },
            ],
            ["targetWidth", { cpp: "target_width", type: "scalar" }],
            ["targetHeight", { cpp: "target_height", type: "scalar" }],
        ]),
        calls: new Map([
            [
                "getEffectiveAspectRatio",
                () =>
                    "effective_aspect_ratio(*camera, target_width, target_height)",
            ],
            ["getViewMatrix", () => "build_camera_view_matrix(*camera)"],
            [
                "getProjectionMatrix",
                () => "build_scene_projection(*camera, aspect)",
            ],
            [
                "getViewProjectionMatrix",
                () => "build_view_projection(*camera, aspect)",
            ],
        ]),
        expression(node) {
            return node.kind === ts.SyntaxKind.NullKeyword
                ? "std::array<float, 16>{}"
                : undefined;
        },
        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const local = node.declarationList.declarations[0];
                if (
                    local?.initializer &&
                    ts.isIdentifier(local.name) &&
                    local.name.text !== "aspect"
                )
                    return [
                        `${indent}${local.name.text === "viewProjection" ? "view_projection" : local.name.text} = ${lowerer.expression(local.initializer)};`,
                    ];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(module, "writeSystemUniforms", "camera reads")}
void read_shader_packet_camera_matrices(const CameraRecord* camera, double target_width, double target_height,
    std::array<float, 16>& view, std::array<float, 16>& projection, std::array<float, 16>& view_projection) {
${body}
}`;
}

/** createPacket performs its first camera reads before any per-pass update. */
export function lowerShaderPacketCameraInitialization(
    context: LoweringContext,
): string {
    const module = "src/material/shader/shader-renderable.ts";
    const { file, declaration: factory } = context.functionDeclaration(
        module,
        "createPacket",
    );
    const write = context.findNodes(
        factory,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            context.expressionMatchesShape(
                node.expression,
                "systemUniformWriter",
            ),
    )[0];
    if (!write || write.arguments.length !== 7)
        context.contractError(
            factory,
            "Expected eager shader system writer initialization.",
        );
    const dimensions = new PinnedNumericLowerer(file, {
        bindings: new Map([
            [
                "engine.canvas.width",
                {
                    cpp: "static_cast<double>(scene.engine->options.width)",
                    type: "scalar",
                },
            ],
            [
                "engine.canvas.height",
                {
                    cpp: "static_cast<double>(scene.engine->options.height)",
                    type: "scalar",
                },
            ],
        ]),
        calls: new Map(),
    });
    return `// ${context.provenance(module, "createPacket", "eager camera cache reads")}
void initialize_shader_packet_camera_cache(const Scene& scene, const MaterialRecord&) {
    if (!scene.engine) throw std::runtime_error("Shader packet requires its source scene engine.");
    const auto* camera = handle_find(scene.engine->cameras, scene.camera);
    const double target_width = ${dimensions.expression(write.arguments[5]!)};
    const double target_height = ${dimensions.expression(write.arguments[6]!)};
    std::array<float, 16> view{}, projection{}, view_projection{};
    upstream::read_shader_packet_camera_matrices(camera, target_width, target_height, view, projection, view_projection);
}`;
}
