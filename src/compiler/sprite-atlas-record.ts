import ts from "typescript";
import { doubleLiteral } from "./data-types.js";
import type {
    DataType,
    DataTypeRegistry,
} from "./data-types.js";
import type { Feature, Value } from "./types.js";

export interface SpriteAtlasRecordContext {
    readonly dataTypes: DataTypeRegistry;
    dataValue(cpp: string, dataType: DataType): Value;
    requireDefaultEngine(node: ts.Node): string;
    allocateTemporaryCppName(label: string): string;
    registerNativeFunction(
        prototype: string,
        definitionLines: string[],
    ): void;
    reachJsData(): void;
    reachImageDecode(): void;
    reachFeature(feature: Feature, site?: ts.Node): void;
    fail(node: ts.Node, message: string): never;
}

/**
 * Atlas-builder helpers already registered for one compilation, keyed on
 * the parameterized body text. The build over stored frames is identical
 * across call sites once its per-call values (engine, texture, size,
 * premultiplied flag, frames) become parameters, so the first call
 * registers one namespace-scope function and every later call with the
 * same shape calls it — freeciv restated the same ~1.6 KB build ten
 * times. Keyed by context so parallel compilations in one process never
 * share a name.
 */
const emittedAtlasHelpers = new WeakMap<
    SpriteAtlasRecordContext,
    Map<string, string>
>();

