#pragma once

// The checks: each drives the lowered splat-stream library's GPU functions
// (the generated upstream_splat_stream.hpp: splat-stream-gpu.ts and
// splat-stream-material.ts) on the device under test, compares the result
// with a CPU evaluation of the pinned WGSL and prints one line the test
// compares across backends.

#include "fixture-require.hpp"
#include "pal_webgpu_usage.hpp"

#include <bblite/upstream_splat_stream.hpp>

#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace stream_check {

using bbl::GpuHandle;
namespace js = bbl::js;
namespace BU = bbl::pal::webgpu_buffer_usage;
namespace TU = bbl::pal::webgpu_texture_usage;

using webgpu_fixture::require;

/** The stream's GPU budget: room for every check's canonical and pass state. */
constexpr double MAX_GPU_BYTES = 64.0 * 1024 * 1024;
/** One canonical or projected record: 16 floats (splat-stream-gpu.ts RECORD_BYTES). */
constexpr std::size_t RECORD_FLOATS = 16;

/** Retirements the library queued behind the GPU (gpu-resource-retirement.ts). */
inline std::vector<bbl::pal::GpuRetirement>& retirements() {
    static std::vector<bbl::pal::GpuRetirement> queue;
    return queue;
}
/** Runs the queued retirements once a check has waited for the work they follow. */
inline void run_retirements() {
    while (!retirements().empty()) {
        auto queue = std::move(retirements());
        retirements().clear();
        for (auto& retirement : queue)
            retirement();
    }
}

/** The engine the library reads `_device` and `_currentEncoder` from. */
struct Library {
    bbl::Engine engine;
    explicit Library(std::shared_ptr<bbl::GpuDevice> device) {
        engine.webgpu_device = std::move(device);
    }
    bbl::GpuDevice& device() { return *engine.webgpu_device; }
    bbl::StoredEngine stored() { return bbl::StoredEngine(engine); }
};

inline GpuHandle buffer(bbl::GpuDevice& device, double size, double usage, bool mapped = false) {
    bbl::GpuBufferDescriptor descriptor;
    descriptor.size = size;
    descriptor.usage = usage;
    descriptor.mapped_at_creation = mapped;
    return device.create_buffer(descriptor);
}

/** Copies a range into a MAP_READ buffer, maps it on the realm and returns its bytes. */
inline js::Promise<js::ArrayBuffer> read_back(bbl::GpuDevice& device, GpuHandle source,
                                              double offset, double size) {
    const auto readback = buffer(device, size, BU::copy_dst | BU::map_read);
    const auto encoder = device.create_command_encoder();
    encoder->copy_buffer_to_buffer(source, offset, readback, 0, size);
    device.submit(js::Array<GpuHandle>{encoder->finish()});
    auto& mapping = bbl::gpu_buffer_mapping(readback);
    require(mapping.map_state() == "unmapped", "readback starts unmapped");
    auto mapped = mapping.map_async(bbl::gpu_map_mode_read, {}, {});
    require(mapping.map_state() == "pending", "mapAsync is pending until the realm settles it");
    co_await mapped;
    require(mapping.map_state() == "mapped", "mapAsync settles mapped");
    const auto range = mapping.get_mapped_range({}, {});
    std::vector<std::uint8_t> bytes(range.data(), range.data() + range.byte_length());
    mapping.unmap();
    require(mapping.map_state() == "unmapped", "unmap");
    readback->destroy();
    co_return js::ArrayBuffer(std::move(bytes));
}

template <class T> std::vector<T> values_of(const js::ArrayBuffer& bytes) {
    std::vector<T> result(bytes.byte_length() / sizeof(T));
    std::memcpy(result.data(), bytes.data(), result.size() * sizeof(T));
    return result;
}

/** A deterministic sequence, so both backends see the same inputs. */
struct Random {
    std::uint32_t state;
    std::uint32_t next() {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        return state;
    }
    float unit() { return static_cast<float>(next() >> 8) / 16777216.0f; }
};

/** A line of hexadecimal words the test compares across backends. */
inline std::string hex_words(const std::vector<std::uint32_t>& words) {
    std::string text;
    char digits[10];
    for (const auto word : words) {
        std::snprintf(digits, sizeof(digits), "%08x", word);
        text += digits;
    }
    return text;
}

/** Float agreement with a CPU evaluation: GPU transcendental functions round differently. */
struct Tolerance {
    double worst = 0;
    void check(float gpu, float cpu, const std::string& what) {
        if (std::isnan(cpu)) {
            require(std::isnan(gpu), what + " is NaN on the CPU only");
            return;
        }
        const double error = std::abs(static_cast<double>(gpu) - cpu);
        const double scale = std::max(std::abs(static_cast<double>(cpu)), 1.0);
        worst = std::max(worst, error / scale);
        require(error <= 1e-5 * scale,
                what + ": GPU " + std::to_string(gpu) + " CPU " + std::to_string(cpu));
    }
};

inline std::uint64_t fnv(const void* data, std::size_t size) {
    std::uint64_t hash = 1469598103934665603ull;
    const auto* bytes = static_cast<const std::uint8_t*>(data);
    for (std::size_t i = 0; i < size; ++i)
        hash = (hash ^ bytes[i]) * 1099511628211ull;
    return hash;
}

