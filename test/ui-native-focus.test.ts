import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("native focus selects the control leaf and preserves range keyboard edits", (t) => {
    runRmlUiFixture(t, "ui-native-focus");
});

test("an SVG root holds native focus for its shapes: Tab order, keys, presses and focus rules", (t) => {
    runRmlUiFixture(t, "ui-svg-focus", {
        macros: {
            BBLITE_HAS_DOM_INPUT: 1,
            BBLITE_WORKERS: 1,
            BBLITE_OFFSCREEN_SURFACES: 1,
            BBLITE_UI_INLINE_SVG: 1,
        },
    });
});
