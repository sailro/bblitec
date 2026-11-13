/**
 * Parallax occlusion mapping, from the pin's own module
 * (`src/material/parallax/parallax-occlusion.ts`).
 *
 * Both families keep the setter's validated copy on the material record
 * (`MaterialRecord::parallax_occlusion`); the validation, the height-texture
 * reads both extensions detect and bind with, and the uniform writer they
 * fill their blocks with are lowered from their declarations here. The
 * families' extensions (`pbrParallaxOcclusionExt`, `stdParallaxOcclusionExt`)
 * compose at generation.
 */
import ts from "typescript";
import { numberPredicateCpp } from "../compiler/number-intrinsics.js";
import { recordAt } from "../compiler/record-access.js";
import { conditionalExpression, selectionArms } from "../compiler/syntax.js";
import type { LoweredSource, LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { standardFeatureRecordSources } from "./standard-material-record-sources.js";

const MODULE = "src/material/parallax/parallax-occlusion.ts";

/**
 * Props both extensions' detection reads as active, standing for any a
 * program sets at composition: only their presence and a nonzero
 * `heightScale` compose.
 */
export const ACTIVE_PARALLAX_OCCLUSION = {
    heightTexture: {},
    heightScale: 1,
} as const;

/** The props members a body reads off `owner` (`props.heightScale`). */
function propsBindings(
    local: string,
    owner: string,
): [string, PinnedBinding][] {
    const optional = (
        member: string,
        field: string,
        type: PinnedBinding["type"] = "scalar",
    ): [string, PinnedBinding] => [
        `${local}.${member}`,
        { cpp: `(*${owner}.${field})`, type, nullish: `!${owner}.${field}` },
    ];
    return [
        optional("heightScale", "height_scale"),
        optional("heightCenter", "height_center"),
        optional("heightChannel", "height_channel", "string"),
        optional("minSteps", "min_steps"),
        optional("maxSteps", "max_steps"),
        optional("refinementSteps", "refinement_steps"),
        [
            `${local}.heightTexture`,
            {
                cpp: `${owner}.height_texture`,
                type: "opaque",
                absentCpp: `!${owner}.height_texture.has_image()`,
            },
        ],
    ];
}

/**
 * The height texture's members the bodies read through their
 * `const texture = props.heightTexture` local. Its format is
 * `parallax_texture_format`'s, which names an uploaded RGBA8 image's and
 * refuses any other source, so no `_sampleType` (a render target's) is
 * ever read.
 */
function heightTextureBindings(
    local: string,
    texture: string,
): [string, PinnedBinding][] {
    const transform = (
        member: string,
        field: string,
    ): [string, PinnedBinding] => [
        `${local}.${member}`,
        // The record holds the value an absent member defaults to, which
        // every read the pin makes takes the same way.
        {
            cpp: `${texture}.uv_transform.${field}`,
            type: "scalar",
            nullish: "false",
            absentCpp: "false",
        },
    ];
    return [
        transform("uScale", "u_scale"),
        transform("vScale", "v_scale"),
        transform("uOffset", "u_offset"),
        transform("vOffset", "v_offset"),
        transform("uAng", "u_ang"),
        [
            `${local}.texture.format`,
            {
                cpp: `parallax_texture_format(${texture})`,
                type: "string",
            },
        ],
        [
            `${local}._sampleType`,
            { cpp: "", type: "string", staticallyAbsent: true },
        ],
        [`${local}.invertY`, { cpp: `${texture}.uv_invert_y`, type: "bool" }],
    ];
}

const numberCalls: PinnedNumericScope["calls"] = new Map([
    [
        "Number.isFinite",
        (args) => `${numberPredicateCpp("isFinite")!}(${args[0]})`,
    ],
    [
        "Number.isInteger",
        (args) => `${numberPredicateCpp("isInteger")!}(${args[0]})`,
    ],
    [
        "Math.fround",
        (args) => `static_cast<double>(static_cast<float>(${args[0]}))`,
    ],
]);

/** `props`, the pin's `ParallaxOcclusionProps` parameter. */
const propsParameter = {
    pinned: "props",
    kind: "record",
    cpp: "props",
    annotation: "ParallaxOcclusionProps",
    cppType: "ParallaxOcclusionProps",
    binding: { cpp: "props", type: "opaque" },
} as const;

/** `_writeParallaxUniforms`, with and without its base transform. */
function lowerUniformWriter(
    context: LoweringContext,
    cppName: string,
    base: boolean,
): string {
    return lowerPinnedFunction(
        context,
        MODULE,
        "_writeParallaxUniforms",
        [
            {
                pinned: "data",
                kind: "f32Buffer",
                cpp: "data",
                cppType: "std::span<float>",
            },
            propsParameter,
            { pinned: "heightOffset", kind: "number", cpp: "height_offset" },
            {
                pinned: "samplingOffset",
                kind: "number",
                cpp: "sampling_offset",
            },
            { pinned: "matrixOffset", kind: "number", cpp: "matrix_offset" },
            {
                pinned: "translationOffset",
                kind: "number",
                cpp: "translation_offset",
            },
            base
                ? {
                      pinned: "baseTransform",
                      kind: "numberArray",
                      cpp: "base_transform",
                      cppType: "std::array<float, 4>",
                      optional: true,
                  }
                : {
                      pinned: "baseTransform",
                      kind: "numberArray",
                      cpp: "base_transform",
                      absent: true,
                  },
            {
                pinned: "invertY",
                kind: "boolean",
                cpp: "invert_y",
                pinnedDefault: true,
            },
        ],
        {
            cppName,
            returns: "void",
            inline: true,
            memberBindings: new Map([
                ...propsBindings("props", "props"),
                ...heightTextureBindings("texture", "props.height_texture"),
                // The base transform's four lanes, read through `?.[n]`:
                // the Standard family hands its own UV block's first vec4
                // (floats), the PBR one nothing.
                ...[0, 1, 2, 3].map((lane): [string, PinnedBinding] => [
                    `baseTransform?.[${lane}]`,
                    base
                        ? {
                              cpp: `static_cast<double>(base_transform[${lane}])`,
                              type: "scalar",
                          }
                        : { cpp: "", type: "scalar", staticallyAbsent: true },
                ]),
            ]),
        },
    );
}

/** A getter's `<test> ? <texture> : undefined`, as a nullable pointer. */
function textureOrNothing(
    context: LoweringContext,
    texture: (lowerer: PinnedNumericLowerer, node: ts.Expression) => string,
): (
    lowerer: PinnedNumericLowerer,
    expression: ts.Expression | undefined,
) => string {
    return (lowerer, expression) => {
        const selection = expression && conditionalExpression(expression);
        const [present, absent] = selection ? selectionArms(selection) : [];
        if (
            !selection ||
            !present ||
            !absent ||
            !context.expressionMatchesShape(absent, "undefined")
        )
            return context.contractError(
                expression ?? context.sourceFile(MODULE),
                "Expected the parallax height getter's `? texture : undefined`.",
            );
        return `(${lowerer.truthTest(selection.condition)} ? ${texture(lowerer, present)} : nullptr)`;
    };
}

/** `_getParallaxHeightTexture`: the bound height texture, null while disabled. */
function lowerHeightTexture(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        MODULE,
        "_getParallaxHeightTexture",
        [
            {
                pinned: "material",
                kind: "record",
                cpp: "material",
                annotation:
                    "{ readonly _parallaxOcclusion?: ParallaxOcclusionProps }",
                cppType: "MaterialRecord",
                binding: { cpp: "material", type: "opaque" },
            },
        ],
        {
            cppName: "parallax_height_texture",
            inline: true,
            returns: {
                type: "const TextureData*",
                value: textureOrNothing(context, (_lowerer, node) => {
                    context.assertExpressionShape(
                        node,
                        "props.heightTexture",
                        "Parallax height texture",
                    );
                    return "&material.parallax_occlusion->height_texture";
                }),
            },
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "material._parallaxOcclusion",
                    {
                        cpp: "(*material.parallax_occlusion)",
                        type: "opaque",
                        absentCpp: "!material.parallax_occlusion",
                    },
                ],
                ...propsBindings("props", "(*material.parallax_occlusion)"),
            ]),
        },
    );
}

