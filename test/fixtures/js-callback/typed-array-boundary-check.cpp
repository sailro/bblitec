#include <bblite/js_data.hpp>
#include <cassert>
#include <iostream>

template <typename T>
void check_numeric_array() {
    using namespace bbl::js;
    std::vector<T> native{T{1}, T{2}, T{3}, T{4}};
    TypedArray<T> values = native;
    native[0] = T{9};
    assert(values[0] == T{1});
    auto alias = values;
    array_fill(values, T{5});
    assert(alias[0] == T{5} && native[0] == T{9});
    array_fill_range(values, T{7}, 1, 3);
    auto sliced = typed_array_slice(values, -3, -1);
    assert(sliced.size() == 2 && sliced[0] == T{7});
    sliced[0] = T{8};
    assert(values[1] == T{7});
    auto native_slice = typed_array_slice(native, 0, 1);
    assert(native_slice.size() == 1 && native_slice[0] == T{9});
    TypedArray<T> moved = std::move(native_slice);
    assert(moved[0] == T{9});
}

int main() {
    check_numeric_array<float>();
    check_numeric_array<double>();
    check_numeric_array<std::uint16_t>();
    check_numeric_array<std::int16_t>();
    check_numeric_array<std::uint32_t>();
    check_numeric_array<std::int32_t>();
    bbl::js::U8Array bytes(3);
    bbl::js::array_fill(bytes, std::uint8_t{17});
    assert(bytes[1] == 17);
    bbl::js::Array<double> numbers{1, 2};
    bbl::js::array_fill(numbers, 5.0);
    assert(numbers[0] == 5 && numbers[1] == 5);
    std::cout << "typed-array-boundary-check: ok\n";
}
