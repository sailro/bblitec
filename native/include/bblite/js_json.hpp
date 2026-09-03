#pragma once

// The generic JSON data bridge: `JSON.stringify` over the plain-data model
// and `JSON.parse` into the one dynamic value a JSON document can hold.
//
// Neither half knows any application. `JSON.stringify` writes through
// `json_write` overloads -- one per plain-data container here, one per
// reached generated struct emitted beside the struct itself -- so the key
// order is the record's own declaration order and nothing sorts it. The
// bytes are observable (they are what a save round-trips and what a debug
// capture shows), which is why nlohmann's `std::map`-backed object is not
// the writer.
//
// `JSON.parse` is nlohmann's parser -- it owns the grammar and throws on a
// syntax error, exactly as the browser's does -- lifted into `JsonValue`,
// which answers the JavaScript questions a document is interrogated with:
// truthiness, a missing property, `Array.isArray`, `typeof`, a strict
// comparison. A missing or wrong-typed field reads as `undefined` rather
// than throwing, so a source-level shape guard decides the same way it does
// in the browser.
//
// Included only by a scene that reaches JSON (`jsonReached`), so the
// plain-data header every scene includes carries no parser for it.

#include <bblite/js_data.hpp>

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifndef JSON_USE_IMPLICIT_CONVERSIONS
#define JSON_USE_IMPLICIT_CONVERSIONS 0
#endif
#include <nlohmann/json.hpp>

namespace bbl::js {

// ── JSON.stringify ────────────────────────────────────────────────────

/**
 * The document writer. Values are pushed in the order the caller emits
 * them, which is how a generated struct codec reproduces JavaScript's
 * object key order: the declaration order of the record it was lowered
 * from.
 *
 * `indent` is `JSON.stringify`'s third argument: 0 is the compact form,
 * n > 0 the pretty form with n spaces per level.
 */
class JsonWriter {
  public:
    JsonWriter() = default;
    explicit JsonWriter(int indent)
        : indent_(indent > 0 ? indent : 0) {}

    void begin_object() {
        separate();
        text_.push_back('{');
        levels_.push_back(true);
    }

    void end_object() {
        const bool empty = levels_.empty() || levels_.back();
        if (!levels_.empty()) levels_.pop_back();
        if (!empty) newline_indent(levels_.size());
        text_.push_back('}');
    }

    void begin_array() {
        separate();
        text_.push_back('[');
        levels_.push_back(true);
    }

    void end_array() {
        const bool empty = levels_.empty() || levels_.back();
        if (!levels_.empty()) levels_.pop_back();
        if (!empty) newline_indent(levels_.size());
        text_.push_back(']');
    }

    /** Names the next object member; the value write follows. */
    void key(std::string_view name) {
        separate();
        write_string(name);
        text_.push_back(':');
        if (indent_ > 0) text_.push_back(' ');
        pending_key_ = true;
    }

    void number(double value) {
        separate();
        // `JSON.stringify` writes a non-finite number as null; every finite
        // one goes through the single formatter every string coercion in
        // this runtime shares, so the digits match the browser's.
        if (!std::isfinite(value)) {
            text_.append("null");
            return;
        }
        NumberTextBuffer buffer{};
        text_.append(format_number(value, buffer));
    }

    void boolean(bool value) {
        separate();
        text_.append(value ? "true" : "false");
    }

    void string(std::string_view value) {
        separate();
        write_string(value);
    }

    void null_value() {
        separate();
        text_.append("null");
    }

    [[nodiscard]] const std::string& text() const { return text_; }
    [[nodiscard]] std::string take() { return std::move(text_); }

  private:
    /**
     * Emits the comma and the line break that precede a value. A value
     * that follows its own key is already positioned, so the key consumes
     * the separator instead.
     */
    void separate() {
        if (pending_key_) {
            pending_key_ = false;
            return;
        }
        if (levels_.empty()) return;
        if (!levels_.back()) {
            text_.push_back(',');
        }
        levels_.back() = false;
        newline_indent(levels_.size());
    }

    /** A line break plus the indent for `levels` open containers. */
    void newline_indent(std::size_t levels) {
        if (indent_ <= 0) return;
        text_.push_back('\n');
        text_.append(levels * static_cast<std::size_t>(indent_), ' ');
    }

