#pragma once

// Plain-data JavaScript runtime support for compiled scene logic: dynamic
// arrays, nullable objects, readonly views, all-number tuples, JavaScript
// Math semantics, and the deterministic seeded Math.random replacement.
// Header-only; reached only when the entry scene compiles plain-data code.

#include <algorithm>
#include <array>
#include <cassert>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <list>
#include <memory>
#include <optional>
#include <initializer_list>
#include <iterator>
#include <span>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

namespace bbl::js {

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

    [[nodiscard]] std::size_t byte_length() const { return bytes_->size(); }
    [[nodiscard]] const std::uint8_t* data() const { return bytes_->data(); }
    [[nodiscard]] std::uint8_t* data() { return bytes_->data(); }
    [[nodiscard]] const std::vector<std::uint8_t>& bytes() const {
        return *bytes_;
    }
    [[nodiscard]] const std::shared_ptr<std::vector<std::uint8_t>>& storage() const {
        return bytes_;
    }

  private:
    std::shared_ptr<std::vector<std::uint8_t>> bytes_;
};

/** A Uint8Array view. Subarrays share storage; slices own a copy. */
class U8Array {
  public:
    using value_type = std::uint8_t;
    using iterator = value_type*;
    using const_iterator = const value_type*;

    U8Array()
        : storage_(std::make_shared<std::vector<std::uint8_t>>()) {}
    explicit U8Array(std::size_t length)
        : storage_(std::make_shared<std::vector<std::uint8_t>>(length, 0u)),
          length_(length) {}
    explicit U8Array(const ArrayBuffer& buffer)
        : storage_(buffer.storage()), length_(buffer.byte_length()) {}
    U8Array(
        const ArrayBuffer& buffer,
        std::size_t byte_offset,
        std::size_t length)
        : storage_(buffer.storage()),
          offset_(byte_offset),
          length_(length) {
        if (offset_ > buffer.byte_length() ||
            length_ > buffer.byte_length() - offset_) {
            throw std::runtime_error("Uint8Array exceeds ArrayBuffer.");
        }
    }

    [[nodiscard]] std::size_t size() const { return length_; }
    [[nodiscard]] std::size_t length() const { return length_; }
    [[nodiscard]] std::uint8_t* data() { return storage_->data() + offset_; }
    [[nodiscard]] const std::uint8_t* data() const { return storage_->data() + offset_; }
    [[nodiscard]] iterator begin() { return data(); }
    [[nodiscard]] iterator end() { return data() + length_; }
    [[nodiscard]] const_iterator begin() const { return data(); }
    [[nodiscard]] const_iterator end() const { return data() + length_; }
    [[nodiscard]] std::uint8_t& operator[](std::size_t index) {
        return storage_->data()[offset_ + index];
    }
    [[nodiscard]] const std::uint8_t& operator[](std::size_t index) const {
        return storage_->data()[offset_ + index];
    }
    [[nodiscard]] ArrayBuffer buffer() const { return ArrayBuffer(storage_); }
    [[nodiscard]] std::size_t byte_offset() const { return offset_; }
    [[nodiscard]] std::size_t byte_length() const { return length_; }
    [[nodiscard]] std::vector<std::uint8_t> to_vector() const {
        return std::vector<std::uint8_t>(
            storage_->begin() + static_cast<std::ptrdiff_t>(offset_),
            storage_->begin() + static_cast<std::ptrdiff_t>(offset_ + length_));
    }
    [[nodiscard]] U8Array subarray(std::size_t begin, std::size_t end) const {
        begin = std::min(begin, length_);
        end = std::min(std::max(end, begin), length_);
        return U8Array(storage_, offset_ + begin, end - begin);
    }
    [[nodiscard]] U8Array slice(std::size_t begin, std::size_t end) const {
        const U8Array view = subarray(begin, end);
        std::vector<std::uint8_t> copied(
            view.storage_->begin() + static_cast<std::ptrdiff_t>(view.offset_),
            view.storage_->begin() + static_cast<std::ptrdiff_t>(view.offset_ + view.length_));
        return U8Array(ArrayBuffer(std::move(copied)));
    }

  private:
    U8Array(
        std::shared_ptr<std::vector<std::uint8_t>> storage,
        std::size_t offset,
        std::size_t length)
        : storage_(std::move(storage)), offset_(offset), length_(length) {}

