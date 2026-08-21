// The two pinned functions that stand between a frozen particle buffer and
// the billboard family this port already renders.
//
// `createParticleBillboard` and `syncParticleBillboard` are small and their
// SHAPE is the contract, so they are folded from their own declarations
// rather than executed with the simulation: which atlas the pin derives from
// the system's texture and sprite sheet, which blend its numeric mode
// selects, and exactly which five props the sync writes per live particle.
// Each of those is asserted against the pinned source here, so a pin that
// changes any of them fails generation instead of baking over it.
//
// What the bake supplies is only the values: the particle columns, the
// texture the graph loaded and the mode the system block set.
import ts from "typescript";
import { LoweredSource, LoweringContext } from "./context.js";
import { blendFactorySymbol } from "./pinned-blend-table.js";
import {
    decodeAtlasImageCpp,
    gridSpriteAtlasFramesCpp,
    pushAtlasHandleCpp,
} from "./pinned-grid-atlas.js";
import type { NodeParticleSystemBake } from "../pinned-node-particle.js";
import type { CompileAsset } from "../compiler/types.js";

const billboardModule = "src/particle/particle-billboard.ts";

/** One baked system, with the asset its texture packaged under. */
export interface NodeParticleSystemEmit {
    bake: NodeParticleSystemBake;
    /** `assets/<output>` of the packaged texture. */
    textureAsset: string;
    /**
     * The asset record the caller registers and materializes. The bake
     * builds it because only the pin knows the URL it resolved, and the
     * caller owns the manifest it belongs to.
     */
    asset?: CompileAsset;
}

/**
 * Lowers the pinned particle-to-billboard bridge.
 *
 * The reached slice is a frozen system: `createParticleBillboard` over a
 * texture the graph loaded, `syncParticleBillboard` once, and the facing
 * billboard system the scene adds. A live system -- one the pin animates
 * from `scene._beforeRender` -- is refused at its call site instead.
 */
export class NodeParticleLowerer {
    public constructor(private readonly context: LoweringContext) {}

    // -----------------------------------------------------------------
    // Pinned contracts
    // -----------------------------------------------------------------

    /**
     * `blendForMode`, as the C++ the mapping is.
     *
     * Emitted from the declaration rather than restated: the two named modes
     * and the fall-through are the whole mapping, and a pin that adds a third
     * has to fail here.
     */
    private blendForModeCpp(): string {
        const { file, declaration } = this.context.functionDeclaration(
            billboardModule,
            "blendForMode",
        );
        const constant = (name: string): number =>
            this.context.numericValue(
                this.context.variableInitializer(file, name),
                file,
            );
        const returns = this.context
            .findNodes(declaration.body!, ts.isReturnStatement)
            .map((statement) => statement.expression);
        if (returns.length !== 3) {
            this.context.contractError(
                declaration,
                "blendForMode changed; expected three returns.",
            );
        }
        const arms: ReadonlyArray<readonly [string, number | null]> = [
            ["billboardBlendAlpha", constant("BLENDMODE_STANDARD")],
            ["billboardBlendOneOne", constant("BLENDMODE_ONEONE")],
            ["billboardBlendAdditive", null],
        ];
        const lines = [
            "// particle-billboard.ts#blendForMode.",
            "SpriteBlendDescriptor blend_for_mode(int mode) {",
        ];
        for (const [index, [exportName, mode]] of arms.entries()) {
            this.context.assertExpressionShape(
                returns[index]!,
                exportName,
                `blendForMode arm ${index}`,
            );
            const factory = blendFactorySymbol("billboard", exportName);
            lines.push(
                mode === null
                    ? `    return ${factory}();`
                    : `    if (mode == ${mode}) return ${factory}();`,
            );
        }
        lines.push("}");
        return lines.join("\n");
    }

