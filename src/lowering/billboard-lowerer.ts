import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import {
    extraTextureBindingsWgsl,
    extraTextureRecords,
} from "../shader-builtins-sprite-fx.js";
import {
    PinnedShaderText,
    ShaderTextBinding,
} from "./pinned-shader-text.js";
import {
    blendFactoriesCpp,
    readPinnedBlendTable,
} from "./pinned-blend-table.js";

const systemModule = "src/sprite/billboard-sprite.ts";
const sceneModule = "src/sprite/billboard-scene.ts";
const blendModule = "src/sprite/billboard-blend.ts";
const pipelineModule = "src/sprite/billboard-pipeline.ts";
const atlasModule = "src/sprite/shared/sprite-atlas.ts";
const customShaderModule = "src/sprite/billboard-custom-shader.ts";
// The particle family owns its own Multiply module, deliberately outside
// the two sprite composers: it declares no SpriteFx block at all.
const particleMultiplyModule =
    "src/particle/particle-billboard-renderable.ts";

/**
 * Which basis the vertex stage builds. The pin's composer emits one of two
 * functions from `system._orientation` and leaves the rest of the stage
 * identical, so this is the whole difference between the two families of
 * billboard.
 */
export type BillboardOrientation = "facing" | "axis-locked";

/**
 * Which depth path a system draws through. The pin's `DEPTH_MODE_TABLE`
 * pairs `transparent` with depth writes off and `cutout` with them on, and
 * the fragment stage discards below the cutoff only on the second — so this
 * selects a fragment arm, a pipeline state, and (per the module doc) the
 * slot the system draws in.
 */
export type BillboardDepthMode = "transparent" | "cutout";

/** The billboard shader, split into the pieces each backend re-homes. */
export interface BillboardShaderSource {
    /**
     * Whether the vertex stage reads the system block. Derived from the
     * pin's own basis rather than from a table here — an orientation that
     * starts reading the lock axis picks the binding up by itself — but
     * carried as a value so the WGSL emitter and the two PALs cannot state
     * it differently.
     */
    vertexReadsSystemBlock: boolean;
    systemStructFields: string;
    basisFunction: string;
    instanceStructFields: string;
    varyingStructFields: string;
    vertexBody: string;
    fragmentBody: string;
    /**
     * `SpriteFx` struct body, present only for a custom-shader system. The
     * block is bound whether or not the caller's body names `fx`, which is
     * why it rides the source rather than being sniffed out of the text.
     */
    fxStructFields?: string | undefined;
    /**
     * The `<name>Tex` / `<name>Samp` pairs a custom shader's extra textures
     * bind through, at this backend's own group, and empty when the body
     * named none. Emitted by the pin's own builder, so the pair it writes
     * per texture is the pin's.
     */
    extraTextureBindings: string;
}

/** One per-instance vertex attribute, at the pin's own byte offset. */
interface AttributeRow {
    location: number;
    offsetBytes: number;
    floatCount: number;
}

/**
 * World-space billboards, lowered from the pinned billboard family.
 *
 * The 2D sprite family that already ships and this one are the same shape
 * twice — an atlas, a packed instance buffer, a quad expanded in the vertex
 * stage — so this mirrors `SpriteLowerer` deliberately, down to which
 * contracts it asserts. What differs is the only thing that matters: the
 * quad is expanded in WORLD space around a camera-derived basis, and it
 * draws inside the scene's own pass against the scene depth buffer, which
 * is why the pinned shader binds the scene UBO at group 0 rather than
 * owning a view of its own.
 *
 * Only the permutation reached by scene code is lowered: camera-facing,
 * straight-alpha, no custom shader and no alpha-to-coverage. Every other
 * arm refuses at the intrinsic rather than silently rendering the wrong one.
 */
export class BillboardLowerer {
    private readonly shaderText: PinnedShaderText;

    public constructor(
        private readonly context: LoweringContext,
        sceneUboWgsl: string,
    ) {
        // `SCENE_UBO_WGSL` is an import in the pinned pipeline module, so the
        // evaluator cannot reach it; the renderer already owns that text and
        // hands it in, which keeps one copy of the scene UBO in the tree.
        this.shaderText = new PinnedShaderText(
            context,
            new Map([["SCENE_UBO_WGSL", sceneUboWgsl]]),
        );
    }

    // -----------------------------------------------------------------
    // Pinned contracts
    // -----------------------------------------------------------------

    /** The instance layout, read from the pin's own constants. */
    private layout(): {
        instanceFloats: number;
        systemUboBytes: number;
    } {
        const constant = (module: string, name: string): number => {
            const file = this.context.sourceFile(module);
            return this.context.numericValue(
                this.context.variableInitializer(file, name),
                file,
            );
        };
        return {
            instanceFloats: constant(
                systemModule,
                "BILLBOARD_INSTANCE_FLOATS_PER_SPRITE",
            ),
            systemUboBytes: constant(
                pipelineModule,
                "BILLBOARD_SYSTEM_UBO_BYTES",
            ),
        };
    }

