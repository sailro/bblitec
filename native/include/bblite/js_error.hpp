#pragma once

#include <bblite/js_aggregate_error.hpp>
#include <bblite/js_gc.hpp>

namespace bbl::js {

/** Source control transfers cross cleanup regions without entering source catch handlers. */
struct AbruptCompletion {};
struct LoopCompletion : AbruptCompletion {
    explicit LoopCompletion(unsigned value) : target(value) {}
    unsigned target;
};

inline bool is_throw_completion(const std::exception_ptr& value) {
    if (!value)
        return false;
    try {
        std::rethrow_exception(value);
    } catch (const AbruptCompletion&) {
        return false;
    } catch (...) {
        return true;
    }
}

class NamedError final : public std::runtime_error {
public:
    NamedError(std::string name, std::string message, std::exception_ptr cause = {})
        : std::runtime_error(message), name(std::move(name)), cause(cause) {}
    std::string name;
    std::exception_ptr cause;
    const std::shared_ptr<const bool> identity = std::make_shared<const bool>(true);
};

inline std::shared_ptr<const bool> error_identity(const std::exception_ptr& error) {
    if (!error)
        return {};
    try {
        std::rethrow_exception(error);
    } catch (const NamedError& value) {
        return value.identity;
    } catch (const AggregateError& value) {
        return value.identity;
    } catch (...) {
        return {};
    }
}

/** A typed authored class retains its ordinary managed record through exceptions. */
class ErrorObject {
public:
    virtual ~ErrorObject() = default;
    virtual const std::string& message() const = 0;
    virtual const std::string& name() const = 0;
    virtual const void* identity() const = 0;
    virtual void gc_trace(const TraceVisitor&) const = 0;
    std::string base;
};

class ObjectError final : public std::exception {
public:
    explicit ObjectError(std::shared_ptr<ErrorObject> value) : object(std::move(value)) {}
    const char* what() const noexcept override { return object->message().c_str(); }
    std::shared_ptr<ErrorObject> object;
};

template <typename T> class TypedErrorObject final : public ErrorObject {
public:
    TypedErrorObject(T value, std::string baseName) : value(std::move(value)) {
        base = std::move(baseName);
    }
    const std::string& message() const override { return value->message; }
    const std::string& name() const override { return value->name; }
    const void* identity() const override { return value.operator->(); }
    void gc_trace(const TraceVisitor& visitor) const override { visitor(value); }
    T value;
};

/** Native exception copies retain the JavaScript object's identity token. */
class Error {
public:
    Error() = default;
    Error(std::exception_ptr value) : value_(value) {
        if (!value)
            return;
        try {
            std::rethrow_exception(value);
        } catch (const ObjectError& error) {
            object_ = error.object;
            value_ = {};
        } catch (...) {
        }
    }
    explicit Error(std::shared_ptr<ErrorObject> value) : object_(std::move(value)) {}
    operator std::exception_ptr() const {
        return object_ ? std::make_exception_ptr(ObjectError(object_)) : value_;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(object_); }
    const std::shared_ptr<ErrorObject>& object() const { return object_; }
    friend bool operator==(const Error& left, const Error& right) {
        if (left.object_ || right.object_)
            return left.object_ && right.object_ &&
                   left.object_->identity() == right.object_->identity();
        if (left.value_ == right.value_)
            return true;
        const auto identity = error_identity(left.value_);
        return identity && identity == error_identity(right.value_);
    }

private:
    std::exception_ptr value_;
    std::shared_ptr<ErrorObject> object_;
};

template <typename T> Error make_object_error(T value, std::string base) {
    return Error(make_gc_shared<TypedErrorObject<T>>(std::move(value), std::move(base)));
}

template <typename T> T error_object(const Error& error) {
    const auto object = std::dynamic_pointer_cast<TypedErrorObject<T>>(error.object());
    return object ? object->value : T{};
}

inline void require_builtin_error_payload(const Error& error) {
    if (error.object())
        throw std::runtime_error(
            "Authored Error payloads require traced cause and AggregateError storage.");
}

inline Error make_error(std::string name, std::string message, std::exception_ptr cause = {}) {
    require_builtin_error_payload(cause);
    return std::make_exception_ptr(NamedError(std::move(name), std::move(message), cause));
}
inline std::string error_message(const std::exception_ptr& error) {
    if (!error)
        throw std::runtime_error("Cannot read a missing error.");
    try {
        std::rethrow_exception(error);
    } catch (const std::exception& value) {
        return value.what();
    }
}
inline std::string error_name(const std::exception_ptr& error) {
    if (!error)
        throw std::runtime_error("Cannot read a missing error.");
    try {
        std::rethrow_exception(error);
    } catch (const ObjectError& value) {
        return value.object->name();
    } catch (const NamedError& value) {
        return value.name;
    } catch (const AggregateError&) {
        return "AggregateError";
    } catch (const std::exception&) {
        return "Error";
    }
}
inline bool error_is(const Error& error, std::string_view name) {
    return name == "Error" ||
           (error.object() ? error.object()->base == name : error_name(error) == name);
}
template <typename Errors>
Error make_aggregate_error(const Errors& errors, std::string message,
                           std::exception_ptr cause = {}) {
    require_builtin_error_payload(cause);
    for (const auto& error : errors)
        require_builtin_error_payload(error);
    return std::make_exception_ptr(AggregateError(
        std::vector<std::exception_ptr>(errors.begin(), errors.end()), std::move(message), cause));
}

} // namespace bbl::js
