#pragma once

#include <bblite/js_callback.hpp>

// Plain-data JavaScript runtime support for compiled scene logic: dynamic
// arrays, nullable objects, readonly views, all-number tuples, JavaScript
// Math semantics, and the deterministic seeded Math.random replacement.
// Header-only; reached only when the entry scene compiles plain-data code.

#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <functional>
#include <limits>
#include <list>
#include <memory>
#include <optional>
#include <regex>
#include <initializer_list>
#include <iterator>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl::js {

/**
 * A numeric JavaScript TypedArray.
 *
 * JavaScript copies an object reference when a typed array is assigned,
 * captured, returned, or stored in another object.  A plain std::vector
 * copied its elements instead, which separated a Uint8Array(buffer) view
 * from later writes through another reference to the source typed array.
 * Keep the vector allocation behind a shared handle so every native wrapper
 * continues to name the same fixed-length backing store.
 */
template <typename T>
class TypedArray {
  public:
    using value_type = T;
    using iterator = typename std::vector<T>::iterator;
    using const_iterator = typename std::vector<T>::const_iterator;

    TypedArray()
        : values_(std::make_shared<std::vector<T>>()) {}
    explicit TypedArray(std::size_t count)
        : values_(std::make_shared<std::vector<T>>(count)) {}
    TypedArray(std::size_t count, const T& value)
        : values_(std::make_shared<std::vector<T>>(count, value)) {}
    TypedArray(std::initializer_list<T> values)
        : values_(std::make_shared<std::vector<T>>(values)) {}
    // Native mesh-data producers own vectors. Crossing into JavaScript data
    // takes a snapshot (or transfers a temporary), then aliases share it.
    TypedArray(std::vector<T> values)
        : values_(std::make_shared<std::vector<T>>(std::move(values))) {}
    template <typename Iterator>
    TypedArray(Iterator first, Iterator last)
        : values_(std::make_shared<std::vector<T>>(first, last)) {}

    [[nodiscard]] std::size_t size() const { return values_->size(); }
    [[nodiscard]] bool empty() const { return values_->empty(); }
    [[nodiscard]] T* data() { return values_->data(); }
    [[nodiscard]] const T* data() const { return values_->data(); }
    [[nodiscard]] iterator begin() { return values_->begin(); }
    [[nodiscard]] iterator end() { return values_->end(); }
    [[nodiscard]] const_iterator begin() const { return values_->begin(); }
    [[nodiscard]] const_iterator end() const { return values_->end(); }
    [[nodiscard]] const_iterator cbegin() const { return values_->cbegin(); }
    [[nodiscard]] const_iterator cend() const { return values_->cend(); }
    [[nodiscard]] T& operator[](std::size_t index) { return (*values_)[index]; }
    [[nodiscard]] const T& operator[](std::size_t index) const {
        return (*values_)[index];
    }
    [[nodiscard]] T& at(std::size_t index) { return values_->at(index); }
    [[nodiscard]] const T& at(std::size_t index) const {
        return values_->at(index);
    }
    [[nodiscard]] T& front() { return values_->front(); }
    [[nodiscard]] const T& front() const { return values_->front(); }
    [[nodiscard]] T& back() { return values_->back(); }
    [[nodiscard]] const T& back() const { return values_->back(); }

    void reserve(std::size_t count) { values_->reserve(count); }
    void resize(std::size_t count) { values_->resize(count); }
    void resize(std::size_t count, const T& value) {
        values_->resize(count, value);
    }
    void clear() { values_->clear(); }
    void push_back(const T& value) { values_->push_back(value); }
    void push_back(T&& value) { values_->push_back(std::move(value)); }

    [[nodiscard]] operator std::vector<T>&() { return *values_; }
    [[nodiscard]] operator const std::vector<T>&() const { return *values_; }
    [[nodiscard]] const std::shared_ptr<std::vector<T>>& storage() const {
        return values_;
    }

    [[nodiscard]] friend bool operator==(
        const TypedArray& left,
        const TypedArray& right) {
        return *left.values_ == *right.values_;
    }

  private:
    std::shared_ptr<std::vector<T>> values_;
};

/** Runs a JavaScript finally block on every exit from its native scope. */
template <typename F>
class Finally {
  public:
    explicit Finally(F action) : action_(std::move(action)) {}
    Finally(const Finally&) = delete;
    Finally& operator=(const Finally&) = delete;
    Finally(Finally&&) = delete;
    Finally& operator=(Finally&&) = delete;
    ~Finally() noexcept(noexcept(action_())) { action_(); }

  private:
    F action_;
};

template <typename F>
[[nodiscard]] Finally<std::decay_t<F>> finally(F&& action) {
    return Finally<std::decay_t<F>>(std::forward<F>(action));
}

/**
 * JavaScript ArrayBuffer storage for scene-owned binary data.
 *
 * Copies share the same bytes, matching JavaScript object identity and making
 * later typed-array/DataView slices able to retain the source buffer without
 * copying a large packaged payload.
 */
class ArrayBuffer {
  public:
    ArrayBuffer()
        : bytes_(std::make_shared<std::vector<std::uint8_t>>()) {}
    explicit ArrayBuffer(std::vector<std::uint8_t> bytes)
        : bytes_(std::make_shared<std::vector<std::uint8_t>>(std::move(bytes))) {}
    explicit ArrayBuffer(std::shared_ptr<std::vector<std::uint8_t>> bytes)
        : bytes_(std::move(bytes)) {}
    template <typename T>
        requires std::is_trivially_copyable_v<T>
    explicit ArrayBuffer(const TypedArray<T>& values)
        : external_owner_(values.storage()),
          external_data_(reinterpret_cast<std::uint8_t*>(
              const_cast<T*>(values.data()))),
          external_length_(values.size() * sizeof(T)) {}
    template <typename T>
        requires std::is_trivially_copyable_v<T>
    explicit ArrayBuffer(std::vector<T>& values)
        : external_data_(reinterpret_cast<std::uint8_t*>(values.data())),
          external_length_(values.size() * sizeof(T)) {}
    template <typename T>
        requires std::is_trivially_copyable_v<T>
    explicit ArrayBuffer(const std::vector<T>& values)
        // JavaScript's `TypedArray.buffer` is the same mutable ArrayBuffer
        // object even when the generated C++ binding for the view is const.
        // The constness is a compiler implementation detail, not part of the
        // source value's semantics, so retain the alias instead of copying.
        : external_data_(reinterpret_cast<std::uint8_t*>(
              const_cast<T*>(values.data()))),
          external_length_(values.size() * sizeof(T)) {}

    [[nodiscard]] std::size_t byte_length() const {
        return bytes_ ? bytes_->size() : external_length_;
    }
    [[nodiscard]] const std::uint8_t* data() const {
        return bytes_ ? bytes_->data() : external_data_;
    }
    [[nodiscard]] std::uint8_t* data() {
        return bytes_ ? bytes_->data() : external_data_;
    }
    [[nodiscard]] const std::vector<std::uint8_t>& bytes() const {
        if (!bytes_) {
            throw std::runtime_error(
                "A typed-array-backed ArrayBuffer has no owned byte vector.");
        }
        return *bytes_;
    }
    [[nodiscard]] const std::shared_ptr<std::vector<std::uint8_t>>& storage() const {
        return bytes_;
    }

  private:
    std::shared_ptr<std::vector<std::uint8_t>> bytes_;
    std::shared_ptr<void> external_owner_;
    std::uint8_t* external_data_ = nullptr;
    std::size_t external_length_ = 0;
};

/**
 * A JavaScript object reference: the plain-data records a scene declares
 * are shared by identity, and this is the handle that shares them.
 *
 * It is `std::shared_ptr` without the atomics. Compiled scene logic runs
 * on the one frame thread -- the audio device and the physics solver never
 * touch a scene record -- so every interlocked increment a `shared_ptr`
 * copy performed was paid for a race that cannot happen, and a voxel
 * mesher that reads a chunk record per block query spent a fifth of its
 * time in them. The count and the object share one allocation, as
 * `make_shared` fuses them; there is no weak reference and no aliasing
 * constructor because no generated code needs either.
 */
template <typename T>
class Ref {
  public:
    using element_type = T;

    Ref() = default;
    Ref(const Ref& other) : block_(other.block_) {
        if (block_) ++block_->count;
    }
    Ref(Ref&& other) noexcept : block_(other.block_) {
        other.block_ = nullptr;
    }
    Ref& operator=(const Ref& other) {
        Ref copy(other);
        swap(copy);
        return *this;
    }
    Ref& operator=(Ref&& other) noexcept {
        Ref moved(std::move(other));
        swap(moved);
        return *this;
    }
    ~Ref() { reset(); }

    void swap(Ref& other) noexcept { std::swap(block_, other.block_); }
    void reset() {
        auto* released = std::exchange(block_, nullptr);
        if (released && --released->count == 0) delete released;
    }
    [[nodiscard]] T* get() const {
        return block_ ? std::addressof(*block_->value) : nullptr;
    }
    [[nodiscard]] T& operator*() const { return *block_->value; }
    [[nodiscard]] T* operator->() const { return get(); }
    explicit operator bool() const { return block_ != nullptr; }
    void gc_trace(const TraceVisitor& visitor) const { visitor.edge(block_); }

    [[nodiscard]] friend bool operator==(const Ref& left, const Ref& right) {
        return left.block_ == right.block_;
    }

  private:
    struct Block final : gc::Node {
        template <typename... Args>
        explicit Block(Args&&... args) : value(std::in_place, std::forward<Args>(args)...) {}
        ~Block() override { clear(); }
        std::size_t count = 1;
        std::optional<T> value;
        void trace(const TraceVisitor& visitor) const override { if (value) visitor(*value); }
        void clear() noexcept override { this->payload_alive = false; value.reset(); }
        std::size_t owners() const noexcept override { return count; }
        void pin() noexcept override { ++count; }
        void unpin() noexcept override { if (--count == 0) delete this; }
    };

    template <typename U, typename... Args>
    friend Ref<U> make_ref(Args&&... args);

    explicit Ref(Block* block) : block_(block) {}

    Block* block_ = nullptr;
};

template <typename T, typename... Args>
[[nodiscard]] Ref<T> make_ref(Args&&... args) {
    return Ref<T>(new typename Ref<T>::Block(std::forward<Args>(args)...));
}

