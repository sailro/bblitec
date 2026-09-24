import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { recordAt } from "../compiler/record-access.js";

const STANDARD_RENDERABLE = "src/material/standard/standard-renderable.ts";
const STANDARD_FLAGS = "src/material/standard/standard-flags.ts";
const PBR_RENDERABLE = "src/material/pbr/pbr-renderable.ts";
const PBR_FEATURES = "src/material/pbr/pbr-material-features.ts";
const PBR_FLAGS = "src/material/pbr/pbr-flag-bits.ts";

function isTransparentInitializer(
    context: LoweringContext,
    modulePath: string,
): { file: ts.SourceFile; initializer: ts.Expression } {
    const file = context.sourceFile(modulePath);
    return {
        file,
        initializer: context.variableInitializer(file, "isTransparent"),
    };
}

function flagBindings(
    context: LoweringContext,
    modulePath: string,
    names: readonly string[],
): [string, PinnedBinding][] {
    return names.map((name) => [
        name,
        {
            cpp: `${context.pinnedNumber(modulePath, name)}u`,
            type: "scalar",
        },
    ]);
}

function lowerCondition(
    file: ts.SourceFile,
    expression: ts.Expression,
    bindings: [string, PinnedBinding][],
): string {
    return new PinnedNumericLowerer(file, {
        bindings: new Map(bindings),
        calls: new Map(),
        booleanAnd: true,
        booleanOr: true,
    }).expression(expression);
}

/**
 * `_computePbrMaterialFeatures`'s blend term: the conditional that yields
 * `PBR_HAS_ALPHA_BLEND` (`mat.alphaBlend === true || ((mat._alphaCutOff ??
 * 0) <= 0 && mat.alpha! < 1)`), with the record answering its three reads.
 * `alpha_mode` is the authored mode -- blend where the scene, the glTF
 * BLEND arm or the shadow-only extension asked for it, mask where the glTF
 * MASK arm set `_alphaCutOff` -- so the absent cutoff takes the `??`'s own
 * right side, read from the pin.
 */
