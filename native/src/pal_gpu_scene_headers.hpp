// The generated and runtime headers the scene-shaped GPU concerns read:
// the activation macros, the generator's capability defines and every
// lowered module a concern below names. Included once, ahead of them, in
// the order the one-definition rules of the variant headers require.
#pragma once
#include <bblite/features/compute_frame_graph.hpp>
#include <bblite/features/has_audio.hpp>
#include <bblite/features/has_billboards.hpp>
#include <bblite/features/has_pbr_renderer.hpp>
#include <bblite/features/has_picking.hpp>
#include <bblite/features/has_screen_space.hpp>
#include <bblite/features/has_sprite_renderer.hpp>
#include <bblite/features/has_ui.hpp>
#include <bblite/features/workers.hpp>

#include "pal_compressed_formats.hpp"
#include "pal_record_sync.hpp"
#if BBLITE_HAS_AUDIO
#include <bblite/pal_audio.hpp>
#endif

#include <span>
#include "pal_device_options.hpp"

#include <bblite/pal.hpp>
#include <bblite/pal_image.hpp>
#include <bblite/runtime.hpp>
#include <bblite/teardown.hpp>
// The generator's capability defines, ahead of the first test of one.
#include <bblite/upstream/render_capabilities.hpp>
#if BBLITE_WORKERS
#include <bblite/pal_offscreen.hpp>
#endif
#if BBLITE_COMPUTE_FRAME_GRAPH
#include <bblite/pal_compute_frame_graph.hpp>
#endif
#if BBLITE_GPU_INSTANCE_COLORS
#include <bblite/js_data.hpp>
#endif
// The backend-neutral RmlUi frame types, for the scissor clamp every UI
// consumer applies to a recorded draw before encoding it.
#if BBLITE_HAS_UI
#include <bblite/pal_ui.hpp>
#endif
// An always-emitted pinned read every scene shape carries: the surface
// sample count (the effect drivers compile with no renderer_plan.hpp, so it
// cannot ride that header).
#include <bblite/upstream/pinned_surface.hpp>
// Material slots and mesh transforms belong to scene renderers.
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/material_texture_slots.hpp>
#include <bblite/upstream/pinned_world_transform.hpp>
#include <bblite/upstream/pinned_rgbd.hpp>
#include <bblite/upstream/pinned_matrix.hpp>
#endif
#include <bblite/upstream/pinned_texture.hpp>
#if BBLITE_HAS_SCREEN_SPACE
#include <bblite/upstream/frame_graph_screen_space.hpp>
#include <bblite/upstream/screen_space_shaders.hpp>
#endif
#if BBLITE_HAS_PICKING
#include <bblite/upstream/picking_math.hpp>
#if BBLITE_DEFORM_PICKING
#include <bblite/upstream/picking_projection.hpp>
#endif
#endif
// The render plan is generated only for scenes that register a
// SceneContext; a sprite-only scene has none, and reaches this header for
// the frame options, capture gate and clock alone.
#if BBLITE_HAS_PBR_RENDERER
#include <bblite/upstream/renderer_plan.hpp>
#endif
// The billboard family's own generated layout, for the pick contributor's
// attribute agreement below. Emitted only for a scene that builds a system.
#if BBLITE_HAS_BILLBOARDS
#include <bblite/upstream/billboard_system.hpp>
#endif
// The 2D layer family's generated header, for the renderer's in-place layer
// sort its per-frame update runs.
#if BBLITE_HAS_SPRITE_RENDERER
#include <bblite/upstream/sprite_layer.hpp>
#endif
// Babylon Lite's own composed PBR variants: one entry per material feature
// set the scene's assets reach, each naming its compiled stages and the byte
// size of the per-variant material UBO the pin declares for it. Included here
// because both backends will bind them; a scene with no glTF materials
// reaches none and emits no header.
#if BBLITE_PBR_VARIANTS > 0
#include <bblite/upstream/pbr_variants.hpp>
#endif
// The Standard family's composed variants: the same shape, one entry per
// feature word the scene's materials and meshes reach, plus the selector and
// lowered UBO writers its support block appends. When no pbr_variants.hpp is
// emitted the header hoists the shared scene/lights/mesh mirrors itself, so
// the include order here (after the PBR header) is what keeps one definition.
#if BBLITE_STANDARD_VARIANTS > 0
#include <bblite/upstream/standard_variants.hpp>
#endif
// The pin's background arms as its factories built them, with the lowered
// builders that fill their buffers. Both backends build and draw from it.
#if BBLITE_PINNED_BACKGROUNDS
#include <bblite/upstream/pinned_backgrounds.hpp>
#endif
// The pinned shadow family: the light-space matrices, the receiver block,
// the generator's defaults and the standard-Z depth state its map takes.
// None of that is a material family's, so the header and the depth state
// below ride `BBLITE_SHADOW_RECEIVERS` -- generation's own answer to "does
// this scene reach a shadow generator AND compose a receiver in SOME
// family". `BBLITE_SHADOWS_ESM` is a Standard conjunction, because what it
// gates includes the caster's own material view and only the Standard
// family has one -- so a scene reaching the ESM filter with no Standard
// variant is refused at generation rather than compiled to a define of
// zero.
#if BBLITE_SHADOW_RECEIVERS
#include <bblite/upstream/pinned_shadow.hpp>
#endif
#if BBLITE_SHADOWS_ESM
#include <bblite/upstream/esm_shadow.hpp>
#endif
#include <bblite/upstream/pinned_depth_state.hpp>
#if BBLITE_GPU_MORPH_STORAGE
#include <bblite/upstream/morph_targets.hpp>
#endif
#include <atomic>
#include <cstdio>

// The node family's compiled graphs: one entry per graph the scene parsed,
// each naming its stages, its vertex inputs and its uniform block. It hoists
// the shared scene/lights mirrors when neither header above is emitted, so
// the include order continues the same one-definition rule.
#if BBLITE_NODE_VARIANTS > 0
#include <bblite/upstream/node_variants.hpp>
#endif

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <memory>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "pal_gpu_common.hpp"
#include "pal_gpu_frame.hpp"
#include "pal_gpu_images.hpp"
#include "pal_gpu_ui.hpp"
