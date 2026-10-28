#pragma once

#include <bblite/js_aggregate_error.hpp>
#include <bblite/js_gc.hpp>
#include <string_view>

namespace bbl::js {

/** Source control transfers cross cleanup regions without entering source catch handlers. */
struct AbruptCompletion {};
struct LoopCompletion : AbruptCompletion {
    explicit LoopCompletion(unsigned value) : target(value) {}
    unsigned target;
};
template <typename T> struct ReturnCompletion : AbruptCompletion {
    explicit ReturnCompletion(T result) : value(std::move(result)) {}
    T value;
};
template <> struct ReturnCompletion<void> : AbruptCompletion {};

/** A JavaScript string crosses native cleanup without becoming an Error object. */
class ThrownString final : public std::exception {
public:
    explicit ThrownString(std::string source) : value(std::move(source)) {}
    const char* what() const noexcept override { return value.c_str(); }
    std::string value;
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
    NamedError(std::string name, std::string message, std::exception_ptr cause = {},
               bool messagePresent = true)
        : std::runtime_error(message), name(std::move(name)), cause(cause),
          message_present(messagePresent) {}
    std::string name;
    std::exception_ptr cause;
    bool message_present;
    /** A WebIDL DOMException: `instanceof DOMException` holds, and so does `instanceof Error`. */
    bool dom_exception = false;
    const std::shared_ptr<const bool> identity = std::make_shared<const bool>(true);
};

/** `new DOMException(message, name)`. */
[[nodiscard]] inline NamedError make_dom_exception(std::string message,
                                                   std::string name = "Error") {
    NamedError error(std::move(name), std::move(message));
    error.dom_exception = true;
    return error;
}

/** A DOMException as an Error value: what platform operations reject and abort with. */
[[nodiscard]] inline std::exception_ptr dom_exception_error(std::string message,
                                                            std::string name = "Error") {
    return std::make_exception_ptr(make_dom_exception(std::move(message), std::move(name)));
}

/** Whether `error` is a DOMException, which only the DOMException constructor and platform
 * operations create. */
[[nodiscard]] inline bool is_dom_exception(const std::exception_ptr& error) {
    if (!error)
        return false;
    try {
        std::rethrow_exception(error);
    } catch (const NamedError& value) {
        return value.dom_exception;
    } catch (...) {
        return false;
    }
}

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

struct JsonNativeObject;

/** A typed authored class retains its ordinary managed record through exceptions. */
class ErrorObject {
public:
    virtual ~ErrorObject() = default;
    virtual const std::string& message() const = 0;
    virtual const std::string& name() const = 0;
    virtual const void* identity() const = 0;
    virtual void gc_trace(const TraceVisitor&) const = 0;
    std::string base;
    /** The record's own properties as a dynamic read sees them, where its owner represents them. */
    std::shared_ptr<JsonNativeObject> properties;
};

class ObjectError final : public std::exception {
public:
    explicit ObjectError(std::shared_ptr<ErrorObject> value) : object(std::move(value)) {}
    const char* what() const noexcept override { return object->message().c_str(); }
    std::shared_ptr<ErrorObject> object;
};

template <typename T> class TypedErrorObject final : public ErrorObject {
public:
    TypedErrorObject(T value, std::string baseName, std::shared_ptr<JsonNativeObject> ownProperties)
        : value(std::move(value)) {
        base = std::move(baseName);
        properties = std::move(ownProperties);
    }
    const std::string& message() const override { return value->message; }
    const std::string& name() const override { return value->name; }
    const void* identity() const override { return value.operator->(); }
    void gc_trace(const TraceVisitor& visitor) const override {
        visitor(value);
        visitor(properties);
    }
    T value;
};

/** Native exception copies retain the JavaScript object's identity token. */
class Error {
public:
    Error() = default;
    Error(std::exception_ptr value) {
        if (!value)
            return;
        try {
            std::rethrow_exception(value);
        } catch (const ObjectError& error) {
            object_ = error.object;
        } catch (...) {
            value_ = value;
        }
    }
    explicit Error(std::shared_ptr<ErrorObject> value) : object_(std::move(value)) {}
    operator std::exception_ptr() const {
        return object_ ? std::make_exception_ptr(ObjectError(object_)) : value_;
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(object_); }
    const std::shared_ptr<ErrorObject>& object() const { return object_; }
    const void* identity() const {
        if (object_)
            return object_->identity();
        if (!value_)
            return nullptr;
        if (const auto token = error_identity(value_))
            return token.get();
        try {
            std::rethrow_exception(value_);
        } catch (const std::exception& value) {
            return &value;
        }
    }
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

template <typename T>
Error make_object_error(T value, std::string base,
                        std::shared_ptr<JsonNativeObject> properties = {}) {
    return Error(make_gc_shared<TypedErrorObject<T>>(std::move(value), std::move(base),
                                                     std::move(properties)));
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

inline Error make_error(std::string name, std::string message, std::exception_ptr cause = {},
                        bool messagePresent = true) {
    require_builtin_error_payload(cause);
    return std::make_exception_ptr(
        NamedError(std::move(name), std::move(message), cause, messagePresent));
}

inline bool error_has_own(const Error& error, std::string_view key) {
    try {
        std::rethrow_exception(error);
    } catch (const NamedError& value) {
        return (key == "message" && value.message_present) || (key == "cause" && value.cause);
    } catch (const AggregateError& value) {
        return key == "message" || key == "errors" || (key == "cause" && value.cause);
    } catch (const std::exception&) {
        return key == "message";
    }
}

inline Error error_cause(const Error& error) {
    try {
        std::rethrow_exception(error);
    } catch (const NamedError& value) {
        return value.cause;
    } catch (const AggregateError& value) {
        return value.cause;
    } catch (const std::exception&) {
        return {};
    }
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
    if (error.object())
        return name == "Error" || error.object()->base == name;
    // A DOMException named like an ECMAScript error (SyntaxError) is not that error's instance.
    const bool dom = is_dom_exception(error);
    if (name == "DOMException")
        return dom;
    return name == "Error" || (!dom && error_name(error) == name);
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
