/**
 * The pin's per-pass scene bind-group layout, recorded.
 *
 * `render/scene-helpers.ts#getSceneBindGroupLayout` creates the group every
 * composed material family, background arm and billboard binds at group 0:
 * the scene block, then the lights. Running it against the recording device
 * reads that layout as the pin creates it, so a backend lays its frame group
 * out from these rows rather than restating the entries.
 */
import { pinnedModuleFunction } from "./lowering/pinned-shader-builders.js";
import {
    createRecordingDevice,
    type DescriptorShapes,
} from "./recording-device.js";

interface SceneLayoutShapes extends DescriptorShapes {
    bindGroupLayout: {
        entries: readonly {
            binding: number;
            visibility: number;
            buffer?: { type?: string };
        }[];
    };
}

/** One entry of the pin's scene layout: a uniform block and its stages. */
export interface PinnedSceneLayoutEntry {
    binding: number;
    vertex: boolean;
    fragment: boolean;
}

const sceneHelpers = "src/render/scene-helpers.ts";
const symbol = "getSceneBindGroupLayout";

/** WebGPU's `GPUShaderStage` bits. */
const vertexStage = 1;
const fragmentStage = 2;

let recorded: readonly PinnedSceneLayoutEntry[] | undefined;

/**
 * The scene layout's entries, in binding order. Every entry the pin declares
 * is a uniform buffer; any other resource there refuses, since each backend
 * binds the group from its per-pass uniform blocks.
 */
export function pinnedSceneLayout(): readonly PinnedSceneLayoutEntry[] {
    if (recorded) return recorded;
    const recording = createRecordingDevice<SceneLayoutShapes>({
        producer: symbol,
        device: ["createBindGroupLayout"],
    });
    pinnedModuleFunction(sceneHelpers, symbol)({ _device: recording.device });
    const layouts = recording.recorder.bindGroupLayouts;
    if (layouts.length !== 1) {
        throw new Error(
            `Pinned ${sceneHelpers}#${symbol} created ${layouts.length} bind-group layouts; it creates the one scene layout.`,
        );
    }
    recorded = [...layouts[0]!.entries]
        .sort((left, right) => left.binding - right.binding)
        .map((entry) => {
            if (
                !entry.buffer ||
                (entry.buffer.type ?? "uniform") !== "uniform"
            ) {
                throw new Error(
                    `Pinned ${sceneHelpers}#${symbol} lays out binding ${entry.binding} as something other than a uniform buffer.`,
                );
            }
            return {
                binding: entry.binding,
                vertex: (entry.visibility & vertexStage) !== 0,
                fragment: (entry.visibility & fragmentStage) !== 0,
            };
        });
    return recorded;
}

/** The recorded rows as a C++ table, for the shared variant declarations. */
export function pinnedSceneLayoutCpp(): string {
    const rows = pinnedSceneLayout();
    return `// ${sceneHelpers} ${symbol}, recorded as the pin creates it:
// the per-pass scene group every composed family, background arm and
// billboard binds at group 0. Every entry is a uniform block.
struct PinnedSceneLayoutEntry {
    std::uint32_t binding;
    bool vertex;
    bool fragment;
};
inline constexpr std::array<PinnedSceneLayoutEntry, ${rows.length}> pinned_scene_layout{{
${rows.map((row) => `    {${row.binding}u, ${row.vertex}, ${row.fragment}},`).join("\n")}
}};
`;
}
