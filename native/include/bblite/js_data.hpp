#pragma once

#include <bblite/byte_hash.hpp>
#include <bblite/js_binding.hpp>
#include <bblite/js_module_namespace.hpp>
#include <bblite/js_callback.hpp>
#include <bblite/js_error.hpp>
#include <bblite/js_accessor.hpp>
#include <bblite/dom_event_state.hpp>

// Plain-data JavaScript runtime support for compiled scene logic: dynamic
// arrays, nullable objects, readonly views, all-number tuples, JavaScript
// Math semantics, and the deterministic seeded Math.random replacement.
// Header-only; reached only when the entry scene compiles plain-data code.

#include <algorithm>
#include <array>
#include <bit>
#include <cassert>
#include <charconv>
#if defined(__APPLE__)
#include <boost/charconv/to_chars.hpp>
#endif
#include <chrono>
#include <cmath>
#include <cstddef>
#include <coroutine>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <functional>
#include <limits>
#include <list>
#include <memory>
#include <map>
#include <optional>
#include <regex>
#include <initializer_list>
#include <iterator>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <tuple>
#include <utility>
#include <variant>
#include <vector>

namespace bbl::js {

[[nodiscard]] inline bool object_prototype_has_property(std::string_view key) {
    for (const auto name :
         {"constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty",
          "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable",
          "toLocaleString", "toString", "valueOf", "__proto__"})
        if (key == name)
            return true;
    return false;
}

/** A required record field can hold undefined while retaining its own key. */
struct Undefined {
    friend bool operator==(Undefined, Undefined) = default;
};

/** Transfer a compiler-owned temporary into its source binding. */
template <typename T> [[nodiscard]] T take_temporary(T& value) {
    static_assert(!std::is_const_v<T>);
    if constexpr (std::is_trivially_copyable_v<T>)
        return value;
    else
        return std::move(value);
}

// Apple's system libc++ only provides floating to_chars from macOS 13.3.
#if defined(__APPLE__)
namespace number_chars = boost::charconv;
// Request the shortest significand; Boost's general mode can choose an exact
// integer spelling with extra significant digits. JS chooses decimal layout below.
inline constexpr auto shortest_number_format = number_chars::chars_format::scientific;
#else
namespace number_chars = std;
inline constexpr auto shortest_number_format = number_chars::chars_format::general;
#endif

[[nodiscard]] inline bool number_truthy(double value);

template <typename... T> [[nodiscard]] bool union_truthy(const std::variant<T...>& value) {
    return std::visit(
        [](const auto& member) {
            using Member = std::decay_t<decltype(member)>;
            if constexpr (std::is_same_v<Member, double>)
                return number_truthy(member);
            else if constexpr (std::is_same_v<Member, bool>)
                return member;
            else if constexpr (std::is_same_v<Member, std::string>)
                return !member.empty();
            else
                return true;
        },
        value);
}

template <typename T> class TypedArray;
template <typename Values, typename Owner = Values> class TypedArraySlot;
template <typename T> [[nodiscard]] T numeric_store_value(double value);

/** Integer-indexed typed-array stores ignore absent indices, as JavaScript does. */
template <typename Values> void typed_array_write(Values& values, double index, double value) {
    if (!std::isfinite(index) || index < 0 || std::trunc(index) != index ||
        index >= static_cast<double>(values.size()))
        return;
    values.store(static_cast<std::size_t>(index),
                 numeric_store_value<typename Values::value_type>(value));
}

/** Runs a JavaScript finally block on every exit from its native scope. */
template <typename F> class Finally {
public:
    explicit Finally(F action) : action_(std::move(action)) {}
    Finally(const Finally&) = delete;
    Finally& operator=(const Finally&) = delete;
    Finally(Finally&&) = delete;
    Finally& operator=(Finally&&) = delete;
    // A finally body reached by an early exit may throw, as JavaScript's
    // does. Exceptional paths run the guard explicitly (or skip it while
    // unwinding), so this destructor never throws during unwinding.
    ~Finally() noexcept(false) { run(); }
    void run() noexcept(noexcept(action_())) {
        if (!pending_)
            return;
        pending_ = false;
        action_();
    }

private:
    F action_;
    bool pending_ = true;
};

template <typename F> [[nodiscard]] Finally<std::decay_t<F>> finally(F&& action) {
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
    ArrayBuffer() : bytes_(std::make_shared<std::vector<std::uint8_t>>()) {}
    explicit ArrayBuffer(std::vector<std::uint8_t> bytes)
        : bytes_(std::make_shared<std::vector<std::uint8_t>>(std::move(bytes))) {}
    explicit ArrayBuffer(std::shared_ptr<std::vector<std::uint8_t>> bytes)
        : bytes_(std::move(bytes)) {}
    template <typename T>
        requires std::is_trivially_copyable_v<T>
    explicit ArrayBuffer(const TypedArray<T>& values) : ArrayBuffer(values.buffer()) {}
    template <typename T>
        requires std::is_trivially_copyable_v<T>
    explicit ArrayBuffer(const std::shared_ptr<std::vector<T>>& values)
        : external_owner_(values), external_data_(reinterpret_cast<std::uint8_t*>(values->data())),
          external_length_(values->size() * sizeof(T)) {}
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
        : external_data_(reinterpret_cast<std::uint8_t*>(const_cast<T*>(values.data()))),
          external_length_(values.size() * sizeof(T)) {}

    [[nodiscard]] std::size_t byte_length() const {
        return bytes_ ? bytes_->size() : external_length_;
    }
    [[nodiscard]] const std::uint8_t* data() const {
        return bytes_ ? bytes_->data() : external_data_;
    }
    [[nodiscard]] std::uint8_t* data() { return bytes_ ? bytes_->data() : external_data_; }
    [[nodiscard]] const std::vector<std::uint8_t>& bytes() const {
        if (!bytes_) {
            throw std::runtime_error("A typed-array-backed ArrayBuffer has no owned byte vector.");
        }
        return *bytes_;
    }
    [[nodiscard]] const std::shared_ptr<std::vector<std::uint8_t>>& storage() const {
        return bytes_;
    }
    [[nodiscard]] bool retains_storage() const { return bytes_ || external_owner_; }
    [[nodiscard]] const void* identity() const {
        return bytes_ ? static_cast<const void*>(bytes_.get()) : external_owner_.get();
    }
    [[nodiscard]] friend bool operator==(const ArrayBuffer& left, const ArrayBuffer& right) {
        if (!left.retains_storage() || !right.retains_storage()) {
            throw std::runtime_error("Borrowed ArrayBuffer identity is not represented.");
        }
        return left.identity() == right.identity();
    }

private:
    std::shared_ptr<std::vector<std::uint8_t>> bytes_;
    std::shared_ptr<void> external_owner_;
    std::uint8_t* external_data_ = nullptr;
    std::size_t external_length_ = 0;
};

/** ToIndex for numeric buffer-view arguments; validate after truncation. */
[[nodiscard]] inline std::size_t buffer_view_index(double value) {
    const double integer = std::isnan(value) ? 0.0 : std::trunc(value);
    if (integer < 0.0 || integer > 9007199254740991.0 ||
        integer >= static_cast<double>(std::numeric_limits<std::size_t>::max())) {
        throw std::runtime_error("TypedArray offset or length is outside ToIndex range.");
    }
    return static_cast<std::size_t>(integer);
}

/** Numeric arrays share object identity when assigned, captured or returned.
 * Owned storage preserves the existing native vector arm. A source buffer
 * view instead retains bytes and uses scalar copies: no T object, pointer or
 * reference is invented inside a byte vector's allocation. */
template <typename T> class TypedArray {
public:
    using value_type = T;
    using iterator = typename std::vector<T>::iterator;
    using const_iterator = typename std::vector<T>::const_iterator;

    TypedArray() : values_(std::make_shared<std::vector<T>>()) {}
    explicit TypedArray(std::size_t count) : values_(std::make_shared<std::vector<T>>(count)) {}
    TypedArray(std::size_t count, const T& value)
        : values_(std::make_shared<std::vector<T>>(count, value)) {}
    TypedArray(std::initializer_list<T> values)
        : values_(std::make_shared<std::vector<T>>(values)) {}
    TypedArray(std::vector<T> values)
        : values_(std::make_shared<std::vector<T>>(std::move(values))) {}
    explicit TypedArray(std::shared_ptr<std::vector<T>> values) : values_(std::move(values)) {}
    template <typename Iterator>
    TypedArray(Iterator first, Iterator last)
        : values_(std::make_shared<std::vector<T>>(first, last)) {}
    explicit TypedArray(const ArrayBuffer& buffer, double byte_offset = 0.0,
                        std::optional<double> length = std::nullopt) {
        if (!buffer.retains_storage()) {
            throw std::runtime_error(
                "Numeric TypedArray views require retained ArrayBuffer storage.");
        }
        const std::size_t offset = buffer_view_index(byte_offset);
        const std::optional<std::size_t> count =
            length ? std::optional<std::size_t>{buffer_view_index(*length)} : std::nullopt;
        if (offset % sizeof(T) != 0 || offset > buffer.byte_length()) {
            throw std::runtime_error("TypedArray byte offset is unaligned or exceeds ArrayBuffer.");
        }
        const std::size_t available = buffer.byte_length() - offset;
        if ((!count && available % sizeof(T) != 0) || (count && *count > available / sizeof(T))) {
            throw std::runtime_error("TypedArray length is unaligned or exceeds ArrayBuffer.");
        }
        view_ = std::make_shared<BufferView>(buffer, offset, count.value_or(available / sizeof(T)));
    }

    [[nodiscard]] std::size_t size() const { return view_ ? view_->length : values_->size(); }
    [[nodiscard]] bool empty() const { return size() == 0; }
    [[nodiscard]] ArrayBuffer buffer() const {
        return view_ ? view_->buffer : ArrayBuffer(values_);
    }
    [[nodiscard]] std::size_t byte_offset() const { return view_ ? view_->offset : 0; }
    [[nodiscard]] std::size_t byte_length() const { return size() * sizeof(T); }
    /** Whether the elements live in owned contiguous storage rather than a buffer view. */
    [[nodiscard]] bool owns_elements() const { return !view_; }
    [[nodiscard]] const void* identity() const {
        return view_ ? static_cast<const void*>(view_.get())
                     : static_cast<const void*>(values_.get());
    }
    [[nodiscard]] std::shared_ptr<void> shared_identity() const {
        return view_ ? std::shared_ptr<void>(view_) : std::shared_ptr<void>(values_);
    }
    [[nodiscard]] friend bool operator==(const TypedArray& left, const TypedArray& right) {
        return left.identity() == right.identity();
    }

    [[nodiscard]] T load(std::size_t index) const {
        if (!view_)
            return (*values_)[index];
        if (index >= view_->length)
            throw std::runtime_error("TypedArray view read exceeds its length.");
        T result;
        std::memcpy(&result, view_->buffer.data() + view_->offset + index * sizeof(T), sizeof(T));
        return result;
    }
    void store(std::size_t index, T value) {
        if (!view_) {
            (*values_)[index] = value;
            return;
        }
        if (index >= view_->length)
            throw std::runtime_error("TypedArray view write exceeds its length.");
        std::memcpy(view_->buffer.data() + view_->offset + index * sizeof(T), &value, sizeof(T));
    }
    [[nodiscard]] TypedArraySlot<TypedArray> slot(std::size_t index);

    /** Copy a validated element range, preserving raw numeric bits in views. */
    [[nodiscard]] TypedArray copy_range(std::size_t begin, std::size_t end) const {
        if (!view_)
            return TypedArray(values_->begin() + begin, values_->begin() + end);
        TypedArray result(end - begin);
        if (end != begin)
            std::memcpy(result.data(), view_->buffer.data() + view_->offset + begin * sizeof(T),
                        (end - begin) * sizeof(T));
        return result;
    }

    [[nodiscard]] T* data() { return owned().data(); }
    [[nodiscard]] const T* data() const { return owned().data(); }
    [[nodiscard]] iterator begin() { return owned().begin(); }
    [[nodiscard]] iterator end() { return owned().end(); }
    [[nodiscard]] const_iterator begin() const { return owned().begin(); }
    [[nodiscard]] const_iterator end() const { return owned().end(); }
    [[nodiscard]] const_iterator cbegin() const { return owned().cbegin(); }
    [[nodiscard]] const_iterator cend() const { return owned().cend(); }
    [[nodiscard]] T& operator[](std::size_t index) { return owned()[index]; }
    [[nodiscard]] const T& operator[](std::size_t index) const { return owned()[index]; }
    [[nodiscard]] T& at(std::size_t index) { return owned().at(index); }
    [[nodiscard]] const T& at(std::size_t index) const { return owned().at(index); }
    [[nodiscard]] T& front() { return owned().front(); }
    [[nodiscard]] const T& front() const { return owned().front(); }
    [[nodiscard]] T& back() { return owned().back(); }
    [[nodiscard]] const T& back() const { return owned().back(); }
    void reserve(std::size_t count) { owned().reserve(count); }
    void resize(std::size_t count) { owned().resize(count); }
    void resize(std::size_t count, const T& value) { owned().resize(count, value); }
    void clear() { owned().clear(); }
    void push_back(const T& value) { owned().push_back(value); }
    void push_back(T&& value) { owned().push_back(std::move(value)); }
    [[nodiscard]] operator std::vector<T>&() { return owned(); }
    [[nodiscard]] operator const std::vector<T>&() const { return owned(); }
    [[nodiscard]] const std::shared_ptr<std::vector<T>>& storage() const {
        static_cast<void>(owned());
        return values_;
    }

private:
    struct BufferView {
        ArrayBuffer buffer;
        std::size_t offset = 0;
        std::size_t length = 0;
    };
    [[nodiscard]] std::vector<T>& owned() const {
        if (view_) {
            throw std::runtime_error(
                "Numeric TypedArray buffer views do not support this contiguous native access or method.");
        }
        return *values_;
    }
    std::shared_ptr<std::vector<T>> values_;
    std::shared_ptr<BufferView> view_;
};

/** A source element reference retains its evaluated view even if the RHS
 * reassigns the array binding. The compiler supplies the JS store conversion. */
/** A typed-array element as an lvalue; `Owner` holds the view (`Values`) or borrows it (`Values&`). */
template <typename Values, typename Owner> class TypedArraySlot {
public:
    using value_type = typename Values::value_type;
    TypedArraySlot(Owner owner, std::size_t index)
        : owner_(std::forward<Owner>(owner)), index_(index) {}
    TypedArraySlot(const TypedArraySlot&) = default;
    [[nodiscard]] operator value_type() const { return owner_.load(index_); }
    TypedArraySlot& operator=(value_type value) {
        owner_.store(index_, value);
        return *this;
    }
    TypedArraySlot& operator=(const TypedArraySlot& source) {
        return *this = static_cast<value_type>(source);
    }
    double operator++() { return increment(1.0, true); }
    double operator--() { return increment(-1.0, true); }
    double operator++(int) { return increment(1.0, false); }
    double operator--(int) { return increment(-1.0, false); }

private:
    double increment(double delta, bool prefix) {
        const double previous = static_cast<double>(owner_.load(index_));
        const double next = previous + delta;
        owner_.store(index_, numeric_store_value<value_type>(next));
        return prefix ? next : previous;
    }
    Owner owner_;
    std::size_t index_;
};
template <typename T>
[[nodiscard]] TypedArraySlot<TypedArray<T>> TypedArray<T>::slot(std::size_t index) {
    return {*this, index};
}

/**
 * A source element reference that does not own its view. The compiler
 * selects it for a named owner only when nothing evaluated between the
 * element and its store writes any storage, so the binding can neither be
 * replaced nor release the view before the store.
 */
template <typename Values> using BorrowedTypedArraySlot = TypedArraySlot<Values, Values&>;

template <typename Values>
[[nodiscard]] decltype(auto) typed_array_load(const Values& values, std::size_t index) {
    if constexpr (requires { values.load(index); })
        return values.load(index);
    else
        return values[index];
}
template <typename Values>
[[nodiscard]] decltype(auto) typed_array_slot(Values& values, std::size_t index) {
    if constexpr (requires { values.slot(index); })
        return values.slot(index);
    else
        return values[index];
}
/** `typed_array_slot` for a store that cannot replace or release the owner. */
template <typename Values>
[[nodiscard]] decltype(auto) typed_array_borrowed_slot(Values& values, std::size_t index) {
    if constexpr (requires { values.slot(index); })
        return BorrowedTypedArraySlot<Values>(values, index);
    else
        return values[index];
}
template <typename Values> [[nodiscard]] std::size_t typed_array_byte_offset(const Values& values) {
    if constexpr (requires { values.byte_offset(); })
        return values.byte_offset();
    else
        return 0;
}

/** Retain object identity before an index expression invokes source code. */
template <typename Values> [[nodiscard]] Values retain_typed_array_owner(const Values& values) {
    if constexpr (requires(Values& owner) { owner.slot(std::size_t{}); }) {
        return values;
    } else {
        throw std::runtime_error(
            "An effectful numeric index requires retained typed-array storage, not a borrowed native vector.");
    }
}

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
 * `make_shared` fuses them. WeakMap keys allocate a lifetime token on demand.
 */
template <typename T> class Ref {
    struct Block;

public:
    // Each block keeps its unique storage owner until its last counted reference.
    // Receiver scopes carry that owner temporarily and count as external GC roots.
    class LifetimeOwner {
    public:
        LifetimeOwner(const LifetimeOwner&) = delete;
        LifetimeOwner& operator=(const LifetimeOwner&) = delete;
        LifetimeOwner(LifetimeOwner&&) = delete;
        LifetimeOwner& operator=(LifetimeOwner&&) = delete;
        ~LifetimeOwner() {
            if (!block_)
                return;
            if (block_->active_owner != this) {
                // Suspended activations can release receiver scopes out of order.
                auto* successor = block_->active_owner;
                while (successor && successor->previous_ != this)
                    successor = successor->previous_;
                if (!successor || owner_)
                    std::terminate();
                successor->previous_ = previous_;
                block_->release();
                return;
            }
            if (!owner_ || owner_.get() != block_)
                std::terminate();
            block_->release();
            block_->active_owner = previous_;
            if (previous_)
                previous_->owner_ = std::move(owner_);
            else if (block_->count != 0)
                block_->lifetime = std::move(owner_);
        }

    private:
        friend class Ref;
        explicit LifetimeOwner(Block* block)
            : block_(block), previous_(block ? block->active_owner : nullptr) {
            if (!block_)
                return;
            block_->retain();
            owner_ = previous_ ? std::move(previous_->owner_) : std::move(block_->lifetime);
            if (!owner_ || owner_.get() != block_)
                std::terminate();
            block_->active_owner = this;
        }
        Block* block_ = nullptr;
        LifetimeOwner* previous_ = nullptr;
        std::unique_ptr<Block> owner_;
    };

    using element_type = T;

    Ref() = default;
    Ref(const Ref& other) : block_(other.block_) {
        if (block_)
            block_->retain();
    }
    Ref(Ref&& other) noexcept : block_(other.block_) { other.block_ = nullptr; }
    Ref& operator=(const Ref& other) {
        auto* replacement = other.block_;
        if (replacement)
            replacement->retain();
        auto* released = block_;
        block_ = replacement;
        if (released)
            released->release();
        return *this;
    }
    Ref& operator=(Ref&& other) noexcept {
        if (this == &other)
            return *this;
        auto* released = block_;
        block_ = other.block_;
        other.block_ = nullptr;
        if (released)
            released->release();
        return *this;
    }
    ~Ref() { reset(); }

    void swap(Ref& other) noexcept {
        auto* previous = block_;
        block_ = other.block_;
        other.block_ = previous;
    }
    void reset() {
        auto* released = block_;
        block_ = nullptr;
        if (released)
            released->release();
    }
    [[nodiscard]] LifetimeOwner lifetime_owner() const { return LifetimeOwner(block_); }
    [[nodiscard]] T* get() const { return block_ ? std::addressof(block_->value) : nullptr; }
    [[nodiscard]] T& operator*() const { return require_value(); }
    [[nodiscard]] T* operator->() const { return std::addressof(require_value()); }
    explicit operator bool() const { return block_ != nullptr; }
    /** Only a registered block is an edge; `make_ref` registers traceable payloads. */
    void gc_trace(const TraceVisitor& visitor) const {
        if (block_ && block_->linked)
            visitor.edge(block_);
    }
    [[nodiscard]] std::weak_ptr<const void> weak_identity() const {
        if (!block_)
            return {};
        if (!block_->identity)
            block_->identity = std::make_shared<int>(0);
        return block_->identity;
    }

    [[nodiscard]] friend bool operator==(const Ref& left, const Ref& right) {
        return left.block_ == right.block_;
    }

private:
    T& require_value() const {
        if (!block_ || !block_->payload_alive)
            throw std::runtime_error("Cannot access a nullish object.");
        return block_->value;
    }

    struct Block final : gc::Node {
        template <typename... Args>
        explicit Block(Args&&... args) : value(std::forward<Args>(args)...) {
            this->payload_alive = true;
        }
        ~Block() override {
            this->detach();
            clear();
        }
        std::size_t count = 1;
        std::unique_ptr<Block> lifetime;
        LifetimeOwner* active_owner = nullptr;
        union {
            T value;
        };
        std::shared_ptr<const void> identity;
        void trace(const TraceVisitor& visitor) const override {
            if (this->payload_alive)
                visitor(value);
        }
        void clear() noexcept override {
            if (std::exchange(this->payload_alive, false)) {
                identity.reset();
                std::destroy_at(std::addressof(value));
            }
        }
        std::size_t owners() const noexcept override { return count; }
        void retain() noexcept {
            if (count == 0 || count == std::numeric_limits<std::size_t>::max())
                std::terminate();
            ++count;
        }
        void release() noexcept {
            if (count == 0)
                std::terminate();
            --count;
            if (count == 0) {
                auto owner = std::move(lifetime);
                if (!owner && !active_owner)
                    std::terminate();
            }
        }
        void pin() noexcept override { retain(); }
        void unpin() noexcept override { release(); }
    };

    template <typename U, typename... Args> friend Ref<U> make_ref(Args&&... args);

    explicit Ref(Block* block) : block_(block) {}

    Block* block_ = nullptr;
};

namespace gc {
/**
 * A reference is an edge exactly when `make_ref` registers its payload, so a
 * container of references to edge-free payloads stays out of the registry.
 */
template <typename T> struct Traceable<Ref<T>> : Traceable<std::remove_cv_t<T>> {};
} // namespace gc

/**
 * A payload that can own a traced edge joins cycle collection; any other
 * payload cannot close a cycle, and reference counting alone releases it.
 */
template <typename T, typename... Args> [[nodiscard]] Ref<T> make_ref(Args&&... args) {
    auto block = std::make_unique<typename Ref<T>::Block>(std::forward<Args>(args)...);
    if constexpr (gc_traceable<T>)
        block->attach();
    auto* value = block.get();
    value->lifetime = std::move(block);
    return Ref<T>(value);
}

/**
 * A non-owning reference whose constructor cannot represent null.
 *
 * Platform event payloads use this only while their synchronous dispatch
 * frame is active. The compiler rejects every retained copy; the wrapper
 * keeps ordinary record copies cheap without making the event an owning or
 * default-constructible JavaScript value.
 */
template <typename T> class Borrowed {
public:
    explicit Borrowed(T& value) noexcept : value_(std::addressof(value)) {}

    [[nodiscard]] T& get() const noexcept { return *value_; }

private:
    T* value_;
};

/**
 * The common DOM Event view borrows dispatch state and cancellation from its
 * payload, including when it crosses a helper typed as Event.
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
        : value_(std::addressof(value)), type_(&type_tag<T>),
          prevent_default_([](const void* borrowed) noexcept {
              static_cast<const T*>(borrowed)->prevent_default();
          }),
          default_prevented_([](const void* borrowed) noexcept {
              if constexpr (requires(const T & event) { event.is_default_prevented(); })
                  return static_cast<const T*>(borrowed)->is_default_prevented();
              else
                  return static_cast<const T*>(borrowed)->default_prevented;
          }) {
        dom = value.dom;
    }

    [[nodiscard]] const BorrowedEvent& get() const noexcept { return *this; }
    void prevent_default() const noexcept { prevent_default_(value_); }
    [[nodiscard]] bool is_default_prevented() const noexcept { return default_prevented_(value_); }
    void stop_propagation() const { bbl::dom_event_state(*this).stop_propagation(); }
    void stop_immediate_propagation() const {
        bbl::dom_event_state(*this).stop_immediate_propagation();
    }
    std::shared_ptr<bbl::DomEventState> dom;
    [[nodiscard]] BorrowedEvent retaining(std::shared_ptr<const void> owner) const {
        auto result = *this;
        result.owner_ = std::move(owner);
        return result;
    }

    template <typename T> [[nodiscard]] const T& payload() const {
        if (type_ != &type_tag<T>) {
            throw std::runtime_error("Borrowed DOM event has the wrong payload type.");
        }
        return *static_cast<const T*>(value_);
    }

    template <typename T> [[nodiscard]] const T& as() const {
        const auto& value = payload<T>();
        if constexpr (requires { value.has_mouse_payload(); }) {
            if (!value.has_mouse_payload())
                throw std::runtime_error("Borrowed DOM event has no mouse payload.");
        }
        return value;
    }

private:
    template <typename T> static inline const char type_tag = 0;
    const void* value_;
    std::shared_ptr<const void> owner_;
    const void* type_;
    void (*prevent_default_)(const void*) noexcept;
    bool (*default_prevented_)(const void*) noexcept;
};

/** A Uint8Array view. Subarrays share storage; slices own a copy. */
class U8Array {
public:
    using value_type = std::uint8_t;
    using iterator = value_type*;
    using const_iterator = const value_type*;

