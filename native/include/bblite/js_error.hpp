#pragma once

#include <bblite/js_aggregate_error.hpp>

namespace bbl::js {

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

/** Native exception copies retain the JavaScript object's identity token. */
class Error {
public:
    Error() = default;
    Error(std::exception_ptr value) : value_(value) {}
    operator std::exception_ptr() const { return value_; }
    friend bool operator==(const Error& left, const Error& right) {
        if (left.value_ == right.value_)
            return true;
        const auto identity = error_identity(left.value_);
        return identity && identity == error_identity(right.value_);
    }

private:
    std::exception_ptr value_;
};

inline Error make_error(std::string name, std::string message, std::exception_ptr cause = {}) {
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
    } catch (const NamedError& value) {
        return value.name;
    } catch (const AggregateError&) {
        return "AggregateError";
    } catch (const std::exception&) {
        return "Error";
    }
}
template <typename Errors>
Error make_aggregate_error(const Errors& errors, std::string message,
                           std::exception_ptr cause = {}) {
    return std::make_exception_ptr(AggregateError(
        std::vector<std::exception_ptr>(errors.begin(), errors.end()), std::move(message), cause));
}

} // namespace bbl::js
