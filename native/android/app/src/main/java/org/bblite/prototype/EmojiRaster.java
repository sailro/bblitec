package org.bblite.prototype;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.Typeface;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

// Android's text renderer handles the system font's COLRv1 paint graph.
final class EmojiRaster {
    private static final Map<String, Map<Integer, Typeface>> typefaces = new HashMap<>();

    private static synchronized Typeface typeface(String path, int index) {
        return typefaces.computeIfAbsent(path, key -> new HashMap<>())
            .computeIfAbsent(index, key -> new Typeface.Builder(path).setTtcIndex(index).build());
    }

    private static Paint paint(String path, int index, int size, float spacing) {
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.SUBPIXEL_TEXT_FLAG);
        paint.setTypeface(typeface(path, index));
        paint.setTextSize(size);
        paint.setLetterSpacing(spacing / size);
        paint.setColor(0xffffffff);
        return paint;
    }

    static int[] measure(byte[] utf8, String path, int index, int size, float spacing) {
        String text = new String(utf8, StandardCharsets.UTF_8);
        return new int[] { Math.round(paint(path, index, size, spacing).measureText(text)) };
    }

    static int[] render(byte[] utf8, String path, int index, int size, float spacing) {
        String text = new String(utf8, StandardCharsets.UTF_8);
        Paint paint = paint(path, index, size, spacing);
        Rect bounds = new Rect();
        paint.getTextBounds(text, 0, text.length(), bounds);
        int width = Math.max(1, bounds.width()), height = Math.max(1, bounds.height());
        Bitmap bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888);
        new Canvas(bitmap).drawText(text, -bounds.left, -bounds.top, paint);
        int[] result = new int[5 + width * height];
        result[0] = Math.round(paint.measureText(text));
        result[1] = bounds.left;
        result[2] = bounds.top;
        result[3] = width;
        result[4] = height;
        bitmap.getPixels(result, 5, width, 0, 0, width, height);
        bitmap.recycle();
        return result;
    }
}
