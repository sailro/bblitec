#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_error.hpp>

#include <algorithm>
#include <cmath>
#include <compare>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace bbl::js {

/**
 * An ECMAScript BigInt: an arbitrary-precision integer, stored as a sign and
 * a magnitude of 32-bit limbs (least significant first, no leading zero
 * limb; zero has no limbs and is never negative). Every operation is exact;
 * the bitwise operators act on the infinite two's complement form.
 */
class BigInt {
public:
    BigInt() = default;
    explicit BigInt(std::int64_t value) : negative_(value < 0) {
        assign_magnitude(value < 0 ? ~static_cast<std::uint64_t>(value) + 1U
                                   : static_cast<std::uint64_t>(value));
    }
    [[nodiscard]] static BigInt from_uint64(std::uint64_t value) {
        BigInt result;
        result.assign_magnitude(value);
        return result;
    }
    /** `BigInt(number)`: a RangeError unless the number is an integer. */
    [[nodiscard]] static BigInt from_number(double value) {
        if (!std::isfinite(value) || std::trunc(value) != value)
            throw NamedError("RangeError", "The number cannot be converted to a BigInt "
                                           "because it is not an integer");
        const double magnitude = std::fabs(value);
        BigInt result;
        if (magnitude < 18446744073709551616.0) {
            result.assign_magnitude(static_cast<std::uint64_t>(magnitude));
        } else {
            int exponent = 0;
            const double fraction = std::frexp(magnitude, &exponent);
            result.assign_magnitude(static_cast<std::uint64_t>(std::ldexp(fraction, 64)));
            result = result.shifted_left(static_cast<std::size_t>(exponent - 64));
        }
        result.negative_ = value < 0 && !result.is_zero();
        return result;
    }
    /** A literal's or a validated text's digits in `radix`, without sign or prefix. */
    [[nodiscard]] static BigInt from_digits(std::string_view digits, unsigned radix) {
        BigInt result;
        for (const char digit : digits) {
            const auto value = digit_value(digit);
            if (!value || *value >= radix)
                throw NamedError("SyntaxError", "Cannot convert text to a BigInt");
            result.multiply_add(radix, *value);
        }
        return result;
    }
    /** `BigInt(text)`: StringToBigInt, a SyntaxError for anything else. */
    [[nodiscard]] static BigInt from_string(std::string_view text) {
        const auto parsed = parse(text);
        if (!parsed)
            throw NamedError("SyntaxError", "Cannot convert text to a BigInt");
        return *parsed;
    }
    [[nodiscard]] static std::optional<BigInt> parse(std::string_view text) {
        constexpr std::string_view space = " \t\n\v\f\r";
        const auto first = text.find_first_not_of(space);
        if (first == std::string_view::npos)
            return BigInt();
        text = text.substr(first, text.find_last_not_of(space) - first + 1);
        unsigned radix = 10;
        bool negative = false;
        if (text.size() > 2 && text[0] == '0') {
            const char prefix = static_cast<char>(text[1] | 0x20);
            radix = prefix == 'x' ? 16 : prefix == 'o' ? 8 : prefix == 'b' ? 2 : 10;
            if (radix != 10)
                text.remove_prefix(2);
        }
        if (radix == 10 && (text.front() == '+' || text.front() == '-')) {
            negative = text.front() == '-';
            text.remove_prefix(1);
        }
        if (text.empty())
            return std::nullopt;
        BigInt result;
        for (const char digit : text) {
            const auto value = digit_value(digit);
            if (!value || *value >= radix)
                return std::nullopt;
            result.multiply_add(radix, *value);
        }
        result.negative_ = negative && !result.is_zero();
        return result;
    }

    [[nodiscard]] bool is_zero() const noexcept { return limbs_.empty(); }
    [[nodiscard]] bool is_negative() const noexcept { return negative_; }