    void write_string(std::string_view value) {
        text_.push_back('"');
        for (const char raw : value) {
            const auto byte = static_cast<unsigned char>(raw);
            switch (byte) {
                case '"': text_.append("\\\""); continue;
                case '\\': text_.append("\\\\"); continue;
                case '\b': text_.append("\\b"); continue;
                case '\f': text_.append("\\f"); continue;
                case '\n': text_.append("\\n"); continue;
                case '\r': text_.append("\\r"); continue;
                case '\t': text_.append("\\t"); continue;
                default: break;
            }
            if (byte < 0x20u) {
                static constexpr char kHex[] = "0123456789abcdef";
                text_.append("\\u00");
                text_.push_back(kHex[(byte >> 4) & 0xFu]);
                text_.push_back(kHex[byte & 0xFu]);
                continue;
            }
            // Everything at or above 0x20 is written through: JSON.stringify
            // escapes no printable ASCII beyond quote and backslash, and
            // leaves UTF-8 sequences as they are.
            text_.push_back(raw);
        }
        text_.push_back('"');
    }

    std::string text_;
    std::vector<bool> levels_;
    int indent_ = 0;
    bool pending_key_ = false;
};

class JsonValue;

inline void json_write(JsonWriter& writer, double value) {
    writer.number(value);
}

inline void json_write(JsonWriter& writer, bool value) {
    writer.boolean(value);
}

inline void json_write(JsonWriter& writer, const std::string& value) {
    writer.string(value);
}

inline void json_write(JsonWriter& writer, const JsonValue& value);

/** A record key: a string is itself, a numeric key is its own spelling. */
[[nodiscard]] inline const std::string& json_object_key(
    const std::string& key) {
    return key;
}

[[nodiscard]] inline std::string json_object_key(double key) {
    return number_to_string(key);
}

template <typename T>
inline void json_write(JsonWriter& writer, const Array<T>& values) {
    writer.begin_array();
    for (std::size_t index = 0; index < values.size(); ++index) {
        json_write(writer, values[index]);
    }
    writer.end_array();
}

/**
 * An absent optional is the compiler's `undefined`. JavaScript drops an
 * `undefined` object member and writes `null` for an `undefined` array
 * slot, so the omission is decided by the object codec (which tests
 * `has_value()` before naming the key) and this overload serves the array
 * and top-level positions, where `null` is what JavaScript emits.
 */
template <typename T>
inline void json_write(JsonWriter& writer, const Nullable<T>& value) {
    if (!value.has_value()) {
        writer.null_value();
        return;
    }
    json_write(writer, *value);
}

template <std::size_t N>
inline void json_write(JsonWriter& writer, const Tuple<N>& values) {
    writer.begin_array();
    for (std::size_t index = 0; index < N; ++index) {
        writer.number(values[index]);
    }
    writer.end_array();
}

/**
 * A reference-backed record. An empty handle is the source's `null`, which
 * is what JavaScript writes for it.
 */
template <typename T>
inline void json_write(JsonWriter& writer, const Ref<T>& value) {
    if (!value) {
        writer.null_value();
        return;
    }
    json_write(writer, *value);
}

/**
 * A `Map` is the lowering of a JavaScript record/index signature, and its
 * storage is insertion-ordered, so the written keys keep the order the
 * source inserted them in.
 */
template <typename K, typename V>
inline void json_write(JsonWriter& writer, const Map<K, V>& entries) {
    writer.begin_object();
    for (const auto& entry : entries) {
        writer.key(json_object_key(entry.first));
        json_write(writer, entry.second);
    }
    writer.end_object();
}

template <typename T>
[[nodiscard]] inline std::string json_stringify(const T& value) {
    JsonWriter writer;
    json_write(writer, value);
    return writer.take();
}

template <typename T>
[[nodiscard]] inline std::string json_stringify(const T& value, int indent) {
    JsonWriter writer(indent);
    json_write(writer, value);
    return writer.take();
}

// ── JSON.parse ────────────────────────────────────────────────────────

/**
 * One node of a parsed document, answering the JavaScript questions a
 * `JSON.parse` result is interrogated with. Reads never throw: a missing
 * property and an out-of-range index are `undefined`, exactly as they are
 * in the browser, so a source-level shape guard reaches the same verdict.
 */
class JsonValue {
  public:
    enum class Kind : std::uint8_t {
        undefined,
        null,
        boolean,
        number,
        string,
        array,
        object,
    };

    using Array = std::vector<JsonValue>;
    using Entry = std::pair<std::string, JsonValue>;
    using Object = std::vector<Entry>;

    JsonValue() = default;

    [[nodiscard]] static JsonValue null_value() {
        JsonValue value;
        value.kind_ = Kind::null;
        return value;
    }

    [[nodiscard]] static JsonValue from_boolean(bool boolean) {
        JsonValue value;
        value.kind_ = Kind::boolean;
        value.boolean_ = boolean;
        return value;
    }

    [[nodiscard]] static JsonValue from_number(double number) {
        JsonValue value;
        value.kind_ = Kind::number;
        value.number_ = number;
        return value;
    }

    [[nodiscard]] static JsonValue from_string(std::string text) {
        JsonValue value;
        value.kind_ = Kind::string;
        value.string_ = std::move(text);
        return value;
    }