inline void check_limits(bbl::GpuDevice& device, const bbl::GpuSupportedLimits& expected) {
    const auto limits = device.limits();
    require(limits.max_buffer_size == expected.max_buffer_size, "maxBufferSize");
    require(limits.max_storage_buffer_binding_size == expected.max_storage_buffer_binding_size,
            "maxStorageBufferBindingSize");
    require(limits.max_compute_workgroups_per_dimension ==
                expected.max_compute_workgroups_per_dimension,
            "maxComputeWorkgroupsPerDimension");
    std::printf("limits %.0f %.0f %.0f\n", limits.max_buffer_size,
                limits.max_storage_buffer_binding_size,
                limits.max_compute_workgroups_per_dimension);
}

/** Buffer mapping states and refusals, as WebGPU defines them. */
inline js::Promise<js::PromiseVoid> check_mapping(bbl::GpuDevice& device) {
    const auto refuses = [](auto call, const char* what) {
        bool refused = false;
        try {
            call();
        } catch (const std::runtime_error&) {
            refused = true;
        }
        require(refused, what);
    };
    const auto created = buffer(device, 32, BU::copy_src, true);
    auto& mapping = bbl::gpu_buffer_mapping(created);
    require(mapping.map_state() == "mapped", "mappedAtCreation is mapped");
    const auto first = mapping.get_mapped_range(0.0, 16.0);
    refuses([&] { (void)mapping.get_mapped_range(8.0, 8.0); }, "overlapping ranges refuse");
    refuses([&] { (void)mapping.get_mapped_range(20.0, 8.0); }, "misaligned offsets refuse");
    const auto second = mapping.get_mapped_range(16.0, 16.0);
    js::TypedArray<std::uint32_t>(first).store(0, 0x11223344u);
    js::TypedArray<std::uint32_t>(second).store(3, 0x55667788u);
    mapping.unmap();
    require(mapping.map_state() == "unmapped", "unmapped after unmap");
    refuses([&] { (void)mapping.get_mapped_range({}, {}); }, "an unmapped buffer has no range");
    const auto words = values_of<std::uint32_t>(co_await read_back(device, created, 0, 32));
    require(words[0] == 0x11223344u && words[7] == 0x55667788u && words[1] == 0,
            "written ranges reach the buffer at unmap");
    // Bytes no returned range covered keep WebGPU's zero initialization.
    const auto partial = buffer(device, 32, BU::copy_src, true);
    js::TypedArray<std::uint32_t>(bbl::gpu_buffer_mapping(partial).get_mapped_range(8.0, 8.0))
        .store(1, 0xabcdef01u);
    bbl::gpu_buffer_mapping(partial).unmap();
    const auto partial_words = values_of<std::uint32_t>(co_await read_back(device, partial, 0, 32));
    require((partial_words == std::vector<std::uint32_t>{0, 0, 0, 0xabcdef01u, 0, 0, 0, 0}),
            "an unreturned mapped range stays zero");
    const auto plain = buffer(device, 16, BU::copy_dst | BU::storage);
    bool rejected = false;
    try {
        co_await bbl::gpu_buffer_mapping(plain).map_async(bbl::gpu_map_mode_read, {}, {});
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    require(rejected, "mapAsync without MAP_READ rejects");
    refuses([&] { device.write_buffer(created, 0, js::ArrayBuffer(std::vector<std::uint8_t>(4))); },
            "writeBuffer without COPY_DST refuses");
    // unmap() aborts a pending mapping.
    const auto pending = buffer(device, 16, BU::copy_dst | BU::map_read);
    auto aborted = bbl::gpu_buffer_mapping(pending).map_async(bbl::gpu_map_mode_read, {}, {});
    bbl::gpu_buffer_mapping(pending).unmap();
    require(bbl::gpu_buffer_mapping(pending).map_state() == "unmapped", "abort unmaps");
    rejected = false;
    try {
        co_await aborted;
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    require(rejected, "an aborted mapping rejects");
    std::printf("mapping ok\n");
    co_return js::PromiseVoid{};
}

// ── CPU evaluations of the pinned WGSL ───────────────────────────────────

struct V3 {
    float x, y, z;
};
struct V4 {
    float x, y, z, w;
};
inline bool finite(std::initializer_list<float> values) {
    for (const float value : values)
        if (!(value == value) || !(std::abs(value) <= 3.402823e38f))
            return false;
    return true;
}
/** Column-major mat4 * vec4, as WGSL multiplies. */
inline V4 mul(const std::array<float, 16>& m, V4 v) {
    return {m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12] * v.w,
            m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13] * v.w,
            m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14] * v.w,
            m[3] * v.x + m[7] * v.y + m[11] * v.z + m[15] * v.w};
}
using M3 = std::array<std::array<float, 3>, 3>; // [column][row]
inline M3 mul(const M3& a, const M3& b) {
    M3 r{};
    for (int c = 0; c < 3; ++c)
        for (int row = 0; row < 3; ++row)
            r[c][row] = a[0][row] * b[c][0] + a[1][row] * b[c][1] + a[2][row] * b[c][2];
    return r;
}
inline V3 mul(const M3& m, V3 v) {
    return {m[0][0] * v.x + m[1][0] * v.y + m[2][0] * v.z,
            m[0][1] * v.x + m[1][1] * v.y + m[2][1] * v.z,
            m[0][2] * v.x + m[1][2] * v.y + m[2][2] * v.z};
}
inline float dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

