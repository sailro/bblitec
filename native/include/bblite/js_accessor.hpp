#pragma once

#include <bblite/js_callback.hpp>
#include <bblite/js_error.hpp>

#include <exception>
#include <string>
#include <tuple>
#include <utility>

namespace bbl::js {

/** A JavaScript property of a native record that a getter can define: a read
 * runs the getter, a write the setter, and a record that stores plain data in
 * such a field keeps it inline (one branch per access, no allocation). */
template <typename T> class Accessor {
public:
    Accessor() = default;
    explicit Accessor(T value) : value_(std::move(value)) {}
    Accessor(Callback<T()> getter, Callback<void(T)> setter)
        : getter_(std::move(getter)), setter_(std::move(setter)) {}

    [[nodiscard]] T get() const { return getter_ ? getter_() : value_; }
    void set(T value) {
        if (setter_)
            setter_(std::move(value));
        else if (getter_)
            std::rethrow_exception(
                make_error("TypeError", "Cannot set a property which has only a getter"));
        else
            value_ = std::move(value);
    }
    void gc_trace(const TraceVisitor& visitor) const {
        if constexpr (gc_traceable<T>)
            visitor(value_);
        visitor(getter_);
        visitor(setter_);
    }

private:
    T value_{};
    Callback<T()> getter_;
    Callback<void(T)> setter_;
};

/** A closed record's field viewed through the open record it was asserted from:
 * reads and writes go to the record's entry, and a read of an absent entry
 * refuses, as a read the program asserted present. */
template <typename T, typename Record>
[[nodiscard]] Accessor<T> entry_accessor(Record record, std::string key) {
    auto entry = std::tuple<Record, std::string>{std::move(record), std::move(key)};
    return Accessor<T>(make_closure(entry,
                                    [](std::tuple<Record, std::string>& view) -> T {
                                        return std::get<0>(view).at(std::get<1>(view));
                                    }),
                       make_closure(entry, [](std::tuple<Record, std::string>& view, T value) {
                           std::get<0>(view).set(std::get<1>(view), std::move(value));
                       }));
}

/** An optional field of such a view: an absent entry reads as absent. */
template <typename T, typename Record>
[[nodiscard]] Accessor<T> optional_entry_accessor(Record record, std::string key) {
    auto entry = std::tuple<Record, std::string>{std::move(record), std::move(key)};
    return Accessor<T>(make_closure(entry,
                                    [](std::tuple<Record, std::string>& view) -> T {
                                        return std::get<0>(view).get(std::get<1>(view));
                                    }),
                       make_closure(entry, [](std::tuple<Record, std::string>& view, T value) {
                           if (value)
                               std::get<0>(view).set(std::get<1>(view), *std::move(value));
                           else
                               static_cast<void>(std::get<0>(view).erase(std::get<1>(view)));
                       }));
}

} // namespace bbl::js
