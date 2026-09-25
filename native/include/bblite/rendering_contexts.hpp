#pragma once

#include <bblite/snapshot_list.hpp>
#include <algorithm>
#include <iterator>
#include <stdexcept>
#include <string>
#include <variant>

namespace bbl {

/** One registration-ordered list; typed backend views share its snapshot. */
template <typename... Contexts> class RenderingContexts {
public:
    struct Entry {
        std::string kind;
        std::variant<Contexts...> context;
        void gc_trace(const js::TraceVisitor& visitor) const { visitor(context); }
    };

    template <typename T> class View {
        SnapshotList<Entry> entries_;

    public:
        class Iterator {
            using Base = typename SnapshotList<Entry>::const_iterator;
            Base current_, end_;
            void skip() {
                while (current_ != end_ && !std::holds_alternative<T>(current_->context))
                    ++current_;
            }

        public:
            using iterator_category = std::forward_iterator_tag;
            using value_type = T;
            using difference_type = std::ptrdiff_t;
            using pointer = const T*;
            using reference = const T&;
            Iterator() = default;
            Iterator(Base current, Base end) : current_(current), end_(end) { skip(); }
            reference operator*() const { return std::get<T>(current_->context); }
            pointer operator->() const { return &**this; }
            Iterator& operator++() {
                ++current_;
                skip();
                return *this;
            }
            Iterator operator++(int) {
                auto before = *this;
                ++*this;
                return before;
            }
            bool operator==(const Iterator& other) const { return current_ == other.current_; }
        };

        explicit View(SnapshotList<Entry> entries) : entries_(std::move(entries)) {}
        Iterator begin() const { return {entries_.begin(), entries_.end()}; }
        Iterator end() const { return {entries_.end(), entries_.end()}; }
        bool empty() const { return begin() == end(); }
        std::size_t size() const { return static_cast<std::size_t>(std::distance(begin(), end())); }
        const T& front() const { return *begin(); }
        const T& operator[](std::size_t index) const {
            auto at = begin();
            while (index-- != 0 && at != end())
                ++at;
            if (at == end())
                throw std::out_of_range("Rendering context index.");
            return *at;
        }
        operator std::vector<T>() const { return {begin(), end()}; }
        void gc_trace(const js::TraceVisitor& visitor) const { visitor(entries_); }
    };

    template <typename T> View<T> select() const { return View<T>(entries_); }
    auto begin() const { return entries_.begin(); }
    auto end() const { return entries_.end(); }
    bool empty() const { return entries_.empty(); }
    std::size_t size() const { return entries_.size(); }
    const Entry& operator[](std::size_t index) const { return entries_[index]; }
    void clear() { entries_.clear(); }
    void gc_trace(const js::TraceVisitor& visitor) const { visitor(entries_); }

    template <typename T> double index_of(const T& context) const {
        for (std::size_t i = 0; i < entries_.size(); ++i) {
            const auto* value = std::get_if<T>(&entries_[i].context);
            if (!value)
                continue;
            if constexpr (requires { value->value; }) {
                if (value->value == context.value)
                    return static_cast<double>(i);
            } else if (*value == context)
                return static_cast<double>(i);
        }
        return -1.0;
    }
    template <typename T> void push_back(std::string kind, T context) {
        entries_.push_back({std::move(kind), std::move(context)});
    }
    template <typename T, typename Predicate> void erase_if(Predicate predicate) {
        const auto first = entries_.begin(), last = entries_.end();
        const auto removed = std::remove_if(first, last, [&](const Entry& entry) {
            const auto* value = std::get_if<T>(&entry.context);
            return value && predicate(*value);
        });
        entries_.erase(removed, last);
    }
    void erase_at(std::size_t index) {
        const auto first = entries_.begin();
        entries_.erase(first + index, first + index + 1);
    }

private:
    SnapshotList<Entry> entries_;
};

} // namespace bbl