/** One canonical record (splat-stream-project.wgsl `L`, splat-stream-gather.wgsl `R`). */
struct Canonical {
    V4 centerOpacity, covarianceA, covarianceB, color;
};
/** A pending projection's inputs (splat-stream-gpu.ts PendingProjection). */
struct Projection {
    double count = 0;
    std::array<float, 16> worldView{}, projection{};
    double width = 0, height = 0, near = 0;
};
struct Projected {
    bool valid = false;
    V4 clipCenter{}, axis0{}, axis1{}, color{};
    float viewZ = 0;
};
/** splat-stream-project.wgsl `main`, evaluated on the CPU. */
inline Projected project_cpu(const Canonical& c, const Projection& params) {
    Projected out;
    if (!(c.centerOpacity.w > 0.0f) ||
        !finite({c.centerOpacity.x, c.centerOpacity.y, c.centerOpacity.z, c.centerOpacity.w,
                 c.covarianceA.x, c.covarianceA.y, c.covarianceA.z, c.covarianceA.w,
                 c.covarianceB.x, c.covarianceB.y, c.covarianceB.z, c.covarianceB.w, c.color.x,
                 c.color.y, c.color.z, c.color.w}))
        return out;
    const V4 g =
        mul(params.worldView, {c.centerOpacity.x, c.centerOpacity.y, c.centerOpacity.z, 1});
    const V4 a = mul(params.projection, g);
    const float near = static_cast<float>(params.near);
    if (!(g.z > near) || a.w == 0.0f || !finite({g.x, g.y, g.z, g.w}) ||
        !finite({a.x, a.y, a.z, a.w}))
        return out;
    const float i = 1.2f * a.w;
    if (a.x < -i || a.x > i || a.y < -i || a.y > i)
        return out;
    const M3 F{{{c.covarianceA.x, c.covarianceA.y, c.covarianceA.z},
                {c.covarianceA.y, c.covarianceA.w, c.covarianceB.x},
                {c.covarianceA.z, c.covarianceB.x, c.covarianceB.y}}};
    const auto& wv = params.worldView;
    const M3 v{{{wv[0], wv[1], wv[2]}, {wv[4], wv[5], wv[6]}, {wv[8], wv[9], wv[10]}}};
    M3 vt{};
    for (int col = 0; col < 3; ++col)
        for (int row = 0; row < 3; ++row)
            vt[col][row] = v[row][col];
    const M3 q = mul(mul(v, F), vt);
    const float t = 1.0f / (a.w * a.w);
    const auto& P = params.projection;
    const V3 K{P[0], P[4], P[8]}, I{P[1], P[5], P[9]}, w{P[3], P[7], P[11]};
    const float width = static_cast<float>(params.width),
                height = static_cast<float>(params.height);
    const auto scale = [&](V3 axis, float clip, float half) {
        return V3{(axis.x * a.w - w.x * clip) * t * half, (axis.y * a.w - w.y * clip) * t * half,
                  (axis.z * a.w - w.z * clip) * t * half};
    };
    const V3 m = scale(K, a.x, width * 0.5f), y = scale(I, a.y, height * 0.5f);
    const V3 E = mul(q, m), r = mul(q, y);
    const V3 b{dot(m, E) + 0.3f, dot(m, r), dot(y, r) + 0.3f};
    if (!finite({b.x, b.y, b.z}))
        return out;
    const float z = b.x + b.z;
    const float x = std::sqrt(std::max(0.0f, (b.x - b.z) * (b.x - b.z) + 4.0f * b.y * b.y));
    const float l = std::max(0.1f, (z + x) * 0.5f), H = std::max(0.1f, (z - x) * 0.5f);
    float fx, fy;
    if (std::abs(b.y) + std::abs(l - b.x) > 1e-6f) {
        const float length = std::sqrt(b.y * b.y + (l - b.x) * (l - b.x));
        fx = b.y / length;
        fy = (l - b.x) / length;
    } else {
        fx = b.x >= b.z ? 1.0f : 0.0f;
        fy = b.x >= b.z ? 0.0f : 1.0f;
    }
    const float jx = -fy, jy = fx;
    const float ul = std::min(std::sqrt(2.0f * l), 1024.0f),
                sl = std::min(std::sqrt(2.0f * H), 1024.0f);
    const float nx = fx * ul / width * a.w, ny = fy * ul / height * a.w;
    const float ox = jx * sl / width * a.w, oy = jy * sl / height * a.w;
    if (!finite({nx, ny, ox, oy}))
        return out;
    const float hx = 2.0f * (std::abs(nx) + std::abs(ox)),
                hy = 2.0f * (std::abs(ny) + std::abs(oy));
    if (a.x + hx < -a.w || a.x - hx > a.w || a.y + hy < -a.w || a.y - hy > a.w)
        return out;
    out.valid = true;
    out.clipCenter = a;
    out.axis0 = {nx, ny, 0, 0};
    out.axis1 = {ox, oy, 0, 0};
    out.color = {c.color.x, c.color.y, c.color.z, c.centerOpacity.w};
    out.viewZ = g.z;
    return out;
}