    U8Array() : U8Array(ArrayBuffer(), 0, 0) {}
    explicit U8Array(std::size_t length)
        : U8Array(ArrayBuffer(std::vector<std::uint8_t>(length, std::uint8_t{0})), 0, length) {}
    explicit U8Array(const ArrayBuffer& buffer) : U8Array(buffer, 0, buffer.byte_length()) {}
    U8Array(const ArrayBuffer& buffer, std::size_t byte_offset)
        : U8Array(buffer, byte_offset, buffer.byte_length() - byte_offset) {}
    U8Array(const ArrayBuffer& buffer, std::size_t byte_offset, std::size_t length)
        : view_(std::make_shared<View>(View{buffer, byte_offset})), length_(length) {
        if (byte_offset > buffer.byte_length() || length > buffer.byte_length() - byte_offset) {
            throw std::runtime_error("Uint8Array exceeds ArrayBuffer.");
        }
        data_ = view_->buffer.data() + byte_offset;
    }
    U8Array(const U8Array&) = default;
    U8Array& operator=(const U8Array&) = default;
    // A move takes the view block and leaves an empty, bufferless view, so a
    // moved-from value never reaches another view's bytes.
    U8Array(U8Array&& other) noexcept
        : view_(std::move(other.view_)), length_(std::exchange(other.length_, 0)),
          data_(std::exchange(other.data_, nullptr)) {}
    U8Array& operator=(U8Array&& other) noexcept {
        view_ = std::move(other.view_);
        length_ = std::exchange(other.length_, 0);
        data_ = std::exchange(other.data_, nullptr);
        return *this;
    }

    [[nodiscard]] std::size_t size() const { return length_; }
    [[nodiscard]] std::size_t length() const { return length_; }
    [[nodiscard]] std::uint8_t* data() { return data_; }
    [[nodiscard]] const std::uint8_t* data() const { return data_; }
    [[nodiscard]] iterator begin() { return data(); }
    [[nodiscard]] iterator end() { return data() + length_; }
    [[nodiscard]] const_iterator begin() const { return data(); }
    [[nodiscard]] const_iterator end() const { return data() + length_; }
    [[nodiscard]] std::uint8_t& operator[](std::size_t index) { return data()[index]; }
    [[nodiscard]] const std::uint8_t& operator[](std::size_t index) const { return data()[index]; }
    [[nodiscard]] std::uint8_t load(std::size_t index) const { return data()[index]; }
    void store(std::size_t index, std::uint8_t value) { data()[index] = value; }
    [[nodiscard]] TypedArraySlot<U8Array> slot(std::size_t index);
    [[nodiscard]] const void* identity() const { return view_.get(); }
    [[nodiscard]] std::shared_ptr<void> shared_identity() const { return view_; }
    [[nodiscard]] friend bool operator==(const U8Array& left, const U8Array& right) {
        return left.identity() == right.identity();
    }
    [[nodiscard]] ArrayBuffer buffer() const { return view_ ? view_->buffer : ArrayBuffer(); }
    [[nodiscard]] std::size_t byte_offset() const { return view_ ? view_->offset : 0; }
    [[nodiscard]] std::size_t byte_length() const { return length_; }
    [[nodiscard]] std::vector<std::uint8_t> to_vector() const {
        return std::vector<std::uint8_t>(data(), data() + length_);
    }
    [[nodiscard]] U8Array subarray(std::size_t begin, std::size_t end) const {
        begin = std::min(begin, length_);
        end = std::min(std::max(end, begin), length_);
        return U8Array(buffer(), byte_offset() + begin, end - begin);
    }
    [[nodiscard]] U8Array slice(std::size_t begin, std::size_t end) const {
        const U8Array view = subarray(begin, end);
        std::vector<std::uint8_t> copied(view.data(), view.data() + view.length_);
        return U8Array(ArrayBuffer(std::move(copied)));
    }

private:
    // One block per JavaScript view object: it retains the buffer and is
    // the view's identity, so a copy of the view takes a single reference.
    struct View {
        ArrayBuffer buffer;
        std::size_t offset = 0;
    };
    std::shared_ptr<View> view_;
    std::size_t length_ = 0;
    // The view's first byte. An ArrayBuffer never resizes its bytes, so the
    // address holds for the view's life and a read skips the buffer's owner.
    std::uint8_t* data_ = nullptr;
};
inline TypedArraySlot<U8Array> U8Array::slot(std::size_t index) { return {*this, index}; }

[[nodiscard]] inline std::uint32_t to_uint32(double value);

/** A DataView over shared ArrayBuffer storage. */
class DataView {
public:
    DataView() = default;
    explicit DataView(const ArrayBuffer& buffer, std::size_t byte_offset = 0,
                      std::size_t byte_length = std::numeric_limits<std::size_t>::max())
        : buffer_(buffer), offset_(byte_offset),
          length_(byte_length == std::numeric_limits<std::size_t>::max()
                      ? buffer.byte_length() - byte_offset
                      : byte_length) {
        if (offset_ > buffer.byte_length() || length_ > buffer.byte_length() - offset_) {
            throw std::runtime_error("DataView exceeds ArrayBuffer.");
        }
    }

    [[nodiscard]] ArrayBuffer buffer() const { return buffer_; }
    [[nodiscard]] std::size_t byte_offset() const { return offset_; }
    [[nodiscard]] std::size_t byte_length() const { return length_; }
    [[nodiscard]] const void* identity() const { return identity_.get(); }
    [[nodiscard]] std::shared_ptr<void> shared_identity() const { return identity_; }
    [[nodiscard]] friend bool operator==(const DataView& left, const DataView& right) {
        return left.identity() == right.identity();
    }
    [[nodiscard]] std::uint8_t get_uint8(std::size_t offset) const {
        require(offset, 1);
        return buffer_.data()[offset_ + offset];
    }
    [[nodiscard]] std::int8_t get_int8(std::size_t offset) const {
        return static_cast<std::int8_t>(get_uint8(offset));
    }
    [[nodiscard]] std::uint16_t get_uint16(std::size_t offset, bool little_endian) const {
        require(offset, 2);
        const auto* bytes = buffer_.data() + offset_ + offset;
        return little_endian ? static_cast<std::uint16_t>(bytes[0] | (bytes[1] << 8))
                             : static_cast<std::uint16_t>((bytes[0] << 8) | bytes[1]);
    }
    [[nodiscard]] std::int16_t get_int16(std::size_t offset, bool little_endian) const {
        return static_cast<std::int16_t>(get_uint16(offset, little_endian));
    }
    [[nodiscard]] std::uint32_t get_uint32(std::size_t offset, bool little_endian) const {
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
               (static_cast<std::uint32_t>(bytes[2]) << 8) | static_cast<std::uint32_t>(bytes[3]);
    }
    [[nodiscard]] std::int32_t get_int32(std::size_t offset, bool little_endian) const {
        return static_cast<std::int32_t>(get_uint32(offset, little_endian));
    }
    [[nodiscard]] float get_float32(std::size_t offset, bool little_endian) const {
        return std::bit_cast<float>(get_uint32(offset, little_endian));
    }
    [[nodiscard]] double get_float64(std::size_t offset, bool little_endian) const {
        require(offset, 8);
        const auto* bytes = buffer_.data() + offset_ + offset;
        std::uint64_t bits = 0;
        for (std::size_t index = 0; index < 8; ++index) {
            const std::size_t position = little_endian ? index : 7 - index;
            bits |= static_cast<std::uint64_t>(bytes[position]) << (8 * index);
        }
        return std::bit_cast<double>(bits);
    }
    // The setters store JavaScript's converted integer (ToInt8/ToUint32...)
    // or the float's bits, in the requested byte order.
    void set_uint8(std::size_t offset, double value) {
        require(offset, 1);
        buffer_.data()[offset_ + offset] = static_cast<std::uint8_t>(to_uint32(value));
    }
    void set_int8(std::size_t offset, double value) { set_uint8(offset, value); }
    void set_uint16(std::size_t offset, double value, bool little_endian) {
        store_bits(offset, 2, to_uint32(value), little_endian);
    }
    void set_int16(std::size_t offset, double value, bool little_endian) {
        set_uint16(offset, value, little_endian);
    }
    void set_uint32(std::size_t offset, double value, bool little_endian) {
        store_bits(offset, 4, to_uint32(value), little_endian);
    }
    void set_int32(std::size_t offset, double value, bool little_endian) {
        set_uint32(offset, value, little_endian);
    }
    void set_float32(std::size_t offset, double value, bool little_endian) {
        store_bits(offset, 4, std::bit_cast<std::uint32_t>(static_cast<float>(value)),
                   little_endian);
    }
    void set_float64(std::size_t offset, double value, bool little_endian) {
        store_bits(offset, 8, std::bit_cast<std::uint64_t>(value), little_endian);
    }

private:
    void store_bits(std::size_t offset, std::size_t width, std::uint64_t bits, bool little_endian) {
        require(offset, width);
        auto* bytes = buffer_.data() + offset_ + offset;
        for (std::size_t index = 0; index < width; ++index) {
            const std::size_t position = little_endian ? index : width - 1 - index;
            bytes[position] = static_cast<std::uint8_t>(bits >> (8 * index));
        }
    }
    void require(std::size_t offset, std::size_t width) const {
        if (offset > length_ || width > length_ - offset) {
            throw std::runtime_error("DataView read exceeds buffer.");
        }
    }

    ArrayBuffer buffer_;
    std::size_t offset_ = 0;
    std::size_t length_ = 0;
    std::shared_ptr<char> identity_ = std::make_shared<char>();
};

/** The byte-level ArrayBufferView interface retains the original view's identity and storage. */
class ArrayBufferView {
public:
    ArrayBufferView() = default;
    template <typename View>
        requires requires(const View& view) {
            view.buffer();
            view.byte_offset();
            view.byte_length();
            view.shared_identity();
        }
    explicit ArrayBufferView(const View& view)
        : buffer_(view.buffer()), offset_(view.byte_offset()), length_(view.byte_length()),
          identity_(view.shared_identity()) {}

