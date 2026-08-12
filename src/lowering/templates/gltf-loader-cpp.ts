export function gltfLoaderCpp(provenance: string): string {
    return `// ${provenance}
#include <bblite/pal_gltf.hpp>
#include <bblite/runtime.hpp>
#include <bblite/ts_runtime.hpp>
#include <bblite/upstream/gltf_glb_parser.hpp>
#include <bblite/upstream/render_capabilities.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl {
namespace {

using JsonArray = ts::JsonValue::Array;
using JsonObject = ts::JsonValue::Object;

const ts::JsonValue& required(const JsonObject& object, const std::string& key) {
    const auto found = object.find(key);
    if (found == object.end()) throw std::runtime_error("glTF is missing '" + key + "'.");
    return found->second;
}

const ts::JsonValue* optional(const JsonObject& object, const std::string& key) {
    const auto found = object.find(key);
    return found == object.end() ? nullptr : &found->second;
}

const JsonArray& array_or_empty(const JsonObject& object, const std::string& key) {
    static const JsonArray empty;
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_array() : empty;
}

std::size_t unsigned_value(const ts::JsonValue& value) {
    const double number = value.as_number();
    if (number < 0.0 || std::floor(number) != number) throw std::runtime_error("Expected unsigned integer.");
    return static_cast<std::size_t>(number);
}

std::size_t unsigned_or(const JsonObject& object, const std::string& key, std::size_t fallback) {
    const ts::JsonValue* value = optional(object, key);
    return value ? unsigned_value(*value) : fallback;
}

float float_or(const JsonObject& object, const std::string& key, float fallback) {
    const ts::JsonValue* value = optional(object, key);
    return value ? static_cast<float>(value->as_number()) : fallback;
}

bool bool_or(const JsonObject& object, const std::string& key, bool fallback) {
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_boolean() : fallback;
}

std::string string_or(const JsonObject& object, const std::string& key, std::string fallback = {}) {
    const ts::JsonValue* value = optional(object, key);
    return value ? value->as_string() : std::move(fallback);
}

std::vector<float> float_array(const ts::JsonValue* value) {
    if (!value) return {};
    std::vector<float> result;
    for (const ts::JsonValue& element : value->as_array()) {
        result.push_back(static_cast<float>(element.as_number()));
    }
    return result;
}

struct BufferViewInfo {
    std::size_t offset = 0;
    std::size_t length = 0;
    std::size_t stride = 0;
};

struct AccessorInfo {
    std::size_t buffer_view = 0;
    std::size_t offset = 0;
    std::size_t count = 0;
    std::uint32_t component_type = 0;
    std::string type;
    bool normalized = false;
};

using Matrix = std::array<float, 16>;

struct RotationTrack {
    std::size_t node = 0;
    bool cubic = false;
    std::vector<float> times;
    std::vector<Vec4> values;
    std::vector<Vec4> in_tangents;
    std::vector<Vec4> out_tangents;
};

struct TranslationTrack {
    std::size_t node = 0;
    bool cubic = false;
    std::vector<float> times;
    std::vector<Vec3> values;
    std::vector<Vec3> in_tangents;
    std::vector<Vec3> out_tangents;
};

struct WeightTrack {
    std::size_t node = 0;
    std::size_t target_count = 0;
    std::vector<float> times;
    std::vector<float> values;
};

struct AnimatedNode {
    Vec3 translation{};
    Vec4 rotation{0.0f, 0.0f, 0.0f, 1.0f};
    Vec3 scale{1.0f, 1.0f, 1.0f};
    int parent = -1;
    Matrix world{};
    bool computed = false;
    bool computing = false;
    std::vector<float> weights;
};

struct SkinRuntime {
    std::vector<std::size_t> joints;
    std::vector<Matrix> inverse_bind_matrices;
};

struct AnimatedMeshBinding {
    std::uint32_t mesh = 0;
    std::uint32_t geometry = 0;
    std::size_t node = 0;
    std::size_t skin = std::numeric_limits<std::size_t>::max();
};

struct AnimationRuntime {
    float time = 0.0f;
    float duration = 0.0f;
    bool paused = false;
    std::vector<RotationTrack> rotation_tracks;
    std::vector<TranslationTrack> translation_tracks;
    std::vector<TranslationTrack> scale_tracks;
    std::vector<WeightTrack> weight_tracks;
    std::vector<std::vector<std::uint32_t>> node_meshes;
    std::vector<AnimatedNode> nodes;
    std::vector<SkinRuntime> skins;
    std::vector<AnimatedMeshBinding> meshes;
};

std::size_t component_size(std::uint32_t component_type) {
    switch (component_type) {
        case 5120:
        case 5121:
            return 1;
        case 5122:
        case 5123:
            return 2;
        case 5125:
        case 5126:
            return 4;
        default:
            throw std::runtime_error("Unsupported glTF component type.");
    }
}

std::size_t component_count(const std::string& type) {
    if (type == "SCALAR") return 1;
    if (type == "VEC2") return 2;
    if (type == "VEC3") return 3;
    if (type == "VEC4") return 4;
    if (type == "MAT4") return 16;
    throw std::runtime_error("Unsupported glTF accessor type.");
}

template <typename T>
T read_value(const std::uint8_t* data) {
    T value{};
    std::memcpy(&value, data, sizeof(T));
    return value;
}

float read_component(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element,
    std::size_t component) {
    const BufferViewInfo& view = views.at(accessor.buffer_view);
    const std::size_t component_bytes =
        component_size(accessor.component_type);
    const std::size_t components =
        component_count(accessor.type);
    if (element >= accessor.count || component >= components) {
        throw std::runtime_error(
            "glTF accessor element or component is out of range.");
    }
    const std::size_t packed_stride =
        component_bytes * components;
    const std::size_t stride = view.stride != 0 ? view.stride : packed_stride;
    if (stride < packed_stride) {
        throw std::runtime_error(
            "glTF accessor stride is smaller than its element size.");
    }
    if (accessor.offset > view.length) {
        throw std::runtime_error(
            "glTF accessor offset exceeds its bufferView.");
    }
    const std::size_t available =
        view.length - accessor.offset;
    if (
        element >
        std::numeric_limits<std::size_t>::max() / stride) {
        throw std::runtime_error("glTF accessor offset overflows.");
    }
    const std::size_t element_offset = element * stride;
    const std::size_t component_offset =
        component * component_bytes;
    if (
        element_offset > available ||
        component_offset > available - element_offset ||
        component_bytes >
            available - element_offset - component_offset) {
        throw std::runtime_error(
            "glTF accessor exceeds its bufferView.");
    }
    const std::size_t offset =
        container.bin_offset +
        view.offset +
        accessor.offset +
        element_offset +
        component_offset;
    const std::uint8_t* data = buffer.data() + offset;
    switch (accessor.component_type) {
        case 5120: {
            const std::int8_t value = read_value<std::int8_t>(data);
            return accessor.normalized ? std::max(-1.0f, static_cast<float>(value) / 127.0f) : value;
        }
        case 5121: {
            const std::uint8_t value = read_value<std::uint8_t>(data);
            return accessor.normalized ? static_cast<float>(value) / 255.0f : value;
        }
        case 5122: {
            const std::int16_t value = read_value<std::int16_t>(data);
            return accessor.normalized ? std::max(-1.0f, static_cast<float>(value) / 32767.0f) : value;
        }
        case 5123: {
            const std::uint16_t value = read_value<std::uint16_t>(data);
            return accessor.normalized ? static_cast<float>(value) / 65535.0f : value;
        }
        case 5125:
            return static_cast<float>(read_value<std::uint32_t>(data));
        case 5126:
            return read_value<float>(data);
        default:
            throw std::runtime_error("Unsupported glTF component type.");
    }
}

std::uint32_t read_index(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const AccessorInfo& accessor,
    std::size_t element) {
    return static_cast<std::uint32_t>(read_component(buffer, container, views, accessor, element, 0));
}

Vec3 normalize(Vec3 value) {
    const float length = std::sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
    return length > 0.000001f
        ? Vec3{value.x / length, value.y / length, value.z / length}
        : Vec3{0.0f, 1.0f, 0.0f};
}

Vec4 normalize_quaternion(Vec4 value) {
    const float length = std::sqrt(
        value.x * value.x +
        value.y * value.y +
        value.z * value.z +
        value.w * value.w);
    return length > 0.000001f
        ? Vec4{
              value.x / length,
              value.y / length,
              value.z / length,
              value.w / length,
          }
        : Vec4{0.0f, 0.0f, 0.0f, 1.0f};
}

Vec4 interpolate_quaternion(Vec4 left, Vec4 right, float amount) {
    float dot =
        left.x * right.x +
        left.y * right.y +
        left.z * right.z +
        left.w * right.w;
    if (dot < 0.0f) {
        right = Vec4{-right.x, -right.y, -right.z, -right.w};
        dot = -dot;
    }
    if (dot > 0.9995f) {
        return normalize_quaternion(Vec4{
            left.x + (right.x - left.x) * amount,
            left.y + (right.y - left.y) * amount,
            left.z + (right.z - left.z) * amount,
            left.w + (right.w - left.w) * amount,
        });
    }
    const float theta = std::acos(dot);
    const float sin_theta = std::sin(theta);
    const float left_weight =
        std::sin((1.0f - amount) * theta) /
        sin_theta;
    const float right_weight =
        std::sin(amount * theta) /
        sin_theta;
    return Vec4{
        left_weight * left.x +
            right_weight * right.x,
        left_weight * left.y +
            right_weight * right.y,
        left_weight * left.z +
            right_weight * right.z,
        left_weight * left.w +
            right_weight * right.w,
    };
}

Vec4 cubic_quaternion(
    Vec4 left,
    Vec4 left_tangent,
    Vec4 right,
    Vec4 right_tangent,
    float amount,
    float span) {
    const float amount2 = amount * amount;
    const float amount3 = amount2 * amount;
    const float h00 = 2.0f * amount3 - 3.0f * amount2 + 1.0f;
    const float h10 = amount3 - 2.0f * amount2 + amount;
    const float h01 = -2.0f * amount3 + 3.0f * amount2;
    const float h11 = amount3 - amount2;
    return normalize_quaternion(Vec4{
        h00 * left.x + h10 * span * left_tangent.x +
            h01 * right.x + h11 * span * right_tangent.x,
        h00 * left.y + h10 * span * left_tangent.y +
            h01 * right.y + h11 * span * right_tangent.y,
        h00 * left.z + h10 * span * left_tangent.z +
            h01 * right.z + h11 * span * right_tangent.z,
        h00 * left.w + h10 * span * left_tangent.w +
            h01 * right.w + h11 * span * right_tangent.w,
    });
}

Vec3 cubic_vec3(
    Vec3 left,
    Vec3 left_tangent,
    Vec3 right,
    Vec3 right_tangent,
    float amount,
    float span) {
    const float amount2 = amount * amount;
    const float amount3 = amount2 * amount;
    const float h00 = 2.0f * amount3 - 3.0f * amount2 + 1.0f;
    const float h10 = amount3 - 2.0f * amount2 + amount;
    const float h01 = -2.0f * amount3 + 3.0f * amount2;
    const float h11 = amount3 - amount2;
    return Vec3{
        h00 * left.x + h10 * span * left_tangent.x +
            h01 * right.x + h11 * span * right_tangent.x,
        h00 * left.y + h10 * span * left_tangent.y +
            h01 * right.y + h11 * span * right_tangent.y,
        h00 * left.z + h10 * span * left_tangent.z +
            h01 * right.z + h11 * span * right_tangent.z,
    };
}

Matrix identity_matrix() {
    Matrix result{};
    result[0] = result[5] = result[10] = result[15] = 1.0f;
    return result;
}

Matrix multiply_matrix(const Matrix& left, const Matrix& right) {
    // Pinned matrix multiplication runs in JavaScript double
    // precision over float32 entries and rounds once per component
    // at the Float32Array store; mirror that exactly.
    Matrix result{};
    for (int column = 0; column < 4; ++column) {
        for (int row = 0; row < 4; ++row) {
            double sum = 0.0;
            for (int index = 0; index < 4; ++index) {
                sum +=
                    static_cast<double>(left[index * 4 + row]) *
                    static_cast<double>(right[column * 4 + index]);
            }
            result[column * 4 + row] = static_cast<float>(sum);
        }
    }
    return result;
}

Matrix local_matrix(const JsonObject& node) {
    if (const ts::JsonValue* matrix_value = optional(node, "matrix")) {
        const std::vector<float> values = float_array(matrix_value);
        if (values.size() != 16) throw std::runtime_error("glTF node matrix must have 16 values.");
        Matrix result{};
        std::copy(values.begin(), values.end(), result.begin());
        return result;
    }
    const std::vector<float> translation = float_array(optional(node, "translation"));
    const std::vector<float> rotation = float_array(optional(node, "rotation"));
    const std::vector<float> scale = float_array(optional(node, "scale"));
    const float tx = translation.size() == 3 ? translation[0] : 0.0f;
    const float ty = translation.size() == 3 ? translation[1] : 0.0f;
    const float tz = translation.size() == 3 ? translation[2] : 0.0f;
    const float x = rotation.size() == 4 ? rotation[0] : 0.0f;
    const float y = rotation.size() == 4 ? rotation[1] : 0.0f;
    const float z = rotation.size() == 4 ? rotation[2] : 0.0f;
    const float w = rotation.size() == 4 ? rotation[3] : 1.0f;
    const float sx = scale.size() == 3 ? scale[0] : 1.0f;
    const float sy = scale.size() == 3 ? scale[1] : 1.0f;
    const float sz = scale.size() == 3 ? scale[2] : 1.0f;
    Matrix result = identity_matrix();
    result[0] = (1.0f - 2.0f * (y * y + z * z)) * sx;
    result[1] = (2.0f * (x * y + z * w)) * sx;
    result[2] = (2.0f * (x * z - y * w)) * sx;
    result[4] = (2.0f * (x * y - z * w)) * sy;
    result[5] = (1.0f - 2.0f * (x * x + z * z)) * sy;
    result[6] = (2.0f * (y * z + x * w)) * sy;
    result[8] = (2.0f * (x * z + y * w)) * sz;
    result[9] = (2.0f * (y * z - x * w)) * sz;
    result[10] = (1.0f - 2.0f * (x * x + y * y)) * sz;
    result[12] = tx;
    result[13] = ty;
    result[14] = tz;
    return result;
}

Matrix trs_matrix(
    Vec3 translation,
    Vec4 rotation,
    Vec3 scale) {
    // Pinned mat4ComposeInto runs in JavaScript double precision and
    // rounds once at the Float32Array store; mirror its products and
    // association exactly.
    const double x = rotation.x;
    const double y = rotation.y;
    const double z = rotation.z;
    const double w = rotation.w;
    const double xx = x * x;
    const double yy = y * y;
    const double zz = z * z;
    const double xy = x * y;
    const double xz = x * z;
    const double yz = y * z;
    const double wx = w * x;
    const double wy = w * y;
    const double wz = w * z;
    const double sx = scale.x;
    const double sy = scale.y;
    const double sz = scale.z;
    Matrix result = identity_matrix();
    result[0] = static_cast<float>((1.0 - 2.0 * (yy + zz)) * sx);
    result[1] = static_cast<float>(2.0 * (xy + wz) * sx);
    result[2] = static_cast<float>(2.0 * (xz - wy) * sx);
    result[4] = static_cast<float>(2.0 * (xy - wz) * sy);
    result[5] = static_cast<float>((1.0 - 2.0 * (xx + zz)) * sy);
    result[6] = static_cast<float>(2.0 * (yz + wx) * sy);
    result[8] = static_cast<float>(2.0 * (xz + wy) * sz);
    result[9] = static_cast<float>(2.0 * (yz - wx) * sz);
    result[10] = static_cast<float>((1.0 - 2.0 * (xx + yy)) * sz);
    result[12] = translation.x;
    result[13] = translation.y;
    result[14] = translation.z;
    return result;
}

Matrix inverse_affine(const Matrix& matrix) {
    const float determinant =
        matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6]) -
        matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2]) +
        matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
    if (std::abs(determinant) < 0.000001f) {
        return identity_matrix();
    }
    const float inverse_determinant = 1.0f / determinant;
    Matrix result = identity_matrix();
    result[0] = (matrix[5] * matrix[10] - matrix[9] * matrix[6]) * inverse_determinant;
    result[1] = (matrix[9] * matrix[2] - matrix[1] * matrix[10]) * inverse_determinant;
    result[2] = (matrix[1] * matrix[6] - matrix[5] * matrix[2]) * inverse_determinant;
    result[4] = (matrix[8] * matrix[6] - matrix[4] * matrix[10]) * inverse_determinant;
    result[5] = (matrix[0] * matrix[10] - matrix[8] * matrix[2]) * inverse_determinant;
    result[6] = (matrix[4] * matrix[2] - matrix[0] * matrix[6]) * inverse_determinant;
    result[8] = (matrix[4] * matrix[9] - matrix[8] * matrix[5]) * inverse_determinant;
    result[9] = (matrix[8] * matrix[1] - matrix[0] * matrix[9]) * inverse_determinant;
    result[10] = (matrix[0] * matrix[5] - matrix[4] * matrix[1]) * inverse_determinant;
    result[12] = -(
        result[0] * matrix[12] +
        result[4] * matrix[13] +
        result[8] * matrix[14]);
    result[13] = -(
        result[1] * matrix[12] +
        result[5] * matrix[13] +
        result[9] * matrix[14]);
    result[14] = -(
        result[2] * matrix[12] +
        result[6] * matrix[13] +
        result[10] * matrix[14]);
    return result;
}

Matrix native_matrix(const Matrix& matrix) {
    Matrix result{};
    for (std::size_t column = 0; column < 4; ++column) {
        for (std::size_t row = 0; row < 4; ++row) {
            const float row_sign = row == 0 ? -1.0f : 1.0f;
            const float column_sign =
                column == 0 ? -1.0f : 1.0f;
            result[column * 4 + row] =
                matrix[column * 4 + row] *
                row_sign *
                column_sign;
        }
    }
    return result;
}

Vec3 transform_point_raw(const Matrix& matrix, Vec3 value) {
    return Vec3{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z + matrix[12],
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z + matrix[13],
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z + matrix[14],
    };
}

Vec3 transform_direction_raw(const Matrix& matrix, Vec3 value) {
    return Vec3{
        matrix[0] * value.x + matrix[4] * value.y + matrix[8] * value.z,
        matrix[1] * value.x + matrix[5] * value.y + matrix[9] * value.z,
        matrix[2] * value.x + matrix[6] * value.y + matrix[10] * value.z,
    };
}

Vec3 transform_point(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed = transform_point_raw(matrix, value);
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

// Babylon Lite normalizes the object-space direction and interpolates
// the transformed vector unnormalized; only the fragment renormalizes.
Vec3 transform_direction(const Matrix& matrix, Vec3 value) {
    const Vec3 transformed =
        transform_direction_raw(matrix, normalize(value));
    return Vec3{-transformed.x, transformed.y, transformed.z};
}

float linear_determinant(const Matrix& matrix) {
    return
        matrix[0] * (matrix[5] * matrix[10] - matrix[9] * matrix[6]) -
        matrix[4] * (matrix[1] * matrix[10] - matrix[9] * matrix[2]) +
        matrix[8] * (matrix[1] * matrix[6] - matrix[5] * matrix[2]);
}

TextureData image_data(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    std::size_t image_index) {
    TextureData result;
    const JsonObject& image =
        images.at(image_index).as_object();
    const BufferViewInfo& view = views.at(
        unsigned_value(required(image, "bufferView")));
    const std::size_t start =
        container.bin_offset + view.offset;
    const std::size_t end = start + view.length;
    if (end > buffer.byte_length()) {
        throw std::runtime_error(
            "glTF image exceeds BIN chunk.");
    }
    const std::string mime_type =
        string_or(image, "mimeType");
    if (
        mime_type != "image/png" &&
        mime_type != "image/jpeg") {
        throw std::runtime_error(
            "Only embedded PNG/JPEG glTF images are supported.");
    }
    result.bytes.assign(
        buffer.bytes().begin() + start,
        buffer.bytes().begin() + end);
    return result;
}

float color_channel(
    const Color3& color,
    int channel) {
    return channel == 0
        ? color.r
        : channel == 1
            ? color.g
            : color.b;
}

void set_color_channel(
    Color3& color,
    int channel,
    float value) {
    if (channel == 0) color.r = value;
    else if (channel == 1) color.g = value;
    else color.b = value;
}

std::array<Color3, 9> pre_scale_harmonics(
    const std::array<Color3, 9>& polynomial) {
    constexpr float c00xy = 0.3333338747897695f;
    constexpr float c00z = 0.33333298856284405f;
    constexpr float c1 = 1.4999984284682104f;
    constexpr float c2 = 3.999982863580422f;
    constexpr float c20zz = 1.3333326611423701f;
    constexpr float c20xy = 0.6666653397393608f;
    constexpr float c22 = 1.999991431790211f;
    std::array<Color3, 9> result{};
    for (int channel = 0; channel < 3; ++channel) {
        const float x =
            color_channel(polynomial[0], channel);
        const float y =
            color_channel(polynomial[1], channel);
        const float z =
            color_channel(polynomial[2], channel);
        const float xx =
            color_channel(polynomial[3], channel);
        const float yy =
            color_channel(polynomial[4], channel);
        const float zz =
            color_channel(polynomial[5], channel);
        const float yz =
            color_channel(polynomial[6], channel);
        const float zx =
            color_channel(polynomial[7], channel);
        const float xy =
            color_channel(polynomial[8], channel);
        set_color_channel(
            result[0],
            channel,
            (xx + yy) * c00xy + zz * c00z);
        set_color_channel(
            result[1], channel, y * c1);
        set_color_channel(
            result[2], channel, z * c1);
        set_color_channel(
            result[3], channel, x * c1);
        set_color_channel(
            result[4], channel, xy * c2);
        set_color_channel(
            result[5], channel, yz * c2);
        set_color_channel(
            result[6],
            channel,
            zz * c20zz - (xx + yy) * c20xy);
        set_color_channel(
            result[7], channel, zx * c2);
        set_color_channel(
            result[8],
            channel,
            (xx - yy) * c22);
    }
    return result;
}

bool load_image_based_environment(
    EnvironmentState& environment,
    const JsonObject& document,
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images) {
    const ts::JsonValue* extensions_value =
        optional(document, "extensions");
    const JsonArray& scenes =
        array_or_empty(document, "scenes");
    if (!extensions_value || scenes.empty()) {
        return false;
    }
    const JsonObject& extensions =
        extensions_value->as_object();
    const ts::JsonValue* ibl_value =
        optional(extensions, "EXT_lights_image_based");
    if (!ibl_value) return false;
    const JsonArray& lights = array_or_empty(
        ibl_value->as_object(),
        "lights");
    const std::size_t scene_index =
        unsigned_or(document, "scene", 0);
    if (scene_index >= scenes.size()) return false;
    const JsonObject& scene =
        scenes[scene_index].as_object();
    const ts::JsonValue* scene_extensions_value =
        optional(scene, "extensions");
    if (!scene_extensions_value) return false;
    const ts::JsonValue* scene_ibl_value =
        optional(
            scene_extensions_value->as_object(),
            "EXT_lights_image_based");
    if (!scene_ibl_value) return false;
    const std::size_t light_index = unsigned_value(
        required(
            scene_ibl_value->as_object(),
            "light"));
    if (light_index >= lights.size()) return false;
    const JsonObject& light =
        lights[light_index].as_object();
    const JsonArray& coefficients =
        array_or_empty(
            light,
            "irradianceCoefficients");
    const JsonArray& specular_images =
        array_or_empty(light, "specularImages");
    if (
        coefficients.size() != 9 ||
        specular_images.empty()) {
        return false;
    }
    const float intensity =
        float_or(light, "intensity", 1.0f);
    const float scale = intensity / pi;
    const float inverse_pi = 1.0f / pi;
    std::array<Color3, 9> source{};
    for (
        std::size_t coefficient = 0;
        coefficient < source.size();
        ++coefficient) {
        const std::vector<float> values =
            float_array(&coefficients[coefficient]);
        if (values.size() != 3) {
            throw std::runtime_error(
                "Image-based light irradiance coefficient must be vec3.");
        }
        source[coefficient] = Color3{
            values[0] * scale,
            values[1] * scale,
            values[2] * scale,
        };
    }
    std::array<Color3, 9> polynomial{};
    for (int channel = 0; channel < 3; ++channel) {
        const float l00 =
            color_channel(source[0], channel);
        const float l1_1 =
            color_channel(source[1], channel);
        const float l10 =
            color_channel(source[2], channel);
        const float l11 =
            color_channel(source[3], channel);
        const float l2_2 =
            color_channel(source[4], channel);
        const float l2_1 =
            color_channel(source[5], channel);
        const float l20 =
            color_channel(source[6], channel);
        const float l21 =
            color_channel(source[7], channel);
        const float l22 =
            color_channel(source[8], channel);
        set_color_channel(
            polynomial[0],
            channel,
            -1.02333f * l11 * inverse_pi);
        set_color_channel(
            polynomial[1],
            channel,
            -1.02333f * l1_1 * inverse_pi);
        set_color_channel(
            polynomial[2],
            channel,
            1.02333f * l10 * inverse_pi);
        set_color_channel(
            polynomial[3],
            channel,
            (
                0.886277f * l00 -
                0.247708f * l20 +
                0.429043f * l22) *
                inverse_pi);
        set_color_channel(
            polynomial[4],
            channel,
            (
                0.886277f * l00 -
                0.247708f * l20 -
                0.429043f * l22) *
                inverse_pi);
        set_color_channel(
            polynomial[5],
            channel,
            (
                0.886277f * l00 +
                0.495417f * l20) *
                inverse_pi);
        set_color_channel(
            polynomial[6],
            channel,
            -0.858086f * l2_1 * inverse_pi);
        set_color_channel(
            polynomial[7],
            channel,
            -0.858086f * l21 * inverse_pi);
        set_color_channel(
            polynomial[8],
            channel,
            0.858086f * l2_2 * inverse_pi);
    }
    environment.has_irradiance = true;
    environment.spherical_harmonics =
        pre_scale_harmonics(polynomial);
    environment.specular_width =
        static_cast<std::uint32_t>(
            unsigned_value(
                required(
                    light,
                    "specularImageSize")));
    environment.specular_mip_count =
        static_cast<std::uint32_t>(
            specular_images.size());
    environment.specular_faces.clear();
    environment.specular_faces.reserve(
        specular_images.size() * 6);
    for (const ts::JsonValue& mip_value :
         specular_images) {
        const JsonArray& faces =
            mip_value.as_array();
        if (faces.size() != 6) {
            throw std::runtime_error(
                "Image-based light mip must contain six faces.");
        }
        for (const ts::JsonValue& face : faces) {
            environment.specular_faces.push_back(
                image_data(
                    buffer,
                    container,
                    views,
                    images,
                    unsigned_value(face)));
        }
    }
    environment.lod_generation_scale =
        specular_images.size() > 1
            ? static_cast<float>(
                  specular_images.size() - 1) /
                  std::log2(
                      static_cast<float>(
                          environment.specular_width))
            : 0.0f;
    const std::vector<float> rotation =
        float_array(optional(light, "rotation"));
    if (rotation.size() == 4) {
        environment.rotation_y =
            -2.0f *
            std::atan2(rotation[1], rotation[3]);
    }
    environment.brdf_lut.bytes =
        pal::read_binary_file(
            asset_path(
                "gltf-ibl-brdf-lut.rgba16f"));
    environment.brdf_lut_width = 256;
    environment.brdf_lut_rgba16f = true;
    environment.exposure = 0.8f;
    environment.contrast = 1.2f;
    environment.tone_mapping_enabled = true;
    return true;
}

TextureData texture_data(
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    const JsonArray& textures,
    const JsonArray& samplers,
    const ts::JsonValue* texture_info) {
    TextureData result;
    if (!texture_info) return result;
    const JsonObject& info = texture_info->as_object();
    const std::size_t texture_index = unsigned_value(required(info, "index"));
    const JsonObject& texture = textures.at(texture_index).as_object();
    const JsonObject* sampler = nullptr;
    if (const ts::JsonValue* sampler_value = optional(texture, "sampler")) {
        sampler = &samplers.at(unsigned_value(*sampler_value)).as_object();
    }
    const std::size_t min_filter =
        sampler ? unsigned_or(*sampler, "minFilter", 9987) : 9987;
    const std::size_t mag_filter =
        sampler ? unsigned_or(*sampler, "magFilter", 9729) : 9729;
    const bool min_nearest = min_filter % 2 == 0;
    const bool mip_nearest = min_filter == 9984 || min_filter == 9985;
    const bool no_mip = min_filter == 9728 || min_filter == 9729;
    const bool mag_linear = mag_filter != 9728;
    result.sampler.min_filter =
        min_nearest ? TextureFilter::nearest : TextureFilter::linear;
    result.sampler.mipmap_mode =
        mip_nearest ? TextureMipmapMode::nearest : TextureMipmapMode::linear;
    result.sampler.mag_filter =
        mag_linear ? TextureFilter::linear : TextureFilter::nearest;
    result.sampler.max_lod = no_mip ? 0.0f : 1000.0f;
    result.sampler.max_anisotropy =
        mag_linear && !min_nearest && !mip_nearest && !no_mip
            ? 4.0f
            : 1.0f;
    const auto address_mode = [](std::size_t mode) {
        return mode == 33071
            ? TextureAddressMode::clamp
            : mode == 33648
                ? TextureAddressMode::mirror
                : TextureAddressMode::repeat;
    };
    result.sampler.address_u = address_mode(
        sampler ? unsigned_or(*sampler, "wrapS", 10497) : 10497);
    result.sampler.address_v = address_mode(
        sampler ? unsigned_or(*sampler, "wrapT", 10497) : 10497);
    const std::size_t image_index = unsigned_value(required(texture, "source"));
    result.bytes = image_data(
        buffer,
        container,
        views,
        images,
        image_index).bytes;
    return result;
}

const ts::JsonValue* texture_transform_value(
    const ts::JsonValue* texture_info) {
    if (!texture_info) return nullptr;
    const ts::JsonValue* extensions_value =
        optional(
            texture_info->as_object(),
            "extensions");
    if (!extensions_value) return nullptr;
    return optional(
        extensions_value->as_object(),
        "KHR_texture_transform");
}

void apply_texture_transform(
    MaterialRecord& material,
    const ts::JsonValue* texture_info) {
    if (!texture_info) return;
    const ts::JsonValue* extensions_value =
        optional(
            texture_info->as_object(),
            "extensions");
    if (!extensions_value) return;
    const ts::JsonValue* transform_value =
        optional(
            extensions_value->as_object(),
            "KHR_texture_transform");
    if (!transform_value) return;
    const JsonObject& transform =
        transform_value->as_object();
    const std::vector<float> scale =
        float_array(optional(transform, "scale"));
    const std::vector<float> offset =
        float_array(optional(transform, "offset"));
    if (scale.size() == 2) {
        material.diffuse_u_scale = scale[0];
        material.diffuse_v_scale = scale[1];
    }
    if (offset.size() == 2) {
        if (
            std::abs(offset[0]) > 0.000001f ||
            std::abs(offset[1]) > 0.000001f) {
            throw std::runtime_error(
                "Offset glTF texture transforms are not supported.");
        }
    }
    if (
        std::abs(
            float_or(transform, "rotation", 0.0f)) >
        0.000001f) {
        throw std::runtime_error(
            "Rotated glTF texture transforms are not supported.");
    }
}

void require_matching_texture_transform(
    const MaterialRecord& material,
    const ts::JsonValue* texture_info) {
    if (!texture_info) return;
    MaterialRecord candidate;
    apply_texture_transform(
        candidate,
        texture_info);
    if (
        std::abs(
            candidate.diffuse_u_scale -
            material.diffuse_u_scale) >
            0.000001f ||
        std::abs(
            candidate.diffuse_v_scale -
            material.diffuse_v_scale) >
            0.000001f) {
        throw std::runtime_error(
            "Reached glTF material uses distinct texture transforms.");
    }
}

// Babylon Lite bakes texture-less PBR factors into 1x1 factor
// textures (gltf-pbr-builder uploadBaseColorFactorTexture /
// uploadOrmFactorTexture) and leaves the shader uniforms at their
// defaults, so the browser shades with the 8-bit quantized values.
// Quantize the record factors identically: the native white-fallback
// texture times the quantized uniform reproduces the browser's
// quantized texel times the default uniform bit for bit.
float quantized_unorm_factor(float value) {
    return std::round(
               std::clamp(value, 0.0f, 1.0f) * 255.0f) /
        255.0f;
}

std::uint8_t linear_to_srgb_byte(float value) {
    // Pinned linearToSrgbByte: the byte lands in an rgba8unorm-srgb
    // texel whose hardware decode is the browser's effective value.
    const double clamped = std::clamp(
        static_cast<double>(value),
        0.0,
        1.0);
    const double encoded = clamped <= 0.0031308
        ? clamped * 12.92
        : 1.055 * std::pow(clamped, 1.0 / 2.4) - 0.055;
    return static_cast<std::uint8_t>(
        std::round(encoded * 255.0));
}

MaterialHandle load_material(
    Engine& engine,
    const JsonObject& material_json,
    const ts::ArrayBuffer& buffer,
    const upstream::ParsedGlbContainer& container,
    const std::vector<BufferViewInfo>& views,
    const JsonArray& images,
    const JsonArray& textures,
    const JsonArray& samplers) {
    MaterialRecord material;
    material.emissive_factor = Color3{0.0f, 0.0f, 0.0f};
    material.specular_aa = true;
    if (const ts::JsonValue* pbr_value = optional(material_json, "pbrMetallicRoughness")) {
        const JsonObject& pbr = pbr_value->as_object();
        const std::vector<float> base = float_array(optional(pbr, "baseColorFactor"));
        if (base.size() == 4) material.base_color_factor = Color4{base[0], base[1], base[2], base[3]};
        material.metallic_factor = float_or(pbr, "metallicFactor", 1.0f);
        material.roughness_factor = float_or(pbr, "roughnessFactor", 1.0f);
        const ts::JsonValue* base_color_texture =
            optional(pbr, "baseColorTexture");
        material.base_color_texture = texture_data(
            buffer, container, views, images, textures, samplers, base_color_texture);
        apply_texture_transform(
            material,
            base_color_texture);
        const ts::JsonValue*
            metallic_roughness_texture =
                optional(
                    pbr,
                    "metallicRoughnessTexture");
        material.metallic_roughness_texture = texture_data(
            buffer, container, views, images, textures, samplers, metallic_roughness_texture);
        require_matching_texture_transform(
            material,
            metallic_roughness_texture);
        if (material.metallic_roughness_texture.bytes.empty()) {
            material.metallic_factor =
                quantized_unorm_factor(material.metallic_factor);
            material.roughness_factor =
                quantized_unorm_factor(material.roughness_factor);
        }
        if (material.base_color_texture.bytes.empty()) {
            // Pinned uploadBaseColorFactorTexture: the factor bakes
            // into the sRGB fallback texel (alpha as a linear byte)
            // and the shader uniform reverts to white; the raw alpha
            // stays on the record for the pinned blend semantics.
            material.base_color_fallback = {
                linear_to_srgb_byte(material.base_color_factor.r),
                linear_to_srgb_byte(material.base_color_factor.g),
                linear_to_srgb_byte(material.base_color_factor.b),
                static_cast<std::uint8_t>(
                    std::round(
                        std::clamp(
                            material.base_color_factor.a,
                            0.0f,
                            1.0f) *
                        255.0f)),
            };
            material.base_color_factor.r = 1.0f;
            material.base_color_factor.g = 1.0f;
            material.base_color_factor.b = 1.0f;
        }
    }
    const ts::JsonValue* normal_texture =
        optional(material_json, "normalTexture");
    material.normal_texture = texture_data(
        buffer, container, views, images, textures, samplers, normal_texture);
    require_matching_texture_transform(
        material,
        normal_texture);
    if (normal_texture) {
        material.normal_texture_scale =
            float_or(normal_texture->as_object(), "scale", 1.0f);
    }
    const ts::JsonValue* occlusion_texture_info =
        optional(material_json, "occlusionTexture");
    material.has_occlusion_texture = occlusion_texture_info != nullptr;
    if (occlusion_texture_info) {
        // Babylon Lite's buildDefaultPbrTexturesExt: an occlusion
        // texture on TEXCOORD_1 without a metallic-roughness image
        // keeps the factor-driven ORM slot and binds the occlusion
        // image through the dedicated uv2 pair; on TEXCOORD_0 the
        // occlusion image itself becomes the ORM texture while
        // assemblePbrPropsExt drops the glTF metallic and roughness
        // factors (the engine defaults of 1.0 apply). Distinct
        // metallic-roughness and occlusion images composite upstream
        // and stay unreached natively.
        const ts::JsonValue* metallic_roughness_info = nullptr;
        if (const ts::JsonValue* pbr_value =
                optional(material_json, "pbrMetallicRoughness")) {
            metallic_roughness_info = optional(
                pbr_value->as_object(),
                "metallicRoughnessTexture");
        }
        const auto texture_image =
            [&](const ts::JsonValue* info) -> std::size_t {
                const std::size_t texture_index = unsigned_value(
                    required(info->as_object(), "index"));
                return unsigned_value(
                    required(
                        textures.at(texture_index).as_object(),
                        "source"));
            };
        const std::size_t occlusion_uv = unsigned_or(
            occlusion_texture_info->as_object(),
            "texCoord",
            0);
        if (occlusion_uv == 1) {
            if (metallic_roughness_info) {
                throw std::runtime_error(
                    "Reached glTF occlusion texture on TEXCOORD_1 "
                    "alongside a metallic-roughness texture is not "
                    "lowered.");
            }
            material.occlusion_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                occlusion_texture_info);
            material.occlusion_texture_uv2 = true;
        } else if (occlusion_uv == 0) {
            if (!metallic_roughness_info) {
                material.metallic_roughness_texture = texture_data(
                    buffer,
                    container,
                    views,
                    images,
                    textures,
                    samplers,
                    occlusion_texture_info);
                material.metallic_factor = 1.0f;
                material.roughness_factor = 1.0f;
            } else if (
                texture_image(metallic_roughness_info) !=
                texture_image(occlusion_texture_info)) {
                throw std::runtime_error(
                    "Reached glTF material uses distinct occlusion "
                    "and metallic-roughness images.");
            }
        } else {
            throw std::runtime_error(
                "Reached glTF occlusion texture uses an unsupported "
                "texture-coordinate set.");
        }
    }
    if (const ts::JsonValue* extensions_value = optional(material_json, "extensions")) {
        const JsonObject& extensions = extensions_value->as_object();
        material.unlit = optional(extensions, "KHR_materials_unlit") != nullptr;
        if (const ts::JsonValue* ior_value =
                optional(extensions, "KHR_materials_ior")) {
            material.has_ior = true;
            material.index_of_refraction =
                float_or(ior_value->as_object(), "ior", 1.5f);
            const float ratio =
                (material.index_of_refraction - 1.0f) /
                (material.index_of_refraction + 1.0f);
            material.reflectance = ratio * ratio;
        }
        if (const ts::JsonValue* volume_value =
                optional(extensions, "KHR_materials_volume")) {
            const JsonObject& volume = volume_value->as_object();
            material.has_volume = true;
            material.use_thickness_as_depth = true;
            material.thickness =
                float_or(volume, "thicknessFactor", 0.0f);
            const std::vector<float> attenuation =
                float_array(optional(volume, "attenuationColor"));
            if (attenuation.size() == 3) {
                material.attenuation_color = Color3{
                    attenuation[0],
                    attenuation[1],
                    attenuation[2],
                };
            }
            material.attenuation_distance =
                float_or(volume, "attenuationDistance", 1.0f);
            material.thickness_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                optional(volume, "thicknessTexture"));
        }
        if (const ts::JsonValue* transmission_value =
                optional(extensions, "KHR_materials_transmission")) {
            const JsonObject& transmission =
                transmission_value->as_object();
            material.transmission_factor =
                float_or(transmission, "transmissionFactor", 0.0f);
            material.transmission_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                optional(transmission, "transmissionTexture"));
        }
        if (const ts::JsonValue* dispersion_value =
                optional(
                    extensions,
                    "KHR_materials_dispersion")) {
            const float dispersion = float_or(
                dispersion_value->as_object(),
                "dispersion",
                0.0f);
            const bool has_refraction =
                material.has_ior ||
                material.transmission_factor > 0.0f ||
                !material.transmission_texture.bytes.empty();
            const bool has_thickness =
                material.thickness > 0.0f ||
                !material.thickness_texture.bytes.empty();
            if (
                dispersion > 0.0f &&
                has_refraction &&
                has_thickness) {
                material.dispersion = 20.0f / dispersion;
            }
        }
        if (const ts::JsonValue* clearcoat_value =
                optional(
                    extensions,
                    "KHR_materials_clearcoat")) {
            const JsonObject& clearcoat =
                clearcoat_value->as_object();
            const ts::JsonValue* clearcoat_texture =
                optional(clearcoat, "clearcoatTexture");
            const ts::JsonValue*
                clearcoat_roughness_texture = optional(
                    clearcoat,
                    "clearcoatRoughnessTexture");
            const ts::JsonValue* clearcoat_normal_texture =
                optional(
                    clearcoat,
                    "clearcoatNormalTexture");
            material.clearcoat_intensity = float_or(
                clearcoat,
                "clearcoatFactor",
                clearcoat_texture ? 1.0f : 0.0f);
            material.clearcoat_roughness = float_or(
                clearcoat,
                "clearcoatRoughnessFactor",
                clearcoat_roughness_texture ? 1.0f : 0.0f);
            material.clearcoat_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                clearcoat_texture);
            material.clearcoat_roughness_texture =
                texture_data(
                    buffer,
                    container,
                    views,
                    images,
                    textures,
                    samplers,
                    clearcoat_roughness_texture);
            material.clearcoat_normal_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                clearcoat_normal_texture);
            material.clearcoat_normal_scale =
                clearcoat_normal_texture
                    ? float_or(
                          clearcoat_normal_texture
                              ->as_object(),
                          "scale",
                          1.0f)
                    : 1.0f;
            require_matching_texture_transform(
                material,
                clearcoat_texture);
            require_matching_texture_transform(
                material,
                clearcoat_roughness_texture);
            require_matching_texture_transform(
                material,
                clearcoat_normal_texture);
        }
        if (const ts::JsonValue* sheen_value =
                optional(extensions, "KHR_materials_sheen")) {
            const JsonObject& sheen =
                sheen_value->as_object();
            const ts::JsonValue* sheen_color_texture =
                optional(sheen, "sheenColorTexture");
            const ts::JsonValue* sheen_roughness_texture =
                optional(sheen, "sheenRoughnessTexture");
            const std::vector<float> sheen_color =
                float_array(
                    optional(sheen, "sheenColorFactor"));
            material.sheen_color = sheen_color.size() == 3
                ? Color3{
                      sheen_color[0],
                      sheen_color[1],
                      sheen_color[2],
                  }
                : Color3{0.0f, 0.0f, 0.0f};
            material.sheen_roughness = float_or(
                sheen,
                "sheenRoughnessFactor",
                0.0f);
            material.sheen_intensity = 1.0f;
            material.sheen_color_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                sheen_color_texture);
            const bool same_as_color =
                sheen_roughness_texture &&
                sheen_color_texture &&
                unsigned_value(
                    required(
                        sheen_roughness_texture->as_object(),
                        "index")) ==
                    unsigned_value(
                        required(
                            sheen_color_texture->as_object(),
                            "index")) &&
                texture_transform_value(
                    sheen_roughness_texture) ==
                    texture_transform_value(
                        sheen_color_texture);
            if (sheen_roughness_texture && !same_as_color) {
                material.sheen_roughness_texture =
                    texture_data(
                        buffer,
                        container,
                        views,
                        images,
                        textures,
                        samplers,
                        sheen_roughness_texture);
            } else if (
                !material.sheen_color_texture.bytes.empty()) {
                material.sheen_roughness_texture =
                    material.sheen_color_texture;
            }
            require_matching_texture_transform(
                material,
                sheen_color_texture);
            require_matching_texture_transform(
                material,
                sheen_roughness_texture);
        }
        if (const ts::JsonValue* iridescence_value =
                optional(
                    extensions,
                    "KHR_materials_iridescence")) {
            const JsonObject& iridescence =
                iridescence_value->as_object();
            const ts::JsonValue* iridescence_texture =
                optional(
                    iridescence,
                    "iridescenceTexture");
            const ts::JsonValue*
                iridescence_thickness_texture = optional(
                    iridescence,
                    "iridescenceThicknessTexture");
            material.iridescence_intensity = float_or(
                iridescence,
                "iridescenceFactor",
                0.0f);
            material.iridescence_index_of_refraction =
                float_or(iridescence, "iridescenceIor", 1.3f);
            material.iridescence_minimum_thickness = float_or(
                iridescence,
                "iridescenceThicknessMinimum",
                100.0f);
            material.iridescence_maximum_thickness = float_or(
                iridescence,
                "iridescenceThicknessMaximum",
                400.0f);
            material.iridescence_texture = texture_data(
                buffer,
                container,
                views,
                images,
                textures,
                samplers,
                iridescence_texture);
            material.iridescence_thickness_texture =
                texture_data(
                    buffer,
                    container,
                    views,
                    images,
                    textures,
                    samplers,
                    iridescence_thickness_texture);
            require_matching_texture_transform(
                material,
                iridescence_texture);
            require_matching_texture_transform(
                material,
                iridescence_thickness_texture);
        }
    }
    material.emissive_texture = texture_data(
        buffer, container, views, images, textures, samplers, optional(material_json, "emissiveTexture"));
    require_matching_texture_transform(
        material,
        optional(material_json, "emissiveTexture"));
    require_matching_texture_transform(
        material,
        optional(material_json, "occlusionTexture"));
    const std::vector<float> emissive = float_array(optional(material_json, "emissiveFactor"));
    if (emissive.size() == 3) material.emissive_factor = Color3{emissive[0], emissive[1], emissive[2]};
    if (const ts::JsonValue* extensions_value =
            optional(material_json, "extensions")) {
        const JsonObject& extensions =
            extensions_value->as_object();
        if (const ts::JsonValue* strength_value =
                optional(
                    extensions,
                    "KHR_materials_emissive_strength")) {
            const float strength = float_or(
                strength_value->as_object(),
                "emissiveStrength",
                1.0f);
            material.emissive_factor.r *= strength;
            material.emissive_factor.g *= strength;
            material.emissive_factor.b *= strength;
        }
    }
    material.double_sided = bool_or(material_json, "doubleSided", false);
    const std::string alpha_mode = string_or(material_json, "alphaMode", "OPAQUE");
    material.alpha_mode =
        alpha_mode == "BLEND"
            ? MaterialAlphaMode::blend
            : alpha_mode == "MASK"
                ? MaterialAlphaMode::mask
                : MaterialAlphaMode::opaque;
    material.alpha_cutoff = float_or(material_json, "alphaCutoff", 0.5f);
    engine.materials.push_back(std::move(material));
    return MaterialHandle{static_cast<std::uint32_t>(engine.materials.size() - 1)};
}

} // namespace

AssetHandle load_gltf(Engine& engine, const std::string& path) {
    ts::ArrayBuffer buffer = ts::await(pal::fetch_array_buffer(path));
    const upstream::ParsedGlbContainer container = upstream::parse_glb_container(buffer);
    const JsonObject& document = container.json.as_object();
    const JsonArray& view_json = array_or_empty(document, "bufferViews");
    const JsonArray& accessor_json = array_or_empty(document, "accessors");
    const JsonArray& image_json = array_or_empty(document, "images");
    const JsonArray& texture_json = array_or_empty(document, "textures");
    const JsonArray& sampler_json = array_or_empty(document, "samplers");
    const JsonArray& material_json = array_or_empty(document, "materials");
    const JsonArray& mesh_json = array_or_empty(document, "meshes");
    const JsonArray& node_json = array_or_empty(document, "nodes");
    const JsonArray& skin_json = array_or_empty(document, "skins");
    const JsonArray& animation_json =
        array_or_empty(document, "animations");
    const bool animated = !animation_json.empty();

    std::vector<BufferViewInfo> views;
    views.reserve(view_json.size());
    for (const ts::JsonValue& value : view_json) {
        const JsonObject& object = value.as_object();
        const std::size_t offset =
            unsigned_or(object, "byteOffset", 0);
        const std::size_t length =
            unsigned_value(required(object, "byteLength"));
        if (
            offset > container.bin_length ||
            length > container.bin_length - offset) {
            throw std::runtime_error(
                "glTF bufferView exceeds the BIN chunk.");
        }
        views.push_back(BufferViewInfo{
            offset,
            length,
            unsigned_or(object, "byteStride", 0),
        });
    }
    std::vector<AccessorInfo> accessors;
    accessors.reserve(accessor_json.size());
    for (const ts::JsonValue& value : accessor_json) {
        const JsonObject& object = value.as_object();
        if (optional(object, "sparse")) {
            throw std::runtime_error(
                "Sparse glTF accessors are not supported.");
        }
        const std::size_t buffer_view =
            unsigned_value(required(object, "bufferView"));
        if (buffer_view >= views.size()) {
            throw std::runtime_error(
                "glTF accessor references an invalid bufferView.");
        }
        accessors.push_back(AccessorInfo{
            buffer_view,
            unsigned_or(object, "byteOffset", 0),
            unsigned_value(required(object, "count")),
            static_cast<std::uint32_t>(unsigned_value(required(object, "componentType"))),
            required(object, "type").as_string(),
            bool_or(object, "normalized", false),
        });
    }
    std::vector<MaterialHandle> materials;
    materials.reserve(material_json.size());
    for (const ts::JsonValue& value : material_json) {
        materials.push_back(load_material(
            engine, value.as_object(), buffer, container, views, image_json, texture_json, sampler_json));
    }

    std::vector<int> parents(node_json.size(), -1);
    for (std::size_t index = 0; index < node_json.size(); ++index) {
        for (const ts::JsonValue& child : array_or_empty(node_json[index].as_object(), "children")) {
            const std::size_t child_index = unsigned_value(child);
            if (child_index >= parents.size()) {
                throw std::runtime_error(
                    "glTF node references an invalid child.");
            }
            if (parents[child_index] >= 0) {
                throw std::runtime_error(
                    "glTF node has multiple parents.");
            }
            parents[child_index] = static_cast<int>(index);
        }
    }
    std::vector<Matrix> world(node_json.size());
    std::vector<bool> computed(node_json.size(), false);
    std::vector<bool> computing(node_json.size(), false);
    std::function<const Matrix&(std::size_t)> compute_world = [&](std::size_t index) -> const Matrix& {
        if (computed[index]) return world[index];
        if (computing[index]) {
            throw std::runtime_error(
                "glTF node hierarchy contains a cycle.");
        }
        computing[index] = true;
        const Matrix local = local_matrix(node_json[index].as_object());
        world[index] = parents[index] >= 0
            ? multiply_matrix(compute_world(static_cast<std::size_t>(parents[index])), local)
            : local;
        computing[index] = false;
        computed[index] = true;
        return world[index];
    };

    AssetRecord asset;
    EnvironmentState image_based_environment;
    if (load_image_based_environment(
            image_based_environment,
            document,
            buffer,
            container,
            views,
            image_json)) {
        asset.scene_setup =
            [image_based_environment](Scene& scene) {
            scene.environment =
                image_based_environment;
        };
    }
    if (const ts::JsonValue* extensions_value =
            optional(document, "extensions")) {
        const JsonObject& extensions =
            extensions_value->as_object();
        if (const ts::JsonValue* lights_value =
                optional(
                    extensions,
                    "KHR_lights_punctual")) {
            const JsonArray& light_definitions =
                array_or_empty(
                    lights_value->as_object(),
                    "lights");
            for (
                std::size_t node_index = 0;
                node_index < node_json.size();
                ++node_index) {
                const JsonObject& node =
                    node_json[node_index].as_object();
                const ts::JsonValue*
                    node_extensions_value =
                        optional(node, "extensions");
                if (!node_extensions_value) continue;
                const ts::JsonValue* light_value =
                    optional(
                        node_extensions_value
                            ->as_object(),
                        "KHR_lights_punctual");
                if (!light_value) continue;
                const std::size_t light_index =
                    unsigned_value(
                        required(
                            light_value->as_object(),
                            "light"));
                if (
                    light_index >=
                    light_definitions.size()) {
                    continue;
                }
                const JsonObject& definition =
                    light_definitions[light_index]
                        .as_object();
                const std::string type =
                    string_or(definition, "type");
                if (
                    type != "point" &&
                    type != "directional") {
                    continue;
                }
                const Matrix& light_world =
                    compute_world(node_index);
                LightRecord light;
                light.kind = type == "point"
                    ? LightKind::point
                    : LightKind::directional;
                light.position = Vec3{
                    -light_world[12],
                    light_world[13],
                    light_world[14],
                };
                const Vec3 forward{
                    light_world[8],
                    -light_world[9],
                    -light_world[10],
                };
                light.direction =
                    normalize(forward);
                const std::vector<float> color =
                    float_array(
                        optional(
                            definition,
                            "color"));
                light.diffuse_color = color.size() == 3
                    ? Color3{
                          color[0],
                          color[1],
                          color[2],
                      }
                    : Color3{1.0f, 1.0f, 1.0f};
                light.specular_color =
                    light.diffuse_color;
                light.intensity =
                    float_or(
                        definition,
                        "intensity",
                        1.0f);
                light.range =
                    float_or(
                        definition,
                        "range",
                        std::numeric_limits<float>::max());
                engine.lights.push_back(light);
                asset.lights.push_back(
                    LightHandle{
                        static_cast<std::uint32_t>(
                            engine.lights.size() - 1)});
            }
        }
    }
    const auto animation_runtime =
        std::make_shared<AnimationRuntime>();
    animation_runtime->node_meshes.resize(node_json.size());
    animation_runtime->nodes.resize(node_json.size());
    for (std::size_t index = 0; index < node_json.size(); ++index) {
        const JsonObject& node = node_json[index].as_object();
        AnimatedNode& animated_node =
            animation_runtime->nodes[index];
        animated_node.parent = parents[index];
        const std::vector<float> translation =
            float_array(optional(node, "translation"));
        if (translation.size() == 3) {
            animated_node.translation = Vec3{
                translation[0],
                translation[1],
                translation[2],
            };
        }
        const std::vector<float> rotation =
            float_array(optional(node, "rotation"));
        if (rotation.size() == 4) {
            animated_node.rotation = Vec4{
                rotation[0],
                rotation[1],
                rotation[2],
                rotation[3],
            };
        }
        const std::vector<float> scale =
            float_array(optional(node, "scale"));
        if (scale.size() == 3) {
            animated_node.scale = Vec3{
                scale[0],
                scale[1],
                scale[2],
            };
        }
        animated_node.weights =
            float_array(optional(node, "weights"));
        if (
            animated_node.weights.empty() &&
            optional(node, "mesh")) {
            animated_node.weights = float_array(
                optional(
                    mesh_json.at(
                        unsigned_value(
                            *optional(node, "mesh")))
                        .as_object(),
                    "weights"));
        }
    }
    for (const ts::JsonValue& skin_value : skin_json) {
        const JsonObject& skin = skin_value.as_object();
        SkinRuntime runtime_skin;
        for (const ts::JsonValue& joint :
             array_or_empty(skin, "joints")) {
            runtime_skin.joints.push_back(
                unsigned_value(joint));
        }
        const ts::JsonValue* inverse_bind_value =
            optional(skin, "inverseBindMatrices");
        if (inverse_bind_value) {
            const AccessorInfo& inverse_bind =
                accessors.at(unsigned_value(*inverse_bind_value));
            if (
                inverse_bind.type != "MAT4" ||
                inverse_bind.count !=
                    runtime_skin.joints.size()) {
                throw std::runtime_error(
                    "glTF inverse bind matrix layout is invalid.");
            }
            for (
                std::size_t matrix_index = 0;
                matrix_index < inverse_bind.count;
                ++matrix_index) {
                Matrix matrix{};
                for (std::size_t component = 0; component < 16; ++component) {
                    matrix[component] = read_component(
                        buffer,
                        container,
                        views,
                        inverse_bind,
                        matrix_index,
                        component);
                }
                runtime_skin
                    .inverse_bind_matrices
                    .push_back(matrix);
            }
        } else {
            runtime_skin.inverse_bind_matrices.assign(
                runtime_skin.joints.size(),
                identity_matrix());
        }
        animation_runtime->skins.push_back(
            std::move(runtime_skin));
    }
    for (std::size_t node_index = 0; node_index < node_json.size(); ++node_index) {
        const JsonObject& node = node_json[node_index].as_object();
        const ts::JsonValue* mesh_value = optional(node, "mesh");
        if (!mesh_value) continue;
        const JsonObject& mesh = mesh_json.at(unsigned_value(*mesh_value)).as_object();
        for (const ts::JsonValue& primitive_value : array_or_empty(mesh, "primitives")) {
            const JsonObject& primitive = primitive_value.as_object();
            if (unsigned_or(primitive, "mode", 4) != 4) {
                throw std::runtime_error("Only triangle-list glTF primitives are supported.");
            }
            const JsonObject& attributes = required(primitive, "attributes").as_object();
            const AccessorInfo& positions = accessors.at(unsigned_value(required(attributes, "POSITION")));
            const AccessorInfo* normals = optional(attributes, "NORMAL")
                ? &accessors.at(unsigned_value(*optional(attributes, "NORMAL")))
                : nullptr;
            const AccessorInfo* tangents = optional(attributes, "TANGENT")
                ? &accessors.at(unsigned_value(*optional(attributes, "TANGENT")))
                : nullptr;
            const AccessorInfo* texcoords = optional(attributes, "TEXCOORD_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "TEXCOORD_0")))
                : nullptr;
            const AccessorInfo* texcoords1 = optional(attributes, "TEXCOORD_1")
                ? &accessors.at(unsigned_value(*optional(attributes, "TEXCOORD_1")))
                : nullptr;
            const AccessorInfo* colors = optional(attributes, "COLOR_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "COLOR_0")))
                : nullptr;
            const AccessorInfo* joints = optional(attributes, "JOINTS_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "JOINTS_0")))
                : nullptr;
            const AccessorInfo* weights = optional(attributes, "WEIGHTS_0")
                ? &accessors.at(unsigned_value(*optional(attributes, "WEIGHTS_0")))
                : nullptr;
            std::vector<const AccessorInfo*> morph_positions;
            std::vector<const AccessorInfo*> morph_normals;
            std::vector<const AccessorInfo*> morph_tangents;
            for (const ts::JsonValue& target_value :
                 array_or_empty(primitive, "targets")) {
                const JsonObject& target =
                    target_value.as_object();
                morph_positions.push_back(
                    optional(target, "POSITION")
                        ? &accessors.at(
                              unsigned_value(
                                  *optional(target, "POSITION")))
                        : nullptr);
                morph_normals.push_back(
                    optional(target, "NORMAL")
                        ? &accessors.at(
                              unsigned_value(
                                  *optional(target, "NORMAL")))
                        : nullptr);
                morph_tangents.push_back(
                    optional(target, "TANGENT")
                        ? &accessors.at(
                              unsigned_value(
                                  *optional(target, "TANGENT")))
                        : nullptr);
            }
            Matrix instance_parent_matrix =
                identity_matrix();
            std::vector<Matrix> instance_matrices;
            if (const ts::JsonValue* extensions_value =
                    optional(node, "extensions")) {
                const ts::JsonValue* instancing_value =
                    optional(
                        extensions_value->as_object(),
                        "EXT_mesh_gpu_instancing");
                if (instancing_value) {
                    if (animated || !morph_positions.empty()) {
                        throw std::runtime_error(
                            "Animated or morphed GPU instances are not supported.");
                    }
                    const JsonObject& instance_attributes =
                        required(
                            instancing_value->as_object(),
                            "attributes")
                            .as_object();
                    const auto accessor =
                        [&](const char* name)
                        -> const AccessorInfo* {
                        const ts::JsonValue* value =
                            optional(
                                instance_attributes,
                                name);
                        return value
                            ? &accessors.at(
                                  unsigned_value(*value))
                            : nullptr;
                    };
                    const AccessorInfo* translations =
                        accessor("TRANSLATION");
                    const AccessorInfo* rotations =
                        accessor("ROTATION");
                    const AccessorInfo* scales =
                        accessor("SCALE");
                    std::size_t instance_count = 0;
                    for (const AccessorInfo* value :
                         {translations, rotations, scales}) {
                        if (!value) continue;
                        if (
                            instance_count != 0 &&
                            value->count != instance_count) {
                            throw std::runtime_error(
                                "GPU instance accessor counts differ.");
                        }
                        instance_count = value->count;
                    }
                    const Matrix& node_world =
                        compute_world(node_index);
                    instance_parent_matrix =
                        native_matrix(node_world);
                    for (
                        std::size_t instance = 0;
                        instance < instance_count;
                        ++instance) {
                        const Vec3 translation = translations
                            ? Vec3{
                                  read_component(
                                      buffer, container, views,
                                      *translations, instance, 0),
                                  read_component(
                                      buffer, container, views,
                                      *translations, instance, 1),
                                  read_component(
                                      buffer, container, views,
                                      *translations, instance, 2),
                              }
                            : Vec3{};
                        const Vec4 rotation = rotations
                            ? Vec4{
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 0),
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 1),
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 2),
                                  read_component(
                                      buffer, container, views,
                                      *rotations, instance, 3),
                              }
                            : Vec4{0.0f, 0.0f, 0.0f, 1.0f};
                        const Vec3 scale = scales
                            ? Vec3{
                                  read_component(
                                      buffer, container, views,
                                      *scales, instance, 0),
                                  read_component(
                                      buffer, container, views,
                                      *scales, instance, 1),
                                  read_component(
                                      buffer, container, views,
                                      *scales, instance, 2),
                              }
                            : Vec3{1.0f, 1.0f, 1.0f};
                        instance_matrices.push_back(
                            native_matrix(
                                trs_matrix(
                                    translation,
                                    rotation,
                                    scale)));
                    }
                }
            }
            ModelGeometry geometry;
            geometry.vertices.resize(positions.count);
            geometry.bounds_min = Vec3{
                std::numeric_limits<float>::max(),
                std::numeric_limits<float>::max(),
                std::numeric_limits<float>::max(),
            };
            geometry.bounds_max = Vec3{
                std::numeric_limits<float>::lowest(),
                std::numeric_limits<float>::lowest(),
                std::numeric_limits<float>::lowest(),
            };
            const bool instanced =
                !instance_matrices.empty();
            const Matrix matrix = instanced
                ? identity_matrix()
                : compute_world(node_index);
            const float determinant = linear_determinant(matrix);
            const std::size_t material_index =
                unsigned_or(primitive, "material", 0);
            const bool clockwise_front_face =
                determinant < 0.0f &&
                material_index < materials.size() &&
                materials[material_index].value <
                    engine.materials.size() &&
                engine.materials[
                    materials[material_index].value]
                    .double_sided;
            for (std::size_t index = 0; index < positions.count; ++index) {
                ModelVertex vertex;
                const Vec3 local_position{
                    read_component(buffer, container, views, positions, index, 0),
                    read_component(buffer, container, views, positions, index, 1),
                    read_component(buffer, container, views, positions, index, 2),
                };
                vertex.local_position = local_position;
                vertex.position = animated || instanced
                    ? Vec3{
                          -local_position.x,
                          local_position.y,
                          local_position.z,
                      }
                    : transform_point(matrix, local_position);
                if (normals) {
                    const Vec3 local_normal{
                        read_component(buffer, container, views, *normals, index, 0),
                        read_component(buffer, container, views, *normals, index, 1),
                        read_component(buffer, container, views, *normals, index, 2),
                    };
                    vertex.normal = animated || instanced
                        ? normalize(Vec3{
                              -local_normal.x,
                              local_normal.y,
                              local_normal.z,
                          })
                        : transform_direction(matrix, local_normal);
                }
                if (tangents) {
                    const Vec3 local_tangent{
                        read_component(buffer, container, views, *tangents, index, 0),
                        read_component(buffer, container, views, *tangents, index, 1),
                        read_component(buffer, container, views, *tangents, index, 2),
                    };
                    const Vec3 tangent = animated || instanced
                        ? normalize(Vec3{
                              -local_tangent.x,
                              local_tangent.y,
                              local_tangent.z,
                          })
                        : transform_direction(matrix, local_tangent);
                    vertex.tangent = Vec4{
                        tangent.x,
                        tangent.y,
                        tangent.z,
                        (determinant < 0.0f ? 1.0f : -1.0f) *
                            read_component(buffer, container, views, *tangents, index, 3),
                    };
                }
                if (texcoords) {
                    vertex.uv = Vec2{
                        read_component(buffer, container, views, *texcoords, index, 0),
                        read_component(buffer, container, views, *texcoords, index, 1),
                    };
                }
                if (texcoords1) {
                    vertex.uv2 = Vec2{
                        read_component(buffer, container, views, *texcoords1, index, 0),
                        read_component(buffer, container, views, *texcoords1, index, 1),
                    };
                }
                if (colors) {
                    vertex.color = Vec4{
                        read_component(buffer, container, views, *colors, index, 0),
                        read_component(buffer, container, views, *colors, index, 1),
                        read_component(buffer, container, views, *colors, index, 2),
                        colors->type == "VEC4"
                            ? read_component(buffer, container, views, *colors, index, 3)
                            : 1.0f,
                    };
                }
                if (joints && weights) {
                    for (std::size_t component = 0; component < 4; ++component) {
                        vertex.joints[component] =
                            static_cast<std::uint16_t>(
                                read_component(
                                    buffer,
                                    container,
                                    views,
                                    *joints,
                                    index,
                                    component));
                    }
                    vertex.weights = Vec4{
                        read_component(buffer, container, views, *weights, index, 0),
                        read_component(buffer, container, views, *weights, index, 1),
                        read_component(buffer, container, views, *weights, index, 2),
                        read_component(buffer, container, views, *weights, index, 3),
                    };
                }
                geometry.bounds_min.x = std::min(geometry.bounds_min.x, vertex.position.x);
                geometry.bounds_min.y = std::min(geometry.bounds_min.y, vertex.position.y);
                geometry.bounds_min.z = std::min(geometry.bounds_min.z, vertex.position.z);
                geometry.bounds_max.x = std::max(geometry.bounds_max.x, vertex.position.x);
                geometry.bounds_max.y = std::max(geometry.bounds_max.y, vertex.position.y);
                geometry.bounds_max.z = std::max(geometry.bounds_max.z, vertex.position.z);
                geometry.vertices[index] = vertex;
            }
            for (std::size_t target = 0; target < morph_positions.size(); ++target) {
                std::vector<Vec3> position_deltas(
                    positions.count,
                    Vec3{});
                std::vector<Vec3> normal_deltas(
                    positions.count,
                    Vec3{});
                std::vector<Vec3> tangent_deltas(
                    positions.count,
                    Vec3{});
                for (std::size_t index = 0; index < positions.count; ++index) {
                    if (morph_positions[target]) {
                        position_deltas[index] = Vec3{
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_positions[target],
                                index,
                                0),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_positions[target],
                                index,
                                1),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_positions[target],
                                index,
                                2),
                        };
                    }
                    if (morph_normals[target]) {
                        normal_deltas[index] = Vec3{
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_normals[target],
                                index,
                                0),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_normals[target],
                                index,
                                1),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_normals[target],
                                index,
                                2),
                        };
                    }
                    if (morph_tangents[target]) {
                        tangent_deltas[index] = Vec3{
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_tangents[target],
                                index,
                                0),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_tangents[target],
                                index,
                                1),
                            read_component(
                                buffer,
                                container,
                                views,
                                *morph_tangents[target],
                                index,
                                2),
                        };
                    }
                }
                geometry.morph_positions.push_back(
                    std::move(position_deltas));
                geometry.morph_normals.push_back(
                    std::move(normal_deltas));
                geometry.morph_tangents.push_back(
                    std::move(tangent_deltas));
            }
            if (const ts::JsonValue* indices_value = optional(primitive, "indices")) {
                const AccessorInfo& indices = accessors.at(unsigned_value(*indices_value));
                geometry.indices.resize(indices.count);
                for (std::size_t index = 0; index < indices.count; ++index) {
                    geometry.indices[index] = read_index(buffer, container, views, indices, index);
                }
            } else {
                geometry.indices.resize(geometry.vertices.size());
                for (std::size_t index = 0; index < geometry.indices.size(); ++index) {
                    geometry.indices[index] = static_cast<std::uint32_t>(index);
                }
            }
            if (geometry.indices.size() % 3 != 0) {
                throw std::runtime_error("Triangle-list glTF indices must be divisible by three.");
            }
            for (const std::uint32_t index : geometry.indices) {
                if (index >= geometry.vertices.size()) {
                    throw std::runtime_error(
                        "glTF primitive index exceeds its vertex count.");
                }
            }
            if (
                determinant < 0.0f &&
                !clockwise_front_face) {
                for (std::size_t index = 0; index < geometry.indices.size(); index += 3) {
                    std::swap(geometry.indices[index + 1], geometry.indices[index + 2]);
                }
            }
            if (!normals) {
                geometry.flat_normals = true;
                std::vector<ModelVertex> flat_vertices;
                flat_vertices.reserve(geometry.indices.size());
                std::vector<std::vector<Vec3>> flat_morph_positions(
                    geometry.morph_positions.size());
                std::vector<std::vector<Vec3>> flat_morph_normals(
                    geometry.morph_normals.size());
                std::vector<std::vector<Vec3>> flat_morph_tangents(
                    geometry.morph_tangents.size());
                for (const std::uint32_t index : geometry.indices) {
                    flat_vertices.push_back(
                        geometry.vertices.at(index));
                    for (std::size_t target = 0; target < flat_morph_positions.size(); ++target) {
                        flat_morph_positions[target].push_back(
                            geometry.morph_positions[target].at(index));
                        flat_morph_normals[target].push_back(
                            geometry.morph_normals[target].at(index));
                        flat_morph_tangents[target].push_back(
                            geometry.morph_tangents[target].at(index));
                    }
                }
                geometry.vertices = std::move(flat_vertices);
                geometry.morph_positions =
                    std::move(flat_morph_positions);
                geometry.morph_normals =
                    std::move(flat_morph_normals);
                geometry.morph_tangents =
                    std::move(flat_morph_tangents);
                geometry.indices.resize(geometry.vertices.size());
                for (
                    std::size_t index = 0;
                    index < geometry.indices.size();
                    ++index) {
                    geometry.indices[index] =
                        static_cast<std::uint32_t>(index);
                }
                for (
                    std::size_t index = 0;
                    index < geometry.vertices.size();
                    index += 3) {
                    ModelVertex& a = geometry.vertices[index];
                    ModelVertex& b = geometry.vertices[index + 1];
                    ModelVertex& c = geometry.vertices[index + 2];
                    const Vec3 edge1{
                        b.position.x - a.position.x,
                        b.position.y - a.position.y,
                        b.position.z - a.position.z,
                    };
                    const Vec3 edge2{
                        c.position.x - a.position.x,
                        c.position.y - a.position.y,
                        c.position.z - a.position.z,
                    };
                    const Vec3 face{
                        edge2.y * edge1.z - edge2.z * edge1.y,
                        edge2.z * edge1.x - edge2.x * edge1.z,
                        edge2.x * edge1.y - edge2.y * edge1.x,
                    };
                    const Vec3 normal = normalize(face);
                    a.normal = normal;
                    b.normal = normal;
                    c.normal = normal;
                }
            }
            geometry.has_tangents = tangents != nullptr;
            if (animated) {
                geometry.bind_vertices = geometry.vertices;
            }
            if (instanced) {
                geometry.bounds_min = Vec3{
                    std::numeric_limits<float>::max(),
                    std::numeric_limits<float>::max(),
                    std::numeric_limits<float>::max(),
                };
                geometry.bounds_max = Vec3{
                    std::numeric_limits<float>::lowest(),
                    std::numeric_limits<float>::lowest(),
                    std::numeric_limits<float>::lowest(),
                };
                for (const Matrix& instance :
                     instance_matrices) {
                    const Matrix world_instance =
                        multiply_matrix(
                            instance_parent_matrix,
                            instance);
                    for (const ModelVertex& vertex :
                         geometry.vertices) {
                        const Vec3 position =
                            transform_point_raw(
                                world_instance,
                                vertex.position);
                        geometry.bounds_min.x = std::min(
                            geometry.bounds_min.x,
                            position.x);
                        geometry.bounds_min.y = std::min(
                            geometry.bounds_min.y,
                            position.y);
                        geometry.bounds_min.z = std::min(
                            geometry.bounds_min.z,
                            position.z);
                        geometry.bounds_max.x = std::max(
                            geometry.bounds_max.x,
                            position.x);
                        geometry.bounds_max.y = std::max(
                            geometry.bounds_max.y,
                            position.y);
                        geometry.bounds_max.z = std::max(
                            geometry.bounds_max.z,
                            position.z);
                    }
                }
            }
            engine.geometries.push_back(std::move(geometry));
            MeshRecord record;
            record.primitive = PrimitiveKind::gltf;
            record.geometry = static_cast<std::uint32_t>(engine.geometries.size() - 1);
            record.baked_world_scale = std::max({
                std::sqrt(
                    matrix[0] * matrix[0] +
                    matrix[1] * matrix[1] +
                    matrix[2] * matrix[2]),
                std::sqrt(
                    matrix[4] * matrix[4] +
                    matrix[5] * matrix[5] +
                    matrix[6] * matrix[6]),
                std::sqrt(
                    matrix[8] * matrix[8] +
                    matrix[9] * matrix[9] +
                    matrix[10] * matrix[10]),
            });
            if (material_index < materials.size()) record.material = materials[material_index];
            record.clockwise_front_face =
                clockwise_front_face;
            record.instance_parent_matrix =
                instance_parent_matrix;
            record.instance_matrices =
                std::move(instance_matrices);
            engine.meshes.push_back(std::move(record));
            const std::uint32_t mesh_record_index =
                static_cast<std::uint32_t>(engine.meshes.size() - 1);
            if (animated) {
                const std::size_t skin_index =
                    optional(node, "skin")
                        ? unsigned_value(*optional(node, "skin"))
                        : std::numeric_limits<std::size_t>::max();
                const bool gpu_deformation =
#if BBLITE_GPU_MORPH_STORAGE
                    // Storage-buffer morphing lifts the two-slot
                    // vertex-attribute morph-target cap.
                    (
#else
                    geometry.morph_positions.size() <= 2 &&
                    (
#endif
                        skin_index ==
                            std::numeric_limits<std::size_t>::max() ||
                        animation_runtime
                                ->skins.at(skin_index)
                                .joints.size() <= 64);
                engine.meshes[mesh_record_index]
                    .gpu_deformation = gpu_deformation;
                animation_runtime
                    ->node_meshes[node_index]
                    .push_back(mesh_record_index);
                animation_runtime->meshes.push_back(
                    AnimatedMeshBinding{
                        mesh_record_index,
                        record.geometry,
                        node_index,
                        skin_index,
                    });
            }
            asset.meshes.push_back(MeshHandle{mesh_record_index});
        }
    }
    if (animated) {
        for (const ts::JsonValue& animation_value : animation_json) {
            const JsonObject& animation =
                animation_value.as_object();
            const JsonArray& animation_samplers =
                array_or_empty(animation, "samplers");
            for (const ts::JsonValue& channel_value :
                 array_or_empty(animation, "channels")) {
                const JsonObject& channel =
                    channel_value.as_object();
                const JsonObject& target =
                    required(channel, "target").as_object();
                const std::string path_name =
                    required(target, "path").as_string();
                if (
                    path_name != "rotation" &&
                    path_name != "translation" &&
                    path_name != "scale" &&
                    path_name != "weights") {
                    throw std::runtime_error(
                        "Reached glTF animation lowering currently supports rotation, translation, scale, and weights channels.");
                }
                const std::size_t sampler_index =
                    unsigned_value(required(channel, "sampler"));
                const JsonObject& sampler =
                    animation_samplers.at(sampler_index).as_object();
                const std::string interpolation =
                    string_or(sampler, "interpolation", "LINEAR");
                if (
                    interpolation != "LINEAR" &&
                    interpolation != "CUBICSPLINE") {
                    throw std::runtime_error(
                        "Reached glTF animation lowering supports LINEAR and CUBICSPLINE interpolation.");
                }
                const AccessorInfo& input =
                    accessors.at(unsigned_value(required(sampler, "input")));
                const AccessorInfo& output =
                    accessors.at(unsigned_value(required(sampler, "output")));
                const std::size_t target_node =
                    unsigned_value(required(target, "node"));
                if (input.type != "SCALAR") {
                    throw std::runtime_error(
                        "glTF animation input accessor must be SCALAR.");
                }
                for (std::size_t index = 0; index < input.count; ++index) {
                    const float time = read_component(
                        buffer,
                        container,
                        views,
                        input,
                        index,
                        0);
                    animation_runtime->duration =
                        std::max(
                            animation_runtime->duration,
                            time);
                }
                if (path_name == "rotation") {
                    const bool cubic =
                        interpolation == "CUBICSPLINE";
                    if (
                        output.type != "VEC4" ||
                        output.count !=
                            input.count * (cubic ? 3u : 1u)) {
                        throw std::runtime_error(
                            "glTF rotation animation accessor layout is invalid.");
                    }
                    RotationTrack track;
                    track.node = target_node;
                    track.cubic = cubic;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            read_component(
                                buffer,
                                container,
                                views,
                                input,
                                index,
                                0));
                        const std::size_t value_index =
                            cubic ? index * 3 + 1 : index;
                        const auto read_quaternion =
                            [&](std::size_t output_index) {
                            return Vec4{
                                read_component(buffer, container, views, output, output_index, 0),
                                read_component(buffer, container, views, output, output_index, 1),
                                read_component(buffer, container, views, output, output_index, 2),
                                read_component(buffer, container, views, output, output_index, 3),
                            };
                        };
                        track.values.push_back(
                            read_quaternion(value_index));
                        if (cubic) {
                            track.in_tangents.push_back(
                                read_quaternion(index * 3));
                            track.out_tangents.push_back(
                                read_quaternion(index * 3 + 2));
                        }
                    }
                    animation_runtime
                        ->rotation_tracks
                        .push_back(std::move(track));
                } else if (
                    path_name == "translation" ||
                    path_name == "scale") {
                    const bool cubic =
                        interpolation == "CUBICSPLINE";
                    if (
                        output.type != "VEC3" ||
                        output.count !=
                            input.count * (cubic ? 3u : 1u)) {
                        throw std::runtime_error(
                            "glTF translation or scale animation accessor layout is invalid.");
                    }
                    TranslationTrack track;
                    track.node = target_node;
                    track.cubic = cubic;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            read_component(buffer, container, views, input, index, 0));
                        const std::size_t value_index =
                            cubic ? index * 3 + 1 : index;
                        const auto read_translation =
                            [&](std::size_t output_index) {
                            return Vec3{
                                read_component(buffer, container, views, output, output_index, 0),
                                read_component(buffer, container, views, output, output_index, 1),
                                read_component(buffer, container, views, output, output_index, 2),
                            };
                        };
                        track.values.push_back(
                            read_translation(value_index));
                        if (cubic) {
                            track.in_tangents.push_back(
                                read_translation(index * 3));
                            track.out_tangents.push_back(
                                read_translation(index * 3 + 2));
                        }
                    }
                    if (path_name == "translation") {
                        animation_runtime
                            ->translation_tracks
                            .push_back(std::move(track));
                    } else {
                        animation_runtime
                            ->scale_tracks
                            .push_back(std::move(track));
                    }
                } else {
                    if (interpolation != "LINEAR") {
                        throw std::runtime_error(
                            "glTF weights animation currently requires LINEAR interpolation.");
                    }
                    if (
                        output.type != "SCALAR" ||
                        input.count == 0 ||
                        output.count % input.count != 0) {
                        throw std::runtime_error(
                            "glTF weights animation accessor layout is invalid.");
                    }
                    WeightTrack track;
                    track.node = target_node;
                    track.target_count =
                        output.count / input.count;
                    for (std::size_t index = 0; index < input.count; ++index) {
                        track.times.push_back(
                            read_component(
                                buffer,
                                container,
                                views,
                                input,
                                index,
                                0));
                        for (std::size_t target_index = 0; target_index < track.target_count; ++target_index) {
                            track.values.push_back(
                                read_component(
                                    buffer,
                                    container,
                                    views,
                                    output,
                                    index * track.target_count + target_index,
                                    0));
                        }
                    }
                    animation_runtime
                        ->weight_tracks
                        .push_back(std::move(track));
                }
            }
        }
        const auto apply_animation_time =
            [animation_runtime, &engine](float time) {
            animation_runtime->time =
                animation_runtime->duration > 0.0f
                    ? std::fmod(
                          std::max(time, 0.0f),
                          animation_runtime->duration)
                    : 0.0f;
            for (const RotationTrack& track :
                 animation_runtime->rotation_tracks) {
                if (
                    track.times.empty() ||
                    track.node >=
                        animation_runtime->node_meshes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        animation_runtime->time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const float span =
                    track.times[right] - track.times[left];
                const float amount =
                    span > 0.0f
                        ? std::clamp(
                              (animation_runtime->time -
                               track.times[left]) /
                                  span,
                              0.0f,
                              1.0f)
                        : 0.0f;
                animation_runtime->nodes[track.node].rotation =
                    track.cubic
                        ? cubic_quaternion(
                              track.values[left],
                              track.out_tangents[left],
                              track.values[right],
                              track.in_tangents[right],
                              amount,
                              span)
                        : interpolate_quaternion(
                              track.values[left],
                              track.values[right],
                              amount);
            }
            for (const TranslationTrack& track :
                 animation_runtime->translation_tracks) {
                if (
                    track.times.empty() ||
                    track.node >= animation_runtime->nodes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        animation_runtime->time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const float span =
                    track.times[right] - track.times[left];
                const float amount =
                    span > 0.0f
                        ? std::clamp(
                              (animation_runtime->time -
                               track.times[left]) /
                                  span,
                              0.0f,
                              1.0f)
                        : 0.0f;
                const Vec3 left_value = track.values[left];
                const Vec3 right_value = track.values[right];
                animation_runtime->nodes[track.node].translation =
                    track.cubic
                        ? cubic_vec3(
                              left_value,
                              track.out_tangents[left],
                              right_value,
                              track.in_tangents[right],
                              amount,
                              span)
                        : Vec3{
                              left_value.x +
                                  (right_value.x - left_value.x) *
                                      amount,
                              left_value.y +
                                  (right_value.y - left_value.y) *
                                      amount,
                              left_value.z +
                                  (right_value.z - left_value.z) *
                                      amount,
                          };
            }
            for (const TranslationTrack& track :
                 animation_runtime->scale_tracks) {
                if (
                    track.times.empty() ||
                    track.node >= animation_runtime->nodes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        animation_runtime->time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const float span =
                    track.times[right] - track.times[left];
                const float amount =
                    span > 0.0f
                        ? std::clamp(
                              (animation_runtime->time -
                               track.times[left]) /
                                  span,
                              0.0f,
                              1.0f)
                        : 0.0f;
                const Vec3 left_value = track.values[left];
                const Vec3 right_value = track.values[right];
                animation_runtime->nodes[track.node].scale =
                    track.cubic
                        ? cubic_vec3(
                              left_value,
                              track.out_tangents[left],
                              right_value,
                              track.in_tangents[right],
                              amount,
                              span)
                        : Vec3{
                              left_value.x +
                                  (right_value.x - left_value.x) *
                                      amount,
                              left_value.y +
                                  (right_value.y - left_value.y) *
                                      amount,
                              left_value.z +
                                  (right_value.z - left_value.z) *
                                      amount,
                          };
            }
            for (
                auto track_iterator =
                    animation_runtime
                        ->weight_tracks.rbegin();
                track_iterator !=
                    animation_runtime
                        ->weight_tracks.rend();
                ++track_iterator) {
                const WeightTrack& track =
                    *track_iterator;
                if (
                    track.times.empty() ||
                    track.node >= animation_runtime->nodes.size()) {
                    continue;
                }
                std::size_t right = 1;
                while (
                    right < track.times.size() &&
                    track.times[right] <
                        animation_runtime->time) {
                    ++right;
                }
                if (right >= track.times.size()) {
                    right = track.times.size() - 1;
                }
                const std::size_t left =
                    right > 0 ? right - 1 : 0;
                const float span =
                    track.times[right] - track.times[left];
                const float amount =
                    span > 0.0f
                        ? std::clamp(
                              (animation_runtime->time -
                               track.times[left]) /
                                  span,
                              0.0f,
                              1.0f)
                        : 0.0f;
                AnimatedNode& node =
                    animation_runtime->nodes[track.node];
                node.weights.resize(track.target_count);
                for (std::size_t target = 0; target < track.target_count; ++target) {
                    const float left_value =
                        track.values[left * track.target_count + target];
                    const float right_value =
                        track.values[right * track.target_count + target];
                    node.weights[target] =
                        left_value +
                        (right_value - left_value) * amount;
                }
            }
            for (AnimatedNode& node : animation_runtime->nodes) {
                node.computed = false;
                node.computing = false;
            }
            std::function<const Matrix&(std::size_t)> compute_animated_world =
                [&](std::size_t node_index) -> const Matrix& {
                AnimatedNode& node =
                    animation_runtime->nodes.at(node_index);
                if (node.computed) return node.world;
                if (node.computing) {
                    throw std::runtime_error(
                        "glTF animated node hierarchy contains a cycle.");
                }
                node.computing = true;
                const Matrix local = trs_matrix(
                    node.translation,
                    node.rotation,
                    node.scale);
                node.world = node.parent >= 0
                    ? multiply_matrix(
                          compute_animated_world(
                              static_cast<std::size_t>(
                                  node.parent)),
                          local)
                    : local;
                node.computing = false;
                node.computed = true;
                return node.world;
            };
            for (const AnimatedMeshBinding& binding :
                 animation_runtime->meshes) {
                ModelGeometry& geometry =
                    engine.geometries.at(binding.geometry);
                if (
                    geometry.bind_vertices.size() !=
                    geometry.vertices.size()) {
                    continue;
                }
                const Matrix& mesh_world =
                    compute_animated_world(binding.node);
                const bool skinned =
                    binding.skin <
                    animation_runtime->skins.size();
                const SkinRuntime* skin = skinned
                    ? &animation_runtime->skins[binding.skin]
                    : nullptr;
                std::vector<Matrix> joint_matrices;
                if (skin) {
                    joint_matrices.reserve(skin->joints.size());
                    for (std::size_t joint = 0; joint < skin->joints.size(); ++joint) {
                        joint_matrices.push_back(
                            multiply_matrix(
                                compute_animated_world(
                                    skin->joints[joint]),
                                skin->inverse_bind_matrices[joint]));
                    }
                }
                MeshRecord& mesh_record =
                    engine.meshes.at(binding.mesh);
                mesh_record.bone_matrices.clear();
                if (skin) {
                    for (const Matrix& joint_matrix : joint_matrices) {
                        mesh_record.bone_matrices.push_back(
                            native_matrix(joint_matrix));
                    }
                } else {
                    mesh_record.bone_matrices.push_back(
                        native_matrix(mesh_world));
                }
                mesh_record.morph_weights = {};
                const std::vector<float>& node_weights =
                    animation_runtime
                        ->nodes[binding.node]
                        .weights;
                for (
                    std::size_t target = 0;
                    target < node_weights.size() &&
                    target < mesh_record.morph_weights.size();
                    ++target) {
                    mesh_record.morph_weights[target] =
                        node_weights[target];
                }
#if BBLITE_GPU_MORPH_STORAGE
                if (
                    mesh_record.morph_storage_weights !=
                    node_weights) {
                    mesh_record.morph_storage_weights =
                        node_weights;
                    ++mesh_record.morph_weights_version;
                }
#endif
                if (
                    mesh_record.gpu_deformation &&
                    !geometry.flat_normals) {
                    ++mesh_record.transform_version;
                    continue;
                }
                for (
                    std::size_t vertex_index = 0;
                    vertex_index < geometry.vertices.size();
                    ++vertex_index) {
                    const ModelVertex& bind =
                        geometry.bind_vertices[vertex_index];
                    Vec3 morphed_position =
                        bind.local_position;
                    Vec3 morphed_normal{
                        -bind.normal.x,
                        bind.normal.y,
                        bind.normal.z,
                    };
                    Vec3 morphed_tangent{
                        -bind.tangent.x,
                        bind.tangent.y,
                        bind.tangent.z,
                    };
                    const std::vector<float>& morph_weights =
                        animation_runtime
                            ->nodes[binding.node]
                            .weights;
                    for (
                        std::size_t target = 0;
                        target < morph_weights.size() &&
                        target < geometry.morph_positions.size();
                        ++target) {
                        const float weight = morph_weights[target];
                        const Vec3 position_delta =
                            geometry.morph_positions[target][vertex_index];
                        const Vec3 normal_delta =
                            geometry.morph_normals[target][vertex_index];
                        const Vec3 tangent_delta =
                            geometry.morph_tangents[target][vertex_index];
                        morphed_position.x +=
                            position_delta.x * weight;
                        morphed_position.y +=
                            position_delta.y * weight;
                        morphed_position.z +=
                            position_delta.z * weight;
                        morphed_normal.x +=
                            normal_delta.x * weight;
                        morphed_normal.y +=
                            normal_delta.y * weight;
                        morphed_normal.z +=
                            normal_delta.z * weight;
                        morphed_tangent.x +=
                            tangent_delta.x * weight;
                        morphed_tangent.y +=
                            tangent_delta.y * weight;
                        morphed_tangent.z +=
                            tangent_delta.z * weight;
                    }
                    Vec3 position{};
                    Vec3 normal{};
                    Vec3 tangent{};
                    if (skin) {
                        const std::array<float, 4> weights{
                            bind.weights.x,
                            bind.weights.y,
                            bind.weights.z,
                            bind.weights.w,
                        };
                        for (std::size_t influence = 0; influence < 4; ++influence) {
                            const float weight = weights[influence];
                            const std::size_t joint = bind.joints[influence];
                            if (
                                weight <= 0.0f ||
                                joint >= joint_matrices.size()) {
                                continue;
                            }
                            const Vec3 joint_position =
                                transform_point_raw(
                                    joint_matrices[joint],
                                    morphed_position);
                            const Vec3 joint_normal =
                                transform_direction_raw(
                                    joint_matrices[joint],
                                    morphed_normal);
                            const Vec3 joint_tangent =
                                transform_direction_raw(
                                    joint_matrices[joint],
                                    morphed_tangent);
                            position.x += joint_position.x * weight;
                            position.y += joint_position.y * weight;
                            position.z += joint_position.z * weight;
                            normal.x += joint_normal.x * weight;
                            normal.y += joint_normal.y * weight;
                            normal.z += joint_normal.z * weight;
                            tangent.x += joint_tangent.x * weight;
                            tangent.y += joint_tangent.y * weight;
                            tangent.z += joint_tangent.z * weight;
                        }
                    } else {
                        position = transform_point_raw(
                            mesh_world,
                            morphed_position);
                        normal = transform_direction_raw(
                            mesh_world,
                            morphed_normal);
                        tangent = transform_direction_raw(
                            mesh_world,
                            morphed_tangent);
                    }
                    ModelVertex& vertex =
                        geometry.vertices[vertex_index];
                    vertex.position = Vec3{
                        -position.x,
                        position.y,
                        position.z,
                    };
                    vertex.normal = normalize(Vec3{
                        -normal.x,
                        normal.y,
                        normal.z,
                    });
                    const Vec3 native_tangent = normalize(Vec3{
                        -tangent.x,
                        tangent.y,
                        tangent.z,
                    });
                    vertex.tangent = Vec4{
                        native_tangent.x,
                        native_tangent.y,
                        native_tangent.z,
                        bind.tangent.w,
                    };
                }
                if (geometry.flat_normals) {
                    for (
                        std::size_t index = 0;
                        index < geometry.vertices.size();
                        index += 3) {
                        ModelVertex& a = geometry.vertices[index];
                        ModelVertex& b = geometry.vertices[index + 1];
                        ModelVertex& c = geometry.vertices[index + 2];
                        const Vec3 edge1{
                            b.position.x - a.position.x,
                            b.position.y - a.position.y,
                            b.position.z - a.position.z,
                        };
                        const Vec3 edge2{
                            c.position.x - a.position.x,
                            c.position.y - a.position.y,
                            c.position.z - a.position.z,
                        };
                        const Vec3 face = normalize(Vec3{
                            edge2.y * edge1.z - edge2.z * edge1.y,
                            edge2.z * edge1.x - edge2.x * edge1.z,
                            edge2.x * edge1.y - edge2.y * edge1.x,
                        });
                        a.normal = face;
                        b.normal = face;
                        c.normal = face;
                    }
                }
                ++mesh_record.transform_version;
            }
        };
        apply_animation_time(0.0f);
        asset.animation_seek =
            [animation_runtime, apply_animation_time](float time) {
            animation_runtime->paused = true;
            apply_animation_time(time);
        };
        asset.animation_tick =
            [animation_runtime, apply_animation_time](float delta_ms) {
            if (animation_runtime->paused) return;
            apply_animation_time(
                animation_runtime->time +
                    delta_ms * 0.001f);
        };
    }
    if (asset.meshes.empty()) throw std::runtime_error("glTF contains no renderable meshes.");
    engine.assets.push_back(std::move(asset));
    return AssetHandle{static_cast<std::uint32_t>(engine.assets.size() - 1)};
}

} // namespace bbl
`;
}
