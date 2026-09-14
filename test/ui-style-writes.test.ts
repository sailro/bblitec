import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("live style writes preserve declaration order, shorthand resets and empty-value removal", t => {
    runRmlUiFixture(t, "ui-style-writes");
});
