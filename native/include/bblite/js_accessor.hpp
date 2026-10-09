#pragma once

#include <bblite/js_callback.hpp>
#include <bblite/js_error.hpp>

#include <exception>
#include <string>
#include <tuple>
#include <utility>

namespace bbl::js {

/** A getter and setter not yet wrapped as callbacks. A record field
 * initialized from them allocates its callbacks in place, so the record owns
 * them from their allocation; the static analyzer loses a returned accessor
 * that initializes an aggregate field and reports its callbacks leaked. */
template <typename Getter, typename Setter> struct AccessorClosures {
    Getter getter;
    Setter setter;
};

/** A JavaScript property of a native record that a getter can define: a read
 * runs the getter, a write the setter, and a record that stores plain data in
 * such a field keeps it inline (one branch per access, no allocation). */
template <typename T> class Accessor {
public:
    Accessor() = default;
    explicit Accessor(T value) : value_(std::move(value)) {}
    Accessor(Callback<T()> getter, Callback<void(T)> setter)
        : getter_(std::move(getter)), setter_(std::move(setter)) {}
    template <typename Getter, typename Setter>
    Accessor(AccessorClosures<Getter, Setter> closures)
        : getter_(std::move(closures.getter)), setter_(std::move(closures.setter)) {}

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
    void define(Accessor replacement, bool configurable, bool preserve_setter = false) {
        if (preserve_setter)
            replacement.setter_ = setter_;
        if (!configurable_ &&
            (configurable || getter_ != replacement.getter_ || setter_ != replacement.setter_))
            std::rethrow_exception(
                make_error("TypeError", "Cannot redefine a nonconfigurable property"));
        replacement.configurable_ = configurable;
        *this = std::move(replacement);
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
    bool configurable_ = true;
};

/** A finite record slot whose authored accessor observes the supplied receiver. */
template <typename T, typename Receiver> class ReceiverAccessor {
public:
    ReceiverAccessor() = default;
    explicit ReceiverAccessor(T value) : value_(std::move(value)) {}
    ReceiverAccessor(Callback<T(Receiver)> getter, Callback<bool(Receiver, T)> setter,
                     Callback<bool()> presence = {}, Callback<bool()> remove = {},
                     Callback<bool(T)> define = {})
        : getter_(std::move(getter)), setter_(std::move(setter)), presence_(std::move(presence)),
          remove_(std::move(remove)), define_(std::move(define)) {}

    void bind_receiver(const Receiver& receiver) {
        if (getter_ || setter_)
            receiver_ = receiver;
    }
    [[nodiscard]] T get() const { return get(receiver_); }
    [[nodiscard]] T get(Receiver receiver) const {
        return getter_ ? getter_(std::move(receiver)) : value_;
    }
    void set(T value) { set(receiver_, std::move(value)); }
    void set(Receiver receiver, T value) {
        if (!try_set(std::move(receiver), std::move(value)))
            std::rethrow_exception(
                make_error("TypeError", "Property setter rejected the assignment"));
    }
    [[nodiscard]] bool try_set(Receiver receiver, T value) {
        if (setter_)
            return setter_(std::move(receiver), std::move(value));
        if (getter_)
            return false;
        value_ = std::move(value);
        return true;
    }
    [[nodiscard]] bool has_own() const {
        if (presence_)
            return presence_();
        if (getter_ || setter_)
            return true;
        if constexpr (requires(T value) { value.is_undefined(); })
            return !value_.is_undefined();
        else if constexpr (requires(T value) { static_cast<bool>(value); })
            return static_cast<bool>(value_);
        else
            return true;
    }
    [[nodiscard]] bool erase() {
        if (remove_)
            return remove_();
        replace(T{});
        return true;
    }
    [[nodiscard]] bool define_value(T value, bool optional_property = false) {
        if (define_)
            return define_(std::move(value));
        if (getter_ || setter_ || (optional_property && !has_own()))
            throw std::runtime_error(
                "Property definition requires represented descriptor attributes");
        replace(std::move(value));
        return true;
    }
    void gc_trace(const TraceVisitor& visitor) const {
        if constexpr (gc_traceable<T>)
            visitor(value_);
        visitor(receiver_);
        visitor(getter_);
        visitor(setter_);
        visitor(presence_);
        visitor(remove_);
        visitor(define_);
    }

private:
    T value_{};
    Receiver receiver_;
    Callback<T(Receiver)> getter_;
    Callback<bool(Receiver, T)> setter_;
    Callback<bool()> presence_;
    Callback<bool()> remove_;
    Callback<bool(T)> define_;
    void replace(T value) {
        value_ = std::move(value);
        receiver_ = {};
        getter_ = {};
        setter_ = {};
    }
};

/** A closed record's field viewed through the open record it was asserted from:
 * reads and writes go to the record's entry, and a read of an absent entry
 * refuses, as a read the program asserted present. */
template <typename T, typename Record>
[[nodiscard]] auto entry_accessor(Record record, std::string key) {
    auto entry = std::tuple<Record, std::string>{std::move(record), std::move(key)};
    auto getter = make_closure(entry, [](std::tuple<Record, std::string>& view) -> T {
        return std::get<0>(view).at(std::get<1>(view));
    });
    auto setter =
        make_closure(std::move(entry), [](std::tuple<Record, std::string>& view, T value) {
            std::get<0>(view).set(std::get<1>(view), std::move(value));
        });
    return AccessorClosures{std::move(getter), std::move(setter)};
}

/** An optional field of such a view: an absent entry reads as absent. */
template <typename T, typename Record>
[[nodiscard]] auto optional_entry_accessor(Record record, std::string key) {
    auto entry = std::tuple<Record, std::string>{std::move(record), std::move(key)};
    auto getter = make_closure(entry, [](std::tuple<Record, std::string>& view) -> T {
        return std::get<0>(view).get(std::get<1>(view));
    });
    auto setter =
        make_closure(std::move(entry), [](std::tuple<Record, std::string>& view, T value) {
            if (value)
                std::get<0>(view).set(std::get<1>(view), *std::move(value));
            else
                static_cast<void>(std::get<0>(view).erase(std::get<1>(view)));
        });
    return AccessorClosures{std::move(getter), std::move(setter)};
}

} // namespace bbl::js
