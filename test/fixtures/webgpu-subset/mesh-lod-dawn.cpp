// The lowered MeshLoD library's GPU selection and streaming on a headless Dawn
// device through `DawnWebGpuDevice`: mesh-lod-dawn <asset> <dump directory>.

#include "dawn-harness.hpp"
#include "mesh-lod-checks.hpp"

int main(int argc, char** argv) {
    if (argc != 3) {
        std::fprintf(stderr, "usage: mesh-lod-dawn <asset> <dump directory>\n");
        return 1;
    }
    const std::string asset = argv[1], dump = argv[2];
    return webgpu_fixture::run_dawn(
        bbl::gpu_required_limits({}),
        [&](std::shared_ptr<bbl::pal::DawnWebGpuDevice> device, webgpu_fixture::DawnHarness&) {
            return mesh_lod_check::check_selection(device, asset, dump);
        },
        "dawn");
}
