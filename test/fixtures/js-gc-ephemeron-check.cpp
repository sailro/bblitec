#include <bblite/js_data.hpp>
#include "allocation-tracker.hpp"

#include <cassert>
#include <cstdio>

using namespace bbl::js;

struct PlainKey {
    int value = 0;
};

struct TracedKey : PlainKey {
    void gc_trace(const TraceVisitor&) const {}
};

struct DiscoveryProbe {
    static inline int visits = 0;
    void gc_trace(const TraceVisitor&) const { ++visits; }
};

struct DiscoveryRoot {
    std::shared_ptr<DiscoveryProbe> probe = make_gc_shared_if<false, DiscoveryProbe>();
    void gc_trace(const TraceVisitor& visitor) const { visitor(probe); }
};

void nonempty_maps() {
    assert(gc::registry.weak_maps == 0);
    auto root = make_gc_shared<DiscoveryRoot>();
    WeakMap<int> map;
    auto key = make_ref<PlainKey>();
    const auto identity = key.weak_identity();
    collect_cycles();
    // Empty maps keep the ordinary collector's unregistered-storage shortcut.
    assert(DiscoveryProbe::visits == 0);
    map.set(identity, 1);
    map.set(identity, 2);
    assert(gc::registry.weak_maps == 1 && map.get(identity) == 2);
    {
        auto alias = map;
        WeakMap<int> second;
        second.set(identity, 3);
        assert(gc::registry.weak_maps == 2 && alias.get(identity) == 2);
    }
    assert(gc::registry.weak_maps == 1);
    collect_cycles();
    assert(DiscoveryProbe::visits == 1);
    assert(map.erase(identity) && gc::registry.weak_maps == 0);
    collect_cycles();
    assert(DiscoveryProbe::visits == 1);

    allocation_failure_at = allocation_count;
    bool threw = false;
    try {
        map.set(identity, 4);
    } catch (const std::bad_alloc&) {
        threw = true;
    }
    allocation_failure_at = std::numeric_limits<std::size_t>::max();
    assert(threw && gc::registry.weak_maps == 0 && !map.has(identity));
    map.set(identity, 5);
    key.reset();
    assert(!map.has(identity) && gc::registry.weak_maps == 0);
    collect_cycles();
    assert(DiscoveryProbe::visits == 1 && root->probe != nullptr);
}

template <typename Key> void self_value() {
    WeakMap<Ref<Key>> map;
    auto key = make_ref<Key>();
    const auto identity = key.weak_identity();
    map.set(identity, key);
    key.reset();
    collect_cycles();
    assert(identity.expired() && !map.has(identity));
}

template <typename Key> void external_key() {
    WeakMap<Ref<Key>> map;
    auto key = make_ref<Key>();
    auto value = make_ref<Key>();
    value->value = 41;
    const auto identity = value.weak_identity();
    map.set(key.weak_identity(), value);
    value.reset();
    collect_cycles();
    assert(!identity.expired() && map.get(key.weak_identity())->value == 41);
    key.reset();
    collect_cycles();
    assert(identity.expired());
}

template <typename Key> void key_chain() {
    WeakMap<Ref<Key>> odd;
    WeakMap<Ref<Key>> even;
    std::vector<Ref<Key>> keys;
    std::vector<WeakIdentity> identities;
    for (int index = 0; index < 65; ++index) {
        keys.push_back(make_ref<Key>());
        identities.push_back(keys.back().weak_identity());
    }
    // Alternating maps force reachability to propagate across ephemerons.
    for (std::size_t index = keys.size() - 1; index > 0; --index)
        (index % 2 ? odd : even).set(identities[index - 1], keys[index]);
    even.set(identities.back(), keys.front());
    auto root = keys.front();
    keys.clear();
    collect_cycles();
    for (const auto& identity : identities)
        assert(!identity.expired());
    root.reset();
    collect_cycles();
    for (const auto& identity : identities)
        assert(identity.expired());
}

void unregistered_array_value() {
    WeakMap<Array<Ref<PlainKey>>> map;
    auto key = make_ref<PlainKey>();
    const auto identity = key.weak_identity();
    {
        Array<Ref<PlainKey>> value{key};
        map.set(identity, value);
        key.reset();
        collect_cycles();
        // The separate array owner keeps the key, and therefore the entry, live.
        assert(!identity.expired() && map.has(identity));
    }
    collect_cycles();
    assert(identity.expired() && !map.has(identity));
}

void aliased_value() {
    WeakMap<Array<Ref<PlainKey>>> map;
    auto key = make_ref<PlainKey>();
    const auto identity = key.weak_identity();
    std::shared_ptr<const void> external;
    {
        Array<Ref<PlainKey>> value{key};
        external = value.retained_storage();
        map.set(identity, value);
    }
    key.reset();
    collect_cycles();
    assert(!identity.expired());
    external.reset();
    collect_cycles();
    assert(identity.expired());
}

void late_typed_alias() {
    using Value = std::tuple<std::shared_ptr<const void>, Array<Array<Ref<PlainKey>>>>;
    WeakMap<Value> map;
    auto key = make_ref<PlainKey>();
    const auto identity = key.weak_identity();
    {
        Array<Ref<PlainKey>> inner{key};
        Array<Array<Ref<PlainKey>>> outer{inner};
        // Discovery reaches this owner's opaque alias before the outer array
        // reveals the element type needed to enumerate its key reference.
        map.set(identity, Value{inner.retained_storage(), outer});
    }
    key.reset();
    collect_cycles();
    assert(identity.expired());
}

