#pragma once

#include <bblite/js_data.hpp>
#include <bblite/js_encoding.hpp>
#include <bblite/js_search_params.hpp>

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace bbl::js {

namespace url_detail {

inline bool ascii_alpha(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
inline bool ascii_digit(char c) { return c >= '0' && c <= '9'; }
inline bool ascii_hex(char c) {
    return ascii_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}

/** The default port of a special scheme; -1 for `file`, -2 for a scheme that is not special. */
inline int special_port(std::string_view scheme) {
    if (scheme == "http" || scheme == "ws")
        return 80;
    if (scheme == "https" || scheme == "wss")
        return 443;
    if (scheme == "ftp")
        return 21;
    return scheme == "file" ? -1 : -2;
}
inline bool special(std::string_view scheme) { return special_port(scheme) != -2; }

enum class EncodeSet { c0, fragment, query, special_query, path, userinfo };

/** Whether `byte` belongs to the URL Standard's percent-encode `set`. */
inline bool in_set(unsigned char byte, EncodeSet set) {
    if (byte < 0x20 || byte > 0x7E)
        return true;
    if (set == EncodeSet::c0)
        return false;
    if (set == EncodeSet::fragment)
        return byte == ' ' || byte == '"' || byte == '<' || byte == '>' || byte == '`';
    const bool query = byte == ' ' || byte == '"' || byte == '#' || byte == '<' || byte == '>';
    if (set == EncodeSet::query)
        return query;
    if (set == EncodeSet::special_query)
        return query || byte == '\'';
    const bool path =
        query || byte == '?' || byte == '^' || byte == '`' || byte == '{' || byte == '}';
    if (set == EncodeSet::path)
        return path;
    return path || byte == '/' || byte == ':' || byte == ';' || byte == '=' || byte == '@' ||
           (byte >= '[' && byte <= ']') || byte == '|';
}

inline void append_encoded(std::string& output, std::string_view text, EncodeSet set) {
    for (const unsigned char byte : text) {
        if (in_set(byte, set))
            search_params_detail::append_percent_encoded(output, byte);
        else
            output.push_back(static_cast<char>(byte));
    }
}

/** Percent-decoding over bytes: a malformed escape stays as it is. */
inline std::string percent_decode(std::string_view input) {
    std::string output;
    for (std::size_t i = 0; i < input.size(); ++i) {
        if (input[i] == '%' && i + 2 < input.size() && ascii_hex(input[i + 1]) &&
            ascii_hex(input[i + 2])) {
            output.push_back(static_cast<char>(search_params_detail::hex_digit(input[i + 1]) * 16 +
                                               search_params_detail::hex_digit(input[i + 2])));
            i += 2;
        } else
            output.push_back(input[i]);
    }
    return output;
}

inline bool single_dot(std::string_view segment) {
    return segment == "." || segment == "%2e" || segment == "%2E";
}
inline bool double_dot(std::string_view segment) {
    if (segment.size() < 2 || segment.size() > 6)
        return false;
    std::string lowered;
    for (const char c : segment)
        lowered.push_back(ascii_lower(c));
    return lowered == ".." || lowered == ".%2e" || lowered == "%2e." || lowered == "%2e%2e";
}
inline bool windows_drive_letter(std::string_view text, bool normalized) {
    return text.size() == 2 && ascii_alpha(text[0]) &&
           (text[1] == ':' || (!normalized && text[1] == '|'));
}
inline bool starts_with_drive_letter(std::string_view text) {
    return text.size() >= 2 && windows_drive_letter(text.substr(0, 2), false) &&
           (text.size() == 2 || text[2] == '/' || text[2] == '\\' || text[2] == '?' ||
            text[2] == '#');
}

/** The IPv4 number parser; nullopt is failure. */
inline std::optional<std::uint64_t> ipv4_number(std::string_view text) {
    if (text.empty())
        return std::nullopt;
    int radix = 10;
    if (text.size() >= 2 && text[0] == '0' && (text[1] == 'x' || text[1] == 'X')) {
        text.remove_prefix(2);
        radix = 16;
    } else if (text.size() >= 2 && text[0] == '0') {
        text.remove_prefix(1);
        radix = 8;
    }
    if (text.empty())
        return 0;
    std::uint64_t value = 0;
    for (const char c : text) {
        int digit = -1;
        if (ascii_digit(c))
            digit = c - '0';
        else if (radix == 16 && ascii_hex(c))
            digit = ascii_lower(c) - 'a' + 10;
        if (digit < 0 || digit >= radix)
            return std::nullopt;
        value = value * static_cast<std::uint64_t>(radix) + static_cast<std::uint64_t>(digit);
        if (value > 0xFFFFFFFFFFull)
            value = 0xFFFFFFFFFFull; // Saturate: any value this large already fails below.
    }
    return value;
}

inline std::vector<std::string_view> split_dots(std::string_view text) {
    std::vector<std::string_view> parts;
    for (;;) {
        const auto dot = text.find('.');
        parts.push_back(text.substr(0, dot));
        if (dot == std::string_view::npos)
            return parts;
        text.remove_prefix(dot + 1);
    }
}

inline bool ends_in_number(std::string_view host) {
    auto parts = split_dots(host);
    if (parts.back().empty()) {
        if (parts.size() == 1)
            return false;
        parts.pop_back();
    }
    const auto last = parts.back();
    if (!last.empty() && std::all_of(last.begin(), last.end(), ascii_digit))
        return true;
    return last.size() >= 2 && last[0] == '0' && (last[1] == 'x' || last[1] == 'X') &&
           std::all_of(last.begin() + 2, last.end(), ascii_hex);
}

[[noreturn]] inline void invalid(std::string_view what) {
    throw NamedError("TypeError", "Invalid URL: " + std::string(what));
}

inline std::string parse_ipv4(std::string_view host) {
    auto parts = split_dots(host);
    if (parts.back().empty() && parts.size() > 1)
        parts.pop_back();
    if (parts.size() > 4)
        invalid("IPv4 address has too many parts");
    std::vector<std::uint64_t> numbers;
    for (const auto part : parts) {
        const auto number = ipv4_number(part);
        if (!number)
            invalid("IPv4 address part is not a number");
        numbers.push_back(*number);
    }
    for (std::size_t i = 0; i + 1 < numbers.size(); ++i)
        if (numbers[i] > 255)
            invalid("IPv4 address part exceeds 255");
    const auto limit = std::uint64_t{1} << (8 * (5 - numbers.size()));
    if (numbers.back() >= limit)
        invalid("IPv4 address exceeds its range");
    std::uint64_t address = numbers.back();
    for (std::size_t i = 0; i + 1 < numbers.size(); ++i)
        address += numbers[i] << (8 * (3 - i));
    std::string output;
    for (int shift = 24; shift >= 0; shift -= 8) {
        output += std::to_string((address >> shift) & 0xFFu);
        if (shift)
            output.push_back('.');
    }
    return output;
}

/** The IPv6 parser and serializer (compressed, lowercase hex, bracketed). */
inline std::string parse_ipv6(std::string_view input) {
    std::array<std::uint16_t, 8> address{};
    std::size_t piece = 0;
    std::optional<std::size_t> compress;
    std::size_t i = 0;
    const auto at = [&](std::size_t index) { return index < input.size() ? input[index] : '\0'; };
    if (at(i) == ':') {
        if (at(i + 1) != ':')
            invalid("IPv6 address starts with one colon");
        i += 2;
        compress = ++piece;
    }
    while (i < input.size()) {
        if (piece == 8)
            invalid("IPv6 address has too many pieces");
        if (at(i) == ':') {
            if (compress)
                invalid("IPv6 address compresses twice");
            ++i;
            compress = ++piece;
            continue;
        }
        unsigned value = 0, length = 0;
        while (length < 4 && ascii_hex(at(i))) {
            value = value * 16 + static_cast<unsigned>(search_params_detail::hex_digit(at(i)));
            ++i;
            ++length;
        }
        if (at(i) == '.') {
            if (length == 0 || piece > 6)
                invalid("IPv6 address has a misplaced IPv4 part");
            i -= length;
            int numbers_seen = 0;
            while (i < input.size()) {
                int ipv4_piece = -1;
                if (numbers_seen > 0) {
                    if (at(i) == '.' && numbers_seen < 4)
                        ++i;
                    else
                        invalid("IPv6 address has a malformed IPv4 part");
                }
                if (!ascii_digit(at(i)))
                    invalid("IPv6 address has a malformed IPv4 part");
                while (ascii_digit(at(i))) {
                    const int number = at(i) - '0';
                    if (ipv4_piece == -1)
                        ipv4_piece = number;
                    else if (ipv4_piece == 0)
                        invalid("IPv6 address has a malformed IPv4 part");
                    else
                        ipv4_piece = ipv4_piece * 10 + number;
                    if (ipv4_piece > 255)
                        invalid("IPv6 address has a malformed IPv4 part");
                    ++i;
                }
                address[piece] = static_cast<std::uint16_t>(address[piece] * 0x100 + ipv4_piece);
                ++numbers_seen;
                if (numbers_seen == 2 || numbers_seen == 4)
                    ++piece;
            }
            if (numbers_seen != 4)
                invalid("IPv6 address has a malformed IPv4 part");
            break;
        }
        if (at(i) == ':') {
            ++i;
            if (i >= input.size())
                invalid("IPv6 address ends with a colon");
        } else if (i < input.size())
            invalid("IPv6 address has an invalid character");
        address[piece++] = static_cast<std::uint16_t>(value);
    }
    if (compress) {
        std::size_t swaps = piece - *compress;
        piece = 7;
        while (piece != 0 && swaps > 0) {
            std::swap(address[piece], address[*compress + swaps - 1]);
            --piece;
            --swaps;
        }
    } else if (piece != 8)
        invalid("IPv6 address has too few pieces");
    // Serialize: the first longest run of two or more zero pieces compresses.
    std::optional<std::size_t> run_start;
    std::size_t run_length = 1;
    for (std::size_t start = 0; start < 8;) {
        std::size_t end = start;
        while (end < 8 && address[end] == 0)
            ++end;
        if (end - start > run_length) {
            run_start = start;
            run_length = end - start;
        }
        start = end == start ? start + 1 : end;
    }
    std::string output = "[";
    bool ignore_zero = false;
    for (std::size_t index = 0; index < 8; ++index) {
        if (ignore_zero && address[index] == 0)
            continue;
        ignore_zero = false;
        if (run_start == index) {
            output += index == 0 ? "::" : ":";
            ignore_zero = true;
            continue;
        }
        constexpr char hex[] = "0123456789abcdef";
        std::string piece_text;
        for (unsigned value = address[index]; value || piece_text.empty(); value /= 16)
            piece_text.insert(piece_text.begin(), hex[value % 16]);
        output += piece_text;
        if (index != 7)
            output.push_back(':');
    }
    return output + "]";
}

inline bool forbidden_host_code_point(char c) {
    return c == '\0' || c == '\t' || c == '\n' || c == '\r' || c == ' ' || c == '#' || c == '/' ||
           c == ':' || c == '<' || c == '>' || c == '?' || c == '@' || c == '[' || c == '\\' ||
           c == ']' || c == '^' || c == '|';
}

/** The host parser. A domain must be ASCII: IDNA mapping is not lowered. */
inline std::string parse_host(std::string_view input, bool not_special) {
    if (input.starts_with('[')) {
        if (!input.ends_with(']'))
            invalid("IPv6 host lacks its closing bracket");
        return parse_ipv6(input.substr(1, input.size() - 2));
    }
    if (not_special) {
        std::string output;
        for (const char c : input)
            if (forbidden_host_code_point(c))
                invalid("opaque host has a forbidden code point");
        append_encoded(output, input, EncodeSet::c0);
        return output;
    }
    const auto domain = percent_decode(input);
    std::string ascii;
    for (const char c : domain) {
        if (static_cast<unsigned char>(c) >= 0x80)
            invalid("internationalized domain names are not lowered");
        ascii.push_back(ascii_lower(c));
    }
    if (ascii.empty())
        invalid("empty host");
    for (const char c : ascii)
        if (forbidden_host_code_point(c) || static_cast<unsigned char>(c) < 0x20 || c == '%' ||
            c == 0x7F)
            invalid("domain has a forbidden code point");
    return ends_in_number(ascii) ? parse_ipv4(ascii) : ascii;
}

} // namespace url_detail

/**
 * A WHATWG URL record and its URL object (URL Standard): parsing with an optional base,
 * serialization, the scheme/host/port/path/query/fragment getters and the href, pathname,
 * search and hash setters. `search_params()` is the URL's one URLSearchParams object, kept in
 * step both ways. Hosts must be ASCII (no IDNA mapping).
 */
class Url {
public:
    Url() = default;
    /** `new URL(input, base?)`: throws TypeError when parsing fails. */
    explicit Url(std::string_view input, const Url* base = nullptr)
        : state_(std::make_shared<State>()) {
        state_->record = parse(input, base ? &base->state().record : nullptr);
        bind_search_params();
    }
    Url(std::string_view input, std::string_view base) : state_(std::make_shared<State>()) {
        const Record parsed_base = parse(base, nullptr);
        state_->record = parse(input, &parsed_base);
        bind_search_params();
    }

    [[nodiscard]] std::string href() const { return serialize(state().record); }
    [[nodiscard]] std::string protocol() const { return state().record.scheme + ":"; }
    [[nodiscard]] std::string username() const { return state().record.username; }
    [[nodiscard]] std::string password() const { return state().record.password; }
    [[nodiscard]] std::string host() const {
        const auto& url = state().record;
        if (!url.host)
            return {};
        return *url.host + (url.port ? ":" + std::to_string(*url.port) : std::string());
    }
    [[nodiscard]] std::string hostname() const { return state().record.host.value_or(""); }
    [[nodiscard]] std::string port() const {
        const auto& url = state().record;
        return url.port ? std::to_string(*url.port) : std::string();
    }
    [[nodiscard]] std::string pathname() const { return path_string(state().record); }
    [[nodiscard]] std::string search() const {
        const auto& query = state().record.query;
        return query && !query->empty() ? "?" + *query : std::string();
    }
    [[nodiscard]] std::string hash() const {
        const auto& fragment = state().record.fragment;
        return fragment && !fragment->empty() ? "#" + *fragment : std::string();
    }
    [[nodiscard]] std::string origin() const {
        const auto& url = state().record;
        if (url.scheme == "http" || url.scheme == "https" || url.scheme == "ws" ||
            url.scheme == "wss" || url.scheme == "ftp")
            return url.scheme + "://" + host();
        if (url.scheme == "blob" && url.opaque_path) {
            try {
                const Url inner(*url.opaque_path);
                if (inner.state().record.scheme == "http" || inner.state().record.scheme == "https")
                    return inner.origin();
            } catch (const NamedError&) {
            }
        }
        return "null";
    }
    [[nodiscard]] const SearchParams& search_params() const { return state().query_object; }
    [[nodiscard]] std::string to_string() const { return href(); }

    /** `url.href = value`: a parse failure throws TypeError and leaves the URL unchanged. */
    void set_href(std::string_view value) const {
        auto& current = state();
        current.record = parse(value, nullptr);
        current.query_object.replace_query(current.record.query.value_or(""));
    }
    /** `url.pathname = value` (ignored for an opaque path). */
    void set_pathname(std::string_view value) const {
        auto& url = state().record;
        if (url.opaque_path)
            return;
        url.path.clear();
        Parser parser(url, nullptr);
        parser.run(strip(value, false), Parser::State::path_start);
    }
    /** `url.search = value`; the URL's URLSearchParams takes the new list. */
    void set_search(std::string_view value) const {
        auto& current = state();
        auto& url = current.record;
        auto input = strip(value, false);
        if (input.empty()) {
            url.query.reset();
            current.query_object.replace_query("");
            return;
        }
        if (input.starts_with('?'))
            input.erase(0, 1);
        url.query = std::string();
        Parser parser(url, nullptr);
        parser.run(input, Parser::State::query);
        current.query_object.replace_query(input);
    }
    /** `url.hash = value`. */
    void set_hash(std::string_view value) const {
        auto& url = state().record;
        auto input = strip(value, false);
        if (input.empty()) {
            url.fragment.reset();
            return;
        }
        if (input.starts_with('#'))
            input.erase(0, 1);
        url.fragment = std::string();
        Parser parser(url, nullptr);
        parser.run(input, Parser::State::fragment);
    }

    [[nodiscard]] const void* get() const noexcept { return state_.get(); }
    explicit operator bool() const noexcept { return static_cast<bool>(state_); }
    [[nodiscard]] friend bool operator==(const Url& left, const Url& right) {
        return left.state_ == right.state_;
    }
    void gc_trace(const TraceVisitor&) const {}

private:
    struct Record {
        std::string scheme;
        std::string username;
        std::string password;
        std::optional<std::string> host;
        std::optional<int> port;
        std::vector<std::string> path;
        std::optional<std::string> opaque_path;
        std::optional<std::string> query;
        std::optional<std::string> fragment;
    };
    struct State {
        Record record;
        SearchParams query_object;
    };

    /** One run of the basic URL parser over `url` (URL Standard state machine). */
    class Parser {
    public:
        enum class State {
            scheme_start,
            scheme,
            no_scheme,
            special_relative_or_authority,
            path_or_authority,
            relative,
            relative_slash,
            special_authority_slashes,
            special_authority_ignore_slashes,
            authority,
            host,
            port,
            file,
            file_slash,
            file_host,
            path_start,
            path,
            opaque_path,
            query,
            fragment,
        };
        Parser(Record& url, const Record* base) : url_(url), base_(base) {}

        void run(const std::string& input, State state) {
            const bool override_state = state != State::scheme_start;
            std::string buffer;
            bool at_sign_seen = false, inside_brackets = false, password_token_seen = false;
            const auto size = static_cast<std::ptrdiff_t>(input.size());
            // A state that moves `pointer` back re-reads its code point, EOF included.
            for (std::ptrdiff_t pointer = 0;; ++pointer) {
                const bool eof = pointer >= size;
                const char c = eof ? '\0' : input[static_cast<std::size_t>(pointer)];
                const auto remaining =
                    eof ? std::string_view()
                        : std::string_view(input).substr(static_cast<std::size_t>(pointer) + 1);
                const auto rest = [&] {
                    return std::string_view(input).substr(static_cast<std::size_t>(pointer));
                };
                const bool is_special = url_detail::special(url_.scheme);
                switch (state) {
                case State::scheme_start:
                    if (!eof && url_detail::ascii_alpha(c)) {
                        buffer.push_back(ascii_lower(c));
                        state = State::scheme;
                    } else {
                        state = State::no_scheme;
                        --pointer;
                    }
                    break;
                case State::scheme:
                    if (!eof && (url_detail::ascii_alpha(c) || url_detail::ascii_digit(c) ||
                                 c == '+' || c == '-' || c == '.')) {
                        buffer.push_back(ascii_lower(c));
                    } else if (!eof && c == ':') {
                        url_.scheme = buffer;
                        buffer.clear();
                        if (url_.scheme == "file") {
                            state = State::file;
                        } else if (url_detail::special(url_.scheme) && base_ &&
                                   base_->scheme == url_.scheme) {
                            state = State::special_relative_or_authority;
                        } else if (url_detail::special(url_.scheme)) {
                            state = State::special_authority_slashes;
                        } else if (remaining.starts_with('/')) {
                            state = State::path_or_authority;
                            ++pointer;
                        } else {
                            url_.opaque_path = std::string();
                            state = State::opaque_path;
                        }
                    } else {
                        buffer.clear();
                        state = State::no_scheme;
                        pointer = -1;
                    }
                    break;
                case State::no_scheme:
                    if (!base_ || (base_->opaque_path && c != '#'))
                        url_detail::invalid("a relative URL needs a base");
                    if (base_->opaque_path && c == '#') {
                        url_.scheme = base_->scheme;
                        url_.opaque_path = base_->opaque_path;
                        url_.query = base_->query;
                        url_.fragment = std::string();
                        state = State::fragment;
                    } else if (base_->scheme != "file") {
                        state = State::relative;
                        --pointer;
                    } else {
                        state = State::file;
                        --pointer;
                    }
                    break;
                case State::special_relative_or_authority:
                    if (c == '/' && remaining.starts_with('/')) {
                        state = State::special_authority_ignore_slashes;
                        ++pointer;
                    } else {
                        state = State::relative;
                        --pointer;
                    }
                    break;
                case State::path_or_authority:
                    if (c == '/')
                        state = State::authority;
                    else {
                        state = State::path;
                        --pointer;
                    }
                    break;
                case State::relative:
                    url_.scheme = base_->scheme;
                    if (c == '/' || (is_special && c == '\\')) {
                        state = State::relative_slash;
                    } else {
                        copy_authority();
                        url_.path = base_->path;
                        url_.query = base_->query;
                        if (c == '?') {
                            url_.query = std::string();
                            state = State::query;
                        } else if (c == '#') {
                            url_.fragment = std::string();
                            state = State::fragment;
                        } else if (!eof) {
                            url_.query.reset();
                            shorten_path();
                            state = State::path;
                            --pointer;
                        }
                    }
                    break;
                case State::relative_slash:
                    if (is_special && (c == '/' || c == '\\'))
                        state = State::special_authority_ignore_slashes;
                    else if (c == '/')
                        state = State::authority;
                    else {
                        copy_authority();
                        state = State::path;
                        --pointer;
                    }
                    break;
                case State::special_authority_slashes:
                    if (c == '/' && remaining.starts_with('/')) {
                        state = State::special_authority_ignore_slashes;
                        ++pointer;
                    } else {
                        state = State::special_authority_ignore_slashes;
                        --pointer;
                    }
                    break;
                case State::special_authority_ignore_slashes:
                    if (c != '/' && c != '\\') {
                        state = State::authority;
                        --pointer;
                    }
                    break;
                case State::authority:
                    if (!eof && c == '@') {
                        if (at_sign_seen)
                            buffer = "%40" + buffer;
                        at_sign_seen = true;
                        for (const char code : buffer) {
                            if (code == ':' && !password_token_seen) {
                                password_token_seen = true;
                                continue;
                            }
                            auto& target = password_token_seen ? url_.password : url_.username;
                            url_detail::append_encoded(target, std::string_view(&code, 1),
                                                       url_detail::EncodeSet::userinfo);
                        }
                        buffer.clear();
                    } else if (eof || c == '/' || c == '?' || c == '#' ||
                               (is_special && c == '\\')) {
                        if (at_sign_seen && buffer.empty())
                            url_detail::invalid("credentials without a host");
                        pointer -= static_cast<std::ptrdiff_t>(buffer.size()) + 1;
                        buffer.clear();
                        state = State::host;
                    } else
                        buffer.push_back(c);
                    break;
                case State::host:
                    if (!eof && c == ':' && !inside_brackets) {
                        if (buffer.empty())
                            url_detail::invalid("empty host");
                        url_.host = url_detail::parse_host(buffer, !is_special);
                        buffer.clear();
                        state = State::port;
                    } else if (eof || c == '/' || c == '?' || c == '#' ||
                               (is_special && c == '\\')) {
                        --pointer;
                        if (is_special && buffer.empty())
                            url_detail::invalid("empty host");
                        url_.host = buffer.empty() ? std::string()
                                                   : url_detail::parse_host(buffer, !is_special);
                        buffer.clear();
                        state = State::path_start;
                    } else {
                        if (c == '[')
                            inside_brackets = true;
                        if (c == ']')
                            inside_brackets = false;
                        buffer.push_back(c);
                    }
                    break;
                case State::port:
                    if (!eof && url_detail::ascii_digit(c)) {
                        buffer.push_back(c);
                    } else if (eof || c == '/' || c == '?' || c == '#' ||
                               (is_special && c == '\\')) {
                        if (!buffer.empty()) {
                            long value = 0;
                            for (const char digit : buffer) {
                                value = value * 10 + (digit - '0');
                                if (value > 65535)
                                    url_detail::invalid("port exceeds 65535");
                            }
                            url_.port = value == url_detail::special_port(url_.scheme)
                                            ? std::nullopt
                                            : std::optional<int>(static_cast<int>(value));
                            buffer.clear();
                        }
                        state = State::path_start;
                        --pointer;
                    } else
                        url_detail::invalid("port is not a number");
                    break;
                case State::file:
                    url_.scheme = "file";
                    url_.host = std::string();
                    if (c == '/' || c == '\\') {
                        state = State::file_slash;
                    } else if (base_ && base_->scheme == "file") {
                        url_.host = base_->host;
                        url_.path = base_->path;
                        url_.query = base_->query;
                        if (c == '?') {
                            url_.query = std::string();
                            state = State::query;
                        } else if (c == '#') {
                            url_.fragment = std::string();
                            state = State::fragment;
                        } else if (!eof) {
                            url_.query.reset();
                            if (!url_detail::starts_with_drive_letter(rest()))
                                shorten_path();
                            else
                                url_.path.clear();
                            state = State::path;
                            --pointer;
                        }
                    } else {
                        state = State::path;
                        --pointer;
                    }
                    break;
                case State::file_slash:
                    if (c == '/' || c == '\\') {
                        state = State::file_host;
                    } else {
                        if (base_ && base_->scheme == "file") {
                            url_.host = base_->host;
                            if (!url_detail::starts_with_drive_letter(rest()) &&
                                !base_->path.empty() &&
                                url_detail::windows_drive_letter(base_->path.front(), true))
                                url_.path.push_back(base_->path.front());
                        }
                        state = State::path;
                        --pointer;
                    }
                    break;
                case State::file_host:
                    if (eof || c == '/' || c == '\\' || c == '?' || c == '#') {
                        --pointer;
                        if (url_detail::windows_drive_letter(buffer, false)) {
                            state = State::path;
                        } else if (buffer.empty()) {
                            url_.host = std::string();
                            state = State::path_start;
                        } else {
                            auto host = url_detail::parse_host(buffer, false);
                            url_.host = host == "localhost" ? std::string() : host;
                            buffer.clear();
                            state = State::path_start;
                        }
                    } else
                        buffer.push_back(c);
                    break;
                case State::path_start:
                    if (is_special) {
                        state = State::path;
                        if (c != '/' && c != '\\')
                            --pointer;
                    } else if (!override_state && c == '?') {
                        url_.query = std::string();
                        state = State::query;
                    } else if (!override_state && c == '#') {
                        url_.fragment = std::string();
                        state = State::fragment;
                    } else if (!eof) {
                        state = State::path;
                        if (c != '/')
                            --pointer;
                    } else if (override_state && !url_.host) {
                        url_.path.emplace_back();
                    }
                    break;
                case State::path:
                    if (eof || c == '/' || (is_special && c == '\\') ||
                        (!override_state && (c == '?' || c == '#'))) {
                        const bool slash = c == '/' || (is_special && c == '\\');
                        if (url_detail::double_dot(buffer)) {
                            shorten_path();
                            if (!slash)
                                url_.path.emplace_back();
                        } else if (url_detail::single_dot(buffer) && !slash) {
                            url_.path.emplace_back();
                        } else if (!url_detail::single_dot(buffer)) {
                            if (url_.scheme == "file" && url_.path.empty() &&
                                url_detail::windows_drive_letter(buffer, false))
                                buffer[1] = ':';
                            url_.path.push_back(buffer);
                        }
                        buffer.clear();
                        if (c == '?') {
                            url_.query = std::string();
                            state = State::query;
                        } else if (c == '#') {
                            url_.fragment = std::string();
                            state = State::fragment;
                        }
                    } else {
                        url_detail::append_encoded(buffer, std::string_view(&c, 1),
                                                   url_detail::EncodeSet::path);
                    }
                    break;
                case State::opaque_path:
                    if (c == '?') {
                        url_.query = std::string();
                        state = State::query;
                    } else if (c == '#') {
                        url_.fragment = std::string();
                        state = State::fragment;
                    } else if (!eof) {
                        url_detail::append_encoded(*url_.opaque_path, std::string_view(&c, 1),
                                                   url_detail::EncodeSet::c0);
                    }
                    break;
                case State::query:
                    if ((!override_state && c == '#') || eof) {
                        url_detail::append_encoded(*url_.query, buffer,
                                                   is_special ? url_detail::EncodeSet::special_query
                                                              : url_detail::EncodeSet::query);
                        buffer.clear();
                        if (c == '#') {
                            url_.fragment = std::string();
                            state = State::fragment;
                        }
                    } else
                        buffer.push_back(c);
                    break;
                case State::fragment:
                    if (!eof)
                        url_detail::append_encoded(*url_.fragment, std::string_view(&c, 1),
                                                   url_detail::EncodeSet::fragment);
                    break;
                }
                if (pointer >= size)
                    return;
            }
        }

    private:
        void copy_authority() {
            url_.username = base_->username;
            url_.password = base_->password;
            url_.host = base_->host;
            url_.port = base_->port;
        }
        void shorten_path() {
            if (url_.scheme == "file" && url_.path.size() == 1 &&
                url_detail::windows_drive_letter(url_.path.front(), true))
                return;
            if (!url_.path.empty())
                url_.path.pop_back();
        }
        Record& url_;
        const Record* base_;
    };

    /** Leading and trailing C0 controls and spaces, then every tab and newline, are removed. */
    static std::string strip(std::string_view input, bool trim) {
        if (trim) {
            while (!input.empty() && static_cast<unsigned char>(input.front()) <= 0x20)
                input.remove_prefix(1);
            while (!input.empty() && static_cast<unsigned char>(input.back()) <= 0x20)
                input.remove_suffix(1);
        }
        std::string output;
        for (const char c : usv_string(input))
            if (c != '\t' && c != '\n' && c != '\r')
                output.push_back(c);
        return output;
    }
    static Record parse(std::string_view input, const Record* base) {
        Record record;
        Parser parser(record, base);
        parser.run(strip(input, true), Parser::State::scheme_start);
        return record;
    }
    static std::string path_string(const Record& url) {
        if (url.opaque_path)
            return *url.opaque_path;
        std::string output;
        for (const auto& segment : url.path)
            output += "/" + segment;
        return output;
    }
    static std::string serialize(const Record& url) {
        std::string output = url.scheme + ":";
        if (url.host) {
            output += "//";
            if (!url.username.empty() || !url.password.empty()) {
                output += url.username;
                if (!url.password.empty())
                    output += ":" + url.password;
                output += "@";
            }
            output += *url.host;
            if (url.port)
                output += ":" + std::to_string(*url.port);
        } else if (!url.opaque_path && url.path.size() > 1 && url.path.front().empty()) {
            output += "/.";
        }
        output += path_string(url);
        if (url.query)
            output += "?" + *url.query;
        if (url.fragment)
            output += "#" + *url.fragment;
        return output;
    }
    void bind_search_params() {
        const std::weak_ptr<State> weak = state_;
        state_->query_object = SearchParams::for_url(
            state_->record.query.value_or(""), [weak](const std::string& serialized) {
                // The URL Standard's URLSearchParams update steps.
                if (const auto current = weak.lock())
                    current->record.query =
                        serialized.empty() ? std::nullopt : std::optional<std::string>(serialized);
            });
    }
    State& state() const {
        if (!state_)
            throw std::runtime_error("URL receiver is absent.");
        return *state_;
    }

    std::shared_ptr<State> state_;
};

} // namespace bbl::js
