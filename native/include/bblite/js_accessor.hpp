#pragma once

#include <bblite/js_callback.hpp>
#include <bblite/js_error.hpp>

#include <exception>
#include <utility>

namespace bbl::js {

/** A JavaScript accessor property of a native record: a read runs the getter,
 * a write the setter. A record that stores plain data in such a field keeps it
 * behind a getter and a setter over one shared cell. */
template <typename T> class Accessor {
public:
    Accessor() = default;
    explicit Accessor(Callback<T()> getter, Callback<void(T)> setter = {})
        : getter_(std::move(getter)), setter_(std::move(setter)) {}

    [[nodiscard]] T get() const { return getter_(); }
    void set(T value) const {
        if (!setter_)
            std::rethrow_exception(
                make_error("TypeError", "Cannot set a property which has only a getter"));
        setter_(std::move(value));
    }
    void gc_trace(const TraceVisitor& visitor) const {
        visitor(getter_);
        visitor(setter_);
    }

private:
    Callback<T()> getter_;
    Callback<void(T)> setter_;
};

template <typename T> [[nodiscard]] Accessor<T> data_accessor(T value) {
    auto cell = make_gc_shared<T>(std::move(value));
    return Accessor<T>(
        make_closure(cell, [](std::shared_ptr<T>& stored) -> T { return *stored; }),
        make_closure(cell, [](std::shared_ptr<T>& stored, T next) { *stored = std::move(next); }));
}

} // namespace bbl::js