    [[nodiscard]] static JsonValue from_array(Array elements) {
        JsonValue value;
        value.kind_ = Kind::array;
        value.array_ = std::make_shared<Array>(std::move(elements));
        return value;
    }

    [[nodiscard]] static JsonValue from_object(Object entries) {
        JsonValue value;
        value.kind_ = Kind::object;
        value.object_ = std::make_shared<Object>(std::move(entries));
        return value;
    }

    [[nodiscard]] Kind kind() const { return kind_; }
    [[nodiscard]] bool is_undefined() const { return kind_ == Kind::undefined; }
    [[nodiscard]] bool is_null() const { return kind_ == Kind::null; }
    [[nodiscard]] bool is_boolean() const { return kind_ == Kind::boolean; }
    [[nodiscard]] bool is_number() const { return kind_ == Kind::number; }
    [[nodiscard]] bool is_string() const { return kind_ == Kind::string; }
    [[nodiscard]] bool is_array() const { return kind_ == Kind::array; }
    [[nodiscard]] bool is_object() const { return kind_ == Kind::object; }

    /** `typeof value` -- the operator, spelled the way JavaScript spells it. */
    [[nodiscard]] std::string type_of() const {
        switch (kind_) {
            case Kind::undefined: return "undefined";
            case Kind::boolean: return "boolean";
            case Kind::number: return "number";
            case Kind::string: return "string";
            case Kind::null:
            case Kind::array:
            case Kind::object: break;
        }
        return "object";
    }

    [[nodiscard]] bool truthy() const {
        switch (kind_) {
            case Kind::undefined:
            case Kind::null:
                return false;
            case Kind::boolean:
                return boolean_;
            case Kind::number:
                return number_ != 0.0 && !std::isnan(number_);
            case Kind::string:
                return !string_.empty();
            case Kind::array:
            case Kind::object:
                break;
        }
        return true;
    }

    /** `value.length` for an array; `undefined` elsewhere reads as NaN. */
    [[nodiscard]] double length() const {
        if (kind_ != Kind::array) {
            return std::numeric_limits<double>::quiet_NaN();
        }
        return static_cast<double>(array_->size());
    }

    [[nodiscard]] const JsonValue& at(double index) const {
        static const JsonValue absent;
        if (kind_ != Kind::array || !(index >= 0.0)) return absent;
        const auto slot = static_cast<std::size_t>(index);
        if (static_cast<double>(slot) != index || slot >= array_->size()) {
            return absent;
        }
        return (*array_)[slot];
    }

    [[nodiscard]] const JsonValue& get(std::string_view key) const {
        static const JsonValue absent;
        if (kind_ != Kind::object) return absent;
        for (const Entry& entry : *object_) {
            if (entry.first == key) return entry.second;
        }
        return absent;
    }

    [[nodiscard]] const Object& entries() const {
        static const Object empty;
        return kind_ == Kind::object ? *object_ : empty;
    }

    [[nodiscard]] const Array& elements() const {
        static const Array empty;
        return kind_ == Kind::array ? *array_ : empty;
    }

    /** `Number(value)`, over the kinds a JSON document can hold. */
    [[nodiscard]] double to_number() const {
        switch (kind_) {
            case Kind::undefined:
                return std::numeric_limits<double>::quiet_NaN();
            case Kind::null:
                return 0.0;
            case Kind::boolean:
                return boolean_ ? 1.0 : 0.0;
            case Kind::number:
                return number_;
            case Kind::string:
                return number_from_string(string_);
            case Kind::array:
                // ToPrimitive joins with commas, then ToNumber reads that
                // string -- so [] is 0 and [3] is 3, as in the browser.
                return number_from_string(to_string());
            case Kind::object:
                break;
        }
        return std::numeric_limits<double>::quiet_NaN();
    }

    /** `String(value)`, over the kinds a JSON document can hold. */
    [[nodiscard]] std::string to_string() const {
        switch (kind_) {
            case Kind::undefined: return "undefined";
            case Kind::null: return "null";
            case Kind::boolean: return boolean_ ? "true" : "false";
            case Kind::number: return number_to_string(number_);
            case Kind::string: return string_;
            case Kind::array: {
                std::string joined;
                for (std::size_t index = 0; index < array_->size(); ++index) {
                    if (index != 0) joined.push_back(',');
                    const JsonValue& element = (*array_)[index];
                    // Array#join spells null and undefined as empty.
                    if (element.is_null() || element.is_undefined()) continue;
                    joined.append(element.to_string());
                }
                return joined;
            }
            case Kind::object: break;
        }
        return "[object Object]";
    }

    [[nodiscard]] const std::string& string_value() const {
        if (kind_ != Kind::string) {
            throw std::runtime_error("JSON value is not a string.");
        }
        return string_;
    }

