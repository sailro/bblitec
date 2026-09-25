import ts from "typescript";
import { textureOwnershipCpp } from "./compute-texture-lowerer.js";
import { stringLiteral } from "../cpp-literals.js";
import {
    type LoweredSource,
    type LoweringContext,
    unwrapExpression,
} from "./context.js";
import {
    lowerPinnedBody,
    type PinnedBodyScope,
} from "./pinned-body-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { proceduralSkyModule } from "./procedural-sky-atmosphere.js";

/** Source lifetime/cancellation with native resource and captured-cell representations. */
export function lowerProceduralSkyLoader(
    context: LoweringContext,
    descriptorCpp: string,
    descriptorSource = "",
): LoweredSource {
    const { file, declaration } = context.functionDeclaration(
        proceduralSkyModule,
        "loadProceduralSkyEnvironment",
    );
    const scopeFor = (asyncBody: boolean): PinnedBodyScope => {
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
        bind("scene", "state->scene");
        bind("scene._z", "state->scene.disposed", "bool");
        bind("scene._built", "state->scene.state->source_built", "bool");
        bind(
            "scene._envTextures",
            "state->scene.state->environment_identity",
            "scalar",
        );
        bind("options", "options");
        bind("options.brdfUrl", "brdf_path");
        bind("generation", "state->generation");
        bind("generation._disposed", "state->generation->disposed", "bool");
        bind(
            "generation._current",
            "state->generation->current",
            "opaque",
            "!state->generation->current",
        );
        bind("current", "current", "opaque", "!current");
        bind("current._disposed", "current->disposed", "bool");
        bind("current._revision", "current->revision", "scalar");
        bind("current._textures", "current->texture_identity", "scalar");
        bind("engine", "state->engine");
        bind("brdfImage", "state->image", "opaque", "!state->image");
        bind("brdfLut", "state->brdf", "opaque", "!state->brdf");
        bind("texture", "state->texture", "opaque", "!state->texture");
        bind(
            "parameterBuffer",
            "state->parameter_buffer",
            "opaque",
            "!state->parameter_buffer",
        );
        bind("textureRetained", "state->texture_retained", "bool");
        bind("brdfRetained", "state->brdf_retained", "bool");
        bind("irradiance", "*irradiance", "f32", "!irradiance");
        bind("image", "image");
        bind("imageReady", "imageReady");
        bind("textures", "textures");
        bind("environment", "environment");
        bind("mipmaps", "mipmaps");
        bind(
            "FACE_SIZE",
            context.doubleLiteral(
                context.numericValue(
                    context.variableInitializer(file, "FACE_SIZE"),
                    file,
                ),
            ),
            "scalar",
        );
        for (const [name, member] of [
            ["closeImage", "close_image"],
            ["isPending", "is_pending"],
            ["assertPending", "assert_pending"],
            ["dispose", "dispose"],
        ])
            bind(name!, `state->${member}`);
        const calls = new Map<string, (args: readonly string[]) => string>([
            [
                "validateOptions",
                (args) => `validate_procedural_sky_options(${args.join(",")})`,
            ],
            [
                "states.has",
                () =>
                    "static_cast<bool>(procedural_sky_generation(state->scene))",
            ],
            ["states.get", () => "procedural_sky_generation(state->scene)"],
            [
                "states.set",
                () =>
                    "js::realm_scratch<ProceduralSkyRegistry>().scenes.set(state->scene.state,state->generation)",
            ],
            [
                "states.delete",
                () =>
                    "js::realm_scratch<ProceduralSkyRegistry>().scenes.erase(state->scene.state)",
            ],
            ["closeImage", () => "state->close_image()"],
            ["isPending", () => "state->is_pending()"],
            ["assertPending", () => "state->assert_pending()"],
            ["dispose", () => "state->dispose()"],
            ["image.close", () => "image->close()"],
            [
                "brdfImage.close",
                () => "(state->image ? state->image->close() : void())",
            ],
            [
                "parameterBuffer.destroy",
                () =>
                    "(state->parameter_buffer ? state->parameter_buffer->destroy() : void())",
            ],
            ["texture.destroy", () => "state->texture->destroy()"],
            [
                "brdfLut.destroy",
                () => "state->brdf->bytes = std::vector<std::uint8_t>{}",
            ],
            [
                "releaseGPUTexture",
                (args) =>
                    args[0] === "state->texture"
                        ? "state->texture_lease.reset()"
                        : "state->brdf_lease.reset()",
            ],
            [
                "scene._disposables.push",
                (args) =>
                    `state->scene.disposables.push_back(${args.join(",")})`,
            ],
            [
                "loadBrdfImage",
                (args) => `load_procedural_sky_brdf(${args.join(",")})`,
            ],
            [
                "_computeProceduralSkyIrradiance",
                (args) =>
                    `compute_procedural_sky_irradiance(${args.join(",")})`,
            ],
            [
                "rgbd.decodeBrdfPng",
                () => "std::make_shared<TextureData>(image->encoded)",
            ],
            ["mipmaps.push", (args) => `mipmaps.push_back(${args.join(",")})`],
            [
                "prepareMipmaps",
                (args) =>
                    `prepare_compute_mipmaps(${args[0]},${args[1]},state->gpu->texture_descriptor,static_cast<std::uint32_t>(${args[2]}))`,
            ],
            [
                "createPreScaledHarmonics",
                (args) =>
                    `procedural_sky_prescaled_harmonics(${args.join(",")})`,
            ],
            [
                "assembleEnvironmentTextures",
                (args) =>
                    `procedural_sky_texture_facade(state->gpu,${args[1]},${args[2]},${args[3]},${args[5]})`,
            ],
            [
                "submitSkyCube",
                (args) => `submit_procedural_sky_cube(${args.join(",")})`,
            ],
        ]);
        const scope: PinnedBodyScope = {
            bindings,
            calls,

            foldConditions: false,
            callShapes: new Map([
                ["isPending", "bool"],
                ["states.has", "bool"],
            ]),
            expression(node, lowerer) {
                if (
                    node.kind === ts.SyntaxKind.NullKeyword ||
                    (ts.isIdentifier(node) && node.text === "undefined")
                )
                    return "{}";
                if (ts.isAwaitExpression(node))
                    return `(co_await ${lowerer.expression(node.expression)})`;
                if (
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.QuestionQuestionToken
                ) {
                    context.assertExpressionShape(
                        node,
                        "options._yield ?? createYieldTask()",
                        "Sky loader yield transport",
                    );
                    return "std::function<js::Promise<js::PromiseVoid>()>{pal::procedural_sky_yield}";
                }
                if (
                    ts.isCallExpression(node) &&
                    node.expression.getText(file) === "Promise.all"
                ) {
                    const values = node.arguments[0];
                    if (!values || !ts.isArrayLiteralExpression(values))
                        return context.contractError(
                            node,
                            "Sky Promise.all needs an ordered input tuple.",
                        );
                    return `js::promise_all_tuple(std::tuple{${values.elements.map((value) => lowerer.expression(value)).join(",")}})`;
                }
                if (
                    ts.isCallExpression(node) &&
                    node.expression.getText(file) ===
                        "loadBrdfImage(options.brdfUrl).then"
                ) {
                    const callback = node.arguments[0];
                    if (
                        !callback ||
                        !ts.isArrowFunction(callback) ||
                        !ts.isBlock(callback.body)
                    )
                        return context.contractError(
                            node,
                            "Sky image readiness callback changed.",
                        );
                    const code = lowerPinnedBody(
                        file,
                        callback.body.statements,
                        scopeFor(false),
                    );
                    return `load_procedural_sky_brdf(brdf_path).then(js::make_closure(std::tuple{state},[](auto& capture,const std::shared_ptr<ProceduralSkyImage>& image){const auto state=std::get<0>(capture);\n${code}\n}))`;
                }
                return undefined;
            },
            statement(node, lowerer, indent) {
                if (ts.isTryStatement(node)) {
                    const lines = [
                        `${indent}try {`,
                        ...lowerer.statements(
                            node.tryBlock.statements,
                            indent + "    ",
                        ),
                    ];
                    if (node.catchClause) {
                        lines.push(
                            `${indent}} catch (...) {`,
                            ...lowerer.statements(
                                node.catchClause.block.statements,
                                indent + "    ",
                            ),
                            `${indent}}`,
                        );
                    } else if (node.finallyBlock) {
                        // This source finally owns no return/await; execute it on both exits.
                        const finallyLines = lowerer.statements(
                            node.finallyBlock.statements,
                            indent + "    ",
                        );
                        lines.push(
                            `${indent}} catch (...) {`,
                            ...finallyLines,
                            `${indent}    throw;`,
                            `${indent}}`,
                            ...lowerer.statements(
                                node.finallyBlock.statements,
                                indent,
                            ),
                        );
                    } else
                        return context.contractError(
                            node,
                            "Sky try block has no handler.",
                        );
                    return lines;
                }
                if (ts.isThrowStatement(node)) return [`${indent}throw;`];
                if (ts.isReturnStatement(node))
                    return [
                        `${indent}${asyncBody ? "co_return" : "return"}${node.expression ? " " + lowerer.expression(node.expression) : ""};`,
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
                            "Sky load option snapshot",
                        );
                        return [];
                    }
                    if (
                        ts.isBinaryExpression(expression) &&
                        expression.left.getText(file) === "texture" &&
                        ts.isCallExpression(expression.right)
                    ) {
                        context.assertExpressionShape(
                            expression.right,
                            "device.createTexture({size:[FACE_SIZE,FACE_SIZE,6],mipLevelCount:mipLevelCount(FACE_SIZE,FACE_SIZE),format:'rgba16float',usage:TU.TEXTURE_BINDING|TU.STORAGE_BINDING|TU.RENDER_ATTACHMENT})",
                            "Sky cube texture descriptor",
                        );
                        return [
                            `${indent}state->gpu=co_await create_procedural_sky_gpu(state->engine,${descriptorCpp});`,
                            `${indent}state->texture=state->gpu->texture;`,
                            `${indent}state->parameter_buffer=state->gpu->parameter_buffer;`,
                            `${indent}state->texture_source=procedural_sky_texture_source(state->engine->offscreen_run,state->texture,sky_acquire_gpu_texture_source,sky_release_gpu_texture_source);`,
                            // Native validation adds an await inside the pin's synchronous
                            // allocation block. Re-enter its source guard after retaining all
                            // completed resources, so cancellation can dispose them safely.
                            `${indent}state->assert_pending();`,
                        ];
                    }
                    if (
                        ts.isBinaryExpression(expression) &&
                        expression.left.getText(file) === "parameterBuffer" &&
                        ts.isCallExpression(expression.right)
                    ) {
                        context.assertExpressionShape(
                            expression.right,
                            "createEmptyUniformBuffer(engine,32)",
                            "Sky uniform allocation",
                        );
                        return [
                            `${indent}state->parameter_buffer=state->gpu->parameter_buffer;`,
                        ];
                    }
                    if (
                        ts.isBinaryExpression(expression) &&
                        expression.left.getText(file) === "scene._envTextures"
                    ) {
                        if (
                            expression.right.kind ===
                                ts.SyntaxKind.Identifier &&
                            expression.right.getText(file) === "textures"
                        )
                            return [
                                `${indent}state->scene.environment=textures->value;`,
                                `${indent}state->scene.state->environment_identity=textures->identity;`,
                            ];
                        context.assertExpressionShape(
                            expression.right,
                            "undefined",
                            "Sky unpublication",
                        );
                        return [
                            `${indent}state->scene.state->environment_identity=0;`,
                            `${indent}state->scene.environment=EnvironmentState{};`,
                        ];
                    }
                    if (ts.isCallExpression(expression)) {
                        const name = expression.expression.getText(file);
                        if (name === "acquireGPUTexture") {
                            if (
                                !["texture", "brdfLut"].includes(
                                    expression.arguments[0]?.getText(file) ??
                                        "",
                                )
                            )
                                return context.contractError(
                                    expression,
                                    "Unrepresented sky retained texture.",
                                );
                            const texture =
                                expression.arguments[0]!.getText(file) ===
                                "texture";
                            return texture
                                ? [
                                      `${indent}state->texture_lease=std::make_shared<GpuTextureLease>(state->texture_source);`,
                                  ]
                                : [
                                      `${indent}state->brdf_source=procedural_sky_texture_source(state->engine->offscreen_run,std::make_shared<ProceduralSkyBrdfAllocation>(state->brdf),sky_acquire_gpu_texture_source,sky_release_gpu_texture_source);`,
                                      `${indent}state->brdf_lease=std::make_shared<GpuTextureLease>(state->brdf_source);`,
                                  ];
                        }
                        if (name === "registerEnvSceneUniforms") {
                            context.assertExpressionShape(
                                expression,
                                "registerEnvSceneUniforms(scene)",
                                "Sky environment UBO registration",
                            );
                            return []; // environment:ibl reaches the source-derived environment UBO writer.
                        }
                        if (name === "scene._disposables.splice") {
                            context.assertExpressionShape(
                                expression,
                                "scene._disposables.splice(index,1)",
                                "Sky failed load removes its own disposer",
                            );
                            return [
                                `${indent}state->scene.disposables.erase(state->scene.disposables.begin()+static_cast<std::ptrdiff_t>(index));`,
                            ];
                        }
                    }
                }
                if (
                    ts.isVariableStatement(node) &&
                    node.declarationList.declarations.length === 1
                ) {
                    const entry = node.declarationList.declarations[0]!;
                    if (!entry.initializer) return undefined;
                    if (ts.isArrayBindingPattern(entry.name)) {
                        if (
                            entry.name.elements
                                .map((element) => element.getText(file))
                                .join(",") !== "irradiance,image"
                        )
                            return context.contractError(
                                entry.name,
                                "Sky parallel load results changed.",
                            );
                        return [
                            `${indent}const auto [irradiance,image]=${lowerer.expression(entry.initializer)};`,
                        ];
                    }
                    if (!ts.isIdentifier(entry.name)) return undefined;
                    const id = entry.name.text;
                    if (id === "states") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "(_skyScenes ??= new WeakMap())",
                            "Sky weak scene index",
                        );
                        return [];
                    }
                    if (id === "engine") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "scene.surface.engine",
                            "Sky engine ownership",
                        );
                        return [];
                    }
                    if (id === "generation") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "{_current:null,_disposed:false}",
                            "Sky generation initial state",
                        );
                        return [
                            `${indent}state->generation=js::make_gc_shared<ProceduralSkyGeneration>();`,
                        ];
                    }
                    if (
                        [
                            "brdfImage",
                            "brdfLut",
                            "texture",
                            "parameterBuffer",
                            "textureRetained",
                            "brdfRetained",
                        ].includes(id)
                    )
                        return [
                            `${indent}${lowerer.expression(entry.name)}=${lowerer.expression(entry.initializer)};`,
                        ];
                    if (
                        [
                            "closeImage",
                            "isPending",
                            "assertPending",
                            "dispose",
                        ].includes(id)
                    ) {
                        const arrow = unwrapExpression(entry.initializer);
                        if (!ts.isArrowFunction(arrow))
                            return context.contractError(
                                arrow,
                                "Expected sky lifecycle closure.",
                            );
                        const nested = scopeFor(false),
                            { returnValue, ...numeric } = nested;
                        void returnValue;
                        const body = ts.isBlock(arrow.body)
                            ? lowerPinnedBody(
                                  file,
                                  arrow.body.statements,
                                  nested,
                              )
                            : `return ${new PinnedNumericLowerer(file, numeric).expression(arrow.body)};`;
                        return [
                            `${indent}${lowerer.expression(entry.name)}=js::make_closure(std::tuple{state},[](auto& capture){const auto state=std::get<0>(capture);\n${body}\n${indent}});`,
                        ];
                    }
                    if (id === "device") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "engine._device",
                            "Sky native GPU owner",
                        );
                        return [];
                    }
                    if (id === "rgbd") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "await import('./rgbd-decode.js')",
                            "Sky decoder module load",
                        );
                        return [
                            `${indent}(void)co_await js::Promise<js::PromiseVoid>::resolved({});`,
                        ];
                    }
                    if (id === "module") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "device.createShaderModule({code:SKY_CUBE_WGSL})",
                            "Sky shader module",
                        );
                        return [];
                    }
                    if (id === "pipeline") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "device.createComputePipeline({layout:'auto',compute:{module,entryPoint:'main'}})",
                            "Sky pipeline",
                        );
                        return [];
                    }
                    if (id === "bindGroup") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView({dimension:'2d-array',baseMipLevel:0,mipLevelCount:1})},{binding:1,resource:{buffer:parameterBuffer}}]})",
                            "Sky binding layout",
                        );
                        return [];
                    }
                    if (id === "mipmaps") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "[]",
                            "Sky prepared face mipmaps",
                        );
                        return [
                            `${indent}std::vector<PreparedComputeMipmaps> mipmaps;`,
                        ];
                    }
                    if (id === "environment") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "{_scene:scene,_texture:texture,_parameterBuffer:parameterBuffer,_bindGroup:bindGroup,_pipeline:pipeline,_mipmaps:mipmaps,_textures:textures,_disposed:false,_revision:0,_yield:options._yield}",
                            "Sky environment owned record",
                        );
                        return [
                            `${indent}auto environment=js::make_gc_shared<ProceduralSkyEnvironment>();`,
                            `${indent}environment->scene=state->scene; environment->engine=state->engine; environment->gpu=state->gpu;`,
                            `${indent}environment->mipmaps=std::move(mipmaps); environment->texture_identity=textures->identity; environment->irradiance=textures->irradiance;`,
                        ];
                    }
                    if (id === "index") {
                        context.assertExpressionShape(
                            entry.initializer,
                            "scene._disposables.indexOf(dispose)",
                            "Sky disposer identity",
                        );
                        lowerer.bindLocal(entry.name, {
                            cpp: id,
                            type: "scalar",
                        });
                        return [
                            `${indent}const auto found=std::find(state->scene.disposables.begin(),state->scene.disposables.end(),state->dispose);`,
                            `${indent}const double index=found==state->scene.disposables.end() ? -1.0 : static_cast<double>(found-state->scene.disposables.begin());`,
                        ];
                    }
                    if (["imageReady", "textures", "current"].includes(id))
                        return [
                            `${indent}const auto ${id}=${lowerer.expression(entry.initializer)};`,
                        ];
                }
                return undefined;
            },
            returnValue: (expression, lowerer) =>
                expression ? lowerer.expression(expression) : "",
        };
        return scope;
    };
    const body = lowerPinnedBody(
        file,
        declaration.body!.statements,
        scopeFor(true),
    );
    return {
        modulePath: proceduralSkyModule,
        symbolName: "loadProceduralSkyEnvironment",
        header: "",
        source: `#include <bblite/pal_procedural_sky_environment.hpp>
namespace bbl {
${descriptorSource}
${textureOwnershipCpp(context, "sky_")}
${lowerBrdfImage(context)}
// ${context.provenance(proceduralSkyModule, "loadProceduralSkyEnvironment")}
js::Promise<std::shared_ptr<ProceduralSkyEnvironment>> load_procedural_sky_environment(Scene scene,ProceduralSkyOptions options,std::string brdf_path) {
    auto state=js::make_gc_shared<ProceduralSkyLoadState>();state->scene=scene;
    state->engine=scene.engine ? scene.engine->realm_owner.lock() : nullptr;
    if(!state->engine) throw std::runtime_error("Procedural sky requires a realm-owned engine.");
${body}
}
}
`,
    };
}