/**
 * `_getStandardParallaxHeightTexture`: the height texture where a Standard
 * surface texture would sample it. Its surface reads are the feature
 * derivation's own record sources.
 */
function lowerStandardHeightTexture(context: LoweringContext): string {
    const surfaces = new Map<string, PinnedBinding>(
        [
            "diffuseTexture",
            "_emissiveTexture",
            "_bumpTexture",
            "_specularTexture",
            "_ambientTexture",
            "_lightmapTexture",
            "_opacityTexture",
        ].map((property) => {
            const source = standardFeatureRecordSources[property];
            if (!source)
                context.contractError(
                    context.sourceFile(MODULE),
                    `The Standard record carries no '${property}' presence.`,
                );
            return [
                `material.${property}`,
                { cpp: `(${source})`, type: "bool" },
            ];
        }),
    );
    return lowerPinnedFunction(
        context,
        MODULE,
        "_getStandardParallaxHeightTexture",
        [
            {
                pinned: "material",
                kind: "record",
                cpp: "material",
                annotation: "StandardMaterialProps",
                cppType: "MaterialRecord",
                binding: { cpp: "material", type: "opaque" },
            },
        ],
        {
            cppName: "standard_parallax_height_texture",
            inline: true,
            returns: {
                type: "const TextureData*",
                value: textureOrNothing(context, (_lowerer, node) => {
                    context.assertExpressionShape(
                        node,
                        "height",
                        "Standard parallax height texture",
                    );
                    return "height";
                }),
            },
            memberBindings: surfaces,
            statement(statement, lowerer, indent) {
                if (!ts.isVariableStatement(statement)) return undefined;
                const [declaration] = statement.declarationList.declarations;
                if (
                    statement.declarationList.declarations.length !== 1 ||
                    !declaration ||
                    !ts.isIdentifier(declaration.name) ||
                    declaration.name.text !== "height" ||
                    !declaration.initializer ||
                    !context.expressionMatchesShape(
                        declaration.initializer,
                        "_getParallaxHeightTexture(material)",
                    )
                )
                    return undefined;
                lowerer.bindLocal(declaration.name, {
                    cpp: "height",
                    type: "opaque",
                    absentCpp: "!height",
                });
                return [
                    `${indent}const TextureData* const height = parallax_height_texture(material);`,
                ];
            },
        },
    );
}

