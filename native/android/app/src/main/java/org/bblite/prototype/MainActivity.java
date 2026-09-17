package org.bblite.prototype;

import org.libsdl.app.SDLActivity;
import org.libsdl.app.SDLSurface;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.window.OnBackInvokedDispatcher;
import android.view.SurfaceHolder;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.widget.RelativeLayout;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;

public final class MainActivity extends SDLActivity {
    private CappedSurface surface;

    public int[] rasterizeEmoji(byte[] utf8, String path, int index, int size, float spacing) {
        return EmojiRaster.render(utf8, path, index, size, spacing);
    }

    public int[] measureEmoji(byte[] utf8, String path, int index, int size, float spacing) {
        return EmojiRaster.measure(utf8, path, index, size, spacing);
    }

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33)
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::finish);
    }

    @Override public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) finish();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller != null) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.systemBars());
            }
        }
    }

    @Override protected SDLSurface createSDLSurface(Context context) {
        surface = new CappedSurface(context);
        surface.setLayoutParams(new RelativeLayout.LayoutParams(-1, -1));
        return surface;
    }

    // Called on SDL's native thread before creating the Vulkan window.
    public boolean configureSurface(double cap) {
        boolean debug = (getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        double selectedCap = debug && (getIntent().getBooleanExtra("capture", false) || getIntent().getBooleanExtra("nativeResolution", false))
            ? Double.POSITIVE_INFINITY : cap;
        CountDownLatch ready = new CountDownLatch(1);
        runOnUiThread(() -> {
            surface.cap = selectedCap;
            surface.trace = "1".equals(getIntent().getStringExtra("BBLITE_RUNTIME_TRACE"));
            surface.ready = ready;
            surface.resizeBuffer();
        });
        try { return ready.await(10, TimeUnit.SECONDS); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); return false; }
    }

    private static final class CappedSurface extends SDLSurface {
        double cap = Double.POSITIVE_INFINITY;
        CountDownLatch ready;
        boolean trace;
        CappedSurface(Context context) { super(context); }
        @Override protected void onSizeChanged(int width, int height, int oldWidth, int oldHeight) {
            super.onSizeChanged(width, height, oldWidth, oldHeight);
            resizeBuffer();
        }
        void resizeBuffer() {
            if (getWidth() <= 0 || getHeight() <= 0) return;
            double density = getResources().getDisplayMetrics().densityDpi / 160.0;
            double scale = Math.min(density, cap) / density;
            int width = Math.max(1, (int)(getWidth() * scale));
            int height = Math.max(1, (int)(getHeight() * scale));
            if (getHolder().getSurfaceFrame().width() == width && getHolder().getSurfaceFrame().height() == height) {
                if (ready != null) ready.countDown();
            } else getHolder().setFixedSize(width, height);
        }
        @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
            super.surfaceChanged(holder, format, width, height);
            // SDL normalizes fingers using these fields; touch coordinates use view pixels.
            mWidth = getWidth();
            mHeight = getHeight();
            if (trace) android.util.Log.i("bblite", "Android surface view=" + getWidth() + "x" + getHeight() + " buffer=" + width + "x" + height + " cap=" + cap);
            if (ready != null) ready.countDown();
        }
    }

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
                for (String key : new String[] { "BBLITE_RUN_ID", "BBLITE_MAX_FRAMES", "BBLITE_RUNTIME_TRACE", "BBLITE_FRAME_DELTA_MS", "BBLITE_ANIMATION_SEEK_SECONDS", "BBLITE_TEST_PASS", "BBLITE_INPUT_REPLAY", "BBLITE_CAPTURE_ENGINE_FRAME", "BBLITE_CAPTURE_UI", "BBLITE_GPU_DEBUG", "BBLITE_MSAA" }) {
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
