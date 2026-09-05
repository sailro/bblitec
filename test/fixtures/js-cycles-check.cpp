#include <bblite/js_data.hpp>
#include <bblite/runtime.hpp>
#include <cassert>
#include <iostream>

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

int main() {
    const auto baseline = managed_node_count();
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
