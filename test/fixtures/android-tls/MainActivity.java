package org.bblite.prototype;

import org.libsdl.app.SDLActivity;

/** Isolated test APK: production trust owner, no system certificate-store changes. */
public final class MainActivity extends SDLActivity {
    @Override protected String[] getLibraries() {
        return new String[] { "c++_shared", "SDL3", "main" };
    }

    @Override protected String[] getArguments() {
        return new String[] { getIntent().getStringExtra("runId"), getIntent().getStringExtra("mode"),
                getIntent().getStringExtra("redirectBase") };
    }

    public void verifyServerCertificates(byte[][] chain, String authType, String hostname)
            throws java.security.cert.CertificateException {
        android.util.Log.i("bblite-tls", "verify host=" + hostname
                + " run=" + getIntent().getStringExtra("runId"));
        try {
            AndroidTlsTrust.checkServerTrusted(chain, authType, hostname);
        } catch (java.security.cert.CertificateException error) {
            android.util.Log.i("bblite-tls", "rejected host=" + hostname + " reason=" + error
                    + " run=" + getIntent().getStringExtra("runId"));
            throw error;
        }
    }
}
