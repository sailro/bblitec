import { execFileSync, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import {
    optionalNativeFixtureTools,
    runNativeFixtureCompiler,
} from "./native-fixture.js";

const java = spawnSync("java", ["-XshowSettings:properties", "-version"], {
    encoding: "utf8",
    windowsHide: true,
});
const javaHome =
    java.status === 0
        ? /java\.home = (.+)/.exec(java.stderr)?.[1]?.trim()
        : undefined;

test("Android motion preference follows the current animator setting and propagates access errors", (t) => {
    if (
        !javaHome ||
        !existsSync(
            join(
                javaHome,
                "bin",
                process.platform === "win32" ? "javac.exe" : "javac",
            ),
        )
    ) {
        t.skip("A JDK is required.");
        return;
    }
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/android-motion-java-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const resolver = join(directory, "ContentResolver.java");
    const settings = join(directory, "Settings.java");
    const fixture = join(directory, "MotionPreferenceCheck.java");
    writeFileSync(
        resolver,
        `package android.content;
public final class ContentResolver { public Float scale; public boolean denied; }
`,
    );
    writeFileSync(
        settings,
        `package android.provider;
import android.content.ContentResolver;
public final class Settings {
    public static final class Global {
        public static final String ANIMATOR_DURATION_SCALE = "animator_duration_scale";
        public static float getFloat(ContentResolver resolver, String key, float defaultValue) {
            if (!key.equals(ANIMATOR_DURATION_SCALE) || defaultValue != 1f) throw new AssertionError("Wrong system preference or default");
            if (resolver.denied) throw new SecurityException("Denied");
            return resolver.scale == null ? defaultValue : resolver.scale;
        }
    }
}
`,
    );
    writeFileSync(
        fixture,
        `package org.bblite.prototype;
import android.content.ContentResolver;
public final class MotionPreferenceCheck {
    public static void main(String[] args) {
        ContentResolver resolver = new ContentResolver();
        if (MotionPreferences.reducedMotion(resolver)) throw new AssertionError("Absent setting must retain the system default");
        for (float scale : new float[] {1f, 0f, .5f, 2f, 0f, 1f}) {
            resolver.scale = scale;
            if (MotionPreferences.reducedMotion(resolver) != (scale == 0f)) throw new AssertionError("Changed setting not observed");
            if (resolver.scale != scale) throw new AssertionError("Setting was changed");
        }
        resolver.denied = true;
        try { MotionPreferences.reducedMotion(resolver); throw new AssertionError("Access error was hidden"); }
        catch (SecurityException expected) {}
    }
}
`,
    );
    execFileSync(
        join(javaHome, "bin", "javac"),
        [
            "-Xlint:all",
            "-Werror",
            "-d",
            directory,
            resolver,
            settings,
            "native/android/app/src/main/java/org/bblite/prototype/MotionPreferences.java",
            fixture,
        ],
        { windowsHide: true },
    );
    execFileSync(
        join(javaHome, "bin", "java"),
        ["-cp", directory, "org.bblite.prototype.MotionPreferenceCheck"],
        { windowsHide: true },
    );
});

test("Android motion JNI polls live state, cleans references and refuses failed reads without caching them", (t) => {
    const native = optionalNativeFixtureTools(false);
    if (!native || !javaHome || !existsSync(join(javaHome, "include/jni.h"))) {
        t.skip("A Windows native compiler and JDK headers are required.");
        return;
    }
    mkdirSync("artifacts", { recursive: true });
    const directory = mkdtempSync(resolve("artifacts/android-motion-jni-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    mkdirSync(join(directory, "SDL3"));
    writeFileSync(
        join(directory, "SDL3/SDL_system.h"),
        "#pragma once\nvoid* SDL_GetAndroidJNIEnv();\nvoid* SDL_GetAndroidActivity();\n",
    );
    const executable = join(directory, "check.exe");
    runNativeFixtureCompiler(native, [
        "/D__ANDROID__=1",
        `/I${directory}`,
        `/I${resolve("native/src")}`,
        `/external:I${join(javaHome, "include")}`,
        `/external:I${join(javaHome, "include/win32")}`,
        "test/fixtures/android-motion-preference-check.cpp",
        `/Fo${directory}/`,
        `/Fe${executable}`,
    ]);
    execFileSync(executable, { windowsHide: true, timeout: 10000 });
});