/**
 * A non-owning reference whose constructor cannot represent null.
 *
 * Platform event payloads use this only while their synchronous dispatch
 * frame is active. The compiler rejects every retained copy; the wrapper
 * keeps ordinary record copies cheap without making the event an owning or
 * default-constructible JavaScript value.
 */
template <typename T>
class Borrowed {
  public:
    explicit Borrowed(T& value) noexcept : value_(std::addressof(value)) {}

    [[nodiscard]] T& get() const noexcept { return *value_; }

  private:
    T* value_;
};

/**
 * The common DOM Event view: only preventDefault survives on the base type.
 *
 * MouseEvent and KeyboardEvent retain their typed Borrowed<T> wrappers. This
 * erased facade accepts either without introducing a third platform-event
 * record or making arbitrary DOM objects storable.
 */
class BorrowedEvent {
  public:
    template <typename T>
        requires requires(const T& value) { value.prevent_default(); }
    explicit BorrowedEvent(const T& value) noexcept
        : value_(std::addressof(value)),
          type_(&type_tag<T>),
          prevent_default_([](const void* borrowed) noexcept {
              static_cast<const T*>(borrowed)->prevent_default();
          }) {}

    [[nodiscard]] const BorrowedEvent& get() const noexcept { return *this; }
    void prevent_default() const noexcept { prevent_default_(value_); }

    template <typename T>
    [[nodiscard]] const T& as() const {
        if (type_ != &type_tag<T>) {
            throw std::runtime_error("Borrowed DOM event has the wrong payload type.");
        }
        return *static_cast<const T*>(value_);
    }

  private:
    template <typename T>
    static inline const char type_tag = 0;
    const void* value_;
    const void* type_;
    void (*prevent_default_)(const void*) noexcept;
};

/** A Uint8Array view. Subarrays share storage; slices own a copy. */
class U8Array {
  public:
    using value_type = std::uint8_t;
    using iterator = value_type*;
    using const_iterator = const value_type*;

    U8Array() = default;
    explicit U8Array(std::size_t length)
        : buffer_(std::vector<std::uint8_t>(length, std::uint8_t{0})),
          length_(length) {}
    explicit U8Array(const ArrayBuffer& buffer)
        : buffer_(buffer), length_(buffer.byte_length()) {}
    U8Array(const ArrayBuffer& buffer, std::size_t byte_offset)
        : U8Array(buffer, byte_offset, buffer.byte_length() - byte_offset) {}
    U8Array(
        const ArrayBuffer& buffer,
        std::size_t byte_offset,
        std::size_t length)
        : buffer_(buffer),
          offset_(byte_offset),
          length_(length) {
        if (offset_ > buffer.byte_length() ||
            length_ > buffer.byte_length() - offset_) {
            throw std::runtime_error("Uint8Array exceeds ArrayBuffer.");
        }
    }

    [[nodiscard]] std::size_t size() const { return length_; }
    [[nodiscard]] std::size_t length() const { return length_; }
    [[nodiscard]] std::uint8_t* data() { return buffer_.data() + offset_; }
    [[nodiscard]] const std::uint8_t* data() const { return buffer_.data() + offset_; }
    [[nodiscard]] iterator begin() { return data(); }
    [[nodiscard]] iterator end() { return data() + length_; }
    [[nodiscard]] const_iterator begin() const { return data(); }
    [[nodiscard]] const_iterator end() const { return data() + length_; }
    [[nodiscard]] std::uint8_t& operator[](std::size_t index) {
        return data()[index];
    }
    [[nodiscard]] const std::uint8_t& operator[](std::size_t index) const {
        return data()[index];
    }
    [[nodiscard]] ArrayBuffer buffer() const { return buffer_; }
    [[nodiscard]] std::size_t byte_offset() const { return offset_; }
    [[nodiscard]] std::size_t byte_length() const { return length_; }
    [[nodiscard]] std::vector<std::uint8_t> to_vector() const {
        return std::vector<std::uint8_t>(data(), data() + length_);
    }
    [[nodiscard]] U8Array subarray(std::size_t begin, std::size_t end) const {
        begin = std::min(begin, length_);
        end = std::min(std::max(end, begin), length_);
        return U8Array(buffer_, offset_ + begin, end - begin);
    }
    [[nodiscard]] U8Array slice(std::size_t begin, std::size_t end) const {
        const U8Array view = subarray(begin, end);
        std::vector<std::uint8_t> copied(view.data(), view.data() + view.length_);
        return U8Array(ArrayBuffer(std::move(copied)));
    }

  private:
    ArrayBuffer buffer_;
    std::size_t offset_ = 0;
    std::size_t length_ = 0;
};

/** A DataView over shared ArrayBuffer storage. */
class DataView {
  public:
    DataView() = default;
    explicit DataView(
        const ArrayBuffer& buffer,
        std::size_t byte_offset = 0,
        std::size_t byte_length =
            std::numeric_limits<std::size_t>::max())
        : buffer_(buffer),
          offset_(byte_offset),
          length_(byte_length == std::numeric_limits<std::size_t>::max()
              ? buffer.byte_length() - byte_offset
              : byte_length) {
        if (offset_ > buffer.byte_length() ||
            length_ > buffer.byte_length() - offset_) {
            throw std::runtime_error("DataView exceeds ArrayBuffer.");
        }
    }

    [[nodiscard]] std::size_t byte_length() const { return length_; }
    [[nodiscard]] std::uint8_t get_uint8(std::size_t offset) const {
        require(offset, 1);
        return buffer_.data()[offset_ + offset];
    }
    [[nodiscard]] std::int8_t get_int8(std::size_t offset) const {
        return static_cast<std::int8_t>(get_uint8(offset));
    }
    [[nodiscard]] std::uint16_t get_uint16(
        std::size_t offset,
        bool little_endian) const {
        require(offset, 2);
        const auto* bytes = buffer_.data() + offset_ + offset;
        return little_endian
            ? static_cast<std::uint16_t>(bytes[0] | (bytes[1] << 8))
            : static_cast<std::uint16_t>((bytes[0] << 8) | bytes[1]);
    }
    [[nodiscard]] std::int16_t get_int16(
        std::size_t offset,
        bool little_endian) const {
        return static_cast<std::int16_t>(get_uint16(offset, little_endian));
    }
    [[nodiscard]] std::uint32_t get_uint32(
        std::size_t offset,
        bool little_endian) const {
        require(offset, 4);
        const auto* bytes = buffer_.data() + offset_ + offset;
        if (little_endian) {
            return static_cast<std::uint32_t>(bytes[0]) |
                (static_cast<std::uint32_t>(bytes[1]) << 8) |
                (static_cast<std::uint32_t>(bytes[2]) << 16) |
                (static_cast<std::uint32_t>(bytes[3]) << 24);
        }
        return (static_cast<std::uint32_t>(bytes[0]) << 24) |
            (static_cast<std::uint32_t>(bytes[1]) << 16) |
            (static_cast<std::uint32_t>(bytes[2]) << 8) |
            static_cast<std::uint32_t>(bytes[3]);
    }
    [[nodiscard]] std::int32_t get_int32(
        std::size_t offset,
        bool little_endian) const {
        return static_cast<std::int32_t>(get_uint32(offset, little_endian));
    }
    [[nodiscard]] float get_float32(
        std::size_t offset,
        bool little_endian) const {
        return std::bit_cast<float>(get_uint32(offset, little_endian));
    }

  private:
    void require(std::size_t offset, std::size_t width) const {
        if (offset > length_ || width > length_ - offset) {
            throw std::runtime_error("DataView read exceeds buffer.");
        }
    }

    ArrayBuffer buffer_;
    std::size_t offset_ = 0;
    std::size_t length_ = 0;
};

/**
 * JavaScript Array storage. Copying an Array copies the reference, not its
 * elements; explicit array-producing operations construct a fresh wrapper.
 */
template <typename T>
class Array {
  public:
    using Storage = std::conditional_t<
        std::is_same_v<T, bool>,
        std::deque<T>,
        std::vector<T>>;
    using value_type = T;
    using iterator = typename Storage::iterator;
    using const_iterator = typename Storage::const_iterator;

    Array() : values_(make_gc_shared<Storage>()) {}
    Array(std::initializer_list<T> values)
        : values_(make_gc_shared<Storage>(values)) {}
    explicit Array(std::size_t count)
        : values_(make_gc_shared<Storage>(count)) {}
    Array(std::size_t count, const T& value)
        : values_(make_gc_shared<Storage>(count, value)) {}
    template <typename Iterator>
    Array(Iterator first, Iterator last)
        : values_(make_gc_shared<Storage>(first, last)) {}

    [[nodiscard]] std::size_t size() const { return values_->size(); }
    [[nodiscard]] bool empty() const { return values_->empty(); }
    [[nodiscard]] T* data() requires (!std::is_same_v<T, bool>) {
        return values_->data();
    }
    [[nodiscard]] const T* data() const requires (!std::is_same_v<T, bool>) {
        return values_->data();
    }
    [[nodiscard]] iterator begin() { return values_->begin(); }
    [[nodiscard]] iterator end() { return values_->end(); }
    [[nodiscard]] const_iterator begin() const { return values_->begin(); }
    [[nodiscard]] const_iterator end() const { return values_->end(); }
    [[nodiscard]] T& operator[](std::size_t index) { return (*values_)[index]; }
    [[nodiscard]] const T& operator[](std::size_t index) const { return (*values_)[index]; }
    [[nodiscard]] T& at(std::size_t index) { return values_->at(index); }
    [[nodiscard]] const T& at(std::size_t index) const { return values_->at(index); }
    [[nodiscard]] T& front() { return values_->front(); }
    [[nodiscard]] const T& front() const { return values_->front(); }
    [[nodiscard]] T& back() { return values_->back(); }
    [[nodiscard]] const T& back() const { return values_->back(); }
    void push_back(const T& value) {
        reserve_for_push();
        values_->push_back(value);
    }
    void push_back(T&& value) {
        reserve_for_push();
        values_->push_back(std::move(value));
    }
    void pop_back() { values_->pop_back(); }
    void reserve(std::size_t count) {
        if constexpr (!std::is_same_v<T, bool>) {
            values_->reserve(count);
        } else {
            static_cast<void>(count);
        }
    }
    void resize(std::size_t count) { values_->resize(count); }
    void clear() { values_->clear(); }
    iterator erase(iterator position) { return values_->erase(position); }
    template <typename Iterator>
    iterator insert(iterator position, Iterator first, Iterator last) {
        return values_->insert(position, first, last);
    }
    iterator insert(iterator position, std::initializer_list<T> values) {
        return values_->insert(position, values);
    }

