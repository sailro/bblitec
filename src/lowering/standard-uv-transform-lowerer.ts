/**
 * Lowers `stdUvTransformExt`'s own uniform writer to C++.
 *
 * `std-uv-transform-fragment.ts` fills one 8-float channel per Standard
 * texture slot: a 2x2 matrix carrying `uScale`/`vScale` and a rotation by
 * `uAng`, then a translation composed against the material's own
 * `uvScale`/`uvOffset`, then an `invertY` flip that negates the second matrix
 * row and mirrors the V translation. Every one of those is arithmetic, and a
 * second copy of it here would agree with the pin only until the pin edits a
 * sign — so the body is translated by `PinnedNumericLowerer`, from the pinned
 * declaration's own AST. That translator already carries the two rules this
 * writer needs: a JS number is an f64, and a `Float32Array` store rounds to
 * f32 exactly where the pin's store does.
 *
 * What this module owns is the correspondence, never the formula: which
 * record member each pinned name reads, and which parts generation folds
 * because it already knows them.
 *
 * Two things are folded rather than translated, both because their *shape* is
 * the contract: the `CHANNELS` table, read out of the pinned module and
 * unrolled into its own row count because the pin's loop bound is
 * `CHANNELS.length`; and the two per-row arguments that table decides.
 *
 * The values stay live: the emitted writer reads the material record every
 * time it runs, so a scene that moves a texture's transform moves the block.
 */
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";

/** The module the extension and both its writers live in. */
const MODULE = "src/material/standard/fragments/std-uv-transform-fragment.ts";

/** The pinned slot whose legacy V flip the fold below depends on. */
const LIGHTMAP_SLOT = "_lightmapTexture";

/** One row of the pinned `CHANNELS` table. */
interface PinnedChannel {
    /** The WGSL field prefix (`d`, `e`, `b`, ...), used in the emitted note. */
    name: string;
    /** The material property the pin reads the texture from. */
    textureKey: string;
    /** The material property carrying the UV set, or null. */
    coordIndexKey: string | null;
}

/**
 * Where this port keeps each channel's texture, by the pin's own slot name.
 *
 * A `null` means the generated loader fills no such slot, so the channel
 * writes the untextured identity — which is what the pin's own
 * `texture?.x ?? default` reads produce for an absent texture.
 */
const channelSlots: Readonly<Record<string, string | null>> = {
    diffuseTexture: "material.base_color_texture",
    _emissiveTexture: null,
    _bumpTexture: "material.bump_texture",
    _specularTexture: "material.specular_texture",
    _ambientTexture: "material.ambient_texture",
    [LIGHTMAP_SLOT]: null,
    _opacityTexture: "material.opacity_texture",
};

/**
 * The pinned `Texture2D` transform properties, as this port's record spells
 * them.
 *
 * Shared with the compiler's own property-assignment table, so the writer
 * that reads a member and the setter that writes it cannot disagree about
 * which record field it is.
 */
export const TEXTURE_UV_PROPERTIES: Readonly<
    Record<string, { record: string; value: "number" | "boolean" }>
> = {
    uScale: { record: "uv_transform.u_scale", value: "number" },
    vScale: { record: "uv_transform.v_scale", value: "number" },
    uOffset: { record: "uv_transform.u_offset", value: "number" },
    vOffset: { record: "uv_transform.v_offset", value: "number" },
    uAng: { record: "uv_transform.u_ang", value: "number" },
    invertY: { record: "uv_invert_y", value: "boolean" },
};

/**
 * The record correspondences the caller holds, passed in rather than
 * restated.
 *
 * `presence` maps a pinned slot name to the expression that says the record
 * carries it — the same one `standardFeatureRecordSources` derives that
 * channel's feature bit from, so a channel cannot compose while its texture
 * reads as absent. `coordIndex` likewise maps the pin's own `coordIndexKey`
 * to the record's UV-set field, or null where the loader fills none.
 */
export interface ChannelSources {
    presence: Readonly<Record<string, string | null | undefined>>;
    coordIndex: Readonly<Record<string, string | null | undefined>>;
}