    /** `Number(bigint)`: the nearest double, ties to even. */
    [[nodiscard]] double to_number() const {
        const std::size_t bits = bit_length();
        if (bits <= 53) {
            const double exact = static_cast<double>(low_uint64());
            return negative_ ? -exact : exact;
        }
        // The 64 most significant bits, left-aligned, and whether any bit
        // below them is set.
        const std::uint64_t top =
            bits <= 64 ? low_uint64() << (64 - bits) : shifted_magnitude_right(bits - 64);
        const bool sticky = bits > 64 && any_bit_below(bits - 64);
        std::uint64_t mantissa = top >> 11U;
        const std::uint64_t rest = top & 0x7FFU;
        if (rest > 0x400U || (rest == 0x400U && (sticky || (mantissa & 1U) != 0)))
            ++mantissa;
        const double magnitude =
            std::ldexp(static_cast<double>(mantissa),
                       static_cast<int>(std::min<std::size_t>(bits - 53, 2048)));
        return negative_ ? -magnitude : magnitude;
    }
    /** The value modulo 2^64 as a signed integer: BigInt64Array storage. */
    [[nodiscard]] std::int64_t to_int64() const { return static_cast<std::int64_t>(to_uint64()); }
    /** The value modulo 2^64: BigUint64Array storage. */
    [[nodiscard]] std::uint64_t to_uint64() const {
        const std::uint64_t magnitude = low_uint64();
        return negative_ ? ~magnitude + 1U : magnitude;
    }

    [[nodiscard]] std::string to_string(double radix_number = 10) const {
        const double integer = std::isnan(radix_number) ? 0 : std::trunc(radix_number);
        if (!(integer >= 2 && integer <= 36))
            throw NamedError("RangeError", "toString() radix must be between 2 and 36");
        const auto radix = static_cast<std::uint32_t>(integer);
        if (is_zero())
            return "0";
        std::string digits;
        std::vector<std::uint32_t> rest = limbs_;
        while (!rest.empty()) {
            const std::uint32_t remainder = divide_small(rest, radix);
            digits.push_back("0123456789abcdefghijklmnopqrstuvwxyz"[remainder]);
        }
        if (negative_)
            digits.push_back('-');
        std::reverse(digits.begin(), digits.end());
        return digits;
    }

    friend BigInt operator-(BigInt value) {
        value.negative_ = !value.negative_ && !value.is_zero();
        return value;
    }
    friend BigInt operator+(const BigInt& left, const BigInt& right) {
        if (left.negative_ == right.negative_)
            return make(left.negative_, add(left.limbs_, right.limbs_));
        const auto order = compare(left.limbs_, right.limbs_);
        if (order == 0)
            return {};
        return order > 0 ? make(left.negative_, subtract(left.limbs_, right.limbs_))
                         : make(right.negative_, subtract(right.limbs_, left.limbs_));
    }
    friend BigInt operator-(const BigInt& left, const BigInt& right) { return left + -right; }
    friend BigInt operator*(const BigInt& left, const BigInt& right) {
        return make(left.negative_ != right.negative_, multiply(left.limbs_, right.limbs_));
    }
    /** Division truncating toward zero; a RangeError for a zero divisor. */
    friend BigInt operator/(const BigInt& left, const BigInt& right) {
        auto [quotient, remainder] = divide(left.limbs_, right.limbs_);
        static_cast<void>(remainder);
        return make(left.negative_ != right.negative_, std::move(quotient));
    }
    /** The remainder with the dividend's sign; a RangeError for a zero divisor. */
    friend BigInt operator%(const BigInt& left, const BigInt& right) {
        auto [quotient, remainder] = divide(left.limbs_, right.limbs_);
        static_cast<void>(quotient);
        return make(left.negative_, std::move(remainder));
    }
    /** `base ** exponent`; a RangeError for a negative exponent. */
    [[nodiscard]] static BigInt pow(const BigInt& base, const BigInt& exponent) {
        if (exponent.negative_)
            throw NamedError("RangeError", "Exponent must be non-negative");
        BigInt result(1);
        if (exponent.is_zero())
            return result;
        if (base.is_zero())
            return {};
        if (base.limbs_.size() == 1 && base.limbs_[0] == 1)
            return base.negative_ && exponent.is_odd() ? -result : result;
        const std::size_t bits = exponent.bit_length();
        if (bits > 40 || base.bit_length() - 1 > max_bits / exponent.low_uint64())
            too_large();
        BigInt square = base;
        for (std::size_t bit = 0; bit < bits; ++bit) {
            if (exponent.bit(bit))
                result = result * square;
            if (bit + 1 < bits)
                square = square * square;
        }
        return result;
    }
    friend BigInt operator~(const BigInt& value) { return -value - BigInt(1); }
    friend BigInt operator&(const BigInt& left, const BigInt& right) {
        return bitwise(left, right, [](std::uint32_t a, std::uint32_t b) { return a & b; });
    }
    friend BigInt operator|(const BigInt& left, const BigInt& right) {
        return bitwise(left, right, [](std::uint32_t a, std::uint32_t b) { return a | b; });
    }
    friend BigInt operator^(const BigInt& left, const BigInt& right) {
        return bitwise(left, right, [](std::uint32_t a, std::uint32_t b) { return a ^ b; });
    }
    /** `value << count`: a right shift for a negative count. */
    friend BigInt operator<<(const BigInt& value, const BigInt& count) {
        return count.negative_ ? value.shifted_right_by(-count) : value.shifted_left_by(count);
    }
    /** `value >> count`: floor division by 2^count, a left shift for a negative count. */
    friend BigInt operator>>(const BigInt& value, const BigInt& count) {
        return count.negative_ ? value.shifted_left_by(-count) : value.shifted_right_by(count);
    }