/** An rgba8 byte as the shader's round(textureLoad(...) * 255.0) reads it. */
inline float byte_of(std::uint8_t value) { return static_cast<float>(value); }
inline float sog_log(float m) {
    return (m > 0 ? 1.0f : m < 0 ? -1.0f : 0.0f) * (std::exp(std::abs(m)) - 1.0f);
}
inline float mix(float a, float b, float t) { return a * (1.0f - t) + b * t; }

/** splat-stream-gather.wgsl `main`, evaluated on the CPU. */
inline Canonical gather_cpu(const std::array<std::vector<std::uint8_t>, 5>& images,
                            const std::vector<float>& codebooks, std::size_t texel,
                            const std::array<float, 3>& meansMin,
                            const std::array<float, 3>& meansMax) {
    const auto load = [&](int image, int lane) { return images[image][texel * 4 + lane]; };
    float w[3];
    for (int lane = 0; lane < 3; ++lane)
        w[lane] = static_cast<float>(static_cast<std::uint32_t>(load(0, lane)) +
                                     static_cast<std::uint32_t>(load(1, lane)) * 256u) /
                  65535.0f;
    const V3 v{sog_log(mix(meansMin[0], meansMax[0], w[0])),
               sog_log(mix(meansMin[1], meansMax[1], w[1])),
               sog_log(mix(meansMin[2], meansMax[2], w[2]))};
    const V3 m{std::exp(codebooks[load(2, 0)]), std::exp(codebooks[load(2, 1)]),
               std::exp(codebooks[load(2, 2)])};
    const float root2 = std::sqrt(2.0f);
    const V3 b{(byte_of(load(3, 0)) / 255.0f - 0.5f) * root2,
               (byte_of(load(3, 1)) / 255.0f - 0.5f) * root2,
               (byte_of(load(3, 2)) / 255.0f - 0.5f) * root2};
    const float l = std::sqrt(std::max(0.0f, 1.0f - dot(b, b)));
    const int g = static_cast<int>(load(3, 3)) - 252;
    V4 i{0, 0, 0, 0};
    if (g == 0)
        i = {b.x, b.y, b.z, l};
    else if (g == 1)
        i = {l, b.y, b.z, b.x};
    else if (g == 2)
        i = {b.y, l, b.z, b.x};
    else if (g == 3)
        i = {b.y, b.z, l, b.x};
    const float E = i.x + i.x, q = i.y + i.y, k = i.z + i.z, L = i.x * E, N = i.x * q, K = i.x * k,
                J = i.y * q, I = i.y * k, z = i.z * k, C = i.w * E, B = i.w * q, P = i.w * k;
    const M3 t{{{1 - J - z, N + P, K - B}, {N - P, 1 - L - z, I + C}, {K + B, I - C, 1 - L - J}}};
    const V3 e{t[0][0] * (2 * m.x), t[0][1] * (2 * m.x), t[0][2] * (2 * m.x)};
    const V3 d{t[1][0] * (2 * m.y), t[1][1] * (2 * m.y), t[1][2] * (2 * m.y)};
    const V3 c{t[2][0] * (2 * m.z), t[2][1] * (2 * m.z), t[2][2] * (2 * m.z)};
    const float U = e.x * e.x + d.x * d.x + c.x * c.x, H = e.x * e.y + d.x * d.y + c.x * c.y,
                A = -(e.x * e.z + d.x * d.z + c.x * c.z), X = e.y * e.y + d.y * d.y + c.y * c.y,
                O = -(e.y * e.z + d.y * d.z + c.y * c.z), T = e.z * e.z + d.z * d.z + c.z * c.z;
    const float sh = 0.28209479177387814f;
    const V3 F{0.5f + sh * codebooks[256 + load(4, 0)], 0.5f + sh * codebooks[256 + load(4, 1)],
               0.5f + sh * codebooks[256 + load(4, 2)]};
    const bool fa = g >= 0 && g < 4 && finite({v.x, v.y, v.z}) && finite({m.x, m.y, m.z}) &&
                    finite({F.x, F.y, F.z}) && finite({U, H, A}) && finite({H, X, O}) &&
                    finite({A, O, T});
    const float da = fa ? byte_of(load(4, 3)) / 255.0f : 0.0f;
    return {{v.x, v.y, -v.z, da}, {U, H, A, X}, {O, T, 0, 0}, {F.x, F.y, F.z, 0}};
}

// ── Inputs ───────────────────────────────────────────────────────────────

