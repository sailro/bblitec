import test from "node:test";
import { runRmlUiFixture } from "./native-fixture.js";

test("native selects and disclosure markers follow Chromium's box metrics and coverage", (t) =>
    runRmlUiFixture(t, "ui-form-metrics"));
