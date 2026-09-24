#include <bblite/js_data.hpp>
#include "allocation-tracker.hpp"

#include <cassert>
#include <cstdio>
#include <string_view>

using namespace bbl::js;

template <typename T> gc::Node* node_of(const Ref<T>& value) {
    gc::Node* node = nullptr;
    const gc::SharedNodes shared;
    value.gc_trace(TraceVisitor(
        shared, [](gc::Node* edge, void* output) { *static_cast<gc::Node**>(output) = edge; },
        &node));
    return node;
}

void check_registry() {
    std::size_t count = 0;
    for (const auto* node : gc::registry.nodes) {
        assert(node->registry_index == count && node->linked);
        assert(++count <= managed_node_count());
    }
    assert(count == managed_node_count());
}

/** Describes its (absent) edges, so its references join the registry. */
struct Payload {
    static inline int live = 0;
    int value;
    explicit Payload(int input) : value(input) { ++live; }
    ~Payload() { --live; }
    void gc_trace(const TraceVisitor&) const {}
};

/** A registered root that owns no edge. */
struct Traced {
    int value = 0;
    void gc_trace(const TraceVisitor&) const {}
};

static_assert(!gc_traceable<Ref<int>> && !gc_traceable<Array<Ref<int>>>);
static_assert(gc_traceable<Ref<Traced>> && gc_traceable<Array<Ref<Traced>>>);

/** A closure registers its body only when its captures can own an edge. */
void closure_bodies() {
    const auto nodes = managed_node_count();
    auto holder = make_ref<Traced>();
    holder->value = 3;
    {
        const Callback<int()> untraced{
            make_closure(std::tuple{2}, [](std::tuple<int>& env) { return std::get<0>(env); })};
        assert(untraced() == 2 && managed_node_count() == nodes + 1);
        const Callback<int()> traced{
            make_closure(std::tuple{holder},
                         [](std::tuple<Ref<Traced>>& env) { return std::get<0>(env)->value; })};
        assert(traced() == 3 && managed_node_count() == nodes + 2);
    }
    holder.reset();
    assert(managed_node_count() == nodes);
    check_registry();
}

/** A payload that describes no edge cannot close a cycle and stays out of the registry. */
void untraced_payloads() {
    const auto nodes = managed_node_count();
    const auto managed_allocations = gc::registry.total_allocations;
    const auto outstanding = outstanding_allocations;
    {
        auto plain = make_ref<int>(5);
        auto copy = plain;
        auto cell = make_gc_shared<double>(2.5);
        auto holder = make_ref<Traced>();
        assert(!node_of(plain) && *copy == 5 && *cell == 2.5);
        assert(managed_node_count() == nodes + 1);
        assert(gc::registry.total_allocations == managed_allocations + 1);
        assert(collect_cycles() == 0 && *plain == 5 && holder->value == 0);
    }
    assert(managed_node_count() == nodes && outstanding_allocations == outstanding);
    check_registry();
}

void ref_owners_and_allocations() {
    const auto nodes = managed_node_count();
    const auto allocations = allocation_count;
    const auto outstanding = outstanding_allocations;
    const auto managed_allocations = gc::registry.total_allocations;
    std::weak_ptr<const void> weak;
    {
        auto source = make_ref<Payload>(42);
        auto* node = node_of(source);
        assert(node && node->owners() == 1 && Payload::live == 1);
        assert(allocation_count == allocations + 1);
        assert(outstanding_allocations == outstanding + 1);
        assert(gc::registry.total_allocations == managed_allocations + 1);
        {
            auto copy = source;
            assert(node->owners() == 2 && copy == source);
            auto moved = std::move(copy);
            assert(!copy && moved == source && node->owners() == 2);
            Ref<Payload> assigned;
            assigned = source;
            assert(node->owners() == 3);
            const auto& same = source;
            source = same;
            assert(source->value == 42 && node->owners() == 3);
            auto& same_move = source;
            source = std::move(same_move);
            assert(source->value == 42 && node->owners() == 3);
            Ref<Payload> moved_to;
            moved_to = std::move(assigned);
            assert(!assigned && moved_to == source && node->owners() == 3);
            moved.reset();
            moved.reset();
            assert(node->owners() == 2);
            node->pin();
            assert(node->owners() == 3);
            node->unpin();
            assert(node->owners() == 2);
        }
        assert(node->owners() == 1);
        assert(allocation_count == allocations + 1);
        weak = source.weak_identity();
        const auto duplicate = source.weak_identity();
        const std::owner_less<> less;
        assert(!weak.expired() && !less(weak, duplicate) && !less(duplicate, weak));
        assert(allocation_count == allocations + 2);
        assert(outstanding_allocations == outstanding + 2);
        assert(collect_cycles() == 0 && node->owners() == 1);
        assert(source->value == 42);
    }
    assert(weak.expired() && Payload::live == 0);
    assert(outstanding_allocations == outstanding + 1);
    weak.reset();
    assert(outstanding_allocations == outstanding);
    assert(managed_node_count() == nodes);
    check_registry();
}

