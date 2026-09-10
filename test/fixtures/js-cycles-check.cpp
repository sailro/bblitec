#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>
#include <cassert>
#include <iostream>
#include <stdexcept>
#include <string>
#include <type_traits>

using namespace bbl::js;
struct Link;
using LinkRef = Ref<Link>;
struct Link {
    LinkRef next;
    Array<LinkRef> children;
    Map<LinkRef, LinkRef> map;
    Set<LinkRef> set;
    Callback<void()> callback;
    std::optional<Map<LinkRef, LinkRef>::Iterator> iterator;
    static inline int live = 0;
    Link() { ++live; }
    ~Link() { --live; }
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(next);
        visitor(children);
        visitor(map);
        visitor(set);
        visitor(callback);
        visitor(iterator);
    }
};

struct BorrowedTuple {
    Ref<BorrowedTuple> self;
    std::tuple<LinkRef&> borrowed;
    void gc_trace(const TraceVisitor& visitor) const { visitor(self); visitor(borrowed); }
};
struct BorrowedList {
    Ref<BorrowedList> self;
    std::initializer_list<LinkRef> borrowed;
    void gc_trace(const TraceVisitor& visitor) const { visitor(self); visitor(borrowed); }
};

struct NonFunctionUnaryPlus {
    int operator+() const { return 1; }
    int operator()(std::tuple<int>& environment) const { return ++std::get<0>(environment); }
};

struct ObservableEmptyInvoker {
    static inline int constructions = 0, destructions = 0;
    ObservableEmptyInvoker() { ++constructions; }
    ~ObservableEmptyInvoker() { ++destructions; }
    using Function = int (*)(std::tuple<int>&);
    Function operator+() const { return +[](std::tuple<int>& environment) { return ++std::get<0>(environment); }; }
    int operator()(std::tuple<int>& environment) const { return ++std::get<0>(environment); }
};

void typed_closure_call_contracts() {
    using Environment = std::tuple<int>;
    auto reference = make_closure(Environment{4}, [](Environment& environment) noexcept -> int& {
        return std::get<0>(environment);
    });
    static_assert(std::is_same_v<decltype(reference.invoke), int& (*)(Environment&) noexcept>);
    static_assert(noexcept(reference.invoke(reference.environment)));
    int& alias = reference();
    alias = 9;
    assert(std::get<0>(reference.environment) == 9);
    Callback<int&()> callback{std::move(reference)};
    callback() = 11;
    assert(callback() == 11);

    auto throwing = make_closure(Environment{0}, [](Environment& environment) -> int {
        ++std::get<0>(environment);
        throw std::runtime_error("closure exception");
    });
    static_assert(!noexcept(throwing.invoke(throwing.environment)));
    bool caught = false;
    try { throwing(); } catch (const std::runtime_error& error) { caught = std::string(error.what()) == "closure exception"; }
    assert(caught && std::get<0>(throwing.environment) == 1);

    static_assert(std::is_empty_v<ObservableEmptyInvoker>);
    auto observable = make_closure(Environment{20}, ObservableEmptyInvoker{});
    static_assert(std::is_same_v<decltype(observable.invoke), ObservableEmptyInvoker>);
    const int constructions = ObservableEmptyInvoker::constructions;
    const int destructions = ObservableEmptyInvoker::destructions;
    assert(observable() == 21 && observable() == 22);
    assert(ObservableEmptyInvoker::constructions == constructions &&
        ObservableEmptyInvoker::destructions == destructions);
}

void typed_closure_identity() {
    using Environment = std::tuple<int>;
    auto first = make_closure(Environment{0}, [](Environment& environment, int amount) -> int {
        return std::get<0>(environment) += amount;
    });
    auto second = make_closure(Environment{100}, [](Environment& environment, int amount) -> int {
        return std::get<0>(environment) += amount * 2;
    });
    // Different lexical invokers must share their dispatch/GC/RTTI types.
    static_assert(std::is_same_v<decltype(first), decltype(second)>);
    static_assert(std::is_same_v<decltype(first.invoke), int (*)(Environment&, int)>);
    assert(first.invoke != second.invoke);
    Callback<int(int)> callback{std::move(first)};
    Callback<int(int)> other{std::move(second)};
    auto copied = callback;
    auto erased = callback.body();
    assert(callback == copied && callback != other);
    assert(callback(1) == 1 && copied(2) == 3 && erased(4) == 7);
    assert(other(3) == 106);
    callback = {};
    assert(copied(1) == 8 && erased(1) == 9);

    auto generic = make_closure(Environment{10}, [](auto& environment, auto amount) {
        return std::get<0>(environment) += amount;
    });
    static_assert(!std::is_pointer_v<decltype(generic.invoke)>);
    assert(generic(2) == 12);
    auto custom = make_closure(Environment{20}, NonFunctionUnaryPlus{});
    static_assert(std::is_same_v<decltype(custom.invoke), NonFunctionUnaryPlus>);
    assert(custom() == 21);
}

void typed_closure_replaced_capture_cycles() {
    const auto baseline = managed_node_count();
    auto record = make_ref<Link>();
    record->next = record;
    using Environment = std::tuple<LinkRef, bool>;
    record->callback = make_closure(Environment{record, false}, [](Environment& environment) {
        auto& captured = std::get<0>(environment);
        auto& replaced = std::get<1>(environment);
        if (!replaced) {
            auto next = make_ref<Link>();
            next->callback = captured->callback;
            next->next = next;
            captured = std::move(next);
            replaced = true;
        } else {
            assert(captured->next == captured);
        }
    });
    auto callback = record->callback;
    auto copied = callback;
    record.reset();
    assert(collect_cycles() == 0 && Link::live == 1);
    callback();
    assert(Link::live == 2);
    assert(collect_cycles() > 0 && Link::live == 1); // Only the replaced capture's cycle dies.
    copied(); // The copied function sees the replacement flag and live record.
    assert(Link::live == 1 && copied == callback);
    callback = {};
    assert(collect_cycles() == 0 && Link::live == 1);
    copied = {};
    assert(collect_cycles() > 0 && Link::live == 0);
    assert(managed_node_count() == baseline);
}

