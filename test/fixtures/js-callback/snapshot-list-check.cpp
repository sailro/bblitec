#include <bblite/js_callback.hpp>
#include <bblite/snapshot_list.hpp>
#include <algorithm>
#include <cassert>
#include <iostream>

int main() {
    using Callback = bbl::js::Callback<void()>;
    bbl::SnapshotList<Callback> callbacks;
    std::vector<int> calls;
    callbacks.push_back([&]() {
        calls.push_back(1);
        callbacks.clear();
        callbacks.push_back([&]() { calls.push_back(3); });
        const auto nested = callbacks;
        for (const auto& callback : nested) callback();
    });
    callbacks.push_back([&]() { calls.push_back(2); });
    const auto selected = callbacks;
    const auto& selected_storage = static_cast<const std::vector<Callback>&>(selected);
    assert(selected_storage.data() == static_cast<const std::vector<Callback>&>(callbacks).data());
    for (const auto& callback : selected) callback();
    assert((calls == std::vector<int>{1, 3, 2}));
    assert(callbacks.size() == 1 && selected.size() == 2);

    // Prepending while dispatching is postponed to the next selection.
    bbl::SnapshotList<Callback> prepended;
    int first = 0, later = 0;
    prepended.push_back([&]() {
        ++first;
        prepended.insert(prepended.begin(), [&]() { ++later; });
    });
    const auto before_insert = prepended;
    for (const auto& callback : before_insert) callback();
    assert(first == 1 && later == 0 && prepended.size() == 2);
    const auto after_insert = prepended;
    for (const auto& callback : after_insert) callback();
    assert(first == 2 && later == 1);

    bbl::SnapshotList<int> membership{1, 2, 3};
    const auto old_membership = membership;
    const std::vector<int> planned_membership = membership;
    assert(planned_membership.size() == 3);
    membership.erase(std::remove_if(membership.begin(), membership.end(),
        [](int value) { return value == 2; }), membership.end());
    assert((static_cast<const std::vector<int>&>(membership) == std::vector<int>{1, 3}));
    assert((static_cast<const std::vector<int>&>(old_membership) == std::vector<int>{1, 2, 3}));
    std::cout << "snapshot-list-check: ok\n";
}