/** `validateSteps` beside it. */
function lowerValidateSteps(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        MODULE,
        "validateSteps",
        [
            { pinned: "value", kind: "number", cpp: "value" },
            { pinned: "name", kind: "string", cpp: "name" },
            { pinned: "maximum", kind: "number", cpp: "maximum" },
        ],
        {
            cppName: "validate_parallax_steps",
            inline: true,
            returns: "void",
            calls: numberCalls,
        },
    );
}

/** `_copyParallaxOcclusionProps`: validates, then copies. */
function lowerCopyProps(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        MODULE,
        "_copyParallaxOcclusionProps",
        [propsParameter],
        {
            cppName: "copy_parallax_occlusion_props",
            inline: true,
            returns: {
                type: "ParallaxOcclusionProps",
                value: (_lowerer, expression) => {
                    if (!expression)
                        return context.contractError(
                            context.sourceFile(MODULE),
                            "Expected the parallax props copy.",
                        );
                    context.assertExpressionShape(
                        expression,
                        "{ ...props }",
                        "Parallax props copy",
                    );
                    return "props";
                },
            },
            calls: new Map([
                ...numberCalls,
                [
                    "validateSteps",
                    (args) => `validate_parallax_steps(${args.join(", ")})`,
                ],
            ]),
            memberBindings: new Map([
                ...propsBindings("props", "props"),
                [
                    "props?.heightTexture",
                    {
                        cpp: "props.height_texture",
                        type: "opaque",
                        absentCpp: "!props.height_texture.has_image()",
                    },
                ],
                ...heightTextureBindings("texture", "props.height_texture"),
            ]),
        },
    );
}

