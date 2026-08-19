import ts from "typescript";
import { PinnedShaderText } from "./pinned-shader-text.js";
import {
    blendFactoriesCpp,
    readPinnedBlendTable,
} from "./pinned-blend-table.js";
import { LoweredSource, LoweringContext } from "./context.js";

const atlasModule = "src/sprite/shared/sprite-atlas.ts";
const layerModule = "src/sprite/sprite-2d.ts";
const blendModule = "src/sprite/sprite-blend.ts";
const pipelineModule = "src/sprite/sprite-pipeline.ts";
const rendererModule = "src/sprite/sprite-renderer.ts";
const uvScrollModule = "src/sprite/sprite-2d-uvscroll.ts";

/** The pinned WGSL, reconstructed for the pure-2D permutation. */
export interface SpriteShaderSource {
    /** `Lr` struct body, one field per line, as the pin declares it. */
    layerStructFields: string;
    /** `I` struct body: the per-instance vertex attributes. */
    instanceStructFields: string;
    /** `O` struct body: the interpolants. */
    varyingStructFields: string;
    /** The `vs` body between its braces. */
    vertexBody: string;
    /** The `fs` body between its braces. */
    fragmentBody: string;
}

/**
 * Lowers Babylon Lite's pure-2D sprite path.
 *
 * The reached slice is one `SpriteRenderer` over `depth: "none"` layers on the
 * straight-alpha blend: `loadSpriteAtlas` -> `createGridSpriteAtlas` ->
 * `createSprite2DLayer` -> `addSprite2DIndex` -> `createSpriteRenderer`.
 * Everything upstream keeps behind a hook (custom shaders, uv scroll, coverage
 * gamma, alpha-to-coverage) or behind a depth mode is not emitted at all,
 * which is where upstream keeps it too.
 */
export class SpriteLowerer {
    private readonly shaderText: PinnedShaderText;

    public constructor(private readonly context: LoweringContext) {
        this.shaderText = new PinnedShaderText(context);
    }

    // -----------------------------------------------------------------
    // Pinned contracts
    // -----------------------------------------------------------------

    /** `PURE_2D_INSTANCE_FLOATS_PER_SPRITE`, `SAVED_SIZE_FLOATS_PER_SPRITE`. */
    private uvScrollExtraFloats(): number {
        const file = this.context.sourceFile(uvScrollModule);
        return this.context.numericValue(
            this.context.variableInitializer(
                file,
                "UVSCROLL_EXTRA_FLOATS_PER_SPRITE",
            ),
            file,
        );
    }