/** The perspective every check projects with: 96x64, near 0.5, looking down +z. */
inline Projection perspective(double count, const std::array<float, 16>& worldView) {
    Projection projection;
    projection.count = count;
    projection.worldView = worldView;
    const float f = 1.0f / std::tan(0.4f), aspect = 1.5f, near = 0.5f, far = 200.0f;
    projection.projection = {f / aspect,
                             0,
                             0,
                             0,
                             0,
                             f,
                             0,
                             0,
                             0,
                             0,
                             far / (far - near),
                             1,
                             0,
                             0,
                             -near * far / (far - near),
                             0};
    projection.width = 96;
    projection.height = 64;
    projection.near = near;
    return projection;
}
/** A camera looking down +z (left-handed), with a rotated, translated world. */
inline Projection test_projection(double count) {
    const float angle = 0.3f, cosine = std::cos(angle), sine = std::sin(angle);
    return perspective(count,
                       {cosine, 0, -sine, 0, 0, 1, 0, 0, sine, 0, cosine, 0, 0.25f, -0.5f, 4, 1});
}
/** Splats spread in depth, with rejected ones: behind the near plane, outside, invisible, NaN. */
inline std::vector<Canonical> test_splats(std::size_t count, std::uint32_t seed) {
    Random random{seed};
    std::vector<Canonical> splats;
    for (std::size_t index = 0; index < count; ++index) {
        Canonical c{};
        const float depth = 1.5f + 0.73f * static_cast<float>(index);
        c.centerOpacity = {(random.unit() - 0.5f) * depth * 0.6f,
                           (random.unit() - 0.5f) * depth * 0.4f, depth,
                           0.2f + 0.8f * random.unit()};
        const float sx = 0.02f + 0.3f * random.unit(), sy = 0.02f + 0.3f * random.unit(),
                    sz = 0.02f + 0.3f * random.unit(), xy = 0.01f * (random.unit() - 0.5f);
        c.covarianceA = {sx, xy, 0.003f, sy};
        c.covarianceB = {-0.002f, sz, 0, 0};
        c.color = {random.unit(), random.unit(), random.unit(), 0};
        splats.push_back(c);
    }
    splats[1].centerOpacity.z = -6.0f;                                 // behind the camera
    splats[3].centerOpacity.x = 400.0f;                                // outside the frustum
    splats[5].centerOpacity.w = 0.0f;                                  // invisible
    splats[7].covarianceA.x = std::numeric_limits<float>::quiet_NaN(); // not finite
    return splats;
}
/**
 * Splats well inside the frustum of an unrotated camera, so validity is the
 * opacity alone and each view depth is the record's own z, bit for bit: half
 * take one of 97 depths, so the sort's stability decides their order.
 */
inline std::vector<Canonical> sort_splats(std::size_t count, std::uint32_t seed) {
    Random random{seed};
    std::vector<Canonical> splats;
    for (std::size_t index = 0; index < count; ++index) {
        Canonical c{};
        const float depth = (index & 1) ? 1.5f + 30.0f * random.unit()
                                        : 1.5f + 0.25f * static_cast<float>(random.next() % 97u);
        const float opacity = random.next() % 10u < 7u ? 0.2f + 0.8f * random.unit() : 0.0f;
        c.centerOpacity = {(random.unit() - 0.5f) * depth * 0.5f,
                           (random.unit() - 0.5f) * depth * 0.3f, depth, opacity};
        c.covarianceA = {0.01f, 0, 0, 0.01f};
        c.covarianceB = {0, 0.01f, 0, 0};
        c.color = {random.unit(), random.unit(), random.unit(), 0};
        splats.push_back(c);
    }
    return splats;
}

inline js::ArrayBuffer canonical_bytes(const std::vector<Canonical>& splats, double capacity) {
    std::vector<std::uint8_t> bytes(static_cast<std::size_t>(capacity) * sizeof(Canonical), 0);
    std::memcpy(bytes.data(), splats.data(), splats.size() * sizeof(Canonical));
    return js::ArrayBuffer(std::move(bytes));
}

inline js::TypedArray<float> floats(const float* values, std::size_t count) {
    return js::TypedArray<float>(std::vector<float>(values, values + count));
}

/** recordProjectionAndSort of `projection` into one submission, then its completion. */
inline js::Promise<js::PromiseVoid>
project_and_sort(Library& library, const std::shared_ptr<bbl::SplatStreamGpuState>& state,
                 const std::shared_ptr<bbl::SplatStreamPassGpu>& pass,
                 const Projection& projection) {
    auto pending = js::make_gc_shared<bbl::SplatStreamPendingProjection>();
    pending->count = projection.count;
    pending->key = "check";
    pending->world_view = floats(projection.worldView.data(), 16);
    pending->projection = floats(projection.projection.data(), 16);
    pending->width = projection.width;
    pending->height = projection.height;
    pending->near = projection.near;
    auto& device = library.device();
    const auto encoder = device.create_command_encoder({std::string("frame")});
    bbl::splat_stream_gpu_detail::record_projection_and_sort(state, pass, pending, encoder);
    device.submit(js::Array<GpuHandle>{encoder->finish()});
    co_await device.on_submitted_work_done();
    run_retirements();
    co_return js::PromiseVoid{};
}