    [[nodiscard]] bool operator==(const Array& other) const {
        return values_ == other.values_;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(values_); }

  private:
    // A JavaScript array literal that then grows a few elements -- the
    // per-face corner and light lists a voxel mesher builds -- would
    // otherwise pay std::vector's 1, 2, 3, 4 growth ladder: one heap
    // allocation per push for the first four pushes. Start at a small
    // fixed capacity instead, so a short-lived list is one allocation.
    static constexpr std::size_t initial_push_capacity = 8;
    void reserve_for_push() {
        if constexpr (!std::is_same_v<T, bool>) {
            if (values_->capacity() == 0) {
                values_->reserve(initial_push_capacity);
            }
        }
    }

    std::shared_ptr<Storage> values_;
};

template <typename T, typename Iterable>
[[nodiscard]] inline Array<T> array_from_iterable(
    const Iterable& values) {
    return Array<T>(values.begin(), values.end());
}

template <typename T, typename Iterable>
inline void array_append(Array<T>& target, const Iterable& values) {
    target.insert(target.end(), values.begin(), values.end());
}

/** Materialize JavaScript array storage at a native std::vector sink. */
template <typename T>
[[nodiscard]] inline std::vector<T> array_to_vector(const Array<T>& values) {
    return std::vector<T>(values.begin(), values.end());
}

/** JavaScript indexed writes grow an Array and leave default-valued holes. */
template <typename T>
[[nodiscard]] inline T& array_index_write(
    Array<T>& target,
    std::size_t index) {
    if (index >= target.size()) {
        if (index == std::numeric_limits<std::size_t>::max()) {
            // The sentinel `array_index` maps every unrepresentable double
            // to. Without this refusal `resize(index + 1)` wraps to
            // `resize(0)` and silently truncates the array.
            throw std::runtime_error(
                "Array index write out of range.");
        }
        target.resize(index + 1);
    }
    return target[index];
}

template <typename T>
class Nullable {
  public:
    Nullable() = default;
    Nullable(std::nullopt_t) {}
    Nullable(const T& value) : owned_(value) {}
    Nullable(T&& value) : owned_(std::move(value)) {}
    template <typename U>
        requires (
            !std::is_same_v<std::remove_cvref_t<U>, Nullable> &&
            std::is_constructible_v<T, U&&>)
    Nullable(U&& value)
        : owned_(std::in_place, std::forward<U>(value)) {}

    [[nodiscard]] static Nullable reference(T& value) {
        Nullable result;
        result.reference_ = &value;
        return result;
    }

    [[nodiscard]] bool has_value() const {
        return reference_ != nullptr || owned_.has_value();
    }
    [[nodiscard]] T& value() {
        if (reference_) return *reference_;
        return owned_.value();
    }
    [[nodiscard]] const T& value() const {
        if (reference_) return *reference_;
        return owned_.value();
    }
    [[nodiscard]] T& operator*() { return value(); }
    [[nodiscard]] const T& operator*() const { return value(); }
    [[nodiscard]] T* operator->() { return &value(); }
    [[nodiscard]] const T* operator->() const { return &value(); }
    explicit operator bool() const { return has_value(); }
    [[nodiscard]] std::optional<T> to_optional() const {
        return has_value()
            ? std::optional<T>{value()}
            : std::nullopt;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(owned_); }

    Nullable& operator=(std::nullopt_t) {
        reference_ = nullptr;
        owned_.reset();
        return *this;
    }
    Nullable& operator=(const T& value) {
        reference_ = nullptr;
        owned_ = value;
        return *this;
    }
    Nullable& operator=(T&& value) {
        reference_ = nullptr;
        owned_ = std::move(value);
        return *this;
    }
    template <typename U>
        requires (
            !std::is_same_v<std::remove_cvref_t<U>, Nullable> &&
            std::is_constructible_v<T, U&&>)
    Nullable& operator=(U&& value) {
        reference_ = nullptr;
        owned_.emplace(std::forward<U>(value));
        return *this;
    }

  private:
    T* reference_ = nullptr;
    std::optional<T> owned_;
};

/** The reached JavaScript RegExp surface: mutable global exec state. */
class RegExp {
  public:
    RegExp(std::string source, bool global, bool ignore_case)
        : expression_(
              std::move(source),
              std::regex_constants::ECMAScript |
                  (ignore_case ? std::regex_constants::icase
                               : std::regex_constants::syntax_option_type{})),
          global_(global) {}

    [[nodiscard]] Nullable<Array<std::string>> exec(
        const std::string& input) {
        const auto requested = global_ && std::isfinite(last_index)
            ? std::max(0.0, std::trunc(last_index))
            : 0.0;
        const auto start = static_cast<std::size_t>(requested);
        if (start > input.size()) {
            if (global_) last_index = 0.0;
            return std::nullopt;
        }
        std::match_results<std::string::const_iterator> match;
        const auto first = input.cbegin() + static_cast<std::ptrdiff_t>(start);
        if (!std::regex_search(first, input.cend(), match, expression_)) {
            if (global_) last_index = 0.0;
            return std::nullopt;
        }
        Array<std::string> groups;
        groups.reserve(match.size());
        for (const auto& group : match) {
            groups.push_back(group.matched ? group.str() : std::string{});
        }
        if (global_) {
            last_index = static_cast<double>(
                start + static_cast<std::size_t>(match.position()) + match.length());
        }
        return groups;
    }

    [[nodiscard]] Array<std::string> split(
        const std::string& input) const {
        Array<std::string> result;
        std::sregex_token_iterator part(input.begin(), input.end(), expression_, -1);
        const std::sregex_token_iterator end;
        for (; part != end; ++part) result.push_back(part->str());
        return result;
    }

    [[nodiscard]] Nullable<Array<std::string>> match(
        const std::string& input) const {
        Array<std::string> result;
        if (global_) {
            const std::sregex_iterator end;
            for (std::sregex_iterator found(input.begin(), input.end(), expression_);
                 found != end;
                 ++found) {
                result.push_back(found->str());
            }
        } else {
            std::smatch found;
            if (std::regex_search(input, found, expression_)) {
                result.reserve(found.size());
                for (const auto& group : found) {
                    result.push_back(
                        group.matched ? group.str() : std::string{});
                }
            }
        }
        return result.empty()
            ? Nullable<Array<std::string>>(std::nullopt)
            : Nullable<Array<std::string>>(std::move(result));
    }

    [[nodiscard]] Array<Array<std::string>> match_all(
        const std::string& input) const {
        if (!global_) {
            throw std::runtime_error("String.matchAll requires a global RegExp.");
        }
        Array<Array<std::string>> result;
        const std::sregex_iterator end;
        for (std::sregex_iterator found(input.begin(), input.end(), expression_);
             found != end;
             ++found) {
            Array<std::string> groups;
            groups.reserve(found->size());
            for (const auto& group : *found) {
                groups.push_back(
                    group.matched ? group.str() : std::string{});
            }
            result.push_back(std::move(groups));
        }
        return result;
    }

    [[nodiscard]] std::string replace(
        const std::string& input,
        const std::string& replacement) const {
        return std::regex_replace(
            input,
            expression_,
            replacement,
            global_
                ? std::regex_constants::format_default
                : std::regex_constants::format_first_only);
    }

    [[nodiscard]] bool test(const std::string& input) {
        return exec(input).has_value();
    }

    double last_index = 0.0;

  private:
    std::regex expression_;
    bool global_ = false;
};

/**
 * JavaScript unions flatten null and undefined. Map.get therefore returns
 * one Nullable<T> when the stored value is already Nullable<T>, rather than
 * the C++-mechanical Nullable<Nullable<T>>.
 */
template <typename V>
struct MapGetResult {
    using Type = Nullable<V>;

    [[nodiscard]] static Type missing() { return {}; }
    [[nodiscard]] static Type found(V& value) {
        return Type::reference(value);
    }
};

template <typename T>
struct MapGetResult<Nullable<T>> {
    using Type = Nullable<T>;

    [[nodiscard]] static Type missing() { return {}; }
    [[nodiscard]] static Type found(Nullable<T>& value) {
        return value.has_value()
            ? Type::reference(*value)
            : Type{};
    }
};

/**
 * A nullable JavaScript object is already an empty/shared reference. The
 * lookup hands back a reference into the map's own slot, as the Nullable
 * arm above already does for plain values: a caller that keeps the object
 * copies it into a typed local, while an optional chain that reads one
 * field and drops it -- `defs[id]?.flag`, the hottest lookup a block
 * registry serves -- binds the reference and pays no refcount traffic.
 * The slot is a list node, so the reference outlives every insertion.
 */
template <typename T>
struct MapGetResult<Ref<T>> {
    using Type = const Ref<T>&;

    [[nodiscard]] static Type missing() {
        static const Ref<T> empty;
        return empty;
    }
    [[nodiscard]] static Type found(Ref<T>& value) {
        return value;
    }
};

/** JavaScript arithmetic converts a missing numeric lookup to NaN. */
[[nodiscard]] inline double number_from_optional(
    const Nullable<double>& value) {
    return value.has_value()
        ? *value
        : std::numeric_limits<double>::quiet_NaN();
}

/**
 * Stable insertion-order iteration for JavaScript Map and Set.
 *
 * JavaScript permits the current entry to be deleted during `for...of` and
 * visits entries appended before the iterator reaches the end. A list keeps
 * nodes stable while the active bit retains a deleted current node until an
 * iterator has safely advanced past it.
 */
template <typename T>
struct InsertionOrderedSlot {
    T value;
    bool active = true;
    void gc_trace(const TraceVisitor& visitor) const { visitor(value); }
};

template <typename T>
struct InsertionOrderedStorage {
    using Slot = InsertionOrderedSlot<T>;
    using Slots = std::list<Slot>;

    void sweep_deleted() {
        for (auto entry = entries.begin(); entry != entries.end();) {
            entry = entry->active ? std::next(entry) : entries.erase(entry);
        }
    }

