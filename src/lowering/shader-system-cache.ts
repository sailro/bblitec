import ts from "typescript";
import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedCallSpelling,
} from "./pinned-numeric-lowerer.js";
import { isShaderSystemMatrix, shaderSystemMatrixTable } from "../shader-ir.js";
import { sameSource } from "../compiler/syntax.js";

const rendererModule = "src/material/shader/shader-renderable.ts";
const dependencyModule = "src/material/shader/shader-system-dependencies.ts";

/**
 * A scene reaching shader materials refuses floating origin at generation
 * (`floatingOriginUnwired`, generation-refusal.ts), so every camera a packet
 * reads is off the mode.
 */
const offFloatingOrigin: PinnedBinding = { cpp: "false", type: "bool" };

/** The pin's dependency bits, each a generated constant of its own name. */
const dependencyConstants = [
    ["WORLD", "shader_system_world"],
    ["VIEW", "shader_system_view"],
    ["PROJECTION", "shader_system_projection"],
    ["VIEW_PROJECTION", "shader_system_view_projection"],
    ["CAMERA_POSITION", "shader_system_camera_position"],
    ["SCREEN_SIZE", "shader_system_screen_size"],
    ["ALPHA_CUTOFF", "shader_system_alpha_cutoff"],
    ["CAMERA", "shader_system_camera"],
] as const;

function dependencyBindings(): [string, PinnedBinding][] {
    return dependencyConstants.map(([pinned, cpp]) => [
        pinned,
        { cpp, type: "scalar" },
    ]);
}

const dependencyTables = new WeakMap<
    LoweringContext,
    ReadonlyMap<string, number>
>();

/**
 * The dependency bits the pin's `shaderSystemDependency` gives each system
 * uniform name, read from its own table: a declared name outside it is not
 * a system uniform (`_isShaderSystemUniform` is that test). Read once per
 * context: the layouts and the matrix routing both key on it.
 */
function pinnedDependencyTable(
    context: LoweringContext,
): ReadonlyMap<string, number> {
    const cached = dependencyTables.get(context);
    if (cached) return cached;
    const lookup = context.functionDeclaration(
        dependencyModule,
        "shaderSystemDependency",
    ).declaration;
    context.assertStatementShapes(
        lookup,
        lookup.body!.statements,
        "return DEPENDENCIES[name] ?? 0;",
        "Shader system dependency lookup",
    );
    const isSystem = context.functionDeclaration(
        "src/material/shader/shader-material.ts",
        "_isShaderSystemUniform",
    ).declaration;
    context.assertStatementShapes(
        isSystem,
        isSystem.body!.statements,
        "return shaderSystemDependency(name) !== 0;",
        "Shader system uniform test",
    );
    const table = context.numericObject(
        context.sourceFile(dependencyModule),
        "DEPENDENCIES",
    );
    dependencyTables.set(context, table);
    return table;
}

/**
 * The reached shader materials' system layouts as their packets read them:
 * the dependency bits of each declared system uniform, in the layout's
 * order (the pipeline's computeUboLayout lays system fields in declaration
 * order). The material record folds them as the asserted
 * `shaderSystemDependencies` does. A declared uniform is a system one when
 * it names a system matrix; a typed `name:type` declaration is custom.
 */
export function shaderSystemLayouts(
    context: LoweringContext,
): (uniforms: readonly string[]) => readonly number[] {
    const table = pinnedDependencyTable(context);
    const fold = context.functionDeclaration(
        dependencyModule,
        "shaderSystemDependencies",
    ).declaration;
    context.assertStatementShapes(
        fold,
        fold.body!.statements,
        `
        let dependencies = 0;
        for (const name of spec._offsets.keys()) { dependencies |= shaderSystemDependency(name); }
        return dependencies;`,
        "Shader system dependency fold",
    );
    return (uniforms) =>
        uniforms.filter(isShaderSystemMatrix).map((name) => {
            const bits = table.get(name);
            if (bits === undefined)
                return context.contractError(
                    context.sourceFile(dependencyModule),
                    `Expected the pinned dependencies of system uniform '${name}'.`,
                );
            return bits;
        });
}