/** The pinned `CHANNELS` table, read out of its own declaration. */
function pinnedChannels(context: LoweringContext): PinnedChannel[] {
    const file = context.sourceFile(MODULE);
    const initializer = context.unwrapExpression(
        context.variableInitializer(file, "CHANNELS"),
    );
    if (!ts.isArrayLiteralExpression(initializer)) {
        return context.contractError(
            initializer,
            "Pinned CHANNELS is no longer an array literal.",
        );
    }
    return initializer.elements.map((element) => {
        const row = context.unwrapExpression(element);
        if (!ts.isArrayLiteralExpression(row) || row.elements.length !== 5) {
            return context.contractError(
                row,
                "Pinned CHANNELS rows are no longer " +
                    "[name, feature, uv2, textureKey, coordIndexKey].",
            );
        }
        const text = (index: number): string =>
            context.stringValue(row.elements[index]!, file);
        const coordIndex = context.unwrapExpression(row.elements[4]!);
        return {
            name: text(0),
            textureKey: text(3),
            coordIndexKey: coordIndex.kind === ts.SyntaxKind.NullKeyword
                ? null
                : text(4),
        };
    });
}

/** The three arguments one unrolled call site folds. */
function channelArguments(
    channel: PinnedChannel,
    sources: ChannelSources,
): { texture: string; usesUv2: string; legacyFlipV: string } {
    if (!(channel.textureKey in channelSlots)) {
        throw new Error(
            `Pinned CHANNELS names slot '${channel.textureKey}', which has ` +
                "no record source in this port.",
        );
    }
    const slot = channelSlots[channel.textureKey]!;
    const present = sources.presence[channel.textureKey];
    if (slot !== null && !present) {
        throw new Error(
            `Pinned CHANNELS slot '${channel.textureKey}' has a record ` +
                "member but no presence expression, so its channel could " +
                "compose while its texture read as absent.",
        );
    }
    const texture = slot === null
        ? "nullptr"
        : `(${present}) ? &${slot} : nullptr`;
    // `coordIndexKey !== null && material[coordIndexKey] === 1`: the first
    // conjunct is the table's own answer, and the second folds to false for a
    // UV set the generated loader never records.
    const coordIndex = channel.coordIndexKey === null
        ? null
        : sources.coordIndex[channel.coordIndexKey] ?? null;
    // `textureKey === "_lightmapTexture" && texture?.uAng === Math.PI`. The
    // generated loader fills no lightmap slot at all, so it is the SECOND
    // conjunct that folds this: `texture` is absent there and
    // `undefined === Math.PI` is false upstream. A port that grows the slot
    // has to lower the comparison rather than inherit the fold.
    if (channel.textureKey === LIGHTMAP_SLOT && slot !== null) {
        throw new Error(
            "This port now records a lightmap texture, so the pinned legacy " +
                "V flip (`texture?.uAng === Math.PI`) no longer folds to " +
                "false and has to be lowered.",
        );
    }
    return {
        texture,
        usesUv2: coordIndex === null ? "false" : `${coordIndex} == 1`,
        legacyFlipV: "false",
    };
}

export interface LoweredStandardUvTransform {
    /** Floats the whole block occupies. */
    floatCount: number;
    /** The struct, its size assertion, and the two emitted functions. */
    source: string;
}