/** Network/image codecs are PAL calls; branch, error and async ordering stay pinned. */
function lowerBrdfImage(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        "src/loader-env/env-helpers.ts",
        "loadBrdfImage",
    );
    const bindings = new Map<string, PinnedBinding>([
        ["url", { cpp: "url", type: "opaque" }],
        [
            "response.ok",
            { cpp: "pal::http_response_ok(response)", type: "bool" },
        ],
        ["response.status", { cpp: "response->status", type: "scalar" }],
    ]);
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings,
        calls: new Map([
            ["fetch", () => "pal::fetch_packaged(url,url)"],
            ["response.blob", () => "pal::http_response_buffer(response)"],
        ]),
        expression(node, lowerer) {
            if (ts.isAwaitExpression(node))
                return `(co_await ${lowerer.expression(node.expression)})`;
            if (
                ts.isCallExpression(node) &&
                node.expression.getText(file) === "createImageBitmap"
            ) {
                context.assertExpressionShape(
                    node.arguments[1]!,
                    "{premultiplyAlpha:'none',colorSpaceConversion:'none'}",
                    "Sky BRDF decode options",
                );
                return `js::Promise<std::shared_ptr<ProceduralSkyImage>>::resolved(procedural_sky_decode_image(${lowerer.expression(node.arguments[0]!)}))`;
            }
            return undefined;
        },
        statement(node, lowerer, indent) {
            if (ts.isVariableStatement(node)) {
                const entry = node.declarationList.declarations[0];
                if (
                    entry &&
                    entry.name.getText(file) === "response" &&
                    entry.initializer
                )
                    return [
                        `${indent}const auto response=${lowerer.expression(entry.initializer)};`,
                    ];
            }
            if (ts.isTryStatement(node)) {
                if (
                    !node.catchClause ||
                    node.catchClause.block.statements.length
                )
                    return context.contractError(
                        node,
                        "Sky image decoder catch changed.",
                    );
                return [
                    `${indent}try {`,
                    ...lowerer.statements(
                        node.tryBlock.statements,
                        indent + "    ",
                    ),
                    `${indent}} catch(...) {}`,
                ];
            }
            if (ts.isReturnStatement(node))
                return [
                    `${indent}co_return ${lowerer.expression(node.expression!)};`,
                ];
            if (ts.isThrowStatement(node)) {
                const error = unwrapExpression(node.expression);
                if (
                    !ts.isNewExpression(error) ||
                    error.expression.getText(file) !== "Error"
                )
                    return context.contractError(
                        node,
                        "Sky image diagnostic changed.",
                    );
                const message = error.arguments?.[0];
                if (!message || !ts.isTemplateExpression(message))
                    return context.contractError(
                        node,
                        "Expected sky URL diagnostic template.",
                    );
                const pieces = [
                    `std::string{${stringLiteral(message.head.text)}}`,
                ];
                for (const span of message.templateSpans) {
                    const value = span.expression.getText(file);
                    if (value === "url") pieces.push("url");
                    else if (value === "response.status")
                        pieces.push("js::number_to_string(response->status)");
                    else {
                        context.assertExpressionShape(
                            span.expression,
                            "response.headers.get('content-type') ?? ''",
                            "Packaged response has no content-type header",
                        );
                        pieces.push("std::string{}");
                    }
                    pieces.push(
                        `std::string{${stringLiteral(span.literal.text)}}`,
                    );
                }
                return [
                    `${indent}throw std::runtime_error(${pieces.join("+")});`,
                ];
            }
            return undefined;
        },
    });
    return `static js::Promise<std::shared_ptr<ProceduralSkyImage>> load_procedural_sky_brdf(std::string url){\n${body}\n}`;
}
