#include "pal_android_tls.hpp"

#include <android/log.h>
#include <array>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>

extern "C" __attribute__((visibility("default"))) int SDL_main(int argc, char** argv) {
    const char* run = argc > 1 ? argv[1] : "missing";
    const bool restricted = argc > 2 && std::string_view(argv[2]) == "restricted";
    int failures = 0;
    try {
        if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK)
            throw std::runtime_error("curl initialization failed");
        if (argc < 4)
            throw std::runtime_error("Missing isolated redirect fixture address");
        const std::string redirect_trusted = std::string(argv[3]) + "/trusted";
        const std::string redirect_wrong_host = std::string(argv[3]) + "/wrong-host";
        __android_log_print(ANDROID_LOG_INFO, "bblite-tls", "backend=%s run=%s",
                            curl_version_info(CURLVERSION_NOW)->ssl_version, run);
        const std::unique_ptr<CURLSH, decltype(&curl_share_cleanup)> share(curl_share_init(),
                                                                           curl_share_cleanup);
        if (!share ||
            curl_share_setopt(share.get(), CURLSHOPT_SHARE, CURL_LOCK_DATA_CONNECT) != CURLSHE_OK)
            throw std::runtime_error("curl connection sharing failed");
        struct Case {
            const char* name;
            const char* url;
            CURLcode expected;
            bool reused;
        };
        const auto* trusted_url = restricted
                                      ? "https://badssl.com/"
                                      : "https://assets.babylonjs.com/splats/Trogir/lod-meta.json";
        const std::array cases{
            Case{"trusted", trusted_url, CURLE_OK, false},
            Case{"trusted-reuse", trusted_url, CURLE_OK, true},
            Case{"untrusted", "https://self-signed.badssl.com/", CURLE_PEER_FAILED_VERIFICATION,
                 false},
            Case{"expired", "https://expired.badssl.com/", CURLE_PEER_FAILED_VERIFICATION, false},
            Case{"wrong-host", "https://wrong.host.badssl.com/", CURLE_PEER_FAILED_VERIFICATION,
                 false},
            Case{"redirect-trusted", redirect_trusted.c_str(),
                 restricted ? CURLE_PEER_FAILED_VERIFICATION : CURLE_OK, false},
            Case{"redirect-wrong-host", redirect_wrong_host.c_str(), CURLE_PEER_FAILED_VERIFICATION,
                 false},
            Case{"trusted-after-rejection", trusted_url, CURLE_OK, true},
        };
        for (const auto& item : cases) {
            std::array<char, CURL_ERROR_SIZE> error{};
            const std::unique_ptr<CURL, decltype(&curl_easy_cleanup)> client(curl_easy_init(),
                                                                             curl_easy_cleanup);
            if (!client)
                throw std::runtime_error("curl allocation failed");
            const auto option = [&](CURLoption name, auto value) {
                if (curl_easy_setopt(client.get(), name, value) != CURLE_OK)
                    throw std::runtime_error("curl option failed");
            };
            bbl::pal::configure_android_tls(client.get());
            option(CURLOPT_SHARE, share.get());
            option(CURLOPT_URL, item.url);
            option(CURLOPT_ERRORBUFFER, error.data());
            option(CURLOPT_PROTOCOLS_STR, "http,https");
            option(CURLOPT_REDIR_PROTOCOLS_STR, "https");
            option(CURLOPT_FOLLOWLOCATION, 1L);
            option(CURLOPT_MAXREDIRS, 5L);
            option(CURLOPT_CONNECTTIMEOUT_MS, 10000L);
            option(CURLOPT_TIMEOUT_MS, 25000L);
            option(CURLOPT_NOSIGNAL, 1L);
            option(
                CURLOPT_WRITEFUNCTION,
                +[](char*, std::size_t size, std::size_t count, void*) { return size * count; });
            const auto result = curl_easy_perform(client.get());
            long connections = -1;
            long redirects = 0;
            long status = 0;
            if (curl_easy_getinfo(client.get(), CURLINFO_NUM_CONNECTS, &connections) != CURLE_OK ||
                curl_easy_getinfo(client.get(), CURLINFO_REDIRECT_COUNT, &redirects) != CURLE_OK ||
                curl_easy_getinfo(client.get(), CURLINFO_RESPONSE_CODE, &status) != CURLE_OK)
                throw std::runtime_error("curl result unavailable");
            const bool redirect_case = std::string_view(item.name).starts_with("redirect-");
            const bool passed = result == item.expected && (!item.reused || connections == 0) &&
                                (!redirect_case || redirects > 0) &&
                                (result != CURLE_OK || status == 200);
            failures += !passed;
            __android_log_print(ANDROID_LOG_INFO, "bblite-tls",
                                "case=%s passed=%d result=%d connects=%ld redirects=%ld http=%ld "
                                "error=%s run=%s",
                                item.name, passed ? 1 : 0, static_cast<int>(result), connections,
                                redirects, status, error.data(), run);
        }
    } catch (const std::exception& error) {
        ++failures;
        __android_log_print(ANDROID_LOG_ERROR, "bblite-tls", "failure=%s run=%s", error.what(),
                            run);
    }
    __android_log_print(ANDROID_LOG_INFO, "bblite-tls", "TLS_TEST_EXIT=%d run=%s", failures ? 1 : 0,
                        run);
    return failures ? 1 : 0;
}