/** Materializes a pure-data SpriteAtlas record over a reached pixel texture. */
export function compileSpriteAtlasRecord(
    context: SpriteAtlasRecordContext,
    value: Value,
    node: ts.Node,
): string | undefined {
    if (value.kind !== "record") return undefined;
    const property = (name: string): Value => {
        const found = value.recordProperties?.[name];
        if (!found) {
            context.fail(
                node,
                `SpriteAtlas record is missing '${name}'.`,
            );
        }
        return found;
    };
    const rawTexture = property("texture");
    const texture =
        rawTexture.kind === "data" &&
        rawTexture.dataType?.kind === "optional" &&
        rawTexture.dataType.inner.kind === "handle" &&
        rawTexture.dataType.inner.handle === "texture"
            ? context.dataValue(
                  `(*${rawTexture.cpp})`,
                  rawTexture.dataType.inner,
              )
            : rawTexture;
    const size = property("textureSizePx");
    const frames = property("frames");
    const premultiplied = property("premultipliedAlpha");
    if (
        texture.kind !== "texture" ||
        texture.textureStorage === "solid"
    ) {
        context.fail(
            node,
            "A data SpriteAtlas requires a file or pixels texture; " +
                `received ${texture.kind} ` +
                `${texture.dataType ? JSON.stringify(texture.dataType) : "without data type"}.`,
        );
    }
    const tupleLane = (tuple: Value, index: number): string => {
        if (tuple.kind === "tuple") {
            const lane = tuple.tupleElements?.[index];
            if (lane?.kind !== "number") {
                context.fail(
                    node,
                    "SpriteAtlas tuple fields require numeric lanes.",
                );
            }
            return lane.staticNumber !== undefined
                ? doubleLiteral(lane.staticNumber)
                : lane.cpp;
        }
        if (
            tuple.kind === "data" &&
            tuple.dataType?.kind === "tuple"
        ) {
            return `${tuple.cpp}[${index}]`;
        }
        context.fail(
            node,
            "SpriteAtlas textureSizePx requires a 2-tuple.",
        );
    };
    const storedFrameType =
        frames.dataType?.kind === "vector" &&
        frames.dataType.element.kind === "struct"
            ? frames.dataType.element
            : undefined;
    const storedFrames =
        frames.kind === "data" && storedFrameType !== undefined;
    const literalFrames =
        frames.kind === "tuple" &&
        frames.tupleElements?.every(
            (frame) => frame.kind === "record",
        );
    if (!storedFrames && !literalFrames) {
        context.fail(
            node,
            "SpriteAtlas frames require an array of frame records.",
        );
    }
    if (premultiplied.kind !== "boolean") {
        context.fail(
            node,
            "SpriteAtlas premultipliedAlpha must be boolean.",
        );
    }
    const engine = context.requireDefaultEngine(node);
    const fileTextureSetup = (
        cpp: string,
        atlas: string,
        decoded: string,
    ): string =>
        `const auto ${decoded} = bbl::pal::decode_image(bbl::js::ArrayBuffer(${cpp}.data.bytes)); ` +
        `${atlas}.rgba = ${decoded}.rgba; ` +
        `if (${cpp}.data.premultiply_alpha) { ` +
        `bbl::pal::DecodedImage premultiplied{${decoded}.width, ${decoded}.height, ${atlas}.rgba}; ` +
        `bbl::pal::premultiply_image_alpha(premultiplied); ` +
        `${atlas}.rgba = std::move(premultiplied.rgba); } ` +
        `${atlas}.sampler = ${cpp}.data.sampler; `;
    const variantTexture =
        texture.textureStorage !== "file" &&
        texture.textureStorage !== "pixels" &&
        texture.dataType?.kind === "handle" &&
        texture.dataType.handle === "texture";
    /**
     * The reach calls key the entry TU's `pal_image.hpp` include (the
     * decode lands in this translation unit either way, inline or inside
     * the registered helper); the pixels arm emits no decode.
     */
    const reachTextureArm = (): void => {
        if (texture.textureStorage === "file") {
            context.reachImageDecode();
        } else if (texture.textureStorage === "pixels") {
            // Pixels come pre-decoded; nothing extra to reach.
        } else if (variantTexture) {
            // A Texture2D stored behind a plain-data field is a variant
            // whose concrete producer is no longer visible here. Keep both
            // source arms valid; the visitor selects only the one actually
            // stored at runtime.
            context.reachFeature("texture:file", node);
            context.reachImageDecode();
        } else {
            context.fail(
                node,
                "A data SpriteAtlas texture lost its concrete storage type.",
            );
        }
    };
    const textureSetup = (
        source: string,
        atlas: string,
        decoded: string,
        stored: string,
    ): string => {
        if (texture.textureStorage === "file") {
            return fileTextureSetup(source, atlas, decoded);
        }
        if (texture.textureStorage === "pixels") {
            return (
                `${atlas}.rgba = ${source}.rgba; ` +
                `${atlas}.sampler = ${source}.sampler; `
            );
        }
        return (
            `std::visit([&](const auto& ${stored}) { ` +
            `using Stored = std::decay_t<decltype(${stored})>; ` +
            `if constexpr (std::is_same_v<Stored, bbl::FileTexture>) { ` +
            fileTextureSetup(stored, atlas, decoded) +
            `} else { ${atlas}.rgba = ${stored}.rgba; ` +
            `${atlas}.sampler = ${stored}.sampler; } ` +
            `}, ${source}); `
        );
    };
    if (storedFrames) {
        // The build over stored frames is call-invariant once its values
        // become parameters, so it is registered once per shape and every
        // call site calls it. The argument expressions are the pure lvalue
        // paths the inline form already re-read (the file arm reads the
        // texture three times), so moving them from sequenced IIFE
        // statements into a call changes no observable evaluation.
        const frameType = storedFrameType!;
        const arrow = context.dataTypes.isReferenceStruct(
            frameType.name,
        );
        const access = (base: string, name: string): string => {
            const field = context.dataTypes.structField(
                frameType.name,
                name,
                node,
            );
            return `${base}${arrow ? "->" : "."}${field.name}`;
        };
        const uvMin = access("frame", "uvMin");
        const uvMax = access("frame", "uvMax");
        const sourceSize = access("frame", "sourceSizePx");
        const pivot = access("frame", "pivot");
        context.reachJsData();
        reachTextureArm();
        const framesCppType = context.dataTypes.cppType({
            kind: "vector",
            element: frameType,
        });
        const parameters =
            `(bbl::Engine& engine, const Texture& texture, ` +
            `double width_px, double height_px, ` +
            `bool premultiplied_alpha, ` +
            `const ${framesCppType}& frames)`;
        // The local shadowing rule sizes the names: the file arm declares
        // a `premultiplied` image inside its `if`, so the parameter is
        // `premultiplied_alpha` or /W4 reads the block local as hiding it.
        const bodyLines = [
            `bbl::SpriteAtlasRecord atlas;`,
            textureSetup(
                "texture",
                "atlas",
                "decoded",
                "stored",
            ).trimEnd(),
            `atlas.width = bbl::js::to_uint32(width_px);`,
            `atlas.height = bbl::js::to_uint32(height_px);`,
            `atlas.premultiplied_alpha = premultiplied_alpha;`,
            `atlas.mip_maps = false;`,
            `for (const auto& frame : frames) { ` +
                `atlas.frames.push_back(bbl::SpriteFrame{` +
                `bbl::Vec2{static_cast<float>(${uvMin}[0]), static_cast<float>(${uvMin}[1])}, ` +
                `bbl::Vec2{static_cast<float>(${uvMax}[0]), static_cast<float>(${uvMax}[1])}, ` +
                `bbl::Vec2{static_cast<float>(${sourceSize}[0]), static_cast<float>(${sourceSize}[1])}, ` +
                `bbl::Vec2{static_cast<float>(${pivot}[0]), static_cast<float>(${pivot}[1])}}); }`,
            `engine.sprite_atlases.push_back(std::move(atlas));`,
            `return bbl::SpriteAtlasHandle{static_cast<std::uint32_t>(engine.sprite_atlases.size() - 1)};`,
        ];
        // First occurrence owns the symbol; the key is the parameterized
        // text itself, so any drift in arm or frame shape gets its own
        // helper and identical shapes share one.
        const key = `${parameters}\n${bodyLines.join("\n")}`;
        let helpers = emittedAtlasHelpers.get(context);
        if (!helpers) {
            helpers = new Map<string, string>();
            emittedAtlasHelpers.set(context, helpers);
        }
        let helper = helpers.get(key);
        if (helper === undefined) {
            helper = context.allocateTemporaryCppName(
                "sprite_atlas_record",
            );
            context.registerNativeFunction(
                `template <typename Texture> bbl::SpriteAtlasHandle ${helper}${parameters};`,
                [
                    `template <typename Texture>`,
                    `bbl::SpriteAtlasHandle ${helper}${parameters} {`,
                    ...bodyLines.map((line) => `    ${line}`),
                    `}`,
                ],
            );
            helpers.set(key, helper);
        }
        return (
            `bblscene::${helper}(${engine}, ${texture.cpp}, ` +
            `${tupleLane(size, 0)}, ${tupleLane(size, 1)}, ` +
            `${premultiplied.cpp}, ${frames.cpp})`
        );
    }
    const atlas = context.allocateTemporaryCppName(
        "sprite_atlas",
    );
    const decoded = context.allocateTemporaryCppName(
        "sprite_atlas_image",
    );
    const frameProperty = (frame: Value, name: string): Value => {
        const property = frame.recordProperties?.[name];
        if (!property) {
            context.fail(
                node,
                `SpriteAtlas frame is missing '${name}'.`,
            );
        }
        return property;
    };
    const frameStatements = (frames.tupleElements ?? [])
        .map((frame) => {
            const uvMin = frameProperty(frame, "uvMin");
            const uvMax = frameProperty(frame, "uvMax");
            const sourceSize = frameProperty(
                frame,
                "sourceSizePx",
            );
            const pivot = frameProperty(frame, "pivot");
            return (
                `${atlas}.frames.push_back(bbl::SpriteFrame{` +
                `bbl::Vec2{static_cast<float>(${tupleLane(uvMin, 0)}), static_cast<float>(${tupleLane(uvMin, 1)})}, ` +
                `bbl::Vec2{static_cast<float>(${tupleLane(uvMax, 0)}), static_cast<float>(${tupleLane(uvMax, 1)})}, ` +
                `bbl::Vec2{static_cast<float>(${tupleLane(sourceSize, 0)}), static_cast<float>(${tupleLane(sourceSize, 1)})}, ` +
                `bbl::Vec2{static_cast<float>(${tupleLane(pivot, 0)}), static_cast<float>(${tupleLane(pivot, 1)})}}); `
            );
        })
        .join("");
    context.reachJsData();
    reachTextureArm();
    const stored = variantTexture
        ? context.allocateTemporaryCppName("stored_texture")
        : "";
    return (
        `([&]() { bbl::SpriteAtlasRecord ${atlas}; ` +
        textureSetup(texture.cpp, atlas, decoded, stored) +
        `${atlas}.width = bbl::js::to_uint32(${tupleLane(size, 0)}); ` +
        `${atlas}.height = bbl::js::to_uint32(${tupleLane(size, 1)}); ` +
        `${atlas}.premultiplied_alpha = ${premultiplied.cpp}; ` +
        `${atlas}.mip_maps = false; ` +
        frameStatements +
        `${engine}.sprite_atlases.push_back(std::move(${atlas})); ` +
        `return bbl::SpriteAtlasHandle{static_cast<std::uint32_t>(${engine}.sprite_atlases.size() - 1)}; }())`
    );
}