    /** `BigInt.asIntN(bits, value)`. */
    [[nodiscard]] static BigInt as_int_n(double bits, const BigInt& value) {
        const std::size_t width = require_index(bits);
        if (width == 0)
            return {};
        BigInt wrapped = as_uint_n(bits, value);
        if (wrapped.bit(width - 1))
            wrapped = wrapped - power_of_two(width);
        return wrapped;
    }
    /** `BigInt.asUintN(bits, value)`: the value modulo 2^bits. */
    [[nodiscard]] static BigInt as_uint_n(double bits, const BigInt& value) {
        const std::size_t width = require_index(bits);
        if (!value.negative_ && value.bit_length() <= width)
            return value;
        require_size(width);
        const std::size_t count = (width + 31) / 32;
        std::vector<std::uint32_t> limbs = value.twos_complement(count);
        if (width % 32 != 0)
            limbs.back() &= (std::uint32_t{1} << (width % 32)) - 1U;
        return make(false, std::move(limbs));
    }

    friend bool operator==(const BigInt& left, const BigInt& right) noexcept {
        return left.negative_ == right.negative_ && left.limbs_ == right.limbs_;
    }
    friend std::strong_ordering operator<=>(const BigInt& left, const BigInt& right) noexcept {
        if (left.negative_ != right.negative_)
            return left.negative_ ? std::strong_ordering::less : std::strong_ordering::greater;
        const int order = compare(left.limbs_, right.limbs_);
        const int signed_order = left.negative_ ? -order : order;
        return signed_order < 0   ? std::strong_ordering::less
               : signed_order > 0 ? std::strong_ordering::greater
                                  : std::strong_ordering::equal;
    }
    /** The mathematical comparison with a Number; unordered against NaN. */
    friend std::partial_ordering operator<=>(const BigInt& left, double right) {
        if (std::isnan(right))
            return std::partial_ordering::unordered;
        if (std::isinf(right))
            return right > 0 ? std::partial_ordering::less : std::partial_ordering::greater;
        const double floor = std::floor(right);
        const auto order = left <=> from_number(floor);
        if (floor == right)
            return order;
        // floor < right < floor + 1, and no integer lies strictly between.
        return order == std::strong_ordering::greater ? std::partial_ordering::greater
                                                      : std::partial_ordering::less;
    }
    friend bool operator==(const BigInt& left, double right) {
        return (left <=> right) == std::partial_ordering::equivalent;
    }
    /** A Map or Set key hash: equal values hash alike. */
    [[nodiscard]] std::size_t hash() const noexcept {
        std::size_t value = negative_ ? 0x9e3779b97f4a7c15U : 0U;
        for (const std::uint32_t limb : limbs_)
            value = value * 1099511628211U ^ limb;
        return value;
    }

private:
    static constexpr std::size_t max_bits = std::size_t{1} << 30;

