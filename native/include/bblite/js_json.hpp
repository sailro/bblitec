#pragma once

// The generic JSON data bridge: `JSON.stringify` over the plain-data model
// and `JSON.parse` into the one dynamic value a JSON document can hold.
//
// Neither half knows any application. `JSON.stringify` writes through
// `json_write` overloads -- one per plain-data container here, one per
// reached generated struct emitted beside the struct itself -- so the key
// order follows JavaScript's own enumerable properties. Index keys precede
// other keys, which retain insertion order. The
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
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <string>
#include <string_view>
#include <utility>
#include <typeinfo>
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
    explicit JsonWriter(int indent) : indent_(indent > 0 ? indent : 0) {}

    void begin_object() {
        separate();
        text_.push_back('{');
        levels_.push_back(true);
    }

    void end_object() {
        const bool empty = levels_.empty() || levels_.back();
        if (!levels_.empty())
            levels_.pop_back();
        if (!empty)
            newline_indent(levels_.size());
        text_.push_back('}');
    }

    void begin_array() {
        separate();
        text_.push_back('[');
        levels_.push_back(true);
    }

    void end_array() {
        const bool empty = levels_.empty() || levels_.back();
        if (!levels_.empty())
            levels_.pop_back();
        if (!empty)
            newline_indent(levels_.size());
        text_.push_back(']');
    }

    /** Names the next object member; the value write follows. */
    void key(std::string_view name) {
        separate();
        write_string(name);
        text_.push_back(':');
        if (indent_ > 0)
            text_.push_back(' ');
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
        if (levels_.empty())
            return;
        if (!levels_.back()) {
            text_.push_back(',');
        }
        levels_.back() = false;
        newline_indent(levels_.size());
    }

    /** A line break plus the indent for `levels` open containers. */
    void newline_indent(std::size_t levels) {
        if (indent_ <= 0)
            return;
        text_.push_back('\n');
        text_.append(levels * static_cast<std::size_t>(indent_), ' ');
    }

    void write_string(std::string_view value) {
        text_.push_back('"');
        for (const char raw : value) {
            const auto byte = static_cast<unsigned char>(raw);
            switch (byte) {
            case '"':
                text_.append("\\\"");
                continue;
            case '\\':
                text_.append("\\\\");
                continue;
            case '\b':
                text_.append("\\b");
                continue;
            case '\f':
                text_.append("\\f");
                continue;
            case '\n':
                text_.append("\\n");
                continue;
            case '\r':
                text_.append("\\r");
                continue;
            case '\t':
                text_.append("\\t");
                continue;
            default:
                break;
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

inline void json_write(JsonWriter& writer, double value) { writer.number(value); }

inline void json_write(JsonWriter& writer, bool value) { writer.boolean(value); }

inline void json_write(JsonWriter& writer, const std::string& value) { writer.string(value); }

inline void json_write(JsonWriter& writer, const JsonValue& value);

/** A record key: a string is itself, a numeric key is its own spelling. */
[[nodiscard]] inline const std::string& json_object_key(const std::string& key) { return key; }
/** A temporary key would leave the returned reference dangling. */
const std::string& json_object_key(std::string&&) = delete;

[[nodiscard]] inline std::string json_object_key(double key) { return number_to_string(key); }

[[nodiscard]] inline std::optional<std::uint32_t> json_property_index(std::string_view name) {
    if (name.empty() || (name.size() > 1 && name.front() == '0'))
        return std::nullopt;
    std::uint32_t index = 0;
    const auto parsed = std::from_chars(name.data(), name.data() + name.size(), index);
    if (parsed.ec != std::errc{} || parsed.ptr != name.data() + name.size() ||
        index == std::numeric_limits<std::uint32_t>::max())
        return std::nullopt;
    return index;
}

[[nodiscard]] inline bool json_property_key_less(std::string_view left, std::string_view right) {
    const auto a = json_property_index(left), b = json_property_index(right);
    return a && (!b || *a < *b);
}

/** Sort references, avoiding repeated linear lookups in parsed object storage. */
template <typename Entries, typename Visitor>
inline void json_for_each_object_entry(const Entries& entries, Visitor&& visitor) {
    using Entry = std::remove_cvref_t<decltype(*entries.begin())>;
    std::vector<const Entry*> ordered;
    ordered.reserve(entries.size());
    for (const auto& entry : entries)
        ordered.push_back(&entry);
    std::stable_sort(ordered.begin(), ordered.end(), [](const Entry* left, const Entry* right) {
        return json_property_key_less(json_object_key(left->first), json_object_key(right->first));
    });
    for (const Entry* entry : ordered)
        visitor(entry->first, entry->second);
}

template <typename T> inline void json_write(JsonWriter& writer, const Array<T>& values) {
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
template <typename T> inline void json_write(JsonWriter& writer, const Nullable<T>& value) {
    if (!value.has_value()) {
        writer.null_value();
        return;
    }
    json_write(writer, *value);
}

template <std::size_t N> inline void json_write(JsonWriter& writer, const Tuple<N>& values) {
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
template <typename T> inline void json_write(JsonWriter& writer, const Ref<T>& value) {
    if (!value) {
        writer.null_value();
        return;
    }
    json_write(writer, *value);
}

/**
 * A `Map` is the lowering of a JavaScript record/index signature, and its
 * storage is insertion-ordered. Serialization orders its property keys as
 * JavaScript does, without changing the dictionary's storage.
 */
template <typename K, typename V>
inline void json_write(JsonWriter& writer, const Map<K, V>& entries) {
    writer.begin_object();
    json_for_each_object_entry(entries, [&](const K& key, const V& value) {
        if constexpr (std::is_same_v<V, JsonValue>) {
            if (value.is_undefined())
                return;
        }
        writer.key(json_object_key(key));
        json_write(writer, value);
    });
    writer.end_object();
}

template <typename T> [[nodiscard]] inline std::string json_stringify(const T& value) {
    JsonWriter writer;
    json_write(writer, value);
    return writer.take();
}

template <typename T> [[nodiscard]] inline std::string json_stringify(const T& value, int indent) {
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
struct JsonNativeObject {
    virtual ~JsonNativeObject() = default;
    [[nodiscard]] virtual JsonValue get(std::string_view key) const = 0;
    [[nodiscard]] virtual bbl::js::Array<std::string> own_keys() const = 0;
    [[nodiscard]] virtual const std::type_info& type() const = 0;
    [[nodiscard]] virtual const void* identity() const = 0;
    virtual void gc_trace(const TraceVisitor& visitor) const = 0;
};

struct JsonNativeArray {
    virtual ~JsonNativeArray() = default;
    [[nodiscard]] virtual std::size_t size() const = 0;
    [[nodiscard]] virtual JsonValue at(std::size_t index) const = 0;
    [[nodiscard]] virtual const void* identity() const = 0;
    virtual void gc_trace(const TraceVisitor& visitor) const = 0;
};

class JsonArrayView;

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
        value.array_ = make_gc_shared<Array>(std::move(elements));
        return value;
    }

    [[nodiscard]] static JsonValue from_object(Object entries) {
        JsonValue value;
        value.kind_ = Kind::object;
        value.object_ = make_gc_shared<Object>(std::move(entries));
        return value;
    }

    template <typename T> [[nodiscard]] static JsonValue from_native(T value);

    template <typename Getter>
    [[nodiscard]] static JsonValue from_record_view(Getter getter,
                                                    bbl::js::Array<std::string> keys);

    template <typename Getter>
    [[nodiscard]] static JsonValue from_tuple_view(Getter getter, std::size_t length);

    [[nodiscard]] static JsonValue from_array_reference(const bbl::js::Array<JsonValue>& elements) {
        JsonValue value;
        value.kind_ = Kind::array;
        value.array_ = elements.retained_storage();
        return value;
    }

    template <typename Sequence> [[nodiscard]] static JsonValue from_sequence(Sequence elements);

    [[nodiscard]] bbl::js::Array<JsonValue> array_value() const {
        if (!is_array())
            throw std::runtime_error("Value is not an array.");
        if (!array_)
            throw std::runtime_error(
                "Typed array storage cannot be reinterpreted as dynamic mutable storage.");
        return bbl::js::Array<JsonValue>(array_);
    }

    template <typename T> [[nodiscard]] bool instance_of() const {
        return native_ && native_->type() == typeid(T);
    }

    void gc_trace(const TraceVisitor& visitor) const {
        visitor(array_);
        visitor(object_);
        visitor(native_);
        visitor(native_array_);
    }

    [[nodiscard]] bool strict_equals(const JsonValue& other) const {
        if (kind_ != other.kind_)
            return false;
        switch (kind_) {
        case Kind::undefined:
        case Kind::null:
            return true;
        case Kind::boolean:
            return boolean_ == other.boolean_;
        case Kind::number:
            return number_ == other.number_;
        case Kind::string:
            return string_ == other.string_;
        case Kind::array:
            return array_identity() == other.array_identity();
        case Kind::object:
            if (native_ || other.native_)
                return native_ && other.native_ && native_->identity() == other.native_->identity();
            return object_ == other.object_;
        }
        return false;
    }

    [[nodiscard]] friend bool operator==(const JsonValue& left, const JsonValue& right) {
        return left.strict_equals(right);
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
        case Kind::undefined:
            return "undefined";
        case Kind::boolean:
            return "boolean";
        case Kind::number:
            return "number";
        case Kind::string:
            return "string";
        case Kind::null:
        case Kind::array:
        case Kind::object:
            break;
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
        return static_cast<double>(array_size());
    }

    [[nodiscard]] JsonValue at(double index) const {
        if (is_object() || is_string())
            return get(bbl::js::number_to_string(index));
        if (kind_ != Kind::array || !(index >= 0.0) || index >= static_cast<double>(array_size()))
            return {};
        const auto slot = static_cast<std::size_t>(index);
        if (static_cast<double>(slot) != index)
            return {};
        return native_array_ ? native_array_->at(slot) : (*array_)[slot];
    }

    [[nodiscard]] JsonValue get(std::string_view key) const {
        if (is_array() || is_string()) {
            if (key == "length")
                return from_number(
                    is_array() ? length() : static_cast<double>(string_code_units(string_).size()));
            const auto index = json_property_index(key);
            if (!index)
                return {};
            if (is_array())
                return at(static_cast<double>(*index));
            const auto units = string_code_units(string_);
            return *index < units.size()
                       ? from_string(string_char_at(string_, static_cast<double>(*index)))
                       : JsonValue{};
        }
        if (kind_ != Kind::object)
            return {};
        if (native_)
            return native_->get(key);
        for (const Entry& entry : *object_) {
            if (entry.first == key)
                return entry.second;
        }
        return {};
    }

    template <typename Visitor> void for_each_entry(Visitor&& visitor) const {
        if (native_) {
            for (const auto& key : own_keys())
                visitor(key, native_->get(key));
        } else if (kind_ == Kind::object) {
            json_for_each_object_entry(*object_, std::forward<Visitor>(visitor));
        }
    }

    void set(std::string_view key, JsonValue value) const {
        if (kind_ != Kind::object || native_)
            throw std::runtime_error("Dynamic property assignment requires an owned object.");
        for (Entry& entry : *object_) {
            if (entry.first == key) {
                entry.second = std::move(value);
                return;
            }
        }
        object_->emplace_back(key, std::move(value));
    }

    [[nodiscard]] JsonArrayView elements() const;

    /** Own enumerable properties: index keys precede other keys in insertion order. */
    [[nodiscard]] bbl::js::Array<std::string> own_keys() const {
        if (is_null() || is_undefined())
            throw std::runtime_error("Cannot enumerate null or undefined.");
        bbl::js::Array<std::string> result;
        if (is_array() || is_string()) {
            const auto count = is_array() ? array_size() : string_code_units(string_).size();
            for (std::size_t index = 0; index < count; ++index)
                result.push_back(std::to_string(index));
        } else if (is_object()) {
            if (native_)
                result = native_->own_keys();
            else
                for (const auto& entry : *object_)
                    result.push_back(entry.first);
            std::stable_sort(result.begin(), result.end(), json_property_key_less);
        }
        return result;
    }

    [[nodiscard]] bbl::js::Array<JsonValue> own_values() const {
        bbl::js::Array<JsonValue> result;
        if (is_object()) {
            for_each_entry([&](const auto&, const JsonValue& value) { result.push_back(value); });
        } else {
            for (const auto& key : own_keys())
                result.push_back(get(key));
        }
        return result;
    }

    [[nodiscard]] bool has_own(std::string_view key) const {
        if (is_null() || is_undefined())
            throw std::runtime_error("Cannot inspect null or undefined.");
        if (is_object()) {
            if (native_) {
                for (const auto& name : native_->own_keys())
                    if (name == key)
                        return true;
                return false;
            }
            for (const auto& entry : *object_)
                if (entry.first == key)
                    return true;
        } else if (is_array() || is_string()) {
            if (key == "length")
                return true;
            const auto index = json_property_index(key);
            return index &&
                   *index < (is_array() ? array_size() : string_code_units(string_).size());
        }
        return false;
    }

    [[nodiscard]] bool has_property(std::string_view key) const {
        if (!is_object() && !is_array())
            throw std::runtime_error("The right side of in must be an object.");
        if (has_own(key))
            return true;
        for (const auto name :
             {"constructor", "__defineGetter__", "__defineSetter__", "hasOwnProperty",
              "__lookupGetter__", "__lookupSetter__", "isPrototypeOf", "propertyIsEnumerable",
              "toLocaleString", "toString", "valueOf", "__proto__"})
            if (key == name)
                return true;
        if (is_array()) {
            for (const auto name :
                 {"at",       "concat",        "copyWithin",  "fill",     "find",      "findIndex",
                  "findLast", "findLastIndex", "lastIndexOf", "pop",      "push",      "reverse",
                  "shift",    "unshift",       "slice",       "sort",     "splice",    "includes",
                  "indexOf",  "join",          "keys",        "entries",  "values",    "forEach",
                  "filter",   "flat",          "flatMap",     "map",      "every",     "some",
                  "reduce",   "reduceRight",   "toReversed",  "toSorted", "toSpliced", "with"})
                if (key == name)
                    return true;
        }
        return false;
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
        case Kind::undefined:
            return "undefined";
        case Kind::null:
            return "null";
        case Kind::boolean:
            return boolean_ ? "true" : "false";
        case Kind::number:
            return number_to_string(number_);
        case Kind::string:
            return string_;
        case Kind::array: {
            std::string joined;
            const auto count = array_size();
            for (std::size_t index = 0; index < count; ++index) {
                if (index != 0)
                    joined.push_back(',');
                const JsonValue element = at(static_cast<double>(index));
                // Array#join spells null and undefined as empty.
                if (element.is_null() || element.is_undefined())
                    continue;
                joined.append(element.to_string());
            }
            return joined;
        }
        case Kind::object:
            break;
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
    [[nodiscard]] bool strict_equals(const char* other) const {
        return strict_equals(std::string_view(other));
    }

    [[nodiscard]] bool strict_equals(bool other) const {
        return kind_ == Kind::boolean && boolean_ == other;
    }

    /** `Array#every` over an array; anything else has no elements to test. */
    template <typename Predicate> [[nodiscard]] bool every(Predicate predicate) const {
        if (kind_ != Kind::array)
            return true;
        const auto count = array_size();
        for (std::size_t index = 0; index < count; ++index) {
            const JsonValue element = at(static_cast<double>(index));
            if (!predicate(element))
                return false;
        }
        return true;
    }

    /** `Array#some` over an array. */
    template <typename Predicate> [[nodiscard]] bool some(Predicate predicate) const {
        return !every(
            [&](const JsonValue& element) { return !static_cast<bool>(predicate(element)); });
    }

private:
    [[nodiscard]] std::size_t array_size() const {
        return native_array_ ? native_array_->size() : array_->size();
    }
    [[nodiscard]] const void* array_identity() const {
        return native_array_ ? native_array_->identity() : array_.get();
    }
    Kind kind_ = Kind::undefined;
    bool boolean_ = false;
    double number_ = 0.0;
    std::string string_;
    std::shared_ptr<Array> array_;
    std::shared_ptr<Object> object_;
    std::shared_ptr<JsonNativeObject> native_;
    std::shared_ptr<JsonNativeArray> native_array_;
};

/** An observing range retains its owner and reads each slot when visited. */
class JsonArrayView {
    JsonValue value_;

public:
    explicit JsonArrayView(JsonValue value) : value_(std::move(value)) {}
    [[nodiscard]] std::size_t size() const {
        return value_.is_array() ? static_cast<std::size_t>(value_.length()) : 0;
    }
    [[nodiscard]] bool empty() const { return size() == 0; }
    [[nodiscard]] JsonValue operator[](std::size_t index) const {
        return value_.at(static_cast<double>(index));
    }
    void gc_trace(const TraceVisitor& visitor) const { visitor(value_); }
    struct Sentinel {};
    struct Iterator {
        const JsonArrayView* owner;
        std::size_t index;
        [[nodiscard]] JsonValue operator*() const { return (*owner)[index]; }
        Iterator& operator++() {
            ++index;
            return *this;
        }
        [[nodiscard]] bool operator!=(Sentinel) const { return index < owner->size(); }
    };
    [[nodiscard]] Iterator begin() const { return {this, 0}; }
    [[nodiscard]] Sentinel end() const { return {}; }
};

inline JsonArrayView JsonValue::elements() const { return JsonArrayView(*this); }

/** Object spread copies own enumerable properties while retaining nested values. */
inline void json_spread_into(Map<std::string, JsonValue>& target, const JsonValue& source) {
    if (source.is_null() || source.is_undefined())
        return;
    if (source.is_object()) {
        source.for_each_entry(
            [&](const std::string& key, const JsonValue& value) { target.set(key, value); });
    } else {
        for (const auto& key : source.own_keys())
            target.set(key, source.get(key));
    }
}

inline void json_flatten_into(bbl::js::Array<JsonValue>& output, const JsonValue& value,
                              double depth) {
    if (depth > 0 && value.is_array()) {
        const auto values = value.elements();
        const auto length = values.size();
        for (std::size_t index = 0; index < length; ++index) {
            json_flatten_into(output, values[index], depth - 1);
        }
    } else
        output.push_back(value);
}

[[nodiscard]] inline JsonValue json_value(const JsonValue& value) { return value; }
[[nodiscard]] inline JsonValue json_value(double value) { return JsonValue::from_number(value); }
[[nodiscard]] inline JsonValue json_value(bool value) { return JsonValue::from_boolean(value); }
[[nodiscard]] inline JsonValue json_value(const std::string& value) {
    return JsonValue::from_string(value);
}
[[nodiscard]] inline JsonValue json_value(const char* value) {
    return JsonValue::from_string(value);
}
[[nodiscard]] inline JsonValue json_value(const bbl::js::Array<JsonValue>& value) {
    return JsonValue::from_array_reference(value);
}
template <typename T> [[nodiscard]] JsonValue json_value(const bbl::js::Array<T>& value) {
    return JsonValue::from_sequence(value);
}
template <std::size_t N> [[nodiscard]] JsonValue json_value(const Tuple<N>& value) {
    return JsonValue::from_sequence(value);
}
template <typename T> [[nodiscard]] JsonValue json_value(const std::optional<T>& value);
template <typename T> [[nodiscard]] JsonValue json_value(const Nullable<T>& value);
template <typename T> [[nodiscard]] JsonValue json_value(const Map<std::string, T>& value);
template <typename... T> [[nodiscard]] JsonValue json_value(const std::variant<T...>& value);
template <typename T> [[nodiscard]] JsonValue json_value(const Ref<T>& value) {
    return value ? JsonValue::from_native(value) : JsonValue::null_value();
}

template <typename T> [[nodiscard]] JsonValue json_value(const std::optional<T>& value) {
    return value ? json_value(*value) : JsonValue{};
}
template <typename T> [[nodiscard]] JsonValue json_value(const Nullable<T>& value) {
    return value ? json_value(*value) : JsonValue{};
}
template <typename T> [[nodiscard]] JsonValue json_value(const Map<std::string, T>& value) {
    return JsonValue::from_native(value);
}
template <typename... T> [[nodiscard]] JsonValue json_value(const std::variant<T...>& value) {
    return std::visit([](const auto& member) { return json_value(member); }, value);
}

template <typename Sequence> struct JsonTypedArray final : JsonNativeArray {
    Sequence value;
    explicit JsonTypedArray(Sequence source) : value(std::move(source)) {}
    std::size_t size() const override { return value.size(); }
    JsonValue at(std::size_t index) const override { return json_value(value[index]); }
    const void* identity() const override { return value.identity(); }
    void gc_trace(const TraceVisitor& visitor) const override { visitor(value); }
};

template <typename Sequence> JsonValue JsonValue::from_sequence(Sequence elements) {
    JsonValue value;
    value.kind_ = Kind::array;
    value.native_array_ = make_gc_shared<JsonTypedArray<Sequence>>(std::move(elements));
    return value;
}

template <typename Getter> struct JsonTupleView final : JsonNativeArray {
    mutable Getter getter;
    std::size_t length;
    JsonTupleView(Getter read, std::size_t count) : getter(std::move(read)), length(count) {}
    std::size_t size() const override { return length; }
    JsonValue at(std::size_t index) const override { return getter(index); }
    const void* identity() const override { return this; }
    void gc_trace(const TraceVisitor& visitor) const override { visitor(getter); }
};

template <typename Getter> JsonValue JsonValue::from_tuple_view(Getter getter, std::size_t length) {
    JsonValue value;
    value.kind_ = Kind::array;
    value.native_array_ = make_gc_shared<JsonTupleView<Getter>>(std::move(getter), length);
    return value;
}

template <typename T>
[[nodiscard]] JsonValue json_value_property(const Map<std::string, T>& value,
                                            std::string_view key) {
    const std::string name(key);
    return value.has(name) ? json_value(value.at(name)) : JsonValue{};
}
template <typename T>
[[nodiscard]] bbl::js::Array<std::string> json_value_keys(const Map<std::string, T>& value) {
    return map_keys(value);
}

template <typename T> struct JsonNativeBox final : JsonNativeObject {
    T value;
    explicit JsonNativeBox(T source) : value(std::move(source)) {}
    JsonValue get(std::string_view key) const override { return json_value_property(value, key); }
    bbl::js::Array<std::string> own_keys() const override { return json_value_keys(value); }
    const std::type_info& type() const override { return typeid(T); }
    const void* identity() const override {
        if constexpr (requires { value.identity(); })
            return value.identity();
        else
            return value.get();
    }
    void gc_trace(const TraceVisitor& visitor) const override { visitor(value); }
};

template <typename T> JsonValue JsonValue::from_native(T source) {
    JsonValue value;
    value.kind_ = Kind::object;
    value.native_ = make_gc_shared<JsonNativeBox<T>>(std::move(source));
    return value;
}

template <typename Getter> struct JsonRecordView final : JsonNativeObject {
    mutable Getter getter;
    bbl::js::Array<std::string> keys;
    JsonRecordView(Getter read, bbl::js::Array<std::string> names)
        : getter(std::move(read)), keys(std::move(names)) {}
    JsonValue get(std::string_view key) const override { return getter(key); }
    bbl::js::Array<std::string> own_keys() const override { return {keys.begin(), keys.end()}; }
    const std::type_info& type() const override { return typeid(JsonRecordView); }
    const void* identity() const override { return this; }
    void gc_trace(const TraceVisitor& visitor) const override {
        visitor(getter);
        visitor(keys);
    }
};

template <typename Getter>
JsonValue JsonValue::from_record_view(Getter getter, bbl::js::Array<std::string> keys) {
    JsonValue value;
    value.kind_ = Kind::object;
    value.native_ = make_gc_shared<JsonRecordView<Getter>>(std::move(getter), std::move(keys));
    return value;
}

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
    value.for_each_entry([&](const std::string& key, const JsonValue& entry) {
        if (entry.is_undefined())
            return;
        writer.key(key);
        json_write(writer, entry);
    });
    writer.end_object();
}

class JsonValueParser {
    struct Frame {
        bool object;
        std::string key;
        JsonValue::Array elements;
        JsonValue::Object entries;
    };

    std::vector<Frame> frames_;
    JsonValue result_;

    bool append(JsonValue value) {
        if (frames_.empty()) {
            result_ = std::move(value);
        } else if (Frame& frame = frames_.back(); frame.object) {
            // A repeated key replaces its value without changing its position.
            for (auto& entry : frame.entries) {
                if (entry.first == frame.key) {
                    entry.second = std::move(value);
                    return true;
                }
            }
            frame.entries.emplace_back(std::move(frame.key), std::move(value));
        } else {
            frame.elements.push_back(std::move(value));
        }
        return true;
    }

public:
    bool null() { return append(JsonValue::null_value()); }
    bool boolean(bool value) { return append(JsonValue::from_boolean(value)); }
    bool number_integer(nlohmann::json::number_integer_t value) {
        return append(JsonValue::from_number(static_cast<double>(value)));
    }
    bool number_unsigned(nlohmann::json::number_unsigned_t value) {
        return append(JsonValue::from_number(static_cast<double>(value)));
    }
    bool number_float(nlohmann::json::number_float_t value, const std::string&) {
        return append(JsonValue::from_number(value));
    }
    bool string(std::string& value) { return append(JsonValue::from_string(std::move(value))); }
    bool binary(nlohmann::json::binary_t&) {
        throw std::runtime_error("Binary values are not JSON.");
    }
    bool start_object(std::size_t) {
        frames_.push_back(Frame{true, {}, {}, {}});
        return true;
    }
    bool key(std::string& value) {
        frames_.back().key = std::move(value);
        return true;
    }
    bool end_object() {
        JsonValue value = JsonValue::from_object(std::move(frames_.back().entries));
        frames_.pop_back();
        return append(std::move(value));
    }
    bool start_array(std::size_t) {
        frames_.push_back(Frame{false, {}, {}, {}});
        return true;
    }
    bool end_array() {
        JsonValue value = JsonValue::from_array(std::move(frames_.back().elements));
        frames_.pop_back();
        return append(std::move(value));
    }
    template <typename Exception>
    bool parse_error(std::size_t, const std::string&, const Exception& error) {
        throw error;
    }
    [[nodiscard]] JsonValue take_result() { return std::move(result_); }
};

/**
 * `JSON.parse(text)`. nlohmann owns the grammar and throws on a malformed
 * document, which is the browser's SyntaxError: a surrounding `try`/`catch`
 * in the source sees it exactly where it would there.
 */
[[nodiscard]] inline JsonValue json_parse(const std::string& text) {
    JsonValueParser parser;
    nlohmann::json::sax_parse(text, &parser);
    return parser.take_result();
}

/**
 * A document's leading N elements as a fixed numeric tuple -- the lowering
 * of a `[number, number, number]` assertion over a parsed array. Each lane
 * is `Number(element)`, so a lane the document does not carry is NaN
 * rather than a read past the end.
 */
template <std::size_t N> [[nodiscard]] inline Tuple<N> json_tuple(const JsonValue& value) {
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
[[nodiscard]] inline Array<std::string> json_string_array(const JsonValue& value) {
    Array<std::string> result;
    result.reserve(value.elements().size());
    for (const JsonValue& element : value.elements()) {
        result.push_back(element.to_string());
    }
    return result;
}

} // namespace bbl::js
