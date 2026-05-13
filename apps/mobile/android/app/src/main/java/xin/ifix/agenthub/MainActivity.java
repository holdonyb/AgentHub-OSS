package xin.ifix.agenthub;

import android.Manifest;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.widget.EditText;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.Arrays;

public class MainActivity extends BridgeActivity {
    private static final int WEBVIEW_AUDIO_PERMISSION_REQUEST = 8701;
    private static final String APPROVAL_NOTIFICATION_CHANNEL_ID = "agenthub-approvals-v2";
    private static final String PREFS_NAME = "agenthub-client";
    private static final String PREF_SERVER_URL = "server_url";
    private PermissionRequest pendingAudioPermissionRequest;

    @Override
    protected void load() {
        super.load();
        installSystemBarInsets();
        createAgentHubNotificationChannel();
        bridge.getWebView().setWebChromeClient(new AgentHubWebChromeClient(bridge, this));
        bridge.getWebView().addJavascriptInterface(new AgentHubAndroidBridge(this), "AgentHubAndroid");
        String serverUrl = configuredServerUrl();
        if (serverUrl.isEmpty()) {
            showServerSetup();
        } else {
            bridge.getWebView().loadUrl(serverUrl);
            startNotificationServiceIfAllowed();
        }
    }

    private void installSystemBarInsets() {
        View webView = bridge.getWebView();
        ViewCompat.setOnApplyWindowInsetsListener(webView, (view, windowInsets) -> {
            Insets insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            view.setPadding(insets.left, insets.top, insets.right, insets.bottom);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(webView);
    }

    private void createAgentHubNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager notificationManager = getSystemService(NotificationManager.class);
        if (notificationManager == null) return;
        NotificationChannel channel = new NotificationChannel(
            APPROVAL_NOTIFICATION_CHANNEL_ID,
            "AgentHub 审批提醒",
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription("Codex、Claude、Kimi 等会话需要你处理时弹出提醒");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.enableVibration(true);
        channel.enableLights(true);
        channel.setShowBadge(true);
        Uri defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        if (defaultSoundUri != null) {
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build();
            channel.setSound(defaultSoundUri, audioAttributes);
        }
        notificationManager.createNotificationChannel(channel);
    }

    private boolean hasAudioPermission() {
        return ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true;
        return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean startNotificationServiceIfAllowed() {
        if (!hasNotificationPermission()) return false;
        Intent intent = new Intent(this, AgentHubNotificationService.class);
        ContextCompat.startForegroundService(this, intent);
        return true;
    }

    private boolean stopNotificationService() {
        stopService(new Intent(this, AgentHubNotificationService.class));
        return true;
    }

    private SharedPreferences clientPrefs() {
        return getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
    }

    private String configuredServerUrl() {
        String saved = normalizeServerUrl(clientPrefs().getString(PREF_SERVER_URL, ""));
        if (!saved.isEmpty()) return saved;
        return normalizeServerUrl(BuildConfig.AGENTHUB_SERVER_URL);
    }

    private String normalizeServerUrl(String value) {
        String raw = value == null ? "" : value.trim();
        if (raw.isEmpty()) return "";
        Uri uri = Uri.parse(raw);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return "";
        if (host == null || host.trim().isEmpty() || "agenthub.invalid".equalsIgnoreCase(host)) return "";
        return raw.replaceAll("/+$", "");
    }

    private String saveServerUrl(String value) {
        String normalized = normalizeServerUrl(value);
        if (normalized.isEmpty()) return "failed:invalid-url";
        clientPrefs().edit().putString(PREF_SERVER_URL, normalized).apply();
        clearCookies();
        runOnUiThread(() -> {
            bridge.getWebView().loadUrl(normalized);
            startNotificationServiceIfAllowed();
        });
        return "ok:" + normalized;
    }

    private boolean clearServerUrl() {
        clientPrefs().edit().remove(PREF_SERVER_URL).apply();
        clearCookies();
        stopNotificationService();
        runOnUiThread(this::showServerSetup);
        return true;
    }

    private void clearCookies() {
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.removeAllCookies(null);
        cookieManager.flush();
    }

    private void showServerSetup() {
        runOnUiThread(() -> {
            EditText input = new EditText(this);
            input.setSingleLine(true);
            input.setHint("https://agenthub.example.com");
            input.setText(configuredServerUrl());
            AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("AgentHub 服务器")
                .setMessage("输入你的 self-host AgentHub 地址")
                .setView(input)
                .setPositiveButton("继续", null)
                .setCancelable(false)
                .create();
            dialog.setOnShowListener((unused) -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener((view) -> {
                String result = saveServerUrl(input.getText().toString());
                if (result.startsWith("ok:")) {
                    dialog.dismiss();
                } else {
                    input.setError("请输入 http 或 https 地址");
                }
            }));
            dialog.show();
        });
    }

    private String appVersionName() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName == null ? "unknown" : info.versionName;
        } catch (PackageManager.NameNotFoundException error) {
            return "unknown";
        }
    }

    private long appVersionCode() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return info.getLongVersionCode();
            return info.versionCode;
        } catch (PackageManager.NameNotFoundException error) {
            return 0;
        }
    }

    private String downloadLatestApk(String url, String filename) {
        try {
            DownloadManager downloadManager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
            if (downloadManager == null) return "failed:download-manager-unavailable";
            String safeFilename = filename == null || filename.trim().isEmpty() ? "agenthub-debug.apk" : filename.trim();
            String targetFilename = uniqueApkFilename(safeFilename);
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("AgentHub 更新包");
            request.setDescription("下载完成后点击系统通知安装");
            request.setMimeType("application/vnd.android.package-archive");
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(true);
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, targetFilename);
            long downloadId = downloadManager.enqueue(request);
            return "enqueued:" + downloadId;
        } catch (Exception error) {
            String message = error.getMessage();
            return "failed:" + error.getClass().getSimpleName() + (message == null || message.trim().isEmpty() ? "" : ":" + message);
        }
    }

    private String uniqueApkFilename(String filename) {
        String clean = filename.replaceAll("[^A-Za-z0-9._-]", "-");
        if (clean.isEmpty()) clean = "agenthub-debug.apk";
        int suffixIndex = clean.toLowerCase().endsWith(".apk") ? clean.length() - 4 : clean.length();
        return clean.substring(0, suffixIndex) + "-" + System.currentTimeMillis() + ".apk";
    }

    private void requestAudioPermission() {
        ActivityCompat.requestPermissions(
            this,
            new String[] { Manifest.permission.RECORD_AUDIO },
            WEBVIEW_AUDIO_PERMISSION_REQUEST
        );
    }

    private void handleAudioPermissionRequest(PermissionRequest request) {
        runOnUiThread(() -> {
            if (hasAudioPermission()) {
                request.grant(request.getResources());
                return;
            }

            if (pendingAudioPermissionRequest != null) {
                pendingAudioPermissionRequest.deny();
            }
            pendingAudioPermissionRequest = request;
            requestAudioPermission();
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == WEBVIEW_AUDIO_PERMISSION_REQUEST) {
            PermissionRequest request = pendingAudioPermissionRequest;
            pendingAudioPermissionRequest = null;
            if (request == null) return;
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                request.grant(request.getResources());
            } else {
                request.deny();
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    private static class AgentHubWebChromeClient extends BridgeWebChromeClient {
        private final MainActivity activity;

        AgentHubWebChromeClient(Bridge bridge, MainActivity activity) {
            super(bridge);
            this.activity = activity;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            boolean wantsAudio = Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE);
            boolean wantsVideo = Arrays.asList(request.getResources()).contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE);
            if (wantsAudio && !wantsVideo) {
                activity.handleAudioPermissionRequest(request);
                return;
            }
            super.onPermissionRequest(request);
        }
    }

    private static class AgentHubAndroidBridge {
        private final MainActivity activity;

        AgentHubAndroidBridge(MainActivity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public String microphonePermissionState() {
            return activity.hasAudioPermission() ? "granted" : "denied";
        }

        @JavascriptInterface
        public boolean requestMicrophonePermission() {
            if (activity.hasAudioPermission()) return true;
            activity.runOnUiThread(activity::requestAudioPermission);
            return false;
        }

        @JavascriptInterface
        public boolean startNotificationService() {
            return activity.startNotificationServiceIfAllowed();
        }

        @JavascriptInterface
        public boolean stopNotificationService() {
            return activity.stopNotificationService();
        }

        @JavascriptInterface
        public String currentServerUrl() {
            return activity.configuredServerUrl();
        }

        @JavascriptInterface
        public String setServerUrl(String url) {
            return activity.saveServerUrl(url);
        }

        @JavascriptInterface
        public boolean clearServerUrl() {
            return activity.clearServerUrl();
        }

        @JavascriptInterface
        public String appVersionName() {
            return activity.appVersionName();
        }

        @JavascriptInterface
        public long appVersionCode() {
            return activity.appVersionCode();
        }

        @JavascriptInterface
        public String downloadLatestApk(String url, String filename) {
            return activity.downloadLatestApk(url, filename);
        }
    }
}
