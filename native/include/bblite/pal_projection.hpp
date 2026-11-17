#pragma once

#include <any>
#include <stdexcept>
#include <utility>

namespace bbl::pal {

/**
 * The program's record of one native result, projected the first time it is
 * read and kept in `projection`: every promise settled with the same native
 * result hands the program the same object, as the pin resolves each request
 * with one object.
 */
template <typename Result, typename Project>
Result project_once(std::any& projection, Project&& project) {
    if (!projection.has_value())
        projection = std::forward<Project>(project)();
    const auto* result = std::any_cast<Result>(&projection);
    if (!result)
        throw std::logic_error("A native result has an incompatible projection.");
    return *result;
}

} // namespace bbl::pal