void shared_alias_owners_and_allocations() {
    const auto nodes = managed_node_count();
    const auto allocations = allocation_count;
    const auto outstanding = outstanding_allocations;
    auto source = make_gc_shared<Payload>(7);
    auto* node = gc::registry.nodes.back();
    assert(node->owners() == 1 && allocation_count == allocations + 1);
    std::shared_ptr<int> alias(source, &source->value);
    std::weak_ptr<int> weak(alias);
    assert(node->owners() == 2 && allocation_count == allocations + 1);
    source.reset();
    assert(*alias == 7 && Payload::live == 1 && node->owners() == 1);
    assert(collect_cycles() == 0 && node->owners() == 1);
    alias.reset();
    assert(weak.expired() && Payload::live == 0 && managed_node_count() == nodes);
    assert(outstanding_allocations == outstanding + 1);
    weak.reset();
    assert(outstanding_allocations == outstanding);
    check_registry();
}

struct Cycle {
    static inline int live = 0;
    Ref<Cycle> reference;
    std::shared_ptr<Cycle> shared;
    Cycle() { ++live; }
    ~Cycle() { --live; }
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(reference);
        visitor(shared);
    }
};

void exact_cycle_edges() {
    const auto nodes = managed_node_count();
    const auto outstanding = outstanding_allocations;
    auto reference = make_ref<Cycle>();
    auto* reference_node = node_of(reference);
    auto shared = make_gc_shared<Cycle>();
    auto* shared_node = gc::registry.nodes.back();
    reference->reference = reference;
    reference->shared = shared;
    shared->reference = reference;
    shared->shared = shared;
    auto identity = reference.weak_identity();
    assert(reference_node->owners() == 3 && shared_node->owners() == 3);
    assert(collect_cycles() == 0 && Cycle::live == 2);
    assert(reference_node->incoming == 2 && shared_node->incoming == 2);
    assert(reference_node->owners() == 3 && shared_node->owners() == 3);
    reference.reset();
    shared.reset();
    assert(reference_node->owners() == 2 && shared_node->owners() == 2);
    assert(collect_cycles() == 2);
    assert(Cycle::live == 0 && identity.expired());
    assert(managed_node_count() == nodes);
    identity.reset();
    assert(outstanding_allocations == outstanding);
    check_registry();
}

struct CollectDuringConstruction {
    explicit CollectDuringConstruction(std::size_t expected_nodes) {
        assert(managed_node_count() == expected_nodes);
        assert(collect_cycles() == 0);
    }
    void gc_trace(const TraceVisitor&) const {}
};

void construction_reentrancy() {
    const auto nodes = managed_node_count();
    const auto outstanding = outstanding_allocations;
    {
        auto root = make_ref<Traced>(42);
        auto reference = make_ref<CollectDuringConstruction>(nodes + 1);
        auto shared = make_gc_shared<CollectDuringConstruction>(nodes + 2);
        assert(root->value == 42);
        assert(managed_node_count() == nodes + 3);
        check_registry();
    }
    assert(managed_node_count() == nodes && outstanding_allocations == outstanding);
}

