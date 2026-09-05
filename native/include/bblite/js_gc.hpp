#pragma once

#include <algorithm>
#include <array>
#include <cassert>
#include <cstddef>
#include <deque>
#include <list>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <span>
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
    Node* first = nullptr;
    std::size_t size = 0;
    std::size_t allocations = 0;
    unsigned frames_since_collection = 0;
    bool collecting = false;
};
// Generated JavaScript values belong to the control thread, as Ref counts do.
inline thread_local Registry registry;

struct Node {
    Node* previous = nullptr;
    Node* next = nullptr;
    std::size_t incoming = 0;
    bool reachable = false;
    bool payload_alive = true;
    Node() {
        next = registry.first;
        if (next) next->previous = this;
        registry.first = this;
        ++registry.size;
        ++registry.allocations;
    }
    virtual ~Node() {
        if (previous) previous->next = next;
        else registry.first = next;
        if (next) next->previous = previous;
        --registry.size;
    }
    Node(const Node&) = delete;
    Node& operator=(const Node&) = delete;
    virtual void trace(const TraceVisitor&) const = 0;
    virtual void clear() noexcept = 0;
    virtual std::size_t owners() const noexcept = 0;
    virtual void pin() noexcept = 0;
    virtual void unpin() noexcept = 0;
    virtual std::weak_ptr<const void> shared_owner() const noexcept { return {}; }
};
using SharedNodes = std::vector<std::pair<std::weak_ptr<const void>, Node*>>;

inline Node* find_shared_node(const SharedNodes& shared, const std::weak_ptr<const void>& owner) {
    const std::owner_less<> less;
    const auto found = std::lower_bound(shared.begin(), shared.end(), owner,
        [less](const auto& entry, const auto& key) { return less(entry.first, key); });
    // lower_bound already establishes !less(found->first, owner).
    return found != shared.end() && !less(owner, found->first) ? found->second : nullptr;
}
}

/** Enumerates owning edges; traversing a reference never traverses its payload. */
class TraceVisitor {
  public:
    using Edge = void (*)(gc::Node*, void*);
    TraceVisitor(const gc::SharedNodes& shared, Edge edge, void* state = nullptr)
        : shared_(shared), edge_(edge), state_(state) {}
    void edge(gc::Node* node) const { if (node) edge_(node, state_); }
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
        if (!value) return;
        edge(gc::find_shared_node(shared_, std::weak_ptr<const void>(value)));
    }
    template <typename T> void operator()(const std::weak_ptr<T>&) const {}
    template <typename T> void operator()(const std::optional<T>& value) const {
        if (value) (*this)(*value);
    }
    template <typename... Ts> void operator()(const std::variant<Ts...>& value) const {
        if (!value.valueless_by_exception()) std::visit([&](const auto& item) { (*this)(item); }, value);
    }
    template <typename... Ts> void operator()(const std::tuple<Ts...>& value) const {
        trace_tuple(value, std::index_sequence_for<Ts...>{});
    }
    template <typename A, typename B> void operator()(const std::pair<A, B>& value) const {
        trace_tuple(value, std::index_sequence<0, 1>{});
    }
    template <typename T, std::size_t N> void operator()(const std::array<T, N>& value) const { trace_range(value); }
    template <typename T, typename A> void operator()(const std::vector<T, A>& value) const { trace_range(value); }
    template <typename T, typename A> void operator()(const std::deque<T, A>& value) const { trace_range(value); }
    template <typename T, typename A> void operator()(const std::list<T, A>& value) const { trace_range(value); }
    template <typename K, typename V, typename C, typename A>
    void operator()(const std::map<K, V, C, A>& value) const { trace_range(value); }
    template <typename K, typename V, typename H, typename E, typename A>
    void operator()(const std::unordered_map<K, V, H, E, A>& value) const { trace_range(value); }
    template <typename K, typename C, typename A>
    void operator()(const std::set<K, C, A>& value) const { trace_range(value); }
    template <typename K, typename H, typename E, typename A>
    void operator()(const std::unordered_set<K, H, E, A>& value) const { trace_range(value); }
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
    template <typename T> void trace_range(const T& values) const {
        for (const auto& value : values) (*this)(value);
    }
    template <std::size_t I, typename T> void trace_tuple_field(const T& value) const {
        if constexpr (!std::is_reference_v<std::tuple_element_t<I, T>>) (*this)(std::get<I>(value));
    }
    template <typename T, std::size_t... I>
    void trace_tuple(const T& value, std::index_sequence<I...>) const {
        (trace_tuple_field<I>(value), ...);
    }
    const gc::SharedNodes& shared_;
    Edge edge_;
    void* state_;
};

