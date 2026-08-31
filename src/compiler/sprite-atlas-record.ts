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
    reachJsData(): void;
    reachFeature(feature: Feature, site?: ts.Node): void;
    fail(node: ts.Node, message: string): never;
}

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
    const atlas = context.allocateTemporaryCppName(
        "sprite_atlas",
    );
    const decoded = context.allocateTemporaryCppName(
        "sprite_atlas_image",
    );
    let frameStatements: string;
    if (storedFrames) {
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
        const stored = context.allocateTemporaryCppName(
            "sprite_frame",
        );
        const uvMin = access(stored, "uvMin");
        const uvMax = access(stored, "uvMax");
        const sourceSize = access(stored, "sourceSizePx");
        const pivot = access(stored, "pivot");
        frameStatements =
            `for (const auto& ${stored} : ${frames.cpp}) { ` +
            `${atlas}.frames.push_back(bbl::SpriteFrame{` +
            `bbl::Vec2{static_cast<float>(${uvMin}[0]), static_cast<float>(${uvMin}[1])}, ` +
            `bbl::Vec2{static_cast<float>(${uvMax}[0]), static_cast<float>(${uvMax}[1])}, ` +
            `bbl::Vec2{static_cast<float>(${sourceSize}[0]), static_cast<float>(${sourceSize}[1])}, ` +
            `bbl::Vec2{static_cast<float>(${pivot}[0]), static_cast<float>(${pivot}[1])}}); } `;
    } else {
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
        frameStatements = (frames.tupleElements ?? [])
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
    }
    context.reachJsData();
    const fileTextureSetup = (cpp: string): string =>
        `const auto ${decoded} = bbl::pal::decode_image(bbl::js::ArrayBuffer(${cpp}.data.bytes)); ` +
        `${atlas}.rgba = ${decoded}.rgba; ` +
        `if (${cpp}.data.premultiply_alpha) { ` +
        `bbl::pal::DecodedImage premultiplied{${decoded}.width, ${decoded}.height, ${atlas}.rgba}; ` +
        `bbl::pal::premultiply_image_alpha(premultiplied); ` +
        `${atlas}.rgba = std::move(premultiplied.rgba); } ` +
        `${atlas}.sampler = ${cpp}.data.sampler; `;
    let textureSetup: string;
    if (texture.textureStorage === "file") {
        textureSetup = fileTextureSetup(texture.cpp);
    } else if (texture.textureStorage === "pixels") {
        textureSetup =
            `${atlas}.rgba = ${texture.cpp}.rgba; ` +
            `${atlas}.sampler = ${texture.cpp}.sampler; `;
    } else if (
        texture.dataType?.kind === "handle" &&
        texture.dataType.handle === "texture"
    ) {
        // A Texture2D stored behind a plain-data field is a variant whose
        // concrete producer is no longer visible here. Keep both source arms
        // valid; the visitor selects only the one actually stored at runtime.
        context.reachFeature("texture:file", node);
        const stored = context.allocateTemporaryCppName(
            "stored_texture",
        );
        textureSetup =
            `std::visit([&](const auto& ${stored}) { ` +
            `using Stored = std::decay_t<decltype(${stored})>; ` +
            `if constexpr (std::is_same_v<Stored, bbl::FileTexture>) { ` +
            fileTextureSetup(stored) +
            `} else { ${atlas}.rgba = ${stored}.rgba; ` +
            `${atlas}.sampler = ${stored}.sampler; } ` +
            `}, ${texture.cpp}); `;
    } else {
        context.fail(
            node,
            "A data SpriteAtlas texture lost its concrete storage type.",
        );
    }
    return (
        `([&]() { bbl::SpriteAtlasRecord ${atlas}; ` +
        textureSetup +
        `${atlas}.width = bbl::js::to_uint32(${tupleLane(size, 0)}); ` +
        `${atlas}.height = bbl::js::to_uint32(${tupleLane(size, 1)}); ` +
        `${atlas}.premultiplied_alpha = ${premultiplied.cpp}; ` +
        `${atlas}.mip_maps = false; ` +
        frameStatements +
        `${engine}.sprite_atlases.push_back(std::move(${atlas})); ` +
        `return bbl::SpriteAtlasHandle{static_cast<std::uint32_t>(${engine}.sprite_atlases.size() - 1)}; }())`
    );
}
