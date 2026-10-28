// The lowered MeshLoD library's GPU selection and streaming on an SDL_GPU
// device through `SdlWebGpuDevice`, its selection stages compiled offline
// (BBLITE_GPU_SHADER_DIR): mesh-lod-sdl <asset> <dump directory>.

#include "mesh-lod-checks.hpp"
#include "sdl-harness.hpp"

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: mesh-lod-sdl <asset> <dump directory>\n");
        return 1;
    }
    const std::string asset = argv[1], dump = argv[2];
    return webgpu_fixture::run_sdl(
        bbl::gpu_required_limits({}),
        [&](std::shared_ptr<bbl::pal::SdlWebGpuDevice> device, SDL_GPUDevice*) {
            return mesh_lod_check::check_selection(device, asset, dump);
        },
        "sdl");
}
