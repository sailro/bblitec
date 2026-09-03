// A standalone check of the JSON bridge and the Web Storage PAL, compiled
// and run by `test/json-storage.test.ts` when a toolchain is available.
//
// The record and its codec are written the way `DataTypeRegistry` emits
// them -- forward declarations, then definitions, inside `bblscene`, found
// from the generic writer by argument-dependent lookup. If the emission
// shape ever stops compiling, this file stops compiling with it.
//
// Storage is exercised against `BBLITE_LOCAL_STORAGE_ROOT`, so the run
// never touches the user's own preference directory.

#include <bblite/js_json.hpp>
#include <bblite/js_storage.hpp>
#include <bblite/pal.hpp>

#include <cmath>
#include <exception>
#include <iostream>
#include <limits>
#include <optional>
#include <string>
#include <string_view>

namespace bblscene {

struct WorldPartDataData {
    bbl::js::Tuple<3> s;
    bbl::js::Tuple<3> p;
    bbl::js::Tuple<4> q;
    bbl::js::Tuple<3> c;
    bbl::js::Nullable<double> sh;
};

using WorldPartData = bbl::js::Ref<WorldPartDataData>;

struct WorldJson {
    double version;
    bbl::js::Array<WorldPartData> parts;
};

inline void json_write(bbl::js::JsonWriter& writer, const WorldJson& value);
inline void json_write(
    bbl::js::JsonWriter& writer,
    const WorldPartDataData& value);

inline void json_write(bbl::js::JsonWriter& writer, const WorldJson& value) {
    writer.begin_object();
    writer.key("version");
    json_write(writer, value.version);
    writer.key("parts");
    json_write(writer, value.parts);
    writer.end_object();
}

inline void json_write(
    bbl::js::JsonWriter& writer,
    const WorldPartDataData& value) {
    writer.begin_object();
    writer.key("s");
    json_write(writer, value.s);
    writer.key("p");
    json_write(writer, value.p);
    writer.key("q");
    json_write(writer, value.q);
    writer.key("c");
    json_write(writer, value.c);
    if (value.sh.has_value()) {
        writer.key("sh");
        json_write(writer, *value.sh);
    }
    writer.end_object();
}

} // namespace bblscene