struct CollectDuringDestruction {
    static inline int destructions = 0;
    ~CollectDuringDestruction() {
        if (++destructions == 1) {
            auto replacement = make_ref<Traced>(17);
            collect_cycles();
            assert(replacement->value == 17);
        }
    }
    void gc_trace(const TraceVisitor&) const {}
};

void destruction_reentrancy() {
    const auto nodes = managed_node_count();
    const auto outstanding = outstanding_allocations;
    {
        auto root = make_ref<Traced>(42);
        CollectDuringDestruction::destructions = 0;
        auto reference = make_ref<CollectDuringDestruction>();
        reference.reset();
        assert(CollectDuringDestruction::destructions == 1 && root->value == 42);
        assert(managed_node_count() == nodes + 1);
        CollectDuringDestruction::destructions = 0;
        auto shared = make_gc_shared<CollectDuringDestruction>();
        shared.reset();
        assert(CollectDuringDestruction::destructions == 1 && root->value == 42);
        assert(managed_node_count() == nodes + 1);
        check_registry();
    }
    assert(managed_node_count() == nodes && outstanding_allocations == outstanding);
}

struct FailingConstruction {
    Ref<Traced> child = make_ref<Traced>(19);
    explicit FailingConstruction(std::size_t expected_nodes) {
        assert(managed_node_count() == expected_nodes + 1);
        assert(collect_cycles() == 0);
        throw 19;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(child); }
};

void construction_failure() {
    const auto nodes = managed_node_count();
    const auto outstanding = outstanding_allocations;
    for (const bool shared : {false, true}) {
        bool threw = false;
        try {
            if (shared)
                (void)make_gc_shared<FailingConstruction>(nodes);
            else
                (void)make_ref<FailingConstruction>(nodes);
        } catch (int value) {
            threw = value == 19;
        }
        assert(threw && managed_node_count() == nodes);
        assert(outstanding_allocations == outstanding);
        check_registry();
    }
}

void registry_growth_failure() {
    std::vector<Ref<Traced>> roots;
    roots.reserve(gc::registry.nodes.capacity());
    while (gc::registry.nodes.size() < gc::registry.nodes.capacity())
        roots.push_back(make_ref<Traced>(23));
    const auto nodes = managed_node_count();
    const auto outstanding = outstanding_allocations;
    for (const bool shared : {false, true}) {
        const auto allocations = allocation_count;
        const auto managed_allocations = gc::registry.total_allocations;
        allocation_failure_at = allocations + 1;
        bool threw = false;
        try {
            if (shared)
                (void)make_gc_shared<Payload>(29);
            else
                (void)make_ref<Payload>(29);
        } catch (const std::bad_alloc&) {
            threw = true;
        }
        allocation_failure_at = std::numeric_limits<std::size_t>::max();
        assert(threw && allocation_count == allocations + 1);
        assert(gc::registry.total_allocations == managed_allocations);
        assert(Payload::live == 0 && managed_node_count() == nodes);
        assert(outstanding_allocations == outstanding);
        check_registry();
    }
}

int main(int argc, char** argv) {
    const std::string_view selected = argc > 1 ? argv[1] : "all";
    gc::registry.nodes.reserve(16);
    const auto nodes = managed_node_count();
    const auto outstanding = outstanding_allocations;
    if (selected == "all" || selected == "owners") {
        ref_owners_and_allocations();
        untraced_payloads();
        closure_bodies();
        shared_alias_owners_and_allocations();
        exact_cycle_edges();
    }
    if (selected == "all" || selected == "construction")
        construction_reentrancy();
    if (selected == "all" || selected == "destruction")
        destruction_reentrancy();
    if (selected == "all" || selected == "failure") {
        construction_failure();
        registry_growth_failure();
    }
    assert(managed_node_count() == nodes && outstanding_allocations == outstanding);
    std::printf(
        "ref-gc-ownership-check: ok (Ref=1 allocation, weak token=1, shared=1; "
        "untraced payloads and closures unregistered; cycle edges=2/2, collected=2; registry and allocations "
        "restored)\n");
}
