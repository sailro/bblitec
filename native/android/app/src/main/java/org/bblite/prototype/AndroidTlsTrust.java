package org.bblite.prototype;

import android.net.http.X509TrustManagerExtensions;
import java.io.ByteArrayInputStream;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/** Android owns the app's trust anchors and hostname-specific network security policy. */
public final class AndroidTlsTrust {
    private AndroidTlsTrust() {}

    private static final class DefaultTrust {
        static final X509TrustManagerExtensions INSTANCE = create();

        private static X509TrustManagerExtensions create() {
            try {
                TrustManagerFactory factory =
                    TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
                factory.init((KeyStore) null);
                for (TrustManager manager : factory.getTrustManagers()) {
                    if (manager instanceof X509TrustManager)
                        return new X509TrustManagerExtensions((X509TrustManager) manager);
                }
                throw new GeneralSecurityException("Android X509 trust manager unavailable");
            } catch (GeneralSecurityException error) {
                throw new IllegalStateException("Android TLS trust initialization failed", error);
            }
        }
    }

    public static void checkServerTrusted(byte[][] encoded, String authType, String hostname)
            throws CertificateException {
        if (encoded == null || encoded.length == 0 || authType == null || authType.isEmpty()
                || hostname == null || hostname.isEmpty())
            throw new CertificateException("Incomplete TLS peer identity");
        CertificateFactory factory = CertificateFactory.getInstance("X.509");
        X509Certificate[] chain = new X509Certificate[encoded.length];
        for (int index = 0; index < encoded.length; ++index) {
            if (encoded[index] == null || encoded[index].length == 0)
                throw new CertificateException("Empty TLS certificate");
            ByteArrayInputStream input = new ByteArrayInputStream(encoded[index]);
            chain[index] = (X509Certificate) factory.generateCertificate(input);
            if (input.available() != 0)
                throw new CertificateException("Trailing TLS certificate bytes");
        }
        // This overload applies the platform's per-host trust/pinning policy. curl separately
        // verifies the certificate's DNS/IP identity; no trust anchors are exported or replaced.
        if (DefaultTrust.INSTANCE.checkServerTrusted(chain, authType, hostname).isEmpty())
            throw new CertificateException("Android returned no verified TLS chain");
    }
}