    /**
     * `createParticleBillboard`'s own rules: which cell size the atlas takes,
     * and what the facing system is built with.
     */
    private assertBillboardRules(): void {
        const { declaration } = this.context.functionDeclaration(
            billboardModule,
            "createParticleBillboard",
        );
        const call = (name: string): ts.CallExpression => {
            const found = this.context
                .findNodes(declaration.body!, ts.isCallExpression)
                .find(
                    (candidate) =>
                        ts.isIdentifier(candidate.expression) &&
                        candidate.expression.text === name,
                );
            if (!found) {
                this.context.contractError(
                    declaration,
                    `createParticleBillboard no longer calls '${name}'.`,
                );
            }
            return found;
        };
        const atlasOptions = call("createGridSpriteAtlas").arguments[1];
        if (!atlasOptions || !ts.isObjectLiteralExpression(atlasOptions)) {
            this.context.contractError(
                declaration,
                "createParticleBillboard's atlas options changed.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(atlasOptions, "cellWidthPx"),
            "sheet && sheet.cellWidth > 0 ? sheet.cellWidth : texture.width",
            "particle atlas cell width",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(atlasOptions, "cellHeightPx"),
            "sheet && sheet.cellHeight > 0 ? sheet.cellHeight : texture.height",
            "particle atlas cell height",
        );
        const systemOptions =
            call("createFacingBillboardSystem").arguments[1];
        if (!systemOptions || !ts.isObjectLiteralExpression(systemOptions)) {
            this.context.contractError(
                declaration,
                "createParticleBillboard's system options changed.",
            );
        }
        if (systemOptions.properties.length !== 2) {
            this.context.contractError(
                systemOptions,
                "createParticleBillboard names " +
                    `${systemOptions.properties.length} system options; two ` +
                    "are lowered.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(systemOptions, "capacity"),
            "system.buffer.capacity",
            "particle billboard capacity",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(systemOptions, "blendMode"),
            "blendForMode(system.blendMode)",
            "particle billboard blend",
        );
    }

    /**
     * `syncParticleBillboard`'s five props, in the pin's own order.
     *
     * This is the whole reason the sync is folded rather than executed: the
     * bake carries the buffer, and which of its columns reach which prop --
     * `size * scaleX` into the world size, `angle` into the rotation, the
     * sprite sheet's cell into the frame -- is the pin's to say.
     */
    private assertSyncProps(): void {
        const { declaration } = this.context.functionDeclaration(
            billboardModule,
            "syncParticleBillboard",
        );
        const calls = this.context.findNodes(
            declaration.body!,
            ts.isCallExpression,
        );
        const write = calls.find(
            (candidate) =>
                ts.isIdentifier(candidate.expression) &&
                candidate.expression.text === "addBillboardSpriteIndex",
        );
        const props = write?.arguments[1];
        if (!props || !ts.isObjectLiteralExpression(props)) {
            this.context.contractError(
                declaration,
                "syncParticleBillboard no longer writes sprite props.",
            );
        }
        const expected: ReadonlyArray<readonly [string, string]> = [
            ["position", "[posX[i], posY[i], posZ[i]]"],
            ["sizeWorld", "[size[i] * scaleX[i], size[i] * scaleY[i]]"],
            ["color", "[colR[i], colG[i], colB[i], colA[i]]"],
            ["rotation", "angle[i]"],
            ["frame", "cellIndex ? cellIndex[i] : 0"],
        ];
        if (props.properties.length !== expected.length) {
            this.context.contractError(
                props,
                `syncParticleBillboard writes ${props.properties.length} ` +
                    `props; ${expected.length} are lowered.`,
            );
        }
        for (const [name, shape] of expected) {
            this.context.assertExpressionShape(
                this.context.propertyInitializer(props, name),
                shape,
                `syncParticleBillboard ${name}`,
            );
        }
        // The sync clears first, so a second call replaces rather than
        // appends -- which is what makes one frozen write the whole state.
        if (
            !calls.some(
                (candidate) =>
                    ts.isIdentifier(candidate.expression) &&
                    candidate.expression.text === "clearBillboardSprites",
            )
        ) {
            this.context.contractError(
                declaration,
                "syncParticleBillboard no longer clears before writing.",
            );
        }
    }
    // -----------------------------------------------------------------
    // Emission
    // -----------------------------------------------------------------

    public lower(
        systems: readonly NodeParticleSystemEmit[],
    ): LoweredSource {
        this.assertBillboardRules();
        this.assertSyncProps();
        for (const entry of systems) {
            this.assertBakeable(entry);
        }
        const provenance = this.context.provenance(
            billboardModule,
            "createParticleBillboard,syncParticleBillboard",
            "over a node-particle state baked at generation",
        );
        return {
            modulePath: billboardModule,
            symbolName: "createParticleBillboard,syncParticleBillboard",
            header: `#pragma once

// ${provenance}
#include <bblite/runtime.hpp>

namespace bbl::upstream {

/**
 * The billboard createParticleBillboard builds for one frozen node-particle
 * system: the pin's grid atlas over the texture the graph loaded, at the
 * buffer's capacity, on the blend its mode selects.
 */
BillboardSystemHandle create_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index);

/**
 * syncParticleBillboard over the baked buffer: one
 * addBillboardSpriteIndex per live particle, in buffer order.
 */
void sync_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index,
    BillboardSystemHandle billboard);

}  // namespace bbl::upstream
`,
            source: `// ${provenance}
#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/billboard_system.hpp>
#include <bblite/upstream/node_particles.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <stdexcept>
#include <utility>
#include <vector>

namespace bbl::upstream {
namespace {

/** One live particle, as syncParticleBillboard reads it. */
struct BakedParticle {
    Vec3 position;
    Vec2 size_world;
    Vec4 color;
    float rotation;
    float frame;
};

struct BakedSystem {
    int set_index;
    int system_index;
    double capacity;
    int blend_mode;
    const char* texture_asset;
    // createParticleBillboard's own cell rule, resolved: the sprite sheet's
    // cell size, or the texture's own.
    double cell_width_px;
    double cell_height_px;
    const BakedParticle* particles;
    std::size_t particle_count;
};

${this.blendForModeCpp()}

/**
 * createGridSpriteAtlas over a loadTexture2D texture.
 *
 * The sampler is that loader's, not loadSpriteAtlas's: repeat addressing on
 * both axes, a mip chain, and the pin's maxAnisotropy rule -- all three
 * filters are linear here, so it asks for 4.
 */
SpriteAtlasHandle load_particle_atlas(
    Engine& engine,
    const std::string& path,
    double cell_w,
    double cell_h) {
${decodeAtlasImageCpp()}
    atlas.premultiplied_alpha = false;
    atlas.mip_maps = true;
    atlas.sampler.min_filter = TextureFilter::linear;
    atlas.sampler.mag_filter = TextureFilter::linear;
    atlas.sampler.mipmap_mode = TextureMipmapMode::linear;
    atlas.sampler.address_u = TextureAddressMode::repeat;
    atlas.sampler.address_v = TextureAddressMode::repeat;
    atlas.sampler.max_anisotropy = 4.0f;

${gridSpriteAtlasFramesCpp(this.context)}

${pushAtlasHandleCpp()}
}

${systems.map(particleRowsCpp).join("\n\n")}

const BakedSystem baked_systems[] = {
${systems.map(bakedSystemRowCpp).join("\n")}
};

const BakedSystem& baked(int set_index, int system_index) {
    for (const BakedSystem& candidate : baked_systems) {
        if (candidate.set_index == set_index &&
            candidate.system_index == system_index) {
            return candidate;
        }
    }
    throw std::runtime_error(
        "No baked node-particle system for this index.");
}

}  // namespace

BillboardSystemHandle create_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index) {
    const BakedSystem& system = baked(set_index, system_index);
    const SpriteAtlasHandle atlas = load_particle_atlas(
        engine,
        asset_path(system.texture_asset),
        system.cell_width_px,
        system.cell_height_px);
    BillboardSystemOptions options;
    options.capacity = system.capacity;
    options.blend = blend_for_mode(system.blend_mode);
    return create_billboard_system(
        engine,
        atlas,
        BillboardOrientation::facing,
        Vec3{0.0f, 0.0f, 0.0f},
        std::move(options));
}

void sync_node_particle_billboard(
    Engine& engine,
    int set_index,
    int system_index,
    BillboardSystemHandle billboard) {
    // createParticleBillboard hands this a system with no sprites, so the
    // pin's own clearBillboardSprites is the identity here; a second sync is
    // refused at generation.
    const BakedSystem& system = baked(set_index, system_index);
    for (std::size_t i = 0; i < system.particle_count; ++i) {
        const BakedParticle& particle = system.particles[i];
        BillboardSpriteProps props;
        props.position = particle.position;
        props.size_world = particle.size_world;
        props.has_size_world = true;
        props.frame = particle.frame;
        props.has_frame = true;
        props.rotation = particle.rotation;
        props.has_rotation = true;
        props.color = particle.color;
        props.has_color = true;
        add_billboard_sprite_index(engine, billboard, props);
    }
}

}  // namespace bbl::upstream
`,
        };
    }

    /**
     * Refuse a bake the emitted loader cannot serve.
     *
     * Both cases are the pin's own: `createParticleBillboard` throws without
     * a texture, and a texture block asking for a flipped upload reaches an
     * arm the sprite atlas record does not carry.
     */
    private assertBakeable(entry: NodeParticleSystemEmit): void {
        if (!entry.bake.texture) {
            throw new Error(
                "A node-particle system reached createParticleBillboard " +
                    "without a texture; the pin throws there.",
            );
        }
        if (entry.bake.texture.invertY) {
            throw new Error(
                "A node-particle texture block asked for a flipped upload; " +
                    "the reached atlas path uploads unflipped.",
            );
        }
    }
}

/** Every baked float carries a decimal point: `1f` does not compile. */
function floatLiteral(value: number): string {
    if (!Number.isFinite(value)) return "0.0f";
    return `${Number.isInteger(value) ? value.toFixed(1) : value}f`;
}

/** One system's live particles, as the table the sync walks. */
function particleRowsCpp(
    entry: NodeParticleSystemEmit,
    index: number,
): string {
    const { bake } = entry;
    const rows: string[] = [];
    for (let i = 0; i < bake.alive; i += 1) {
        rows.push(
            `    {{${floatLiteral(bake.positions[i * 3]!)}, ` +
                `${floatLiteral(bake.positions[i * 3 + 1]!)}, ` +
                `${floatLiteral(bake.positions[i * 3 + 2]!)}}, ` +
                `{${floatLiteral(bake.sizes[i * 2]!)}, ` +
                `${floatLiteral(bake.sizes[i * 2 + 1]!)}}, ` +
                `{${floatLiteral(bake.colors[i * 4]!)}, ` +
                `${floatLiteral(bake.colors[i * 4 + 1]!)}, ` +
                `${floatLiteral(bake.colors[i * 4 + 2]!)}, ` +
                `${floatLiteral(bake.colors[i * 4 + 3]!)}}, ` +
                `${floatLiteral(bake.rotations[i]!)}, ` +
                `${floatLiteral(bake.frames ? bake.frames[i]! : 0)}},`,
        );
    }
    if (rows.length === 0) rows.push("    {}");
    const body = rows.join("\n");
    return `const BakedParticle particles_${index}[] = {\n${body}\n};`;
}

/** One row of the table `baked()` looks a (set, system) pair up in. */
function bakedSystemRowCpp(
    entry: NodeParticleSystemEmit,
    index: number,
): string {
    const { bake, textureAsset } = entry;
    const sheet = bake.spriteSheet;
    const cellWidth =
        sheet && sheet.cellWidth > 0 ? sheet.cellWidth : bake.texture!.width;
    const cellHeight =
        sheet && sheet.cellHeight > 0
            ? sheet.cellHeight
            : bake.texture!.height;
    return (
        `    {${bake.set}, ${bake.system}, ${bake.capacity}, ` +
        `${bake.blendMode}, ${JSON.stringify(textureAsset)}, ` +
        `${cellWidth}, ${cellHeight}, particles_${index}, ${bake.alive}},`
    );
}
