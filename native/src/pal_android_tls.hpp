// The Android app's trust manager validates chains; curl retains DNS/IP hostname verification.
#pragma once

#include <SDL3/SDL.h>
#include <curl/curl.h>
#include <jni.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace bbl::pal {

/** Always publish a verification error, including when the platform verifier throws. */
template <typename Verify>
int android_tls_verify_result(X509_STORE_CTX* store, Verify&& verify) noexcept {
    if (!store)
        return 0;
    X509_STORE_CTX_set_error(store, X509_V_ERR_APPLICATION_VERIFICATION);
    try {
        if (verify()) {
            X509_STORE_CTX_set_error(store, X509_V_OK);
            return 1;
        }
    } catch (...) {
    }
    X509_STORE_CTX_set_error(store, X509_V_ERR_APPLICATION_VERIFICATION);
    return 0;
}

inline const char* android_tls_auth_type(const SSL* ssl) {
    // TLS 1.3 cipher suites no longer encode the certificate authentication algorithm.
    if (SSL_version(ssl) == TLS1_3_VERSION)
        return "UNKNOWN";
    // Certificate verification precedes the TLS 1.2 change-cipher-spec. The selected
    // cipher can still be pending, with no active/current cipher at this callback.
    const auto* cipher = SSL_get_pending_cipher(ssl);
    if (!cipher)
        cipher = SSL_get_current_cipher(ssl);
    if (!cipher)
        return nullptr;
    const auto auth = SSL_CIPHER_get_auth_nid(cipher);
    const auto exchange = SSL_CIPHER_get_kx_nid(cipher);
    if (auth == NID_auth_rsa) {
        if (exchange == NID_kx_rsa)
            return "RSA";
        if (exchange == NID_kx_dhe)
            return "DHE_RSA";
        if (exchange == NID_kx_ecdhe)
            return "ECDHE_RSA";
    }
    if (auth == NID_auth_ecdsa && exchange == NID_kx_ecdhe)
        return "ECDHE_ECDSA";
    return nullptr;
}

inline bool android_tls_check_chain(X509_STORE_CTX* store, std::string_view hostname) {
    auto* ssl =
        static_cast<SSL*>(X509_STORE_CTX_get_ex_data(store, SSL_get_ex_data_X509_STORE_CTX_idx()));
    if (!ssl || hostname.empty())
        return false;
    const auto* auth = android_tls_auth_type(ssl);
    auto* leaf = X509_STORE_CTX_get0_cert(store);
    if (!auth || !leaf)
        return false;
    std::vector<X509*> chain{leaf};
    const auto* untrusted = X509_STORE_CTX_get0_untrusted(store);
    for (int index = 0; index < sk_X509_num(untrusted); ++index) {
        auto* certificate = sk_X509_value(untrusted, index);
        if (!certificate)
            return false;
        if (X509_cmp(certificate, leaf) != 0)
            chain.push_back(certificate);
    }
    auto* env = static_cast<JNIEnv*>(SDL_GetAndroidJNIEnv());
    if (!env)
        return false;
    if (env->ExceptionCheck()) {
        env->ExceptionClear();
        return false;
    }
    if (env->PushLocalFrame(16) < 0) {
        env->ExceptionClear();
        return false;
    }
    struct Frame {
        JNIEnv* env;
        ~Frame() {
            // Certificate, allocation and class-loader failures must never become acceptance.
            if (env->ExceptionCheck())
                env->ExceptionClear();
            env->PopLocalFrame(nullptr);
        }
    } frame{env};
    const auto activity = static_cast<jobject>(SDL_GetAndroidActivity());
    if (!activity || env->ExceptionCheck())
        return false;
    const auto type = env->GetObjectClass(activity);
    if (!type || env->ExceptionCheck())
        return false;
    const auto method = env->GetMethodID(type, "verifyServerCertificates",
                                         "([[BLjava/lang/String;Ljava/lang/String;)V");
    if (!method || env->ExceptionCheck())
        return false;
    const auto bytes_type = env->FindClass("[B");
    if (!bytes_type || env->ExceptionCheck())
        return false;
    const auto encoded = env->NewObjectArray(static_cast<jsize>(chain.size()), bytes_type, nullptr);
    if (!encoded || env->ExceptionCheck())
        return false;
    for (std::size_t index = 0; index < chain.size(); ++index) {
        const auto length = i2d_X509(chain[index], nullptr);
        if (length <= 0)
            return false;
        std::vector<unsigned char> der(static_cast<std::size_t>(length));
        auto* cursor = der.data();
        if (i2d_X509(chain[index], &cursor) != length)
            return false;
        const auto bytes = env->NewByteArray(length);
        if (!bytes || env->ExceptionCheck())
            return false;
        env->SetByteArrayRegion(bytes, 0, length, reinterpret_cast<const jbyte*>(der.data()));
        if (env->ExceptionCheck())
            return false;
        env->SetObjectArrayElement(encoded, static_cast<jsize>(index), bytes);
        env->DeleteLocalRef(bytes);
        if (env->ExceptionCheck())
            return false;
    }
    const auto authentication = env->NewStringUTF(auth);
    if (!authentication || env->ExceptionCheck())
        return false;
    const auto host = env->NewStringUTF(std::string(hostname).c_str());
    if (!host || env->ExceptionCheck())
        return false;
    env->CallVoidMethod(activity, method, encoded, authentication, host);
    return !env->ExceptionCheck();
}