    /**
     * The vertex attributes, at the byte offsets the pin declares. Reading
     * the offsets rather than deriving them from the slot order is what
     * makes a reordered pin fail loudly instead of drawing garbage.
     */
    private attributeRows(instanceFloats: number): AttributeRow[] {
        const file = this.context.sourceFile(pipelineModule);
        const offset = (name: string): number =>
            this.context.numericValue(
                this.context.variableInitializer(file, name),
                file,
            );
        const rows: AttributeRow[] = [
            {
                location: 0,
                offsetBytes: offset("BILLBOARD_POSITION_OFFSET_BYTES"),
                floatCount: 3,
            },
            {
                location: 1,
                offsetBytes: offset("BILLBOARD_SIZE_OFFSET_BYTES"),
                floatCount: 2,
            },
            {
                location: 2,
                offsetBytes: offset("BILLBOARD_UV_MIN_OFFSET_BYTES"),
                floatCount: 2,
            },
            {
                location: 3,
                offsetBytes: offset("BILLBOARD_UV_MAX_OFFSET_BYTES"),
                floatCount: 2,
            },
            {
                location: 4,
                offsetBytes: offset("BILLBOARD_ROTATION_OFFSET_BYTES"),
                floatCount: 1,
            },
            {
                location: 5,
                offsetBytes: offset("BILLBOARD_PIVOT_OFFSET_BYTES"),
                floatCount: 2,
            },
            {
                location: 6,
                offsetBytes: offset("BILLBOARD_COLOR_OFFSET_BYTES"),
                floatCount: 4,
            },
        ];
        const covered = rows.reduce(
            (total, row) => total + row.floatCount,
            0,
        );
        if (covered !== instanceFloats) {
            this.context.contractError(
                this.context.sourceFile(pipelineModule),
                `Pinned billboard attributes cover ${covered} floats, but an instance holds ${instanceFloats}.`,
            );
        }
        return rows;
    }