    Slots entries;
    std::size_t iterator_count = 0;
    gc::Node* allocation = nullptr;
    void gc_bind_node(gc::Node* node) noexcept { allocation = node; }
};

template <typename T, bool IsConst>
class InsertionOrderedIterator {
  private:
    using Storage = InsertionOrderedStorage<T>;
    using Slots = typename Storage::Slots;
    using BaseIterator = std::conditional_t<
        IsConst,
        typename Slots::const_iterator,
        typename Slots::iterator>;

  public:
    using iterator_category = std::forward_iterator_tag;
    using value_type = T;
    using difference_type = std::ptrdiff_t;
    using reference = std::conditional_t<IsConst, const T&, T&>;
    using pointer = std::conditional_t<IsConst, const T*, T*>;

    InsertionOrderedIterator(
        std::shared_ptr<Storage> storage,
        BaseIterator current,
        BaseIterator end)
        : storage_(std::move(storage)), allocation_(storage_->allocation), current_(current), end_(end) {
        ++storage_->iterator_count;
        skip_deleted();
    }
    InsertionOrderedIterator(const InsertionOrderedIterator& other)
        : storage_(other.storage_), allocation_(other.allocation_), current_(other.current_), end_(other.end_) {
        if (storage_ && storage_alive()) ++storage_->iterator_count;
    }
    InsertionOrderedIterator(InsertionOrderedIterator&& other) noexcept
        : storage_(std::move(other.storage_)),
          allocation_(other.allocation_),
          current_(other.current_),
          end_(other.end_) {}
    InsertionOrderedIterator& operator=(
        const InsertionOrderedIterator& other) {
        if (this == &other) return *this;
        release();
        storage_ = other.storage_;
        allocation_ = other.allocation_;
        current_ = other.current_;
        end_ = other.end_;
        if (storage_ && storage_alive()) ++storage_->iterator_count;
        return *this;
    }
    InsertionOrderedIterator& operator=(
        InsertionOrderedIterator&& other) noexcept {
        if (this == &other) return *this;
        release();
        storage_ = std::move(other.storage_);
        allocation_ = other.allocation_;
        current_ = other.current_;
        end_ = other.end_;
        return *this;
    }
    ~InsertionOrderedIterator() { release(); }

    [[nodiscard]] reference operator*() const { return current_->value; }
    [[nodiscard]] pointer operator->() const {
        return std::addressof(current_->value);
    }
    InsertionOrderedIterator& operator++() {
        ++current_;
        skip_deleted();
        return *this;
    }
    InsertionOrderedIterator operator++(int) {
        InsertionOrderedIterator previous = *this;
        ++(*this);
        return previous;
    }
    [[nodiscard]] bool operator==(
        const InsertionOrderedIterator& other) const {
        return current_ == other.current_;
    }
    [[nodiscard]] bool operator!=(
        const InsertionOrderedIterator& other) const {
        return !(*this == other);
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(storage_); }

  private:
    [[nodiscard]] bool storage_alive() const {
        return !allocation_ || allocation_->payload_alive;
    }
    void release() {
        if (!storage_) return;
        // Cycle collection may already have destroyed the storage payload.
        // This iterator's shared owner still keeps its control node alive.
        if (!storage_alive()) {
            storage_.reset();
            return;
        }
        assert(storage_->iterator_count > 0);
        --storage_->iterator_count;
        if (storage_->iterator_count == 0) {
            storage_->sweep_deleted();
        }
        storage_.reset();
    }
    void skip_deleted() {
        while (current_ != end_ && !current_->active) ++current_;
    }

    std::shared_ptr<Storage> storage_;
    gc::Node* allocation_ = nullptr;
    BaseIterator current_;
    BaseIterator end_;
};

template <typename T>
inline constexpr bool is_ref_v = false;
template <typename T>
inline constexpr bool is_ref_v<Ref<T>> = true;

/** Insertion-ordered JavaScript Map and Set containers. */
template <typename T>
struct ValueHash {
    [[nodiscard]] std::size_t operator()(const T& value) const noexcept {
        if constexpr (requires { value.value; }) {
            return std::hash<decltype(value.value)>{}(value.value);
        } else if constexpr (is_ref_v<T>) {
            // An object keys a Set or Map by identity.
            return std::hash<const void*>{}(value.get());
        } else {
            return std::hash<T>{}(value);
        }
    }
};

/** A stored function hashes by the identity its equality already uses. */
template <typename Sig>
struct ValueHash<Callback<Sig>> {
    [[nodiscard]] std::size_t operator()(
        const Callback<Sig>& value) const noexcept {
        return std::hash<std::size_t>{}(value.identity());
    }
};

/**
 * The container shell Map and Set share: insertion-ordered slots, an
 * unordered index from a key into them, the erase that soft-deletes
 * under a live iterator, and the iterator surface over the slots. The
 * derived containers keep only their own entry shape and lookup API —
 * Map indexes `std::pair<K, V>` by the pair's first, Set indexes the
 * value by itself — and both hand the key to `insert` explicitly, so
 * the shell needs no key projection.
 */
template <typename EntryT, typename KeyT>
class IndexedInsertionOrdered {
  public:
    using Slot = InsertionOrderedSlot<EntryT>;
    using Iterator = InsertionOrderedIterator<EntryT, false>;
    using ConstIterator = InsertionOrderedIterator<EntryT, true>;

    [[nodiscard]] bool has(const KeyT& key) const {
        return find(key) != storage_->index.end();
    }
    [[nodiscard]] bool erase(const KeyT& key) {
        const auto entry = find(key);
        if (entry == storage_->index.end()) return false;
        const auto slot = entry->second;
        storage_->invalidate_lookup();
        storage_->index.erase(entry);
        if (storage_->iterator_count > 0) {
            slot->active = false;
        } else {
            storage_->entries.erase(slot);
        }
        return true;
    }
    void clear() {
        storage_->invalidate_lookup();
        storage_->index.clear();
        if (storage_->iterator_count > 0) {
            for (Slot& entry : storage_->entries) {
                entry.active = false;
            }
        } else {
            storage_->entries.clear();
        }
    }
    [[nodiscard]] Iterator begin() {
        return Iterator(
            storage_,
            storage_->entries.begin(),
            storage_->entries.end());
    }
    [[nodiscard]] Iterator end() {
        return Iterator(
            storage_,
            storage_->entries.end(),
            storage_->entries.end());
    }
    [[nodiscard]] ConstIterator begin() const {
        const auto& entries = storage_->entries;
        return ConstIterator(
            storage_, entries.cbegin(), entries.cend());
    }
    [[nodiscard]] ConstIterator end() const {
        const auto& entries = storage_->entries;
        return ConstIterator(
            storage_, entries.cend(), entries.cend());
    }
    [[nodiscard]] std::size_t size() const {
        return storage_->index.size();
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(storage_); }

  protected:
    using OrderedStorage = InsertionOrderedStorage<EntryT>;
    struct Storage : OrderedStorage {
        using Index = std::unordered_map<
            KeyT,
            typename OrderedStorage::Slots::iterator,
            ValueHash<KeyT>>;
        Index index;
        // The last lookup, kept beside the shared storage: hot JavaScript
        // Map readers query the same key repeatedly (a voxel mesher reads
        // one chunk's blocks thousands of times in a row), and a repeated
        // key then costs a compare instead of a hash and a probe. Every
        // mutation that can invalidate an unordered-map iterator clears it
        // through `invalidate_lookup`, the one place that knows both halves.
        mutable std::optional<KeyT> cached_key;
        mutable std::optional<typename Index::const_iterator> cached_index;
        void invalidate_lookup() {
            cached_key.reset();
            cached_index.reset();
        }
        void gc_trace(const TraceVisitor& visitor) const {
            visitor(this->entries);
            // The index and lookup cache own additional key copies.
            for (const auto& entry : index) visitor(entry.first);
            visitor(cached_key);
        }
    };

    /**
     * Find `key`, remembering the answer for the next lookup unless the
     * caller is about to change it: a writer's own miss is invalidated by
     * the insert that follows, so recording it would only copy the key.
     */
    [[nodiscard]] auto find(const KeyT& key, bool remember = true) const {
        if (storage_->cached_key.has_value() &&
            std::equal_to<KeyT>{}(*storage_->cached_key, key)) {
            return *storage_->cached_index;
        }
        const auto& index = storage_->index;
        const auto entry = index.find(key);
        if (remember) {
            storage_->cached_key = key;
            storage_->cached_index = entry;
        }
        return entry;
    }
    /** Append a not-yet-present entry and index it under `key`. */
    void insert(const KeyT& key, const EntryT& entry) {
        storage_->entries.push_back(Slot{entry});
        storage_->invalidate_lookup();
        storage_->index.emplace(
            key,
            std::prev(storage_->entries.end()));
    }

    std::shared_ptr<Storage> storage_ =
        make_gc_shared<Storage>();
};

template <typename K, typename V>
class Map : public IndexedInsertionOrdered<std::pair<K, V>, K> {
  private:
    using Base = IndexedInsertionOrdered<std::pair<K, V>, K>;
    using Base::find;
    using Base::insert;
    using Base::storage_;

  public:
    using Entry = std::pair<K, V>;

    Map() = default;
    Map(std::initializer_list<Entry> entries) {
        for (const Entry& entry : entries) set(entry.first, entry.second);
    }

    [[nodiscard]] typename MapGetResult<V>::Type get(const K& key) const {
        const auto entry = find(key);
        return entry == storage_->index.end()
            ? MapGetResult<V>::missing()
            : MapGetResult<V>::found(entry->second->value.second);
    }
    template <typename OptionalKey>
        requires std::is_same_v<OptionalKey, K>
    [[nodiscard]] typename MapGetResult<V>::Type get(
        const Nullable<OptionalKey>& key) const {
        return key.has_value()
            ? get(*key)
            : MapGetResult<V>::missing();
    }
    [[nodiscard]] V& at(const K& key) {
        const auto entry = find(key);
        if (entry == storage_->index.end()) {
            throw std::out_of_range("Map key is not present.");
        }
        return entry->second->value.second;
    }
    [[nodiscard]] const V& at(const K& key) const {
        const auto entry = find(key);
        if (entry == storage_->index.end()) {
            throw std::out_of_range("Map key is not present.");
        }
        return entry->second->value.second;
    }
    Map& set(const K& key, const V& value) {
        const auto entry = find(key, false);
        if (entry == storage_->index.end()) {
            insert(key, Entry{key, value});
        } else {
            entry->second->value.second = value;
        }
        return *this;
    }
};