void closure_value() {
    WeakMap<Callback<int()>> map;
    auto key = make_ref<PlainKey>();
    const auto identity = key.weak_identity();
    Callback<int()> callback =
        make_closure(std::tuple{key}, [](auto& captures) { return std::get<0>(captures)->value; });
    map.set(identity, callback);
    key.reset();
    collect_cycles();
    assert(!identity.expired() && callback() == 0);
    callback = nullptr;
    collect_cycles();
    assert(identity.expired());
}

void callback_key() {
    WeakMap<Callback<int()>> map;
    Callback<int()> key = [] { return 7; };
    const auto identity = key.weak_identity();
    map.set(identity, key);
    key = nullptr;
    collect_cycles();
    assert(identity.expired() && !map.has(identity));
}

struct NestedMapValue {
    Ref<PlainKey> key;
    WeakMap<Ref<NestedMapValue>> map;
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(key);
        visitor(map);
    }
};

void unreachable_map() {
    WeakIdentity key_identity;
    WeakIdentity value_identity;
    {
        auto value = make_ref<NestedMapValue>();
        value->key = make_ref<PlainKey>();
        key_identity = value->key.weak_identity();
        value_identity = value.weak_identity();
        value->map.set(key_identity, value);
    }
    assert(gc::registry.weak_maps == 1);
    collect_cycles();
    assert(key_identity.expired() && value_identity.expired());
    assert(gc::registry.weak_maps == 0);
}

struct PruneValue {
    Ref<PlainKey> key;
    WeakMap<Ref<PruneValue>>* map = nullptr;
    WeakIdentity other;
    ~PruneValue() {
        assert(collect_cycles() == 0);
        if (map)
            map->erase(other);
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(key); }
};

void reentrant_prune() {
    WeakMap<Ref<PruneValue>> map;
    WeakIdentity first_identity;
    WeakIdentity second_identity;
    {
        auto first = make_ref<PruneValue>();
        auto second = make_ref<PruneValue>();
        first->key = make_ref<PlainKey>();
        second->key = make_ref<PlainKey>();
        first_identity = first->key.weak_identity();
        second_identity = second->key.weak_identity();
        first->map = &map;
        first->other = second_identity;
        map.set(first_identity, first);
        map.set(second_identity, second);
    }
    collect_cycles();
    assert(first_identity.expired() && second_identity.expired());
    assert(!map.has(first_identity) && !map.has(second_identity));
}

struct AccessPruneValue {
    WeakMap<std::shared_ptr<AccessPruneValue>>* map = nullptr;
    WeakIdentity other;
    int* destroyed = nullptr;
    ~AccessPruneValue() {
        ++*destroyed;
        map->erase(other);
        assert(gc::registry.weak_maps == 0);
        collect_cycles();
    }
};

void reentrant_access_prune() {
    WeakMap<std::shared_ptr<AccessPruneValue>> map;
    auto first_key = make_ref<PlainKey>();
    auto second_key = make_ref<PlainKey>();
    const auto first_identity = first_key.weak_identity();
    const auto second_identity = second_key.weak_identity();
    int destroyed = 0;
    {
        auto first = std::make_shared<AccessPruneValue>();
        auto second = std::make_shared<AccessPruneValue>();
        first->map = second->map = &map;
        first->destroyed = second->destroyed = &destroyed;
        first->other = second_identity;
        second->other = first_identity;
        map.set(first_identity, first);
        map.set(second_identity, second);
    }
    first_key.reset();
    second_key.reset();
    assert(!map.has(first_identity));
    assert(destroyed == 2 && gc::registry.weak_maps == 0);
}

void allocation_failures() {
    const auto outstanding = outstanding_allocations - detail::recycled_allocations_held;
    bool completed = false;
    for (std::size_t offset = 0; offset < 128; ++offset) {
        WeakMap<Array<Ref<PlainKey>>> map;
        auto key = make_ref<PlainKey>();
        const auto identity = key.weak_identity();
        map.set(identity, Array<Ref<PlainKey>>{key});
        allocation_failure_at = allocation_count + offset;
        bool threw = false;
        try {
            collect_cycles();
        } catch (const std::bad_alloc&) {
            threw = true;
        }
        allocation_failure_at = std::numeric_limits<std::size_t>::max();
        assert(!gc::registry.collecting && key->value == 0 && map.has(identity));
        key.reset();
        collect_cycles();
        // Every partially built graph must release all temporary pins.
        assert(identity.expired());
        if (!threw) {
            completed = true;
            break;
        }
    }
    assert(completed);
    assert(outstanding_allocations - detail::recycled_allocations_held == outstanding);
}

int main() {
    const auto nodes = managed_node_count();
    nonempty_maps();
    self_value<PlainKey>();
    self_value<TracedKey>();
    external_key<PlainKey>();
    external_key<TracedKey>();
    key_chain<PlainKey>();
    key_chain<TracedKey>();
    unregistered_array_value();
    aliased_value();
    late_typed_alias();
    closure_value();
    callback_key();
    unreachable_map();
    reentrant_prune();
    reentrant_access_prune();
    allocation_failures();
    collect_cycles();
    assert(managed_node_count() == nodes);
    assert(gc::registry.weak_maps == 0);
    std::puts("gc-ephemerons: ok");
}