/**
 * The packet matrix each system matrix's dependency bits store into: the
 * pin's table, keyed by the name the compiler's system-matrix table gives
 * the packet state's field.
 */
export function lowerShaderSystemMatrixRouting(
    context: LoweringContext,
): string {
    const table = pinnedDependencyTable(context);
    const routed = new Set<number>();
    const routes = shaderSystemMatrixTable
        .filter(({ type }) => type === "mat4x4<f32>")
        .map(({ name, enumerator }) => {
            const bits = table.get(name);
            // A store finds its matrix by its bits alone.
            if (!bits || routed.has(bits))
                return context.contractError(
                    context.sourceFile(dependencyModule),
                    `Expected distinct nonzero pinned dependencies for system matrix '${name}'.`,
                );
            routed.add(bits);
            return `    if (dependency == ${bits}u) return state.${enumerator};`;
        });
    return `// ${context.provenance(dependencyModule, "DEPENDENCIES", "system matrix routing")}
template<class State>
std::array<float, 16>& shader_system_matrix(State& state, std::uint32_t dependency) {
${routes.join("\n")}
    throw std::runtime_error("A shader system store names no packet matrix.");
}
`;
}

/** The pin's dependency bits as named generated constants. */
export function lowerShaderSystemDependencyConstants(
    context: LoweringContext,
): string {
    return `// ${context.provenance(dependencyModule, dependencyConstants.map(([name]) => name).join(", "))}
${dependencyConstants
    .map(
        ([pinned, cpp]) =>
            `inline constexpr double ${cpp} = ${context.doubleLiteral(context.pinnedNumber(dependencyModule, pinned))};`,
    )
    .join("\n")}
`;
}

