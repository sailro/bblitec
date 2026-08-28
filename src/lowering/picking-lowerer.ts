import { LoweredSource, LoweringContext } from "./context.js";

/**
 * The runtime half of GPU picking.
 *
 * Everything that decides an ANSWER lives in the backend: the pick renders
 * the scene into a one-pixel target through a sheared view projection and
 * reads the id back, and only the renderer holds the buffers and textures
 * that draw needs. What is left here is the pin's own bookkeeping --
 * `createGpuPicker` builds a record with no device yet
 * (`_device: null`), `disposePicker` releases what the pass allocated, and
 * `pickAsync` serialises against the picker's pending pick.
 *
 * The serialisation is the one piece worth stating. Upstream chains each
 * call onto `picker._pending` so two picks cannot interleave their single
 * set of staging buffers, and *rejection does not wedge the queue*. Here a
 * pick is synchronous: the readback is a wait on submitted work, so the
 * call returns with the answer and the next one starts after it by
 * construction. The queue that upstream needs is the frame boundary this
 * runtime already has.
 */
export class PickingLowerer {
    public constructor(
        private readonly context: LoweringContext,
    ) {}

    public lower(): LoweredSource {
        const modulePath = "src/picking/gpu-picker.ts";
        // Anchored rather than assumed: if the pin stops exporting these,
        // the port is describing a surface that no longer exists.
        for (const name of [
            "createGpuPicker",
            "pickAsync",
            "disposePicker",
        ]) {
            this.context.functionDeclaration(modulePath, name);
        }
        return {
            modulePath,
            symbolName: "pickAsync",
            header: "",
            source: `// ${this.context.provenance(modulePath, "pickAsync")}
#include <bblite/runtime.hpp>

#include <stdexcept>

namespace bbl {

namespace {

GpuPickerRecord& picker_record(
    Engine& engine,
    GpuPickerHandle picker) {
    if (picker.value >= engine.gpu_pickers.size()) {
        throw std::runtime_error("Invalid GPU picker handle.");
    }
    return engine.gpu_pickers[picker.value];
}

} // namespace

// The pinned record starts with no device and no targets; both are made
// on the first pick, which is why a picker created before the loop starts
// costs nothing.
GpuPickerHandle create_gpu_picker(Scene& scene) {
    if (!scene.engine) {
        throw std::runtime_error(
            "createGpuPicker requires a scene bound to an engine.");
    }
    Engine& engine = *scene.engine;
    engine.gpu_pickers.push_back(GpuPickerRecord{false});
    return GpuPickerHandle{
        static_cast<std::uint32_t>(engine.gpu_pickers.size() - 1)};
}

// ${this.context.provenance(modulePath, "pickAsync")}
// A disposed picker answers the empty info the pin's
// \`createEmptyPickingInfo\` returns, as does a pick taken before the
// renderer installed its hook -- a scene that picks without a running
// loop has nothing to read, and reporting a miss is what upstream does
// when the scene has no camera.
PickingInfo gpu_pick(
    Engine& engine,
    GpuPickerHandle picker,
    double x,
    double y) {
    const GpuPickerRecord& record = picker_record(engine, picker);
    if (record.disposed || !engine.pick_hook) {
        return PickingInfo{};
    }
    return engine.pick_hook(picker, x, y);
}

// The name a pick resolved to, read where the scene asks for it rather
// than captured at pick time: upstream \`pickedMesh\` is a live node
// reference, so a scene that renames the node between the pick and the
// read sees the new name.
std::string picked_node_name(
    const Engine& engine,
    const PickingInfo& info) {
    switch (info.picked_kind) {
        case PickedNodeKind::mesh:
            return engine.meshes[info.picked_index].name;
        case PickedNodeKind::splat_mesh:
            return engine.splat_meshes[info.picked_index].name;
        case PickedNodeKind::none:
            break;
    }
    return {};
}

// The backend owns the resources, so it frees them through the same hook
// it installed; the record only stops answering.
void dispose_picker(Engine& engine, GpuPickerHandle picker) {
    picker_record(engine, picker).disposed = true;
}

} // namespace bbl
`,
        };
    }
}
