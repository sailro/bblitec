#pragma once

#include <bblite/teardown.hpp>

#include <algorithm>
#include <array>
#include <cstddef>
#include <deque>
#include <exception>
#include <list>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <tuple>
#include <type_traits>
#include <utility>
#include <unordered_map>
#include <unordered_set>
#include <variant>
#include <vector>

namespace bbl::js {

class TraceVisitor;
namespace gc {
struct Node;
struct Registry {
    std::vector<Node*> nodes;
    std::size_t allocations = 0;
    std::size_t total_allocations = 0;
    unsigned frames_since_collection = 0;
    bool collecting = false;
    std::size_t weak_maps = 0; // Nonempty maps that require ephemeron tracing.
    ~Registry() noexcept;
};
// Generated JavaScript values belong to the control thread, as Ref counts do.
inline thread_local Registry registry;

struct Node {
    std::size_t registry_index = 0;
    std::size_t incoming = 0;
    bool reachable = false;
    bool payload_alive = false;
    bool linked = false;
    Node() = default;
    /** Registers the node; only registered nodes count toward the collection cadence. */
    void attach() {
        const auto index = registry.nodes.size();
        registry.nodes.push_back(this);
        registry_index = index;
        linked = true;
        ++registry.allocations;
        ++registry.total_allocations;
    }
    void detach() noexcept {
        if (!linked)
            return;
        registry.nodes[registry_index] = registry.nodes.back();
        registry.nodes[registry_index]->registry_index = registry_index;
        registry.nodes.pop_back();
        linked = false;
    }
    virtual ~Node() { detach(); }
    Node(const Node&) = delete;
    Node& operator=(const Node&) = delete;
    virtual void trace(const TraceVisitor&) const = 0;
    virtual void clear() noexcept = 0;
    virtual std::size_t owners() const noexcept = 0;
    virtual void pin() noexcept = 0;
    virtual void unpin() noexcept = 0;
    virtual std::weak_ptr<const void> shared_owner() const noexcept { return {}; }
    virtual std::weak_ptr<const void> weak_owner() const noexcept { return shared_owner(); }
};
using SharedNodes = std::vector<std::pair<std::weak_ptr<const void>, Node*>>;

inline Node* find_shared_node(const SharedNodes& shared, const std::weak_ptr<const void>& owner) {
    const std::owner_less<> less;
    const auto found = std::lower_bound(
        shared.begin(), shared.end(), owner,
        [less](const auto& entry, const auto& key) { return less(entry.first, key); });
    // lower_bound already establishes !less(found->first, owner).
    return found != shared.end() && !less(owner, found->first) ? found->second : nullptr;
}
inline std::size_t collect_ephemerons();
} // namespace gc

/** Enumerates owning edges; traversing a reference never traverses its payload. */
class TraceVisitor {
public:
    using Edge = void (*)(gc::Node*, void*);
    using Trace = void (*)(const void*, const TraceVisitor&);
    using Erase = void (*)(const void*, const std::weak_ptr<const void>&);
    struct Discovery {
        gc::Node* (*shared)(const std::weak_ptr<const void>&, const void*, Trace, void*);
        void (*weak)(const std::weak_ptr<const void>&, const void*, Trace, const void*, Erase,
                     void*);
    };
    TraceVisitor(const gc::SharedNodes& shared, Edge edge, void* state = nullptr,
                 const Discovery* discovery = nullptr)
        : shared_(shared), edge_(edge), state_(state), discovery_(discovery) {}
    void edge(gc::Node* node) const {
        if (node)
            edge_(node, state_);
    }
    void reference(gc::Node* node) const {
        if (node && (node->linked || discovery_))
            edge(node);
    }
    template <typename T>
    void ephemeron(const std::weak_ptr<const void>& key, const T& value, const void* owner,
                   Erase erase) const {
        if (discovery_)
            discovery_->weak(key, std::addressof(value), trace_value<T>, owner, erase, state_);
        else
            (*this)(value);
    }
    template <typename T> void operator()(const T& value) const {
        if constexpr (requires { gc_trace_edges(value, *this); }) {
            gc_trace_edges(value, *this);
        } else if constexpr (requires { value.gc_trace(*this); }) {
            value.gc_trace(*this);
        }
        // Unmanaged native values have no described internal edges. References
        // retained by their opaque storage remain external roots conservatively.
    }
    template <typename T> void operator()(const std::shared_ptr<T>& value) const {
        if (!value)
            return;
        const std::weak_ptr<const void> owner(value);
        if (auto* node = gc::find_shared_node(shared_, owner))
            edge(node);
        else if (discovery_) {
            Trace trace = nullptr;
            if constexpr (!std::is_void_v<T> && requires { sizeof(T); })
                trace = trace_value<T>;
            edge(discovery_->shared(owner, value.get(), trace, state_));
        }
    }
    template <typename T> void operator()(const std::weak_ptr<T>&) const {}
    template <typename T> void operator()(const std::optional<T>& value) const {
        if (value)
            (*this)(*value);
    }
    template <typename... Ts> void operator()(const std::variant<Ts...>& value) const {
        if (!value.valueless_by_exception())
            std::visit([&](const auto& item) { (*this)(item); }, value);
    }
    template <typename... Ts> void operator()(const std::tuple<Ts...>& value) const {
        trace_tuple(value, std::index_sequence_for<Ts...>{});
    }
    template <typename A, typename B> void operator()(const std::pair<A, B>& value) const {
        trace_tuple(value, std::index_sequence<0, 1>{});
    }
    template <typename T, std::size_t N> void operator()(const std::array<T, N>& value) const {
        trace_range(value);
    }
    template <typename T, typename A> void operator()(const std::vector<T, A>& value) const {
        trace_range(value);
    }
    template <typename T, typename A> void operator()(const std::deque<T, A>& value) const {
        trace_range(value);
    }
    template <typename T, typename A> void operator()(const std::list<T, A>& value) const {
        trace_range(value);
    }
    template <typename K, typename V, typename C, typename A>
    void operator()(const std::map<K, V, C, A>& value) const {
        trace_range(value);
    }
    template <typename K, typename V, typename H, typename E, typename A>
    void operator()(const std::unordered_map<K, V, H, E, A>& value) const {
        trace_range(value);
    }
    template <typename K, typename C, typename A>
    void operator()(const std::set<K, C, A>& value) const {
        trace_range(value);
    }
    template <typename K, typename H, typename E, typename A>
    void operator()(const std::unordered_set<K, H, E, A>& value) const {
        trace_range(value);
    }
    // Views borrow their elements. Counting them would subtract another owner's
    // references and could collect objects that still have a live root.
    template <typename T, std::size_t N> void operator()(const std::span<T, N>&) const {}
    template <typename T> void operator()(const std::reference_wrapper<T>&) const {}
    template <typename T> void operator()(const std::initializer_list<T>&) const {}
    template <typename C, typename Tr, typename A>
    void operator()(const std::basic_string<C, Tr, A>&) const {}
    template <typename C, typename Tr>
    void operator()(const std::basic_string_view<C, Tr>&) const {}

private:
    template <typename T> static void trace_value(const void* value, const TraceVisitor& visitor) {
        visitor(*static_cast<const T*>(value));
    }
    template <typename T> void trace_range(const T& values) const {
        if constexpr (!std::is_scalar_v<std::remove_cvref_t<decltype(*std::begin(values))>>) {
            for (const auto& value : values)
                (*this)(value);
        }
    }
    template <std::size_t I, typename T> void trace_tuple_field(const T& value) const {
        if constexpr (!std::is_reference_v<std::tuple_element_t<I, T>>)
            (*this)(std::get<I>(value));
    }
    template <typename T, std::size_t... I>
    void trace_tuple(const T& value, std::index_sequence<I...>) const {
        (trace_tuple_field<I>(value), ...);
    }
    const gc::SharedNodes& shared_;
    Edge edge_;
    void* state_;
    const Discovery* discovery_;
};

namespace gc {
/**
 * Whether tracing a value can report an edge: a shared owner, or a payload
 * that describes its edges. Mirrors `TraceVisitor`'s dispatch; a container
 * type specializes it by its elements.
 */
template <typename T>
concept DescribesEdges = requires(const T& value, const TraceVisitor& visitor) {
    value.gc_trace(visitor);
} || requires(const T& value, const TraceVisitor& visitor) { gc_trace_edges(value, visitor); };
template <typename T>
concept Complete = requires { sizeof(T); };
template <typename T> struct Traceable : std::bool_constant<DescribesEdges<T>> {
    // A forward-declared record would answer false and stay cached; refuse it.
    static_assert(Complete<T>, "Traceability is decided on complete types only.");
};
/** Tuple lanes that are references borrow their value and are never traced. */
template <typename T>
struct TraceableField
    : std::bool_constant<!std::is_reference_v<T> && Traceable<std::remove_cv_t<T>>::value> {};
template <typename T> struct Traceable<std::shared_ptr<T>> : std::true_type {};
template <typename T> struct Traceable<std::optional<T>> : Traceable<T> {};
template <typename... Ts>
struct Traceable<std::variant<Ts...>> : std::disjunction<Traceable<Ts>...> {};
template <typename... Ts>
struct Traceable<std::tuple<Ts...>> : std::disjunction<TraceableField<Ts>...> {};
template <typename A, typename B>
struct Traceable<std::pair<A, B>> : std::disjunction<TraceableField<A>, TraceableField<B>> {};
template <typename T, std::size_t N> struct Traceable<std::array<T, N>> : Traceable<T> {};
template <typename T, typename A> struct Traceable<std::vector<T, A>> : Traceable<T> {};
template <typename T, typename A> struct Traceable<std::deque<T, A>> : Traceable<T> {};
template <typename T, typename A> struct Traceable<std::list<T, A>> : Traceable<T> {};
template <typename K, typename V, typename C, typename A>
struct Traceable<std::map<K, V, C, A>> : std::disjunction<Traceable<K>, Traceable<V>> {};
template <typename K, typename V, typename H, typename E, typename A>
struct Traceable<std::unordered_map<K, V, H, E, A>> : std::disjunction<Traceable<K>, Traceable<V>> {
};
template <typename K, typename C, typename A> struct Traceable<std::set<K, C, A>> : Traceable<K> {};
template <typename K, typename H, typename E, typename A>
struct Traceable<std::unordered_set<K, H, E, A>> : Traceable<K> {};
} // namespace gc

template <typename T>
inline constexpr bool gc_traceable = gc::Traceable<std::remove_cv_t<T>>::value;

inline gc::Registry::~Registry() noexcept {
    // Pin the complete registry before clearing cycles; payload destruction
    // can publish more nodes, which join the same teardown.
    collecting = true;
    std::size_t pinned = 0;
    std::size_t cleared = 0;
    for (;;) {
        while (pinned < nodes.size()) {
            nodes[pinned]->pin();
            ++pinned;
        }
        while (cleared < pinned) {
            nodes[cleared]->clear();
            ++cleared;
        }
        if (pinned == nodes.size())
            break;
    }
    // Longer-lived invalid roots must not touch a destroyed thread registry.
    while (!nodes.empty()) {
        auto* node = nodes.back();
        node->detach();
        node->unpin();
    }
}

namespace gc {
template <typename T> struct SharedBlock final : Node {
    template <typename... Args>
    explicit SharedBlock(Args&&... args) : value(std::forward<Args>(args)...) {
        payload_alive = true;
    }
    ~SharedBlock() override {
        detach();
        clear();
    }
    union {
        T value;
    };
    std::weak_ptr<const void> identity;
    std::shared_ptr<const void> retained;
    void trace(const TraceVisitor& visitor) const override {
        if (payload_alive)
            visitor(value);
    }
    void clear() noexcept override {
        if (std::exchange(payload_alive, false))
            std::destroy_at(std::addressof(value));
    }
    std::size_t owners() const noexcept override {
        return static_cast<std::size_t>(identity.use_count());
    }
    void pin() noexcept override { retained = identity.lock(); }
    void unpin() noexcept override { auto release = std::move(retained); }
    std::weak_ptr<const void> shared_owner() const noexcept override { return identity; }
};
} // namespace gc

namespace detail {

/**
 * Heap allocations the thread's recycled lists hold: every kept item and each
 * list's own storage. Allocation accounting subtracts it, so memory a list
 * keeps for reuse is not counted as outstanding.
 */
inline thread_local std::size_t recycled_allocations_held = 0;

/**
 * One thread's free list of `Item`s of one kind, keeping at most `Kept`, so
 * the cells, records and containers a frame creates and drops reuse their
 * memory instead of reaching the heap each time. `Free` releases an item the
 * list does not keep. An item released on another thread joins that
 * thread's list.
 */
template <typename Item, std::size_t Kept, typename Free> struct RecycledList {
    RecycledList() {
        items.reserve(Kept);
        ++recycled_allocations_held;
    }
    RecycledList(const RecycledList&) = delete;
    RecycledList& operator=(const RecycledList&) = delete;
    ~RecycledList() {
        for (Item* item : items)
            Free{}(item);
        recycled_allocations_held -= items.size() + 1;
    }
    /** A kept item, or null. */
    [[nodiscard]] Item* take() noexcept {
        if (items.empty())
            return nullptr;
        Item* item = items.back();
        items.pop_back();
        --recycled_allocations_held;
        return item;
    }
    /** Keeps `item` when there is room; the caller frees it otherwise. */
    [[nodiscard]] bool keep(Item* item) noexcept {
        if (items.size() >= Kept)
            return false;
        items.push_back(item); // Within the reserved capacity: no allocation.
        ++recycled_allocations_held;
        return true;
    }
    std::vector<Item*> items;
};

// The thread's list, reached through a trivially destructible pointer so a
// release during thread teardown, after the list itself is gone, still
// finds out that it is gone and frees its item directly.
template <typename List> inline thread_local List* thread_list = nullptr;
template <typename List> inline thread_local bool thread_list_retired = false;

template <typename List> struct ThreadListOwner {
    List list;
    ~ThreadListOwner() {
        thread_list<List> = nullptr;
        thread_list_retired<List> = true;
    }
};

/** The thread's list, created on first use; null once the thread is tearing down. */
template <typename List> [[nodiscard]] List* recycled_list() {
    if (thread_list<List> == nullptr && !thread_list_retired<List>) {
        static thread_local ThreadListOwner<List> owner;
        thread_list<List> = &owner.list;
    }
    return thread_list<List>;
}

template <typename T> struct FreeBlock {
    void operator()(T* block) const noexcept { std::allocator<T>{}.deallocate(block, 1); }
};

/**
 * The shared blocks of one payload type (the control block with its payload,
 * or a control block alone). The rebound block type owns its allocation contract.
 */
template <typename T, typename Tag> struct RecycledBlocks : RecycledList<T, 128, FreeBlock<T>> {};

/** Shared-block memory drawn from and returned to the thread's list for `Tag`. */
template <typename T, typename Tag> struct RecycledBlockAllocator {
    using value_type = T;
    RecycledBlockAllocator() = default;
    // Implicit, as a standard allocator's rebinding conversion is.
    template <typename U> RecycledBlockAllocator(const RecycledBlockAllocator<U, Tag>&) noexcept {}
    template <typename U> struct rebind {
        using other = RecycledBlockAllocator<U, Tag>;
    };
    [[nodiscard]] T* allocate(std::size_t count) {
        if (count == 1) {
            if (auto* list = recycled_list<RecycledBlocks<T, Tag>>()) {
                if (T* block = list->take())
                    return block;
            }
        }
        return std::allocator<T>{}.allocate(count);
    }
    void deallocate(T* block, std::size_t count) noexcept {
        auto* list = thread_list<RecycledBlocks<T, Tag>>;
        if (count == 1 && list != nullptr && list->keep(block))
            return;
        std::allocator<T>{}.deallocate(block, count);
    }
    template <typename U>
    [[nodiscard]] friend bool operator==(const RecycledBlockAllocator&,
                                         const RecycledBlockAllocator<U, Tag>&) noexcept {
        return true;
    }
};

} // namespace detail

/**
 * Shared storage with ordinary shared_ptr alias/weak semantics. A payload
 * that can own a traced edge joins cycle collection with its visitor; any
 * other payload cannot close a cycle, and reference counting releases it,
 * into the thread's recycled blocks.
 */
template <typename T, typename... Args>
[[nodiscard]] std::shared_ptr<T> make_gc_shared(Args&&... args) {
    if constexpr (!gc_traceable<T>) {
        return std::allocate_shared<T>(detail::RecycledBlockAllocator<T, T>{},
                                       std::forward<Args>(args)...);
    } else {
        auto block = std::make_shared<gc::SharedBlock<T>>(std::forward<Args>(args)...);
        block->identity = block;
        block->attach();
        auto* value = std::addressof(block->value);
        if constexpr (requires { value->gc_bind_node(block.get()); })
            value->gc_bind_node(block.get());
        return {std::move(block), value};
    }
}

/**
 * Container storage joins cycle collection only when its elements can own a
 * traced edge. Storage that cannot is acyclic: reference counting releases
 * it, and it costs the registry nothing.
 */
template <bool Traced, typename T, typename... Args>
[[nodiscard]] std::shared_ptr<T> make_gc_shared_if(Args&&... args) {
    if constexpr (Traced)
        return make_gc_shared<T>(std::forward<Args>(args)...);
    else
        return std::allocate_shared<T>(detail::RecycledBlockAllocator<T, T>{},
                                       std::forward<Args>(args)...);
}

template <typename T> [[nodiscard]] auto make_gc_cell(T&& value) {
    return make_gc_shared<std::decay_t<T>>(std::forward<T>(value));
}

/** Collect unreachable cycles at a control-thread boundary. Acyclic values
 * still die immediately through their existing reference-count operations. */
inline std::size_t collect_cycles() {
    auto& registry = gc::registry;
    if (registry.collecting || registry.nodes.empty())
        return 0;
    if (registry.weak_maps != 0)
        return gc::collect_ephemerons();
    const auto nodes = registry.nodes;
    gc::SharedNodes shared;
    for (auto* node : nodes) {
        auto identity = node->shared_owner();
        if (!identity.expired())
            shared.emplace_back(std::move(identity), node);
    }
    std::sort(shared.begin(), shared.end(), [](const auto& left, const auto& right) {
        return std::owner_less<>{}(left.first, right.first);
    });
    // Finish allocating before pinning nodes or invoking any payload visitor.
    std::vector<gc::Node*> pending;
    pending.reserve(nodes.size());
    registry.collecting = true;
    struct Collection {
        const std::vector<gc::Node*>& nodes;
        ~Collection() {
            for (auto* node : nodes)
                node->unpin();
            gc::registry.collecting = false;
        }
    } collection{nodes};
    for (auto* node : nodes) {
        node->pin();
        node->incoming = 0;
        node->reachable = false;
    }
    const TraceVisitor count(shared, [](gc::Node* node, void*) { ++node->incoming; });
    for (const auto* node : nodes)
        node->trace(count);
    const TraceVisitor mark(
        shared,
        [](gc::Node* node, void* state) {
            if (node->reachable)
                return;
            node->reachable = true;
            static_cast<std::vector<gc::Node*>*>(state)->push_back(node);
        },
        &pending);
    for (auto* node : nodes) {
        // Every counted edge is one owner, and the pin taken above is
        // another, so a node reporting fewer owners than edges has a tracer
        // that enumerated one edge twice. Clearing it would free a live
        // value, so the collector refuses instead.
        if (node->owners() < node->incoming + 1) {
            throw std::logic_error("A gc_trace over-reports the edges into a managed node: " +
                                   std::to_string(node->incoming) + " incoming edge(s) against " +
                                   std::to_string(node->owners()) + " owner(s).");
        }
        if (node->owners() > node->incoming + 1)
            mark.edge(node);
    }
    while (!pending.empty()) {
        auto* node = pending.back();
        pending.pop_back();
        node->trace(mark);
    }
    std::size_t collected = 0;
    for (auto* node : nodes) {
        if (node->reachable)
            continue;
        node->clear();
        ++collected;
    }
    registry.allocations = 0;
    registry.frames_since_collection = 0;
    return collected;
}

inline std::size_t managed_node_count() noexcept { return gc::registry.nodes.size(); }

/** Bounded cadence also handles dropping the last root without allocating. */
inline void collect_at_frame_boundary() {
    auto& registry = gc::registry;
    if (registry.nodes.empty())
        return;
    ++registry.frames_since_collection;
    if (registry.frames_since_collection >= 60 ||
        (registry.frames_since_collection >= 8 && registry.allocations >= 1024)) {
        collect_cycles();
    }
}

/** Declare before generated locals so collection follows their normal teardown.
 * Exhausted memory leaves acyclic owners to process teardown; a refused
 * collection is a tracer defect, reported before the process fails. */
struct CollectOnExit {
    ~CollectOnExit() noexcept {
        try {
            collect_cycles();
        } catch (const std::bad_alloc&) {
            return;
        } catch (const std::exception& error) {
            terminate_after("cycle collection at exit", error.what());
        }
    }
};

} // namespace bbl::js

#include <bblite/js_gc_ephemerons.hpp>
