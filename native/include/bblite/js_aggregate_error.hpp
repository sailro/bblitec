#pragma once

#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace bbl::js {

/** An AggregateError retains the original exceptions in source order. */
class AggregateError : public std::runtime_error {
public:
    AggregateError(std::vector<std::exception_ptr> errors, std::string message,
                   std::exception_ptr cause = {})
        : std::runtime_error(message), errors(std::move(errors)), cause(cause) {}

    std::vector<std::exception_ptr> errors;
    std::exception_ptr cause;
    const std::shared_ptr<const bool> identity = std::make_shared<const bool>(true);
};

} // namespace bbl::js