/** setupMain's runtime words for `count` visible splats and `levelCount` radix levels. */
inline std::vector<std::uint32_t> expected_runtime(std::uint32_t count, std::uint32_t levelCount) {
    std::vector<std::uint32_t> runtime(32, 0);
    const auto c = [](std::uint32_t z) { return (z + 255u) / 256u; };
    const auto put = [&](std::uint32_t u, std::uint32_t x, std::uint32_t y) {
        const std::uint32_t m = 4u + u * 3u;
        runtime[m] = x;
        runtime[m + 1] = y;
        runtime[m + 2] = 1u;
    };
    runtime[0] = count;
    std::uint32_t f = c(count);
    put(0, f, 1);
    for (std::uint32_t o = 0; o < levelCount; ++o) {
        put(1 + o, std::max(1u, c(f)), 16);
        f = c(f);
    }
    std::uint32_t l = c(count);
    for (std::uint32_t k = 0; k + 1 < levelCount; ++k) {
        put(1 + levelCount + k, c(l), 16);
        l = c(l);
    }
    return runtime;
}

// ── Checks ───────────────────────────────────────────────────────────────

/** Projection, compaction, its draw and dispatch arguments, and the stable 8-pass radix sort. */
inline js::Promise<js::PromiseVoid> check_sort(Library& library, double capacity, double count,
                                               std::uint32_t seed) {
    auto& device = library.device();
    const auto splats = sort_splats(static_cast<std::size_t>(count), seed);
    const auto state =
        bbl::create_splat_stream_gpu_state(library.stored(), capacity, MAX_GPU_BYTES);
    device.write_buffer(state->canonical, 0, canonical_bytes(splats, capacity));
    const auto pass = bbl::create_splat_stream_pass_gpu(state);
    const auto projection = perspective(count, {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1});
    co_await project_and_sort(library, state, pass, projection);

    // Keys are ~bitcast<u32>(viewZ): ascending keys draw far splats first.
    std::vector<std::pair<std::uint32_t, std::uint32_t>> expected;
    for (std::uint32_t index = 0; index < static_cast<std::uint32_t>(count); ++index) {
        const auto cpu = project_cpu(splats[index], projection);
        require(cpu.valid == (splats[index].centerOpacity.w > 0.0f),
                "an inside splat is valid by its opacity");
        if (cpu.valid)
            expected.push_back({~std::bit_cast<std::uint32_t>(cpu.viewZ), index});
    }
    std::stable_sort(expected.begin(), expected.end(),
                     [](const auto& left, const auto& right) { return left.first < right.first; });
    const auto n = static_cast<std::uint32_t>(expected.size());
    const auto runtime =
        values_of<std::uint32_t>(co_await read_back(device, pass->runtime, 0, 128));
    const auto indirect =
        values_of<std::uint32_t>(co_await read_back(device, pass->indirect, 0, 16));
    const auto sorted =
        values_of<std::uint32_t>(co_await read_back(device, pass->sorted, 0, n * 8.0));
    require(indirect == std::vector<std::uint32_t>({6u, n, 0u, 0u}), "drawArgs (6, n, 0, 0)");
    const auto levelCount = static_cast<std::uint32_t>(pass->levels.size());
    const auto runtime_expected = expected_runtime(n, levelCount);
    const std::size_t used = 4 + 3 * (1 + 2 * levelCount - 1);
    for (std::size_t word = 0; word < used; ++word)
        require(runtime[word] == runtime_expected[word],
                "runtime word " + std::to_string(word) + " " + std::to_string(runtime[word]) +
                    " expected " + std::to_string(runtime_expected[word]));
    for (std::uint32_t index = 0; index < n; ++index)
        require(sorted[index * 2] == expected[index].first &&
                    sorted[index * 2 + 1] == expected[index].second,
                "sorted entry " + std::to_string(index));
    std::printf(
        "sort capacity=%.0f count=%.0f visible=%u levels=%u runtime=%s keys=%016llx\n", capacity,
        count, n, levelCount,
        hex_words(std::vector<std::uint32_t>(runtime.begin(), runtime.begin() + used)).c_str(),
        static_cast<unsigned long long>(fnv(sorted.data(), n * 8u)));
    bbl::retire_splat_stream_gpu_state(state);
    run_retirements();
    co_return js::PromiseVoid{};
}

