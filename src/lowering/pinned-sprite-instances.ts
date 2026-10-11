import type { LoweringContext } from "./context.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import {
    spriteFramesBinding,
    spritePropsBindings,
} from "./pinned-sprite-storage.js";

const modulePath = "src/sprite/sprite-2d.ts";

/** Native record/view transport for the pin's complete Sprite2D writers. */
export function lowerSpriteInstances(context: LoweringContext): string {
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    const bindings = (): Map<string, PinnedBinding> =>
        new Map([
            ["layer", { cpp: "layer", type: "opaque" }],
            ["layer.atlas", { cpp: "atlas", type: "opaque" }],
            ["layer.atlas.frames", spriteFramesBinding("atlas.frames")],
            [
                "layer._instanceData",
                { cpp: "layer.instance_data", type: "f32" },
            ],
            ["layer._savedSize", { cpp: "layer.saved_size", type: "f32" }],
            [
                "layer._instanceFloatsPerSprite",
                scalar("layer.instance_floats_per_sprite"),
            ],
            ["layer.layerZ", scalar("layer.layer_z")],
            ["layer.count", scalar("layer.count")],
            [
                "layer.depth",
                {
                    cpp: 'std::string_view(layer.depth_mode == Sprite2DDepthMode::none ? "none" : layer.depth_mode == Sprite2DDepthMode::test ? "test" : "test-write")',
                    type: "string",
                },
            ],
        ]);
    const calls: PinnedNumericScope["calls"] = new Map([
        [
            "resolveSpriteFrame",
            (args) => `upstream::resolve_sprite_frame(${args.join(", ")})`,
        ],
        [
            "markDirty",
            (args) =>
                `touch_sprite_instances(${args[0]}, gpu_u32(gpu_size(${args[1]})), gpu_u32(gpu_size(${args[2]})))`,
        ],
    ]);
    const lower = (
        name: string,
        inputs: Map<string, PinnedBinding>,
    ): string => {
        const { file, declaration } = context.functionDeclaration(
            modulePath,
            name,
        );
        return lowerPinnedBody(file, declaration.body!.statements, {
            bindings: inputs,
            calls,
        });
    };
    const writerBindings = bindings();
    for (const [name, binding] of spritePropsBindings("props", "2d"))
        writerBindings.set(name, binding);
    writerBindings.set("slotIndex", scalar("static_cast<double>(index)"));
    writerBindings.set("prev", {
        cpp: "(*previous)",
        type: "f32",
        absentCpp: "previous == nullptr",
        absentValue: "null",
    });
    const writer = lower("writeInstance", writerBindings);
    const frameBindings = bindings();
    frameBindings.set("index", scalar("index"));
    frameBindings.set("frame", scalar("frame"));
    const setter = lower("setSprite2DFrameIndex", frameBindings);
    return `void write_sprite_instance(Sprite2DLayerRecord& layer, const SpriteAtlasRecord& atlas,
    std::uint32_t index, const Sprite2DProps& props, bool is_add) {
    const std::size_t previous_base = static_cast<std::size_t>(index) * layer.instance_floats_per_sprite;
    const auto previous_view = is_add ? std::span<const float>{} : std::span<const float>(layer.instance_data).subspan(previous_base, layer.instance_floats_per_sprite);
    const auto* previous = is_add ? nullptr : &previous_view;
${writer}
}
void set_sprite_frame(Sprite2DLayerRecord& layer, const SpriteAtlasRecord& atlas, double index, double frame) {
${setter}
}
`;
}