namespace {

int failures = 0;

void check(bool condition, const std::string& what) {
    if (condition) return;
    ++failures;
    std::cout << "FAIL " << what << '\n';
}

void check_equal(
    const std::string& actual,
    const std::string& expected,
    const std::string& what) {
    if (actual == expected) return;
    ++failures;
    std::cout << "FAIL " << what << "\n  expected: " << expected
              << "\n  actual:   " << actual << '\n';
}

bblscene::WorldJson sample_world() {
    bblscene::WorldJson world{1.0, {}};
    world.parts.push_back(
        bbl::js::make_ref<bblscene::WorldPartDataData>(
            bblscene::WorldPartDataData{
                bbl::js::Tuple<3>{1.0, 2.0, 3.0},
                bbl::js::Tuple<3>{4.0, 5.0, 6.0},
                bbl::js::Tuple<4>{0.0, 0.0, 0.0, 1.0},
                bbl::js::Tuple<3>{1.0, 1.0, 1.0},
                bbl::js::Nullable<double>{}}));
    world.parts.push_back(
        bbl::js::make_ref<bblscene::WorldPartDataData>(
            bblscene::WorldPartDataData{
                bbl::js::Tuple<3>{2.0, 2.0, 2.0},
                bbl::js::Tuple<3>{0.0, 1.5, 0.0},
                bbl::js::Tuple<4>{0.0, 0.0, 0.0, 1.0},
                bbl::js::Tuple<3>{0.5, 0.25, 0.0},
                bbl::js::Nullable<double>{1.0}}));
    return world;
}

void check_stringify() {
    const bblscene::WorldJson world = sample_world();
    check_equal(
        bbl::js::json_stringify(world),
        "{\"version\":1,\"parts\":["
        "{\"s\":[1,2,3],\"p\":[4,5,6],\"q\":[0,0,0,1],\"c\":[1,1,1]},"
        "{\"s\":[2,2,2],\"p\":[0,1.5,0],\"q\":[0,0,0,1],"
        "\"c\":[0.5,0.25,0],\"sh\":1}]}",
        "compact document, declaration key order, absent optional omitted");

    bblscene::WorldJson single{1.0, {}};
    single.parts.push_back(
        bbl::js::make_ref<bblscene::WorldPartDataData>(
            bblscene::WorldPartDataData{
                bbl::js::Tuple<3>{1.0, 1.0, 1.0},
                bbl::js::Tuple<3>{0.0, 0.0, 0.0},
                bbl::js::Tuple<4>{0.0, 0.0, 0.0, 1.0},
                bbl::js::Tuple<3>{1.0, 0.0, 0.0},
                bbl::js::Nullable<double>{}}));
    check_equal(
        bbl::js::json_stringify(single, 2),
        "{\n"
        "  \"version\": 1,\n"
        "  \"parts\": [\n"
        "    {\n"
        "      \"s\": [\n"
        "        1,\n"
        "        1,\n"
        "        1\n"
        "      ],\n"
        "      \"p\": [\n"
        "        0,\n"
        "        0,\n"
        "        0\n"
        "      ],\n"
        "      \"q\": [\n"
        "        0,\n"
        "        0,\n"
        "        0,\n"
        "        1\n"
        "      ],\n"
        "      \"c\": [\n"
        "        1,\n"
        "        0,\n"
        "        0\n"
        "      ]\n"
        "    }\n"
        "  ]\n"
        "}",
        "pretty document at two spaces");

    check_equal(
        bbl::js::json_stringify(std::string("a\"b\\c\nd\te\x01")),
        "\"a\\\"b\\\\c\\nd\\te\\u0001\"",
        "string escaping");
    check_equal(
        bbl::js::json_stringify(
            std::numeric_limits<double>::quiet_NaN()),
        "null",
        "NaN writes as null");
    check_equal(
        bbl::js::json_stringify(
            std::numeric_limits<double>::infinity()),
        "null",
        "Infinity writes as null");
    check_equal(bbl::js::json_stringify(true), "true", "boolean");
    check_equal(
        bbl::js::json_stringify(bbl::js::Array<double>{}),
        "[]",
        "empty array");
    check_equal(
        bbl::js::json_stringify(bbl::js::Array<double>{}, 2),
        "[]",
        "empty array stays flat when pretty");
    bbl::js::Array<bbl::js::Nullable<double>> holes;
    holes.push_back(bbl::js::Nullable<double>{});
    holes.push_back(bbl::js::Nullable<double>{4.0});
    check_equal(
        bbl::js::json_stringify(holes),
        "[null,4]",
        "an absent array slot is null, as JavaScript writes undefined");
    bbl::js::Map<std::string, double> record;
    record.set("z", 1.0);
    record.set("a", 2.0);
    check_equal(
        bbl::js::json_stringify(record),
        "{\"z\":1,\"a\":2}",
        "record keys keep insertion order rather than sorting");
}

void check_parse() {
    const bbl::js::JsonValue document =
        bbl::js::json_parse("{\"version\":1,\"parts\":[{\"s\":[1,2,3]}]}");
    check(document.is_object(), "parsed object");
    check(document.truthy(), "an object is truthy");
    check(document.get("version").strict_equals(1.0), "version reads 1");
    check(
        !document.get("version").strict_equals(std::string_view("1")),
        "strict equality does not coerce");
    check(document.get("parts").is_array(), "parts is an array");
    check(document.get("parts").length() == 1.0, "parts has one entry");
    check(
        document.get("missing").is_undefined(),
        "a missing property reads undefined");
    check(
        !document.get("missing").truthy(),
        "a missing property is falsy");
    check(
        document.get("missing").type_of() == "undefined",
        "typeof a missing property");
    check(
        document.get("parts").at(0.0).get("s").at(1.0).strict_equals(2.0),
        "nested index");
    check(
        document.get("parts").at(9.0).is_undefined(),
        "an index past the end reads undefined");
    check(
        document.get("parts").at(0.0).get("s").every(
            [](const bbl::js::JsonValue& element) {
                return element.is_number();
            }),
        "every over an array of numbers");
    check(bbl::js::json_parse("null").is_null(), "a null document");
    check(
        !bbl::js::json_parse("null").truthy(),
        "a null document is falsy");
    check(
        bbl::js::json_parse("\"\"").type_of() == "string" &&
            !bbl::js::json_parse("\"\"").truthy(),
        "an empty string is falsy");
    check(
        bbl::js::json_parse("0").type_of() == "number" &&
            !bbl::js::json_parse("0").truthy(),
        "zero is falsy");
    // A wrong-shaped document fails its guards rather than the program.
    const bbl::js::JsonValue wrong = bbl::js::json_parse("{\"parts\":7}");
    check(
        !wrong.get("parts").is_array(),
        "a wrong-typed field is not an array");
    check(
        !wrong.get("version").strict_equals(1.0),
        "a missing version fails the version guard");
    check(
        std::isnan(wrong.get("version").to_number()),
        "a missing number coerces to NaN");
    bool threw = false;
    try {
        static_cast<void>(bbl::js::json_parse("{ not json"));
    } catch (const std::exception&) {
        threw = true;
    }
    check(threw, "a malformed document throws where the browser does");
    check_equal(
        bbl::js::json_stringify(
            bbl::js::json_parse("{\"z\":1,\"a\":[true,null]}")),
        "{\"z\":1,\"a\":[true,null]}",
        "a parsed document round-trips with its own key order");
}

void check_storage() {
    const std::string key = "sandblox-world";
    bbl::pal::remove_local_storage(key);
    check(
        !bbl::pal::read_local_storage(key).has_value(),
        "an unset key reads as absent");
    // Removing a key that was never set is not a failure.
    bbl::pal::remove_local_storage(key);
    bbl::pal::write_local_storage(key, "{\"version\":1}");
    const auto stored = bbl::pal::read_local_storage(key);
    check(stored.has_value(), "a written key reads back");
    check_equal(
        stored.value_or(""),
        "{\"version\":1}",
        "the stored value round-trips");
    bbl::pal::write_local_storage(key, "");
    const auto empty = bbl::pal::read_local_storage(key);
    check(
        empty.has_value() && empty->empty(),
        "an empty value is present, not absent");
    const auto js_empty = bbl::js::local_storage_get_item(key);
    check(
        js_empty.has_value() && js_empty.value().empty(),
        "the JavaScript shape carries the empty value too");
    bbl::pal::remove_local_storage(key);
    check(
        !bbl::js::local_storage_get_item(key).has_value(),
        "a removed key reads as absent");
    // Two keys a naive file name would collapse onto one.
    bbl::pal::write_local_storage("a/b", "slash");
    bbl::pal::write_local_storage("a_b", "underscore");
    check_equal(
        bbl::pal::read_local_storage("a/b").value_or(""),
        "slash",
        "an encoded key does not collide with its literal neighbour");
    check_equal(
        bbl::pal::read_local_storage("a_b").value_or(""),
        "underscore",
        "the literal neighbour is its own entry");
    // A traversal attempt is data, not a path.
    bbl::pal::write_local_storage("../escape", "contained");
    check_equal(
        bbl::pal::read_local_storage("../escape").value_or(""),
        "contained",
        "a traversal-shaped key stays inside the root");
    check(
        !bbl::pal::read_local_storage("..\\escape").has_value(),
        "the other separator is a different key");
    bbl::pal::write_local_storage("", "empty key");
    check_equal(
        bbl::pal::read_local_storage("").value_or(""),
        "empty key",
        "the empty key is storable");
    const std::string unicode = "cl\xc3\xa9-\xe4\xb8\x96";
    bbl::pal::write_local_storage(unicode, "unicode");
    check_equal(
        bbl::pal::read_local_storage(unicode).value_or(""),
        "unicode",
        "a non-ASCII key round-trips");
    bool refused = false;
    try {
        bbl::pal::write_local_storage(std::string(4096, 'k'), "too long");
    } catch (const std::exception&) {
        refused = true;
    }
    check(refused, "a key too long to store refuses by name");
}

} // namespace

int main() {
    try {
        check_stringify();
        check_parse();
        check_storage();
    } catch (const std::exception& error) {
        std::cout << "FAIL unexpected exception: " << error.what() << '\n';
        ++failures;
    }
    if (failures == 0) {
        std::cout << "js-json-storage-check: ok\n";
        return 0;
    }
    std::cout << "js-json-storage-check: " << failures << " failure(s)\n";
    return 1;
}
