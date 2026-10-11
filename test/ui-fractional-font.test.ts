import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("fractional UI fonts retain CSS sizes, pixels and live handles with bounded caches", (t) => {
    runRmlUiFixture(t, "ui-fractional-font");
});

test("fractional UI fonts contribute their actual width to intrinsic layouts", (t) => {
    runRmlUiFixture(t, "ui-fractional-layout");
});
