#pragma once

#include <bblite/runtime.hpp>
#include <bblite/js_data.hpp>

namespace bbl {

/** The pin owns one independent Float32Array for every declared uniform. */
struct ShaderUniformSlot {
    std::string name;
    std::string type;
    std::uint32_t offset = invalid_handle;
    js::F32Array value;
    double version = 0;
};

struct ShaderUniformState {
    std::vector<ShaderUniformSlot> slots;
    double version = 0;
    double ubo_version = 0;
};

/** Live aliases never invalidate this per-material serialized packet themselves. */
struct ShaderUniformUploadState {
    double version = -1;
    std::vector<std::int32_t> slot_versions;
};

using ShaderUniformRead = std::variant<double, js::F32Array>;

struct ShaderUniformInput {
    std::size_t size_value;
    std::function<double(std::size_t)> read;
    std::size_t size() const { return size_value; }
    double load(std::size_t index) const { return read(index); }
};

ShaderUniformRead get_shader_uniform(Engine& engine, MaterialHandle material,
                                     const std::string& name);
void set_shader_uniform_input(Engine& engine, MaterialHandle material, const std::string& name,
                              const ShaderUniformInput& input);
const std::vector<float>& shader_uniform_render_values(const MaterialRecord& material);

template <class Value>
void set_shader_uniform(Engine& engine, MaterialHandle material, const std::string& name,
                        const Value& value) {
    if constexpr (std::is_arithmetic_v<Value>) {
        set_shader_uniform_input(engine, material, name, {1u, [&value](std::size_t) {
                                                              return static_cast<double>(value);
                                                          }});
    } else {
        set_shader_uniform_input(engine, material, name,
                                 {value.size(), [&value](std::size_t index) {
                                      if constexpr (requires { value.load(index); })
                                          return static_cast<double>(value.load(index));
                                      else
                                          return static_cast<double>(value[index]);
                                  }});
    }
}

template <class... Values>
void set_shader_uniform(Engine& engine, MaterialHandle material, const std::string& name,
                        const std::variant<Values...>& value) {
    std::visit([&](const auto& item) { set_shader_uniform(engine, material, name, item); }, value);
}

} // namespace bbl