/** The shader packet's system upload gate, separate from custom material slots. */
export function lowerShaderSystemCache(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        rendererModule,
        "updatePacket",
    );
    const statements = declaration.body!.statements;
    const publication = statements.find(
        (statement): statement is ts.IfStatement =>
            ts.isIfStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "dependencies",
            ),
    );
    const gate =
        publication && ts.isBlock(publication.thenStatement)
            ? publication.thenStatement.statements.find(
                  (statement): statement is ts.IfStatement =>
                      ts.isIfStatement(statement) &&
                      context.hasNode(statement.expression, (node) =>
                          sameSource(node, "packet._lastCamera"),
                      ),
              )
            : undefined;
    if (
        !publication ||
        publication.elseStatement ||
        !gate ||
        !ts.isBlock(gate.thenStatement) ||
        gate.elseStatement
    )
        context.contractError(
            declaration,
            "Expected the shader packet system publication gate.",
        );
    // The visible-packet policy and the indexed-indirect resolver are each
    // installed by one opt-in enabler (enableShaderMaterialVisiblePacketUpdates,
    // setMeshIndexedIndirect) that no reached program lowers.
    context.assertWrittenOnlyBy(
        "_deferPacketUpdate",
        "src/material/shader/enable-shader-material-visible-packet-updates.ts",
        "enableShaderMaterialVisiblePacketUpdates",
    );
    context.assertWrittenOnlyBy(
        "_indexedDrawResolver",
        rendererModule,
        "_installShaderIndexedDrawResolver",
    );
    const fields = [
        ["_lastCamera", "camera", "opaque"],
        ["_lastCameraVersion", "camera_version", "scalar"],
        ["_lastFloatingOrigin", "floating_origin", "bool"],
        ["_lastMeshWmVersion", "mesh_version", "scalar"],
        ["_lastTargetWidth", "target_width", "scalar"],
        ["_lastTargetHeight", "target_height", "scalar"],
        ["_lastAspect", "aspect", "scalar"],
        ["_lastAlphaCutoff", "alpha_cutoff", "scalar"],
    ] as const;
    const factory = context.functionDeclaration(
        rendererModule,
        "createPacket",
    ).declaration;
    const packet = context.objectInitializer(factory, "packet");
    for (const [name] of fields)
        if (
            packet.properties.some((property) =>
                sameSource(property.name, name),
            )
        )
            context.contractError(
                packet,
                `Expected initially absent shader packet stamp '${name}'.`,
            );
    const bindings = new Map<string, PinnedBinding>([
        [
            "packet._systemDependencies",
            { cpp: "static_cast<double>(system_dependencies)", type: "scalar" },
        ],
        [
            "camera",
            { cpp: "camera", type: "opaque", absentCpp: "camera == nullptr" },
        ],
        [
            "cameraIdentity",
            {
                cpp: "cameraIdentity",
                type: "opaque",
                absentCpp: "cameraIdentity == nullptr",
            },
        ],
        ["camera?._useFloatingOrigin", offFloatingOrigin],
        [
            "packet.mesh.worldMatrixVersion",
            {
                cpp: "static_cast<double>(mesh.transform_version)",
                type: "scalar",
            },
        ],
        ["context.targetWidth", { cpp: "target_width", type: "scalar" }],
        ["context.targetHeight", { cpp: "target_height", type: "scalar" }],
        // Read only where the layout declares it, as the pin's gate reads it.
        [
            'material._uniformValues.get("alphaCutoff")?.value[0] ?? 0.4',
            { cpp: "alpha_cutoff()", type: "scalar" },
        ],
        ...dependencyBindings(),
        ...fields.map(([source, native, type]): [string, PinnedBinding] => [
            `packet.${source}`,
            { cpp: `cache.${native}`, type },
        ]),
    ]);
    const prefix = statements.slice(0, statements.indexOf(publication) + 1);
    const body = lowerPinnedBody(file, prefix, {
        bindings,
        calls: new Map([
            [
                "_cameraChangeKey",
                (args: readonly string[]) =>
                    `scene_camera_change_key(*${args[0]!})`,
            ],
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
                    "packet._lastCamera !== cameraIdentity",
                )
            )
                return "(cache.camera != cameraIdentity)";
            if (expression.kind === ts.SyntaxKind.NullKeyword)
                return "static_cast<const CameraRecord*>(nullptr)";
            return undefined;
        },
        statement(statement, lowerer, indent) {
            // Both hooks are absent in every reached program (asserted above).
            if (
                ts.isIfStatement(statement) &&
                context.expressionMatchesShape(
                    statement.expression,
                    "material._deferPacketUpdate?.(packet.mesh)",
                )
            ) {
                context.assertStatementShapes(
                    statement,
                    [statement],
                    "if (material._deferPacketUpdate?.(packet.mesh)) { return; }",
                    "Shader packet visibility deferral",
                );
                return [];
            }
            if (
                ts.isExpressionStatement(statement) &&
                context.expressionMatchesShape(
                    statement.expression,
                    "_indexedDrawResolver?.update(engine, packet.mesh)",
                )
            )
                return [];
            if (ts.isVariableStatement(statement)) {
                const local = statement.declarationList.declarations[0];
                if (local && ts.isIdentifier(local.name)) {
                    const elided = new Map([
                        ["engine", "scene.surface.engine"],
                        ["state", "material as ShaderMaterialRenderState"],
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
                    if (
                        local.name.text === "cameraIdentity" &&
                        local.initializer
                    )
                        return [
                            `${indent}const CameraRecord* const cameraIdentity = ${lowerer.expression(local.initializer)};`,
                        ];
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
                return [`${indent}write_system();`];
            }
            return undefined;
        },
    });
    return `// ${context.provenance(rendererModule, "updatePacket", "system packet publication")}
template<class Cache, class AlphaCutoff, class WriteSystem>
void update_shader_packet_system(Cache& cache, std::uint32_t system_dependencies, const CameraRecord* camera,
    const MeshRecord& mesh, double target_width, double target_height, AlphaCutoff&& alpha_cutoff,
    WriteSystem&& write_system) {
${body}
}
`;
}

/**
 * The source's system block writer over a packet's declared layout: it
 * zero-fills the block, then reads only the camera matrices and the world a
 * declared uniform names, each at most once, in layout order -- so which
 * public camera caches a write refreshes is the declaration's.
 */
export function lowerShaderSystemWriter(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        rendererModule,
        "writeSystemUniforms",
    );
    const statements = declaration.body!.statements;
    context.assertStatementShapes(
        declaration,
        statements.slice(0, 4),
        `
        data.fill(0);
        let world: Float32Array | undefined;
        let view: Float32Array | undefined;
        let viewProjection: Float32Array | undefined;`,
        "Shader system block initialization",
    );
    const loop = statements[4];
    if (
        statements.length !== 5 ||
        !loop ||
        !ts.isForOfStatement(loop) ||
        !ts.isBlock(loop.statement)
    )
        return context.contractError(
            declaration,
            "Expected one loop over the declared system layout.",
        );
    context.assertExpressionShape(
        loop.expression,
        "spec._offsets",
        "Declared system layout",
    );
    const entry = ts.isVariableDeclarationList(loop.initializer)
        ? loop.initializer.declarations[0]?.name
        : undefined;
    if (!entry || !sameSource(entry, "[name, offset]"))
        return context.contractError(
            loop,
            "Expected the declared layout's name and offset.",
        );
    const [offset, dependency, ...rest] = loop.statement.statements;
    if (!offset || !dependency || rest.length !== 1)
        return context.contractError(
            loop,
            "Expected the declared slot's offset, dependency and branches.",
        );
    context.assertStatementShapes(
        loop,
        [offset, dependency],
        "const f = offset / 4; const dependency = shaderSystemDependency(name);",
        "Declared slot dependency",
    );
    const memos = new Set(["view", "viewProjection", "world"]);
    const body = lowerPinnedBody(file, rest, {
        bindings: new Map<string, PinnedBinding>([
            [
                "camera",
                {
                    cpp: "camera",
                    type: "opaque",
                    absentCpp: "camera == nullptr",
                },
            ],
            ["mesh", { cpp: "mesh", type: "opaque" }],
            ["targetWidth", { cpp: "target_width", type: "scalar" }],
            ["targetHeight", { cpp: "target_height", type: "scalar" }],
            [
                "dependency",
                { cpp: "static_cast<double>(dependency)", type: "scalar" },
            ],
            ...dependencyBindings(),
            ["camera._useFloatingOrigin", offFloatingOrigin],
        ]),
        calls: new Map<string, PinnedCallSpelling>([
            ["getViewMatrix", () => "build_camera_view_matrix(*camera)"],
            [
                "getProjectionMatrix",
                (args) => `build_scene_projection(*camera, ${args[1]})`,
            ],
            [
                "getViewProjectionMatrix",
                (args) => `build_view_projection(*camera, ${args[1]})`,
            ],
            [
                "getEffectiveAspectRatio",
                () =>
                    "effective_aspect_ratio(*camera, target_width, target_height)",
            ],
            ["_shaderWorldMatrix", () => "read_world()"],
        ]),
        // Each memoized matrix (`view ??= getViewMatrix(camera)`) is read once.
        expression(node, lowerer) {
            if (
                !ts.isBinaryExpression(node) ||
                node.operatorToken.kind !==
                    ts.SyntaxKind.QuestionQuestionEqualsToken
            )
                return undefined;
            const name = node.left.getText(file);
            if (!memos.has(name))
                return context.contractError(
                    node,
                    "Expected a declared system matrix memo.",
                );
            return `(${name} ? *${name} : *(${name} = ${lowerer.expression(node.right)}))`;
        },
        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const local = node.declarationList.declarations[0];
                if (local?.initializer && ts.isIdentifier(local.name)) {
                    if (local.name.text === "matrix")
                        return [
                            `${indent}const std::array<float, 16> matrix = ${lowerer.expression(local.initializer)};`,
                        ];
                    if (local.name.text === "wm") {
                        context.assertExpressionShape(
                            local.initializer,
                            "camera.worldMatrix as unknown as ArrayLike<number>",
                            "Shader camera position source",
                        );
                        return [];
                    }
                }
            }
            if (!ts.isExpressionStatement(node)) return undefined;
            const write = node.expression;
            // The eye's three lanes are one store of the pass's camera position.
            if (context.expressionMatchesShape(write, "data[f] = wm[12]!"))
                return [`${indent}store_camera_position();`];
            if (
                context.expressionMatchesShape(
                    write,
                    "data[f + 1] = wm[13]!",
                ) ||
                context.expressionMatchesShape(write, "data[f + 2] = wm[14]!")
            )
                return [];
            if (context.expressionMatchesShape(write, "data.set(matrix, f)"))
                return [`${indent}store(dependency, matrix);`];
            if (
                ts.isCallExpression(write) &&
                context.expressionMatchesShape(write.expression, "data.set") &&
                write.arguments.length === 2 &&
                context.expressionMatchesShape(write.arguments[1]!, "f")
            )
                return [
                    `${indent}store(dependency, ${lowerer.expression(write.arguments[0]!)});`,
                ];
            if (
                ts.isCallExpression(write) &&
                context.expressionMatchesShape(
                    write.expression,
                    "multiplyMat4IntoBuffer",
                )
            ) {
                context.assertExpressionShape(
                    write,
                    "multiplyMat4IntoBuffer(data, f, matrix, 0, (world ??= _shaderWorldMatrix(mesh, camera)), 0)",
                    "Declared world product write",
                );
                return [
                    `${indent}store_product(dependency, matrix, ${lowerer.expression(write.arguments[4]!)});`,
                ];
            }
            if (context.expressionMatchesShape(write, "data[f] = targetWidth"))
                return [
                    `${indent}store_screen_size(target_width, target_height);`,
                ];
            if (
                context.expressionMatchesShape(
                    write,
                    "data[f + 1] = targetHeight",
                )
            )
                return [];
            if (
                context.expressionMatchesShape(
                    write,
                    'data[f] = material._uniformValues.get("alphaCutoff")?.value[0] ?? 0.4',
                )
            )
                return [
                    `${indent}throw std::runtime_error("A shader material's alphaCutoff system uniform is not supported.");`,
                ];
            return undefined;
        },
    });
    return `// ${context.provenance(rendererModule, "writeSystemUniforms", "declared system layout")}
template<class Clear, class ReadWorld, class Store, class StoreProduct, class StoreCameraPosition, class StoreScreenSize>
void write_shader_packet_system(const CameraRecord* camera, std::span<const std::uint32_t> layout,
    double target_width, double target_height, Clear&& clear, ReadWorld&& read_world, Store&& store,
    StoreProduct&& store_product, StoreCameraPosition&& store_camera_position,
    StoreScreenSize&& store_screen_size) {
    clear();
    std::optional<std::array<float, 16>> world;
    std::optional<std::array<float, 16>> view;
    std::optional<std::array<float, 16>> viewProjection;
    for (const std::uint32_t dependency : layout) {
${body.replace(/^/gm, "    ")}
    }
}
`;
}