/** Immediate snapshot of JavaScript Map.prototype.values iteration order. */
template <typename K, typename V>
[[nodiscard]] inline Array<V> map_values(const Map<K, V>& map) {
    Array<V> values;
    values.reserve(map.size());
    for (const auto& entry : map) values.push_back(entry.second);
    return values;
}

/** Immediate snapshot of JavaScript Map.prototype.keys iteration order. */
template <typename K, typename V>
[[nodiscard]] inline Array<K> map_keys(const Map<K, V>& map) {
    Array<K> keys;
    keys.reserve(map.size());
    for (const auto& entry : map) keys.push_back(entry.first);
    return keys;
}

template <typename T>
class Set : public IndexedInsertionOrdered<T, T> {
  private:
    using Base = IndexedInsertionOrdered<T, T>;
    using Base::find;
    using Base::insert;
    using Base::storage_;

  public:
    using Slot = typename Base::Slot;

    Set() = default;
    Set(std::initializer_list<T> values) {
        for (const T& value : values) add(value);
    }
    explicit Set(const Array<T>& values) {
        for (const T& value : values) add(value);
    }

    Set& add(const T& value) {
        if (find(value, false) == storage_->index.end()) {
            insert(value, value);
        }
        return *this;
    }
};

template <typename T>
using Span = std::span<T>;

/**
 * Fixed-length JavaScript numeric array storage.
 *
 * A TypeScript tuple is still an Array object: assigning it to another field
 * or record preserves identity, while `[...tuple]` explicitly makes a copy.
 * Keeping the fixed extent avoids the allocation and bounds metadata of the
 * general Array wrapper without losing that reference behavior.
 */
template <std::size_t N>
class Tuple {
  public:
    using Storage = std::array<double, N>;
    using iterator = typename Storage::iterator;
    using const_iterator = typename Storage::const_iterator;

    Tuple() : values_(std::make_shared<Storage>()) {}
    Tuple(std::initializer_list<double> values)
        : values_(std::make_shared<Storage>()) {
        if (values.size() != N) {
            throw std::runtime_error("Tuple initializer has the wrong length.");
        }
        std::copy(values.begin(), values.end(), values_->begin());
    }
    Tuple(Storage values)
        : values_(std::make_shared<Storage>(std::move(values))) {}

    [[nodiscard]] double& operator[](std::size_t index) {
        return (*values_)[index];
    }
    [[nodiscard]] const double& operator[](std::size_t index) const {
        return (*values_)[index];
    }
    [[nodiscard]] constexpr std::size_t size() const { return N; }
    [[nodiscard]] double* data() { return values_->data(); }
    [[nodiscard]] const double* data() const { return values_->data(); }
    [[nodiscard]] iterator begin() { return values_->begin(); }
    [[nodiscard]] const_iterator begin() const { return values_->begin(); }
    [[nodiscard]] iterator end() { return values_->end(); }
    [[nodiscard]] const_iterator end() const { return values_->end(); }

    [[nodiscard]] Tuple clone() const {
        return Tuple{*values_};
    }

  private:
    std::shared_ptr<Storage> values_;
};

template <std::size_t N>
[[nodiscard]] inline Tuple<N> clone_tuple(const Tuple<N>& tuple) {
    return tuple.clone();
}

/**
 * Primitive number spelling for JavaScript string interpolation, written
 * into a caller's buffer. The finite path uses the shortest round-trippable
 * spelling supplied by `to_chars`, with an integer fast path for the
 * coordinates and ids a scene keys its maps by; the exceptional spellings
 * follow ECMAScript rather than the implementation-defined C library names.
 * This is the one formatter, shared by `number_to_string` and `concat`, so a
 * key built either way spells the same text.
 */
using NumberTextBuffer = std::array<char, 64>;

[[nodiscard]] inline std::string_view format_number(
    double value,
    NumberTextBuffer& buffer) {
    if (std::isnan(value)) return "NaN";
    if (value == std::numeric_limits<double>::infinity()) return "Infinity";
    if (value == -std::numeric_limits<double>::infinity()) return "-Infinity";
    constexpr double int32_min = -2147483648.0;
    constexpr double int32_limit = 2147483648.0;
    if (value >= int32_min && value < int32_limit) {
        const auto integer = static_cast<std::int32_t>(value);
        if (static_cast<double>(integer) == value) {
            // Integer coordinates and ids are repeatedly interpolated into
            // JavaScript string keys. A small direct-mapped working set per
            // execution thread keeps those pure conversions from rerunning
            // to_chars in hot Map/Set loops; a collision only replaces an
            // entry and never affects the returned spelling.
            struct CachedIntegerText {
                std::int32_t value = 0;
                std::uint8_t length = 0;
                bool valid = false;
                std::array<char, 12> text{};
            };
            static thread_local std::array<CachedIntegerText, 32> cache;
            auto& entry = cache[static_cast<std::uint32_t>(integer) & 31u];
            if (!entry.valid || entry.value != integer) {
                const auto converted = std::to_chars(
                    entry.text.data(),
                    entry.text.data() + entry.text.size(),
                    integer);
                assert(converted.ec == std::errc{});
                entry.value = integer;
                entry.length = static_cast<std::uint8_t>(
                    converted.ptr - entry.text.data());
                entry.valid = true;
            }
            return std::string_view(entry.text.data(), entry.length);
        }
    }
    const auto converted = std::to_chars(
        buffer.data(), buffer.data() + buffer.size(), value,
        std::chars_format::general);
    assert(converted.ec == std::errc{});
    return std::string_view(
        buffer.data(),
        static_cast<std::size_t>(converted.ptr - buffer.data()));
}

[[nodiscard]] inline std::string number_to_string(double value) {
    NumberTextBuffer buffer;
    return std::string(format_number(value, buffer));
}

/**
 * JavaScript string concatenation, `a + b + c` and a template literal
 * alike, built in one buffer. The operand-at-a-time `std::string +` chain
 * this replaces made a temporary per operator, and a number operand went
 * through a `std::string` of its own before it was appended; here each
 * number is spelled straight into the result. A concatenation is not
 * sequenced in C++ either way, so this changes nothing about evaluation
 * order.
 */
/**
 * A number operand of a concatenation. The wrapper is explicit so that a
 * boolean, which JavaScript spells "true"/"false", can never reach the
 * number formatter through an implicit conversion.
 */
struct NumberPart {
    explicit NumberPart(double value) : value(value) {}
    double value;
};

inline void concat_append(std::string& target, std::string_view part) {
    target.append(part);
}
inline void concat_append(std::string& target, NumberPart part) {
    NumberTextBuffer buffer;
    target.append(format_number(part.value, buffer));
}

[[nodiscard]] inline std::size_t concat_size(std::string_view part) {
    return part.size();
}
[[nodiscard]] inline std::size_t concat_size(NumberPart) {
    // Counted as nothing on purpose: the reservation below exists so a
    // long text with a number in it grows once rather than per operand,
    // while a short key such as "-3,12" must stay inside the small-string
    // buffer -- reserving for a worst-case integer spelling would push
    // every such key onto the heap, which measured slower than the chain
    // this replaces.
    return 0;
}

template <typename... Parts>
[[nodiscard]] inline std::string concat(const Parts&... parts) {
    std::string result;
    result.reserve((std::size_t{0} + ... + concat_size(parts)));
    (concat_append(result, parts), ...);
    return result;
}

// Runtime Number.prototype.toFixed for retained UI values. JavaScript falls
// back to its ordinary number spelling at 1e21, preserves the exceptional
// spellings, and prints positive or negative zero without a minus sign.
[[nodiscard]] inline std::string number_to_fixed(double value, int digits) {
    assert(digits >= 0 && digits <= 100);
    if (std::isnan(value)) return "NaN";
    if (value == std::numeric_limits<double>::infinity()) return "Infinity";
    if (value == -std::numeric_limits<double>::infinity()) return "-Infinity";
    if (std::abs(value) >= 1e21) return number_to_string(value);
    if (value == 0.0) {
        return digits == 0
            ? std::string("0")
            : std::string("0.") + std::string(
                  static_cast<std::size_t>(digits), '0');
    }
    std::array<char, 160> buffer{};
    const auto converted = std::to_chars(
        buffer.data(), buffer.data() + buffer.size(), value,
        std::chars_format::fixed, digits);
    assert(converted.ec == std::errc{});
    return std::string(buffer.data(), converted.ptr);
}

[[nodiscard]] inline double math_sign(double value) {
    if (std::isnan(value) || value == 0.0) return value;
    return value > 0.0 ? 1.0 : -1.0;
}

/**
 * ECMA-262's relative-index rule: a negative index counts back from the
 * end, and either sign clamps into `[0, length]`. Every ranged builtin the
 * lowerer serves -- `slice`, `fill`, `copyWithin` -- resolves each of its
 * endpoints through exactly this, so it is stated once here rather than
 * once per operation.
 */
[[nodiscard]] inline std::size_t relative_index(
    std::size_t length,
    double raw) {
    const auto size = static_cast<std::ptrdiff_t>(length);
    auto index = static_cast<std::ptrdiff_t>(std::trunc(raw));
    if (index < 0) {
        index = std::max<std::ptrdiff_t>(0, size + index);
    }
    return static_cast<std::size_t>(std::min(size, index));
}

[[nodiscard]] inline std::pair<std::size_t, std::size_t>
relative_slice_bounds(
    std::size_t length,
    double begin_value,
    double end_value) {
    const auto begin = relative_index(length, begin_value);
    // An end before the begin is an empty range in every one of these
    // operations -- the spec writes it as a `max(final - from, 0)` count
    // rather than as a clamp, and the two agree on every input.
    const auto end = std::max(begin, relative_index(length, end_value));
    return {begin, end};
}

[[nodiscard]] inline std::string string_slice(
    const std::string& value,
    double begin_value,
    double end_value) {
    const auto [begin, end] = relative_slice_bounds(
        value.size(),
        begin_value,
        end_value);
    return value.substr(begin, end - begin);
}

[[nodiscard]] inline std::string string_upper(std::string value) {
    for (char& character : value) {
        if (character >= 'a' && character <= 'z') {
            character = static_cast<char>(character - 'a' + 'A');
        }
    }
    return value;
}