    private layout(): {
        instanceFloats: number;
        savedSizeFloats: number;
        defaultCapacity: number;
    } {
        const file = this.context.sourceFile(layerModule);
        const instanceFloats = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "PURE_2D_INSTANCE_FLOATS_PER_SPRITE",
            ),
            file,
        );
        const savedSizeFloats = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "SAVED_SIZE_FLOATS_PER_SPRITE",
            ),
            file,
        );
        const defaultCapacity = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "DEFAULT_CAPACITY",
            ),
            file,
        );
        if (
            instanceFloats !== 13 ||
            savedSizeFloats !== 2 ||
            defaultCapacity !== 16
        ) {
            this.context.contractError(
                file,
                `Pinned sprite instance layout changed: ${instanceFloats} instance floats, ${savedSizeFloats} saved-size floats, capacity ${defaultCapacity}.`,
            );
        }
        return {
            instanceFloats,
            savedSizeFloats,
            defaultCapacity,
        };
    }

    /**
     * `sprite-pipeline.ts`: the pure-2D per-instance vertex attributes at
     * the pin's own byte offsets. The offsets are the module's named
     * constants and the rows are `instanceAttributes`' base literal (the
     * depth and uv-scroll rows append behind opt-ins the pure-2D slice
     * never takes), so a moved slot or widened format fails generation
     * instead of drifting inside two hand-written PAL tables.
     */
    private instanceAttributeRows(instanceFloats: number): Array<{
        location: number;
        offsetBytes: number;
        floatCount: number;
    }> {
        const file = this.context.sourceFile(pipelineModule);
        const array = this.context.unwrapExpression(
            this.context.variableInitializer(file, "instanceAttributes"),
        );
        if (!ts.isArrayLiteralExpression(array)) {
            return this.context.contractError(
                array,
                "Expected the pinned instanceAttributes array literal.",
            );
        }
        const rows = array.elements.map((element) => {
            const literal = this.context.unwrapExpression(element);
            if (!ts.isObjectLiteralExpression(literal)) {
                return this.context.contractError(
                    literal,
                    "Expected a pinned sprite attribute object literal.",
                );
            }
            let location: number | undefined;
            let offsetBytes: number | undefined;
            let floatCount: number | undefined;
            for (const property of literal.properties) {
                if (!ts.isPropertyAssignment(property)) continue;
                const name = this.context.propertyName(property.name);
                if (name === "shaderLocation") {
                    location = this.context.numericValue(
                        property.initializer,
                        file,
                    );
                } else if (name === "offset") {
                    const reference = this.context.unwrapExpression(
                        property.initializer,
                    );
                    if (!ts.isIdentifier(reference)) {
                        return this.context.contractError(
                            reference,
                            "Expected a named sprite offset constant.",
                        );
                    }
                    offsetBytes = this.context.numericValue(
                        this.context.variableInitializer(
                            file,
                            reference.text,
                        ),
                        file,
                    );
                } else if (name === "format") {
                    const format = this.context.unwrapExpression(
                        property.initializer,
                    );
                    if (!ts.isStringLiteral(format)) {
                        return this.context.contractError(
                            format,
                            "Expected a sprite attribute format string.",
                        );
                    }
                    const match = /^float32(?:x([234]))?$/.exec(
                        format.text,
                    );
                    if (!match) {
                        return this.context.contractError(
                            format,
                            `Unsupported sprite attribute format '${format.text}'.`,
                        );
                    }
                    floatCount =
                        match[1] === undefined ? 1 : Number(match[1]);
                }
            }
            if (
                location === undefined ||
                offsetBytes === undefined ||
                floatCount === undefined
            ) {
                return this.context.contractError(
                    literal,
                    "Pinned sprite attribute misses shaderLocation, offset or format.",
                );
            }
            return { location, offsetBytes, floatCount };
        });
        // The base rows must tile the pure-2D stride exactly: the last
        // attribute ends where PURE_2D_INSTANCE_FLOATS_PER_SPRITE says the
        // instance does, or the two pinned modules disagree.
        const lastEnd = rows.reduce(
            (max, row) =>
                Math.max(max, row.offsetBytes + row.floatCount * 4),
            0,
        );
        if (lastEnd !== instanceFloats * 4) {
            this.context.contractError(
                array,
                `Pinned sprite attributes end at ${lastEnd} bytes, expected ${instanceFloats * 4}.`,
            );
        }
        return rows;
    }

    /**
     * `writeInstance` writes thirteen numbered slots. The lowered writer
     * below reproduces them, so the slot expressions are pinned here
     * rather than trusted: a moved slot has to fail generation.
     */
    private assertInstanceSlots(): void {
        const { declaration } = this.functionOf(
            layerModule,
            "writeInstance",
        );
        const expected: ReadonlyArray<[number, string]> = [
            [0, "posX"],
            [1, "posY"],
            [2, "visible ? trueW : 0"],
            [3, "visible ? trueH : 0"],
            [4, "uMin"],
            [5, "vMin"],
            [6, "uMax"],
            [7, "vMax"],
            [8, "rotation"],
        ];
        const writes = this.context
            .findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isElementAccessExpression(node.left) &&
                    ts.isIdentifier(node.left.expression) &&
                    node.left.expression.text === "data",
            )
            .map((node) => node as ts.BinaryExpression);
        for (const [slot, source] of expected) {
            const write = writes.find(
                (node) =>
                    this.elementIndexText(node.left) ===
                    `base + ${slot}`,
            );
            if (!write) {
                this.context.contractError(
                    declaration,
                    `Pinned writeInstance no longer writes slot ${slot}.`,
                );
            }
            this.context.assertExpressionShape(
                write.right,
                source,
                `writeInstance slot ${slot}`,
            );
        }
        // The colour block writes slots 9..12 twice (the props arm and the
        // add default), so it is checked by count rather than by shape.
        for (const slot of [9, 10, 11, 12]) {
            const found = writes.filter(
                (node) =>
                    this.elementIndexText(node.left) ===
                    `base + ${slot}`,
            );
            if (found.length !== 2) {
                this.context.contractError(
                    declaration,
                    `Pinned writeInstance colour slot ${slot} has ${found.length} writers, expected 2.`,
                );
            }
        }
        // The flip resolution is what makes flipX absolute rather than a
        // toggle, and the swap is what a preserved orientation means.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "currentFlipX",
            ),
            "uMin > uMax",
            "writeInstance currentFlipX",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "wantsFlipX",
            ),
            "props.flipX !== undefined ? props.flipX === true : prevFlipX",
            "writeInstance wantsFlipX",
        );
    }

    /** `base` is `slotIndex * layer._instanceFloatsPerSprite`. */
    private assertInstanceBase(): void {
        const { declaration } = this.functionOf(
            layerModule,
            "writeInstance",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "base",
            ),
            "slotIndex * layer._instanceFloatsPerSprite",
            "writeInstance base",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "savedBase",
            ),
            "slotIndex * SAVED_SIZE_FLOATS_PER_SPRITE",
            "writeInstance savedBase",
        );
    }

    /** `createGridSpriteAtlas` derives columns, rows, and each frame's UVs. */
    private assertGridAtlas(): void {
        const { declaration } = this.functionOf(
            atlasModule,
            "createGridSpriteAtlas",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "cols",
            ),
            "options.columns ?? Math.max(1, Math.floor((texture.width - margin * 2 + spacing) / (cellW + spacing)))",
            "createGridSpriteAtlas columns",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "rows",
            ),
            "options.rows ?? Math.max(1, Math.floor((texture.height - margin * 2 + spacing) / (cellH + spacing)))",
            "createGridSpriteAtlas rows",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "x",
            ),
            "margin + c * (cellW + spacing)",
            "createGridSpriteAtlas frame x",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "y",
            ),
            "margin + r * (cellH + spacing)",
            "createGridSpriteAtlas frame y",
        );
        const push = this.context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                node.expression.name.text === "push",
        )[0];
        const frame = push
            ? this.context.unwrapExpression(
                  push.arguments[0]!,
              )
            : undefined;
        if (!frame || !ts.isObjectLiteralExpression(frame)) {
            this.context.contractError(
                declaration,
                "Pinned createGridSpriteAtlas no longer pushes frame literals.",
            );
        }
        for (const [name, source] of [
            ["uvMin", "[x / tw, y / th]"],
            ["uvMax", "[(x + cellW) / tw, (y + cellH) / th]"],
            ["sourceSizePx", "[cellW, cellH]"],
            ["pivot", "[pivot[0], pivot[1]]"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(
                    frame,
                    name,
                ),
                source,
                `createGridSpriteAtlas frame ${name}`,
            );
        }
    }

    /** `resolveSpriteFrame` is a bounds check and nothing else. */
    private assertFrameResolution(): void {
        const { declaration } = this.functionOf(
            atlasModule,
            "resolveSpriteFrame",
        );
        const guard = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node),
        )[0];
        if (!guard) {
            this.context.contractError(
                declaration,
                "Pinned resolveSpriteFrame no longer bounds-checks.",
            );
        }
        this.context.assertExpressionShape(
            guard.expression,
            "frame < 0 || frame >= atlas.frames.length",
            "resolveSpriteFrame bounds",
        );
        const returned = this.context.findNodes(
            declaration,
            (node): node is ts.ReturnStatement =>
                ts.isReturnStatement(node) &&
                node.expression !== undefined,
        )[0];
        this.context.assertExpressionShape(
            returned!.expression!,
            "frame",
            "resolveSpriteFrame result",
        );
    }

    /** `loadSpriteAtlas` requires `gridSize` and fixes the texture options. */
    private assertAtlasLoader(): void {
        const { declaration, file } = this.functionOf(
            atlasModule,
            "loadSpriteAtlas",
        );
        const options = this.context.objectInitializer(
            declaration,
            "texOpts",
        );
        for (const [name, source] of [
            ["invertY", "false"],
            ["addressModeU", '"clamp-to-edge"'],
            ["addressModeV", '"clamp-to-edge"'],
            ["mipMaps", "false"],
            [
                "minFilter",
                'options.sampling === "nearest" ? "nearest" : "linear"',
            ],
            [
                "magFilter",
                'options.sampling === "nearest" ? "nearest" : "linear"',
            ],
            [
                "premultiplyAlpha",
                "options.premultiplyOnLoad ?? false",
            ],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(
                    options,
                    name,
                ),
                source,
                `loadSpriteAtlas ${name}`,
            );
        }
        if (
            !this.context.hasCall(
                declaration,
                "createGridSpriteAtlas",
            )
        ) {
            this.context.contractError(
                file,
                "Pinned loadSpriteAtlas no longer partitions the texture into a grid.",
            );
        }
    }

    /** `spriteBlendAlpha` and the shared straight-alpha blend state. */
    /** `buildSpriteLayerUbo` fills sixteen floats in a fixed order. */
    private assertLayerUbo(): void {
        const { declaration, file } = this.functionOf(
            pipelineModule,
            "buildSpriteLayerUbo",
        );
        const expected: ReadonlyArray<[number, string]> = [
            [0, "layer.view.positionPx[0]"],
            [1, "layer.view.positionPx[1]"],
            [2, "layer.view.zoom"],
            [3, "layer.view.rotation"],
            [4, "screenWidth"],
            [5, "screenHeight"],
            [6, "layer.pivot[0]"],
            [7, "layer.pivot[1]"],
        ];
        const writes = this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === "ubo",
        );
        for (const [slot, source] of expected) {
            const write = writes.find(
                (node) =>
                    this.elementIndexText(node.left) ===
                    String(slot),
            );
            if (!write) {
                this.context.contractError(
                    declaration,
                    `Pinned buildSpriteLayerUbo no longer writes float ${slot}.`,
                );
            }
            this.context.assertExpressionShape(
                write.right,
                source,
                `buildSpriteLayerUbo float ${slot}`,
            );
        }
        // Straight alpha scales only A; premultiplied scales RGB too. Only
        // the straight arm is reached, and it has to be the `else`.
        const branch = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node),
        )[0];
        if (
            !branch?.elseStatement ||
            !this.context.hasNode(
                branch.expression,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text ===
                        "_premultipliedOpacity",
            )
        ) {
            this.context.contractError(
                declaration,
                "Pinned buildSpriteLayerUbo no longer branches on premultiplied opacity.",
            );
        }
        const bytes = this.context.numericValue(
            this.context.variableInitializer(
                file,
                "LAYER_UBO_BYTES",
            ),
            file,
        );
        if (bytes !== 64) {
            this.context.contractError(
                file,
                `Pinned sprite layer UBO is ${bytes} bytes, expected 64.`,
            );
        }
    }

    /** The shared quad: four corners, six indices, one instanced draw. */
    private assertQuad(): void {
        const file = this.context.sourceFile(pipelineModule);
        const indices = this.context.unwrapExpression(
            this.context.variableInitializer(
                file,
                "SHARED_SPRITE_INDEX_DATA",
            ),
        );
        this.context.assertExpressionShape(
            indices,
            "new U16([0, 1, 2, 0, 2, 3])",
            "shared sprite index buffer",
        );
        const { declaration } = this.functionOf(
            rendererModule,
            "spriteRendererRecord",
        );
        const draw = this.context.findNodes(
            declaration,
            (node): node is ts.CallExpression =>
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(
                    node.expression,
                ) &&
                node.expression.name.text === "drawIndexed",
        )[0];
        if (!draw) {
            this.context.contractError(
                declaration,
                "Pinned sprite record pass no longer records an indexed draw.",
            );
        }
        this.context.assertExpressionShape(
            draw.arguments[0]!,
            "6",
            "sprite drawIndexed index count",
        );
        this.context.assertExpressionShape(
            draw.arguments[1]!,
            "layer.count",
            "sprite drawIndexed instance count",
        );
    }

    // -----------------------------------------------------------------
    // Pinned WGSL
    // -----------------------------------------------------------------

    /**
     * Reconstructs the shader the pin builds for the reached permutation
     * (`hasDepth: false`, sprite group 0, no uv scroll) by evaluating its
     * own template rather than by transcribing the result. Anything the
     * evaluator cannot fold is a contract failure, so a changed shader
     * stops generation instead of silently keeping this copy.
     */
    public shaderSource(
        uvScroll = false,
    ): SpriteShaderSource {
        const permutation = (): Map<string, string | boolean> =>
            new Map<string, string | boolean>([
                ["hasDepth", false],
                ["spriteGroupIndex", "0"],
                ["uvScroll", uvScroll],
            ]);
        const prologue = this.shaderText.evaluate(
            pipelineModule,
            "makeSpritePrologueWgsl",
            permutation(),
        );
        const full = this.shaderText.evaluate(
            pipelineModule,
            "makeSpriteWgsl",
            permutation(),
        );
        return {
            layerStructFields: this.shaderText.braced(
                prologue,
                "struct Lr {",
                "sprite layer uniform struct",
            ),
            instanceStructFields: this.shaderText.braced(
                prologue,
                "struct I {",
                "sprite instance struct",
            ),
            varyingStructFields: this.shaderText.braced(
                prologue,
                "struct O {",
                "sprite varying struct",
            ),
            vertexBody: this.shaderText.braced(
                prologue,
                "fn vs(in: I) -> O {",
                "sprite vertex stage",
            ),
            fragmentBody: this.shaderText.braced(
                full,
                "fn fs(in: O) -> @location(0) vec4f {",
                "sprite fragment stage",
            ),
        };
    }



    // -----------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------

    private functionOf(
        modulePath: string,
        symbolName: string,
    ): {
        file: ts.SourceFile;
        declaration: ts.FunctionDeclaration;
    } {
        return this.context.functionDeclaration(
            modulePath,
            symbolName,
        );
    }

    private elementIndexText(
        target: ts.Expression,
    ): string | undefined {
        if (!ts.isElementAccessExpression(target)) {
            return undefined;
        }
        return target.argumentExpression
            .getText(target.getSourceFile())
            .replace(/\s+/g, " ")
            .trim();
    }

    public lowerCore(): LoweredSource {
        const layout = this.layout();
        const blends = readPinnedBlendTable(
            this.context,
            blendModule,
            "spriteBlend",
        );
        // The intrinsic defaults an unnamed blendMode to this factory, so the
        // descriptor the default names has to be one the pin still exports.
        // Everything about its factors is read, not asserted -- a hand-typed
        // expectation here would fail a bump the table lowers correctly.
        if (
            !blends.some(
                (blend) => blend.exportName === "spriteBlendAlpha",
            )
        ) {
            this.context.contractError(
                this.context.sourceFile(blendModule),
                "Pinned sprite blends no longer export spriteBlendAlpha, which the default names.",
            );
        }
        const attributeRows = this.instanceAttributeRows(
            layout.instanceFloats,
        );
        this.assertGridAtlas();
        this.assertFrameResolution();
        this.assertAtlasLoader();
        this.assertInstanceBase();
        this.assertInstanceSlots();
        this.assertLayerUbo();
        this.assertQuad();

        const provenance = this.context.provenance(
            layerModule,
            "createSprite2DLayer, addSprite2DIndex",
            `${atlasModule}#createGridSpriteAtlas, ${blendModule}#spriteBlendAlpha, ${rendererModule}#createSpriteRenderer`,
        );
        return {
            modulePath: layerModule,
            symbolName:
                "createSprite2DLayer,addSprite2DIndex,loadSpriteAtlas,createSpriteRenderer",
            header: `#pragma once

// ${this.context.provenance(pipelineModule, "buildSpriteLayerUbo")}
#include <bblite/runtime.hpp>

#include <array>
#include <cstdint>
#include <stdexcept>

namespace bbl::upstream {

/**
 * sprite-pipeline.ts: the pure-2D per-instance vertex attributes at the
 * pin's own byte offsets, and the stride sprite-2d.ts derives from
 * PURE_2D_INSTANCE_FLOATS_PER_SPRITE. Both render backends translate
 * these rows into their API's vertex-attribute descriptors, so the
 * numbers exist once, here.
 */
struct SpriteInstanceAttribute {
    std::uint32_t shader_location;
    std::uint32_t byte_offset;
    std::uint32_t float_count;
};

/**
 * shared/sprite-atlas.ts#resolveSpriteFrame: a bounds check, nothing more.
 * It lives in the shared header because it is the shared atlas module's, and
 * both the 2D layer and the billboard system resolve a frame through it.
 */
inline std::uint32_t resolve_sprite_frame(
    const SpriteAtlasRecord& atlas,
    double frame) {
    if (frame < 0.0 ||
        frame >= static_cast<double>(atlas.frames.size())) {
        throw std::runtime_error(
            "resolveSpriteFrame: index out of range.");
    }
    return static_cast<std::uint32_t>(frame);
}

inline constexpr std::array<SpriteInstanceAttribute, ${attributeRows.length}>
    sprite_instance_attributes{{
${attributeRows
    .map(
        (row) =>
            `        {${row.location}u, ${row.offsetBytes}u, ${row.floatCount}u},`,
    )
    .join("\n")}
    }};

// sprite-2d-uvscroll.ts ensureWide: the uvOffset attribute the widened
// layout adds, at the byte offset the narrow stride ends on.
inline constexpr SpriteInstanceAttribute sprite_uvscroll_attribute{
    7u, ${layout.instanceFloats * 4}u, 2u};

inline constexpr std::uint32_t sprite_uvscroll_stride_bytes =
    ${(layout.instanceFloats + this.uvScrollExtraFloats()) * 4}u;

inline constexpr std::uint32_t sprite_instance_stride_bytes =
    ${layout.instanceFloats * 4}u;

/**
 * The sixteen floats of the per-layer UBO, in the pinned order:
 *   [0..1] viewPos.xy  [2] viewScale  [3] viewRot
 *   [4..5] screenSize.xy  [6..7] pivot.xy
 *   [8..11] opacityMul.rgba  [12..15] aa (coverage gamma, unreached)
 *
 * Premultiplied sources scale RGB and A together for a correct fade;
 * straight alpha scales only A, because the blend stage already uses
 * source alpha as the colour factor.
 */
inline void build_sprite_layer_ubo(
    const Sprite2DLayerRecord& layer,
    float screen_width,
    float screen_height,
    std::array<float, 16>& ubo) {
    ubo[0] = layer.view.position_px.x;
    ubo[1] = layer.view.position_px.y;
    ubo[2] = layer.view.zoom;
    ubo[3] = layer.view.rotation;
    ubo[4] = screen_width;
    ubo[5] = screen_height;
    ubo[6] = layer.pivot.x;
    ubo[7] = layer.pivot.y;
    const float opacity = layer.opacity;
    if (layer.blend.premultiplied_opacity) {
        ubo[8] = opacity;
        ubo[9] = opacity;
        ubo[10] = opacity;
        ubo[11] = opacity;
    } else {
        ubo[8] = 1.0f;
        ubo[9] = 1.0f;
        ubo[10] = 1.0f;
        ubo[11] = opacity;
    }
}

} // namespace bbl::upstream

namespace bbl {

/**
 * sprite-blend.ts: each exported descriptor, as the factory scene code
 * reaches when it names that descriptor at a layer. A mode with no colour
 * blend is the pin's opaque replacement, which is blending disabled.
 */
${blendFactoriesCpp(blends, "sprite", "sprite-blend.ts")}
} // namespace bbl
`,
            source: `// ${provenance}
#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl {
namespace {

// sprite-2d.ts: the pure-2D instance layout and the CPU-side shadow that
// keeps a hidden sprite's true size.
constexpr std::uint32_t sprite_instance_floats = ${layout.instanceFloats}u;
constexpr std::uint32_t sprite_saved_size_floats = ${layout.savedSizeFloats}u;
// sprite-2d-uvscroll.ts UVSCROLL_EXTRA_FLOATS_PER_SPRITE.
constexpr std::uint32_t sprite_uvscroll_extra_floats = ${this.uvScrollExtraFloats()}u;

void grow_sprite_capacity(
    Sprite2DLayerRecord& layer,
    std::uint32_t min_capacity) {
    std::uint32_t capacity = layer.capacity;
    while (capacity < min_capacity) {
        capacity *= 2u;
    }
    layer.instance_data.resize(
        static_cast<std::size_t>(capacity) *
        layer.instance_floats_per_sprite);
    layer.saved_size.resize(
        static_cast<std::size_t>(capacity) *
        sprite_saved_size_floats);
    layer.capacity = capacity;
}

std::runtime_error new_sprite_range_error(
    double index,
    std::uint32_t count) {
    return std::runtime_error(
        "setSprite2DUvOffset: index " +
        std::to_string(static_cast<long long>(index)) +
        " out of range [0, " + std::to_string(count) + ")");
}

} // namespace

// sprite-2d-uvscroll.ts ensureWide: widen a layer from the narrow base
// layout to the uvOffset layout, re-striding the sprites already written.
// The offset slots default to zero, and the attribute the pipeline pushes
// sits right after the base layout -- so its byte offset IS the narrow
// stride.
void ensure_sprite_uv_scroll(Sprite2DLayerRecord& layer) {
    if (layer.uv_scroll) {
        return;
    }
    const std::uint32_t old_stride = layer.instance_floats_per_sprite;
    const std::uint32_t new_stride =
        old_stride + sprite_uvscroll_extra_floats;
    std::vector<float> next(
        static_cast<std::size_t>(layer.capacity) * new_stride, 0.0f);
    for (std::uint32_t index = 0; index < layer.count; ++index) {
        const std::size_t from =
            static_cast<std::size_t>(index) * old_stride;
        const std::size_t to =
            static_cast<std::size_t>(index) * new_stride;
        for (std::uint32_t field = 0; field < old_stride; ++field) {
            next[to + field] = layer.instance_data[from + field];
        }
    }
    layer.instance_data = std::move(next);
    layer.uv_scroll_offset_bytes = old_stride * 4u;
    layer.instance_floats_per_sprite = new_stride;
    layer.uv_scroll = true;
    layer.version += 1u;
}

// setSprite2DUvOffset: the two floats sit right after the base layout, and
// the first call is what enables the layout at all.
void set_sprite_2d_uv_offset(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    double index,
    Vec2 uv_offset) {
    Sprite2DLayerRecord& layer =
        engine.sprite_layers[layer_handle.value];
    if (index < 0.0 ||
        index >= static_cast<double>(layer.count)) {
        throw new_sprite_range_error(index, layer.count);
    }
    ensure_sprite_uv_scroll(layer);
    const std::size_t base =
        static_cast<std::size_t>(index) *
        layer.instance_floats_per_sprite;
    const std::size_t slot = base + sprite_instance_floats;
    layer.instance_data[slot] = uv_offset.x;
    layer.instance_data[slot + 1u] = uv_offset.y;
}

SpriteAtlasHandle load_sprite_atlas(
    Engine& engine,
    const std::string& path,
    LoadSpriteAtlasOptions options) {
    if (options.grid_width_px <= 0.0f ||
        options.grid_height_px <= 0.0f) {
        throw std::runtime_error(
            "loadSpriteAtlas: gridSize required.");
    }
    SpriteAtlasRecord atlas;
    // loadTexture2D fetches, decodes and uploads before the grid is
    // built, so the decode has to happen here too: the frame table is
    // derived from the texture's own size.
    const std::vector<std::uint8_t> file_bytes =
        pal::read_binary_file(path);
    const pal::DecodedImage image =
        pal::decode_image(ts::ArrayBuffer(file_bytes));
    atlas.rgba = image.rgba;
    atlas.width = static_cast<std::uint32_t>(image.width);
    atlas.height = static_cast<std::uint32_t>(image.height);
    atlas.premultiplied_alpha = options.premultiplied_alpha;
    if (options.premultiply_on_load) {
        // createImageBitmap({ premultiplyAlpha: "premultiply" }).
        for (std::size_t index = 0; index + 3 < atlas.rgba.size();
             index += 4) {
            const std::uint32_t alpha = atlas.rgba[index + 3];
            for (std::size_t channel = 0; channel < 3; ++channel) {
                atlas.rgba[index + channel] =
                    static_cast<std::uint8_t>(
                        (static_cast<std::uint32_t>(
                             atlas.rgba[index + channel]) *
                             alpha +
                         127u) /
                        255u);
            }
        }
    }
    // The pinned sampler: clamp both axes, no mip chain, and a filter
    // chosen by \`sampling\`. mipmapFilter is "nearest" without mips, which
    // also takes maxAnisotropy back to 1.
    atlas.sampler.min_filter = options.sampling;
    atlas.sampler.mag_filter = options.sampling;
    atlas.sampler.mipmap_mode = TextureMipmapMode::nearest;
    // The pinned defaults, with the caller-spread texture options over them.
    atlas.sampler.address_u = options.address_u;
    atlas.sampler.address_v = options.address_v;
    atlas.sampler.max_anisotropy = 1.0f;
    atlas.sampler.max_lod = 0.0f;

    // createGridSpriteAtlas: row-major frames over a uniform grid.
    const double cell_w = static_cast<double>(options.grid_width_px);
    const double cell_h = static_cast<double>(options.grid_height_px);
    const double margin = 0.0;
    const double spacing = 0.0;
    const double tw = static_cast<double>(atlas.width);
    const double th = static_cast<double>(atlas.height);
    const double columns = std::max(
        1.0,
        std::floor((tw - margin * 2.0 + spacing) / (cell_w + spacing)));
    const double rows = std::max(
        1.0,
        std::floor((th - margin * 2.0 + spacing) / (cell_h + spacing)));
    const double pivot_x = 0.5;
    const double pivot_y = 0.5;
    for (double r = 0.0; r < rows; r += 1.0) {
        for (double c = 0.0; c < columns; c += 1.0) {
            const double x = margin + c * (cell_w + spacing);
            const double y = margin + r * (cell_h + spacing);
            SpriteFrame frame;
            frame.uv_min = Vec2{
                static_cast<float>(x / tw),
                static_cast<float>(y / th)};
            frame.uv_max = Vec2{
                static_cast<float>((x + cell_w) / tw),
                static_cast<float>((y + cell_h) / th)};
            frame.source_size_px = Vec2{
                static_cast<float>(cell_w),
                static_cast<float>(cell_h)};
            frame.pivot = Vec2{
                static_cast<float>(pivot_x),
                static_cast<float>(pivot_y)};
            atlas.frames.push_back(frame);
        }
    }

    engine.sprite_atlases.push_back(std::move(atlas));
    return SpriteAtlasHandle{
        static_cast<std::uint32_t>(
            engine.sprite_atlases.size() - 1u)};
}

Sprite2DLayerHandle create_sprite_2d_layer(
    Engine& engine,
    SpriteAtlasHandle atlas,
    Sprite2DLayerOptions options) {
    Sprite2DLayerRecord layer;
    layer.atlas = atlas;
    layer.blend = options.blend_mode;
    layer.opacity = options.opacity;
    layer.visible = options.visible;
    layer.order = options.order;
    layer.pivot = options.pivot;
    layer.instance_floats_per_sprite = sprite_instance_floats;
    layer.capacity = static_cast<std::uint32_t>(
        std::max(1.0, static_cast<double>(options.capacity)));
    layer.instance_data.assign(
        static_cast<std::size_t>(layer.capacity) *
            layer.instance_floats_per_sprite,
        0.0f);
    layer.saved_size.assign(
        static_cast<std::size_t>(layer.capacity) *
            sprite_saved_size_floats,
        0.0f);
    engine.sprite_layers.push_back(std::move(layer));
    return Sprite2DLayerHandle{
        static_cast<std::uint32_t>(
            engine.sprite_layers.size() - 1u)};
}

double add_sprite_2d_index(
    Engine& engine,
    Sprite2DLayerHandle layer_handle,
    Sprite2DProps props) {
    Sprite2DLayerRecord& layer =
        engine.sprite_layers[layer_handle.value];
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[layer.atlas.value];
    const std::uint32_t index = layer.count;
    if (index >= layer.capacity) {
        grow_sprite_capacity(layer, index + 1u);
    }

    // writeInstance, add arm (\`prev === null\`): unspecified fields take
    // their documented defaults rather than a previous value.
    const std::size_t base =
        static_cast<std::size_t>(index) *
        layer.instance_floats_per_sprite;
    const std::size_t saved_base =
        static_cast<std::size_t>(index) *
        sprite_saved_size_floats;
    const bool has_frame = props.has_frame;
    const SpriteFrame frame = has_frame
        ? atlas.frames[upstream::resolve_sprite_frame(
              atlas,
              static_cast<double>(props.frame))]
        : SpriteFrame{};

    float true_w = 0.0f;
    float true_h = 0.0f;
    if (props.has_size_px) {
        true_w = props.size_px.x;
        true_h = props.size_px.y;
    } else if (has_frame) {
        true_w = frame.source_size_px.x;
        true_h = frame.source_size_px.y;
    }
    layer.saved_size[saved_base] = true_w;
    layer.saved_size[saved_base + 1u] = true_h;

    const bool visible =
        props.has_visible ? props.visible : true;

    float u_min = 0.0f;
    float v_min = 0.0f;
    float u_max = 1.0f;
    float v_max = 1.0f;
    if (has_frame) {
        u_min = frame.uv_min.x;
        v_min = frame.uv_min.y;
        u_max = frame.uv_max.x;
        v_max = frame.uv_max.y;
    }
    // flipX/flipY are absolute orientation flags resolved against the flip
    // already baked into the endpoints; on add there is no previous
    // orientation, so an omitted flag leaves them as the frame wrote them.
    const bool current_flip_x = u_min > u_max;
    const bool current_flip_y = v_min > v_max;
    const bool wants_flip_x =
        props.has_flip_x ? props.flip_x : false;
    const bool wants_flip_y =
        props.has_flip_y ? props.flip_y : false;
    if (current_flip_x != wants_flip_x) {
        std::swap(u_min, u_max);
    }
    if (current_flip_y != wants_flip_y) {
        std::swap(v_min, v_max);
    }

    const float rotation =
        props.has_rotation ? props.rotation : 0.0f;

    layer.instance_data[base + 0u] = props.position_px.x;
    layer.instance_data[base + 1u] = props.position_px.y;
    layer.instance_data[base + 2u] = visible ? true_w : 0.0f;
    layer.instance_data[base + 3u] = visible ? true_h : 0.0f;
    layer.instance_data[base + 4u] = u_min;
    layer.instance_data[base + 5u] = v_min;
    layer.instance_data[base + 6u] = u_max;
    layer.instance_data[base + 7u] = v_max;
    layer.instance_data[base + 8u] = rotation;
    layer.instance_data[base + 9u] =
        props.has_color ? props.color.x : 1.0f;
    layer.instance_data[base + 10u] =
        props.has_color ? props.color.y : 1.0f;
    layer.instance_data[base + 11u] =
        props.has_color ? props.color.z : 1.0f;
    layer.instance_data[base + 12u] =
        props.has_color ? props.color.w : 1.0f;

    layer.count = index + 1u;
    layer.version += 1u;
    return static_cast<double>(index);
}

SpriteRendererHandle create_sprite_renderer(
    Engine& engine,
    SpriteRendererOptions options) {
    SpriteRendererRecord renderer;
    renderer.layers = std::move(options.layers);
    renderer.clear = options.clear;
    renderer.clear_value = options.clear_value;
    for (const Sprite2DLayerHandle& layer : renderer.layers) {
        if (layer.value >= engine.sprite_layers.size()) {
            throw std::runtime_error(
                "SpriteRenderer received an unknown layer.");
        }
    }
    engine.sprite_renderers.push_back(std::move(renderer));
    return SpriteRendererHandle{
        static_cast<std::uint32_t>(
            engine.sprite_renderers.size() - 1u)};
}

void register_sprite_renderer(
    Engine& engine,
    SpriteRendererHandle renderer) {
    engine.registered_sprite_renderers.push_back(renderer);
}

} // namespace bbl
`,
        };
    }
}
