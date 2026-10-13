#pragma once

#include <bblite/pal.hpp>

#include <string>

namespace bbl::pal {

/**
 * A deployed shader artifact: `file` in the `BBLITE_GPU_SHADER_DIR` folder
 * beside the executable, or in the folder that environment variable names.
 */
inline std::string gpu_shader_path(const std::string& file) {
    const std::string shader_override = environment_variable("BBLITE_GPU_SHADER_DIR");
    return join_path(shader_override.empty()
                         ? join_path(executable_directory(), BBLITE_GPU_SHADER_DIR)
                         : shader_override,
                     file);
}

} // namespace bbl::pal
