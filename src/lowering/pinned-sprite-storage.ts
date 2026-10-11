import type {
    PinnedBinding,
    PinnedRecordShape,
} from "./pinned-numeric-lowerer.js";

const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });

/** Atlas tuples retain JavaScript numbers until a source instance writer stores them. */
const spriteFrameShape: PinnedRecordShape = {
    cpp: "SpriteFrame",
    members: [
        ["uvMin", "uv_min"],
        ["uvMax", "uv_max"],
        ["sourceSizePx", "source_size_px"],
        ["pivot", "pivot"],
    ].map(([name, native]) => ({
        name: name!,
        read: (owner: string) =>
            new Map([
                ["[0]", scalar(`${owner}.${native}.x`)],
                ["[1]", scalar(`${owner}.${native}.y`)],
            ]),
        store: () => {
            throw new Error(
                "Sprite instance writers cannot replace atlas frame fields.",
            );
        },
    })),
};

export function spriteFramesBinding(cpp: string): PinnedBinding {
    return {
        cpp,
        type: "record-list",
        record: spriteFrameShape,
        indexedRead: (owner, index) =>
            `bbl::js::array_index_checked(${owner}, ${index}, "Sprite atlas frame")`,
    };
}

/** One optional instance record, shared by the source writers and their entry points. */
export function spritePropsBindings(
    source: string,
    family: "2d" | "billboard",
): Map<string, PinnedBinding> {
    const result = new Map<string, PinnedBinding>([
        [source, { cpp: "props", type: "opaque" }],
    ]);
    const tuples: ReadonlyArray<readonly [string, string, readonly string[]]> =
        family === "billboard"
            ? [
                  ["position", "position", ["x", "y", "z"]],
                  ["sizeWorld", "size_world", ["x", "y"]],
                  ["pivot", "pivot", ["x", "y"]],
                  ["color", "color", ["x", "y", "z", "w"]],
              ]
            : [
                  ["positionPx", "position_px", ["x", "y"]],
                  ["sizePx", "size_px", ["x", "y"]],
                  ["color", "color", ["x", "y", "z", "w"]],
              ];
    for (const [name, field, lanes] of tuples) {
        result.set(`${source}.${name}`, {
            cpp: `props.${field}`,
            type: "opaque",
            absentCpp: `!props.has_${field}`,
        });
        lanes.forEach((lane, index) =>
            result.set(
                `${source}.${name}[${index}]`,
                scalar(`props.${field}.${lane}`),
            ),
        );
    }
    const fields: ReadonlyArray<
        readonly [string, string, "scalar" | "bool", boolean?]
    > = [
        ["frame", "frame", "scalar"],
        ["rotation", "rotation", "scalar", true],
        ["flipX", "flip_x", "bool"],
        ["flipY", "flip_y", "bool"],
        ["visible", "visible", "bool"],
        ...(family === "2d" ? [["z", "z", "scalar", true] as const] : []),
    ];
    for (const [name, field, type, nullish] of fields)
        result.set(`${source}.${name}`, {
            cpp: `props.${field}`,
            type,
            absentCpp: `!props.has_${field}`,
            ...(nullish ? { nullish: `!props.has_${field}` } : {}),
        });
    return result;
}
