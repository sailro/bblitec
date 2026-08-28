import ts from "typescript";
import { doubleLiteral } from "./data-types.js";
import type {
    DataType,
    DataTypeRegistry,
} from "./data-types.js";
import type { Value } from "./types.js";

export interface SpriteAtlasRecordContext {
    readonly dataTypes: DataTypeRegistry;
    dataValue(cpp: string, dataType: DataType): Value;
    requireDefaultEngine(node: ts.Node): string;
    allocateTemporaryCppName(label: string): string;
    reachJsData(): void;
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
        texture.textureStorage === "file" ||
        texture.textureStorage === "solid"
    ) {
        context.fail(
            node,
            "A data SpriteAtlas currently requires a texture created " +
                `from pixels; received ${texture.kind} ` +
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
    if (
        frames.kind !== "data" ||
        frames.dataType?.kind !== "vector" ||
        frames.dataType.element.kind !== "struct"
    ) {
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
    const frameType = frames.dataType.element;
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
    const engine = context.requireDefaultEngine(node);
    const atlas = context.allocateTemporaryCppName(
        "sprite_atlas",
    );
    const stored = context.allocateTemporaryCppName(
        "sprite_frame",
    );
    const uvMin = access(stored, "uvMin");
    const uvMax = access(stored, "uvMax");
    const sourceSize = access(stored, "sourceSizePx");
    const pivot = access(stored, "pivot");
    context.reachJsData();
    return (
        `([&]() { bbl::SpriteAtlasRecord ${atlas}; ` +
        `${atlas}.rgba = ${texture.cpp}.rgba; ` +
        `${atlas}.width = bbl::js::to_uint32(${tupleLane(size, 0)}); ` +
        `${atlas}.height = bbl::js::to_uint32(${tupleLane(size, 1)}); ` +
        `${atlas}.premultiplied_alpha = ${premultiplied.cpp}; ` +
        `${atlas}.mip_maps = false; ${atlas}.sampler = ${texture.cpp}.sampler; ` +
        `for (const auto& ${stored} : ${frames.cpp}) { ` +
        `${atlas}.frames.push_back(bbl::SpriteFrame{` +
        `bbl::Vec2{static_cast<float>(${uvMin}[0]), static_cast<float>(${uvMin}[1])}, ` +
        `bbl::Vec2{static_cast<float>(${uvMax}[0]), static_cast<float>(${uvMax}[1])}, ` +
        `bbl::Vec2{static_cast<float>(${sourceSize}[0]), static_cast<float>(${sourceSize}[1])}, ` +
        `bbl::Vec2{static_cast<float>(${pivot}[0]), static_cast<float>(${pivot}[1])}}); } ` +
        `${engine}.sprite_atlases.push_back(std::move(${atlas})); ` +
        `return bbl::SpriteAtlasHandle{static_cast<std::uint32_t>(${engine}.sprite_atlases.size() - 1)}; }())`
    );
}
