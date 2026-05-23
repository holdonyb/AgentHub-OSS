package xin.ifix.agenthub;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import java.util.Locale;

final class AgentHubServerConfig {
    static final String PREFS_NAME = "agenthub-notifications";
    static final String PREF_SERVER_URL = "server_url";

    private AgentHubServerConfig() {}

    static String loadServerUrl(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        return normalizeServerUrl(prefs.getString(PREF_SERVER_URL, null));
    }

    static String saveServerUrl(Context context, String value) {
        String normalized = normalizeServerUrl(value);
        if (normalized == null) throw new IllegalArgumentException("invalid-server-url");
        validateServerUrl(normalized);
        context
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString(PREF_SERVER_URL, normalized)
            .apply();
        return normalized;
    }

    static void clearServerUrl(Context context) {
        context
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .remove(PREF_SERVER_URL)
            .apply();
    }

    static void validateServerUrl(String normalizedUrl) {
        Uri uri = Uri.parse(normalizedUrl);
        String scheme = safeLower(uri.getScheme());
        String host = safeLower(uri.getHost());
        if (host.isEmpty()) throw new IllegalArgumentException("请填写完整的 AgentHub 地址");
        if ("https".equals(scheme)) return;
        if (!"http".equals(scheme)) {
            throw new IllegalArgumentException("地址必须以 http:// 或 https:// 开头");
        }
        if (!isAllowedInsecureHost(host)) {
            throw new IllegalArgumentException("公网地址必须使用 HTTPS；只有 localhost、局域网或 Tailscale 地址允许 HTTP");
        }
    }

    static String normalizeServerUrl(String value) {
        if (value == null) return null;
        String raw = value.trim();
        if (raw.isEmpty()) return null;
        try {
            Uri uri = Uri.parse(raw);
            String scheme = safeLower(uri.getScheme());
            String host = uri.getHost();
            if (host == null || host.trim().isEmpty()) return null;
            if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
            Uri.Builder builder = uri.buildUpon();
            builder.scheme(scheme);
            builder.encodedPath("");
            builder.clearQuery();
            builder.fragment(null);
            String normalized = builder.build().toString().replaceAll("/+$", "");
            return normalized;
        } catch (Exception error) {
            return null;
        }
    }

    private static String safeLower(String value) {
        return value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
    }

    private static boolean isAllowedInsecureHost(String host) {
        if ("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host)) return true;
        if (!host.matches("^\\d+\\.\\d+\\.\\d+\\.\\d+$")) return false;
        String[] octets = host.split("\\.");
        int a = parseOctet(octets, 0);
        int b = parseOctet(octets, 1);
        if (a < 0 || b < 0) return false;
        if (a == 10) return true;
        if (a == 127) return true;
        if (a == 192 && b == 168) return true;
        if (a == 172 && b >= 16 && b <= 31) return true;
        return a == 100 && b >= 64 && b <= 127;
    }

    private static int parseOctet(String[] octets, int index) {
        if (index >= octets.length) return -1;
        try {
            int value = Integer.parseInt(octets[index]);
            return value >= 0 && value <= 255 ? value : -1;
        } catch (NumberFormatException error) {
            return -1;
        }
    }
}