    [[noreturn]] static void too_large() {
        throw NamedError("RangeError", "Maximum BigInt size exceeded");
    }
    static void require_size(std::size_t bits) {
        if (bits > max_bits)
            too_large();
    }
    /** ToIndex of a bit width. */
    static std::size_t require_index(double bits) {
        const double integer = std::isnan(bits) ? 0 : std::trunc(bits);
        if (!(integer >= 0 && integer <= 9007199254740991.0))
            throw NamedError("RangeError", "Invalid value: not (convertible to) a safe integer");
        return integer > static_cast<double>(max_bits) ? max_bits + 1
                                                       : static_cast<std::size_t>(integer);
    }
    static std::optional<unsigned> digit_value(char digit) {
        if (digit >= '0' && digit <= '9')
            return static_cast<unsigned>(digit - '0');
        const char lower = static_cast<char>(digit | 0x20);
        if (lower >= 'a' && lower <= 'z')
            return static_cast<unsigned>(lower - 'a' + 10);
        return std::nullopt;
    }
    static BigInt make(bool negative, std::vector<std::uint32_t> limbs) {
        BigInt result;
        result.limbs_ = std::move(limbs);
        result.trim();
        result.negative_ = negative && !result.is_zero();
        return result;
    }
    static BigInt power_of_two(std::size_t exponent) { return BigInt(1).shifted_left(exponent); }
    void trim() {
        while (!limbs_.empty() && limbs_.back() == 0)
            limbs_.pop_back();
    }
    void assign_magnitude(std::uint64_t magnitude) {
        limbs_.clear();
        while (magnitude != 0) {
            limbs_.push_back(static_cast<std::uint32_t>(magnitude));
            magnitude >>= 32U;
        }
    }
    void multiply_add(std::uint32_t factor, std::uint32_t addend) {
        std::uint64_t carry = addend;
        for (auto& limb : limbs_) {
            const std::uint64_t product = std::uint64_t{limb} * factor + carry;
            limb = static_cast<std::uint32_t>(product);
            carry = product >> 32U;
        }
        if (carry != 0)
            limbs_.push_back(static_cast<std::uint32_t>(carry));
    }
    [[nodiscard]] std::uint64_t low_uint64() const noexcept {
        std::uint64_t value = limbs_.empty() ? 0 : limbs_[0];
        if (limbs_.size() > 1)
            value |= std::uint64_t{limbs_[1]} << 32U;
        return value;
    }
    [[nodiscard]] std::size_t bit_length() const noexcept {
        if (limbs_.empty())
            return 0;
        std::uint32_t top = limbs_.back();
        std::size_t bits = (limbs_.size() - 1) * 32;
        while (top != 0) {
            ++bits;
            top >>= 1U;
        }
        return bits;
    }
    [[nodiscard]] bool bit(std::size_t index) const noexcept {
        const std::size_t limb = index / 32;
        return limb < limbs_.size() && ((limbs_[limb] >> (index % 32)) & 1U) != 0;
    }
    [[nodiscard]] bool is_odd() const noexcept { return bit(0); }
    [[nodiscard]] bool any_bit_below(std::size_t count) const noexcept {
        for (std::size_t limb = 0; limb < count / 32 && limb < limbs_.size(); ++limb) {
            if (limbs_[limb] != 0)
                return true;
        }
        const std::size_t limb = count / 32;
        return count % 32 != 0 && limb < limbs_.size() &&
               (limbs_[limb] & ((std::uint32_t{1} << (count % 32)) - 1U)) != 0;
    }
    /** The magnitude shifted right by `count` bits, its low 64 bits. */
    [[nodiscard]] std::uint64_t shifted_magnitude_right(std::size_t count) const {
        std::uint64_t value = 0;
        for (std::size_t bit_index = 0; bit_index < 64; ++bit_index) {
            if (bit(count + bit_index))
                value |= std::uint64_t{1} << bit_index;
        }
        return value;
    }
    [[nodiscard]] BigInt shifted_left(std::size_t count) const {
        if (is_zero())
            return {};
        require_size(bit_length() + count);
        std::vector<std::uint32_t> limbs(count / 32, 0);
        const unsigned offset = static_cast<unsigned>(count % 32);
        std::uint32_t carry = 0;
        for (const std::uint32_t limb : limbs_) {
            limbs.push_back(offset == 0 ? limb : (limb << offset) | carry);
            carry = offset == 0 ? 0 : limb >> (32U - offset);
        }
        limbs.push_back(carry);
        return make(negative_, std::move(limbs));
    }
    [[nodiscard]] BigInt shifted_left_by(const BigInt& count) const {
        if (is_zero())
            return {};
        if (count.bit_length() > 40)
            too_large();
        return shifted_left(static_cast<std::size_t>(count.low_uint64()));
    }
    /** Floor division by 2^count. */
    [[nodiscard]] BigInt shifted_right_by(const BigInt& count) const {
        const std::size_t length = bit_length();
        if (count.bit_length() > 40 || count.low_uint64() >= length)
            return negative_ ? BigInt(-1) : BigInt();
        const auto shift = static_cast<std::size_t>(count.low_uint64());
        const bool inexact = any_bit_below(shift);
        std::vector<std::uint32_t> limbs;
        const unsigned offset = static_cast<unsigned>(shift % 32);
        for (std::size_t index = shift / 32; index < limbs_.size(); ++index) {
            const std::uint32_t high = index + 1 < limbs_.size() ? limbs_[index + 1] : 0;
            limbs.push_back(offset == 0 ? limbs_[index]
                                        : (limbs_[index] >> offset) | (high << (32U - offset)));
        }
        BigInt result = make(negative_, std::move(limbs));
        return negative_ && inexact ? result - BigInt(1) : result;
    }
    /** The low `count` limbs of the infinite two's complement form. */
    [[nodiscard]] std::vector<std::uint32_t> twos_complement(std::size_t count) const {
        std::vector<std::uint32_t> limbs(count, 0);
        std::copy_n(limbs_.begin(), std::min(count, limbs_.size()), limbs.begin());
        if (negative_)
            negate_in_place(limbs);
        return limbs;
    }
    /** Two's complement negation of fixed-width limbs, modulo 2^(32 * size). */
    static void negate_in_place(std::vector<std::uint32_t>& limbs) noexcept {
        std::uint64_t carry = 1;
        for (auto& limb : limbs) {
            const std::uint64_t sum = std::uint64_t{static_cast<std::uint32_t>(~limb)} + carry;
            limb = static_cast<std::uint32_t>(sum);
            carry = sum >> 32U;
        }
    }
    template <typename Operation>
    static BigInt bitwise(const BigInt& left, const BigInt& right, Operation operation) {
        const std::size_t count = std::max(left.limbs_.size(), right.limbs_.size()) + 1;
        const auto a = left.twos_complement(count);
        const auto b = right.twos_complement(count);
        std::vector<std::uint32_t> limbs(count);
        for (std::size_t index = 0; index < count; ++index)
            limbs[index] = operation(a[index], b[index]);
        const bool negative = (limbs.back() >> 31U) != 0;
        if (negative)
            negate_in_place(limbs);
        return make(negative, std::move(limbs));
    }
    static int compare(const std::vector<std::uint32_t>& left,
                       const std::vector<std::uint32_t>& right) noexcept {
        if (left.size() != right.size())
            return left.size() < right.size() ? -1 : 1;
        for (std::size_t index = left.size(); index-- > 0;) {
            if (left[index] != right[index])
                return left[index] < right[index] ? -1 : 1;
        }
        return 0;
    }
    static std::vector<std::uint32_t> add(const std::vector<std::uint32_t>& left,
                                          const std::vector<std::uint32_t>& right) {
        const auto& longer = left.size() >= right.size() ? left : right;
        const auto& shorter = left.size() >= right.size() ? right : left;
        std::vector<std::uint32_t> sum;
        sum.reserve(longer.size() + 1);
        std::uint64_t carry = 0;
        for (std::size_t index = 0; index < longer.size(); ++index) {
            const std::uint64_t total = std::uint64_t{longer[index]} +
                                        (index < shorter.size() ? shorter[index] : 0) + carry;
            sum.push_back(static_cast<std::uint32_t>(total));
            carry = total >> 32U;
        }
        if (carry != 0)
            sum.push_back(static_cast<std::uint32_t>(carry));
        return sum;
    }
    /** `left - right` for `left >= right`. */
    static std::vector<std::uint32_t> subtract(const std::vector<std::uint32_t>& left,
                                               const std::vector<std::uint32_t>& right) {
        std::vector<std::uint32_t> difference(left.size());
        std::int64_t borrow = 0;
        for (std::size_t index = 0; index < left.size(); ++index) {
            std::int64_t value = std::int64_t{left[index]} -
                                 (index < right.size() ? std::int64_t{right[index]} : 0) - borrow;
            borrow = value < 0 ? 1 : 0;
            if (value < 0)
                value += std::int64_t{1} << 32U;
            difference[index] = static_cast<std::uint32_t>(value);
        }
        return difference;
    }
    static std::vector<std::uint32_t> multiply(const std::vector<std::uint32_t>& left,
                                               const std::vector<std::uint32_t>& right) {
        if (left.empty() || right.empty())
            return {};
        require_size((left.size() + right.size()) * 32);
        std::vector<std::uint32_t> product(left.size() + right.size(), 0);
        for (std::size_t i = 0; i < left.size(); ++i) {
            std::uint64_t carry = 0;
            for (std::size_t j = 0; j < right.size(); ++j) {
                const std::uint64_t total =
                    std::uint64_t{left[i]} * right[j] + product[i + j] + carry;
                product[i + j] = static_cast<std::uint32_t>(total);
                carry = total >> 32U;
            }
            product[i + right.size()] = static_cast<std::uint32_t>(carry);
        }
        return product;
    }
    /** Divides `limbs` in place by a single limb, returning the remainder. */
    static std::uint32_t divide_small(std::vector<std::uint32_t>& limbs, std::uint32_t divisor) {
        std::uint64_t remainder = 0;
        for (std::size_t index = limbs.size(); index-- > 0;) {
            const std::uint64_t current = (remainder << 32U) | limbs[index];
            limbs[index] = static_cast<std::uint32_t>(current / divisor);
            remainder = current % divisor;
        }
        while (!limbs.empty() && limbs.back() == 0)
            limbs.pop_back();
        return static_cast<std::uint32_t>(remainder);
    }
    /** Magnitude quotient and remainder (Knuth, algorithm D). */
    static std::pair<std::vector<std::uint32_t>, std::vector<std::uint32_t>>
    divide(const std::vector<std::uint32_t>& dividend, const std::vector<std::uint32_t>& divisor) {
        if (divisor.empty())
            throw NamedError("RangeError", "Division by zero");
        if (compare(dividend, divisor) < 0)
            return {{}, dividend};
        if (divisor.size() == 1) {
            std::vector<std::uint32_t> quotient = dividend;
            const std::uint32_t remainder = divide_small(quotient, divisor[0]);
            return {std::move(quotient), remainder == 0 ? std::vector<std::uint32_t>{}
                                                        : std::vector<std::uint32_t>{remainder}};
        }
        // Normalize so the divisor's top limb has its high bit set.
        unsigned shift = 0;
        for (std::uint32_t top = divisor.back(); (top & 0x80000000U) == 0; top <<= 1U)
            ++shift;
        const auto normalize = [shift](const std::vector<std::uint32_t>& limbs, std::size_t size) {
            std::vector<std::uint32_t> result(size, 0);
            std::uint32_t carry = 0;
            for (std::size_t index = 0; index < limbs.size(); ++index) {
                result[index] = shift == 0 ? limbs[index] : (limbs[index] << shift) | carry;
                carry = shift == 0 ? 0 : limbs[index] >> (32U - shift);
            }
            if (limbs.size() < size)
                result[limbs.size()] = carry;
            return result;
        };
        const std::size_t n = divisor.size();
        const std::size_t m = dividend.size() - n;
        const std::vector<std::uint32_t> v = normalize(divisor, n);
        std::vector<std::uint32_t> u = normalize(dividend, dividend.size() + 1);
        std::vector<std::uint32_t> quotient(m + 1, 0);
        constexpr std::uint64_t base = std::uint64_t{1} << 32U;
        for (std::size_t j = m + 1; j-- > 0;) {
            const std::uint64_t top = (std::uint64_t{u[j + n]} << 32U) | u[j + n - 1];
            std::uint64_t estimate = top / v[n - 1];
            std::uint64_t remainder = top % v[n - 1];
            while (estimate >= base || estimate * v[n - 2] > ((remainder << 32U) | u[j + n - 2])) {
                --estimate;
                remainder += v[n - 1];
                if (remainder >= base)
                    break;
            }
            // A quotient digit is below the base; one too large is corrected below.
            estimate = std::min(estimate, base - 1);
            // Multiply and subtract.
            std::int64_t borrow = 0;
            std::uint64_t carry = 0;
            for (std::size_t i = 0; i < n; ++i) {
                const std::uint64_t product = estimate * v[i] + carry;
                carry = product >> 32U;
                const std::int64_t difference = std::int64_t{u[i + j]} - borrow -
                                                static_cast<std::int64_t>(product & 0xFFFFFFFFU);
                u[i + j] = static_cast<std::uint32_t>(difference);
                borrow = difference < 0 ? 1 : 0;
            }
            const std::int64_t last =
                std::int64_t{u[j + n]} - borrow - static_cast<std::int64_t>(carry);
            u[j + n] = static_cast<std::uint32_t>(last);
            if (last < 0) {
                // The estimate was one too large: add the divisor back.
                --estimate;
                std::uint64_t sum_carry = 0;
                for (std::size_t i = 0; i < n; ++i) {
                    const std::uint64_t sum = std::uint64_t{u[i + j]} + v[i] + sum_carry;
                    u[i + j] = static_cast<std::uint32_t>(sum);
                    sum_carry = sum >> 32U;
                }
                u[j + n] = static_cast<std::uint32_t>(std::uint64_t{u[j + n]} + sum_carry);
            }
            quotient[j] = static_cast<std::uint32_t>(estimate);
        }
        // Unnormalize the remainder.
        std::vector<std::uint32_t> remainder(n, 0);
        for (std::size_t i = 0; i < n; ++i)
            remainder[i] = shift == 0 ? u[i] : (u[i] >> shift) | (u[i + 1] << (32U - shift));
        while (!quotient.empty() && quotient.back() == 0)
            quotient.pop_back();
        while (!remainder.empty() && remainder.back() == 0)
            remainder.pop_back();
        return {std::move(quotient), std::move(remainder)};
    }