/** The lowered module's functions, for `upstream/parallax_occlusion.hpp`. */
export function lowerParallaxOcclusion(context: LoweringContext): string {
    return [
        lowerValidateSteps(context),
        lowerCopyProps(context),
        lowerHeightTexture(context),
        lowerStandardHeightTexture(context),
        lowerUniformWriter(context, "write_parallax_uniforms", false),
        lowerUniformWriter(context, "write_parallax_uniforms_over", true),
    ].join("\n\n");
}

const PBR_FRAGMENT =
    "src/material/pbr/fragments/parallax-occlusion-fragment.ts";

/**
 * `pbrParallaxOcclusionExt.writeUbo`'s body over a variant's material block:
 * `offsets.get(name)` is the composer's byte offset of each field the
 * variant declares (`slots`), and the four-field write is
 * `upstream::write_parallax_uniforms` (this header).
 */
export function lowerPbrParallaxWriter(
    context: LoweringContext,
    slots: readonly { name: string; offset: number }[],
    data: string,
): string {
    const file = context.sourceFile(PBR_FRAGMENT);
    const method = context.objectMethod(
        context.objectInitializer(file, "pbrParallaxOcclusionExt"),
        "writeUbo",
    );
    const offset = (node: ts.Expression): string | undefined => {
        const call = context.unwrapExpression(node);
        if (
            !ts.isCallExpression(call) ||
            !context.expressionMatchesShape(call.expression, "offsets.get") ||
            call.arguments.length !== 1 ||
            !ts.isStringLiteral(call.arguments[0]!)
        )
            return undefined;
        const name = call.arguments[0].text;
        const slot = slots.find((field) => field.name === name);
        if (!slot)
            return context.contractError(
                call,
                `The parallax variant declares no '${name}' field.`,
            );
        return `${slot.offset}.0`;
    };
    return lowerPinnedBody(file, method.body.statements, {
        bindings: new Map<string, PinnedBinding>([
            ["data", { cpp: data, type: "f32" }],
            [
                "material._parallaxOcclusion",
                {
                    cpp: "(*material.parallax_occlusion)",
                    type: "opaque",
                    absentCpp: "!material.parallax_occlusion",
                },
            ],
        ]),
        calls: new Map([
            [
                "_writeParallaxUniforms",
                (args) => `write_parallax_uniforms(${args.join(", ")})`,
            ],
        ]),
        expression(node) {
            return offset(node);
        },
        statement(statement, lowerer, indent) {
            if (!ts.isVariableStatement(statement)) return undefined;
            const [declaration] = statement.declarationList.declarations;
            const at =
                declaration?.initializer && offset(declaration.initializer);
            if (!at || !ts.isIdentifier(declaration.name)) return undefined;
            // The variant declares the field, so the lookup is never absent.
            lowerer.bindLocal(declaration.name, {
                cpp: at,
                type: "scalar",
                absentCpp: "false",
            });
            return [`${indent}// ${declaration.name.text}: byte ${at}`];
        },
    });
}

const STANDARD_FRAGMENT =
    "src/material/standard/fragments/std-parallax-occlusion-fragment.ts";

/**
 * `stdParallaxOcclusionExt._bind`'s block, which the pin fills once when it
 * binds the material: `standard_parallax_params(material, props,
 * features)` is its sixteen floats, or nothing for a caster view, which
 * binds none. The buffer, its disposer and the three entries are the PAL's
 * (`parallaxParams`, the height view and sampler by name). Emitted into the
 * Standard support block, after `write_standard_uv_transform`.
 */
