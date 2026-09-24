#include <bblite/js_data.hpp>
#include <cassert>
#include <functional>
#include <iostream>

/** A registered payload that owns no edge. */
struct Traced {
    int value = 0;
    void gc_trace(const bbl::js::TraceVisitor&) const {}
};

struct CollectingPayload {
    static inline int created = 0;
    static inline int destroyed = 0;

    CollectingPayload() {
        auto child = bbl::js::make_ref<Traced>(41);
        assert(bbl::js::collect_cycles() == 0);
        assert(child->value == 41);
        ++created;
    }

    ~CollectingPayload() {
        ++destroyed;
        auto child = bbl::js::make_ref<Traced>(43);
        assert(bbl::js::collect_cycles() == 0);
        assert(child->value == 43);
    }
    void gc_trace(const bbl::js::TraceVisitor&) const {}
};

struct FailingPayload {
    FailingPayload() {
        auto child = bbl::js::make_ref<Traced>(47);
        assert(bbl::js::collect_cycles() == 0);
        throw 47;
    }
    void gc_trace(const bbl::js::TraceVisitor&) const {}
};

struct ReceiverPayload {
    static inline int live = 0;
    int id;
    std::function<void()> on_destroy;
    explicit ReceiverPayload(int value) : id(value) { ++live; }
    ~ReceiverPayload() { --live; }
    void destroy() {
        if (on_destroy)
            on_destroy();
    }
    void gc_trace(const bbl::js::TraceVisitor&) const {}
};

int main() {
    using namespace bbl::js;
    const auto baseline = managed_node_count();
    for (int iteration = 0; iteration < 100; ++iteration) {
        {
            auto shared = make_gc_shared<CollectingPayload>();
            auto reference = make_ref<CollectingPayload>();
            assert(managed_node_count() == baseline + 2);
        }
        assert(CollectingPayload::created == (iteration + 1) * 2);
        assert(CollectingPayload::destroyed == CollectingPayload::created);
        assert(managed_node_count() == baseline);
    }
    for (bool shared : {false, true}) {
        bool caught = false;
        try {
            if (shared)
                (void)make_gc_shared<FailingPayload>();
            else
                (void)make_ref<FailingPayload>();
        } catch (int value) {
            caught = value == 47;
        }
        assert(caught && managed_node_count() == baseline);
    }
    {
        auto value = make_ref<Traced>(53);
        auto lifetime = value.lifetime_owner();
        const auto* selected = value.get();
        value.reset();
        assert(collect_cycles() == 0);
        assert(selected->value == 53);
    }
    {
        struct Scope {
            Ref<Traced>::LifetimeOwner owner;
            explicit Scope(const Ref<Traced>& value) : owner(value.lifetime_owner()) {}
        };
        auto value = make_ref<Traced>(57);
        const auto* selected = value.get();
        std::optional<Scope> first(std::in_place, value);
        std::optional<Scope> middle(std::in_place, value);
        std::optional<Scope> last(std::in_place, value);
        value.reset();
        middle.reset();
        first.reset();
        assert(collect_cycles() == 0);
        assert(selected->value == 57);
        last.reset();
        assert(managed_node_count() == baseline);
    }
    {
        auto slot = make_ref<ReceiverPayload>(59);
        auto replacement = make_ref<ReceiverPayload>(61);
        {
            auto lifetime = slot.lifetime_owner();
            auto receiver = slot;
            receiver->on_destroy = [&] {
                assert(slot == receiver);
                auto nested = receiver.lifetime_owner();
                slot = replacement;
                assert(collect_cycles() == 0 && receiver->id == 59);
            };
            receiver->destroy();
            slot.reset();
            assert(receiver->id == 59 && ReceiverPayload::live == 2);
        }
        assert(ReceiverPayload::live == 1);
    }
    assert(ReceiverPayload::live == 0);
    assert(managed_node_count() == baseline);
    std::cout << "gc-reentrant-lifetime: ok\n";
}