/** Projection of known splats, then their compaction and depth sort. */
inline js::Promise<js::PromiseVoid> check_projection(Library& library) {
    constexpr double capacity = 300, count = 40;
    auto& device = library.device();
    const auto splats = test_splats(static_cast<std::size_t>(count), 0x5eed1234u);
    const auto state =
        bbl::create_splat_stream_gpu_state(library.stored(), capacity, MAX_GPU_BYTES);
    device.write_buffer(state->canonical, 0, canonical_bytes(splats, capacity));
    const auto pass = bbl::create_splat_stream_pass_gpu(state);
    const auto projection = test_projection(count);
    co_await project_and_sort(library, state, pass, projection);
    const auto projected =
        values_of<float>(co_await read_back(device, pass->projected, 0, count * RECORD_FLOATS * 4));
    const auto valid =
        values_of<std::uint32_t>(co_await read_back(device, pass->valid, 0, count * 4));
    const auto indirect =
        values_of<std::uint32_t>(co_await read_back(device, pass->indirect, 0, 16));
    const auto sorted =
        values_of<std::uint32_t>(co_await read_back(device, pass->sorted, 0, count * 8));
    Tolerance tolerance;
    std::vector<std::pair<float, std::uint32_t>> order;
    std::uint32_t visible = 0;
    for (std::size_t index = 0; index < static_cast<std::size_t>(count); ++index) {
        const auto cpu = project_cpu(splats[index], projection);
        require(valid[index] == (cpu.valid ? 1u : 0u),
                "validity of splat " + std::to_string(index));
        if (!cpu.valid)
            continue;
        ++visible;
        order.push_back({cpu.viewZ, static_cast<std::uint32_t>(index)});
        const float* gpu = projected.data() + index * RECORD_FLOATS;
        const V4 rows[] = {cpu.clipCenter, cpu.axis0, cpu.axis1, cpu.color};
        for (int row = 0; row < 4; ++row) {
            const float values[] = {rows[row].x, rows[row].y, rows[row].z, rows[row].w};
            for (int lane = 0; lane < 4; ++lane)
                tolerance.check(gpu[row * 4 + lane], values[lane],
                                "projected[" + std::to_string(index) + "][" +
                                    std::to_string(row * 4 + lane) + "]");
        }
    }
    require(visible == count - 4, "four splats are rejected");
    require(indirect == std::vector<std::uint32_t>({6u, visible, 0u, 0u}), "projection drawArgs");
    std::stable_sort(order.begin(), order.end(),
                     [](const auto& left, const auto& right) { return left.first > right.first; });
    std::vector<std::uint32_t> indices;
    for (std::uint32_t entry = 0; entry < visible; ++entry) {
        require(sorted[entry * 2 + 1] == order[entry].second,
                "depth order " + std::to_string(entry));
        tolerance.check(std::bit_cast<float>(~sorted[entry * 2]), order[entry].first, "sort key");
        indices.push_back(sorted[entry * 2 + 1]);
    }
    std::printf("projection visible=%u order=%s worst=%.3g\n", visible, hex_words(indices).c_str(),
                tolerance.worst);
    std::vector<std::uint32_t> bits(projected.size());
    std::memcpy(bits.data(), projected.data(), bits.size() * 4);
    std::printf("projected %s\n", hex_words(bits).c_str());
    bbl::retire_splat_stream_gpu_state(state);
    run_retirements();
    co_return js::PromiseVoid{};
}

/** A SOG source's images and codebooks, decoded (splat-stream-gather.wgsl's inputs). */
struct SogImages {
    static constexpr std::uint32_t width = 9, height = 7;
    std::array<std::vector<std::uint8_t>, 5> images;
    std::vector<float> codebooks = std::vector<float>(512);
    std::array<float, 3> meansMin{-2.5f, -1.0f, -3.0f}, meansMax{2.0f, 1.5f, 0.5f};
    double count = 60;
};
inline SogImages sog_images() {
    SogImages sog;
    Random random{0xa11ce5u};
    for (auto& image : sog.images) {
        image.resize(SogImages::width * SogImages::height * 4);
        for (auto& byte : image)
            byte = static_cast<std::uint8_t>(random.next());
    }
    // Quaternion modes 252..255 are valid; others leave the splat invisible.
    for (std::size_t texel = 0; texel < SogImages::width * SogImages::height; ++texel)
        sog.images[3][texel * 4 + 3] =
            static_cast<std::uint8_t>(texel % 9 == 4 ? 251 : 252 + texel % 4);
    for (std::size_t index = 0; index < 256; ++index) {
        sog.codebooks[index] = -6.0f + 5.0f * random.unit();
        sog.codebooks[256 + index] = -2.0f + 4.0f * random.unit();
    }
    return sog;
}

/**
 * The source the request manager prepares from decoded images
 * (splat-stream-requests.ts): five rgba8unorm textures filled by
 * copyExternalImageToTexture and the codebook buffer, made the stream's GPU
 * source by the library's makeGpuSource.
 */
inline std::shared_ptr<bbl::SplatStreamSourceGpu> upload_source(bbl::GpuDevice& device,
                                                                const SogImages& sog) {
    auto prepared = js::make_gc_shared<bbl::PreparedSplatSource>();
    prepared->url = "check.sog";
    prepared->width = SogImages::width;
    prepared->height = SogImages::height;
    prepared->count = sog.count;
    prepared->means_min = floats(sog.meansMin.data(), 3);
    prepared->means_max = floats(sog.meansMax.data(), 3);
    for (const auto& image : sog.images) {
        bbl::GpuTextureDescriptor descriptor;
        descriptor.size = {static_cast<double>(SogImages::width),
                           static_cast<double>(SogImages::height), 1};
        descriptor.format = "rgba8unorm";
        descriptor.usage = TU::texture_binding | TU::copy_dst | TU::render_attachment;
        const auto texture = device.create_texture(descriptor);
        bbl::pal::DecodedImage decoded;
        decoded.width = static_cast<int>(SogImages::width);
        decoded.height = static_cast<int>(SogImages::height);
        decoded.rgba = image;
        bbl::web_platform::CopyExternalImageSource source;
        source.source = bbl::pal::ImageBitmap(std::move(decoded), false);
        source.flip_y = false;
        bbl::web_platform::CopyExternalImageDestination destination;
        destination.texture = texture;
        destination.premultiplied_alpha = false;
        bbl::web_platform::copy_external_image_to_texture(
            device, source, destination,
            {static_cast<double>(SogImages::width), static_cast<double>(SogImages::height), 1});
        prepared->textures.push_back(texture);
    }
    prepared->metadata_buffer = buffer(device, 2048, BU::storage | BU::copy_dst);
    device.write_buffer(prepared->metadata_buffer, 0, js::TypedArray<float>(sog.codebooks));
    return bbl::load_gaussian_splat_stream_detail::make_gpu_source(prepared);
}

