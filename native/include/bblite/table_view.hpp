#pragma once

#include <span>
#include <stdexcept>

namespace bbl {

/** Read-only table storage with the checked access used by generated bindings. */
template <typename T>
class TableView : public std::span<const T> {
public:
    using std::span<const T>::span;

    constexpr const T& at(std::size_t index) const {
        if (index >= this->size()) throw std::out_of_range("Generated table index is out of range.");
        return (*this)[index];
    }
};

} // namespace bbl
