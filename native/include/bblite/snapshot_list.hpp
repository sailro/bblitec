#pragma once

#include <initializer_list>
#include <memory>
#include <utility>
#include <vector>

namespace bbl {

/**
 * A native dispatch list whose copies freeze membership, not callback state.
 * Reads and snapshots share storage; only mutation during a snapshot copies
 * the vector. Unlike DOM tombstones, clearing a list does not cancel entries
 * already selected for the current dispatch. JavaScript callback wrappers
 * still share their callable identity and mutable captures across snapshots.
 */
template <typename T>
class SnapshotList {
  public:
    using Storage = std::vector<T>;
    using const_iterator = typename Storage::const_iterator;
    using iterator = typename Storage::iterator;

    SnapshotList() = default;
    SnapshotList(std::initializer_list<T> values)
        : entries_(std::make_shared<Storage>(values)) {}

    [[nodiscard]] bool empty() const { return values().empty(); }
    [[nodiscard]] std::size_t size() const { return values().size(); }
    [[nodiscard]] const T& front() const { return values().front(); }
    [[nodiscard]] const T& operator[](std::size_t index) const { return values()[index]; }
    [[nodiscard]] const_iterator begin() const { return values().begin(); }
    [[nodiscard]] const_iterator end() const { return values().end(); }
    [[nodiscard]] iterator begin() { return writable().begin(); }
    [[nodiscard]] iterator end() { return writable().end(); }
    [[nodiscard]] operator const Storage&() const { return values(); }

    void push_back(T value) { writable().push_back(std::move(value)); }
    iterator insert(const_iterator position, T value) {
        const auto offset = position - values().begin();
        auto& target = writable();
        return target.insert(target.begin() + offset, std::move(value));
    }
    iterator erase(const_iterator first, const_iterator last) {
        const auto begin_offset = first - values().begin();
        const auto end_offset = last - values().begin();
        auto& target = writable();
        return target.erase(target.begin() + begin_offset, target.begin() + end_offset);
    }
    void clear() {
        if (!entries_) return;
        if (entries_.use_count() == 1) entries_->clear();
        else entries_.reset();
    }

  private:
    [[nodiscard]] const Storage& values() const {
        static const Storage empty;
        return entries_ ? *entries_ : empty;
    }
    Storage& writable() {
        if (!entries_) entries_ = std::make_shared<Storage>();
        else if (entries_.use_count() != 1) entries_ = std::make_shared<Storage>(*entries_);
        return *entries_;
    }
    std::shared_ptr<Storage> entries_;
};

} // namespace bbl