[[nodiscard]] inline std::string string_lower(std::string value) {
    for (char& character : value) {
        if (character >= 'A' && character <= 'Z') {
            character = static_cast<char>(character - 'A' + 'a');
        }
    }
    return value;
}

/** The six characters JavaScript's own trim and number parsing skip. */
[[nodiscard]] inline bool is_ascii_whitespace(char value) {
    return value == ' ' || value == '\t' || value == '\n' ||
        value == '\r' || value == '\f' || value == '\v';
}

[[nodiscard]] inline std::string string_trim(const std::string& value) {
    std::size_t begin = 0;
    while (begin < value.size() && is_ascii_whitespace(value[begin])) {
        ++begin;
    }
    std::size_t end = value.size();
    while (end > begin && is_ascii_whitespace(value[end - 1])) {
        --end;
    }
    return value.substr(begin, end - begin);
}

[[nodiscard]] inline double string_index_of(
    const std::string& value,
    const std::string& search) {
    const auto index = value.find(search);
    return index == std::string::npos ? -1.0 : static_cast<double>(index);
}

// JavaScript string iteration yields one Unicode code point as a string.
// Native strings are UTF-8, so retain each complete encoded sequence.
[[nodiscard]] inline Array<std::string> string_characters(
    const std::string& value) {
    Array<std::string> result;
    for (std::size_t offset = 0; offset < value.size();) {
        const auto lead = static_cast<unsigned char>(value[offset]);
        std::size_t count = lead < 0x80u
            ? 1u
            : (lead & 0xe0u) == 0xc0u
              ? 2u
              : (lead & 0xf0u) == 0xe0u
                ? 3u
                : (lead & 0xf8u) == 0xf0u
                  ? 4u
                  : 1u;
        count = std::min(count, value.size() - offset);
        result.push_back(value.substr(offset, count));
        offset += count;
    }
    return result;
}

[[nodiscard]] inline Array<std::string> string_split(
    const std::string& value,
    const std::string& separator) {
    if (separator.empty()) return string_characters(value);
    Array<std::string> result;
    std::size_t begin = 0;
    while (true) {
        const std::size_t end = value.find(separator, begin);
        if (end == std::string::npos) {
            result.push_back(value.substr(begin));
            return result;
        }
        result.push_back(value.substr(begin, end - begin));
        begin = end + separator.size();
    }
}

[[nodiscard]] inline bool string_starts_with(
    const std::string& value,
    const std::string& prefix) {
    return value.starts_with(prefix);
}

[[nodiscard]] inline bool string_ends_with(
    const std::string& value,
    const std::string& suffix) {
    return value.ends_with(suffix);
}

[[nodiscard]] inline double string_char_code_at(
    const std::string& value,
    double index_value) {
    const auto index = static_cast<std::size_t>(std::max(0.0, std::trunc(index_value)));
    return index < value.size()
        ? static_cast<unsigned char>(value[index])
        : std::numeric_limits<double>::quiet_NaN();
}

[[nodiscard]] inline std::string string_at(
    const std::string& value,
    std::size_t index) {
    return index < value.size()
        ? std::string(1, value[index])
        : std::string{};
}

[[nodiscard]] inline double number_from_string(
    const std::string& value) {
    const char* begin = value.c_str();
    char* end = nullptr;
    const double parsed = std::strtod(begin, &end);
    while (is_ascii_whitespace(*end)) {
        ++end;
    }
    if (end == begin) {
        for (const char character : value) {
            if (!is_ascii_whitespace(character)) {
                return std::numeric_limits<double>::quiet_NaN();
            }
        }
        return 0.0;
    }
    return *end == '\0'
        ? parsed
        : std::numeric_limits<double>::quiet_NaN();
}

/** JavaScript `parseInt(value, 10)` for the reached decimal-string form. */
[[nodiscard]] inline double parse_int_decimal(
    const std::string& value) {
    std::size_t index = 0;
    while (index < value.size() && is_ascii_whitespace(value[index])) {
        ++index;
    }
    bool negative = false;
    if (index < value.size() &&
        (value[index] == '+' || value[index] == '-')) {
        negative = value[index] == '-';
        ++index;
    }
    double parsed = 0.0;
    bool found_digit = false;
    while (
        index < value.size() &&
        value[index] >= '0' && value[index] <= '9') {
        found_digit = true;
        parsed = parsed * 10.0 +
            static_cast<double>(value[index] - '0');
        ++index;
    }
    if (!found_digit) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return negative ? -parsed : parsed;
}

[[nodiscard]] inline std::string string_from_char_code(double value) {
    const double finite = std::isfinite(value) ? std::trunc(value) : 0.0;
    const double wrapped = std::fmod(finite, 65536.0);
    const auto code = static_cast<std::uint16_t>(
        wrapped < 0.0 ? wrapped + 65536.0 : wrapped);
    return std::string(
        1,
        static_cast<char>(code));
}

[[nodiscard]] inline std::string string_from_char_codes(
    std::initializer_list<double> values) {
    std::string result;
    result.reserve(values.size());
    for (const double value : values) {
        result += string_from_char_code(value);
    }
    return result;
}

[[nodiscard]] inline std::string string_pad_start(
    const std::string& value,
    double target_length_value,
    const std::string& fill) {
    const auto target_length = static_cast<std::size_t>(
        std::max(0.0, std::trunc(target_length_value)));
    if (value.size() >= target_length || fill.empty()) return value;
    const std::size_t needed = target_length - value.size();
    std::string prefix;
    prefix.reserve(needed);
    while (prefix.size() < needed) prefix += fill;
    prefix.resize(needed);
    prefix.append(value);
    return prefix;
}

// `Record<Union, T>` — one fixed slot per member of a string-literal
// union. The compiler lays the slots out in the union's own member
// order, which is the order its enum tags are numbered in, so a tag
// indexes its slot directly. Unlike an Array it never grows: the key
// space is closed at compile time.
template <typename T, std::size_t N>
using EnumMap = std::array<T, N>;

template <typename T, std::size_t N, typename Tag>
[[nodiscard]] inline const T& enum_map_at(
    const EnumMap<T, N>& slots, Tag tag) {
    const auto index = static_cast<std::size_t>(tag);
    assert(index < N);
    return slots[index];
}

template <typename T, std::size_t N, typename Tag>
[[nodiscard]] inline T& enum_map_at(
    EnumMap<T, N>& slots, Tag tag) {
    const auto index = static_cast<std::size_t>(tag);
    assert(index < N);
    return slots[index];
}

template <typename Values>
[[nodiscard]] inline double array_length(const Values& values) {
    return static_cast<double>(values.size());
}

template <typename T>
[[nodiscard]] inline Array<T> array_slice(
    const Array<T>& values,
    double begin_value,
    double end_value) {
    const auto [begin, end] = relative_slice_bounds(
        values.size(),
        begin_value,
        end_value);
    return Array<T>(values.begin() + begin, values.begin() + end);
}

/** JavaScript Array.join for the reached string-array form. */
template <typename Range, typename Projection>
[[nodiscard]] inline std::string array_join(
    const Range& values,
    const std::string& separator,
    Projection projection) {
    std::string result;
    bool first = true;
    for (const auto& value : values) {
        if (!first) {
            result += separator;
        }
        result += projection(value);
        first = false;
    }
    return result;
}

template <typename Range>
[[nodiscard]] inline std::string array_join(
    const Range& values,
    const std::string& separator) {
    return array_join(values, separator, [](const auto& value) -> const auto& {
        return value;
    });
}

/** `%TypedArray%.prototype.slice` copies a numeric range into fresh storage. */
template <typename Values>
[[nodiscard]] inline Values typed_array_slice(
    const Values& values,
    double begin_value,
    double end_value) {
    const auto [begin, end] = relative_slice_bounds(
        values.size(),
        begin_value,
        end_value);
    return Values(values.begin() + begin, values.begin() + end);
}

// `array.indexOf(value)` — the first strictly-equal element, or -1.
// JavaScript compares primitives by value and objects by identity, and
// every element type reaching here is a scalar or a handle id, so a
// plain `==` is that comparison. NaN matches nothing in either
// language, for the same reason.
// The needle is non-deduced so the element type always comes from the
// container: a literal argument then converts to it instead of
// deducing a second, conflicting T.
template <typename T>
[[nodiscard]] inline double array_index_of(
    const Array<T>& values,
    const std::type_identity_t<T>& value) {
    for (std::size_t index = 0; index < values.size();
         ++index) {
        if (values[index] == value) {
            return static_cast<double>(index);
        }
    }
    return -1.0;
}

template <typename T>
[[nodiscard]] inline double array_index_of(
    Span<const T> values,
    const std::type_identity_t<T>& value) {
    for (std::size_t index = 0; index < values.size();
         ++index) {
        if (values[index] == value) {
            return static_cast<double>(index);
        }
    }
    return -1.0;
}

// Constant arrays materialize as `std::array`, so searching one needs
// no conversion at the call site.
template <typename T, std::size_t N>
[[nodiscard]] inline double array_index_of(
    const std::array<T, N>& values,
    const std::type_identity_t<T>& value) {
    for (std::size_t index = 0; index < N; ++index) {
        if (values[index] == value) {
            return static_cast<double>(index);
        }
    }
    return -1.0;
}

// `array.pop()!` — the compiled subset requires a non-empty array (the
// corpus always guards with `.length`); JavaScript would yield `undefined`,
// which the plain-data model cannot represent, so an empty pop refuses by
// name in every build configuration instead of reading freed storage.
template <typename T>
inline T array_pop(Array<T>& values) {
    if (values.empty()) [[unlikely]] {
        throw std::runtime_error("Array pop on an empty array.");
    }
    T last = values.back();
    values.pop_back();
    return last;
}

// `array.shift()!` — same contract as `array_pop`.
template <typename T>
inline T array_shift(Array<T>& values) {
    if (values.empty()) [[unlikely]] {
        throw std::runtime_error("Array shift on an empty array.");
    }
    T first = values.front();
    values.erase(values.begin());
    return first;
}

// `array.unshift(...items)` inserts the arguments at the front in source
// order and returns the new JavaScript length.
template <typename T>
inline double array_unshift(
    Array<T>& values,
    std::initializer_list<T> inserted) {
    values.insert(values.begin(), inserted.begin(), inserted.end());
    return static_cast<double>(values.size());
}