    [[nodiscard]] ArrayBuffer buffer() const { return buffer_; }
    [[nodiscard]] std::size_t byte_offset() const { return offset_; }
    [[nodiscard]] std::size_t byte_length() const { return length_; }
    [[nodiscard]] const void* identity() const { return identity_.get(); }
    [[nodiscard]] std::shared_ptr<void> shared_identity() const { return identity_; }
    [[nodiscard]] friend bool operator==(const ArrayBufferView& left,
                                         const ArrayBufferView& right) {
        return left.identity() == right.identity();
    }

private:
    ArrayBuffer buffer_;
    std::size_t offset_ = 0;
    std::size_t length_ = 0;
    std::shared_ptr<void> identity_;
};

namespace detail {

template <typename Vector> struct DeleteVector {
    void operator()(Vector* vector) const noexcept { delete vector; }
};

/**
 * One thread's recycled vector storage of one type. Array and tuple storage
 * whose elements own no traced edge dies young -- a mesher's per-face corner
 * and light lists -- so a new array takes a cleared vector, capacity and
 * all, from here (and its control block from `RecycledBlocks`) instead of
 * allocating both. Only small vectors are kept, and only so many, so a
 * thread's list stays small.
 */
template <typename Vector> using RecycledVectors = RecycledList<Vector, 256, DeleteVector<Vector>>;
inline constexpr std::size_t recycled_vector_capacity = 64;

/** Returns a vector to its thread's list, cleared, or frees it. */
template <typename Vector> struct RecycleVector {
    void operator()(Vector* vector) const noexcept {
        auto* list = thread_list<RecycledVectors<Vector>>;
        if (list != nullptr && vector->capacity() <= recycled_vector_capacity) {
            vector->clear();
            if (list->keep(vector))
                return;
        }
        delete vector;
    }
};

/**
 * A fresh vector, shared: a recycled one when the thread keeps one, filled
 * by `fill` as a newly constructed vector would be.
 */
template <typename Vector, typename Fill>
[[nodiscard]] std::shared_ptr<Vector> make_recycled_vector(Fill&& fill) {
    Vector* vector = nullptr;
    if (auto* list = recycled_list<RecycledVectors<Vector>>())
        vector = list->take();
    if (vector == nullptr)
        vector = new Vector();
    try {
        std::forward<Fill>(fill)(*vector);
    } catch (...) {
        RecycleVector<Vector>{}(vector);
        throw;
    }
    return std::shared_ptr<Vector>(vector, RecycleVector<Vector>{},
                                   RecycledBlockAllocator<Vector, RecycledVectors<Vector>>{});
}

} // namespace detail

/**
 * JavaScript Array storage. Copying an Array copies the reference, not its
 * elements; explicit array-producing operations construct a fresh wrapper.
 */
template <typename T> class Array {
public:
    using Storage = std::conditional_t<std::is_same_v<T, bool>, std::deque<T>, std::vector<T>>;
    using value_type = T;
    using iterator = typename Storage::iterator;
    using const_iterator = typename Storage::const_iterator;

    Array() : values_(make_storage()) {}
    Array(std::initializer_list<T> values) : values_(make_storage(values)) {}
    explicit Array(std::size_t count) : values_(make_storage(count)) {}
    Array(std::size_t count, const T& value) : values_(make_storage(count, value)) {}
    template <typename Iterator>
    Array(Iterator first, Iterator last) : values_(make_storage(first, last)) {}
    /** Rewrap a native producer's retained JavaScript array without copying it. */
    explicit Array(std::shared_ptr<Storage> values) : values_(std::move(values)) {
        if (!values_)
            throw std::runtime_error("Array requires retained storage.");
    }
    [[nodiscard]] const std::shared_ptr<Storage>& retained_storage() const { return values_; }

    [[nodiscard]] std::size_t size() const { return values_->size(); }
    [[nodiscard]] bool empty() const { return values_->empty(); }
    [[nodiscard]] T* data()
        requires(!std::is_same_v<T, bool>)
    {
        return values_->data();
    }
    [[nodiscard]] const T* data() const
        requires(!std::is_same_v<T, bool>)
    {
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
    iterator erase(iterator first, iterator last) { return values_->erase(first, last); }
    template <typename Iterator> iterator insert(iterator position, Iterator first, Iterator last) {
        return values_->insert(position, first, last);
    }
    iterator insert(iterator position, std::initializer_list<T> values) {
        return values_->insert(position, values);
    }

    [[nodiscard]] bool operator==(const Array& other) const { return values_ == other.values_; }
    [[nodiscard]] const void* identity() const { return values_.get(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(values_); }

private:
    template <typename... Args> static std::shared_ptr<Storage> make_storage(Args&&... args) {
        if constexpr (gc_traceable<T> || std::is_same_v<T, bool>) {
            return make_gc_shared_if<gc_traceable<T>, Storage>(std::forward<Args>(args)...);
        } else {
            return detail::make_recycled_vector<Storage>(
                [&](Storage& storage) { fill_storage(storage, std::forward<Args>(args)...); });
        }
    }
    // A recycled vector is filled in place, keeping its capacity.
    static void fill_storage(Storage&) {}
    static void fill_storage(Storage& storage, std::initializer_list<T> values) {
        storage.assign(values);
    }
    static void fill_storage(Storage& storage, std::size_t count) { storage.resize(count); }
    static void fill_storage(Storage& storage, std::size_t count, const T& value) {
        storage.assign(count, value);
    }
    template <typename Iterator>
    static void fill_storage(Storage& storage, Iterator first, Iterator last) {
        storage.assign(first, last);
    }
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
namespace gc {
template <typename T> struct Traceable<Array<T>> : Traceable<T> {};
} // namespace gc

template <typename T, typename Iterable>
[[nodiscard]] inline Array<T> array_from_iterable(const Iterable& values) {
    if constexpr (std::is_same_v<decltype(values.begin()), decltype(values.end())>) {
        return Array<T>(values.begin(), values.end());
    } else {
        Array<T> result;
        for (const auto& value : values)
            result.push_back(value);
        return result;
    }
}

template <typename T, typename Iterable, typename Transform>
[[nodiscard]] inline Array<T> array_from_iterable(const Iterable& values, Transform transform) {
    Array<T> result;
    if constexpr (requires { values.size(); })
        result.reserve(values.size());
    for (const auto& value : values)
        result.push_back(transform(value));
    return result;
}

template <typename T, typename Iterable>
inline void array_append(Array<T>& target, const Iterable& values) {
    if constexpr (std::is_same_v<decltype(values.begin()), decltype(values.end())>) {
        target.insert(target.end(), values.begin(), values.end());
    } else {
        for (const auto& value : values)
            target.push_back(value);
    }
}

/** Materialize JavaScript array storage at a native std::vector sink. */
template <typename T> [[nodiscard]] inline std::vector<T> array_to_vector(const Array<T>& values) {
    return std::vector<T>(values.begin(), values.end());
}

/** JavaScript indexed writes grow an Array and leave default-valued holes. */
template <typename T>
[[nodiscard]] inline T& array_index_write(Array<T>& target, std::size_t index) {
    if (index >= target.size()) {
        if (index == std::numeric_limits<std::size_t>::max()) {
            // The sentinel `array_index` maps every unrepresentable double
            // to. Without this refusal `resize(index + 1)` wraps to
            // `resize(0)` and silently truncates the array.
            throw std::runtime_error("Array index write out of range.");
        }
        target.resize(index + 1);
    }
    return target[index];
}

/** JavaScript refuses a read through null or undefined. */
[[noreturn]] inline void throw_nullish_access() {
    throw std::runtime_error("Cannot access a nullish value.");
}

template <typename T> class Nullable {
public:
    Nullable() = default;
    Nullable(std::nullopt_t) {}
    Nullable(const T& value) : owned_(value) {}
    Nullable(T&& value) : owned_(std::move(value)) {}
    template <typename U>
        requires(!std::is_same_v<std::remove_cvref_t<U>, Nullable> &&
                 std::is_constructible_v<T, U &&>)
    Nullable(U&& value) : owned_(std::in_place, std::forward<U>(value)) {}

    [[nodiscard]] static Nullable reference(T& value) {
        Nullable result;
        result.reference_ = &value;
        return result;
    }

    [[nodiscard]] bool has_value() const { return reference_ != nullptr || owned_.has_value(); }
    [[nodiscard]] T& value() {
        if (reference_)
            return *reference_;
        return require_owned(*this);
    }
    [[nodiscard]] const T& value() const {
        if (reference_)
            return *reference_;
        return require_owned(*this);
    }
    [[nodiscard]] T& operator*() { return value(); }
    [[nodiscard]] const T& operator*() const { return value(); }
    [[nodiscard]] T* operator->() { return &value(); }
    [[nodiscard]] const T* operator->() const { return &value(); }
    explicit operator bool() const { return has_value(); }
    [[nodiscard]] std::optional<T> to_optional() const {
        return has_value() ? std::optional<T>{value()} : std::nullopt;
    }
    template <typename U> [[nodiscard]] T value_or(U&& fallback) const {
        return has_value() ? value() : T(std::forward<U>(fallback));
    }
    [[nodiscard]] bool operator==(const Nullable& other) const
        requires requires(const T& left, const T& right) { left == right; }
    {
        return has_value() == other.has_value() && (!has_value() || value() == other.value());
    }
    [[nodiscard]] bool operator==(const T& other) const
        requires requires(const T& left, const T& right) { left == right; }
    {
        return has_value() && value() == other;
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
        requires(!std::is_same_v<std::remove_cvref_t<U>, Nullable> &&
                 std::is_constructible_v<T, U &&>)
    Nullable& operator=(U&& value) {
        reference_ = nullptr;
        owned_.emplace(std::forward<U>(value));
        return *this;
    }

private:
    /** JavaScript refuses a property read through null or undefined. */
    template <typename Self> static auto& require_owned(Self& self) {
        if (!self.owned_)
            throw_nullish_access();
        return *self.owned_;
    }

    T* reference_ = nullptr;
    std::optional<T> owned_;
};
namespace gc {
template <typename T> struct Traceable<Nullable<T>> : Traceable<T> {};
} // namespace gc

template <typename T> struct IsNullable : std::false_type {};
template <typename T> struct IsNullable<Nullable<T>> : std::true_type {};
template <typename T> struct IsOptional : std::false_type {};
template <typename T> struct IsOptional<std::optional<T>> : std::true_type {};

/**
 * Own the JavaScript value selected by a borrowed native expression.
 * Nullable snapshots own the selected value, not a borrowed Map slot.
 */
template <typename T>
    requires(!IsNullable<std::remove_cvref_t<T>>::value)
[[nodiscard]] std::remove_cvref_t<T> snapshot_value(T&& value) {
    return std::forward<T>(value);
}
template <typename T> [[nodiscard]] Nullable<T> snapshot_value(const Nullable<T>& value) {
    return value.has_value() ? Nullable<T>{*value} : Nullable<T>{};
}

/**
 * A value the source proves present (`x!`, a read under its own presence
 * guard). JavaScript throws reading through null or undefined; an absent
 * value refuses by name, never dereferencing empty storage.
 */
template <typename Storage>
    requires IsNullable<std::remove_cvref_t<Storage>>::value ||
             IsOptional<std::remove_cvref_t<Storage>>::value
[[nodiscard]] decltype(auto) present(Storage&& value) {
    if (!value.has_value())
        throw_nullish_access();
    return *std::forward<Storage>(value);
}

[[nodiscard]] inline std::u16string string_code_units(const std::string& value);
[[nodiscard]] inline std::string string_from_code_units(const std::u16string& units);

/** A replacement receives owned captures; unmatched groups remain undefined. */
struct RegExpReplacement {
    std::vector<Nullable<std::string>> groups;
    double offset = 0;
    const std::string& input;

    template <typename T> [[nodiscard]] Nullable<T> argument(std::size_t index) const {
        const auto convert = []<typename V>(const V& value) -> Nullable<T> {
            if constexpr (std::is_constructible_v<T, V>)
                return T(value);
            else
                throw std::runtime_error(
                    "RegExp callback argument does not match its declared type.");
        };
        if (index < groups.size()) {
            if (!groups[index])
                return std::nullopt;
            return convert(*groups[index]);
        } else if (index == groups.size()) {
            return convert(offset);
        } else if (index == groups.size() + 1) {
            return convert(input);
        } else
            return std::nullopt;
    }
};

/** RegExp aliases share their expression and lastIndex, measured in UTF-16 units. */
class RegExp {
public:
    RegExp(std::string source, bool global, bool ignore_case)
        : state_(std::make_shared<State>(source, global, ignore_case)) {}

    [[nodiscard]] double& last_index() const { return state_->last_index; }

    [[nodiscard]] Nullable<Array<std::string>> exec(const std::string& input) {
        const auto units = wide(input);
        const auto requested = state_->global && !std::isnan(last_index())
                                   ? std::max(0.0, std::trunc(last_index()))
                                   : 0.0;
        if (requested > static_cast<double>(units.size())) {
            if (state_->global)
                last_index() = 0.0;
            return std::nullopt;
        }
        const auto start = static_cast<std::size_t>(requested);
        std::wsmatch match;
        if (!search(units, start, match)) {
            if (state_->global)
                last_index() = 0.0;
            return std::nullopt;
        }
        Array<std::string> groups;
        groups.reserve(match.size());
        for (const auto& group : match) {
            groups.push_back(group.matched ? narrow(group.str()) : std::string{});
        }
        if (state_->global) {
            last_index() = static_cast<double>(start + static_cast<std::size_t>(match.position()) +
                                               match.length());
        }
        return groups;
    }

    [[nodiscard]] Array<std::string> split(const std::string& input) const {
        Array<std::string> result;
        const auto units = wide(input);
        std::wsregex_token_iterator part(units.begin(), units.end(), state_->expression, -1);
        const std::wsregex_token_iterator end;
        for (; part != end; ++part)
            result.push_back(narrow(part->str()));
        return result;
    }

    [[nodiscard]] Nullable<Array<std::string>> match(const std::string& input) const {
        Array<std::string> result;
        const auto units = wide(input);
        if (state_->global)
            last_index() = 0.0;
        std::size_t start = 0;
        std::wsmatch found;
        while (start <= units.size() && search(units, start, found)) {
            if (state_->global)
                result.push_back(narrow(found.str()));
            else {
                result.reserve(found.size());
                for (const auto& group : found)
                    result.push_back(group.matched ? narrow(group.str()) : std::string{});
                break;
            }
            start += static_cast<std::size_t>(found.position() + found.length());
            if (found.length() == 0)
                ++start;
        }
        return result.empty() ? Nullable<Array<std::string>>(std::nullopt)
                              : Nullable<Array<std::string>>(std::move(result));
    }

    [[nodiscard]] Array<Array<std::string>> match_all(const std::string& input) const {
        if (!state_->global) {
            throw std::runtime_error("String.matchAll requires a global RegExp.");
        }
        Array<Array<std::string>> result;
        const auto units = wide(input);
        const auto requested =
            std::isnan(last_index()) ? 0.0 : std::max(0.0, std::trunc(last_index()));
        if (requested > static_cast<double>(units.size()))
            return result;
        std::size_t start = static_cast<std::size_t>(requested);
        std::wsmatch found;
        while (start <= units.size() && search(units, start, found)) {
            Array<std::string> groups;
            groups.reserve(found.size());
            for (const auto& group : found) {
                groups.push_back(group.matched ? narrow(group.str()) : std::string{});
            }
            result.push_back(std::move(groups));
            start += static_cast<std::size_t>(found.position() + found.length());
            if (found.length() == 0)
                ++start;
        }
        return result;
    }

    [[nodiscard]] std::string replace(const std::string& input,
                                      const std::string& replacement) const {
        const auto units = wide(input);
        if (state_->global)
            last_index() = 0.0;
        return narrow(std::regex_replace(units, state_->expression, wide(replacement),
                                         state_->global ? std::regex_constants::format_default
                                                        : std::regex_constants::format_first_only));
    }

    template <typename Callback>
    [[nodiscard]] std::string replace_with(const std::string& input, Callback&& callback,
                                           bool require_global = false) const {
        if (require_global && !state_->global)
            throw std::runtime_error("String.replaceAll requires a global RegExp.");
        // Collect before invoking any callback: callback effects cannot change the match list.
        const auto matches = replacements(input);
        const auto units = string_code_units(input);
        std::u16string output;
        std::size_t end = 0;
        for (const auto& match : matches) {
            const auto position = static_cast<std::size_t>(match.offset);
            output.append(units, end, position - end);
            output += string_code_units(callback(match));
            end = position + string_code_units(*match.groups[0]).size();
        }
        output.append(units, end, units.size() - end);
        return string_from_code_units(output);
    }

    [[nodiscard]] bool test(const std::string& input) { return exec(input).has_value(); }

private:
    static std::wstring wide(const std::string& input) {
        const auto units = string_code_units(input);
        return {units.begin(), units.end()};
    }
    static std::string narrow(const std::wstring& input) {
        return string_from_code_units({input.begin(), input.end()});
    }
    struct State {
        std::wregex expression;
        bool global;
        double last_index = 0;
        State(const std::string& source, bool global_, bool ignore_case)
            : expression(wide(source), ignore_case ? std::regex_constants::ECMAScript |
                                                         std::regex_constants::icase
                                                   : std::regex_constants::ECMAScript),
              global(global_) {}
    };
    std::shared_ptr<State> state_;

    bool search(const std::wstring& input, std::size_t start, std::wsmatch& match) const {
        const auto flags = start == 0 ? std::regex_constants::match_default
                                      : std::regex_constants::match_prev_avail;
        return std::regex_search(input.cbegin() + static_cast<std::ptrdiff_t>(start), input.cend(),
                                 match, state_->expression, flags);
    }

    std::vector<RegExpReplacement> replacements(const std::string& input) const {
        std::vector<RegExpReplacement> results;
        const auto units = wide(input);
        if (state_->global)
            last_index() = 0.0;
        std::size_t start = 0;
        std::wsmatch match;
        while (start <= units.size() && search(units, start, match)) {
            const auto position = start + static_cast<std::size_t>(match.position());
            RegExpReplacement result{{}, static_cast<double>(position), input};
            result.groups.reserve(match.size());
            for (const auto& group : match)
                result.groups.push_back(group.matched ? Nullable<std::string>(narrow(group.str()))
                                                      : std::nullopt);
            results.push_back(std::move(result));
            if (!state_->global)
                break;
            start = position + static_cast<std::size_t>(match.length());
            if (match.length() == 0)
                ++start;
        }
        return results;
    }
};

/**
 * JavaScript unions flatten null and undefined. Map.get therefore returns
 * one Nullable<T> when the stored value is already Nullable<T>, rather than
 * the C++-mechanical Nullable<Nullable<T>>.
 */
template <typename V> struct MapGetResult {
    using Type = Nullable<V>;

    [[nodiscard]] static Type missing() { return {}; }
    [[nodiscard]] static Type found(V& value) { return Type::reference(value); }
};

template <typename T> struct MapGetResult<Nullable<T>> {
    using Type = Nullable<T>;

    [[nodiscard]] static Type missing() { return {}; }
    [[nodiscard]] static Type found(Nullable<T>& value) {
        return value.has_value() ? Type::reference(*value) : Type{};
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
namespace detail {
/**
 * The empty reference a missed lookup hands back. Constant-initialized at
 * namespace scope, so a miss -- an absent registry id read in a hot loop --
 * reads it without the guard a function-local static checks on every call.
 */
template <typename T> inline constinit const Ref<T> empty_ref{};
} // namespace detail

template <typename T> struct MapGetResult<Ref<T>> {
    using Type = const Ref<T>&;

    [[nodiscard]] static Type missing() { return detail::empty_ref<T>; }
    [[nodiscard]] static Type found(Ref<T>& value) { return value; }
};

/** An unmapped arguments object owns indexed values independently of the rest array. */
template <typename T> class Arguments {
public:
    using Result = std::remove_cvref_t<typename MapGetResult<T>::Type>;
    Arguments() = default;
    explicit Arguments(const Array<T>& values) : values_(values.begin(), values.end()) {}
    [[nodiscard]] double length() const { return static_cast<double>(values_.size()); }
    [[nodiscard]] Result get(double index) const;
    [[nodiscard]] bool operator==(const Arguments& other) const { return values_ == other.values_; }
    [[nodiscard]] const void* identity() const { return values_.identity(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(values_); }

private:
    Array<T> values_;
};
namespace gc {
template <typename T> struct Traceable<Arguments<T>> : Traceable<T> {};
} // namespace gc

/** JavaScript arithmetic converts a missing numeric lookup to NaN. */
[[nodiscard]] inline double number_from_optional(const Nullable<double>& value) {
    return value.has_value() ? *value : std::numeric_limits<double>::quiet_NaN();
}

/**
 * Stable insertion-order iteration for JavaScript Map and Set.
 *
 * JavaScript permits the current entry to be deleted during `for...of` and
 * visits entries appended before the iterator reaches the end. A list keeps
 * nodes stable while the active bit retains a deleted current node until an
 * iterator has safely advanced past it.
 */
template <typename T> struct InsertionOrderedSlot {
    T value;
    bool active = true;
    void gc_trace(const TraceVisitor& visitor) const { visitor(value); }
};

template <typename T> struct InsertionOrderedStorage {
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

template <typename T, bool IsConst> class InsertionOrderedIterator {
private:
    using Storage = InsertionOrderedStorage<T>;
    using Slots = typename Storage::Slots;
    using BaseIterator =
        std::conditional_t<IsConst, typename Slots::const_iterator, typename Slots::iterator>;

public:
    using iterator_category = std::forward_iterator_tag;
    using value_type = T;
    using difference_type = std::ptrdiff_t;
    using reference = std::conditional_t<IsConst, const T&, T&>;
    using pointer = std::conditional_t<IsConst, const T*, T*>;

    InsertionOrderedIterator(std::shared_ptr<Storage> storage, BaseIterator current,
                             BaseIterator end)
        : storage_(std::move(storage)), allocation_(storage_->allocation), current_(current),
          end_(end) {
        ++storage_->iterator_count;
        skip_deleted();
    }
    InsertionOrderedIterator(const InsertionOrderedIterator& other)
        : storage_(other.storage_), allocation_(other.allocation_), current_(other.current_),
          end_(other.end_) {
        if (storage_ && storage_alive())
            ++storage_->iterator_count;
    }
    InsertionOrderedIterator(InsertionOrderedIterator&& other) noexcept
        : storage_(std::move(other.storage_)), allocation_(other.allocation_),
          current_(other.current_), end_(other.end_) {}
    InsertionOrderedIterator& operator=(const InsertionOrderedIterator& other) {
        if (this == &other)
            return *this;
        release();
        storage_ = other.storage_;
        allocation_ = other.allocation_;
        current_ = other.current_;
        end_ = other.end_;
        if (storage_ && storage_alive())
            ++storage_->iterator_count;
        return *this;
    }
    InsertionOrderedIterator& operator=(InsertionOrderedIterator&& other) noexcept {
        if (this == &other)
            return *this;
        release();
        storage_ = std::move(other.storage_);
        allocation_ = other.allocation_;
        current_ = other.current_;
        end_ = other.end_;
        return *this;
    }
    ~InsertionOrderedIterator() { release(); }

    [[nodiscard]] reference operator*() const { return current_->value; }
    [[nodiscard]] pointer operator->() const { return std::addressof(current_->value); }
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
    [[nodiscard]] bool operator==(const InsertionOrderedIterator& other) const {
        return current_ == other.current_;
    }
    [[nodiscard]] bool operator!=(const InsertionOrderedIterator& other) const {
        return !(*this == other);
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(storage_); }

private:
    [[nodiscard]] bool storage_alive() const { return !allocation_ || allocation_->payload_alive; }
    void release() {
        if (!storage_)
            return;
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
        while (current_ != end_ && !current_->active)
            ++current_;
    }

    std::shared_ptr<Storage> storage_;
    gc::Node* allocation_ = nullptr;
    BaseIterator current_;
    BaseIterator end_;
};

template <typename T> inline constexpr bool is_ref_v = false;
template <typename T> inline constexpr bool is_ref_v<Ref<T>> = true;

// Insertion-ordered JavaScript Map and Set containers.
namespace detail {
template <typename T> inline constexpr bool is_variant_v = false;
template <typename... T> inline constexpr bool is_variant_v<std::variant<T...>> = true;

/** A number key's hash under SameValueZero: every NaN is one key and -0 is the +0 key. */
[[nodiscard]] inline std::size_t number_key_hash(double value) noexcept {
    if (std::isnan(value))
        value = std::numeric_limits<double>::quiet_NaN();
    else if (value == 0.0)
        value = 0.0;
    return static_cast<std::size_t>(std::bit_cast<std::uint64_t>(value));
}

/**
 * SameValueZero, the key equality of JavaScript Map and Set: NaN is NaN
 * and -0 is +0. A short string -- a chunk coordinate, an id -- compares
 * inline; the library's variable-length compare is a call that costs more
 * than such a key's bytes.
 */
template <typename T> [[nodiscard]] bool same_value_zero(const T& left, const T& right) {
    if constexpr (std::is_floating_point_v<T>) {
        return left == right || (std::isnan(left) && std::isnan(right));
    } else if constexpr (std::is_same_v<T, std::string>) {
        const std::size_t size = left.size();
        if (size != right.size())
            return false;
        constexpr std::size_t short_key = 16;
        if (size > short_key)
            return std::memcmp(left.data(), right.data(), size) == 0;
        for (std::size_t index = 0; index < size; ++index) {
            if (left[index] != right[index])
                return false;
        }
        return true;
    } else if constexpr (is_variant_v<T>) {
        return left.index() == right.index() &&
               std::visit(
                   [](const auto& first, const auto& second) {
                       if constexpr (std::is_same_v<decltype(first), decltype(second)>)
                           return same_value_zero(first, second);
                       else
                           return false;
                   },
                   left, right);
    } else {
        return std::equal_to<T>{}(left, right);
    }
}

/** The key Map.prototype.set and Set.prototype.add store: -0 becomes +0. */
template <typename T> [[nodiscard]] decltype(auto) stored_key(const T& key) {
    if constexpr (std::is_floating_point_v<T>) {
        return key == 0 ? T{} : key;
    } else if constexpr (is_variant_v<T>) {
        T stored = key;
        std::visit(
            [](auto& member) {
                if constexpr (std::is_floating_point_v<std::remove_cvref_t<decltype(member)>>) {
                    if (member == 0)
                        member = 0;
                }
            },
            stored);
        return stored;
    } else {
        return key;
    }
}
} // namespace detail

/**
 * The hash a Map or Set index files a key under. It need not spread its
 * bits -- the index mixes every hash before placing it -- so a number
 * hashes its canonical bits, an object its identity and a string its bytes.
 */
template <typename T> struct ValueHash {
    [[nodiscard]] std::size_t operator()(const T& value) const noexcept {
        if constexpr (std::is_floating_point_v<T>) {
            return detail::number_key_hash(static_cast<double>(value));
        } else if constexpr (std::is_integral_v<T> || std::is_enum_v<T>) {
            return static_cast<std::size_t>(value);
        } else if constexpr (std::is_pointer_v<T>) {
            return static_cast<std::size_t>(reinterpret_cast<std::uintptr_t>(value));
        } else if constexpr (std::is_same_v<T, std::string>) {
            // A key such as a chunk coordinate ("-3,12") is one step of
            // overlapping loads, where the library's hash walks it bytewise.
            return static_cast<std::size_t>(hash_bytes(value.data(), value.size()));
        } else if constexpr (requires { value.value; }) {
            return ValueHash<std::remove_cvref_t<decltype(value.value)>>{}(value.value);
        } else if constexpr (is_ref_v<T>) {
            // An object keys a Set or Map by identity.
            return ValueHash<const void*>{}(value.get());
        } else if constexpr (requires { value.identity(); }) {
            return ValueHash<std::remove_cvref_t<decltype(value.identity())>>{}(value.identity());
        } else {
            return std::hash<T>{}(value);
        }
    }
};

/** A stored function hashes by the identity its equality already uses. */
template <typename Sig> struct ValueHash<Callback<Sig>> {
    [[nodiscard]] std::size_t operator()(const Callback<Sig>& value) const noexcept {
        return value.identity();
    }
};

template <typename Table> struct ValueHash<GenericCallback<Table>> {
    [[nodiscard]] std::size_t operator()(const GenericCallback<Table>& value) const noexcept {
        return value.identity();
    }
};

template <typename... T> struct ValueHash<std::variant<T...>> {
    [[nodiscard]] std::size_t operator()(const std::variant<T...>& value) const noexcept {
        return std::visit(
            [](const auto& member) { return ValueHash<std::decay_t<decltype(member)>>{}(member); },
            value);
    }
};

namespace detail {
/**
 * A Map or Set index: open addressing over the positions of the entries,
 * which live in their insertion-ordered list. A cell holds its key's mixed
 * hash (never zero; zero marks an empty cell) and the entry's position, and
 * a lookup compares the key the entry itself holds, so the index copies no
 * key. Linear probing from the hash's high bits, growth by doubling past
 * three-quarters full, and an erase that shifts the cells after it back, so
 * a probe ends at the first empty cell and no deleted cell ever lengthens it.
 */
template <typename Position> class HashIndex {
public:
    struct Cell {
        std::uint64_t tag = 0;
        Position position{};
    };

    /**
     * A key's ValueHash mixed into a tag by one odd multiply, whose high bits
     * -- the home cell -- depend on every bit of the hash. Keys that differ a
     * little, as ids and chunk coordinates do, land spread apart.
     */
    [[nodiscard]] static std::uint64_t tag_of(std::size_t hash) noexcept {
        return (static_cast<std::uint64_t>(hash) * 0x9E3779B97F4A7C15ull) | 1u;
    }

    [[nodiscard]] std::size_t size() const noexcept { return count_; }

    /** The cell filed under `tag` whose entry `matches`, or null. */
    template <typename Matches>
    [[nodiscard]] Cell* find(std::uint64_t tag, Matches&& matches) const {
        if (count_ == 0)
            return nullptr;
        for (std::size_t index = home(tag);; index = (index + 1) & mask_) {
            Cell& cell = cells_[index];
            if (cell.tag == 0)
                return nullptr;
            if (cell.tag == tag && matches(cell.position))
                return &cell;
        }
    }

    /** Make room for one more cell, so the `insert` that follows cannot throw. */
    void reserve_one() {
        if ((count_ + 1) * 4 > capacity() * 3)
            rehash(capacity() == 0 ? minimum_capacity : capacity() * 2);
    }

    /** File a position whose key the index does not hold, after `reserve_one`. */
    void insert(std::uint64_t tag, Position position) noexcept {
        place(tag, position);
        ++count_;
    }

    void erase(Cell* cell) noexcept {
        auto hole = static_cast<std::size_t>(cell - cells_.get());
        for (std::size_t next = (hole + 1) & mask_;; next = (next + 1) & mask_) {
            Cell& candidate = cells_[next];
            if (candidate.tag == 0)
                break;
            // The candidate fills the hole unless its home lies after the
            // hole, where a probe for it would never reach the hole.
            if (((next - home(candidate.tag)) & mask_) >= ((next - hole) & mask_)) {
                cells_[hole] = candidate;
                hole = next;
            }
        }
        cells_[hole] = Cell{};
        --count_;
    }

    /**
     * Empty the index. A map cleared and refilled every frame keeps its
     * cells, as an erased one does, instead of growing them again; only a
     * table past `kept_capacity` -- a one-off bulk load -- is released.
     */
    void clear() noexcept {
        if (capacity() > kept_capacity) {
            cells_.reset();
            mask_ = 0;
            shift_ = 64;
        } else if (count_ > 0) {
            std::fill_n(cells_.get(), capacity(), Cell{});
        }
        count_ = 0;
    }

private:
    static constexpr std::size_t minimum_capacity = 4;
    // 64 Ki cells (1 MiB in a release build): room for 49,152 keys.
    static constexpr std::size_t kept_capacity = std::size_t{1} << 16;

    [[nodiscard]] std::size_t capacity() const noexcept { return cells_ ? mask_ + 1 : 0; }
    [[nodiscard]] std::size_t home(std::uint64_t tag) const noexcept {
        return static_cast<std::size_t>(tag >> shift_);
    }
    void place(std::uint64_t tag, Position position) noexcept {
        std::size_t index = home(tag);
        while (cells_[index].tag != 0)
            index = (index + 1) & mask_;
        cells_[index] = Cell{tag, position};
    }
    void rehash(std::size_t capacity) {
        auto previous = std::exchange(cells_, std::make_unique<Cell[]>(capacity));
        const std::size_t previous_capacity = previous ? mask_ + 1 : 0;
        mask_ = capacity - 1;
        shift_ = static_cast<unsigned>(64 - std::countr_zero(capacity));
        for (std::size_t index = 0; index < previous_capacity; ++index) {
            if (previous[index].tag != 0)
                place(previous[index].tag, previous[index].position);
        }
    }

    std::unique_ptr<Cell[]> cells_;
    std::size_t count_ = 0;
    std::size_t mask_ = 0;
    unsigned shift_ = 64;
};
} // namespace detail

/**
 * The container shell Map and Set share: insertion-ordered slots, the hash
 * index from a key to its slot, the erase that soft-deletes under a live
 * iterator, and the iterator surface over the slots. The derived containers
 * keep only their own entry shape and lookup API: Map indexes
 * `std::pair<K, V>` by the pair's first, Set indexes the value by itself.
 */
template <typename EntryT, typename KeyT> class IndexedInsertionOrdered {
public:
    using Slot = InsertionOrderedSlot<EntryT>;
    using Iterator = InsertionOrderedIterator<EntryT, false>;
    using ConstIterator = InsertionOrderedIterator<EntryT, true>;

    [[nodiscard]] bool operator==(const IndexedInsertionOrdered& other) const {
        return storage_ == other.storage_;
    }

    [[nodiscard]] bool has(const KeyT& key) const { return locate(key) != nullptr; }
    template <typename Query>
        requires std::is_same_v<Query, KeyT>
    [[nodiscard]] bool has(const Nullable<Query>& key) const {
        return key && has(*key);
    }
    template <typename Query>
        requires std::is_same_v<Query, KeyT>
    [[nodiscard]] bool erase(const Nullable<Query>& key) {
        return key && erase(*key);
    }
    [[nodiscard]] bool erase(const KeyT& key) {
        Storage& storage = *storage_;
        auto* cell = find_cell(key, tag_of(key));
        if (cell == nullptr)
            return false;
        const auto slot = cell->position;
        storage.index.erase(cell);
        forget_dense_key(key);
        if (storage.iterator_count > 0) {
            slot->active = false;
        } else {
            storage.entries.erase(slot);
        }
        return true;
    }
    void clear() {
        storage_->index.clear();
        if constexpr (dense_keys) {
            if (storage_->dense.slots)
                storage_->dense.slots->clear();
        }
        if (storage_->iterator_count > 0) {
            for (Slot& entry : storage_->entries) {
                entry.active = false;
            }
        } else {
            storage_->entries.clear();
        }
    }
    [[nodiscard]] Iterator begin() {
        return Iterator(storage_, storage_->entries.begin(), storage_->entries.end());
    }
    [[nodiscard]] Iterator end() {
        return Iterator(storage_, storage_->entries.end(), storage_->entries.end());
    }
    [[nodiscard]] ConstIterator begin() const {
        const auto& entries = storage_->entries;
        return ConstIterator(storage_, entries.cbegin(), entries.cend());
    }
    [[nodiscard]] ConstIterator end() const {
        const auto& entries = storage_->entries;
        return ConstIterator(storage_, entries.cend(), entries.cend());
    }
    [[nodiscard]] std::size_t size() const { return storage_->index.size(); }
    [[nodiscard]] const void* identity() const { return storage_.get(); }
    void gc_trace(const TraceVisitor& visitor) const { visitor(storage_); }

protected:
    using OrderedStorage = InsertionOrderedStorage<EntryT>;
    using Index = detail::HashIndex<typename OrderedStorage::Slots::iterator>;
    static constexpr bool dense_keys = std::is_same_v<KeyT, double>;
    /**
     * Number keys that are small non-negative integers -- a table keyed by
     * block, tile or enum id, read like an array -- are also indexed by
     * their value once the map has served `dense_after` lookups: position k
     * holds key k's slot, or null, up to the largest such key present. It is
     * built from the entries when the map turns hot and kept key by key by
     * insert and erase; until then a map carries only the null pointer.
     */
    struct DenseKeys {
        std::unique_ptr<std::vector<Slot*>> slots;
        std::uint32_t lookups = 0;
    };
    struct NoDenseKeys {};
    struct Storage : OrderedStorage {
        Index index;
        std::conditional_t<dense_keys, DenseKeys, NoDenseKeys> dense;
        void gc_trace(const TraceVisitor& visitor) const { visitor(this->entries); }
    };

    /** The key an entry is indexed under, inside the entry (a Set's entry is its key). */
    [[nodiscard]] static const KeyT* entry_key(const EntryT& entry) {
        if constexpr (std::is_same_v<EntryT, KeyT>)
            return &entry;
        else
            return &entry.first;
    }
    [[nodiscard]] static std::uint64_t tag_of(const KeyT& key) {
        return Index::tag_of(ValueHash<KeyT>{}(key));
    }

    /** The slot holding `key`, or null: a reader's lookup. */
    [[nodiscard]] Slot* locate(const KeyT& key) const {
        if constexpr (dense_keys) {
            DenseKeys& dense = storage_->dense;
            if (dense.slots) {
                if (const auto position = dense_position(key)) {
                    const auto& slots = *dense.slots;
                    return *position < slots.size() ? slots[*position] : nullptr;
                }
            } else if (++dense.lookups == dense_after) {
                index_dense_keys();
            }
        }
        return locate(key, tag_of(key));
    }
    /** The slot holding `key`, whose tag the caller has, or null. */
    [[nodiscard]] Slot* locate(const KeyT& key, std::uint64_t tag) const {
        const auto* cell = find_cell(key, tag);
        return cell == nullptr ? nullptr : &*cell->position;
    }
    /** Append a not-yet-present entry and index it under its key's `tag`. */
    template <typename Entry> void insert(std::uint64_t tag, Entry&& entry) {
        Storage& storage = *storage_;
        // Every allocation precedes the append, so a failed one leaves the
        // entries and both indexes as they were.
        storage.index.reserve_one();
        const std::optional<std::size_t> position = reserve_dense_key(*entry_key(entry));
        storage.entries.push_back(Slot{std::forward<Entry>(entry)});
        const auto slot = std::prev(storage.entries.end());
        storage.index.insert(tag, slot);
        if constexpr (dense_keys) {
            if (position)
                (*storage.dense.slots)[*position] = &*slot;
        }
    }

    std::shared_ptr<Storage> storage_ =
        make_gc_shared_if<gc_traceable<EntryT> || gc_traceable<KeyT>, Storage>();

private:
    // Lookups a number-keyed map serves before it indexes its dense keys.
    static constexpr std::uint32_t dense_after = 64;
    // Number keys below this are dense keys.
    static constexpr double dense_limit = 256.0;

    [[nodiscard]] typename Index::Cell* find_cell(const KeyT& key, std::uint64_t tag) const {
        return storage_->index.find(tag, [&](const auto& position) {
            return detail::same_value_zero(*entry_key(position->value), key);
        });
    }

    /** The dense position of a small non-negative integer number key. */
    [[nodiscard]] static std::optional<std::size_t> dense_position(double key) {
        // SameValueZero: -0 is the +0 key.
        if (!(key >= 0.0 && key < dense_limit))
            return std::nullopt;
        // Signed: one conversion each way, where an unsigned one branches.
        const auto integer = static_cast<std::int64_t>(key);
        if (static_cast<double>(integer) != key)
            return std::nullopt;
        return static_cast<std::size_t>(integer);
    }

    /** Index every dense key the entries hold: the map has turned hot. */
    void index_dense_keys() const {
        auto slots = std::make_unique<std::vector<Slot*>>();
        for (Slot& slot : storage_->entries) {
            if (!slot.active)
                continue;
            if (const auto position = dense_position(*entry_key(slot.value))) {
                if (*position >= slots->size())
                    slots->resize(*position + 1);
                (*slots)[*position] = &slot;
            }
        }
        storage_->dense.slots = std::move(slots);
    }

    /** Room in the dense index for `key` about to be inserted: its position, if it has one. */
    [[nodiscard]] std::optional<std::size_t> reserve_dense_key(const KeyT& key) {
        if constexpr (dense_keys) {
            auto& slots = storage_->dense.slots;
            if (!slots)
                return std::nullopt;
            const auto position = dense_position(key);
            if (position && *position >= slots->size())
                slots->resize(*position + 1);
            return position;
        } else {
            static_cast<void>(key);
            return std::nullopt;
        }
    }

    /** Forget `key`'s dense position once it is erased. */
    void forget_dense_key(const KeyT& key) {
        if constexpr (dense_keys) {
            auto& slots = storage_->dense.slots;
            if (!slots)
                return;
            if (const auto position = dense_position(key); position && *position < slots->size())
                (*slots)[*position] = nullptr;
        } else {
            static_cast<void>(key);
        }
    }
};

template <typename K, typename V> class Map : public IndexedInsertionOrdered<std::pair<K, V>, K> {
private:
    using Base = IndexedInsertionOrdered<std::pair<K, V>, K>;
    using Base::insert;
    using Base::locate;
    using Base::storage_;

public:
    using Entry = std::pair<K, V>;

    Map() = default;
    Map(std::initializer_list<Entry> entries) {
        for (const Entry& entry : entries)
            set(entry.first, entry.second);
    }

    [[nodiscard]] typename MapGetResult<V>::Type get(const K& key) const {
        auto* slot = locate(key);
        return slot == nullptr ? MapGetResult<V>::missing()
                               : MapGetResult<V>::found(slot->value.second);
    }
    [[nodiscard]] auto get_owned(const K& key) const { return snapshot_value(get(key)); }
    template <typename OptionalKey>
        requires std::is_same_v<OptionalKey, K>
    [[nodiscard]] typename MapGetResult<V>::Type get(const Nullable<OptionalKey>& key) const {
        return key.has_value() ? get(*key) : MapGetResult<V>::missing();
    }
    template <typename OptionalKey>
        requires std::is_same_v<OptionalKey, K>
    [[nodiscard]] auto get_owned(const Nullable<OptionalKey>& key) const {
        return snapshot_value(get(key));
    }
    [[nodiscard]] V& at(const K& key) {
        auto* slot = locate(key);
        if (slot == nullptr) {
            throw std::out_of_range("Map key is not present.");
        }
        return slot->value.second;
    }
    [[nodiscard]] const V& at(const K& key) const {
        const auto* slot = locate(key);
        if (slot == nullptr) {
            throw std::out_of_range("Map key is not present.");
        }
        return slot->value.second;
    }
    template <typename Value = V>
        requires std::is_convertible_v<Value&&, V>
    Map& set(const K& key, Value&& value) {
        const auto tag = Base::tag_of(key);
        auto* slot = locate(key, tag);
        if (slot == nullptr) {
            // The value may alias the key: the entry copies the key first.
            insert(tag, Entry{detail::stored_key(key), std::forward<Value>(value)});
        } else {
            V replacement = std::forward<Value>(value);
            slot->value.second = std::move(replacement);
        }
        return *this;
    }
};
namespace gc {
template <typename K, typename V>
struct Traceable<Map<K, V>> : std::disjunction<Traceable<K>, Traceable<V>> {};
} // namespace gc

using WeakIdentity = std::weak_ptr<const void>;

/** Weak object keys do not retain their payloads. Expired entries are reclaimed on access. */
template <typename V> class WeakMap {
    struct Storage {
        using Entries = std::map<WeakIdentity, V, std::owner_less<WeakIdentity>>;
        mutable Entries entries;
        mutable typename Entries::iterator cursor = entries.end();
        void erase(typename Entries::iterator entry) const {
            if (cursor == entry)
                ++cursor;
            entries.erase(entry);
        }
        void prune(std::size_t budget = 8) const {
            const auto count = std::min(budget, entries.size());
            for (std::size_t i = 0; i < count; ++i) {
                if (cursor == entries.end())
                    cursor = entries.begin();
                const auto entry = cursor++;
                if (entry->first.expired())
                    entries.erase(entry);
            }
        }
        void gc_trace(const TraceVisitor& visitor) const {
            prune(entries.size());
            for (const auto& [key, value] : entries) {
                static_cast<void>(key);
                visitor(value);
            }
        }
    };
    // Registered whatever its values: each collection prunes the entries
    // whose keys died, even when no value can own a traced edge.
    std::shared_ptr<Storage> storage_ = make_gc_shared<Storage>();

public:
    [[nodiscard]] typename MapGetResult<V>::Type get(const WeakIdentity& key) const {
        storage_->prune();
        const auto found = storage_->entries.find(key);
        if (found != storage_->entries.end() && key.expired()) {
            storage_->erase(found);
            return MapGetResult<V>::missing();
        }
        return found == storage_->entries.end() ? MapGetResult<V>::missing()
                                                : MapGetResult<V>::found(found->second);
    }
    [[nodiscard]] auto get_owned(const WeakIdentity& key) const { return snapshot_value(get(key)); }
    [[nodiscard]] bool has(const WeakIdentity& key) const {
        storage_->prune();
        return !key.expired() && storage_->entries.contains(key);
    }
    WeakMap& set(const WeakIdentity& key, const V& value) {
        storage_->prune();
        if (key.expired())
            throw std::runtime_error("WeakMap key is not a live object.");
        storage_->entries.insert_or_assign(key, value);
        return *this;
    }
    bool erase(const WeakIdentity& key) {
        storage_->prune();
        const auto found = storage_->entries.find(key);
        if (found == storage_->entries.end())
            return false;
        const bool alive = !key.expired();
        storage_->erase(found);
        return alive;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(storage_); }
};
namespace gc {
template <typename V> struct Traceable<WeakMap<V>> : Traceable<V> {};
} // namespace gc

/** Immediate snapshot of JavaScript Map.prototype.values iteration order. */
template <typename K, typename V> [[nodiscard]] inline Array<V> map_values(const Map<K, V>& map) {
    Array<V> values;
    values.reserve(map.size());
    for (const auto& entry : map)
        values.push_back(entry.second);
    return values;
}

/**
 * `Date.now()`: milliseconds since the Unix epoch on the system clock. A
 * fixed-delta capture paces the performance clock, not this one, exactly
 * as a browser's Date keeps wall time under a paced animation frame.
 */
[[nodiscard]] inline double epoch_milliseconds() {
    const auto now = std::chrono::system_clock::now().time_since_epoch();
    return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(now).count());
}

using Date = Ref<double>;
struct StorageTag {};
using Storage = Ref<StorageTag>;
[[nodiscard]] inline Storage local_storage_object() {
    static thread_local const auto instance = make_ref<StorageTag>();
    return instance;
}
using DateTimeFormat = Ref<std::string>;
#ifdef __ANDROID__
std::string android_time_zone();
#elif defined(__APPLE__)
std::string macos_time_zone();
#endif

[[nodiscard]] inline DateTimeFormat make_date_time_format() {
#ifdef __ANDROID__
    return make_ref<std::string>(android_time_zone());
#elif defined(__APPLE__)
    return make_ref<std::string>(macos_time_zone());
#else
    return make_ref<std::string>(std::chrono::current_zone()->name());
#endif
}

/** ECMAScript TimeClip: finite milliseconds within 100 million days. */
[[nodiscard]] inline double date_time_clip(double value) {
    if (!std::isfinite(value) || std::abs(value) > 8640000000000000.0)
        return std::numeric_limits<double>::quiet_NaN();
    return value == 0.0 ? 0.0 : std::trunc(value) + 0.0;
}

[[nodiscard]] inline Date make_date(double milliseconds) {
    return make_ref<double>(date_time_clip(milliseconds));
}

[[nodiscard]] inline std::string date_iso_string(const Date& date) {
    if (!std::isfinite(*date))
        throw std::runtime_error("Invalid time value");
    using namespace std::chrono;
    const auto time = sys_time<milliseconds>{milliseconds{static_cast<std::int64_t>(*date)}};
    const auto day = floor<days>(time);
    // Gregorian calendars repeat every 400 years. Reduce into 2000..2399
    // before using chrono::year, whose range is smaller than JavaScript's.
    constexpr auto base = sys_days{year{2000} / January / 1};
    const auto offset = (day - base).count();
    constexpr std::int64_t cycle_days = 146097;
    const auto cycles = offset >= 0 ? offset / cycle_days : (offset - cycle_days + 1) / cycle_days;
    const year_month_day calendar{base + days{offset - cycles * cycle_days}};
    const auto full_year = static_cast<int>(calendar.year()) + cycles * 400;
    const hh_mm_ss clock{time - day};
    const auto digits = [](std::int64_t value, std::size_t width) {
        auto text = std::to_string(value);
        if (text.size() < width)
            text.insert(0, width - text.size(), '0');
        return text;
    };
    const auto year_text = full_year >= 0 && full_year <= 9999
                               ? digits(full_year, 4)
                               : std::string(full_year < 0 ? "-" : "+") +
                                     digits(full_year < 0 ? -full_year : full_year, 6);
    return year_text + "-" + digits(static_cast<unsigned>(calendar.month()), 2) + "-" +
           digits(static_cast<unsigned>(calendar.day()), 2) + "T" +
           digits(clock.hours().count(), 2) + ":" + digits(clock.minutes().count(), 2) + ":" +
           digits(clock.seconds().count(), 2) + "." + digits(clock.subseconds().count(), 3) + "Z";
}

/**
 * Whether a `?` property that also admits null is own: it is while its storage holds a value.
 * Empty storage is either an absent property or a stored null, which nothing records.
 */
template <typename Slot>
[[nodiscard]] bool held_own_property(const Slot& slot, std::string_view property) {
    if (static_cast<bool>(slot))
        return true;
    throw std::runtime_error("Own-property presence of '" + std::string(property) +
                             "' is not represented while it is empty: it may be absent or null.");
}

/** JavaScript SameValue over numbers: NaN equals NaN and the signed zeros differ. */
[[nodiscard]] inline bool same_value(double left, double right) {
    if (std::isnan(left) || std::isnan(right))
        return std::isnan(left) && std::isnan(right);
    if (left == 0.0 && right == 0.0)
        return std::signbit(left) == std::signbit(right);
    return left == right;
}

/** Immediate snapshot of JavaScript Array.prototype.keys: 0 through length - 1. */
template <typename Values> [[nodiscard]] inline Array<double> array_keys(const Values& values) {
    Array<double> keys;
    keys.reserve(values.size());
    for (std::size_t index = 0; index < values.size(); ++index) {
        keys.push_back(static_cast<double>(index));
    }
    return keys;
}

/** Immediate snapshot of JavaScript Map.prototype.keys iteration order. */
template <typename K, typename V> [[nodiscard]] inline Array<K> map_keys(const Map<K, V>& map) {
    Array<K> keys;
    keys.reserve(map.size());
    for (const auto& entry : map)
        keys.push_back(entry.first);
    return keys;
}

template <typename T> class Set : public IndexedInsertionOrdered<T, T> {
private:
    using Base = IndexedInsertionOrdered<T, T>;
    using Base::insert;
    using Base::locate;
    using Base::storage_;

public:
    using Slot = typename Base::Slot;

    Set() = default;
    Set(std::initializer_list<T> values) {
        for (const T& value : values)
            add(value);
    }
    explicit Set(const Array<T>& values) {
        for (const T& value : values)
            add(value);
    }

    Set& add(const T& value) {
        const auto tag = Base::tag_of(value);
        if (locate(value, tag) == nullptr) {
            insert(tag, detail::stored_key(value));
        }
        return *this;
    }
};
namespace gc {
template <typename T> struct Traceable<Set<T>> : Traceable<T> {};
} // namespace gc

template <typename T> struct GeneratorPromise;

inline thread_local bool discarding_generator = false;
struct GeneratorDisposal {
    bool previous = std::exchange(discarding_generator, true);
    ~GeneratorDisposal() { discarding_generator = previous; }
};

/** Internal completion bypasses source catch handlers while running finally. */
struct GeneratorClose : AbruptCompletion {};

template <typename Close> void close_iterator(Close&& close, int exceptions) {
    if (discarding_generator)
        return;
    if (std::uncaught_exceptions() > exceptions) {
        try {
            close();
        } catch (...) {
            // IteratorClose preserves the exception already unwinding.
            return;
        }
    } else
        close();
}

/** A stored JavaScript iterator: aliases share one advancing cursor. */
template <typename T> class Iterator {
public:
    using promise_type = GeneratorPromise<T>;
    struct Result {
        bool done;
        Nullable<T> value;
        void gc_trace(const TraceVisitor& visitor) const { visitor(value); }
    };
    Iterator() = default;
    template <typename Pull>
        requires(!std::is_same_v<std::remove_cvref_t<Pull>, Iterator>)
    explicit Iterator(Pull&& pull) : pull_(std::forward<Pull>(pull)) {}
    template <typename Pull, typename Close>
    Iterator(Pull&& pull, Close&& close)
        : pull_(std::forward<Pull>(pull)), close_(std::forward<Close>(close)) {}
    [[nodiscard]] Result next() const {
        auto value = pull_();
        return {!value.has_value(), std::move(value)};
    }
    Result return_() const {
        close();
        return {true, {}};
    }
    void close() const {
        if (close_)
            close_();
    }
    class Cursor {
    public:
        Cursor(Callback<Nullable<T>()> pull, Callback<void()> close)
            : pull_(std::move(pull)), value_(pull_()), close_(std::move(close)) {}
        Cursor(const Cursor&) = delete;
        Cursor& operator=(const Cursor&) = delete;
        Cursor(Cursor&& other) noexcept
            : pull_(std::move(other.pull_)), value_(std::move(other.value_)),
              close_(std::exchange(other.close_, {})), exceptions_(other.exceptions_) {}
        ~Cursor() noexcept(false) {
            if (value_ && close_)
                close_iterator([&] { close_(); }, exceptions_);
        }
        T& operator*() { return *value_; }
        const T& operator*() const { return *value_; }
        Cursor& operator++() {
            value_ = pull_();
            return *this;
        }
        bool operator!=(std::default_sentinel_t) const { return value_.has_value(); }

    private:
        Callback<Nullable<T>()> pull_;
        Nullable<T> value_;
        Callback<void()> close_;
        int exceptions_ = std::uncaught_exceptions();
    };
    [[nodiscard]] Cursor begin() const { return Cursor(pull_, close_); }
    [[nodiscard]] std::default_sentinel_t end() const { return {}; }
    [[nodiscard]] std::size_t identity() const { return pull_.identity(); }
    friend bool operator==(const Iterator& left, const Iterator& right) {
        return left.pull_ == right.pull_;
    }
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(pull_);
        visitor(close_);
    }

private:
    Callback<Nullable<T>()> pull_;
    Callback<void()> close_;
};

template <typename T> struct GeneratorPromise {
    Nullable<T> value;
    std::exception_ptr error;
    bool closing = false;
    Iterator<T> get_return_object();
    std::suspend_always initial_suspend() const noexcept { return {}; }
    std::suspend_always final_suspend() const noexcept { return {}; }
    struct Yield {
        GeneratorPromise* promise;
        bool await_ready() const noexcept { return false; }
        void await_suspend(std::coroutine_handle<>) const noexcept {}
        void await_resume() const {
            if (promise->closing)
                throw GeneratorClose{};
        }
    };
    Yield yield_value(T result) {
        value = std::move(result);
        return {this};
    }
    void return_void() const noexcept {}
    void unhandled_exception() noexcept {
        try {
            throw;
        } catch (const GeneratorClose&) {
            // Requested close completes the generator normally.
            return;
        } catch (...) {
            error = std::current_exception();
        }
    }
};

/** A generator call owns suspended source locals; aliases share its position. */
template <typename T> struct GeneratorFrame {
    std::coroutine_handle<GeneratorPromise<T>> handle;
    bool started = false;
    bool executing = false;
    explicit GeneratorFrame(std::coroutine_handle<GeneratorPromise<T>> frame) : handle(frame) {}
    ~GeneratorFrame() {
        if (handle) {
            const GeneratorDisposal disposing;
            handle.destroy();
        }
    }
    Nullable<T> resume(bool close) {
        if (executing)
            throw NamedError("TypeError", "Generator is already executing.");
        if (!handle)
            return {};
        if (close && !started) {
            std::exchange(handle, {}).destroy();
            return {};
        }
        started = true;
        executing = true;
        handle.promise().closing = close;
        handle.promise().value = std::nullopt;
        handle.resume();
        executing = false;
        auto result = std::move(handle.promise().value);
        const auto error = handle.promise().error;
        if (handle.done())
            std::exchange(handle, {}).destroy();
        if (error)
            std::rethrow_exception(error);
        return result;
    }
};

template <typename T> Iterator<T> GeneratorPromise<T>::get_return_object() {
    auto frame = std::make_shared<GeneratorFrame<T>>(
        std::coroutine_handle<GeneratorPromise<T>>::from_promise(*this));
    const auto pull = make_closure(frame, [](auto& owner) { return owner->resume(false); });
    return Iterator<T>(pull,
                       make_closure(std::move(frame), [](auto& owner) { owner->resume(true); }));
}

/** IteratorClose preserves an already pending source exception. */
template <typename T> class IteratorScope {
public:
    explicit IteratorScope(Iterator<T> iterator) : iterator_(std::move(iterator)) {}
    IteratorScope(const IteratorScope&) = delete;
    IteratorScope& operator=(const IteratorScope&) = delete;
    ~IteratorScope() noexcept(false) {
        close_iterator([&] { iterator_.close(); }, exceptions_);
    }

private:
    Iterator<T> iterator_;
    int exceptions_ = std::uncaught_exceptions();
};

/** Keep the last yielded slot pinned until the next pull. Deleting it or
 * clearing the Set can then append entries before iteration resumes. */
template <typename Yield, typename T, bool Entries> struct SetCursor {
    std::optional<Set<T>> values;
    std::optional<InsertionOrderedIterator<T, true>> cursor;
    Nullable<Yield> operator()() {
        if (!values)
            return {};
        const Set<T>& source = *values;
        if (cursor)
            ++*cursor;
        else
            cursor.emplace(source.begin());
        if (*cursor == source.end()) {
            cursor.reset();
            values.reset();
            return {};
        }
        const T value = **cursor;
        if constexpr (Entries)
            return Yield{value, value};
        else
            return value;
    }
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(values);
        visitor(cursor);
    }
};

template <typename Yield, bool Entries, typename T>
[[nodiscard]] Iterator<Yield> set_iterator(const Set<T>& values) {
    return Iterator<Yield>(SetCursor<Yield, T, Entries>{values, {}});
}

template <typename T> using Span = std::span<T>;

/**
 * Fixed-length JavaScript numeric array storage.
 *
 * A TypeScript tuple is still an Array object: assigning it to another field
 * or record preserves identity, while `[...tuple]` explicitly makes a copy.
 * Keeping the fixed extent avoids the allocation and bounds metadata of the
 * general Array wrapper without losing that reference behavior.
 */
template <std::size_t N> class Tuple {
public:
    using Storage = std::array<double, N>;
    using RetainedStorage = std::vector<double>;
    using iterator = typename RetainedStorage::iterator;
    using const_iterator = typename RetainedStorage::const_iterator;

    Tuple()
        : values_(detail::make_recycled_vector<RetainedStorage>(
              [](RetainedStorage& storage) { storage.resize(N); })) {}
    Tuple(std::initializer_list<double> values)
        : values_(detail::make_recycled_vector<RetainedStorage>(
              [&](RetainedStorage& storage) { storage.assign(values); })) {
        if (values.size() != N) {
            throw std::runtime_error("Tuple initializer has the wrong length.");
        }
    }
    Tuple(Storage values)
        : values_(detail::make_recycled_vector<RetainedStorage>(
              [&](RetainedStorage& storage) { storage.assign(values.begin(), values.end()); })) {}
    /** The same JavaScript array as a number Array of exactly N elements. */
    explicit Tuple(std::shared_ptr<RetainedStorage> values) : values_(std::move(values)) {
        if (!values_ || values_->size() != N)
            throw std::runtime_error("An array asserted as a " + std::to_string(N) +
                                     "-element tuple has another length.");
    }
    [[nodiscard]] const std::shared_ptr<RetainedStorage>& retained_storage() const {
        return values_;
    }

    [[nodiscard]] double& operator[](std::size_t index) { return (*values_)[index]; }
    [[nodiscard]] const double& operator[](std::size_t index) const { return (*values_)[index]; }
    [[nodiscard]] constexpr std::size_t size() const { return N; }
    [[nodiscard]] const void* identity() const { return values_.get(); }
    [[nodiscard]] bool operator==(const Tuple& other) const { return values_ == other.values_; }
    [[nodiscard]] bool operator==(const Array<double>& other) const {
        return identity() == other.identity();
    }
    [[nodiscard]] double* data() { return values_->data(); }
    [[nodiscard]] const double* data() const { return values_->data(); }
    [[nodiscard]] iterator begin() { return values_->begin(); }
    [[nodiscard]] const_iterator begin() const { return values_->begin(); }
    [[nodiscard]] iterator end() { return values_->end(); }
    [[nodiscard]] const_iterator end() const { return values_->end(); }

    [[nodiscard]] Tuple clone() const {
        Tuple result;
        std::copy(values_->begin(), values_->end(), result.values_->begin());
        return result;
    }

private:
    std::shared_ptr<RetainedStorage> values_;
};

/** Fixed heterogeneous tuple lanes retain the identity of the JS array. */
template <typename... T> class Product {
public:
    using Storage = std::tuple<T...>;
    Product() : values_(make_gc_shared_if<gc_traceable<Storage>, Storage>()) {}
    Product(T... values)
        : values_(make_gc_shared_if<gc_traceable<Storage>, Storage>(std::move(values)...)) {}
    template <std::size_t I> [[nodiscard]] auto& get() const { return std::get<I>(*values_); }
    [[nodiscard]] constexpr std::size_t size() const { return sizeof...(T); }
    [[nodiscard]] const void* identity() const { return values_.get(); }
    [[nodiscard]] bool operator==(const Product& other) const { return values_ == other.values_; }
    void gc_trace(const TraceVisitor& visitor) const { visitor(values_); }

private:
    std::shared_ptr<Storage> values_;
};
namespace gc {
template <typename... T> struct Traceable<Product<T...>> : Traceable<std::tuple<T...>> {};
} // namespace gc

template <std::size_t N> [[nodiscard]] inline Tuple<N> clone_tuple(const Tuple<N>& tuple) {
    return tuple.clone();
}

/** A number array asserted as an N-element tuple keeps its identity; its length must be N. */
template <std::size_t N> [[nodiscard]] inline Tuple<N> array_as_tuple(const Array<double>& values) {
    return Tuple<N>(values.retained_storage());
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

[[nodiscard]] inline std::string_view format_number(double value, NumberTextBuffer& buffer) {
    if (std::isnan(value))
        return "NaN";
    if (value == std::numeric_limits<double>::infinity())
        return "Infinity";
    if (value == -std::numeric_limits<double>::infinity())
        return "-Infinity";
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
                    entry.text.data(), entry.text.data() + entry.text.size(), integer);
                assert(converted.ec == std::errc{});
                entry.value = integer;
                entry.length = static_cast<std::uint8_t>(converted.ptr - entry.text.data());
                entry.valid = true;
            }
            return std::string_view(entry.text.data(), entry.length);
        }
    }
    NumberTextBuffer shortest;
    const auto converted = number_chars::to_chars(
        shortest.data(), shortest.data() + shortest.size(), value, shortest_number_format);
    assert(converted.ec == std::errc{});
    const auto exponent_start = std::find(shortest.data(), converted.ptr, 'e');
    char* output = buffer.data();
    if (exponent_start == converted.ptr) {
        output = std::copy(shortest.data(), converted.ptr, output);
    } else {
        int exponent = 0;
        const char* exponent_digits = exponent_start + 1;
        if (*exponent_digits == '+')
            ++exponent_digits;
        [[maybe_unused]] const auto parsed =
            std::from_chars(exponent_digits, converted.ptr, exponent);
        assert(parsed.ec == std::errc{} && parsed.ptr == converted.ptr);
        if (exponent >= -6 && exponent < 21) {
            // JavaScript uses fixed notation in [1e-6, 1e21).
            const char* digits = shortest.data();
            if (*digits == '-') {
                *output++ = *digits++;
            }
            int point = exponent + 1;
            if (point <= 0) {
                *output++ = '0';
                *output++ = '.';
                for (int zero = point; zero < 0; ++zero)
                    *output++ = '0';
            }
            for (; digits != exponent_start; ++digits) {
                if (*digits == '.')
                    continue;
                if (point == 0 && exponent >= 0)
                    *output++ = '.';
                *output++ = *digits;
                --point;
            }
            while (point-- > 0)
                *output++ = '0';
        } else {
            output = std::copy(shortest.data(), exponent_start + 1, output);
            if (exponent >= 0)
                *output++ = '+';
            const auto written = std::to_chars(output, buffer.data() + buffer.size(), exponent);
            assert(written.ec == std::errc{});
            output = written.ptr;
        }
    }
    return std::string_view(buffer.data(), static_cast<std::size_t>(output - buffer.data()));
}

[[nodiscard]] inline std::string number_to_string(double value) {
    NumberTextBuffer buffer;
    return std::string(format_number(value, buffer));
}

[[nodiscard]] inline std::string error_to_string(const std::string& name,
                                                 const std::string& message) {
    if (name.empty())
        return message;
    if (message.empty())
        return name;
    return name + ": " + message;
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

/** Whether `part` begins with a lone low surrogate that would join `tail`'s trailing lone high one (WTF-8). */
[[nodiscard]] inline bool joins_lone_surrogates(std::string_view tail, std::string_view part) {
    const auto size = tail.size();
    return size >= 3 && part.size() >= 3 && static_cast<unsigned char>(tail[size - 3]) == 0xedu &&
           (static_cast<unsigned char>(tail[size - 2]) & 0xf0u) == 0xa0u &&
           (static_cast<unsigned char>(tail[size - 1]) & 0xc0u) == 0x80u &&
           static_cast<unsigned char>(part[0]) == 0xedu &&
           (static_cast<unsigned char>(part[1]) & 0xf0u) == 0xb0u &&
           (static_cast<unsigned char>(part[2]) & 0xc0u) == 0x80u;
}

inline void concat_append(std::string& target, std::string_view part) {
    // New neighbors can turn two WTF-8 lone surrogates into one UTF-8
    // scalar. Keep storage canonical so ordinary native equality agrees.
    const auto size = target.size();
    if (joins_lone_surrogates(target, part)) {
        const auto high = ((static_cast<unsigned char>(target[size - 2]) & 0x0fu) << 6u) |
                          (static_cast<unsigned char>(target[size - 1]) & 0x3fu);
        const auto low = ((static_cast<unsigned char>(part[1]) & 0x0fu) << 6u) |
                         (static_cast<unsigned char>(part[2]) & 0x3fu);
        const auto point = 0x10000u + (high << 10u) + low;
        target.resize(size - 3);
        target.push_back(static_cast<char>(0xf0u | (point >> 18u)));
        for (unsigned byte = 3; byte > 0; --byte)
            target.push_back(static_cast<char>(0x80u | ((point >> (6u * (byte - 1u))) & 0x3fu)));
        part.remove_prefix(3);
    }
    target.append(part);
}
inline void concat_append(std::string& target, NumberPart part) {
    NumberTextBuffer buffer;
    target.append(format_number(part.value, buffer));
}

/**
 * One operand of a short concatenation copied into its stack buffer at
 * `out`: false when it does not fit, or would join two lone surrogates
 * (`concat_append` owns that rewrite).
 */
[[nodiscard]] inline bool concat_spell(char*& out, const char* begin, const char* end,
                                       std::string_view part) {
    if (part.size() > static_cast<std::size_t>(end - out) ||
        joins_lone_surrogates(std::string_view(begin, static_cast<std::size_t>(out - begin)), part))
        return false;
    out = std::copy(part.begin(), part.end(), out);
    return true;
}
[[nodiscard]] inline bool concat_spell(char*& out, const char*, const char* end, NumberPart part) {
    NumberTextBuffer buffer;
    const std::string_view spelled = format_number(part.value, buffer);
    if (spelled.size() > static_cast<std::size_t>(end - out))
        return false;
    out = std::copy(spelled.begin(), spelled.end(), out);
    return true;
}

// A long concatenation's reservation: its text operands, and room for the
// longest number spelling (25 characters) per number.
[[nodiscard]] inline std::size_t concat_size(std::string_view part) { return part.size(); }
[[nodiscard]] inline std::size_t concat_size(NumberPart) { return 25; }

template <typename... Parts> [[nodiscard]] inline std::string concat(const Parts&... parts) {
    // A short result -- a key such as "-3,12" -- is assembled in one stack
    // buffer and constructed once; a longer one grows into one reservation.
    std::array<char, 64> text{};
    char* out = text.data();
    if ((concat_spell(out, text.data(), text.data() + text.size(), parts) && ...))
        return std::string(text.data(), static_cast<std::size_t>(out - text.data()));
    std::string result;
    result.reserve((std::size_t{0} + ... + concat_size(parts)));
    (concat_append(result, parts), ...);
    return result;
}

/**
 * The recent results of a pure function of numbers that returns a string --
 * a Map key such as "3,-2" -- so repeated arguments reuse the spelling
 * instead of recomputing it. Arguments compare by bit pattern; only a result
 * held in the string's inline buffer is kept, so a reuse never allocates.
 */
template <std::size_t Arguments, std::size_t Entries = 4> class RecentStrings {
public:
    template <typename Compute>
    [[nodiscard]] std::string remember(const std::array<double, Arguments>& arguments,
                                       Compute&& compute) {
        std::array<std::uint64_t, Arguments> bits{};
        for (std::size_t index = 0; index < Arguments; ++index)
            bits[index] = std::bit_cast<std::uint64_t>(arguments[index]);
        for (const Entry& entry : entries_) {
            if (!entry.valid)
                continue;
            bool same = true;
            for (std::size_t index = 0; index < Arguments; ++index)
                same = same && entry.bits[index] == bits[index];
            if (same)
                return entry.result;
        }
        std::string result = std::forward<Compute>(compute)();
        if (result.size() <= std::string().capacity()) {
            entries_[next_] = Entry{bits, result, true};
            next_ = (next_ + 1) % Entries;
        }
        return result;
    }

private:
    struct Entry {
        std::array<std::uint64_t, Arguments> bits{};
        std::string result;
        bool valid = false;
    };
    std::array<Entry, Entries> entries_{};
    std::size_t next_ = 0;
};

// Runtime Number.prototype.toFixed for retained UI values. JavaScript falls
// back to its ordinary number spelling at 1e21, preserves the exceptional
// spellings, and prints positive or negative zero without a minus sign.
[[nodiscard]] inline std::string number_to_fixed(double value, double precision) {
    const double integer = std::isnan(precision) ? 0.0 : std::trunc(precision);
    if (integer < 0 || integer > 100)
        throw std::range_error("Number.toFixed precision must be between 0 and 100");
    const int digits = static_cast<int>(integer);
    if (std::isnan(value))
        return "NaN";
    if (value == std::numeric_limits<double>::infinity())
        return "Infinity";
    if (value == -std::numeric_limits<double>::infinity())
        return "-Infinity";
    if (std::abs(value) >= 1e21)
        return number_to_string(value);
    if (value == 0.0) {
        return digits == 0 ? std::string("0")
                           : std::string("0.") + std::string(static_cast<std::size_t>(digits), '0');
    }
    std::array<char, 160> buffer{};
    const auto converted = number_chars::to_chars(buffer.data(), buffer.data() + buffer.size(),
                                                  value, number_chars::chars_format::fixed, digits);
    assert(converted.ec == std::errc{});
    // to_chars uses ties-to-even; ECMAScript chooses the larger magnitude.
    // Test the exact binary fraction, not a rounded multiplication by 10^digits.
    const auto bits = std::bit_cast<std::uint64_t>(std::abs(value));
    const auto encoded_exponent = static_cast<int>((bits >> 52u) & 0x7ffu);
    const std::uint64_t significand =
        (bits & 0x000fffffffffffffull) | (encoded_exponent ? 0x0010000000000000ull : 0);
    const int trailing = std::countr_zero(significand);
    const int exponent = encoded_exponent ? encoded_exponent - 1075 : -1074;
    if (exponent + trailing + digits == -1 && ((significand >> trailing) & 3u) == 1u)
        ++converted.ptr[-1];
    return std::string(buffer.data(), converted.ptr);
}

[[nodiscard]] inline double math_sign(double value) {
    if (std::isnan(value) || value == 0.0)
        return value;
    return value > 0.0 ? 1.0 : -1.0;
}

[[nodiscard]] inline double math_fround(double value) {
    // Clamp overflow explicitly: an out-of-range floating conversion is
    // undefined in C++, while JavaScript returns the corresponding infinity.
    constexpr double overflow = 0x1.ffffffp127;
    if (std::abs(value) >= overflow) {
        return std::copysign(std::numeric_limits<double>::infinity(), value);
    }
    if (std::abs(value) > static_cast<double>(std::numeric_limits<float>::max()))
        return std::copysign(static_cast<double>(std::numeric_limits<float>::max()), value);
    return static_cast<double>(static_cast<float>(value));
}

[[nodiscard]] inline double math_clz32(double value) {
    return static_cast<double>(std::countl_zero(numeric_store_value<std::uint32_t>(value)));
}

[[nodiscard]] inline bool number_is_integer(double value) {
    return std::isfinite(value) && std::trunc(value) == value;
}

[[nodiscard]] inline bool number_is_safe_integer(double value) {
    return number_is_integer(value) && std::abs(value) <= 9007199254740991.0;
}

/**
 * ECMA-262's relative-index rule: a negative index counts back from the
 * end, and either sign clamps into `[0, length]`. Every ranged builtin the
 * lowerer serves -- `slice`, `fill`, `copyWithin` -- resolves each of its
 * endpoints through exactly this, so it is stated once here rather than
 * once per operation.
 */
[[nodiscard]] inline std::size_t relative_index(std::size_t length, double raw) {
    if (std::isnan(raw))
        return 0;
    const double size = static_cast<double>(length);
    double index = std::trunc(raw);
    if (index < 0.0)
        index += size;
    if (index <= 0.0)
        return 0;
    if (index >= size)
        return length;
    return static_cast<std::size_t>(index);
}

[[nodiscard]] inline std::pair<std::size_t, std::size_t>
relative_slice_bounds(std::size_t length, double begin_value, double end_value) {
    const auto begin = relative_index(length, begin_value);
    // An end before the begin is an empty range in every one of these
    // operations -- the spec writes it as a `max(final - from, 0)` count
    // rather than as a clamp, and the two agree on every input.
    const auto end = std::max(begin, relative_index(length, end_value));
    return {begin, end};
}

[[nodiscard]] inline std::string string_slice(const std::string& value, double begin_value,
                                              double end_value) {
    const auto [begin, end] = relative_slice_bounds(value.size(), begin_value, end_value);
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

/** JavaScript's WhiteSpace and LineTerminator code points, which trimming and number parsing skip. */
[[nodiscard]] inline bool is_js_whitespace(char32_t point) {
    return (point >= 0x09 && point <= 0x0d) || point == 0x20 || point == 0xa0 || point == 0x1680 ||
           (point >= 0x2000 && point <= 0x200a) || point == 0x2028 || point == 0x2029 ||
           point == 0x202f || point == 0x205f || point == 0x3000 || point == 0xfeff;
}

/** The code point of the (W)UTF-8 sequence starting at `index`, and its byte length. */
[[nodiscard]] inline std::pair<char32_t, std::size_t> code_point_at(const std::string& value,
                                                                    std::size_t index) {
    const auto lead = static_cast<unsigned char>(value[index]);
    const std::size_t length = lead < 0x80u ? 1 : lead < 0xe0u ? 2 : lead < 0xf0u ? 3 : 4;
    if (index + length > value.size())
        return {static_cast<char32_t>(lead), 1};
    char32_t point = length == 1 ? lead : lead & (0x7fu >> length);
    for (std::size_t byte = 1; byte < length; ++byte)
        point = (point << 6u) | (static_cast<unsigned char>(value[index + byte]) & 0x3fu);
    return {point, length};
}

// The first byte past the leading JavaScript white space.
[[nodiscard]] inline std::size_t trimmed_begin(const std::string& value) {
    std::size_t begin = 0;
    while (begin < value.size()) {
        const auto [point, length] = code_point_at(value, begin);
        if (!is_js_whitespace(point))
            break;
        begin += length;
    }
    return begin;
}

// The end of the text before the trailing JavaScript white space, never before `begin`.
[[nodiscard]] inline std::size_t trimmed_end(const std::string& value, std::size_t begin) {
    std::size_t end = value.size();
    while (end > begin) {
        std::size_t start = end - 1;
        while (start > begin && (static_cast<unsigned char>(value[start]) & 0xc0u) == 0x80u)
            --start;
        if (!is_js_whitespace(code_point_at(value, start).first))
            break;
        end = start;
    }
    return end;
}

[[nodiscard]] inline std::string string_trim(const std::string& value) {
    const std::size_t begin = trimmed_begin(value);
    return value.substr(begin, trimmed_end(value, begin) - begin);
}

[[nodiscard]] inline std::string string_trim_start(const std::string& value) {
    return value.substr(trimmed_begin(value));
}

[[nodiscard]] inline std::string string_trim_end(const std::string& value) {
    return value.substr(0, trimmed_end(value, 0));
}

/**
 * The end of the longest decimal literal at `index` (an optional sign,
 * digits with an optional fraction, and an exponent when digits follow
 * it), or `index` itself when it has no digits.
 */
[[nodiscard]] inline std::size_t decimal_literal_end(std::string_view value, std::size_t index) {
    const auto digit = [&](std::size_t at) {
        return at < value.size() && value[at] >= '0' && value[at] <= '9';
    };
    const std::size_t start = index;
    if (index < value.size() && (value[index] == '+' || value[index] == '-'))
        ++index;
    std::size_t digits = 0;
    for (; digit(index); ++index)
        ++digits;
    if (index < value.size() && value[index] == '.')
        for (++index; digit(index); ++index)
            ++digits;
    if (digits == 0)
        return start;
    if (index < value.size() && (value[index] == 'e' || value[index] == 'E')) {
        std::size_t exponent = index + 1;
        if (exponent < value.size() && (value[exponent] == '+' || value[exponent] == '-'))
            ++exponent;
        if (digit(exponent)) {
            while (digit(exponent))
                ++exponent;
            index = exponent;
        }
    }
    return index;
}

/** A signed `Infinity` at `index`: its value and where it ends. */
[[nodiscard]] inline std::optional<std::pair<double, std::size_t>>
infinity_at(std::string_view value, std::size_t index) {
    const bool has_sign = index < value.size() && (value[index] == '+' || value[index] == '-');
    const std::size_t word = index + (has_sign ? 1 : 0);
    if (value.substr(word, 8) != "Infinity")
        return std::nullopt;
    const double infinity = std::numeric_limits<double>::infinity();
    return std::pair{has_sign && value[index] == '-' ? -infinity : infinity, word + 8};
}

/** A letter or digit's value as a digit of radix up to 36, or -1. */
[[nodiscard]] inline int radix_digit(char character) {
    return character >= '0' && character <= '9'   ? character - '0'
           : character >= 'a' && character <= 'z' ? character - 'a' + 10
           : character >= 'A' && character <= 'Z' ? character - 'A' + 10
                                                  : -1;
}

/**
 * An unsigned `0x`/`0o`/`0b` integer literal's value, correctly rounded
 * (NaN when it has no digits or one outside its radix), or nothing when
 * `text` is not one.
 */
[[nodiscard]] inline std::optional<double> radix_integer_literal(std::string_view text) {
    if (text.size() < 2 || text[0] != '0')
        return std::nullopt;
    const char tag = text[1];
    const int bits = tag == 'x' || tag == 'X'   ? 4
                     : tag == 'o' || tag == 'O' ? 3
                     : tag == 'b' || tag == 'B' ? 1
                                                : 0;
    if (bits == 0)
        return std::nullopt;
    // The digits' bits, regrouped as hexadecimal, which strtod rounds correctly.
    std::string binary;
    for (const char character : text.substr(2)) {
        const int digit = radix_digit(character);
        if (digit < 0 || digit >= (1 << bits))
            return std::numeric_limits<double>::quiet_NaN();
        for (int bit = bits - 1; bit >= 0; --bit)
            binary.push_back(((digit >> bit) & 1) != 0 ? '1' : '0');
    }
    if (binary.empty())
        return std::numeric_limits<double>::quiet_NaN();
    binary.insert(0, (4 - binary.size() % 4) % 4, '0');
    std::string hexadecimal = "0x";
    for (std::size_t at = 0; at < binary.size(); at += 4) {
        int nibble = 0;
        for (std::size_t bit = at; bit < at + 4; ++bit)
            nibble = nibble * 2 + (binary[bit] - '0');
        hexadecimal.push_back("0123456789abcdef"[nibble]);
    }
    return std::strtod(hexadecimal.c_str(), nullptr);
}

/**
 * JavaScript `parseFloat`: leading white space, then a signed decimal
 * literal or `Infinity`; anything else in front is NaN and anything after
 * the number is ignored.
 */
[[nodiscard]] inline double parse_float(const std::string& value) {
    const std::size_t start = trimmed_begin(value);
    if (const auto infinity = infinity_at(value, start))
        return infinity->first;
    const std::size_t end = decimal_literal_end(value, start);
    return end == start ? std::numeric_limits<double>::quiet_NaN()
                        : std::strtod(value.substr(start, end - start).c_str(), nullptr);
}

/**
 * `Number.prototype.toString(radix)`: the integer part by repeated
 * division and the fraction by repeated multiplication, to the
 * precision a double carries; radix 10 is the ordinary spelling.
 */
[[nodiscard]] inline std::string number_to_string_radix(double value, int radix) {
    if (radix == 10 || !std::isfinite(value))
        return number_to_string(value);
    if (radix < 2 || radix > 36)
        throw std::runtime_error("toString() radix must be between 2 and 36");
    const char* digits = "0123456789abcdefghijklmnopqrstuvwxyz";
    const bool negative = value < 0.0;
    double magnitude = std::fabs(value);
    double integer_part = std::floor(magnitude);
    double fraction = magnitude - integer_part;
    std::string result;
    result.reserve(64);
    if (negative)
        result += '-';
    // The integer digits come out least significant first.
    const auto integer_begin = static_cast<std::ptrdiff_t>(result.size());
    if (integer_part == 0.0)
        result += '0';
    while (integer_part >= 1.0) {
        const double remainder = std::fmod(integer_part, static_cast<double>(radix));
        result += digits[static_cast<int>(remainder)];
        integer_part = std::floor(integer_part / radix);
    }
    std::reverse(result.begin() + integer_begin, result.end());
    if (fraction > 0.0) {
        result += '.';
        for (int count = 0; fraction > 0.0 && count < 52; ++count) {
            fraction *= radix;
            const int digit = static_cast<int>(std::floor(fraction));
            result += digits[digit];
            fraction -= digit;
        }
    }
    return result;
}

[[nodiscard]] inline double string_index_of(const std::string& value, const std::string& search) {
    const auto index = value.find(search);
    return index == std::string::npos ? -1.0 : static_cast<double>(index);
}

// JavaScript string iteration yields one Unicode code point as a string.
// Native strings are UTF-8, so retain each complete encoded sequence.
[[nodiscard]] inline Array<std::string> string_characters(const std::string& value) {
    Array<std::string> result;
    for (std::size_t offset = 0; offset < value.size();) {
        const auto lead = static_cast<unsigned char>(value[offset]);
        std::size_t count = lead < 0x80u              ? 1u
                            : (lead & 0xe0u) == 0xc0u ? 2u
                            : (lead & 0xf0u) == 0xe0u ? 3u
                            : (lead & 0xf8u) == 0xf0u ? 4u
                                                      : 1u;
        count = std::min(count, value.size() - offset);
        result.push_back(value.substr(offset, count));
        offset += count;
    }
    return result;
}

[[nodiscard]] inline Array<std::string> string_split(const std::string& value,
                                                     const std::string& separator) {
    if (separator.empty())
        return string_characters(value);
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

[[nodiscard]] inline bool string_starts_with(const std::string& value, const std::string& prefix) {
    return value.starts_with(prefix);
}

[[nodiscard]] inline bool string_ends_with(const std::string& value, const std::string& suffix) {
    return value.ends_with(suffix);
}

// UTF-16 indexing over native UTF-8 strings. Lone surrogates use WTF-8 so
// slicing through a surrogate pair retains the JavaScript code unit.
class StringCodeUnitCursor {
public:
    explicit StringCodeUnitCursor(const std::string& value) : value_(value) {}

    [[nodiscard]] std::optional<char16_t> next() {
        if (trailing_)
            return std::exchange(trailing_, std::nullopt);
        if (index_ == value_.size())
            return {};
        const auto lead = static_cast<unsigned char>(value_[index_++]);
        if (lead >= 0x80u && (lead < 0xc2u || lead > 0xf4u))
            throw std::runtime_error("Invalid UTF-8 string.");
        std::uint32_t point = lead;
        const unsigned count = lead < 0x80 ? 0u : lead < 0xe0 ? 1u : lead < 0xf0 ? 2u : 3u;
        if (count)
            point &= (1u << (6u - count)) - 1u;
        for (unsigned byte = 0; byte < count; ++byte) {
            if (index_ == value_.size() ||
                (static_cast<unsigned char>(value_[index_]) & 0xc0u) != 0x80u)
                throw std::runtime_error("Invalid UTF-8 string.");
            point = (point << 6u) | (static_cast<unsigned char>(value_[index_++]) & 0x3fu);
        }
        if ((count == 1 && point < 0x80u) || (count == 2 && point < 0x800u) ||
            (count == 3 && point < 0x10000u) || point > 0x10ffffu)
            throw std::runtime_error("Invalid UTF-8 string.");
        if (point > 0xffffu) {
            point -= 0x10000u;
            trailing_ = static_cast<char16_t>(0xdc00u + (point & 0x3ffu));
            return static_cast<char16_t>(0xd800u + (point >> 10u));
        }
        return static_cast<char16_t>(point);
    }

private:
    const std::string& value_;
    std::size_t index_ = 0;
    std::optional<char16_t> trailing_;
};

[[nodiscard]] inline double string_char_code_at(const std::string& value, double index_value) {
    const double index = std::isnan(index_value) ? 0.0 : std::trunc(index_value);
    if (index >= 0 && std::isfinite(index)) {
        StringCodeUnitCursor cursor(value);
        std::size_t position = 0;
        while (const auto unit = cursor.next()) {
            if (static_cast<double>(position++) == index)
                return static_cast<double>(*unit);
        }
    }
    return std::numeric_limits<double>::quiet_NaN();
}

[[nodiscard]] inline std::u16string string_code_units(const std::string& value) {
    std::u16string units;
    StringCodeUnitCursor cursor(value);
    while (const auto unit = cursor.next())
        units.push_back(*unit);
    return units;
}

[[nodiscard]] inline std::string string_from_code_units(const std::u16string& units) {
    std::string result;
    for (std::size_t index = 0; index < units.size(); ++index) {
        std::uint32_t point = units[index];
        if (point >= 0xd800u && point <= 0xdbffu && index + 1 < units.size() &&
            units[index + 1] >= 0xdc00u && units[index + 1] <= 0xdfffu) {
            point = 0x10000u + ((point - 0xd800u) << 10u) + (units[++index] - 0xdc00u);
        }
        if (point < 0x80u)
            result.push_back(static_cast<char>(point));
        else {
            const unsigned count = point < 0x800u ? 1u : point < 0x10000u ? 2u : 3u;
            result.push_back(static_cast<char>((0xffu << (7u - count)) | (point >> (6u * count))));
            for (unsigned byte = count; byte > 0; --byte)
                result.push_back(
                    static_cast<char>(0x80u | ((point >> (6u * (byte - 1u))) & 0x3fu)));
        }
    }
    return result;
}

[[nodiscard]] inline double string_length(const std::string& value) {
    // A continuation byte contributes no code unit; a four-byte UTF-8
    // sequence contributes the two code units of its surrogate pair.
    std::size_t length = 0;
    for (const unsigned char byte : value) {
        if ((byte & 0xc0u) != 0x80u)
            length += byte >= 0xf0u ? 2u : 1u;
    }
    return static_cast<double>(length);
}

[[nodiscard]] inline std::string string_substring(const std::string& value, double start,
                                                  double end) {
    const auto units = string_code_units(value);
    auto first = relative_index(units.size(), std::isnan(start) ? 0.0 : std::max(0.0, start));
    auto last = relative_index(units.size(), std::isnan(end) ? 0.0 : std::max(0.0, end));
    if (first > last)
        std::swap(first, last);
    return string_from_code_units(units.substr(first, last - first));
}

[[nodiscard]] inline std::string string_repeat(const std::string& value, double count) {
    count = std::isnan(count) ? 0.0 : std::trunc(count);
    if (!std::isfinite(count) || count < 0.0)
        throw std::runtime_error("String.repeat count out of range.");
    if (value.empty() || count == 0.0)
        return {};
    std::string result;
    const std::size_t maximum_repetitions = result.max_size() / value.size();
    if (count >= static_cast<double>(maximum_repetitions))
        throw std::runtime_error("String.repeat result is too large.");
    const auto repetitions = static_cast<std::size_t>(count);
    result.reserve(value.size() * repetitions);
    for (std::size_t index = 0; index < repetitions; ++index)
        concat_append(result, value);
    return result;
}

[[nodiscard]] inline Nullable<std::string> string_relative_at(const std::string& value,
                                                              double index) {
    index = std::isnan(index) ? 0.0 : std::trunc(index);
    if (!std::isfinite(index))
        return {};
    if (index < 0.0)
        index += string_length(value);
    if (index < 0.0)
        return {};
    StringCodeUnitCursor cursor(value);
    for (std::size_t offset = 0; const auto unit = cursor.next(); ++offset)
        if (static_cast<double>(offset) == index)
            return string_from_code_units(std::u16string(1, *unit));
    return {};
}

/** Numeric string properties index UTF-16 code units without truncating or wrapping. */
[[nodiscard]] inline Nullable<std::string> string_index(const std::string& value, double index) {
    if (!std::isfinite(index) || index < 0.0 || std::trunc(index) != index)
        return {};
    return string_relative_at(value, index);
}

/** A function-local UTF-16 index borrowing a proven unchanged string parameter. */
class StringIndex {
public:
    explicit StringIndex(const std::string& value) : cursor_(value) {}
    StringIndex(const StringIndex&) = delete;
    StringIndex& operator=(const StringIndex&) = delete;

    [[nodiscard]] std::optional<char16_t> at(double index) {
        if (!std::isfinite(index) || index < 0.0 || std::trunc(index) != index)
            return {};
        while (static_cast<double>(units_.size()) <= index) {
            const auto unit = cursor_.next();
            if (!unit)
                return {};
            units_.push_back(*unit);
        }
        return units_[static_cast<std::size_t>(index)];
    }

private:
    StringCodeUnitCursor cursor_;
    std::u16string units_;
};

[[nodiscard]] inline Nullable<std::string> string_index(StringIndex& value, double index) {
    const auto unit = value.at(index);
    return unit ? Nullable<std::string>(string_from_code_units(std::u16string(1, *unit)))
                : Nullable<std::string>{};
}

[[nodiscard]] inline double string_char_code_at(StringIndex& value, double index) {
    const auto unit = value.at(std::isnan(index) ? 0.0 : std::trunc(index));
    return unit ? static_cast<double>(*unit) : std::numeric_limits<double>::quiet_NaN();
}

[[nodiscard]] inline Nullable<double> string_code_point_at(const std::string& value, double index) {
    index = std::isnan(index) ? 0.0 : std::trunc(index);
    if (!std::isfinite(index) || index < 0.0)
        return {};
    StringCodeUnitCursor cursor(value);
    for (std::size_t offset = 0; const auto unit = cursor.next(); ++offset) {
        if (static_cast<double>(offset) != index)
            continue;
        std::uint32_t point = *unit;
        if (point >= 0xd800u && point <= 0xdbffu) {
            const auto next = cursor.next();
            if (next && *next >= 0xdc00u && *next <= 0xdfffu)
                point = 0x10000u + ((point - 0xd800u) << 10u) + (*next - 0xdc00u);
        }
        return static_cast<double>(point);
    }
    return {};
}

template <typename Replacement>
[[nodiscard]] std::string string_replace_matches(const std::string& value,
                                                 const std::string& search,
                                                 Replacement&& replacement, bool all) {
    const auto input = string_code_units(value);
    const auto pattern = string_code_units(search);
    std::u16string result;
    std::size_t consumed = 0, position = input.find(pattern);
    while (position != std::u16string::npos) {
        result.append(input, consumed, position - consumed);
        result += replacement(input, pattern, position);
        consumed = position + pattern.size();
        if (!all || (pattern.empty() && position == input.size()))
            break;
        position = input.find(pattern, position + std::max<std::size_t>(1, pattern.size()));
    }
    result.append(input, consumed);
    return string_from_code_units(result);
}

[[nodiscard]] inline std::string string_replace(const std::string& value, const std::string& search,
                                                const std::string& replacement, bool all) {
    const auto substitute = string_code_units(replacement);
    return string_replace_matches(
        value, search,
        [&](const auto& input, const auto& pattern, std::size_t position) {
            std::u16string result;
            for (std::size_t index = 0; index < substitute.size(); ++index) {
                if (substitute[index] == u'$' && index + 1 < substitute.size()) {
                    const auto token = substitute[index + 1];
                    if (token == u'$')
                        result += u'$';
                    else if (token == u'&')
                        result += pattern;
                    else if (token == u'`')
                        result.append(input, 0, position);
                    else if (token == u'\'')
                        result.append(input, position + pattern.size());
                    else {
                        result += substitute[index];
                        continue;
                    }
                    ++index;
                } else
                    result += substitute[index];
            }
            return result;
        },
        all);
}

template <typename Replacement>
[[nodiscard]] std::string string_replace_with(const std::string& value, const std::string& search,
                                              Replacement&& replacement, bool all) {
    return string_replace_matches(
        value, search,
        [&](const auto&, const auto& pattern, std::size_t position) {
            return string_code_units(
                replacement(string_from_code_units(pattern), static_cast<double>(position), value));
        },
        all);
}

/**
 * JavaScript's string-to-number conversion: white space around a signed
 * decimal literal, a signed `Infinity` or an unsigned `0x`/`0o`/`0b`
 * integer; white space alone is 0 and anything else NaN.
 */
[[nodiscard]] inline double number_from_string(const std::string& value) {
    const std::size_t begin = trimmed_begin(value);
    const std::string_view text(value.data() + begin, trimmed_end(value, begin) - begin);
    if (text.empty())
        return 0.0;
    if (const auto infinity = infinity_at(text, 0); infinity && infinity->second == text.size())
        return infinity->first;
    if (const auto integer = radix_integer_literal(text))
        return *integer;
    return decimal_literal_end(text, 0) == text.size()
               ? std::strtod(std::string(text).c_str(), nullptr)
               : std::numeric_limits<double>::quiet_NaN();
}

/** JavaScript parseInt over a string and a validated literal radix. */
[[nodiscard]] inline double parse_int(const std::string& value, int radix) {
    std::size_t index = trimmed_begin(value);
    bool negative = false;
    if (index < value.size() && (value[index] == '+' || value[index] == '-')) {
        negative = value[index] == '-';
        ++index;
    }
    const bool allow_prefix = radix == 0 || radix == 16;
    if (radix == 0)
        radix = 10;
    if (allow_prefix && index + 1 < value.size() && value[index] == '0' &&
        (value[index + 1] == 'x' || value[index + 1] == 'X')) {
        index += 2;
        radix = 16;
    }
    double parsed = 0.0;
    bool found_digit = false;
    while (index < value.size()) {
        const int digit = radix_digit(value[index]);
        if (digit < 0 || digit >= radix)
            break;
        found_digit = true;
        parsed = parsed * radix + digit;
        ++index;
    }
    if (!found_digit) {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return negative ? -parsed : parsed;
}

[[nodiscard]] inline double parse_int_decimal(const std::string& value) {
    return parse_int(value, 10);
}

[[nodiscard]] inline std::string string_from_char_code(double value) {
    const double finite = std::isfinite(value) ? std::trunc(value) : 0.0;
    const double wrapped = std::fmod(finite, 65536.0);
    const auto code = static_cast<std::uint16_t>(wrapped < 0.0 ? wrapped + 65536.0 : wrapped);
    return string_from_code_units(std::u16string(1, static_cast<char16_t>(code)));
}

[[nodiscard]] inline std::string string_from_char_codes(std::initializer_list<double> values) {
    std::string result;
    result.reserve(values.size());
    for (const double value : values) {
        concat_append(result, string_from_char_code(value));
    }
    return result;
}

// The padding `padStart`/`padEnd` adds: none once the value reaches the
// length or when the fill is empty.
[[nodiscard]] inline std::size_t pad_needed(const std::string& value, double target_length_value,
                                            const std::string& fill) {
    const auto target_length =
        static_cast<std::size_t>(std::max(0.0, std::trunc(target_length_value)));
    return value.size() >= target_length || fill.empty() ? 0 : target_length - value.size();
}

// `fill` repeated to exactly `needed` bytes, appended in place.
inline void append_fill(std::string& target, std::size_t needed, const std::string& fill) {
    const std::size_t end = target.size() + needed;
    target.reserve(end);
    while (target.size() < end)
        target += fill;
    target.resize(end);
}

[[nodiscard]] inline std::string
string_pad_start(const std::string& value, double target_length_value, const std::string& fill) {
    const std::size_t needed = pad_needed(value, target_length_value, fill);
    if (needed == 0)
        return value;
    std::string result;
    result.reserve(needed + value.size());
    append_fill(result, needed, fill);
    result.append(value);
    return result;
}

[[nodiscard]] inline std::string
string_pad_end(const std::string& value, double target_length_value, const std::string& fill) {
    const std::size_t needed = pad_needed(value, target_length_value, fill);
    if (needed == 0)
        return value;
    std::string result = value;
    append_fill(result, needed, fill);
    return result;
}

/** `String.prototype.charAt`: the code unit at the index, or the empty string. */
[[nodiscard]] inline std::string string_char_at(const std::string& value, double index) {
    // Unlike `at`, a negative index never counts from the end.
    if (index < 0.0)
        return {};
    const auto unit = string_relative_at(value, index);
    return unit.has_value() ? *unit : std::string{};
}

// `Record<Union, T>` — one fixed slot per member of a string-literal
// union. The compiler lays the slots out in the union's own member
// order, which is the order its enum tags are numbered in, so a tag
// indexes its slot directly. Unlike an Array it never grows: the key
// space is closed at compile time.
template <typename T, std::size_t N> using EnumMap = std::array<T, N>;

template <typename T, std::size_t N, typename Tag>
[[nodiscard]] inline const T& enum_map_at(const EnumMap<T, N>& slots, Tag tag) {
    const auto index = static_cast<std::size_t>(tag);
    assert(index < N);
    return slots[index];
}

template <typename T, std::size_t N, typename Tag>
[[nodiscard]] inline T& enum_map_at(EnumMap<T, N>& slots, Tag tag) {
    const auto index = static_cast<std::size_t>(tag);
    assert(index < N);
    return slots[index];
}

template <typename Values> [[nodiscard]] inline double array_length(const Values& values) {
    return static_cast<double>(values.size());
}

template <typename T>
[[nodiscard]] inline Array<T> array_slice(const Array<T>& values, double begin_value,
                                          double end_value) {
    const auto [begin, end] = relative_slice_bounds(values.size(), begin_value, end_value);
    return Array<T>(values.begin() + begin, values.begin() + end);
}

/** JavaScript Array.join with an explicit element-to-string projection. */
template <typename Range, typename Projection>
[[nodiscard]] inline std::string array_join(const Range& values, const std::string& separator,
                                            Projection projection) {
    std::string result;
    bool first = true;
    for (const auto& value : values) {
        if (!first) {
            concat_append(result, separator);
        }
        concat_append(result, projection(value));
        first = false;
    }
    return result;
}

template <typename Range>
[[nodiscard]] inline std::string array_join(const Range& values, const std::string& separator) {
    return array_join(values, separator, [](const auto& value) -> const auto& { return value; });
}

/** `Array.prototype.sort()` with no comparator over strings: stable, ascending UTF-16
 * code units. An `Array` shares its storage, so the caller's array is the one sorted. */
template <typename Strings> [[nodiscard]] inline Strings string_array_sort(Strings values) {
    std::stable_sort(values.begin(), values.end(),
                     [](const std::string& left, const std::string& right) {
                         return string_code_units(left) < string_code_units(right);
                     });
    return values;
}

/** `%TypedArray%.prototype.subarray`: a view over the same bytes for a numeric range. */
template <typename Values>
[[nodiscard]] inline Values typed_array_subarray(const Values& values, double begin_value,
                                                 double end_value) {
    const auto [begin, end] = relative_slice_bounds(values.size(), begin_value, end_value);
    using Element = typename Values::value_type;
    return Values(values.buffer(),
                  static_cast<double>(values.byte_offset() + begin * sizeof(Element)),
                  static_cast<double>(end - begin));
}

/** `%TypedArray%.prototype.slice` copies a numeric range into fresh storage. */
template <typename Values>
[[nodiscard]] inline Values typed_array_slice(const Values& values, double begin_value,
                                              double end_value) {
    const auto [begin, end] = relative_slice_bounds(values.size(), begin_value, end_value);
    if constexpr (requires { values.copy_range(begin, end); })
        return values.copy_range(begin, end);
    else
        return Values(values.begin() + begin, values.begin() + end);
}

// `array.indexOf(value)` — the first strictly-equal element, or -1.
// JavaScript compares primitives by value and objects by identity, and
// every element type reaching here is a scalar or a handle id, so a
// plain `==` is that comparison. NaN matches nothing in either
// language, for the same reason.
// One search over every indexed container (Array, a readonly span, a pinned
// body's std::vector, a constant std::array, a typed array's numbers). The
// needle takes the container's element type, so a literal argument converts
// to it instead of deducing a second, conflicting type.
template <typename Values>
[[nodiscard]] inline double array_index_of(const Values& values,
                                           const typename Values::value_type& value) {
    for (std::size_t index = 0; index < values.size(); ++index) {
        if (values[index] == value) {
            return static_cast<double>(index);
        }
    }
    return -1.0;
}

/** `includes`: SameValueZero, so a NaN needle finds a NaN element. */
template <typename Values>
[[nodiscard]] inline bool array_includes(const Values& values,
                                         const typename Values::value_type& value) {
    for (std::size_t index = 0; index < values.size(); ++index) {
        if (detail::same_value_zero(static_cast<typename Values::value_type>(values[index]), value))
            return true;
    }
    return false;
}

template <typename Values, typename T>
    requires std::is_enum_v<T>
[[nodiscard]] inline double array_index_of(const Values& values, const Nullable<T>& value) {
    return value ? array_index_of(values, *value) : -1.0;
}

// `array.pop()!` — the non-null assertion states the array is not empty. A
// nullable element is its own absent state; any other element has none, so an
// empty pop refuses by name in every build configuration instead of reading
// freed storage. An unasserted `pop()` lowers to `array_pop_or_absent`.
template <typename T> inline T array_pop(Array<T>& values) {
    if (values.empty()) [[unlikely]] {
        if constexpr (std::is_same_v<T, typename MapGetResult<T>::Type>)
            return {};
        else
            throw std::runtime_error("Array pop on an empty array.");
    }
    T last = values.back();
    values.pop_back();
    return last;
}

// A temporary wrapper still owns the array being mutated. Reuse the lvalue
// operation without copying its elements or retaining ordinary receivers again.
template <typename T> inline T array_pop(Array<T>&& values) { return array_pop(values); }

// `array.shift()!` — same contract as `array_pop`.
template <typename T> inline T array_shift(Array<T>& values) {
    if (values.empty()) [[unlikely]] {
        if constexpr (std::is_same_v<T, typename MapGetResult<T>::Type>)
            return {};
        else
            throw std::runtime_error("Array shift on an empty array.");
    }
    T first = values.front();
    values.erase(values.begin());
    return first;
}

template <typename T> inline T array_shift(Array<T>&& values) { return array_shift(values); }

/**
 * What `array.pop()` and `array.shift()` yield: the removed element, or
 * absent -- JavaScript's `undefined` -- for an empty array. Null and
 * undefined are one absent state, so a nullable element is its own result,
 * and an object reference is absent as the empty reference.
 */
template <typename T> struct ArrayRemovalResult {
    using Type = Nullable<T>;
};
template <typename T> struct ArrayRemovalResult<Nullable<T>> {
    using Type = Nullable<T>;
};
template <typename T> struct ArrayRemovalResult<Ref<T>> {
    using Type = Ref<T>;
};

template <typename T>
inline typename ArrayRemovalResult<T>::Type array_pop_or_absent(Array<T>& values) {
    if (values.empty())
        return {};
    T last = values.back();
    values.pop_back();
    return last;
}

template <typename T>
inline typename ArrayRemovalResult<T>::Type array_pop_or_absent(Array<T>&& values) {
    return array_pop_or_absent(values);
}

template <typename T>
inline typename ArrayRemovalResult<T>::Type array_shift_or_absent(Array<T>& values) {
    if (values.empty())
        return {};
    T first = values.front();
    values.erase(values.begin());
    return first;
}

template <typename T>
inline typename ArrayRemovalResult<T>::Type array_shift_or_absent(Array<T>&& values) {
    return array_shift_or_absent(values);
}

// `array.unshift(...items)` inserts the arguments at the front in source
// order and returns the new JavaScript length.
template <typename T>
inline double array_unshift(Array<T>& values, std::initializer_list<T> inserted) {
    values.insert(values.begin(), inserted.begin(), inserted.end());
    return static_cast<double>(values.size());
}

// `array.reverse()` mutates and returns the same JavaScript array object.
template <typename T> inline Array<T>& array_reverse(Array<T>& values) {
    std::reverse(values.begin(), values.end());
    return values;
}

/**
 * `fill(value, start, end)` — the ranged form, over any container the
 * lowerer serves. Both endpoints are relative indices, so a negative one
 * counts back from the end and an end at or before the start writes
 * nothing; `relative_slice_bounds` is that rule, shared with `slice`.
 */
template <typename Values, typename T>
inline Values& array_fill_range(Values& values, const T& value, double start, double end) {
    const auto [from, to] = relative_slice_bounds(values.size(), start, end);
    if constexpr (requires { values.store(0, value); }) {
        for (std::size_t index = from; index < to; ++index)
            values.store(index, value);
    } else
        std::fill(values.begin() + static_cast<std::ptrdiff_t>(from),
                  values.begin() + static_cast<std::ptrdiff_t>(to), value);
    return values;
}

// Full-array fill shares the range implementation across all storage forms.
template <typename Values, typename T> inline Values& array_fill(Values& values, const T& value) {
    return array_fill_range(values, value, 0.0, std::numeric_limits<double>::infinity());
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
inline Values& array_copy_within(Values& values, double target, double start, double end) {
    const auto to = relative_index(values.size(), target);
    const auto [from, final] = relative_slice_bounds(values.size(), start, end);
    const auto count = std::min(final - from, values.size() - to);
    if (count == 0 || from == to)
        return values;
    if constexpr (requires {
                      values.byte_offset();
                      values.load(0);
                  }) {
        auto bytes = values.buffer();
        using Element = typename Values::value_type;
        std::memmove(bytes.data() + values.byte_offset() + to * sizeof(Element),
                     bytes.data() + values.byte_offset() + from * sizeof(Element),
                     count * sizeof(Element));
    } else {
        const auto begin = values.begin();
        const auto offset = [](std::size_t index) { return static_cast<std::ptrdiff_t>(index); };
        if (to < from) {
            std::copy(begin + offset(from), begin + offset(from + count), begin + offset(to));
            return values;
        }
        std::copy_backward(begin + offset(from), begin + offset(from + count),
                           begin + offset(to + count));
    }
    return values;
}

template <typename Result, typename Values>
[[nodiscard]] inline Result array_relative_at(const Values& values, double index) {
    index = std::isnan(index) ? 0.0 : std::trunc(index);
    if (index < 0.0)
        index += static_cast<double>(values.size());
    if (index < 0.0 || index >= static_cast<double>(values.size()))
        return {};
    return values[static_cast<std::size_t>(index)];
}

template <typename Values, typename T>
[[nodiscard]] inline double array_last_index_of(const Values& values, const T& value, double from) {
    if (values.empty())
        return -1.0;
    from = std::isnan(from) ? 0.0 : std::trunc(from);
    if (from < 0.0)
        from += static_cast<double>(values.size());
    if (from < 0.0)
        return -1.0;
    const auto start =
        static_cast<std::size_t>(std::min(from, static_cast<double>(values.size() - 1)));
    for (auto remaining = start + 1; remaining > 0; --remaining) {
        if (values[remaining - 1] == value)
            return static_cast<double>(remaining - 1);
    }
    return -1.0;
}

template <typename Values, typename T>
    requires std::is_enum_v<T>
[[nodiscard]] inline double array_last_index_of(const Values& values, const Nullable<T>& value,
                                                double from) {
    return value ? array_last_index_of(values, *value, from) : -1.0;
}

template <typename T, typename Inserted>
inline Array<T> array_splice_insertions(Array<T>& values, double start, double count,
                                        const Inserted& inserted) {
    const auto first = relative_index(values.size(), start);
    count = std::isnan(count) ? 0.0 : std::max(0.0, std::trunc(count));
    const auto removed =
        static_cast<std::size_t>(std::min(count, static_cast<double>(values.size() - first)));
    const auto begin = values.begin() + static_cast<std::ptrdiff_t>(first);
    const auto end = begin + static_cast<std::ptrdiff_t>(removed);
    Array<T> result(begin, end);
    values.erase(begin, end);
    values.insert(values.begin() + static_cast<std::ptrdiff_t>(first), inserted.begin(),
                  inserted.end());
    return result;
}

template <typename T>
inline Array<T> array_splice(Array<T>& values, double start, double count,
                             std::initializer_list<T> inserted) {
    return array_splice_insertions(values, start, count, inserted);
}

template <typename T>
inline Array<T> array_splice(Array<T>& values, double start, double count,
                             const Array<T>& inserted) {
    // Expanded arguments have their values before the receiver is modified.
    if (values == inserted) {
        const Array<T> copy(inserted.begin(), inserted.end());
        return array_splice_insertions(values, start, count, copy);
    }
    return array_splice_insertions(values, start, count, inserted);
}

// `new Array<T>(count).fill(value)`.
[[nodiscard]] inline std::size_t array_from_length(double count) {
    if (std::isnan(count) || count <= 0.0)
        return 0;
    count = std::trunc(count);
    if (count > 4294967295.0)
        throw std::runtime_error("Array.from length out of range.");
    return static_cast<std::size_t>(count);
}

template <typename T> [[nodiscard]] inline Array<T> array_filled(double count, const T& value) {
    return Array<T>(static_cast<std::size_t>(count), value);
}

[[nodiscard]] inline std::size_t array_index(double index) {
    // The raw fast-path conversion for indices the compiler proved in
    // bounds. It must still be defined over the full double domain — a
    // negative, non-finite, or 2^64-and-up value makes the bare cast
    // undefined behavior — so everything unrepresentable maps to the
    // SIZE_MAX sentinel, which every internal range check rejects.
    return index >= 0.0 && index < 18446744073709551616.0 ? static_cast<std::size_t>(index)
                                                          : std::numeric_limits<std::size_t>::max();
}

// `array.splice(index, 1)` — remove one element and shift the tail down,
// the removal form the reached subset compiles (the particle sweep).
template <typename T> inline void array_splice_one(Array<T>& values, double index) {
    const auto position = array_index(index);
    if (position >= values.size()) [[unlikely]] {
        throw std::runtime_error("Array splice index out of range.");
    }
    values.erase(values.begin() + static_cast<std::ptrdiff_t>(position));
}

// Length writes keep the dense-array contract; sparse growth needs slot presence.
template <typename T> inline void array_truncate(Array<T>& values, double count) {
    if (!std::isfinite(count) || count < 0.0 || count > 4294967295.0 || std::trunc(count) != count)
        throw std::runtime_error("Invalid array length.");
    const auto size = array_index(count);
    if (size > values.size()) [[unlikely]] {
        throw std::runtime_error("Array length assignment must not grow the array.");
    }
    values.resize(size);
}

template <typename T> [[nodiscard]] inline bool array_has_index(const T& values, double index) {
    // Range-check against a constant before conversion so NaN, infinities,
    // negatives and values past any container never reach the cast; the
    // container's own bound is then an integer compare, where a size turned
    // into a double costs an unsigned conversion on every read. Comparing
    // the cast back to the source is the integer test, avoiding std::floor
    // in every dynamic read while retaining JavaScript index semantics.
    constexpr double signed_limit = 9223372036854775808.0; // 2^63
    if (!(index >= 0.0 && index < signed_limit)) {
        return false;
    }
    // Signed on purpose: the range check above bounds the value below
    // 2^63, and a double-to-signed conversion is one instruction where the
    // unsigned form needs a branch around the high half.
    const auto native = static_cast<std::int64_t>(index);
    return static_cast<double>(native) == index && static_cast<std::size_t>(native) < values.size();
}

/**
 * The position of an index `array_has_index` accepted. Such an index is
 * an integer below 2^63, so the signed conversion is exact and one
 * instruction -- the same one the check made -- where a direct unsigned
 * conversion guards the high half on every access.
 */
[[nodiscard]] inline std::size_t accepted_index(double index) {
    return static_cast<std::size_t>(static_cast<std::int64_t>(index));
}

template <typename T> typename Arguments<T>::Result Arguments<T>::get(double index) const {
    if (!array_has_index(values_, index))
        return Result{};
    return Result(values_[accepted_index(index)]);
}

template <typename T> [[nodiscard]] inline T& missing_array_value() {
    // Re-defaulted on every miss so a stray write through one missed index
    // cannot persist into every later miss of the same element type.
    T& slot = realm_scratch<T>();
    slot = T{};
    return slot;
}

template <typename T> [[nodiscard]] inline const T& missing_array_value_readonly() {
    // Never handed out mutably, so one immutable default serves every miss
    // without the mutable slot's per-miss re-defaulting.
    static const T missing{};
    return missing;
}

template <typename T> [[nodiscard]] inline T& array_at_or_default(Array<T>& values, double index) {
    return array_has_index(values, index) ? values[accepted_index(index)]
                                          : missing_array_value<T>();
}

template <typename T>
[[nodiscard]] inline const T& array_at_or_default(const Array<T>& values, double index) {
    return array_has_index(values, index) ? values[accepted_index(index)]
                                          : missing_array_value_readonly<T>();
}

template <typename T, std::size_t Extent>
[[nodiscard]] inline const T& array_at_or_default(std::span<T, Extent> values, double index) {
    return array_has_index(values, index) ? values[accepted_index(index)]
                                          : missing_array_value_readonly<std::remove_const_t<T>>();
}

[[noreturn]] inline void throw_index_error(const char* site, const char* operation, double index,
                                           std::size_t size) {
    throw std::runtime_error(std::string(site) + ": array " + operation + " index " +
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
[[nodiscard]] inline auto& array_index_checked(Values& values, double index, const char* site) {
    if (!array_has_index(values, index)) [[unlikely]] {
        throw_index_error(site, "read", index, values.size());
    }
    return values[accepted_index(index)];
}
template <typename T>
[[nodiscard]] inline T array_index_checked(const TypedArray<T>& values, double index,
                                           const char* site) {
    if (!array_has_index(values, index))
        throw_index_error(site, "read", index, values.size());
    return values.load(accepted_index(index));
}
template <typename T>
[[nodiscard]] inline T array_index_checked(Array<T>&& values, double index, const char* site) {
    if (!array_has_index(values, index))
        throw_index_error(site, "read", index, values.size());
    return values[accepted_index(index)];
}
template <typename T>
[[nodiscard]] inline T array_index_checked(TypedArray<T>& values, double index, const char* site) {
    return array_index_checked(std::as_const(values), index, site);
}

/**
 * The store form of `array_index_checked` for fixed-length storage
 * (typed arrays and tuples). JavaScript drops an out-of-range typed
 * store silently; nothing reached depends on that, so it refuses like
 * the read does rather than hiding the defect.
 */
template <typename Values>
[[nodiscard]] inline auto& array_store_checked(Values& values, double index, const char* site) {
    if (!array_has_index(values, index)) [[unlikely]] {
        throw_index_error(site, "write", index, values.size());
    }
    return values[accepted_index(index)];
}
template <typename T>
[[nodiscard]] inline TypedArraySlot<TypedArray<T>>
array_store_checked(TypedArray<T>& values, double index, const char* site) {
    if (!array_has_index(values, index))
        throw_index_error(site, "write", index, values.size());
    return values.slot(accepted_index(index));
}
[[nodiscard]] inline TypedArraySlot<U8Array> array_store_checked(U8Array& values, double index,
                                                                 const char* site) {
    if (!array_has_index(values, index))
        throw_index_error(site, "write", index, values.size());
    return values.slot(accepted_index(index));
}
/** `array_store_checked` for a store that cannot replace or release the owner. */
template <typename Values>
[[nodiscard]] inline BorrowedTypedArraySlot<Values>
array_store_borrowed(Values& values, double index, const char* site) {
    if (!array_has_index(values, index))
        throw_index_error(site, "write", index, values.size());
    return {values, accepted_index(index)};
}

/**
 * The growing store for an unproven Array index: a write past the end
 * extends the array with default-valued holes exactly as
 * `array_index_write` does, so only an index no JavaScript array could
 * hold (negative, fractional, non-finite, or 2^32-1 and up — where
 * JavaScript stores a plain property instead of an element) refuses.
 */
template <typename T>
[[nodiscard]] inline T& array_index_write_checked(Array<T>& values, double index,
                                                  const char* site) {
    if (!(index >= 0.0 && std::floor(index) == index && index < 4294967295.0)) [[unlikely]] {
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

[[nodiscard]] inline bool number_truthy(double value) { return value != 0.0 && !std::isnan(value); }

// Test the contained value without evaluating an optional-producing call twice.
template <typename T> [[nodiscard]] bool nullable_truthy(const Nullable<T>& value) {
    if (!value.has_value())
        return false;
    if constexpr (std::is_same_v<T, std::string>)
        return !value.value().empty();
    else if constexpr (std::is_arithmetic_v<T>) {
        return number_truthy(static_cast<double>(value.value()));
    } else
        return true; // Present JavaScript objects are truthy, including empty containers.
}

// JavaScript typed arrays reached by the compiled subset.
using F64Array = TypedArray<double>;
using F32Array = TypedArray<float>;
using U16Array = TypedArray<std::uint16_t>;
using I16Array = TypedArray<std::int16_t>;
using I8Array = TypedArray<std::int8_t>;
using U32Array = TypedArray<std::uint32_t>;
using I32Array = TypedArray<std::int32_t>;

/** A numeric index signature can write through arrays with different element storage. */
class NumericArrayView {
public:
    using value_type = double;
    NumericArrayView() = default;
    template <typename Values>
        requires requires(const Values& values) {
            values.size();
            values.identity();
        }
    explicit NumericArrayView(Values values)
        : owner_(std::make_shared<Model<Values>>(std::move(values))) {}

    [[nodiscard]] std::size_t size() const { return owner_ ? owner_->size() : 0; }
    [[nodiscard]] const void* identity() const { return owner_ ? owner_->identity() : nullptr; }
    [[nodiscard]] double load(std::size_t index) const { return owner_->load(index); }
    void store(std::size_t index, double value) { owner_->store(index, value); }
    [[nodiscard]] double read(double index, const char* site) const {
        if (!array_has_index(*this, index))
            throw_index_error(site, "read", index, size());
        return load(accepted_index(index));
    }
    [[nodiscard]] TypedArraySlot<NumericArrayView> slot(double index, const char* site) const {
        if (!(index >= 0.0 && std::floor(index) == index && index < 4294967295.0)) {
            throw_index_error(site, "write", index, size());
        }
        return {*this, static_cast<std::size_t>(index)};
    }
    [[nodiscard]] friend bool operator==(const NumericArrayView& left,
                                         const NumericArrayView& right) {
        return left.identity() == right.identity();
    }

private:
    struct Owner {
        virtual ~Owner() = default;
        virtual std::size_t size() const = 0;
        virtual const void* identity() const = 0;
        virtual double load(std::size_t index) const = 0;
        virtual void store(std::size_t index, double value) = 0;
    };
    template <typename Values> struct Model final : Owner {
        explicit Model(Values source) : values(std::move(source)) {}
        std::size_t size() const override { return values.size(); }
        const void* identity() const override { return values.identity(); }
        double load(std::size_t index) const override {
            return static_cast<double>(typed_array_load(values, index));
        }
        void store(std::size_t index, double value) override {
            if constexpr (requires { array_index_write(values, index); }) {
                array_index_write(values, index) = value;
            } else {
                if (index >= size())
                    throw std::runtime_error("Numeric index write exceeds fixed array storage.");
                if constexpr (requires { values.store(index, value); }) {
                    values.store(index, numeric_store_value<typename Values::value_type>(value));
                } else {
                    values[index] = value;
                }
            }
        }
        Values values;
    };
    std::shared_ptr<Owner> owner_;
};

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
        return static_cast<std::uint32_t>(static_cast<std::int64_t>(value));
    }
    if (!std::isfinite(value))
        return 0u;
    const double truncated = std::trunc(value);
    const double wrapped = std::fmod(truncated, 4294967296.0);
    return static_cast<std::uint32_t>(wrapped < 0.0 ? wrapped + 4294967296.0 : wrapped);
}

template <std::integral Value> [[nodiscard]] inline std::uint32_t to_uint32(Value value) {
    return static_cast<std::uint32_t>(value);
}

[[nodiscard]] inline std::int32_t uint32_as_int32(std::uint32_t value) {
    return value <= 0x7fffffffu
               ? static_cast<std::int32_t>(value)
               : static_cast<std::int32_t>(static_cast<std::int64_t>(value) - 0x100000000ll);
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
    [[nodiscard]] operator double() const { return static_cast<double>(uint32_as_int32(bits)); }
};

struct UnsignedBitwiseNumber {
    std::uint32_t bits = 0;
    [[nodiscard]] operator double() const { return static_cast<double>(bits); }
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
[[nodiscard]] inline SignedBitwiseNumber math_imul(Left left, Right right) {
    return {to_uint32(left) * to_uint32(right)};
}

template <typename Value> [[nodiscard]] inline SignedBitwiseNumber bitwise_not(Value value) {
    return {~to_uint32(value)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber bitwise_and(Left left, Right right) {
    return {to_uint32(left) & to_uint32(right)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber bitwise_or(Left left, Right right) {
    return {to_uint32(left) | to_uint32(right)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber bitwise_xor(Left left, Right right) {
    return {to_uint32(left) ^ to_uint32(right)};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber shift_left(Left left, Right right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    return {to_uint32(left) << count};
}

template <typename Left, typename Right>
[[nodiscard]] inline SignedBitwiseNumber shift_right(Left left, Right right) {
    const std::uint32_t count = to_uint32(right) & 31u;
    const std::uint32_t value = to_uint32(left);
    const std::uint32_t shifted =
        count == 0u ? value
                    : (value >> count) |
                          ((value & 0x80000000u) != 0u ? (~std::uint32_t{0} << (32u - count)) : 0u);
    return {shifted};
}

template <typename Left, typename Right>
[[nodiscard]] inline UnsignedBitwiseNumber shift_right_unsigned(Left left, Right right) {
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

[[nodiscard]] inline std::int8_t to_int8(double value) {
    return std::bit_cast<std::int8_t>(to_uint8(value));
}
template <typename T> [[nodiscard]] T numeric_store_value(double value) {
    if constexpr (std::is_floating_point_v<T>)
        return static_cast<T>(value);
    else if constexpr (std::is_same_v<T, std::uint8_t>)
        return to_uint8(value);
    else if constexpr (std::is_same_v<T, std::int8_t>)
        return to_int8(value);
    else if constexpr (std::is_same_v<T, std::uint16_t>)
        return to_uint16(value);
    else if constexpr (std::is_same_v<T, std::int16_t>)
        return to_int16(value);
    else if constexpr (std::is_same_v<T, std::uint32_t>)
        return to_uint32(value);
    else {
        static_assert(std::is_same_v<T, std::int32_t>);
        return to_int32(value);
    }
}

/**
 * A JavaScript number handed to a native parameter the way an emscripten
 * binding hands it: converted to whatever arithmetic type the parameter
 * declares, as a store of the number into that type converts it.
 */
struct NumberArgument {
    double value;
    template <typename T>
        requires std::is_arithmetic_v<T>
    operator T() const {
        return numeric_store_value<T>(value);
    }
};

[[nodiscard]] inline U8Array u8_array_sized(double count) {
    return U8Array(static_cast<std::size_t>(count));
}

template <typename Values> [[nodiscard]] inline U8Array u8_array_from(const Values& values) {
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

[[nodiscard]] inline I8Array i8_array_sized(double count) {
    return I8Array(static_cast<std::size_t>(count), 0);
}

[[nodiscard]] inline U32Array u32_array_sized(double count) {
    return U32Array(static_cast<std::size_t>(count), 0u);
}

[[nodiscard]] inline I32Array i32_array_sized(double count) {
    return I32Array(static_cast<std::size_t>(count), 0);
}

template <typename Output, typename Values, typename Convert>
[[nodiscard]] inline Output typed_array_from_values(const Values& values, Convert convert) {
    Output result;
    result.reserve(values.size());
    for (std::size_t index = 0; index < values.size(); ++index) {
        result.push_back(convert(static_cast<double>(typed_array_load(values, index))));
    }
    return result;
}

template <typename Values> [[nodiscard]] inline U16Array u16_array_from(const Values& values) {
    return typed_array_from_values<U16Array>(values, to_uint16);
}

template <typename Values> [[nodiscard]] inline I16Array i16_array_from(const Values& values) {
    return typed_array_from_values<I16Array>(values, to_int16);
}

template <typename Values> [[nodiscard]] inline I8Array i8_array_from(const Values& values) {
    return typed_array_from_values<I8Array>(values, to_int8);
}

template <typename Values> [[nodiscard]] inline F32Array f32_array_from(const Values& values) {
    return typed_array_from_values<F32Array>(
        values, [](double value) { return static_cast<float>(value); });
}

template <typename Values> [[nodiscard]] inline F64Array f64_array_from(const Values& values) {
    return typed_array_from_values<F64Array>(values, [](double value) { return value; });
}

template <typename Values> [[nodiscard]] inline U32Array u32_array_from(const Values& values) {
    return typed_array_from_values<U32Array>(values, [](double value) { return to_uint32(value); });
}

template <typename Values> [[nodiscard]] inline I32Array i32_array_from(const Values& values) {
    return typed_array_from_values<I32Array>(values, to_int32);
}

/**
 * A typed array as the array methods read it: `size()` is its length and
 * `operator[]` the number an element holds at the time of the read, through
 * a view's bytes as through owned storage, so a callback's writes reach
 * later reads.
 */
template <typename Values> class TypedArrayNumbers {
public:
    using value_type = double;
    class const_iterator {
    public:
        using iterator_category = std::input_iterator_tag;
        using value_type = double;
        using difference_type = std::ptrdiff_t;
        using pointer = void;
        using reference = double;
        const_iterator() = default;
        const_iterator(const Values* values, std::size_t index) : values_(values), index_(index) {}
        [[nodiscard]] double operator*() const {
            return static_cast<double>(typed_array_load(*values_, index_));
        }
        const_iterator& operator++() {
            ++index_;
            return *this;
        }
        const_iterator operator++(int) {
            auto previous = *this;
            ++index_;
            return previous;
        }
        [[nodiscard]] bool operator==(const const_iterator& other) const {
            return index_ == other.index_;
        }

    private:
        const Values* values_ = nullptr;
        std::size_t index_ = 0;
    };
    explicit TypedArrayNumbers(Values values) : values_(std::move(values)) {}
    [[nodiscard]] std::size_t size() const { return values_.size(); }
    [[nodiscard]] bool empty() const { return values_.size() == 0; }
    [[nodiscard]] double operator[](std::size_t index) const {
        return static_cast<double>(typed_array_load(values_, index));
    }
    [[nodiscard]] const_iterator begin() const { return {&values_, 0}; }
    [[nodiscard]] const_iterator end() const { return {&values_, size()}; }

private:
    Values values_;
};

template <typename Values>
[[nodiscard]] inline TypedArrayNumbers<Values> typed_array_numbers(const Values& values) {
    return TypedArrayNumbers<Values>(values);
}

/**
 * The typed array a `map`, `filter` or `from(source, mapper)` builds: each
 * `push_back` stores the next number as an element store converts it, into
 * storage reserved at the final length when the walk knows it.
 */
template <typename Values> class TypedArrayFill {
public:
    using value_type = double;
    void reserve(std::size_t count) { elements_.reserve(count); }
    void push_back(double value) { elements_.push_back(numeric_store_value<Element>(value)); }
    [[nodiscard]] Values take() {
        if constexpr (std::is_same_v<Values, U8Array>)
            return U8Array(ArrayBuffer(std::move(elements_)));
        else
            return Values(std::move(elements_));
    }

private:
    using Element = typename Values::value_type;
    std::vector<Element> elements_;
};

/** The elements as an owned list of numbers: the list a comparator sort orders. */
template <typename Values>
[[nodiscard]] inline Array<double> typed_array_number_list(const Values& values) {
    return array_from_iterable<double>(typed_array_numbers(values));
}

/** Writes back a list read from the same array, so every number converts exactly. */
template <typename Values, typename Numbers>
inline void typed_array_store_numbers(Values values, const Numbers& numbers) {
    for (std::size_t index = 0; index < numbers.size() && index < values.size(); ++index)
        values.store(index, static_cast<typename Values::value_type>(numbers[index]));
}

/** `%TypedArray%.prototype.sort()`: stable numeric order, -0 before +0, NaN last. */
template <typename Values> inline Values typed_array_sort(Values values) {
    const auto less = [](double left, double right) {
        if (std::isnan(left))
            return false;
        if (std::isnan(right))
            return true;
        if (left != right)
            return left < right;
        return std::signbit(left) && !std::signbit(right);
    };
    // Contiguous element storage sorts in place; a view over a buffer's bytes
    // sorts its numbers and writes them back.
    if constexpr (std::is_same_v<Values, U8Array>) {
        std::stable_sort(values.data(), values.data() + values.size(), less);
    } else if (values.owns_elements()) {
        std::stable_sort(values.begin(), values.end(), less);
    } else {
        auto numbers = typed_array_number_list(values);
        std::stable_sort(numbers.begin(), numbers.end(), less);
        typed_array_store_numbers(values, numbers);
    }
    return values;
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
inline void typed_array_set(TypedArray<T> target, const TypedArray<T>& source, double offset) {
    const auto start = array_index(offset);
    if (start > target.size() || source.size() > target.size() - start) [[unlikely]] {
        throw std::runtime_error("TypedArray set does not fit the target array.");
    }
    if (source.empty())
        return;
    auto target_bytes = target.buffer();
    const auto source_bytes = source.buffer();
    std::memmove(target_bytes.data() + target.byte_offset() + start * sizeof(T),
                 source_bytes.data() + source.byte_offset(), source.size() * sizeof(T));
}

/** The same `set` for the Uint8Array view, whose storage is its own class. */
inline void typed_array_set(U8Array target, const U8Array& source, double offset) {
    const auto start = array_index(offset);
    if (start > target.size() || source.size() > target.size() - start) [[unlikely]] {
        throw std::runtime_error("TypedArray set does not fit the target array.");
    }
    if (source.size() != 0)
        std::memmove(target.data() + start, source.data(), source.size());
}

/** The same `set`, over the owned storage a lowered pinned body keeps a typed array in. */
template <typename T>
inline void typed_array_set(std::vector<T>& target, const std::vector<T>& source, double offset) {
    const auto start = array_index(offset);
    if (start > target.size() || source.size() > target.size() - start) [[unlikely]] {
        throw std::runtime_error("TypedArray set does not fit the target array.");
    }
    std::copy(source.begin(), source.end(), target.begin() + static_cast<std::ptrdiff_t>(start));
}

/**
 * `Math.hypot`, as the plain root of the sum of squares.
 *
 * The ECMAScript spec leaves `Math.hypot` implementation-approximated, so
 * no port can match V8 by construction; this is the adaptation the splat
 * folds record as `splat-hypot-approximation`. One home rather than one per
 * generated translation unit, for the reason `round_js` below has one.
 */
template <typename Range> [[nodiscard]] inline double hypot_js(const Range& values) {
    double sum = 0.0;
    for (double value : values) {
        if (std::isinf(value))
            return std::numeric_limits<double>::infinity();
        sum += value * value;
    }
    return std::sqrt(sum);
}

[[nodiscard]] inline double hypot_js(std::initializer_list<double> values) {
    return hypot_js<std::initializer_list<double>>(values);
}

/**
 * `Math.max` (`Maximum`) or `Math.min` of two operands at ECMA-262's rules:
 * NaN when either is NaN, and `-0` ordered below `+0`. Equal operands tie
 * on their sign bits -- the maximum ANDs them (`+0` wins), the minimum ORs
 * them (`-0` wins) -- and equal nonzero operands share every bit.
 *
 * The ordering is a select; NaN and ties are predicted branches, so a
 * loop-carried fold (a running bound) waits on one compare-select per step
 * rather than on the blends a fully branchless step chains, and no library
 * `signbit` call spills the operands.
 */
template <bool Maximum, std::floating_point Number>
[[nodiscard]] inline Number math_extreme_step(Number left, Number right) {
    using Bits =
        std::conditional_t<sizeof(Number) == sizeof(std::uint64_t), std::uint64_t, std::uint32_t>;
    static_assert(sizeof(Bits) == sizeof(Number));
    // A NaN is the one value unequal to itself; a sum with one is NaN.
    if (left != left || right != right) [[unlikely]] {
        return left + right;
    }
    if (left == right) [[unlikely]] {
        const Bits left_bits = std::bit_cast<Bits>(left);
        const Bits right_bits = std::bit_cast<Bits>(right);
        return std::bit_cast<Number>(
            static_cast<Bits>(Maximum ? left_bits & right_bits : left_bits | right_bits));
    }
    if constexpr (Maximum) {
        return left > right ? left : right;
    } else {
        return left < right ? left : right;
    }
}

/**
 * `Math.max` (`Maximum`) or `Math.min` over `values`, at ECMA-262's rules: a
 * NaN operand makes the result NaN, `-0` orders below `+0`, and an empty
 * list is -Infinity for the maximum and +Infinity for the minimum. None of
 * that is `std::max`/`std::min`'s, and a third argument to either is its
 * comparator. The result is one of the operands, that infinity or NaN, so it
 * is exact at the width it is computed in.
 */
template <bool Maximum, typename Number, typename Range>
[[nodiscard]] inline Number math_extreme_in(const Range& values) {
    auto value = std::begin(values);
    const auto end = std::end(values);
    if (value == end) {
        return Maximum ? -std::numeric_limits<Number>::infinity()
                       : std::numeric_limits<Number>::infinity();
    }
    // Seeded with the first operand rather than the empty list's infinity,
    // which would cost every call one more step.
    Number result = static_cast<Number>(*value);
    while (++value != end) {
        result = math_extreme_step<Maximum>(result, static_cast<Number>(*value));
    }
    return result;
}

/** Over a range of JavaScript numbers: a rest array or a spread source. */
template <bool Maximum, typename Range>
[[nodiscard]] inline double math_extreme(const Range& values) {
    return math_extreme_in<Maximum, double>(values);
}

/**
 * One operand of a `Math.max`/`Math.min` argument list: any native number,
 * as the JavaScript Number it denotes. A braced list of `double` would
 * refuse an integer lane or a `std::uint32_t` option field as narrowing;
 * this converts each one exactly as an arithmetic operand would.
 */
struct MathOperand {
    template <typename Value>
        requires std::convertible_to<Value, double>
    MathOperand(Value value) : number(static_cast<double>(value)) {}
    [[nodiscard]] operator double() const { return number; }
    double number;
};

/**
 * Over a call's own argument list, at JavaScript's width. The braced list
 * evaluates its operands left to right, as JavaScript's argument list does.
 */
template <bool Maximum>
[[nodiscard]] inline double math_extreme(std::initializer_list<MathOperand> operands) {
    return math_extreme_in<Maximum, double>(operands);
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
inline std::uint32_t& random_state() { return realm_state.random; }

inline void seed_random(std::uint32_t seed) { random_state() = seed; }

// A source assignment replaces the function object, not the built-in
// generator's state. Saving this callback preserves an override's closure
// identity; an empty callback denotes the built-in generator.
inline Callback<double()>& random_override() {
    struct RandomOverride {
        Callback<double()> callback;
    };
    return realm_scratch<RandomOverride>().callback;
}

inline void set_random_override(Callback<double()> callback) {
    random_override() = std::move(callback);
}

[[nodiscard]] inline double random_builtin() {
    std::uint32_t& state = random_state();
    state += 0x6D2B79F5u;
    std::uint32_t t = state;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return static_cast<double>((t ^ (t >> 14))) / 4294967296.0;
}

[[nodiscard]] inline Callback<double()> random_function() {
    const auto& override = random_override();
    if (override)
        return override;
    struct BuiltinRandom {
        Callback<double()> callback{random_builtin};
    };
    return realm_scratch<BuiltinRandom>().callback;
}

[[nodiscard]] inline double random_js() {
    const auto& override = random_override();
    return override ? override() : random_builtin();
}

} // namespace bbl::js

#include <bblite/js_text_codec.hpp>
#include <bblite/js_search_params.hpp>
