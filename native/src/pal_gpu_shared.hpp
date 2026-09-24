// What the GPU backends share, by concern. A unit includes the concern it
// reads; this header includes them all, in dependency order.
#pragma once
#include "pal_gpu_common.hpp"
#include "pal_gpu_frame.hpp"
#include "pal_gpu_images.hpp"
#include "pal_gpu_ui.hpp"
#include "pal_gpu_scene_headers.hpp"
#include "pal_gpu_textures.hpp"
#include "pal_gpu_surface.hpp"
#include "pal_gpu_sprites.hpp"
#include "pal_gpu_vertex.hpp"
#include "pal_gpu_materials.hpp"
#include "pal_gpu_shadows.hpp"
#include "pal_gpu_scene_blocks.hpp"
#include "pal_gpu_picking.hpp"
#include "pal_gpu_targets.hpp"
#include "pal_gpu_pipeline.hpp"
#include "pal_gpu_shader_passes.hpp"