    std::shared_ptr<std::vector<std::uint8_t>> storage_;
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
        : storage_(buffer.storage()),
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
    [[nodiscard]] std::uint16_t get_uint16(
        std::size_t offset,
        bool little_endian) const {
        require(offset, 2);
        const auto* bytes = storage_->data() + offset_ + offset;
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
        const auto* bytes = storage_->data() + offset_ + offset;
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

  private:
    void require(std::size_t offset, std::size_t width) const {
        if (!storage_ || offset > length_ || width > length_ - offset) {
            throw std::runtime_error("DataView read exceeds buffer.");
        }
    }

    std::shared_ptr<std::vector<std::uint8_t>> storage_;
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
    using Storage = std::vector<T>;
    using value_type = T;
    using iterator = typename Storage::iterator;
    using const_iterator = typename Storage::const_iterator;

    Array() : values_(std::make_shared<Storage>()) {}
    Array(std::initializer_list<T> values)
        : values_(std::make_shared<Storage>(values)) {}
    explicit Array(std::size_t count)
        : values_(std::make_shared<Storage>(count)) {}
    Array(std::size_t count, const T& value)
        : values_(std::make_shared<Storage>(count, value)) {}
    template <typename Iterator>
    Array(Iterator first, Iterator last)
        : values_(std::make_shared<Storage>(first, last)) {}

    [[nodiscard]] std::size_t size() const { return values_->size(); }
    [[nodiscard]] bool empty() const { return values_->empty(); }
    [[nodiscard]] T* data() { return values_->data(); }
    [[nodiscard]] const T* data() const { return values_->data(); }
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
    void push_back(const T& value) { values_->push_back(value); }
    void push_back(T&& value) { values_->push_back(std::move(value)); }
    void pop_back() { values_->pop_back(); }
    void reserve(std::size_t count) { values_->reserve(count); }
    void resize(std::size_t count) { values_->resize(count); }
    void clear() { values_->clear(); }
    iterator erase(iterator position) { return values_->erase(position); }
    template <typename Iterator>
    iterator insert(iterator position, Iterator first, Iterator last) {
        return values_->insert(position, first, last);
    }

    [[nodiscard]] bool operator==(const Array& other) const {
        return values_ == other.values_;
    }

  private:
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

/** JavaScript indexed writes grow an Array and leave default-valued holes. */
template <typename T>
[[nodiscard]] inline T& array_index_write(
    Array<T>& target,
    std::size_t index) {
    if (index >= target.size()) {
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
        requires std::is_constructible_v<T, U&&>
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

/** A nullable JavaScript object is already an empty/shared pointer. */
template <typename T>
struct MapGetResult<std::shared_ptr<T>> {
    using Type = std::shared_ptr<T>;

    [[nodiscard]] static Type missing() { return {}; }
    [[nodiscard]] static Type found(std::shared_ptr<T>& value) {
        return value;
    }
};

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
        : storage_(std::move(storage)), current_(current), end_(end) {
        ++storage_->iterator_count;
        skip_deleted();
    }
    InsertionOrderedIterator(const InsertionOrderedIterator& other)
        : storage_(other.storage_), current_(other.current_), end_(other.end_) {
        if (storage_) ++storage_->iterator_count;
    }
    InsertionOrderedIterator(InsertionOrderedIterator&& other) noexcept
        : storage_(std::move(other.storage_)),
          current_(other.current_),
          end_(other.end_) {}
    InsertionOrderedIterator& operator=(
        const InsertionOrderedIterator& other) {
        if (this == &other) return *this;
        release();
        storage_ = other.storage_;
        current_ = other.current_;
        end_ = other.end_;
        if (storage_) ++storage_->iterator_count;
        return *this;
    }
    InsertionOrderedIterator& operator=(
        InsertionOrderedIterator&& other) noexcept {
        if (this == &other) return *this;
        release();
        storage_ = std::move(other.storage_);
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

  private:
    void release() {
        if (!storage_) return;
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
    BaseIterator current_;
    BaseIterator end_;
};

/** Insertion-ordered JavaScript Map and Set containers. */
template <typename K, typename V>
class Map {
  public:
    using Entry = std::pair<K, V>;
    using Slot = InsertionOrderedSlot<Entry>;
    using Iterator = InsertionOrderedIterator<Entry, false>;
    using ConstIterator = InsertionOrderedIterator<Entry, true>;

    Map() = default;
    Map(std::initializer_list<Entry> entries) {
        for (const Entry& entry : entries) set(entry.first, entry.second);
    }

    [[nodiscard]] bool has(const K& key) const {
        return find(key) != storage_->index.end();
    }
    [[nodiscard]] typename MapGetResult<V>::Type get(const K& key) const {
        const auto entry = find(key);
        return entry == storage_->index.end()
            ? MapGetResult<V>::missing()
            : MapGetResult<V>::found(entry->second->value.second);
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
        const auto entry = find(key);
        if (entry == storage_->index.end()) {
            storage_->entries.push_back(
                Slot{Entry{key, value}});
            storage_->index.emplace(
                key,
                std::prev(storage_->entries.end()));
        } else {
            entry->second->value.second = value;
        }
        return *this;
    }
    [[nodiscard]] bool erase(const K& key) {
        const auto entry = find(key);
        if (entry == storage_->index.end()) return false;
        const auto slot = entry->second;
        storage_->index.erase(entry);
        if (storage_->iterator_count > 0) {
            slot->active = false;
        } else {
            storage_->entries.erase(slot);
        }
        return true;
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

  private:
    using OrderedStorage = InsertionOrderedStorage<Entry>;
    struct Storage : OrderedStorage {
        std::unordered_map<
            K,
            typename OrderedStorage::Slots::iterator>
            index;
    };

    [[nodiscard]] auto find(const K& key) const {
        return storage_->index.find(key);
    }

    std::shared_ptr<Storage> storage_ =
        std::make_shared<Storage>();
};

template <typename T>
class Set {
  public:
    using Slot = InsertionOrderedSlot<T>;
    using Iterator = InsertionOrderedIterator<T, false>;
    using ConstIterator = InsertionOrderedIterator<T, true>;

    Set() = default;
    Set(std::initializer_list<T> values) {
        for (const T& value : values) add(value);
    }
    explicit Set(const Array<T>& values) {
        for (const T& value : values) add(value);
    }

    [[nodiscard]] bool has(const T& value) const {
        return find(value) != storage_->index.end();
    }
    Set& add(const T& value) {
        if (!has(value)) {
            storage_->entries.push_back(Slot{value});
            storage_->index.emplace(
                value,
                std::prev(storage_->entries.end()));
        }
        return *this;
    }
    [[nodiscard]] bool erase(const T& value) {
        const auto entry = find(value);
        if (entry == storage_->index.end()) return false;
        const auto slot = entry->second;
        storage_->index.erase(entry);
        if (storage_->iterator_count > 0) {
            slot->active = false;
        } else {
            storage_->entries.erase(slot);
        }
        return true;
    }
    void clear() {
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

  private:
    using OrderedStorage = InsertionOrderedStorage<T>;
    struct Storage : OrderedStorage {
        std::unordered_map<
            T,
            typename OrderedStorage::Slots::iterator>
            index;
    };

    [[nodiscard]] auto find(const T& value) const {
        return storage_->index.find(value);
    }

    std::shared_ptr<Storage> storage_ =
        std::make_shared<Storage>();
};

template <typename T>
using Span = std::span<T>;

template <std::size_t N>
using Tuple = std::array<double, N>;

// Primitive number interpolation for JavaScript template strings. The
// finite path uses the shortest round-trippable spelling supplied by
// `to_chars`; the exceptional spellings follow ECMAScript rather than the
// implementation-defined C library names.
[[nodiscard]] inline std::string number_to_string(double value) {
    if (std::isnan(value)) return "NaN";
    if (value == std::numeric_limits<double>::infinity()) return "Infinity";
    if (value == -std::numeric_limits<double>::infinity()) return "-Infinity";
    if (value == 0.0) return "0";
    char buffer[64];
    const auto converted = std::to_chars(
        buffer, buffer + sizeof(buffer), value,
        std::chars_format::general);
    assert(converted.ec == std::errc{});
    return std::string(buffer, converted.ptr);
}

[[nodiscard]] inline std::pair<std::size_t, std::size_t>
relative_slice_bounds(
    std::size_t length,
    double begin_value,
    double end_value) {
    const auto size = static_cast<std::ptrdiff_t>(length);
    const auto clamp = [size](double raw) {
        auto index = static_cast<std::ptrdiff_t>(
            std::trunc(raw));
        if (index < 0) {
            index = std::max<std::ptrdiff_t>(
                0,
                size + index);
        }
        return std::min(size, index);
    };
    const auto begin = clamp(begin_value);
    const auto end = std::max(begin, clamp(end_value));
    return {
        static_cast<std::size_t>(begin),
        static_cast<std::size_t>(end),
    };
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

[[nodiscard]] inline bool string_starts_with(
    const std::string& value,
    const std::string& prefix) {
    return value.starts_with(prefix);
}

[[nodiscard]] inline double string_char_code_at(
    const std::string& value,
    double index_value) {
    const auto index = static_cast<std::size_t>(std::max(0.0, std::trunc(index_value)));
    return index < value.size()
        ? static_cast<unsigned char>(value[index])
        : std::numeric_limits<double>::quiet_NaN();
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

// `array.pop()!` — the compiled subset asserts the array is non-empty.
template <typename T>
inline T array_pop(Array<T>& values) {
    assert(!values.empty());
    T last = values.back();
    values.pop_back();
    return last;
}

// `array.fill(value)` on an existing array.
template <typename T>
inline void array_fill(Array<T>& values, const T& value) {
    for (T& entry : values) {
        entry = value;
    }
}

// Typed arrays except Uint8Array use contiguous native vectors. Keep their
// JavaScript `fill` route beside the ordinary Array overload so every typed
// array kind accepted by the data lowerer has the same runtime operation.
template <typename T>
inline void array_fill(std::vector<T>& values, const T& value) {
    std::fill(values.begin(), values.end(), value);
}

// `new Array<T>(count).fill(value)`.
template <typename T>
[[nodiscard]] inline Array<T> array_filled(double count, const T& value) {
    return Array<T>(static_cast<std::size_t>(count), value);
}

// `array.splice(index, 1)` — remove one element and shift the tail down,
// the removal form the reached subset compiles (the particle sweep).
template <typename T>
inline void array_splice_one(Array<T>& values, double index) {
    const auto position = static_cast<std::size_t>(index);
    assert(position < values.size());
    values.erase(values.begin() + static_cast<std::ptrdiff_t>(position));
}

// `array.length = count` — the reached subset only shrinks (truncation).
template <typename T>
inline void array_truncate(Array<T>& values, double count) {
    const auto size = static_cast<std::size_t>(count);
    assert(size <= values.size());
    values.resize(size);
}

[[nodiscard]] inline std::size_t array_index(double index) {
    return static_cast<std::size_t>(index);
}

template <typename T>
[[nodiscard]] inline bool array_has_index(
    const T& values,
    double index) {
    return std::isfinite(index) &&
        index >= 0.0 &&
        std::floor(index) == index &&
        index < static_cast<double>(values.size());
}

template <typename T>
inline T missing_array_value{};

template <typename T>
[[nodiscard]] inline T& array_at_or_default(
    Array<T>& values,
    double index) {
    return array_has_index(values, index)
        ? values[array_index(index)]
        : missing_array_value<T>;
}

template <typename T>
[[nodiscard]] inline const T& array_at_or_default(
    const Array<T>& values,
    double index) {
    return array_has_index(values, index)
        ? values[array_index(index)]
        : missing_array_value<T>;
}

// JavaScript `%` (remainder keeps the dividend sign, like std::fmod).
[[nodiscard]] inline double remainder_js(double left, double right) {
    return std::fmod(left, right);
}

// JavaScript Math.round: a half rounds toward +Infinity, where std::round
// rounds it away from zero. The two disagree at -0.5, -1.5, ...
[[nodiscard]] inline double round_number(double value) {
    return std::floor(value + 0.5);
}

// Numeric `a || b`: 0 and NaN fall through to the fallback.
[[nodiscard]] inline double or_number(double value, double fallback) {
    return (value != 0.0 && !std::isnan(value)) ? value : fallback;
}

[[nodiscard]] inline bool number_truthy(double value) {
    return value != 0.0 && !std::isnan(value);
}

// JavaScript typed arrays reached by the compiled subset.
using F32Array = std::vector<float>;
using U16Array = std::vector<std::uint16_t>;
using U32Array = std::vector<std::uint32_t>;

// ECMAScript ToUint32: modulo 2^32 with truncation toward zero.
[[nodiscard]] inline std::uint32_t to_uint32(double value) {
    if (!std::isfinite(value)) {
        return 0u;
    }
    const double truncated = std::trunc(value);
    if (truncated >= 0.0 && truncated < 4294967296.0) {
        return static_cast<std::uint32_t>(truncated);
    }
    const double wrapped = std::fmod(truncated, 4294967296.0);
    return static_cast<std::uint32_t>(
        wrapped < 0.0 ? wrapped + 4294967296.0 : wrapped);
}

[[nodiscard]] inline std::int32_t uint32_as_int32(std::uint32_t value) {
    return value <= 0x7fffffffu
        ? static_cast<std::int32_t>(value)
        : static_cast<std::int32_t>(
              static_cast<std::int64_t>(value) - 0x100000000ll);
}

[[nodiscard]] inline double bitwise_not(double value) {
    return static_cast<double>(uint32_as_int32(~to_uint32(value)));
}

[[nodiscard]] inline double bitwise_and(double left, double right) {
    return static_cast<double>(
        uint32_as_int32(to_uint32(left) & to_uint32(right)));
}

[[nodiscard]] inline double bitwise_or(double left, double right) {
    return static_cast<double>(
        uint32_as_int32(to_uint32(left) | to_uint32(right)));
}

[[nodiscard]] inline double bitwise_xor(double left, double right) {
    return static_cast<double>(
        uint32_as_int32(to_uint32(left) ^ to_uint32(right)));
}

[[nodiscard]] inline double shift_left(double left, double right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    return static_cast<double>(
        uint32_as_int32(to_uint32(left) << count));
}

[[nodiscard]] inline double shift_right(double left, double right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    const std::uint32_t value = to_uint32(left);
    const std::uint32_t shifted = count == 0u
        ? value
        : (value >> count) |
              ((value & 0x80000000u) != 0u
                  ? (~std::uint32_t{0} << (32u - count))
                  : 0u);
    return static_cast<double>(uint32_as_int32(shifted));
}

[[nodiscard]] inline double shift_right_unsigned(double left, double right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    return static_cast<double>(to_uint32(left) >> count);
}

[[nodiscard]] inline std::uint16_t to_uint16(double value) {
    return static_cast<std::uint16_t>(to_uint32(value));
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

inline void array_fill(U8Array& values, std::uint8_t value) {
    std::fill(values.begin(), values.end(), value);
}

[[nodiscard]] inline F32Array f32_array_sized(double count) {
    return F32Array(static_cast<std::size_t>(count), 0.0f);
}

[[nodiscard]] inline U16Array u16_array_sized(double count) {
    return U16Array(static_cast<std::size_t>(count), 0u);
}

[[nodiscard]] inline U32Array u32_array_sized(double count) {
    return U32Array(static_cast<std::size_t>(count), 0u);
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
[[nodiscard]] inline F32Array f32_array_from(const Values& values) {
    return typed_array_from_values<F32Array>(values, [](double value) {
        return static_cast<float>(value);
    });
}

template <typename Values>
[[nodiscard]] inline U32Array u32_array_from(const Values& values) {
    return typed_array_from_values<U32Array>(values, to_uint32);
}

/**
 * `%TypedArray%.prototype.set(source, offset)` for two arrays of one kind.
 *
 * The spec copies `source` whole into `target` starting at `offset` and
 * raises a RangeError when the run would not fit, so no element is ever
 * written past the end. The compiled subset asserts that instead, the way
 * `array_pop` asserts non-emptiness: a compiled scene's lengths and offset
 * are its own, and a run that does not fit is a scene bug rather than a
 * condition a native frame could report.
 */
template <typename T>
inline void typed_array_set(
    std::vector<T>& target,
    const std::vector<T>& source,
    double offset) {
    const auto start = static_cast<std::size_t>(offset);
    assert(offset >= 0.0);
    assert(start + source.size() <= target.size());
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