    /** `writeInstance` writes each slot from the source the pin names. */
    private assertInstanceSlots(): void {
        const { declaration } = this.context.functionDeclaration(
            systemModule,
            "writeInstance",
        );
        const expected: ReadonlyArray<[number, string]> = [
            [0, "posX"],
            [1, "posY"],
            [2, "posZ"],
            [3, "visible ? trueWidth : 0"],
            [4, "visible ? trueHeight : 0"],
            [5, "uvMinX"],
            [6, "uvMinY"],
            [7, "uvMaxX"],
            [8, "uvMaxY"],
            [9, "rotation"],
            [10, "pivotX"],
            [11, "pivotY"],
        ];
        const writes = this.elementAssignments(declaration, "data");
        for (const [slot, source] of expected) {
            const write = writes.find(
                (node) =>
                    this.elementIndexText(node.left) ===
                    `base + ${slot}`,
            );
            if (!write) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard writeInstance no longer writes slot ${slot}.`,
                );
            }
            this.context.assertExpressionShape(
                write.right,
                source,
                `billboard writeInstance slot ${slot}`,
            );
        }
        // Colour writes twice — the props arm and the add default — so it is
        // checked by count, the way the 2D layer's is.
        for (const slot of [12, 13, 14, 15]) {
            const found = writes.filter(
                (node) =>
                    this.elementIndexText(node.left) ===
                    `base + ${slot}`,
            );
            if (found.length !== 2) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard colour slot ${slot} has ${found.length} writers, expected 2.`,
                );
            }
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "base"),
            "slotIndex * BILLBOARD_INSTANCE_FLOATS_PER_SPRITE",
            "billboard writeInstance base",
        );
        // The flip resolution is what makes flipX an absolute orientation
        // rather than a toggle.
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "currentFlipX",
            ),
            "uvMinX > uvMaxX",
            "billboard writeInstance currentFlipX",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                declaration,
                "wantsFlipX",
            ),
            "props.flipX !== undefined ? props.flipX === true : prevFlipX",
            "billboard writeInstance wantsFlipX",
        );
        // On add, the pivot falls back to the frame's own pivot; a scene that
        // omits it must not silently get the centre of a frame that names
        // another anchor.
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "pivotX"),
            "props.pivot ? props.pivot[0] : prev ? prev[10] : (frame?.pivot[0] ?? 0.5)",
            "billboard writeInstance pivotX",
        );
    }

    /** The system's defaults, which the intrinsic reproduces for an add. */
    private assertSystemDefaults(): void {
        const { declaration } = this.context.functionDeclaration(
            systemModule,
            "createBillboardSystem",
        );
        for (const [name, shape] of [
            ["blendMode", "opts.blendMode ?? billboardBlendAlpha"],
            [
                "capacity",
                "Math.max(1, opts.capacity ?? DEFAULT_CAPACITY)",
            ],
            ["depthMode", "blendMode._depthMode"],
        ] as const) {
            this.context.assertExpressionShape(
                this.context.variableInitializer(declaration, name),
                shape,
                `createBillboardSystem ${name}`,
            );
        }
        // The capacity shape above anchors DEFAULT_CAPACITY by name only;
        // the VALUE is what the intrinsic and runtime.hpp restate, so it is
        // read and checked the way the 2D lane checks sprite-2d's own
        // constant (they are independent pinned constants that both happen
        // to be 16 today).
        const file = this.context.sourceFile(systemModule);
        const defaultCapacity = this.context.numericValue(
            this.context.variableInitializer(file, "DEFAULT_CAPACITY"),
            file,
        );
        if (defaultCapacity !== 16) {
            this.context.contractError(
                file,
                `Pinned billboard DEFAULT_CAPACITY changed: ${defaultCapacity}.`,
            );
        }
        // The slot each depth mode draws in. Nothing stores this number --
        // the record carries the mode and both backends select on it -- but
        // the mapping it states is what the two draw slots ARE, so a pin
        // that retunes it has to fail generation rather than leave the
        // backends drawing in the old order.
        this.context.assertExpressionShape(
            this.context.propertyInitializer(
                this.context.objectInitializer(declaration, "system"),
                "order",
            ),
            'opts.order ?? (depthMode === "transparent" ? 200 : 100)',
            "createBillboardSystem order",
        );
        // A facing system's axis is the zero vector, which the UBO carries
        // and the facing basis ignores.
        this.context.assertExpressionShape(
            this.context.callExpression(
                this.context.functionDeclaration(
                    systemModule,
                    "createFacingBillboardSystem",
                ).declaration,
                "createBillboardSystem",
            ),
            'createBillboardSystem(atlas, "facing", [0, 0, 0], opts)',
            "createFacingBillboardSystem",
        );
        // The axis-locked factory normalises its axis before storing it, and
        // the basis reads `normalize(billboards.axisAndCutoff.xyz)` again --
        // so a scene's raw axis has to be normalised at the same point the
        // pin normalises it, not left to the shader.
        const axisLocked = this.context.functionDeclaration(
            systemModule,
            "createAxisLockedBillboardSystem",
        ).declaration;
        this.context.assertExpressionShape(
            this.context.variableInitializer(axisLocked, "lengthSq"),
            "axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]",
            "createAxisLockedBillboardSystem lengthSq",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(axisLocked, "invLength"),
            "1 / Math.sqrt(lengthSq)",
            "createAxisLockedBillboardSystem invLength",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(axisLocked, "normalized"),
            "[axis[0] * invLength, axis[1] * invLength, axis[2] * invLength]",
            "createAxisLockedBillboardSystem normalized",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.functionDeclaration(
                    systemModule,
                    "resolveOpacity",
                ).declaration,
                "opacity",
            ),
            "opts.opacity ?? 1",
            "resolveOpacity",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.functionDeclaration(
                    systemModule,
                    "resolveAlphaCutoff",
                ).declaration,
                "cutoff",
            ),
            'opts.alphaCutoff ?? (depthMode === "cutout" ? 0.5 : 0)',
            "resolveAlphaCutoff",
        );
    }

    /** The transparent arm draws without writing depth. */
    private assertDepthMode(): void {
        const file = this.context.sourceFile(pipelineModule);
        this.context.assertExpressionShape(
            this.context.variableInitializer(file, "DEPTH_MODE_TABLE"),
            "{ transparent: { index: 0, writeEnabled: false }, cutout: { index: 1, writeEnabled: true } }",
            "DEPTH_MODE_TABLE",
        );
    }

    /** The eight floats of the per-system UBO, in the pinned order. */
    private assertSystemUbo(): void {
        const { declaration } = this.context.functionDeclaration(
            pipelineModule,
            "buildBillboardSystemUbo",
        );
        const writes = this.elementAssignments(declaration, "ubo");
        // Slots 0..3 are written twice (premultiplied and straight arms);
        // the straight arm is the one this path reaches.
        for (const slot of [0, 1, 2, 3]) {
            const found = writes.filter(
                (node) =>
                    this.elementIndexText(node.left) === `${slot}`,
            );
            if (found.length !== 2) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard UBO slot ${slot} has ${found.length} writers, expected 2.`,
                );
            }
        }
        for (const [slot, source] of [
            [4, "system._axis[0]"],
            [5, "system._axis[1]"],
            [6, "system._axis[2]"],
            [7, "system.alphaCutoff"],
        ] as const) {
            const write = writes.find(
                (node) =>
                    this.elementIndexText(node.left) === `${slot}`,
            );
            if (!write) {
                this.context.contractError(
                    declaration,
                    `Pinned billboard UBO no longer writes slot ${slot}.`,
                );
            }
            this.context.assertExpressionShape(
                write.right,
                source,
                `billboard UBO slot ${slot}`,
            );
        }
    }

    /**
     * The transparent draw is back-to-front by view-space depth. The sort is
     * not an optimisation: with depth writes off, the order the instances
     * are drawn in IS the composite, so this expression decides the image.
     */
    private assertSortDepth(): void {
        const { declaration } = this.context.functionDeclaration(
            pipelineModule,
            "uploadSortedBillboardInstances",
        );
        const write = this.elementAssignments(declaration, "depths")[0];
        if (!write) {
            this.context.contractError(
                declaration,
                "Pinned billboard sort no longer writes a depth.",
            );
        }
        this.context.assertExpressionShape(
            write.right,
            "cameraViewMatrix[2] * anchorX + cameraViewMatrix[6] * anchorY + cameraViewMatrix[10] * anchorZ + cameraViewMatrix[14]",
            "billboard sort depth",
        );
    }

    /** The quad the vertex stage expands, and the draw that issues it. */
    private assertQuad(): void {
        this.context.assertExpressionShape(
            this.context.variableInitializer(
                this.context.sourceFile(pipelineModule),
                "BILLBOARD_INDEX_DATA",
            ),
            "new U16([0, 1, 2, 0, 2, 3])",
            "billboard index data",
        );
    }

    /** `addFacingBillboardSystem` joins the scene's own renderables. */
    private assertSceneRegistration(): void {
        const { declaration } = this.context.functionDeclaration(
            sceneModule,
            "addFacingBillboardSystem",
        );
        this.context.assertExpressionShape(
            this.context.callExpression(
                declaration,
                "addBillboardSystem",
            ),
            "addBillboardSystem(scene, system)",
            "addFacingBillboardSystem",
        );
        if (
            !this.context.hasCall(
                this.context.functionDeclaration(
                    sceneModule,
                    "addBillboardSystem",
                ).declaration,
                "addDeferredSceneRenderables",
            )
        ) {
            this.context.contractError(
                declaration,
                "Expected a billboard system to register as a deferred scene renderable.",
            );
        }
    }

    // -----------------------------------------------------------------
    // Shader
    // -----------------------------------------------------------------

    /**
     * The WGSL for the permutation scene code reaches, reconstructed by
     * folding the pin's own builders.
     */
    public shaderSource(
        orientation: BillboardOrientation = "facing",
        depthMode: BillboardDepthMode = "transparent",
        customFragment?: string,
        extraTextures: readonly string[] = [],
    ): BillboardShaderSource {
        const permutation = new Map<string, ShaderTextBinding>([
            ["orientation", orientation],
            ["depthMode", depthMode],
            ["alphaToCoverage", false],
        ]);
        // The custom composer is the pin's own second builder, not this one
        // with a body swapped in: it keeps the world-space vertex stage and
        // the varying contract, and adds the fx block the caller may read.
        const composed =
            customFragment === undefined
                ? undefined
                : this.shaderText.evaluate(
                      customShaderModule,
                      "makeCustomBillboardWgsl",
                      // The three the pin's own composer takes: it has no
                      // depth or coverage arm, so binding those would pre-fill
                      // a parameter a later pin could add under either name.
                      new Map<string, ShaderTextBinding>([
                          ["orientation", orientation],
                          [
                              "extraTextures",
                              extraTextureRecords(extraTextures),
                          ],
                          ["fragment", customFragment],
                      ]),
                  );
        const full =
            composed ??
            this.shaderText.evaluate(
                pipelineModule,
                "makeBillboardWgsl",
                permutation,
            );
        const basis = this.shaderText.evaluate(
            pipelineModule,
            "makeBillboardBasisWgsl",
            new Map<string, string | boolean>([
                ["orientation", orientation],
            ]),
        );
        return {
            ...this.bracedShaderSections(full, basis, "billboard"),
            fxStructFields: composed
                ? this.shaderText.braced(
                      composed,
                      "struct SpriteFx {",
                      "billboard fx uniform struct",
                  )
                : undefined,
            extraTextureBindings: extraTextureBindingsWgsl(
                this.shaderText,
                extraTextures,
            ),
        };
    }

    /**
     * The six pieces every billboard-family program splits into, extracted
     * from one composed module under a family's own error labels. Both
     * composers emit the same struct and stage markers, so the extraction
     * is stated once and each caller adds only what its family declares
     * beyond it.
     */
    private bracedShaderSections(
        full: string,
        basis: string,
        labelPrefix: string,
    ): Omit<
        BillboardShaderSource,
        "fxStructFields" | "extraTextureBindings"
    > {
        return {
            vertexReadsSystemBlock: basis.includes("billboards."),
            systemStructFields: this.shaderText.braced(
                full,
                "struct S {",
                `${labelPrefix} system uniform struct`,
            ),
            basisFunction: basis,
            instanceStructFields: this.shaderText.braced(
                full,
                "struct I {",
                `${labelPrefix} instance struct`,
            ),
            varyingStructFields: this.shaderText.braced(
                full,
                "struct O {",
                `${labelPrefix} varying struct`,
            ),
            vertexBody: this.shaderText.braced(
                full,
                "fn vs(in: I) -> O {",
                `${labelPrefix} vertex stage`,
            ),
            fragmentBody: this.shaderText.braced(
                full,
                "fn fs(in: O) -> @location(0) vec4f {",
                `${labelPrefix} fragment stage`,
            ),
        };
    }

    /**
     * The particle family's private Multiply program.
     *
     * It is a third billboard composer, not this one with a fragment swapped
     * in: `particle-billboard-renderable.ts` writes its own whole module so
     * the Multiply-only bundle carries no `SpriteFx` declaration, layout
     * entry or per-frame write at all. Its vertex half is byte-identical to
     * the stock stage today, and it is still taken from the pin's own
     * builder — a builder that starts differing has to move what we deploy,
     * not be caught by a comparison here.
     */
    public particleMultiplyShaderSource(
        orientation: BillboardOrientation,
    ): BillboardShaderSource {
        const full = this.shaderText.evaluate(
            particleMultiplyModule,
            "makeMultiplyWgsl",
            new Map<string, ShaderTextBinding>([
                ["orientation", orientation],
            ]),
        );
        const basis = this.shaderText.evaluate(
            pipelineModule,
            "makeBillboardBasisWgsl",
            new Map<string, string | boolean>([
                ["orientation", orientation],
            ]),
        );
        return {
            ...this.bracedShaderSections(full, basis, "particle multiply"),
            extraTextureBindings: "",
        };
    }

    /** Every `<arrayName>[...] = ...` store in a declaration, in order. */
    private elementAssignments(
        declaration: ts.Node,
        arrayName: string,
    ): ts.BinaryExpression[] {
        return this.context.findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind ===
                    ts.SyntaxKind.EqualsToken &&
                ts.isElementAccessExpression(node.left) &&
                ts.isIdentifier(node.left.expression) &&
                node.left.expression.text === arrayName,
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

    // -----------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------

    public lowerCore(): LoweredSource {
        const layout = this.layout();
        const rows = this.attributeRows(layout.instanceFloats);
        this.assertSystemDefaults();
        const blends = readPinnedBlendTable(
            this.context,
            blendModule,
            "billboardBlend",
        );
        this.assertDepthMode();
        this.assertInstanceSlots();
        this.assertSystemUbo();
        this.assertSortDepth();
        this.assertQuad();
        this.assertSceneRegistration();

        const provenance = this.context.provenance(
            systemModule,
            "createFacingBillboardSystem, addBillboardSpriteIndex",
            `${sceneModule}#addFacingBillboardSystem, ${blendModule}#billboardBlendAlpha, ${pipelineModule}#buildBillboardSystemUbo, ${atlasModule}#resolveSpriteFrame`,
        );
        return {
            modulePath: systemModule,
            symbolName:
                "createFacingBillboardSystem,addBillboardSpriteIndex,addFacingBillboardSystem",
            header: `#pragma once

// ${this.context.provenance(pipelineModule, "billboard vertex layout")}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <array>
#include <cstdint>
#include <numeric>
#include <vector>

namespace bbl::upstream {

/**
 * The per-instance vertex attributes at the pin's own byte offsets, and the
 * stride billboard-sprite.ts derives from its floats-per-sprite. Both render
 * backends translate these rows into their API's descriptors, so the numbers
 * exist once, here.
 */
struct BillboardInstanceAttribute {
    std::uint32_t shader_location;
    std::uint32_t byte_offset;
    std::uint32_t float_count;
};

inline constexpr std::array<BillboardInstanceAttribute, ${rows.length}>
    billboard_instance_attributes{{
${rows
    .map(
        (row) =>
            `        {${row.location}u, ${row.offsetBytes}u, ${row.floatCount}u},`,
    )
    .join("\n")}
    }};

inline constexpr std::uint32_t billboard_instance_stride_bytes =
    ${layout.instanceFloats * 4}u;

inline constexpr std::uint32_t billboard_system_ubo_bytes = ${layout.systemUboBytes}u;

} // namespace bbl::upstream

namespace bbl {

/**
 * billboard-blend.ts: each exported descriptor that names a colour blend, as
 * the factory scene code reaches when it imports that descriptor by name.
 * They live here rather than in the system's own translation unit because
 * the scene names one at the call site.
 */
${blendFactoriesCpp(blends, "billboard", "billboard-blend.ts")}
} // namespace bbl

namespace bbl::upstream {

/** The quad, expanded in the vertex stage; six indices, one draw. */
inline constexpr std::array<std::uint16_t, 6> billboard_index_data{
    {0u, 1u, 2u, 0u, 2u, 3u}};


/**
 * buildBillboardSystemUbo: a premultiplied source scales RGB and A together
 * for a correct fade; straight alpha scales only A, because the blend stage
 * already weights colour by source alpha.
 * The axis is the facing system's zero vector, which the facing basis
 * ignores; the cutoff rides slot 7 unread by the transparent arm.
 */
inline void build_billboard_system_ubo(
    const BillboardSystemRecord& system,
    std::array<float, ${layout.systemUboBytes / 4}>& ubo) {
    const float opacity = system.opacity;
    if (system.blend.premultiplied_opacity) {
        ubo[0] = opacity;
        ubo[1] = opacity;
        ubo[2] = opacity;
        ubo[3] = opacity;
    } else {
        ubo[0] = 1.0f;
        ubo[1] = 1.0f;
        ubo[2] = 1.0f;
        ubo[3] = opacity;
    }
    ubo[4] = system.axis.x;
    ubo[5] = system.axis.y;
    ubo[6] = system.axis.z;
    ubo[7] = system.alpha_cutoff;
}

/**
 * uploadSortedBillboardInstances: view-space depth of an anchor. With depth
 * writes off the draw order IS the composite, so the transparent pass sorts
 * back to front on this value every frame.
 */
inline float billboard_sort_depth(
    const std::array<float, 16>& view,
    float anchor_x,
    float anchor_y,
    float anchor_z) {
    return view[2] * anchor_x + view[6] * anchor_y +
           view[10] * anchor_z + view[14];
}

/**
 * uploadSortedBillboardInstances: the instance data, reordered back to front
 * for one view.
 *
 * Both backends upload the result verbatim, and neither may decide the
 * order: with depth writes off it IS the composite, so a per-backend copy of
 * this would be a per-backend copy of the image. A stable sort over an index
 * sequence keeps the pin's own left-minus-right tie-break without spelling
 * it.
 */
inline void billboard_sorted_instances(
    const BillboardSystemRecord& system,
    const std::array<float, 16>& view,
    std::vector<float>& out) {
    const std::size_t floats = system.instance_floats_per_sprite;
    out.resize(static_cast<std::size_t>(system.count) * floats);
    if (system.count == 0) {
        return;
    }
    std::vector<std::uint32_t> order(system.count);
    std::iota(order.begin(), order.end(), 0u);
    std::vector<float> depths(system.count);
    for (std::uint32_t index = 0; index < system.count; ++index) {
        const std::size_t base =
            static_cast<std::size_t>(index) * floats;
        depths[index] = billboard_sort_depth(
            view,
            system.instance_data[base],
            system.instance_data[base + 1u],
            system.instance_data[base + 2u]);
    }
    std::stable_sort(
        order.begin(),
        order.end(),
        [&](std::uint32_t left, std::uint32_t right) {
            return depths[left] > depths[right];
        });
    for (std::uint32_t slot = 0; slot < system.count; ++slot) {
        const std::size_t source =
            static_cast<std::size_t>(order[slot]) * floats;
        const std::size_t destination =
            static_cast<std::size_t>(slot) * floats;
        for (std::size_t field = 0; field < floats; ++field) {
            out[destination + field] =
                system.instance_data[source + field];
        }
    }
}

#if BBLITE_FLOATING_ORIGIN
/**
 * The anchor lanes of every staged instance, rebuilt eye-relative.
 *
 * The three position floats lead each instance (setSpriteProps writes them
 * at base + 0..2), and the subtraction runs in double before the single
 * float store -- the same large - large = small the mesh worlds take.
 */
inline void billboard_apply_floating_origin(
    const BillboardSystemRecord& system,
    std::vector<float>& out,
    Vec3d offset) {
    const std::size_t stride = system.instance_floats_per_sprite;
    for (std::size_t base = 0; base + 2 < out.size(); base += stride) {
        out[base + 0] = static_cast<float>(
            static_cast<double>(out[base + 0]) - offset.x);
        out[base + 1] = static_cast<float>(
            static_cast<double>(out[base + 1]) - offset.y);
        out[base + 2] = static_cast<float>(
            static_cast<double>(out[base + 2]) - offset.z);
    }
}
#endif

/**
 * The instance data a system uploads this frame, in the order its depth mode
 * gives it.
 *
 * A transparent system writes no depth, so the draw order IS the composite
 * and the instances are staged back to front for the view. A cutout system
 * writes depth, so the GPU resolves its own overlap and the pin uploads in
 * logical insertion order instead. Neither backend chooses: a per-backend
 * copy of this choice would be a per-backend copy of the image.
 */
inline void billboard_upload_instances(
    const BillboardSystemRecord& system,
    const std::array<float, 16>& view,
    std::vector<float>& out
#if BBLITE_FLOATING_ORIGIN
    // The active camera's world translation. A billboard's anchor is a
    // world position uploaded per instance, so it takes the same
    // eye-relative bake the mesh worlds do -- after the sort, which is
    // computed against the absolute view and would order the same either
    // way but is left exactly as the pin runs it.
    ,
    Vec3d fo_offset
#endif
) {
    if (system.depth_mode == BillboardDepthMode::cutout) {
        const std::size_t floats =
            static_cast<std::size_t>(system.count) *
            system.instance_floats_per_sprite;
        out.assign(
            system.instance_data.begin(),
            system.instance_data.begin() +
                static_cast<std::ptrdiff_t>(floats));
    } else {
        billboard_sorted_instances(system, view, out);
    }
#if BBLITE_FLOATING_ORIGIN
    // Both arms leave out in the same shape, so the anchor bake is one
    // pass over whichever of the two filled it.
    billboard_apply_floating_origin(system, out, fo_offset);
#endif
}

} // namespace bbl::upstream
`,
            source: `// ${provenance}
#include <bblite/runtime.hpp>
#include <bblite/upstream/billboard_system.hpp>
// resolveSpriteFrame is the shared atlas module's, lowered once beside the
// 2D layer's own layout.
#include <bblite/upstream/sprite_layer.hpp>

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace bbl {

// createBillboardSystem: both factories delegate here, differing only in the
// orientation and the axis it carries. A facing system's axis is the pin's
// zero vector -- its basis reads the camera, not the axis.
BillboardSystemHandle create_billboard_system(
    Engine& engine,
    SpriteAtlasHandle atlas,
    BillboardOrientation orientation,
    Vec3 axis,
    BillboardSystemOptions options) {
    if (atlas.value >= engine.sprite_atlases.size()) {
        throw std::runtime_error("Invalid sprite atlas handle.");
    }
    BillboardSystemRecord system;
    system.atlas = atlas;
    system.blend = options.blend;
    system.add_pass_blend = options.add_pass_blend;
    // initSystem, through the fx hook: a system built with a descriptor
    // draws that program, its extra textures bind after the atlas, and
    // its params start zeroed.
    system.custom_shader = options.custom_shader;
    system.custom_textures = std::move(options.custom_textures);
    system.custom_texture_names = std::move(options.custom_texture_names);
    system.opacity = options.opacity;
    system.visible = options.visible;
    system.orientation = orientation;
    // resolveAlphaCutoff follows the descriptor's depth mode, and so does
    // the slot the system draws in -- which is the mode itself, so only the
    // mode is stored.
    const bool cutout =
        options.blend.depth_mode == BillboardDepthMode::cutout;
    system.depth_mode = options.blend.depth_mode;
    // createAxisLockedBillboardSystem: the axis is normalised before it is
    // stored, and a non-finite or zero axis is rejected. The basis
    // normalises again in WGSL, but a zero axis has no direction to recover
    // there, so the refusal belongs here as it does upstream.
    if (orientation == BillboardOrientation::axis_locked) {
        const double length_sq =
            static_cast<double>(axis.x) * axis.x +
            static_cast<double>(axis.y) * axis.y +
            static_cast<double>(axis.z) * axis.z;
        if (!std::isfinite(length_sq)) {
            throw std::runtime_error(
                "createAxisLockedBillboardSystem: axis components must be "
                "finite numbers.");
        }
        if (length_sq < 1e-8) {
            throw std::runtime_error(
                "createAxisLockedBillboardSystem: axis must be non-zero.");
        }
        const double inv_length = 1.0 / std::sqrt(length_sq);
        axis = Vec3{
            static_cast<float>(axis.x * inv_length),
            static_cast<float>(axis.y * inv_length),
            static_cast<float>(axis.z * inv_length)};
    }
    system.axis = axis;
    system.alpha_cutoff = options.has_alpha_cutoff
        ? options.alpha_cutoff
        : (cutout ? 0.5f : 0.0f);
    system.instance_floats_per_sprite = ${layout.instanceFloats}u;
    system.capacity = static_cast<std::uint32_t>(
        std::max(1.0, static_cast<double>(options.capacity)));
    system.instance_data.assign(
        static_cast<std::size_t>(system.capacity) *
            system.instance_floats_per_sprite,
        0.0f);
    engine.billboard_systems.push_back(std::move(system));
    return BillboardSystemHandle{
        static_cast<std::uint32_t>(
            engine.billboard_systems.size() - 1u)};
}

double add_billboard_sprite_index(
    Engine& engine,
    BillboardSystemHandle system_handle,
    BillboardSpriteProps props) {
    BillboardSystemRecord& system =
        engine.billboard_systems[system_handle.value];
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[system.atlas.value];
    const std::uint32_t index = system.count;
    if (index >= system.capacity) {
        const std::uint32_t capacity =
            std::max(index + 1u, system.capacity * 2u);
        system.instance_data.resize(
            static_cast<std::size_t>(capacity) *
                system.instance_floats_per_sprite,
            0.0f);
        system.capacity = capacity;
    }

    // writeInstance, add arm (\`prev === null\`): an unspecified field takes
    // its documented default rather than a previous value.
    const std::size_t base =
        static_cast<std::size_t>(index) *
        system.instance_floats_per_sprite;
    const bool has_frame = props.has_frame;
    const SpriteFrame frame = has_frame
        ? atlas.frames[upstream::resolve_sprite_frame(
              atlas,
              static_cast<double>(props.frame))]
        : SpriteFrame{};

    const float true_width =
        props.has_size_world ? props.size_world.x : 0.0f;
    const float true_height =
        props.has_size_world ? props.size_world.y : 0.0f;

    const bool visible =
        props.has_visible ? props.visible : true;

    float uv_min_x = 0.0f;
    float uv_min_y = 0.0f;
    float uv_max_x = 1.0f;
    float uv_max_y = 1.0f;
    if (has_frame) {
        uv_min_x = frame.uv_min.x;
        uv_min_y = frame.uv_min.y;
        uv_max_x = frame.uv_max.x;
        uv_max_y = frame.uv_max.y;
    }
    // flipX/flipY are absolute orientation flags resolved against the flip
    // already baked into the endpoints; on add there is no previous
    // orientation, so an omitted flag leaves them as the frame wrote them.
    const bool current_flip_x = uv_min_x > uv_max_x;
    const bool current_flip_y = uv_min_y > uv_max_y;
    const bool wants_flip_x =
        props.has_flip_x ? props.flip_x : false;
    const bool wants_flip_y =
        props.has_flip_y ? props.flip_y : false;
    if (current_flip_x != wants_flip_x) {
        std::swap(uv_min_x, uv_max_x);
    }
    if (current_flip_y != wants_flip_y) {
        std::swap(uv_min_y, uv_max_y);
    }

    const float rotation =
        props.has_rotation ? props.rotation : 0.0f;
    // With no previous instance the pivot falls back to the FRAME's pivot,
    // not to the quad centre.
    const float pivot_x =
        props.has_pivot ? props.pivot.x : frame.pivot.x;
    const float pivot_y =
        props.has_pivot ? props.pivot.y : frame.pivot.y;

    system.instance_data[base + 0u] = props.position.x;
    system.instance_data[base + 1u] = props.position.y;
    system.instance_data[base + 2u] = props.position.z;
    system.instance_data[base + 3u] = visible ? true_width : 0.0f;
    system.instance_data[base + 4u] = visible ? true_height : 0.0f;
    system.instance_data[base + 5u] = uv_min_x;
    system.instance_data[base + 6u] = uv_min_y;
    system.instance_data[base + 7u] = uv_max_x;
    system.instance_data[base + 8u] = uv_max_y;
    system.instance_data[base + 9u] = rotation;
    system.instance_data[base + 10u] = pivot_x;
    system.instance_data[base + 11u] = pivot_y;
    system.instance_data[base + 12u] =
        props.has_color ? props.color.x : 1.0f;
    system.instance_data[base + 13u] =
        props.has_color ? props.color.y : 1.0f;
    system.instance_data[base + 14u] =
        props.has_color ? props.color.z : 1.0f;
    system.instance_data[base + 15u] =
        props.has_color ? props.color.w : 1.0f;

    system.count = index + 1u;
    system.instance_version += 1u;
    return static_cast<double>(index);
}

BillboardSpriteHandle add_billboard_sprite(
    Engine& engine,
    BillboardSystemHandle system_handle,
    BillboardSpriteProps props) {
    const std::uint32_t index = static_cast<std::uint32_t>(
        add_billboard_sprite_index(engine, system_handle, props));
    BillboardSystemRecord& system =
        engine.billboard_systems[system_handle.value];
    if (system.next_handle_id == invalid_handle) {
        throw std::runtime_error("Billboard sprite handle id space exhausted.");
    }
    const std::uint32_t id = system.next_handle_id++;
    if (system.index_to_handle_id.size() < system.capacity) {
        system.index_to_handle_id.resize(system.capacity, 0u);
    }
    system.handle_id_to_index[id] = index;
    system.index_to_handle_id[index] = id;
    return BillboardSpriteHandle{system_handle, id};
}

void update_billboard_sprite(
    Engine& engine,
    BillboardSpriteHandle handle,
    BillboardSpriteProps props) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    BillboardSystemRecord& system =
        engine.billboard_systems[handle.system.value];
    const auto found = system.handle_id_to_index.find(handle.id);
    if (found == system.handle_id_to_index.end()) {
        throw std::runtime_error("Invalid billboard sprite handle.");
    }
    const std::size_t base =
        static_cast<std::size_t>(found->second) *
        system.instance_floats_per_sprite;
    if (props.has_position) {
        system.instance_data[base + 0u] = props.position.x;
        system.instance_data[base + 1u] = props.position.y;
        system.instance_data[base + 2u] = props.position.z;
    }
    if (props.has_size_world) {
        system.instance_data[base + 3u] = props.size_world.x;
        system.instance_data[base + 4u] = props.size_world.y;
    }
    if (props.has_color) {
        system.instance_data[base + 12u] = props.color.x;
        system.instance_data[base + 13u] = props.color.y;
        system.instance_data[base + 14u] = props.color.z;
        system.instance_data[base + 15u] = props.color.w;
    }
    system.instance_version += 1u;
}

// billboard-sprite-handle-animation.ts drives a sprite's frame through the
// same setter the 2D family has: rewrite the four UV floats from the atlas
// frame, keeping whichever axes the sprite was flipped on. The flip is read
// back off the stored endpoints rather than a stored flag, exactly as the
// add above resolves it.
void set_billboard_sprite_frame(
    Engine& engine,
    BillboardSpriteHandle handle,
    double frame) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    BillboardSystemRecord& system =
        engine.billboard_systems[handle.system.value];
    const auto found = system.handle_id_to_index.find(handle.id);
    if (found == system.handle_id_to_index.end()) {
        throw std::runtime_error("Invalid billboard sprite handle.");
    }
    const SpriteAtlasRecord& atlas =
        engine.sprite_atlases[system.atlas.value];
    const SpriteFrame& atlas_frame =
        atlas.frames[upstream::resolve_sprite_frame(atlas, frame)];
    const std::size_t base =
        static_cast<std::size_t>(found->second) *
        system.instance_floats_per_sprite;
    const bool flip_x =
        system.instance_data[base + 5u] > system.instance_data[base + 7u];
    const bool flip_y =
        system.instance_data[base + 6u] > system.instance_data[base + 8u];
    system.instance_data[base + 5u] =
        flip_x ? atlas_frame.uv_max.x : atlas_frame.uv_min.x;
    system.instance_data[base + 6u] =
        flip_y ? atlas_frame.uv_max.y : atlas_frame.uv_min.y;
    system.instance_data[base + 7u] =
        flip_x ? atlas_frame.uv_min.x : atlas_frame.uv_max.x;
    system.instance_data[base + 8u] =
        flip_y ? atlas_frame.uv_min.y : atlas_frame.uv_max.y;
    system.instance_version += 1u;
}

/** Whether a handle still names a sprite, which is what stops an animation
 *  stepping one its own removeWhenFinished already took away. */
bool billboard_sprite_alive(
    const Engine& engine,
    BillboardSpriteHandle handle) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        return false;
    }
    const BillboardSystemRecord& system =
        engine.billboard_systems[handle.system.value];
    return system.handle_id_to_index.count(handle.id) != 0;
}

void remove_billboard_sprite(
    Engine& engine,
    BillboardSpriteHandle handle) {
    if (handle.system.value >= engine.billboard_systems.size()) {
        return;
    }
    BillboardSystemRecord& system =
        engine.billboard_systems[handle.system.value];
    const auto found = system.handle_id_to_index.find(handle.id);
    if (found == system.handle_id_to_index.end()) {
        return;
    }
    const std::uint32_t index = found->second;
    const std::uint32_t last = system.count - 1u;
    if (index != last) {
        const std::size_t stride = system.instance_floats_per_sprite;
        std::copy_n(
            system.instance_data.begin() +
                static_cast<std::ptrdiff_t>(last * stride),
            stride,
            system.instance_data.begin() +
                static_cast<std::ptrdiff_t>(index * stride));
        const std::uint32_t moved = system.index_to_handle_id[last];
        system.index_to_handle_id[index] = moved;
        if (moved != 0u) {
            system.handle_id_to_index[moved] = index;
        }
    }
    system.index_to_handle_id[last] = 0u;
    system.handle_id_to_index.erase(found);
    system.count = last;
    system.instance_version += 1u;
}

void clear_billboard_sprites(
    Engine& engine,
    BillboardSystemHandle system_handle) {
    if (system_handle.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    // Keep the allocated instance buffer: the JavaScript system resets its
    // logical count and reuses capacity when a dynamic set is refilled.
    BillboardSystemRecord& system =
        engine.billboard_systems[system_handle.value];
    system.handle_id_to_index.clear();
    std::fill(
        system.index_to_handle_id.begin(),
        system.index_to_handle_id.end(),
        0u);
    if (system.count != 0u) {
        system.count = 0u;
        system.instance_version += 1u;
    }
}

// setBillboardShaderParams: the fx UBO the pipeline binds reads these four
// floats each frame. A system without a custom shader has no fx block to
// read them, which is the pin's own "no visual effect unless".
void set_billboard_shader_params(
    Engine& engine,
    BillboardSystemHandle system,
    Vec4 params) {
    if (system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    engine.billboard_systems[system.value].shader_params = params;
}

// render/alpha-to-coverage.ts setAlphaToCoverage: membership of the enabled
// set, which the pipeline owner reads when it builds. A flag on the record
// is the same fact without the WeakSet, because the record IS the target.
void set_billboard_alpha_to_coverage(
    Engine& engine,
    BillboardSystemHandle system,
    bool enabled) {
    if (system.value >= engine.billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    engine.billboard_systems[system.value].alpha_to_coverage = enabled;
}

void add_billboard_system(
    Scene& scene,
    BillboardSystemHandle system) {
    if (!scene.engine) {
        throw std::runtime_error("Scene has no engine.");
    }
    if (system.value >= scene.engine->billboard_systems.size()) {
        throw std::runtime_error("Invalid billboard system handle.");
    }
    scene.billboard_systems.push_back(system);
}

} // namespace bbl
`,
        };
    }
}