// `array.reverse()` mutates and returns the same JavaScript array object.
template <typename T>
inline Array<T>& array_reverse(Array<T>& values) {
    std::reverse(values.begin(), values.end());
    return values;
}

// `array.fill(value)` shares one range assignment across native vectors,
// JavaScript arrays, and typed-array views (including Uint8Array).
template <typename Values, typename T>
inline void array_fill(Values& values, const T& value) {
    std::fill(values.begin(), values.end(), value);
}

/**
 * `fill(value, start, end)` — the ranged form, over any container the
 * lowerer serves. Both endpoints are relative indices, so a negative one
 * counts back from the end and an end at or before the start writes
 * nothing; `relative_slice_bounds` is that rule, shared with `slice`.
 */
template <typename Values, typename T>
inline void array_fill_range(
    Values& values,
    const T& value,
    double start,
    double end) {
    const auto [from, to] = relative_slice_bounds(
        values.size(),
        start,
        end);
    std::fill(
        values.begin() + static_cast<std::ptrdiff_t>(from),
        values.begin() + static_cast<std::ptrdiff_t>(to),
        value);
}

/**
 * `%TypedArray%.prototype.copyWithin(target, start, end)`.
 *
 * The spec copies `min(final - from, len - to)` elements and states that
 * the copy behaves as if through an intermediate list, so an overlapping
 * run keeps the source bytes -- `std::copy` cannot promise that when the
 * target is inside the source, and `std::memmove` is exactly what can, so
 * the trivially-copyable element types these containers hold move through
 * `std::copy_backward` when the run overlaps forwards.
 */
template <typename Values>
inline void array_copy_within(
    Values& values,
    double target,
    double start,
    double end) {
    const auto to = relative_index(values.size(), target);
    const auto [from, final] = relative_slice_bounds(
        values.size(),
        start,
        end);
    const auto count = std::min(final - from, values.size() - to);
    if (count == 0 || from == to) return;
    const auto begin = values.begin();
    const auto offset = [](std::size_t index) {
        return static_cast<std::ptrdiff_t>(index);
    };
    if (to < from) {
        std::copy(
            begin + offset(from),
            begin + offset(from + count),
            begin + offset(to));
        return;
    }
    std::copy_backward(
        begin + offset(from),
        begin + offset(from + count),
        begin + offset(to + count));
}

// `new Array<T>(count).fill(value)`.
template <typename T>
[[nodiscard]] inline Array<T> array_filled(double count, const T& value) {
    return Array<T>(static_cast<std::size_t>(count), value);
}

[[nodiscard]] inline std::size_t array_index(double index) {
    // The raw fast-path conversion for indices the compiler proved in
    // bounds. It must still be defined over the full double domain — a
    // negative, non-finite, or 2^64-and-up value makes the bare cast
    // undefined behavior — so everything unrepresentable maps to the
    // SIZE_MAX sentinel, which every internal range check rejects.
    return index >= 0.0 && index < 18446744073709551616.0
        ? static_cast<std::size_t>(index)
        : std::numeric_limits<std::size_t>::max();
}

// `array.splice(index, 1)` — remove one element and shift the tail down,
// the removal form the reached subset compiles (the particle sweep).
template <typename T>
inline void array_splice_one(Array<T>& values, double index) {
    const auto position = array_index(index);
    if (position >= values.size()) [[unlikely]] {
        throw std::runtime_error("Array splice index out of range.");
    }
    values.erase(values.begin() + static_cast<std::ptrdiff_t>(position));
}

// `array.length = count` — the reached subset only shrinks (truncation).
template <typename T>
inline void array_truncate(Array<T>& values, double count) {
    const auto size = array_index(count);
    if (size > values.size()) [[unlikely]] {
        throw std::runtime_error(
            "Array length assignment must not grow the array.");
    }
    values.resize(size);
}

template <typename T>
[[nodiscard]] inline bool array_has_index(
    const T& values,
    double index) {
    // Range-check before conversion so NaN, infinities, negatives and values
    // too large for this container never reach the cast. Comparing the cast
    // back to the source is the integer test, avoiding std::floor in every
    // dynamic typed-array read while retaining JavaScript index semantics.
    if (!(index >= 0.0 &&
          index < static_cast<double>(values.size()))) {
        return false;
    }
    // Signed on purpose: the range check above already bounds the value
    // below 2^63, and a double-to-signed conversion is one instruction
    // where the unsigned form needs a branch around the high half.
    const auto native = static_cast<std::int64_t>(index);
    return static_cast<double>(native) == index;
}

template <typename T>
[[nodiscard]] inline T& missing_array_value() {
    // Re-defaulted on every miss so a stray write through one missed index
    // cannot persist into every later miss of the same element type.
    static T slot{};
    slot = T{};
    return slot;
}

template <typename T>
[[nodiscard]] inline const T& missing_array_value_readonly() {
    // Never handed out mutably, so one immutable default serves every miss
    // without the mutable slot's per-miss re-defaulting.
    static const T missing{};
    return missing;
}

template <typename T>
[[nodiscard]] inline T& array_at_or_default(
    Array<T>& values,
    double index) {
    return array_has_index(values, index)
        ? values[array_index(index)]
        : missing_array_value<T>();
}

template <typename T>
[[nodiscard]] inline const T& array_at_or_default(
    const Array<T>& values,
    double index) {
    return array_has_index(values, index)
        ? values[array_index(index)]
        : missing_array_value_readonly<T>();
}

template <typename T, std::size_t Extent>
[[nodiscard]] inline const T& array_at_or_default(
    std::span<T, Extent> values,
    double index) {
    return array_has_index(values, index)
        ? values[array_index(index)]
        : missing_array_value_readonly<std::remove_const_t<T>>();
}

[[noreturn]] inline void throw_index_error(
    const char* site,
    const char* operation,
    double index,
    std::size_t size) {
    throw std::runtime_error(
        std::string(site) + ": array " + operation + " index " +
        number_to_string(index) + " is out of bounds for length " +
        number_to_string(static_cast<double>(size)) + ".");
}

/**
 * A runtime index read the compiler could not prove in bounds.
 *
 * JavaScript would yield `undefined`; the plain-data model has no
 * undefined number, struct, or handle to yield, and no reached scene
 * depends on reading one (source-tested reads already ride
 * `array_at_or_default` with its found flag). So an out-of-bounds read
 * here is a scene or compiler defect, and it refuses by name in every
 * build configuration, carrying the scene source location the emission
 * recorded. Indices the compiler does prove in bounds keep the raw
 * `values[array_index(i)]` fast path and never reach this function.
 */
template <typename Values>
[[nodiscard]] inline auto& array_index_checked(
    Values& values,
    double index,
    const char* site) {
    if (!array_has_index(values, index)) [[unlikely]] {
        throw_index_error(site, "read", index, values.size());
    }
    return values[static_cast<std::size_t>(index)];
}

/**
 * The store form of `array_index_checked` for fixed-length storage
 * (typed arrays and tuples). JavaScript drops an out-of-range typed
 * store silently; nothing reached depends on that, so it refuses like
 * the read does rather than hiding the defect.
 */
template <typename Values>
[[nodiscard]] inline auto& array_store_checked(
    Values& values,
    double index,
    const char* site) {
    if (!array_has_index(values, index)) [[unlikely]] {
        throw_index_error(site, "write", index, values.size());
    }
    return values[static_cast<std::size_t>(index)];
}

/**
 * The growing store for an unproven Array index: a write past the end
 * extends the array with default-valued holes exactly as
 * `array_index_write` does, so only an index no JavaScript array could
 * hold (negative, fractional, non-finite, or 2^32-1 and up — where
 * JavaScript stores a plain property instead of an element) refuses.
 */
template <typename T>
[[nodiscard]] inline T& array_index_write_checked(
    Array<T>& values,
    double index,
    const char* site) {
    if (!(index >= 0.0 && std::floor(index) == index &&
          index < 4294967295.0)) [[unlikely]] {
        throw_index_error(site, "write", index, values.size());
    }
    return array_index_write(values, static_cast<std::size_t>(index));
}

// JavaScript `%` (remainder keeps the dividend sign, like std::fmod).
[[nodiscard]] inline double remainder_js(double left, double right) {
    return std::fmod(left, right);
}

// Numeric `a || b`: 0 and NaN fall through to the fallback.
[[nodiscard]] inline double or_number(double value, double fallback) {
    return (value != 0.0 && !std::isnan(value)) ? value : fallback;
}

[[nodiscard]] inline bool number_truthy(double value) {
    return value != 0.0 && !std::isnan(value);
}

// JavaScript typed arrays reached by the compiled subset.
using F64Array = TypedArray<double>;
using F32Array = TypedArray<float>;
using U16Array = TypedArray<std::uint16_t>;
using I16Array = TypedArray<std::int16_t>;
using U32Array = TypedArray<std::uint32_t>;
using I32Array = TypedArray<std::int32_t>;

// src/math/mat4-compose.ts + mat4-compose-into.ts: JavaScript evaluates the
// quaternion products in double precision, then each Float32Array store
// narrows once. Keep that boundary explicit here.
[[nodiscard]] inline F32Array mat4_compose(
    double tx, double ty, double tz,
    double qx, double qy, double qz, double qw,
    double sx, double sy, double sz) {
    const double xx = qx * qx, yy = qy * qy, zz = qz * qz;
    const double xy = qx * qy, xz = qx * qz, yz = qy * qz;
    const double wx = qw * qx, wy = qw * qy, wz = qw * qz;
    F32Array result(16);
    result[0] = static_cast<float>((1.0 - 2.0 * (yy + zz)) * sx);
    result[1] = static_cast<float>(2.0 * (xy + wz) * sx);
    result[2] = static_cast<float>(2.0 * (xz - wy) * sx);
    result[3] = 0.0f;
    result[4] = static_cast<float>(2.0 * (xy - wz) * sy);
    result[5] = static_cast<float>((1.0 - 2.0 * (xx + zz)) * sy);
    result[6] = static_cast<float>(2.0 * (yz + wx) * sy);
    result[7] = 0.0f;
    result[8] = static_cast<float>(2.0 * (xz + wy) * sz);
    result[9] = static_cast<float>(2.0 * (yz - wx) * sz);
    result[10] = static_cast<float>((1.0 - 2.0 * (xx + yy)) * sz);
    result[11] = 0.0f;
    result[12] = static_cast<float>(tx);
    result[13] = static_cast<float>(ty);
    result[14] = static_cast<float>(tz);
    result[15] = 1.0f;
    return result;
}

