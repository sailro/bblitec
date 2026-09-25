import ts from "typescript";
import {
    type LoweredSource,
    type LoweringContext,
    unwrapExpression,
} from "./context.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import { type PinnedBinding } from "./pinned-numeric-lowerer.js";
import { proceduralSkyModule } from "./procedural-sky-atmosphere.js";
import { recordAt } from "../compiler/record-access.js";

/** Source-owned update cancellation, active-generation checks and GPU submission order. */
export function lowerProceduralSkyUpdate(
    context: LoweringContext,
): LoweredSource {
    const bodies = [
        [
            "isEnvironmentActive",
            "bool procedural_sky_environment_active(const std::shared_ptr<ProceduralSkyEnvironment>& environment)",
        ],
        [
            "assertEnvironmentActive",
            "void assert_procedural_sky_environment_active(const std::shared_ptr<ProceduralSkyEnvironment>& environment)",
        ],
        [
            "submitSkyCube",
            "void submit_procedural_sky_cube(const std::shared_ptr<ProceduralSkyEnvironment>& environment, const ProceduralSkyOptions& options)",
        ],
        [
            "updateProceduralSkyEnvironment",
            "js::Promise<bool> update_procedural_sky_environment(std::shared_ptr<ProceduralSkyEnvironment> environment, ProceduralSkyOptions options)",
        ],
    ];
    const source = bodies
        .map(([name, signature]) => {
            const { file, declaration } = context.functionDeclaration(
                proceduralSkyModule,
                name!,
            );
            const asynchronous = name === "updateProceduralSkyEnvironment";
            const bindings = new Map<string, PinnedBinding>();
            const bind = (
                name: string,
                cpp: string,
                type: PinnedBinding["type"] = "opaque",
                absentCpp?: string,
            ) =>
                bindings.set(name, {
                    cpp,
                    type,
                    ...(absentCpp ? { absentCpp } : {}),
                });
            bind("environment", "environment");
            bind("options", "options");
            bind("environment._disposed", "environment->disposed", "bool");
            bind(
                "environment._scene._z",
                "environment->scene.disposed",
                "bool",
            );
            bind(
                "environment._scene._envTextures",
                "environment->scene.state->environment_identity",
            );
            bind("environment._textures", "environment->texture_identity");
            bind("environment._revision", "environment->revision", "scalar");
            bind(
                "environment._yield",
                "environment->yield",
                "opaque",
                "!environment->yield",
            );
            bind("environment._scene", "environment->scene");
            bind(
                "environment._pipeline",
                "environment->gpu->dispatch.pipeline",
            );
            bind(
                "environment._bindGroup",
                "environment->gpu->dispatch.groups.at(0).group",
            );
            bind("environment._mipmaps", "environment->mipmaps");
            bind("scene", "environment->scene");
            bind("engine", "environment->engine");
            bind("device", "environment->engine->offscreen_run->device()");
            const faceSize = context.numericValue(
                context.variableInitializer(file, "FACE_SIZE"),
                file,
            );
            bind("FACE_SIZE", context.doubleLiteral(faceSize), "scalar");
            const calls = new Map<string, (args: readonly string[]) => string>([
                [
                    "isEnvironmentActive",
                    (args) =>
                        `procedural_sky_environment_active(${args.join(",")})`,
                ],
                [
                    "assertEnvironmentActive",
                    (args) =>
                        `assert_procedural_sky_environment_active(${args.join(",")})`,
                ],
                [
                    "validateOptions",
                    (args) =>
                        `validate_procedural_sky_options(${args.join(",")})`,
                ],
                [
                    "createPreScaledHarmonics",
                    (args) =>
                        `procedural_sky_prescaled_harmonics(${args.join(",")})`,
                ],
                [
                    "submitSkyCube",
                    (args) => `submit_procedural_sky_cube(${args.join(",")})`,
                ],
                [
                    "writeParameters",
                    () =>
                        "write_procedural_sky_parameters(environment->gpu, procedural_sky_parameters(options))",
                ],
                [
                    "_computeProceduralSkyIrradiance",
                    (args) =>
                        `compute_procedural_sky_irradiance(${args.join(",")})`,
                ],
                [
                    "textures.irradianceSH.set",
                    (args) => `environment->irradiance = ${args[0]}`,
                ],
                [
                    "textures.sphericalHarmonics.set",
                    (args) =>
                        `write_procedural_environment_harmonics(environment->scene.environment, ${args[0]})`,
                ],
                [
                    "_invalidateSceneUboCaches",
                    (args) =>
                        `invalidate_procedural_scene_uniforms(${args.join(",")})`,
                ],
                [
                    "recordPreparedMipmaps",
                    (args) => `record_compute_mipmaps(${args.join(",")})`,
                ],
                [
                    "device.createCommandEncoder",
                    () =>
                        "std::make_shared<pal::ComputeCommandEncoder>(std::shared_ptr<pal::OffscreenDevice>(environment->engine->offscreen_run, &environment->engine->offscreen_run->device()))",
                ],
                [
                    "encoder.beginComputePass",
                    () => 'encoder->begin_compute_pass("")',
                ],
                [
                    "pass.setPipeline",
                    (args) => `pass.set_pipeline(${args.join(",")})`,
                ],
                [
                    "pass.setBindGroup",
                    (args) =>
                        `pass.set_bind_group(static_cast<std::uint32_t>(${args[0]}),${args[1]})`,
                ],
                [
                    "pass.dispatchWorkgroups",
                    (args) =>
                        `pass.dispatch(${args.map((argument) => `static_cast<std::uint32_t>(${argument})`).join(",")})`,
                ],
                ["pass.end", () => "pass.end()"],
                ["Math.ceil", (args) => `std::ceil(${args.join(",")})`],
            ]);
            const scope: PinnedBodyScope = {
                bindings,
                calls,

                foldConditions: false,
                forOf(iterated, element) {
                    if (iterated !== "environment._mipmaps") return undefined;
                    return {
                        range: "environment->mipmaps",
                        bindings: new Map([
                            [element, { cpp: element, type: "opaque" }],
                        ]),
                    };
                },
                expression(node, lowerer) {
                    if (ts.isAwaitExpression(node))
                        return `(co_await ${lowerer.expression(node.expression)})`;
                    if (
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind ===
                            ts.SyntaxKind.QuestionQuestionToken
                    ) {
                        context.assertExpressionShape(
                            node,
                            "environment._yield ?? createYieldTask()",
                            "Sky update yield transport",
                        );
                        return "environment->yield ? environment->yield : std::function<js::Promise<js::PromiseVoid>()>{pal::procedural_sky_yield}";
                    }
                    if (ts.isArrowFunction(node)) {
                        context.assertExpressionShape(
                            node,
                            "() => environment._revision === revision && isEnvironmentActive(environment)",
                            "Sky update generation predicate",
                        );
                        if (ts.isBlock(node.body))
                            return context.contractError(
                                node,
                                "Expected sky generation expression predicate.",
                            );
                        return `[environment,revision](){return ${lowerer.expression(node.body)};}`;
                    }
                    return undefined;
                },
                statement(node, lowerer, indent) {
                    if (ts.isReturnStatement(node) && asynchronous)
                        return [
                            `${indent}co_return ${node.expression ? lowerer.expression(node.expression) : "false"};`,
                        ];
                    if (ts.isExpressionStatement(node)) {
                        const expression = unwrapExpression(node.expression);
                        if (
                            ts.isBinaryExpression(expression) &&
                            expression.left.getText(file) === "options"
                        ) {
                            context.assertExpressionShape(
                                expression,
                                "options = { ...options, sunDirection: [...options.sunDirection] }",
                                "Sky option snapshot",
                            );
                            // Native options and their direction already have value ownership.
                            return [];
                        }
                        if (
                            ts.isCallExpression(expression) &&
                            expression.expression.getText(file) ===
                                "device.queue.submit"
                        ) {
                            context.assertExpressionShape(
                                expression,
                                "device.queue.submit([encoder.finish()])",
                                "Sky command-buffer submission",
                            );
                            return [
                                `${indent}encoder->finish();`,
                                `${indent}encoder->submit();`,
                            ];
                        }
                    }
                    if (
                        ts.isVariableStatement(node) &&
                        node.declarationList.declarations.length === 1
                    ) {
                        const entry = node.declarationList.declarations[0]!;
                        if (!ts.isIdentifier(entry.name) || !entry.initializer)
                            return undefined;
                        const id = entry.name.text;
                        if (["scene", "engine", "device"].includes(id)) {
                            const expected =
                                id === "scene"
                                    ? "environment._scene"
                                    : id === "engine"
                                      ? "scene.surface.engine"
                                      : "engine._device";
                            context.assertExpressionShape(
                                entry.initializer,
                                expected,
                                "Sky GPU owner alias",
                            );
                            return [];
                        }
                        if (id === "encoder" || id === "pass") {
                            const value = lowerer.expression(entry.initializer);
                            bind(id, id);
                            return [`${indent}auto ${id}=${value};`];
                        }
                        if (id === "irradiance") {
                            const value = lowerer.expression(entry.initializer);
                            bind(id, "*irradiance", "f32", "!irradiance");
                            return [`${indent}const auto irradiance=${value};`];
                        }
                        if (id === "harmonics") {
                            const value = lowerer.expression(entry.initializer);
                            bind(id, id, "f32");
                            return [`${indent}const auto ${id}=${value};`];
                        }
                        if (id === "textures") {
                            context.assertExpressionShape(
                                entry.initializer,
                                "environment._textures",
                                "Sky update facade alias",
                            );
                            return [];
                        }
                    }
                    return undefined;
                },
                returnValue: (expression, lowerer) =>
                    expression ? lowerer.expression(expression) : "",
            };
            return `// ${context.provenance(proceduralSkyModule, name!)}\n${signature} {\n${lowerPinnedBody(file, declaration.body!.statements, scope)}\n}\n`;
        })
        .join("\n");
    const extras = context.functionDeclaration(
        "src/scene/scene-ubo-extras.ts",
        "_invalidateSceneUboCaches",
    );
    const invalidate = lowerPinnedBody(
        extras.file,
        extras.declaration.body!.statements,
        {
            bindings: new Map([
                [
                    "task._sceneUboCacheKey",
                    {
                        cpp: "static_cast<bool>(task.scene_uniforms)",
                        type: "bool",
                    },
                ],
            ]),
            calls: new Map(),
            statement(node, lowerer, indent) {
                if (ts.isForOfStatement(node)) {
                    context.assertExpressionShape(
                        node.expression,
                        "scene._frameGraph._tasks",
                        "Sky uniform task ownership",
                    );
                    return [
                        `${indent}for(const auto handle:scene.tasks){`,
                        `${indent}    auto& task=${recordAt("scene.engine->frame_tasks", "handle")};`,
                        ...lowerer.statements(
                            ts.isBlock(node.statement)
                                ? node.statement.statements
                                : [node.statement],
                            indent + "    ",
                        ),
                        `${indent}}`,
                    ];
                }
                if (
                    ts.isExpressionStatement(node) &&
                    context.expressionMatchesShape(
                        node.expression,
                        "task._sceneUboCacheKey.length = 0",
                    )
                )
                    return [`${indent}task.scene_uniforms->cache={};`];
                return undefined;
            },
        },
    );
    return {
        modulePath: proceduralSkyModule,
        symbolName: "updateProceduralSkyEnvironment",
        header: "",
        source: `#include <bblite/pal_procedural_sky_environment.hpp>\n#include <bblite/pal_procedural_sky.hpp>\nnamespace bbl {
static void write_procedural_environment_harmonics(EnvironmentState& target, const std::vector<float>& source) {
    if(source.size()!=target.spherical_harmonics.size()*4) throw std::runtime_error("Invalid sky harmonic storage.");
    for(std::size_t i=0;i<target.spherical_harmonics.size();++i) target.spherical_harmonics[i]={source[i*4],source[i*4+1],source[i*4+2]};
}
static void invalidate_procedural_scene_uniforms(Scene& scene) {\n${invalidate}\n}
${source}\n}\n`,
    };
}
