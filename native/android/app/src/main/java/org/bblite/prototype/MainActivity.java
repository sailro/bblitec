package org.bblite.prototype;

import org.libsdl.app.SDLActivity;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

public final class MainActivity extends SDLActivity {
    @Override protected String[] getLibraries() {
        return new String[] { "c++_shared", "SDL3", "main" };
    }

    // Runs on SDL's native thread, before the generated program starts.
    @Override protected String[] getArguments() {
        try {
            String version;
            try (BufferedReader input = new BufferedReader(new InputStreamReader(getAssets().open("payload.version"), StandardCharsets.UTF_8))) {
                version = input.readLine();
                if (version == null) throw new IOException("Missing payload identity");
            }
            File payload = new File(getFilesDir(), "payload");
            File marker = new File(payload, ".version");
            if (!marker.isFile() || !version.equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8))) {
                // The marker is committed last; an interrupted copy is retried on launch.
                removeTree(payload);
                copyAssets("payload", payload);
                Files.write(marker.toPath(), version.getBytes(StandardCharsets.UTF_8));
            }
            if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
                for (String key : new String[] { "BBLITE_RUN_ID", "BBLITE_MAX_FRAMES", "BBLITE_RUNTIME_TRACE", "BBLITE_FRAME_DELTA_MS", "BBLITE_ANIMATION_SEEK_SECONDS", "BBLITE_TEST_PASS", "BBLITE_INPUT_REPLAY", "BBLITE_CAPTURE_ENGINE_FRAME" }) {
                    String value = getIntent().getStringExtra(key);
                    if (value != null) nativeSetenv(key, value);
                }
                if (getIntent().getBooleanExtra("capture", false)) {
                    nativeSetenv("BBLITE_SCREENSHOT", new File(getFilesDir(), "capture.png").getAbsolutePath());
                    nativeSetenv("BBLITE_SCREENSHOT_FRAME", getIntent().getStringExtra("captureFrame") == null ? "5" : getIntent().getStringExtra("captureFrame"));
                }
            }
            return new String[0];
        } catch (IOException error) {
            throw new IllegalStateException("Unable to prepare the packaged scene", error);
        }
    }

    private void copyAssets(String asset, File output) throws IOException {
        String[] children = getAssets().list(asset);
        if (children != null && children.length > 0) {
            Files.createDirectories(output.toPath());
            for (String child : children) copyAssets(asset + "/" + child, new File(output, child));
        } else {
            Files.createDirectories(output.getParentFile().toPath());
            try (InputStream input = getAssets().open(asset)) {
                Files.copy(input, output.toPath(), StandardCopyOption.REPLACE_EXISTING);
            }
        }
    }

    private void removeTree(File file) throws IOException {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) removeTree(child);
        Files.deleteIfExists(file.toPath());
    }
}