namespace gc {
template <typename T> struct SharedBlock final : Node {
    template <typename... Args>
    explicit SharedBlock(Args&&... args) : value(std::in_place, std::forward<Args>(args)...) {}
    ~SharedBlock() override { clear(); }
    std::optional<T> value;
    std::weak_ptr<const void> identity;
    std::shared_ptr<const void> retained;
    void trace(const TraceVisitor& visitor) const override { if (value) visitor(*value); }
    void clear() noexcept override { payload_alive = false; value.reset(); }
    std::size_t owners() const noexcept override { return static_cast<std::size_t>(identity.use_count()); }
    void pin() noexcept override { retained = identity.lock(); }
    void unpin() noexcept override { auto release = std::move(retained); }
    std::weak_ptr<const void> shared_owner() const noexcept override { return identity; }
};
}

/** Shared storage with ordinary shared_ptr alias/weak semantics and a visitor. */
template <typename T, typename... Args>
[[nodiscard]] std::shared_ptr<T> make_gc_shared(Args&&... args) {
    auto block = std::make_shared<gc::SharedBlock<T>>(std::forward<Args>(args)...);
    block->identity = block;
    auto* value = std::addressof(*block->value);
    if constexpr (requires { value->gc_bind_node(block.get()); }) value->gc_bind_node(block.get());
    return {std::move(block), value};
}

/** Collect unreachable cycles at a control-thread boundary. Acyclic values
 * still die immediately through their existing reference-count operations. */
inline std::size_t collect_cycles() {
    auto& registry = gc::registry;
    if (registry.collecting || !registry.first) return 0;
    std::vector<gc::Node*> nodes;
    nodes.reserve(registry.size);
    gc::SharedNodes shared;
    for (auto* node = registry.first; node; node = node->next) {
        nodes.push_back(node);
        auto identity = node->shared_owner();
        if (!identity.expired()) shared.emplace_back(std::move(identity), node);
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
            for (auto* node : nodes) node->unpin();
            gc::registry.collecting = false;
        }
    } collection{nodes};
    for (auto* node : nodes) {
        node->pin();
        node->incoming = 0;
        node->reachable = false;
    }
    const TraceVisitor count(shared, [](gc::Node* node, void*) { ++node->incoming; });
    for (const auto* node : nodes) node->trace(count);
    const TraceVisitor mark(shared, [](gc::Node* node, void* state) {
        if (node->reachable) return;
        node->reachable = true;
        static_cast<std::vector<gc::Node*>*>(state)->push_back(node);
    }, &pending);
    for (auto* node : nodes) {
        assert(node->owners() >= node->incoming + 1);
        if (node->owners() > node->incoming + 1) mark.edge(node);
    }
    while (!pending.empty()) {
        auto* node = pending.back();
        pending.pop_back();
        node->trace(mark);
    }
    std::size_t collected = 0;
    for (auto* node : nodes) {
        if (node->reachable) continue;
        node->clear();
        ++collected;
    }
    registry.allocations = 0;
    registry.frames_since_collection = 0;
    return collected;
}

inline std::size_t managed_node_count() noexcept { return gc::registry.size; }

/** Bounded cadence also handles dropping the last root without allocating. */
inline void collect_at_frame_boundary() {
    auto& registry = gc::registry;
    if (!registry.first) return;
    ++registry.frames_since_collection;
    if (registry.frames_since_collection >= 60 ||
        (registry.frames_since_collection >= 8 && registry.allocations >= 1024)) {
        collect_cycles();
    }
}

/** Declare before generated locals so collection follows their normal teardown. */
struct CollectOnExit {
    ~CollectOnExit() noexcept {
        try { collect_cycles(); }
        catch (const std::bad_alloc&) { /* Process teardown still releases acyclic owners. */ }
    }
};

} // namespace bbl::js