int main() {
    const auto baseline = managed_node_count();
    typed_closure_identity();
    typed_closure_call_contracts();
    typed_closure_replaced_capture_cycles();
    assert(managed_node_count() == baseline);
    { auto plain = make_ref<Link>(); }
    assert(Link::live == 0 && managed_node_count() == baseline);
    for (int iteration = 0; iteration < 100; ++iteration) {
        auto a = make_ref<Link>();
        auto b = make_ref<Link>();
        a->next = a;
        a->children.push_back(b);
        b->children.push_back(a);
        a->map.set(a, b);
        assert(a->map.has(a)); // Cached key owns another reference to a.
        b->set.add(a);
        auto children = a->children;
        auto duplicate = children;
        a.reset();
        b.reset();
        assert(collect_cycles() == 0);
        assert(Link::live == 2 && children[0]->children[0]->next);
        children = Array<LinkRef>{};
        assert(collect_cycles() == 0);
        duplicate = Array<LinkRef>{};
        assert(collect_cycles() > 0 && Link::live == 0);
    }
    assert(managed_node_count() == baseline);
    {
        auto a = make_ref<Link>();
        a->map.set(a, a);
        {
            auto iterator = a->map.begin();
            assert(a->map.erase(a)); // Its inactive slot stays owned by the live iterator.
            a.reset();
            assert(collect_cycles() == 0);
            assert(Link::live == 1);
        }
        collect_cycles();
        assert(Link::live == 0);
    }
    assert(managed_node_count() == baseline);
    {
        auto record = make_ref<Link>();
        record->callback = make_closure(std::tuple{record}, [](auto& captures) {
            auto& captured = std::get<0>(captures);
            captured->next = captured;
        });
        auto callback = record->callback;
        record.reset();
        assert(collect_cycles() == 0);
        callback();
        callback = {};
        assert(collect_cycles() > 0 && Link::live == 0);
    }
    {
        auto cell = make_gc_shared<Callback<void()>>();
        auto record = make_ref<Link>();
        *cell = make_closure(std::tuple{record, cell}, [](auto& captures) {
            auto& captured = std::get<0>(captures);
            auto& mutable_cell = std::get<1>(captures);
            captured.reset();
            *mutable_cell = {}; // Self-disposal must retain the active body.
            collect_cycles();
        });
        record->callback = *cell;
        record.reset();
        assert(collect_cycles() == 0);
        (*cell)();
        assert(Link::live == 0);
        cell.reset();
        collect_cycles();
    }
    assert(managed_node_count() == baseline);
    {
        auto record = make_ref<Link>();
        record->map.set(record, record);
        record->iterator.emplace(record->map.begin());
        record.reset();
        assert(collect_cycles() > 0 && Link::live == 0);
    }
    {
        auto leaf = make_ref<Link>();
        auto holder = make_ref<BorrowedTuple>(BorrowedTuple{{}, std::tie(leaf)});
        holder->self = holder;
        holder.reset();
        assert(collect_cycles() > 0 && Link::live == 1);
        assert(leaf->children.empty());
        const std::initializer_list<LinkRef> backing{leaf};
        leaf.reset();
        auto list = make_ref<BorrowedList>(BorrowedList{{}, backing});
        list->self = list;
        list.reset();
        assert(collect_cycles() > 0 && Link::live == 1);
        assert(backing.begin()->get()->children.empty());
    }
    assert(managed_node_count() == baseline);
    {
        bbl::Scene scene;
        auto record = make_ref<Link>();
        record->callback = make_closure(std::tuple{scene}, [](auto& captures) {
            std::get<0>(captures).before_render.clear();
        });
        scene.before_render.push_back(make_closure(std::tuple{record}, [](auto& captures, float) {
            std::get<0>(captures)->callback();
        }));
        const auto snapshot = scene.before_render;
        record.reset();
        assert(collect_cycles() == 0);
        snapshot.front()(0.0f);
    }
    collect_cycles();
    assert(managed_node_count() == baseline);
    {
        bbl::Scene scene;
        scene.before_render.push_back(make_closure(std::tuple{scene}, [](auto&, float) {}));
    }
    for (int frame = 0; frame < 60; ++frame) collect_at_frame_boundary();
    assert(managed_node_count() == baseline);
    {
        auto manager = make_gc_shared<bbl::PropertyAnimationManagerRecord>();
        auto group = make_gc_shared<bbl::PropertyAnimationGroupRecord>();
        auto record = make_ref<Link>();
        record->callback = make_closure(std::tuple{manager}, [](auto&) {});
        bbl::PropertyAnimationTarget target;
        target.kind = bbl::PropertyAnimationTargetKind::callback;
        target.write_scalar = make_closure(std::tuple{record}, [](auto&, float) {});
        group->targets.push_back(target);
        manager->groups.push_back(group);
        bbl::PropertyAnimationWeightFade fade;
        fade.target = bbl::AnimationWeightFadeTarget::from_property(group);
        manager->weight_fades.push_back(fade);
        bbl::PropertyAnimationBucket bucket;
        bucket.target = target;
        manager->buckets.push_back(bucket);
        assert(collect_cycles() == 0);
    }
    assert(collect_cycles() > 0 && Link::live == 0);
    assert(managed_node_count() == baseline);
    std::cout << "js-cycles-check: ok\n";
}
