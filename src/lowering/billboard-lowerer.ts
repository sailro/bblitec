import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { PinnedShaderText } from "./pinned-shader-text.js";
import {
    blendFactoriesCpp,
    readPinnedBlendTable,
} from "./pinned-blend-table.js";

const systemModule = "src/sprite/billboard-sprite.ts";
const sceneModule = "src/sprite/billboard-scene.ts";
const blendModule = "src/sprite/billboard-blend.ts";
const pipelineModule = "src/sprite/billboard-pipeline.ts";
const atlasModule = "src/sprite/shared/sprite-atlas.ts";

/**
 * Which basis the vertex stage builds. The pin's composer emits one of two
 * functions from `system._orientation` and leaves the rest of the stage
 * identical, so this is the whole difference between the two families of
 * billboard.
 */
export type BillboardOrientation = "facing" | "axis-locked";

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

    /**
     * The pin's blend descriptors, read as the pure data they are: every
     * exported `billboardBlend*` that names a colour blend becomes a native
     * factory. Walking the module rather than naming two descriptors here is
     * what keeps a blend the pin adds from needing a compiler change, and
     * what makes a blend it CHANGES change what we emit.
     *
     * `cutout` carries no `_descriptor` and drives an alpha-test depth-write
     * path this slice does not render, so it is skipped here and refused at
     * the intrinsic.
     */
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
        const writes = this.context
            .findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isElementAccessExpression(node.left) &&
                    ts.isIdentifier(node.left.expression) &&
                    node.left.expression.text === "ubo",
            )
            .map((node) => node as ts.BinaryExpression);
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
        const write = this.context
            .findNodes(
                declaration,
                (node): node is ts.BinaryExpression =>
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    ts.isElementAccessExpression(node.left) &&
                    ts.isIdentifier(node.left.expression) &&
                    node.left.expression.text === "depths",
            )
            .map((node) => node as ts.BinaryExpression)[0];
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
    ): BillboardShaderSource {
        const permutation = new Map<string, string | boolean>([
            ["orientation", orientation],
            ["depthMode", "transparent"],
            ["alphaToCoverage", false],
        ]);
        const full = this.shaderText.evaluate(
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
            vertexReadsSystemBlock: basis.includes("billboards."),
            systemStructFields: this.shaderText.between(
                full,
                "struct S {",
                "};",
                "billboard system uniform struct",
            ),
            basisFunction: basis,
            instanceStructFields: this.shaderText.between(
                full,
                "struct I {",
                "};",
                "billboard instance struct",
            ),
            varyingStructFields: this.shaderText.between(
                full,
                "struct O {",
                "};",
                "billboard varying struct",
            ),
            vertexBody: this.shaderText.between(
                full,
                "fn vs(in: I) -> O {",
                "\n}",
                "billboard vertex stage",
            ),
            fragmentBody: this.shaderText.between(
                full,
                "fn fs(in: O) -> @location(0) vec4f {",
                "\n}",
                "billboard fragment stage",
            ),
        };
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
        // A cutout mode is not another factor pair: the pin's own
        // `_depthMode` says it drives an alpha-test depth-write pipeline,
        // which this path does not render. Filtering on that field rather
        // than on a descriptor's name is what keeps the lowerer and the
        // intrinsic refusing the same set.
        const blends = readPinnedBlendTable(
            this.context,
            blendModule,
            "billboardBlend",
        ).filter((blend) => blend.depthMode === "transparent");
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
    system.opacity = options.opacity;
    system.visible = options.visible;
    system.orientation = orientation;
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
    system.alpha_cutoff = 0.0f;
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
    return static_cast<double>(index);
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