function pbrAlphaBlendFeatures(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        PBR_FEATURES,
        "_computePbrMaterialFeatures",
    );
    let term: ts.ConditionalExpression | undefined;
    const visit = (node: ts.Node): void => {
        if (
            term === undefined &&
            ts.isConditionalExpression(node) &&
            context.unwrapExpression(node.whenTrue).getText(file) ===
                "PBR_HAS_ALPHA_BLEND"
        ) {
            term = node;
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(declaration);
    if (!term) {
        context.contractError(
            declaration,
            "Expected the PBR_HAS_ALPHA_BLEND term in _computePbrMaterialFeatures.",
        );
    }
    let cutoff: ts.BinaryExpression | undefined;
    const findCutoff = (node: ts.Node): void => {
        if (
            cutoff === undefined &&
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
            context.unwrapExpression(node.left).getText(file) ===
                "mat._alphaCutOff"
        ) {
            cutoff = node;
            return;
        }
        ts.forEachChild(node, findCutoff);
    };
    findCutoff(term.condition);
    if (!cutoff) {
        context.contractError(
            term,
            "Expected the PBR blend term to read `mat._alphaCutOff ?? <default>`.",
        );
    }
    const absentCutoff = context.numericValue(cutoff.right, file);
    return lowerCondition(file, term, [
        [
            "mat.alphaBlend === true",
            {
                cpp: "(material.alpha_mode == MaterialAlphaMode::blend)",
                type: "bool",
            },
        ],
        [
            cutoff.getText(file),
            {
                cpp:
                    "(material.alpha_mode == MaterialAlphaMode::mask ? " +
                    "static_cast<double>(material.alpha_cutoff) : " +
                    `${context.doubleLiteral(absentCutoff)})`,
                type: "scalar",
            },
        ],
        [
            "mat.alpha",
            { cpp: "static_cast<double>(material.alpha)", type: "scalar" },
        ],
        ...flagBindings(context, PBR_FLAGS, ["PBR_HAS_ALPHA_BLEND"]),
    ]);
}

/**
 * The render bucket `bind_render_item` assigns, from the pin's own
 * `isTransparent` stamps rather than a rule restated beside the record.
 *
 * - Standard: `standard-renderable.ts` over the lowered
 *   `standard_material_features` word (`HAS_OPACITY_TEXTURE`, the material
 *   alpha, and the vertex/instance colour-alpha arm).
 * - PBR: `pbr-renderable.ts` over `_computePbrMaterialFeatures`'s blend term,
 *   with the no-colour and ESM caster views as the pin's `features2` bits.
 * - Shader, node and grid materials keep the mode their factory set.
 *
 * Transmission is not a bucket: the pin lists a transmissive renderable
 * with the transparent ones (`isTransparent || _transmissive`), which is
 * `item.transmissive` on the list side.
 */
export function lowerRenderBucket(
    context: LoweringContext,
    options: { standardVertexAlpha?: boolean; standardVertexColors?: boolean },
): string {
    const standard = isTransparentInitializer(context, STANDARD_RENDERABLE);
    const standardTransparent = lowerCondition(
        standard.file,
        standard.initializer,
        [
            ["shadowOutput", { cpp: "shadow_output", type: "bool" }],
            ["features", { cpp: "features", type: "scalar" }],
            [
                "mat.alpha",
                { cpp: "static_cast<double>(material.alpha)", type: "scalar" },
            ],
            ["colorAlphaBlend", { cpp: "color_alpha_blend", type: "bool" }],
            ...flagBindings(context, STANDARD_FLAGS, ["HAS_OPACITY_TEXTURE"]),
        ],
    );
    const pbr = isTransparentInitializer(context, PBR_RENDERABLE);
    const pbrTransparent = lowerCondition(pbr.file, pbr.initializer, [
        ["features", { cpp: "features", type: "scalar" }],
        ["features2", { cpp: "features2", type: "scalar" }],
        ...flagBindings(context, PBR_FLAGS, [
            "PBR_HAS_ALPHA_BLEND",
            "PBR2_NO_COLOR_OUTPUT",
            "PBR2_ESM_SHADOW_OUTPUT",
        ]),
    ]);
    const [noColorFlag, esmFlag] = [
        "PBR2_NO_COLOR_OUTPUT",
        "PBR2_ESM_SHADOW_OUTPUT",
    ].map((name) => context.pinnedNumber(PBR_FLAGS, name));
    // `colorAlphaBlend`, through the pin's own lowered decision where the
    // scene reached vertex alpha; without it the arm is false.
    const colorAlphaBlend = options.standardVertexAlpha
        ? `bool color_alpha_blend = false;
        if (item.mesh.value < engine.meshes.size()) {
            const MeshRecord& mesh = ${recordAt("engine.meshes", "item.mesh")};
            const bool has_vertex_color = ${options.standardVertexColors ? "mesh.geometry < engine.geometries.size() && engine.geometries[mesh.geometry].has_vertex_colors" : "false"};
            color_alpha_blend = standard_color_alpha_features(
                shadow_output, mesh.has_vertex_alpha, has_vertex_color,
                has_instance_colors(mesh)) != 0u;
        }`
        : "const bool color_alpha_blend = false;";
    return `    // ${context.provenance(STANDARD_RENDERABLE, "isTransparent", `${PBR_RENDERABLE}#isTransparent, ${PBR_FEATURES}#_computePbrMaterialFeatures`)}
    bool transparent = material.alpha_mode == MaterialAlphaMode::blend;
    if (item.material_kind == RenderMaterialKind::standard) {
#if BBLITE_STANDARD_VARIANTS > 0
        const bool shadow_output = material.no_color || material.esm_shadow;
        const std::uint32_t features = standard_material_features(material);
        ${colorAlphaBlend}
        transparent = ${standardTransparent};
#else
        throw std::runtime_error(
            "A Standard material record exists in a build that composed no Standard variant.");
#endif
    } else if (item.material_kind == RenderMaterialKind::pbr) {
        const std::uint32_t features = static_cast<std::uint32_t>(${pbrAlphaBlendFeatures(context)});
        const std::uint32_t features2 =
            (material.no_color ? ${noColorFlag}u : 0u) | (material.esm_shadow ? ${esmFlag}u : 0u);
        transparent = ${pbrTransparent};
    }
    item.bucket = transparent
        ? RenderBucket::alpha_blend
        : material.alpha_mode == MaterialAlphaMode::mask
            ? RenderBucket::alpha_mask
            : RenderBucket::opaque;`;
}