// ECMAScript ToUint32: modulo 2^32 with truncation toward zero.
[[nodiscard]] inline std::uint32_t to_uint32(double value) {
    // Almost every reached conversion is already within int64 range. C++
    // truncates floating-to-integer conversion toward zero, and conversion
    // from signed int64 to uint32 is defined modulo 2^32, which together are
    // exactly ECMAScript ToUint32 for this range. Keep fmod only for the rare
    // finite values outside it; NaN and infinities still become zero.
    constexpr double int64_min = -9223372036854775808.0;
    constexpr double int64_limit = 9223372036854775808.0;
    if (value >= int64_min && value < int64_limit) {
        return static_cast<std::uint32_t>(
            static_cast<std::int64_t>(value));
    }
    if (!std::isfinite(value)) return 0u;
    const double truncated = std::trunc(value);
    const double wrapped = std::fmod(truncated, 4294967296.0);
    return static_cast<std::uint32_t>(
        wrapped < 0.0 ? wrapped + 4294967296.0 : wrapped);
}

template <std::integral Value>
[[nodiscard]] inline std::uint32_t to_uint32(Value value) {
    return static_cast<std::uint32_t>(value);
}

[[nodiscard]] inline std::int32_t uint32_as_int32(std::uint32_t value) {
    return value <= 0x7fffffffu
        ? static_cast<std::int32_t>(value)
        : static_cast<std::int32_t>(
              static_cast<std::int64_t>(value) - 0x100000000ll);
}

/**
 * Bitwise expression intermediates stay in their specified 32-bit lane.
 *
 * JavaScript exposes a Number at an assignment/call boundary, so both wrappers
 * convert to double there. Nested operations consume the bits directly instead
 * of converting an exact int32 to double and immediately running ToUint32 on it
 * again. This is representation-only: signed bitwise results and unsigned
 * right-shift results retain their distinct JavaScript numeric values.
 */
struct SignedBitwiseNumber {
    std::uint32_t bits = 0;
    [[nodiscard]] operator double() const {
        return static_cast<double>(uint32_as_int32(bits));
    }
};

struct UnsignedBitwiseNumber {
    std::uint32_t bits = 0;
    [[nodiscard]] operator double() const {
        return static_cast<double>(bits);
    }
};

template <typename Lane>
    requires requires(const Lane& lane) {
        { lane.bits } -> std::convertible_to<std::uint32_t>;
    }
[[nodiscard]] inline std::uint32_t to_uint32(Lane lane) {
    return lane.bits;
}

// ECMAScript Math.imul: multiply the two ToUint32 values modulo 2^32,
// then expose the low word as a signed 32-bit JavaScript number. Unsigned
// multiplication gives the specified wrap without relying on signed overflow.
template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber math_imul(
    Left left,
    Right right) {
    return {to_uint32(left) * to_uint32(right)};
}

template <typename Value>
[[nodiscard]] inline SignedBitwiseNumber bitwise_not(Value value) {
    return {~to_uint32(value)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber bitwise_and(
    Left left,
    Right right) {
    return {to_uint32(left) & to_uint32(right)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber bitwise_or(
    Left left,
    Right right) {
    return {to_uint32(left) | to_uint32(right)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber bitwise_xor(
    Left left,
    Right right) {
    return {to_uint32(left) ^ to_uint32(right)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber shift_left(
    Left left,
    Right right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    return {to_uint32(left) << count};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber shift_right(
    Left left,
    Right right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    const std::uint32_t value = to_uint32(left);
    const std::uint32_t shifted = count == 0u
        ? value
        : (value >> count) |
              ((value & 0x80000000u) != 0u
                  ? (~std::uint32_t{0} << (32u - count))
                  : 0u);
    return {shifted};
}

template <typename Left, typename Right>
[[nodiscard]] inline UnsignedBitwiseNumber shift_right_unsigned(
    Left left,
    Right right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    return {to_uint32(left) >> count};
}

[[nodiscard]] inline std::uint16_t to_uint16(double value) {
    return static_cast<std::uint16_t>(to_uint32(value));
}

[[nodiscard]] inline std::int32_t to_int32(double value) {
    return uint32_as_int32(to_uint32(value));
}

[[nodiscard]] inline std::int16_t to_int16(double value) {
    const std::uint16_t wrapped = to_uint16(value);
    return wrapped <= 0x7fffu
        ? static_cast<std::int16_t>(wrapped)
        : static_cast<std::int16_t>(static_cast<std::int32_t>(wrapped) - 0x10000);
}

[[nodiscard]] inline std::uint8_t to_uint8(double value) {
    return static_cast<std::uint8_t>(to_uint32(value));
}

[[nodiscard]] inline U8Array u8_array_sized(double count) {
    return U8Array(static_cast<std::size_t>(count));
}

template <typename Values>
[[nodiscard]] inline U8Array u8_array_from(const Values& values) {
    U8Array result(values.size());
    for (std::size_t index = 0; index < values.size(); ++index) {
        result[index] = to_uint8(values[index]);
    }
    return result;
}

[[nodiscard]] inline F32Array f32_array_sized(double count) {
    return F32Array(static_cast<std::size_t>(count), 0.0f);
}

[[nodiscard]] inline F64Array f64_array_sized(double count) {
    return F64Array(static_cast<std::size_t>(count), 0.0);
}

[[nodiscard]] inline U16Array u16_array_sized(double count) {
    return U16Array(static_cast<std::size_t>(count), 0u);
}

[[nodiscard]] inline I16Array i16_array_sized(double count) {
    return I16Array(static_cast<std::size_t>(count), 0);
}

[[nodiscard]] inline U32Array u32_array_sized(double count) {
    return U32Array(static_cast<std::size_t>(count), 0u);
}

[[nodiscard]] inline I32Array i32_array_sized(double count) {
    return I32Array(static_cast<std::size_t>(count), 0);
}

template <typename Output, typename Values, typename Convert>
[[nodiscard]] inline Output typed_array_from_values(
    const Values& values,
    Convert convert) {
    Output result;
    result.reserve(values.size());
    for (const double value : values) {
        result.push_back(convert(value));
    }
    return result;
}

template <typename Values>
[[nodiscard]] inline U16Array u16_array_from(const Values& values) {
    return typed_array_from_values<U16Array>(values, to_uint16);
}

template <typename Values>
[[nodiscard]] inline I16Array i16_array_from(const Values& values) {
    return typed_array_from_values<I16Array>(values, to_int16);
}

template <typename Values>
[[nodiscard]] inline F32Array f32_array_from(const Values& values) {
    return typed_array_from_values<F32Array>(values, [](double value) {
        return static_cast<float>(value);
    });
}

template <typename Values>
[[nodiscard]] inline F64Array f64_array_from(const Values& values) {
    return typed_array_from_values<F64Array>(values, [](double value) {
        return value;
    });
}

template <typename Values>
[[nodiscard]] inline U32Array u32_array_from(const Values& values) {
    return typed_array_from_values<U32Array>(values, [](double value) {
        return to_uint32(value);
    });
}

template <typename Values>
[[nodiscard]] inline I32Array i32_array_from(const Values& values) {
    return typed_array_from_values<I32Array>(values, to_int32);
}

/**
 * `%TypedArray%.prototype.set(source, offset)` for two arrays of one kind.
 *
 * The spec copies `source` whole into `target` starting at `offset` and
 * raises a RangeError when the run would not fit, so no element is ever
 * written past the end. The refusal here is that RangeError, kept in
 * every build configuration the way `array_pop` keeps its emptiness
 * check: a run that does not fit is a scene bug, and it must not become
 * an out-of-bounds copy in a release parity build.
 */
template <typename T>
inline void typed_array_set(
    TypedArray<T>& target,
    const TypedArray<T>& source,
    double offset) {
    const auto start = array_index(offset);
    if (start > target.size() ||
        source.size() > target.size() - start) [[unlikely]] {
        throw std::runtime_error(
            "TypedArray set does not fit the target array.");
    }
    std::copy(source.begin(), source.end(), target.begin() + static_cast<std::ptrdiff_t>(start));
}

/**
 * `Math.round`, at ECMA-262's own rule rather than C's.
 *
 * The two differ on a negative tie: JavaScript rounds halves toward
 * +Infinity (`Math.round(-0.5)` is `-0`), while `std::round` rounds halves
 * away from zero (`-1`). The spec's rule is "the integer closest to x, ties
 * toward +Infinity", which is `floor(x) + (x - floor(x) >= 0.5)` -- written
 * that way rather than as `floor(x + 0.5)` because the addition is not
 * exact for large magnitudes, where `floor(x) == x` makes this branch return
 * `x` unchanged, as the spec requires.
 */
/**
 * `Math.hypot`, as the plain root of the sum of squares.
 *
 * The ECMAScript spec leaves `Math.hypot` implementation-approximated, so
 * no port can match V8 by construction; this is the adaptation the splat
 * folds record as `splat-hypot-approximation`. One home rather than one per
 * generated translation unit, for the reason `round_js` below has one.
 */
[[nodiscard]] inline double hypot_js(std::initializer_list<double> values) {
    double sum = 0.0;
    for (double value : values) {
        sum += value * value;
    }
    return std::sqrt(sum);
}

[[nodiscard]] inline double round_js(double value) {
    if (!std::isfinite(value) || value == 0.0) {
        return value;
    }
    const double floored = std::floor(value);
    return value - floored >= 0.5 ? floored + 1.0 : floored;
}

// Deterministic Math.random: mulberry32 over a pinned seed. The browser
// reference capture installs the identical generator before module load, so
// both sides consume the same sequence (recorded as a fidelity adaptation).
inline std::uint32_t& random_state() {
    static std::uint32_t state = 1u;
    return state;
}

inline void seed_random(std::uint32_t seed) {
    random_state() = seed;
}

[[nodiscard]] inline double random_js() {
    std::uint32_t& state = random_state();
    state += 0x6D2B79F5u;
    std::uint32_t t = state;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>((t ^ (t >> 14))) / 4294967296.0;
}

}  // namespace bbl::js