/** The pinned channel writer plus the unrolled data writer, as C++. */
export function lowerStandardUvTransformWriter(
    context: LoweringContext,
    sources: ChannelSources,
): LoweredStandardUvTransform {
    const file = context.sourceFile(MODULE);
    const constant = (name: string): number =>
        context.numericValue(context.variableInitializer(file, name), file);
    const floatsPerChannel = constant("FLOATS_PER_CHANNEL");
    const channelCount = constant("CHANNEL_COUNT");
    const channels = pinnedChannels(context);
    if (channels.length !== channelCount) {
        throw new Error(
            `Pinned CHANNEL_COUNT is ${channelCount} but CHANNELS holds ` +
                `${channels.length} rows.`,
        );
    }
    const floatCount = floatsPerChannel * channelCount;

    // `data` is registered as an f32 buffer, which is what makes every
    // intermediate a double and every store round once -- the pin's own
    // `Float32Array` semantics, read off the binding rather than restated.
    const bindings = new Map<string, PinnedBinding>([
        ["data", { cpp: "data", type: "f32" }],
        ["channel", { cpp: "channel", type: "scalar" }],
        ["material.uvScale", { cpp: "material.uv_scale", type: "f32" }],
        ["materialOffsetX", { cpp: "material_offset_x", type: "scalar" }],
        ["materialOffsetY", { cpp: "material_offset_y", type: "scalar" }],
        ["usesUv2", { cpp: "uses_uv2", type: "bool" }],
        ["legacyFlipV", { cpp: "legacy_flip_v", type: "bool" }],
        ["FLOATS_PER_CHANNEL", { cpp: `${floatsPerChannel}.0`, type: "scalar" }],
        [
            "texture",
            {
                cpp: "texture",
                type: "scalar",
                optional: {
                    present: "texture != nullptr",
                    members: new Map(
                        Object.entries(TEXTURE_UV_PROPERTIES).map(
                            ([pinned, { record, value }]) => [
                                pinned,
                                {
                                    cpp: `texture->${record}`,
                                    // Only the boolean is read outside a
                                    // `??`, under the pin's own `!!`
                                    // coercion of `undefined`.
                                    ...(value === "boolean"
                                        ? { absent: "false" }
                                        : {}),
                                },
                            ],
                        ),
                    ),
                },
            },
        ],
    ]);
    const { declaration: channelWriter } = context.functionDeclaration(
        MODULE,
        "writeChannel",
    );
    if (!channelWriter.body) {
        throw new Error("Pinned writeChannel has no body.");
    }
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map([
            ["Math.cos", (args: readonly string[]) => `std::cos(${args[0]})`],
            ["Math.sin", (args: readonly string[]) => `std::sin(${args[0]})`],
        ]),
    });
    const channelBody = channelWriter.body.statements
        .flatMap((statement) => lowerer.statement(statement, "    "))
        .join("\n");

    // The data writer's own two reads and the two folded arguments, asserted
    // against their own expressions so a changed pin fails here rather than
    // emitting a stale unroll.
    const { declaration: dataWriter } = context.functionDeclaration(
        MODULE,
        "writeUvTransformData",
    );
    for (const [local, shape] of [
        ["materialOffsetX", "material.uvOffset?.[0] ?? 0"],
        ["materialOffsetY", "material.uvOffset?.[1] ?? 0"],
    ] as const) {
        context.assertExpressionShape(
            context.variableInitializer(dataWriter, local),
            shape,
            `writeUvTransformData ${local}`,
        );
    }
    const call = context.callExpression(dataWriter, "writeChannel");
    context.assertExpressionShape(
        call.arguments[6]!,
        "coordIndexKey !== null && material[coordIndexKey] === 1",
        "writeUvTransformData usesUv2",
    );
    context.assertExpressionShape(
        call.arguments[7]!,
        `textureKey === "${LIGHTMAP_SLOT}" && texture?.uAng === Math.PI`,
        "writeUvTransformData legacyFlipV",
    );

    const calls = channels.map((channel, index) => {
        const emit = channelArguments(channel, sources);
        return `    // channel ${index}: ${channel.name} (${channel.textureKey})
    write_std_uv_transform_channel(
        out.data,
        ${index}.0,
        ${emit.texture},
        props,
        material_offset_x,
        material_offset_y,
        ${emit.usesUv2},
        ${emit.legacyFlipV});`;
    });
    const source = `

// ${context.provenance(MODULE, "stdUvTxUniforms")}
//
// The vertex-stage block the extension declares: one 2x2 matrix plus a
// translation per Standard texture channel.
struct StandardUvTxUniforms {
    std::array<float, ${floatCount}> data{};
};
static_assert(
    sizeof(StandardUvTxUniforms) == ${floatCount * 4},
    "The pinned Standard UV transform block is ${channelCount} channels of "
    "${floatsPerChannel} floats.");

// ${context.provenance(MODULE, "writeChannel")}
inline void write_std_uv_transform_channel(
    std::array<float, ${floatCount}>& data,
    double channel,
    const bbl::TextureData* texture,
    [[maybe_unused]] const StandardMaterialProps& material,
    [[maybe_unused]] double material_offset_x,
    [[maybe_unused]] double material_offset_y,
    [[maybe_unused]] bool uses_uv2,
    [[maybe_unused]] bool legacy_flip_v) {
${channelBody}
}

// ${context.provenance(MODULE, "writeUvTransformData")}
//
// The pin's loop runs over its own CHANNELS table, whose rows are fixed, so
// generation unrolls it and folds the two per-row constants each call site
// carries. \`material.uvOffset\` is the pin's optional per-material offset,
// which \`enableStandardUvOffset()\` installs and no reached scene calls, so
// both components read their \`?? 0\` arm here exactly as they do upstream.
inline void write_std_uv_transform_data(
    const bbl::MaterialRecord& material,
    const StandardMaterialProps& props,
    StandardUvTxUniforms& out) {
    const double material_offset_x = 0.0;
    const double material_offset_y = 0.0;
${calls.join("\n")}
}
`;
    return { floatCount, source };
}
