import test from "node:test";
import assert from "node:assert/strict";
import {
    compileApplicationFixture,
    runApplicationRmlUiFixture,
} from "./rmlui-application-fixture.js";

test("touch listeners lower every addEventListener form with Chromium's passive defaults", () => {
    const cpp = compileApplicationFixture(
        "touch-listener-forms",
        `
        const pad = document.createElement("div");
        document.body.appendChild(pad);
        let count = 0;
        const count1 = (): void => { count++; };
        pad.addEventListener("touchstart", count1, { passive: true });
        pad.addEventListener("touchmove", count1, true);
        pad.addEventListener("touchend", count1, { capture: true, once: true, passive: false });
        pad.removeEventListener("touchend", count1, { capture: true });
        const controller = new AbortController();
        pad.addEventListener("touchcancel", count1, { signal: controller.signal });
        controller.abort();
        document.addEventListener("touchstart", count1);
        window.addEventListener("touchmove", count1, { capture: false });
        document.body.addEventListener("touchmove", count1, {});
        document.addEventListener("touchend", count1);
        window.addEventListener("wheel", count1);
        pad.ontouchstart = count1;
        pad.ontouchstart = null;
    `,
    );
    const calls = cpp.match(
        /bbl::(?:on|off|set)_dom_(?:touch|pointer)(?:_handler)?\([^;]*;/g,
    );
    assert.ok(calls, cpp);
    const call = (pattern: RegExp): string => {
        const found = calls.find((each) => pattern.test(each));
        assert.ok(found, `${pattern} in ${calls.join("\n")}`);
        return found;
    };
    // Every registration lowers: none erases.
    assert.equal(
        calls.filter((each) => each.startsWith("bbl::on_dom_touch(")).length,
        8,
    );
    // The options object's passive is the listener's.
    assert.match(
        call(/on_dom_touch\(.*node\(.*"touchstart"/),
        /, false, false, v_bblite_event_option_\d+\)/,
    );
    // A boolean is capture. Left undefined, passive is Chromium's default for the
    // scrolling types, which the target decides natively: true on the Window,
    // Document, documentElement and body.
    const topLevel = /bbl::dom_top_level_target\([^;]*\)\)/;
    assert.match(
        call(/on_dom_touch\(.*node\(.*"touchmove", .*, true, false/),
        topLevel,
    );
    assert.match(call(/on_dom_touch\(.*document\(\), "touchstart"/), topLevel);
    assert.match(
        call(/on_dom_touch\(.*window\(\), "touchmove"/),
        /, v_bblite_event_option_\d+, false, bbl::dom_top_level_target\(/,
    );
    assert.match(call(/on_dom_pointer\(.*window\(\), "wheel"/), topLevel);
    assert.match(
        call(/on_dom_touch\(.*document\(\), "touchend"/),
        /, false, false, false\)/,
    );
    assert.match(
        call(/off_dom_touch\(.*"touchend"/),
        /, v_bblite_event_option_\d+\);$/,
    );
    // A signal leases the listener.
    assert.match(call(/"touchcancel"/), /, std::move\(listener_lease\)\);$/);
    assert.match(cpp, /bbl::js::add_event_listener\([^\n]*"touchcancel"/);
    assert.match(
        call(/set_dom_touch_handler\(.*"touchstart", \{\}\)/),
        /\{\}\);$/,
    );
});

test("TouchEvent lists and Touch fields read the dispatched payload", () => {
    const cpp = compileApplicationFixture(
        "touch-event-reads",
        `
        const pad = document.createElement("div");
        document.body.appendChild(pad);
        let total = 0;
        function sum(list: TouchList): number {
            let value = 0;
            for (const touch of list) value += touch.identifier + touch.pageX + touch.pageY;
            return value;
        }
        pad.addEventListener("touchmove", (event) => {
            const touch = event.changedTouches[0];
            if (touch && touch.target === pad && event.targetTouches.length <= event.touches.length)
                total += touch.clientX + touch.clientY + touch.screenX + touch.screenY + touch.force;
            for (const each of event.touches) total += each.identifier;
            total += sum(event.targetTouches) + (event.shiftKey || event.altKey ? 1 : 0);
        });
    `,
    );
    for (const list of ["Touches", "TargetTouches", "ChangedTouches"])
        assert.match(
            cpp,
            new RegExp(
                `bbl::dom_touch_list\\([^;]*\\.as<bbl::PlatformTouchEvent>\\(\\), bbl::DomTouchListKind::${list}\\)`,
            ),
        );
    assert.match(cpp, /\bbbl::js::Array<bbl::DomTouch>/);
    assert.match(
        cpp,
        /\.target != bbl::dom_target_value\(|\.target == bbl::dom_target_value\(/,
    );
    assert.match(cpp, /as<bbl::PlatformTouchEvent>\(\)\.shift_key/);
    assert.throws(
        () =>
            compileApplicationFixture(
                "touch-event-radius",
                `
                document.addEventListener("touchstart", (event) => {
                    if (event.changedTouches[0]!.radiusX > 1) throw new Error("radius");
                });
            `,
            ),
        /SDL finger events report no contact geometry or stylus state, so Touch\.radiusX is not lowered/,
    );
});

test("SDL finger events dispatch Chromium's pointer, touch and tap order natively", (t) => {
    runApplicationRmlUiFixture(
        t,
        "touch-events",
        `
        const log = document.createElement("div");
        log.id = "log";
        document.body.appendChild(log);
        const pad = document.createElement("div");
        pad.id = "pad";
        pad.style.cssText = "position:absolute;left:20px;top:20px;width:200px;height:100px";
        document.body.appendChild(pad);
        const other = document.createElement("div");
        other.id = "other";
        other.style.cssText = "position:absolute;left:300px;top:20px;width:200px;height:100px";
        document.body.appendChild(other);
        let order = "";
        function record(value: string): void { order += value; log.textContent = order; }
        function ids(list: TouchList): string {
            let text = "";
            for (const touch of list) text += String(touch.identifier);
            return text;
        }
        function where(target: EventTarget | null): string {
            return target === pad ? "p" : target === other ? "o" : "?";
        }
        function describe(event: TouchEvent): string {
            return where(event.target) + ids(event.touches) + "/" + ids(event.targetTouches) + "/" +
                ids(event.changedTouches);
        }
        function canceling(type: string): boolean { return pad.getAttribute("data-cancel") === type; }
        pad.addEventListener("pointerover", () => record("O"));
        pad.addEventListener("pointerdown", (event) => {
            record("D");
            if (canceling("pointerdown")) event.preventDefault();
        });
        pad.addEventListener("pointermove", () => record("V"));
        pad.addEventListener("pointerup", () => record("U"));
        pad.addEventListener("pointerleave", () => record("L"));
        pad.addEventListener("mouseover", () => record("o"));
        pad.addEventListener("mousemove", () => record("v"));
        pad.addEventListener("mousedown", () => record("m"));
        pad.addEventListener("mouseup", () => record("u"));
        pad.addEventListener("click", () => record("K"));
        window.addEventListener("touchstart", () => record("w"), { capture: true });
        pad.addEventListener("touchstart", (event) => {
            const touch = event.changedTouches[0]!;
            record("S" + describe(event) + "@" + String(touch.clientX) + "," + String(touch.pageY) +
                where(touch.target));
            if (event.touches !== event.touches) record("#");
            event.preventDefault();
            if (event.defaultPrevented) record("!");
        }, { passive: true });
        pad.addEventListener("touchstart", (event) => {
            if (canceling("touchstart")) event.preventDefault();
        });
        pad.addEventListener("touchmove", (event) => record("M" + describe(event)));
        pad.addEventListener("touchend", (event) => record("E" + describe(event)));
        pad.addEventListener("touchend", () => record("1"), { once: true });
        pad.addEventListener("touchcancel", (event) =>
            record("C" + describe(event) + (event.cancelable ? "!" : "")));
        const controller = new AbortController();
        pad.addEventListener("touchmove", () => record("x"), { signal: controller.signal });
        controller.abort();
        other.addEventListener("touchstart", (event) => record("S" + describe(event)));
        other.ontouchend = (event) => record("h" + describe(event));
        document.addEventListener("touchstart", (event) => {
            event.preventDefault();
            record(event.defaultPrevented ? "d!" : "d");
        });
        globalThis.close();
    `,
        { BBLITE_HAS_DOM_INPUT: 1 },
    );
});