    [[nodiscard]] bool strict_equals(double other) const {
        return kind_ == Kind::number && number_ == other;
    }

    [[nodiscard]] bool strict_equals(std::string_view other) const {
        return kind_ == Kind::string && string_ == other;
    }

    [[nodiscard]] bool strict_equals(bool other) const {
        return kind_ == Kind::boolean && boolean_ == other;
    }

    /** `Array#every` over an array; anything else has no elements to test. */
    template <typename Predicate>
    [[nodiscard]] bool every(Predicate predicate) const {
        if (kind_ != Kind::array) return true;
        for (const JsonValue& element : *array_) {
            if (!predicate(element)) return false;
        }
        return true;
    }

    /** `Array#some` over an array. */
    template <typename Predicate>
    [[nodiscard]] bool some(Predicate predicate) const {
        if (kind_ != Kind::array) return false;
        for (const JsonValue& element : *array_) {
            if (predicate(element)) return true;
        }
        return false;
    }

  private:
    Kind kind_ = Kind::undefined;
    bool boolean_ = false;
    double number_ = 0.0;
    std::string string_;
    std::shared_ptr<Array> array_;
    std::shared_ptr<Object> object_;
};

inline void json_write(JsonWriter& writer, const JsonValue& value) {
    switch (value.kind()) {
        case JsonValue::Kind::undefined:
        case JsonValue::Kind::null:
            writer.null_value();
            return;
        case JsonValue::Kind::boolean:
            writer.boolean(value.strict_equals(true));
            return;
        case JsonValue::Kind::number:
            writer.number(value.to_number());
            return;
        case JsonValue::Kind::string:
            writer.string(value.string_value());
            return;
        case JsonValue::Kind::array:
            writer.begin_array();
            for (const JsonValue& element : value.elements()) {
                json_write(writer, element);
            }
            writer.end_array();
            return;
        case JsonValue::Kind::object:
            break;
    }
    writer.begin_object();
    for (const auto& entry : value.entries()) {
        writer.key(entry.first);
        json_write(writer, entry.second);
    }
    writer.end_object();
}

[[nodiscard]] inline JsonValue json_value_from_document(
    const nlohmann::ordered_json& document) {
    if (document.is_null()) return JsonValue::null_value();
    if (document.is_boolean()) {
        return JsonValue::from_boolean(document.get<bool>());
    }
    if (document.is_number()) {
        return JsonValue::from_number(document.get<double>());
    }
    if (document.is_string()) {
        return JsonValue::from_string(document.get<std::string>());
    }
    if (document.is_array()) {
        JsonValue::Array elements;
        elements.reserve(document.size());
        for (const nlohmann::ordered_json& element : document) {
            elements.push_back(json_value_from_document(element));
        }
        return JsonValue::from_array(std::move(elements));
    }
    JsonValue::Object entries;
    entries.reserve(document.size());
    for (auto entry = document.begin(); entry != document.end(); ++entry) {
        entries.emplace_back(
            entry.key(),
            json_value_from_document(entry.value()));
    }
    return JsonValue::from_object(std::move(entries));
}

/**
 * `JSON.parse(text)`. nlohmann owns the grammar and throws on a malformed
 * document, which is the browser's SyntaxError: a surrounding `try`/`catch`
 * in the source sees it exactly where it would there.
 */
[[nodiscard]] inline JsonValue json_parse(const std::string& text) {
    // `ordered_json` rather than the default `json`, whose object is a
    // sorted `std::map`: a document read back and written out again keeps
    // its own key order.
    return json_value_from_document(
        nlohmann::ordered_json::parse(text));
}

/**
 * A document's leading N elements as a fixed numeric tuple -- the lowering
 * of a `[number, number, number]` assertion over a parsed array. Each lane
 * is `Number(element)`, so a lane the document does not carry is NaN
 * rather than a read past the end.
 */
template <std::size_t N>
[[nodiscard]] inline Tuple<N> json_tuple(const JsonValue& value) {
    Tuple<N> result;
    for (std::size_t index = 0; index < N; ++index) {
        result[index] = value.at(static_cast<double>(index)).to_number();
    }
    return result;
}

/** The same, as a growable numeric array of the document's own length. */
[[nodiscard]] inline Array<double> json_number_array(const JsonValue& value) {
    Array<double> result;
    result.reserve(value.elements().size());
    for (const JsonValue& element : value.elements()) {
        result.push_back(element.to_number());
    }
    return result;
}

/** The same, as strings. */
[[nodiscard]] inline Array<std::string> json_string_array(
    const JsonValue& value) {
    Array<std::string> result;
    result.reserve(value.elements().size());
    for (const JsonValue& element : value.elements()) {
        result.push_back(element.to_string());
    }
    return result;
}

} // namespace bbl::js