/** The SSL context (not an easy handle/transfer stack) owns the peer identity across reuse. */
struct AndroidTlsPeer {
    std::string hostname;
    bool proxy = false;
};

inline int android_tls_peer_index() {
    static const int index = SSL_CTX_get_ex_new_index(
        0, nullptr, nullptr, nullptr, +[](void*, void* value, CRYPTO_EX_DATA*, int, long, void*) {
            delete static_cast<AndroidTlsPeer*>(value);
        });
    return index;
}

inline CURLcode android_tls_context(CURL* client, void* context, void*) noexcept {
    try {
        if (!context)
            return CURLE_SSL_CERTPROBLEM;
        char* effective = nullptr;
        if (curl_easy_getinfo(client, CURLINFO_EFFECTIVE_URL, &effective) != CURLE_OK || !effective)
            return CURLE_SSL_CERTPROBLEM;
        const std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> url(curl_url(), curl_url_cleanup);
        if (!url || curl_url_set(url.get(), CURLUPART_URL, effective, 0) != CURLUE_OK)
            return CURLE_SSL_CERTPROBLEM;
        char* raw_host = nullptr;
        if (curl_url_get(url.get(), CURLUPART_HOST, &raw_host, 0) != CURLUE_OK)
            return CURLE_SSL_CERTPROBLEM;
        const std::unique_ptr<char, decltype(&curl_free)> host(raw_host, curl_free);
        if (!host || !*host)
            return CURLE_SSL_CERTPROBLEM;
        auto peer = std::make_unique<AndroidTlsPeer>();
        peer->hostname = host.get();
        long proxy = 0;
        if (curl_easy_getinfo(client, CURLINFO_USED_PROXY, &proxy) != CURLE_OK)
            return CURLE_SSL_CERTPROBLEM;
        peer->proxy = proxy != 0;
        if (peer->hostname.size() >= 2 && peer->hostname.front() == '[' &&
            peer->hostname.back() == ']')
            peer->hostname = peer->hostname.substr(1, peer->hostname.size() - 2);
        auto* ssl_context = static_cast<SSL_CTX*>(context);
        const auto index = android_tls_peer_index();
        if (index < 0)
            return CURLE_OUT_OF_MEMORY;
        if (SSL_CTX_get_ex_data(ssl_context, index))
            return CURLE_SSL_CERTPROBLEM;
        if (!SSL_CTX_set_ex_data(ssl_context, index, peer.get()))
            return CURLE_OUT_OF_MEMORY;
        SSL_CTX_set_cert_verify_callback(
            ssl_context,
            +[](X509_STORE_CTX* store, void* argument) -> int {
                return android_tls_verify_result(store, [&] {
                    const auto* state = static_cast<AndroidTlsPeer*>(argument);
                    auto* ssl = static_cast<SSL*>(
                        X509_STORE_CTX_get_ex_data(store, SSL_get_ex_data_X509_STORE_CTX_idx()));
                    if (!ssl || !state)
                        return false;
                    // Use the TLS peer's SNI for redirected/proxy connections, not the first URL.
                    const auto* sni = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
                    // Without SNI a proxy's IP cannot be inferred from the origin URL.
                    if (!sni && state->proxy)
                        return false;
                    return android_tls_check_chain(store, sni ? sni : state->hostname);
                });
            },
            peer.release());
        SSL_CTX_set_verify(ssl_context, SSL_VERIFY_PEER, nullptr);
        return CURLE_OK;
    } catch (...) {
        return CURLE_SSL_CERTPROBLEM;
    }
}

inline void configure_android_tls(CURL* client) {
    const auto* backend = curl_version_info(CURLVERSION_NOW);
    if (!backend || !backend->ssl_version ||
        !std::string_view(backend->ssl_version).starts_with("OpenSSL/"))
        throw std::runtime_error("Android TLS requires OpenSSL-backed curl.");
    if (curl_easy_setopt(client, CURLOPT_SSL_VERIFYPEER, 1L) != CURLE_OK ||
        curl_easy_setopt(client, CURLOPT_SSL_VERIFYHOST, 2L) != CURLE_OK ||
        curl_easy_setopt(client, CURLOPT_SSL_CTX_FUNCTION, android_tls_context) != CURLE_OK ||
        // A resumed TLS handshake may omit the certificate callback. New connections must
        // consult Android's current policy; ordinary verified HTTP connection reuse remains.
        curl_easy_setopt(client, CURLOPT_SSL_SESSIONID_CACHE, 0L) != CURLE_OK)
        throw std::runtime_error("Android TLS verification configuration failed.");
}
} // namespace bbl::pal
