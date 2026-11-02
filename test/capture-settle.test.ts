import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    cppFunction,
    cppRecord,
    optionalNativeFixtureTools,
    runFixtureExecutable,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

test("capture settle parsing preserves general-format numbers without floating from_chars", (t) => {
    const tools = optionalNativeFixtureTools(false);
    if (!tools) return t.skip("Native fixture compiler unavailable.");
    const source = readFileSync("native/src/pal_window_realm.cpp", "utf8");
    const directory = resolve("artifacts", "capture-settle-check");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "check.cpp");
    const executable = join(directory, "check.exe");
    writeFileSync(
        file,
        `#include <bit>
#include <cassert>
#include <cerrno>
#include <charconv>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <locale.h>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>
${cppRecord(source, "struct CaptureSettle")}
${cppFunction(source, "std::optional<double> parse_capture_milliseconds(")}
std::string environment;
std::string environment_variable(const char*) { return environment; }
${cppFunction(source, "const std::optional<CaptureSettle>& capture_settle(")}
void compare(const std::string& text) {
    double expected = 0;
    const auto reference = std::from_chars(text.data(), text.data() + text.size(), expected);
    const bool accepted = reference.ec == std::errc{} && reference.ptr == text.data() + text.size();
    errno = EDOM;
    const auto actual = parse_capture_milliseconds(text);
    assert(errno == EDOM);
    if (actual.has_value() != accepted) {
        std::cerr << "acceptance mismatch: " << text << '\\n';
        std::abort();
    }
    if (accepted) {
        if (std::isnan(expected)) assert(std::isnan(*actual));
        else assert(std::bit_cast<std::uint64_t>(*actual) == std::bit_cast<std::uint64_t>(expected));
        assert((*actual < 0) == (expected < 0));
    }
}
int main(int argc, char** argv) {
    if (argc > 1) {
        environment = argv[1];
        try {
            const auto& parsed = capture_settle();
            if (!parsed) std::cout << "none";
            else std::cout << parsed->attribute << '|' << parsed->values.size() << '|' << parsed->milliseconds;
        } catch (const std::runtime_error&) { std::cout << "rejected"; }
        return 0;
    }
    const std::vector<std::string> corpus{
        "", "0", "-0", ".5", "5.", "-1.25", "1e3", "2.5E-2", "0e-9999", "0e9999",
        "4.9e-324", "1e-320", "2.4703282292062327e-324", "2.4703282292062328e-324",
        "1.7976931348623157e308", "1.7976931348623158e308", "1.7976931348623159e308",
        "1e309", "1e-9999", "-1e-9999", "inf", "INF", "infinity", "InFiNiTy", "-inf",
        "nan", "NaN", "-nan", "nan()", "nan(payload_1)", "nan(ind)", "nan(snan)",
        "nan(bad-payload)", "+1", "+inf", " 1", "\\t1", "1 ", "1\\n", "0x1p2", "-0X1",
        "1,5", "1e", "1e+", ".", "-", "--1", "1ms", std::string("1\\0x", 3)
    };
    for (const auto& text : corpus) compare(text);
    for (int index = 0; index < 2000; ++index) {
        const auto text = std::to_string(index) + "." + std::to_string(index * 17) +
            "e" + std::to_string(index % 650 - 325);
        compare(text); compare("-" + text); compare("+" + text); compare(text + "x");
    }
    // The parser's explicit C locale must not inherit a process decimal comma.
    for (const auto locale : {"de-DE", "German_Germany.1252", "de_DE.UTF-8"}) {
        if (setlocale(LC_NUMERIC, locale)) {
            compare("1.25"); compare("1,25");
            setlocale(LC_NUMERIC, "C");
            break;
        }
    }
    std::cout << "capture settle numbers match";
}
`,
    );
    runNativeFixtureCompiler(tools, [
        `/Fo:${directory}/`,
        `/Fe:${executable}`,
        file,
    ]);
    assert.equal(
        runFixtureExecutable(executable),
        "capture settle numbers match",
    );
    for (const [input, expected] of [
        ["", "none"],
        ["data-phase=idle|done;3000", "data-phase|2|3000"],
        ["data-phase=idle;2.5e2", "data-phase|1|250"],
        ["data-phase=idle;-0", "data-phase|1|-0"],
        ["data-phase=idle;+1", "rejected"],
        ["data-phase=idle; 1", "rejected"],
        ["data-phase=idle;0x10", "rejected"],
        ["data-phase=idle;1ms", "rejected"],
        ["data-phase=idle;-1", "rejected"],
        ["data-phase=idle;1e9999", "rejected"],
        ["data-phase=idle;1e-9999", "rejected"],
        ["data-phase=idle", "rejected"],
        ["data-phase;100", "rejected"],
    ]) {
        assert.equal(
            runFixtureExecutable(executable, { args: [input!] }),
            expected,
        );
    }
});
