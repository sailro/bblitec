// The SDL_GPU scene renderer as one translation unit: every source opens with
// the scene header, which is then parsed once rather than once per file. The
// families come in the order the renderer's single source held them, the
// driver's frame run last. The build compiles only this file; native lint
// also compiles each included source independently, checking its own includes.
#include "pal_sdl_gpu_scene_meshes.cpp"
#include "pal_sdl_gpu_scene_variants.cpp"
#include "pal_sdl_gpu_scene_shadows.cpp"
#include "pal_sdl_gpu_scene_textures.cpp"
#include "pal_sdl_gpu_scene_targets.cpp"
#include "pal_sdl_gpu_scene_post_process.cpp"
#include "pal_sdl_gpu_scene_ssao.cpp"
#include "pal_sdl_gpu_scene_picking.cpp"
#include "pal_sdl_gpu.cpp"