export function lowerStandardParallaxParams(
    context: LoweringContext,
    uvOffset: boolean,
): string {
    const file = context.sourceFile(STANDARD_FRAGMENT);
    const method = context.objectMethod(
        context.objectInitializer(file, "stdParallaxOcclusionExt"),
        "_bind",
    );
    let filled = false;
    const body = lowerPinnedBody(file, method.body.statements, {
        bindings: new Map<string, PinnedBinding>([
            [
                "material._renderFeatures?.features",
                { cpp: "static_cast<double>(features)", type: "scalar" },
            ],
            [
                "CASTER_FLAGS",
                {
                    cpp: `${context.pinnedNumber(file, "CASTER_FLAGS")}.0`,
                    type: "scalar",
                },
            ],
            // A native draw always has its scene, and the PAL owns the
            // buffer the disposers would release.
            ["scene", { cpp: "true", type: "bool", staticBoolean: true }],
            ["disposers", { cpp: "true", type: "bool", staticBoolean: true }],
            [
                "material._parallaxOcclusion",
                {
                    cpp: "(*material.parallax_occlusion)",
                    type: "opaque",
                    absentCpp: "!material.parallax_occlusion",
                },
            ],
            [
                "props.heightTexture.invertY",
                {
                    cpp: "material.parallax_occlusion->height_texture.uv_invert_y",
                    type: "bool",
                },
            ],
            ["material", { cpp: "material", type: "opaque" }],
            [
                "material._hasUvTx",
                { cpp: "material.has_uv_transform", type: "bool" },
            ],
            ...[0, 1].flatMap((lane): [string, PinnedBinding][] => [
                [
                    `material.uvScale[${lane}]`,
                    {
                        cpp: `static_cast<double>(props.uv_scale[${lane}])`,
                        type: "scalar",
                    },
                ],
                [
                    `material.uvOffset?.[${lane}]`,
                    uvOffset
                        ? { cpp: `props.uv_offset[${lane}]`, type: "scalar" }
                        : { cpp: "", type: "scalar", staticallyAbsent: true },
                ],
            ]),
        ]),
        calls: new Map([
            [
                "writeStandardUvTransformData",
                (args) =>
                    `write_standard_uv_transform_lanes(props, ${args[2]}, ${args[0]})`,
            ],
            [
                "_writeParallaxUniforms",
                (args) =>
                    `write_parallax_uniforms_over(${args.slice(0, 6).join(", ")}, parallax_base_lanes(${args[6]}), ${args[7]})`,
            ],
        ]),
        statement(statement, lowerer, indent) {
            if (ts.isReturnStatement(statement)) {
                if (
                    !statement.expression ||
                    !context.expressionMatchesShape(
                        statement.expression,
                        "binding",
                    )
                )
                    context.contractError(
                        statement,
                        "Expected the Standard parallax bind to return its binding index.",
                    );
                return [`${indent}return ${filled ? "data" : "std::nullopt"};`];
            }
            if (ts.isVariableStatement(statement)) {
                const [declaration] = statement.declarationList.declarations;
                if (
                    declaration &&
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === "data" &&
                    declaration.initializer &&
                    context.expressionMatchesShape(
                        declaration.initializer,
                        "new Float32Array(16)",
                    )
                ) {
                    filled = true;
                    lowerer.bindLocal(declaration.name, {
                        cpp: "data",
                        type: "f32",
                    });
                    return [`${indent}std::array<float, 16> data{};`];
                }
                if (
                    declaration &&
                    ts.isIdentifier(declaration.name) &&
                    declaration.name.text === "buffer"
                ) {
                    if (
                        !declaration.initializer ||
                        !context.expressionMatchesShape(
                            declaration.initializer,
                            "createUniformBuffer(scene.surface.engine, data)",
                        )
                    )
                        context.contractError(
                            declaration,
                            "Expected the Standard parallax block buffer.",
                        );
                    return [];
                }
                return undefined;
            }
            if (
                ts.isExpressionStatement(statement) &&
                (context.expressionMatchesShape(
                    statement.expression,
                    "disposers.push(() => buffer.destroy())",
                ) ||
                    (ts.isCallExpression(statement.expression) &&
                        context.expressionMatchesShape(
                            statement.expression.expression,
                            "entries.push",
                        )))
            )
                return [];
            return undefined;
        },
    });
    return `
// ${context.provenance(STANDARD_FRAGMENT, "stdParallaxOcclusionExt._bind")}
// writeStandardUvTransformData into the first vec4 of a block.
inline void write_standard_uv_transform_lanes(const StandardMaterialProps& props, bool invert_y,
                                              std::span<float> data) {
    StandardUvTransformUniforms uv{};
    write_standard_uv_transform(props, invert_y, uv);
    std::copy(uv.u.begin(), uv.u.end(), data.begin());
}
// The base transform the writer reads before it stores over the same lanes.
inline std::array<float, 4> parallax_base_lanes(std::span<const float> data) {
    return {data[0], data[1], data[2], data[3]};
}
inline std::optional<std::array<float, 16>> standard_parallax_params(
    const MaterialRecord& material, [[maybe_unused]] const StandardMaterialProps& props,
    std::uint32_t features) {
${body}
}
`;
}