/** Three intervals of the source, with gaps in the canonical generation. */
inline js::Array<std::shared_ptr<bbl::SplatStreamGpuInterval>>
source_intervals(const std::shared_ptr<bbl::SplatStreamSourceGpu>& source) {
    js::Array<std::shared_ptr<bbl::SplatStreamGpuInterval>> intervals;
    for (const auto& [from, count, to] :
         {std::array<double, 3>{0, 12, 0}, std::array<double, 3>{15, 10, 20},
          std::array<double, 3>{40, 20, 34}}) {
        auto interval = js::make_gc_shared<bbl::SplatStreamGpuInterval>();
        interval->source = source;
        interval->source_offset = from;
        interval->count = count;
        interval->destination_offset = to;
        intervals.push_back(interval);
    }
    return intervals;
}

/** The library's gather of a source's intervals into the canonical generation. */
inline js::Promise<js::PromiseVoid>
check_gather(Library& library, const SogImages& sog,
             std::shared_ptr<bbl::SplatStreamSourceGpu> source) {
    constexpr double capacity = 64;
    auto& device = library.device();
    const auto state =
        bbl::create_splat_stream_gpu_state(library.stored(), capacity, MAX_GPU_BYTES);
    const auto intervals = source_intervals(source);
    bbl::set_splat_stream_gpu_intervals(state, intervals, 1);
    const auto encoder = device.create_command_encoder({std::string("frame")});
    require(bbl::splat_stream_gpu_detail::record_gather(state, encoder), "the gather records");
    device.submit(js::Array<GpuHandle>{encoder->finish()});
    co_await device.on_submitted_work_done();
    run_retirements();
    const auto records = values_of<float>(
        co_await read_back(device, state->canonical, 0, capacity * RECORD_FLOATS * 4));
    Tolerance tolerance;
    std::vector<bool> written(static_cast<std::size_t>(capacity), false);
    for (const auto& interval : intervals) {
        for (std::size_t offset = 0; offset < static_cast<std::size_t>(interval->count); ++offset) {
            const auto destination =
                static_cast<std::size_t>(interval->destination_offset) + offset;
            written[destination] = true;
            const auto cpu = gather_cpu(sog.images, sog.codebooks,
                                        static_cast<std::size_t>(interval->source_offset) + offset,
                                        sog.meansMin, sog.meansMax);
            const float* gpu = records.data() + destination * RECORD_FLOATS;
            const V4 rows[] = {cpu.centerOpacity, cpu.covarianceA, cpu.covarianceB, cpu.color};
            for (int row = 0; row < 4; ++row) {
                const float values[] = {rows[row].x, rows[row].y, rows[row].z, rows[row].w};
                for (int lane = 0; lane < 4; ++lane)
                    tolerance.check(gpu[row * 4 + lane], values[lane],
                                    "canonical[" + std::to_string(destination) + "][" +
                                        std::to_string(row * 4 + lane) + "]");
            }
        }
    }
    for (std::size_t record = 0; record < written.size(); ++record)
        if (!written[record])
            for (std::size_t lane = 0; lane < RECORD_FLOATS; ++lane)
                require(records[record * RECORD_FLOATS + lane] == 0.0f,
                        "an unwritten record stays zero");
    std::vector<std::uint32_t> bits(records.size());
    std::memcpy(bits.data(), records.data(), bits.size() * 4);
    std::printf("gather worst=%.3g\n", tolerance.worst);
    std::printf("canonical %s\n", hex_words(bits).c_str());
    bbl::retire_splat_stream_gpu_state(state);
    run_retirements();
    co_return js::PromiseVoid{};
}

} // namespace stream_check

namespace bbl {
// The lowered retirement protocol (gpu-resource-retirement.ts) runs a
// retirement once the submissions before it drain; the fixture's checks
// run the queue after waiting for their own work.
void retire_gpu_resources(std::shared_ptr<pal::GpuRetirementState>, pal::GpuRetirement retirement) {
    stream_check::retirements().push_back(std::move(retirement));
}
void dispose_gpu_resource_retirements(std::shared_ptr<pal::GpuRetirementState>) {}
void run_gpu_resource_callbacks(pal::GpuRetirementBatch disposers) {
    for (const auto& dispose : *disposers)
        dispose();
}
} // namespace bbl
