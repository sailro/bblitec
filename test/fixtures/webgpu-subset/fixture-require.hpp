#pragma once

// A failed WebGPU-subset fixture check, by what it checked.

#include <stdexcept>
#include <string>

namespace webgpu_fixture {

inline void require(bool condition, const std::string& message) {
    if (!condition)
        throw std::runtime_error("webgpu check: " + message);
}

} // namespace webgpu_fixture
