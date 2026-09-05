#include "pal_owned_gpu_record.hpp"

#include <cassert>
#include <iostream>
#include <map>
#include <stdexcept>
#include <vector>

struct Resources {
    static inline bool fail_construction = false;
    int buffer = 0;
    std::map<int, int> bindings;
    Resources() {
        if (fail_construction) throw std::runtime_error("allocation failure");
    }
};

struct Owner {
    int live = 0;
    void release_gpu_resources(Resources& resources) {
        live -= resources.buffer;
        live -= static_cast<int>(resources.bindings.size());
        assert(live >= 0);
    }
};

using Record = bbl::pal::OwnedGpuRecord<Resources, Owner>;

Record upload(Owner& owner, bool fail = false) {
    Record record(owner);
    record.buffer = 1;
    ++owner.live;
    if (fail) throw std::runtime_error("upload failure");
    record.bindings.emplace(1, 1);
    ++owner.live;
    return record;
}

int main() {
    Owner owner;
    try { upload(owner, true); } catch (const std::runtime_error&) {}
    assert(owner.live == 0);
    {
        std::vector<Record> records;
        for (int i = 0; i < 20; ++i) records.push_back(upload(owner));
        assert(owner.live == 40);
        records[0] = std::move(records[1]);
        assert(owner.live == 38);
        records[1].reset();
        records[0].reset();
        records[0].reset();
        assert(owner.live == 36);
        Record pending = upload(owner);
        Resources::fail_construction = true;
        try {
            Record failed(std::move(pending));
            assert(false);
        } catch (const std::runtime_error&) {}
        Resources::fail_construction = false;
        assert(owner.live == 38);
    }
    assert(owner.live == 0);
    try {
        std::vector<Record> unpublished;
        unpublished.push_back(upload(owner));
        unpublished.push_back(upload(owner, true));
    } catch (const std::runtime_error&) {}
    assert(owner.live == 0);
    std::cout << "owned-gpu-record-check: ok\n";
}
