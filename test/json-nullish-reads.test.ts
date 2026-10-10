import test from "node:test";
import {
    optionalNativeFixtureTools,
    runGeneratedProgram,
} from "./native-fixture.js";

test("document member reads reject nullish values without changing dictionary lookups", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) {
        t.skip("Native fixture compiler unavailable.");
        return;
    }
    runGeneratedProgram(
        tools,
        "json-nullish-reads/runtime",
        String.raw`
        #include <bblite/js_json.hpp>
        #include <cassert>

        int main() {
            using bbl::js::JsonValue;
            for (const auto value : {JsonValue{}, JsonValue::null_value()}) {
                int failures = 0;
                try { static_cast<void>(value.read_property("missing")); }
                catch (const bbl::js::NamedError& error) {
                    assert(error.name == "TypeError");
                    ++failures;
                }
                try { static_cast<void>(value.read_index(0)); }
                catch (const bbl::js::NamedError& error) {
                    assert(error.name == "TypeError");
                    ++failures;
                }
                assert(failures == 2);
                assert(value.get("option").is_undefined());
                assert(value.at(0).is_undefined());
            }
            const auto object = bbl::js::json_parse(R"({"key":4,"0":5})");
            assert(object.read_property("key").to_number() == 4);
            assert(object.read_index(0).to_number() == 5);
            assert(object.read_property("missing").is_undefined());
            const auto array = bbl::js::json_parse("[1,null]");
            assert(array.read_property("length").to_number() == 2);
            assert(array.read_index(0).to_number() == 1);
            assert(array.read_index(1).is_null());
            assert(array.read_index(2).is_undefined());
            assert(array.read_index(0.5).is_undefined());
            const auto string = JsonValue::from_string("ab");
            assert(string.read_property("length").to_number() == 2);
            assert(string.read_index(1).to_string() == "b");
            assert(string.read_index(2).is_undefined());
            assert(JsonValue::from_number(2).read_property("missing").is_undefined());
            assert(JsonValue::from_boolean(false).read_index(0).is_undefined());
        }
        `,
    );
});