/** createPacket performs its first camera reads before any per-pass update. */
export function lowerShaderPacketCameraInitialization(
    context: LoweringContext,
): string {
    const { file, declaration: factory } = context.functionDeclaration(
        rendererModule,
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
    context.assertExpressionShape(
        write.arguments[4]!,
        "scene.camera",
        "Eager shader system camera",
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
    // Only the reads persist: the gate's first update rewrites every declared
    // value before the packet's first draw, so the stores are discarded here.
    return `// ${context.provenance(rendererModule, "createPacket", "eager camera cache reads")}
void initialize_shader_packet_camera_cache(const Scene& scene, const MaterialRecord& material) {
    if (!scene.engine) throw std::runtime_error("Shader packet requires its source scene engine.");
    const auto* camera = handle_find(scene.engine->cameras, scene.camera);
    const double target_width = ${dimensions.expression(write.arguments[5]!)};
    const double target_height = ${dimensions.expression(write.arguments[6]!)};
    upstream::write_shader_packet_system(
        camera, material.shader_system_dependencies, target_width, target_height, [] {},
        [] { return std::array<float, 16>{}; },
        [](std::uint32_t, const std::array<float, 16>&) {},
        [](std::uint32_t, const std::array<float, 16>&, const std::array<float, 16>&) {}, [] {},
        [](double, double) {});
}`;
}