/** The two setters' shared body: validate, store, register the extension. */
const SETTERS = [
    [
        "src/material/pbr/set-parallax-occlusion.ts",
        "setPbrParallaxOcclusion",
        "_registerPbrExt(pbrParallaxOcclusionExt);",
    ],
    [
        "src/material/standard/set-std-parallax-occlusion.ts",
        "setStandardParallaxOcclusion",
        "_registerStdExt(stdParallaxOcclusionExt);",
    ],
] as const;

/**
 * `upstream/parallax_occlusion.hpp` and the setters both families call:
 * the props a call passed validated and stored, or cleared. Generation
 * registers the extensions.
 */
export function lowerParallaxOcclusionUnit(
    context: LoweringContext,
): LoweredSource {
    for (const [modulePath, setter, registration] of SETTERS) {
        const { declaration } = context.functionDeclaration(modulePath, setter);
        context.assertStatementShapes(
            declaration,
            declaration.body!.statements,
            "const state = props === null ? undefined : _copyParallaxOcclusionProps(props); " +
                `material._parallaxOcclusion = state; ${registration}`,
            `${setter} validation, store and registration`,
        );
    }
    return {
        modulePath: MODULE,
        symbolName: SETTERS.map(([, setter]) => setter).join(","),
        header: `#pragma once
#include <bblite/js_data.hpp>
#include <bblite/js_error.hpp>
#include <bblite/runtime.hpp>

#include <array>
#include <cmath>
#include <optional>
#include <span>
#include <stdexcept>
#include <string>

namespace bbl::upstream {
// The height texture's \`texture.format\`: \`loadTexture2D\` and
// \`createTexture2DFromPixels\` upload RGBA8, sRGB-encoded where asked.
inline std::string parallax_texture_format(const TextureData& texture) {
    if (texture.render_source || texture.gpu_source || texture.float_texels ||
        !texture.compressed.mips.empty())
        throw std::runtime_error("Parallax occlusion reads its height texture's format, which "
                                 "this port records for an uploaded RGBA8 image alone.");
    return texture.srgb ? "rgba8unorm-srgb" : "rgba8unorm";
}

${lowerParallaxOcclusion(context)}
} // namespace bbl::upstream
`,
        source: `// ${SETTERS.map(([modulePath, setter]) => context.provenance(modulePath, setter)).join("\n// ")}
#include <bblite/runtime.hpp>
#include <bblite/upstream/parallax_occlusion.hpp>

#include <optional>
#include <utility>

namespace bbl {

void set_parallax_occlusion(Engine& engine, MaterialHandle material,
                            std::optional<ParallaxOcclusionProps> props) {
    std::optional<ParallaxOcclusionProps> state;
    if (props) state = upstream::copy_parallax_occlusion_props(*props);
    ${recordAt("engine.materials", "material")}.parallax_occlusion = std::move(state);
}

} // namespace bbl
`,
    };
}