    bool negative_ = false;
    std::vector<std::uint32_t> limbs_;
};

/** BigInt64Array and BigUint64Array: 64-bit elements read and written as BigInts. */
using I64Array = TypedArray<std::int64_t>;
using U64Array = TypedArray<std::uint64_t>;

template <typename T> [[nodiscard]] BigInt bigint_element(T stored) {
    if constexpr (std::is_signed_v<T>)
        return BigInt(stored);
    else
        return BigInt::from_uint64(stored);
}

/** An element of a BigInt typed array as a place: reads a BigInt, stores ToBigInt64. */
template <typename T> class BigIntArraySlot {
public:
    BigIntArraySlot(TypedArray<T> array, std::size_t index)
        : array_(std::move(array)), index_(index) {}
    [[nodiscard]] operator BigInt() const { return bigint_element(array_.load(index_)); }
    BigIntArraySlot& operator=(const BigInt& value) {
        if constexpr (std::is_signed_v<T>)
            array_.store(index_, value.to_int64());
        else
            array_.store(index_, value.to_uint64());
        return *this;
    }

private:
    TypedArray<T> array_;
    std::size_t index_;
};

/** A checked element read, refusing an index outside the array like other typed arrays. */
template <typename T>
[[nodiscard]] BigInt bigint_array_load(const TypedArray<T>& array, double index, const char* site) {
    if (!array_has_index(array, index))
        throw_index_error(site, "read", index, array.size());
    return bigint_element(array.load(accepted_index(index)));
}

/** A checked element store place. */
template <typename T>
[[nodiscard]] BigIntArraySlot<T> bigint_array_slot(const TypedArray<T>& array, double index,
                                                   const char* site) {
    if (!array_has_index(array, index))
        throw_index_error(site, "write", index, array.size());
    return BigIntArraySlot<T>(array, accepted_index(index));
}

/** A BigInt typed array of the given elements, each stored ToBigInt64/ToBigUint64. */
template <typename T, typename Source>
[[nodiscard]] TypedArray<T> bigint_array_from(const Source& values) {
    TypedArray<T> result(static_cast<std::size_t>(values.size()));
    std::size_t index = 0;
    for (const BigInt& value : values) {
        if constexpr (std::is_signed_v<T>)
            result.store(index++, value.to_int64());
        else
            result.store(index++, value.to_uint64());
    }
    return result;
}

} // namespace bbl::js

template <> struct std::hash<bbl::js::BigInt> {
    std::size_t operator()(const bbl::js::BigInt& value) const noexcept { return value.hash(); }
};
