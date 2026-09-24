#include <bblite/js_data.hpp>
#include <atomic>
#include <cassert>
#include <iostream>
#include <thread>
#include <vector>

using namespace bbl::js;

/** A registered payload that owns no edge. */
struct Traced {
    int value = 0;
    void gc_trace(const TraceVisitor&) const {}
};

struct RealmPayload {
    static inline std::atomic<int> live = 0;
    Ref<RealmPayload> self;
    RealmPayload() { ++live; }
    ~RealmPayload() {
        std::vector<Ref<Traced>> transient;
        for (int index = 0; index < 32; ++index)
            transient.push_back(make_ref<Traced>(index));
        assert(transient.back()->value == 31);
        --live;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(self); }
};

std::weak_ptr<const void> storage_identity;

void use_realm_statics() {
    static thread_local auto cycle = [] {
        auto value = make_ref<RealmPayload>();
        value->self = value;
        return value;
    }();
    static thread_local Map<int, Ref<RealmPayload>> values{{1, cycle}};
    auto storage = local_storage_object();
    assert(storage == local_storage_object());
    storage_identity = storage.weak_identity();
    assert(values.at(1) == cycle);
}

void use_legacy_process_static() {
    static auto value = [] {
        auto result = make_ref<RealmPayload>();
        result->self = result;
        return result;
    }();
    static Map<int, Ref<RealmPayload>> values{{1, value}};
    assert(values.at(1) == value);
}

int main() {
    static_assert(sizeof(Ref<int>) == sizeof(void*));
    for (int realm = 0; realm < 2; ++realm) {
        std::thread worker([] {
            use_realm_statics();
            assert(RealmPayload::live == 1);
        });
        worker.join();
        assert(RealmPayload::live == 0 && storage_identity.expired());
    }
    std::thread legacy([] {
        use_legacy_process_static();
        assert(RealmPayload::live == 1);
    });
    legacy.join();
    assert(RealmPayload::live == 0);
    std::cout << "gc-shutdown-lifetime: ok\n";
}
