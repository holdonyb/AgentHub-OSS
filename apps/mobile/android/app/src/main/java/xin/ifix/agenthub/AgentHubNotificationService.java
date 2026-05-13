package xin.ifix.agenthub;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.webkit.CookieManager;
import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public class AgentHubNotificationService extends Service {
    private static final String ALERT_CHANNEL_ID = "agenthub-approvals-v2";
    private static final String SERVICE_CHANNEL_ID = "agenthub-background-v1";
    private static final String PREFS_NAME = "agenthub-notifications";
    private static final String CLIENT_PREFS_NAME = "agenthub-client";
    private static final String PREF_SERVER_URL = "server_url";
    private static final String PREF_NOTIFIED_PERMISSIONS = "notified_permissions";
    private static final String PREF_NOTIFIED_SESSIONS = "notified_sessions";
    private static final String PREF_NOTIFIED_JOBS = "notified_jobs";
    private static final String PREF_JOB_FAILURES_PRIMED = "job_failures_primed";
    private static final int FOREGROUND_NOTIFICATION_ID = 4401;
    private static final int MAX_REMEMBERED_KEYS = 400;
    private static final long POLL_INTERVAL_MS = 30_000L;
    private static final int HTTP_TIMEOUT_MS = 12_000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private boolean stopped = false;
    private boolean pollInFlight = false;

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            if (stopped || pollInFlight) return;
            pollInFlight = true;
            executor.execute(() -> {
                try {
                    pollAgentHub();
                } catch (Exception ignored) {
                    // Background notification polling must never crash the app process.
                } finally {
                    pollInFlight = false;
                    if (!stopped) handler.postDelayed(pollRunnable, POLL_INTERVAL_MS);
                }
            });
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification notification = buildForegroundNotification("正在监听审批和等待回复");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(FOREGROUND_NOTIFICATION_ID, notification);
        }
        handler.removeCallbacks(pollRunnable);
        handler.post(pollRunnable);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopped = true;
        handler.removeCallbacks(pollRunnable);
        executor.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void pollAgentHub() throws Exception {
        String baseUrl = currentServerUrl();
        if (baseUrl.isEmpty()) return;
        String cookie = CookieManager.getInstance().getCookie(baseUrl);
        if (cookie == null || cookie.trim().isEmpty()) return;
        JSONObject permissions = getJson(baseUrl, "/api/permissions", cookie);
        Set<String> pendingPermissionSessions = notifyPendingPermissions(permissions);
        JSONObject sessions = getJson(baseUrl, "/api/sessions", cookie);
        notifyNeedsReplySessions(sessions, pendingPermissionSessions);
        JSONObject jobs = getJson(baseUrl, "/api/jobs", cookie);
        notifyFailedJobs(jobs);
    }

    private JSONObject getJson(String baseUrl, String path, String cookie) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(HTTP_TIMEOUT_MS);
        connection.setReadTimeout(HTTP_TIMEOUT_MS);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Cookie", cookie);
        connection.setRequestProperty("User-Agent", "AgentHub-Android-Notifier");
        int status = connection.getResponseCode();
        if (status < 200 || status >= 300) {
            connection.disconnect();
            return new JSONObject();
        }
        try (InputStream input = connection.getInputStream()) {
            return new JSONObject(readAll(input));
        } finally {
            connection.disconnect();
        }
    }

    private String currentServerUrl() {
        String saved = normalizeServerUrl(getSharedPreferences(CLIENT_PREFS_NAME, MODE_PRIVATE).getString(PREF_SERVER_URL, ""));
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

    private Set<String> notifyPendingPermissions(JSONObject payload) {
        Set<String> pendingSessionIds = new HashSet<>();
        JSONArray items = payload.optJSONArray("items");
        if (items == null) return pendingSessionIds;
        for (int index = 0; index < items.length(); index += 1) {
            JSONObject permission = items.optJSONObject(index);
            if (permission == null || !"pending".equals(permission.optString("status"))) continue;
            String permissionId = permission.optString("permission_id");
            String sessionId = permission.optString("session_id");
            if (!sessionId.isEmpty()) pendingSessionIds.add(sessionId);
            if (permissionId.isEmpty() || !rememberOnce(PREF_NOTIFIED_PERMISSIONS, permissionId)) continue;
            String body = firstNonEmpty(
                permission.optString("title"),
                permission.optString("description"),
                "有新的审批请求需要处理"
            );
            showAlertNotification(
                "AgentHub 需要你处理审批",
                body,
                "permission:" + permissionId,
                sessionId
            );
        }
        return pendingSessionIds;
    }

    private void notifyNeedsReplySessions(JSONObject payload, Set<String> pendingPermissionSessions) {
        JSONArray items = payload.optJSONArray("items");
        if (items == null) return;
        for (int index = 0; index < items.length(); index += 1) {
            JSONObject session = items.optJSONObject(index);
            if (session == null || !"needs_reply".equals(session.optString("status"))) continue;
            String sessionId = session.optString("session_id");
            if (sessionId.isEmpty() || pendingPermissionSessions.contains(sessionId)) continue;
            String key = sessionId + ":" + firstNonEmpty(session.optString("last_activity_at"), session.optString("updated_at"), "");
            if (!rememberOnce(PREF_NOTIFIED_SESSIONS, key)) continue;
            String title = firstNonEmpty(
                session.optString("display_title"),
                session.optString("custom_title"),
                session.optString("llm_title"),
                session.optString("title"),
                "AgentHub 会话等待回复"
            );
            String summary = firstNonEmpty(session.optString("activity_summary"), session.optString("last_message"), "等待你回复");
            showAlertNotification("AgentHub 会话等待回复", title + "：" + summary, "session:" + key, sessionId);
        }
    }

    private void notifyFailedJobs(JSONObject payload) {
        JSONArray items = payload.optJSONArray("items");
        if (items == null) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        boolean primed = prefs.getBoolean(PREF_JOB_FAILURES_PRIMED, false);
        for (int index = 0; index < items.length(); index += 1) {
            JSONObject job = items.optJSONObject(index);
            if (job == null || !"failed".equals(job.optString("status"))) continue;
            String jobId = job.optString("job_id");
            if (jobId.isEmpty()) continue;
            String key = jobId + ":" + firstNonEmpty(job.optString("updated_at"), "");
            if (!rememberOnce(PREF_NOTIFIED_JOBS, key)) continue;
            if (!primed) continue;
            String subject = firstNonEmpty(job.optString("backend"), job.optString("kind"), "作业");
            String body = subject + "：" + failureSummary(job.optString("error_text"));
            showAlertNotification("AgentHub 作业失败", body, "job:" + key, job.optString("target_session_id"));
        }
        if (!primed) prefs.edit().putBoolean(PREF_JOB_FAILURES_PRIMED, true).apply();
    }

    private String failureSummary(String text) {
        String raw = text == null ? "" : text;
        String lower = raw.toLowerCase(Locale.ROOT);
        if (raw.contains("INSUFFICIENT_BALANCE") || raw.contains("账户余额不足")) {
            return "Codex API 余额不足，请充值或切换 key 后重试";
        }
        if (lower.contains("invalid_api_key") || lower.contains("incorrect api key")) {
            return "Codex API Key 无效，请重新登录或更新 key 后重试";
        }
        if (raw.contains("released to unblock queued input")) {
            return "Worker 超时或失联，系统已释放后续排队输入";
        }
        if (lower.contains("timed out after") || lower.contains("exited 4294967295") || lower.contains("exited -1")) {
            return "任务超时或被中断";
        }
        String compacted = compactText(raw, 180);
        return compacted.isEmpty() ? "执行失败，打开 AgentHub 查看细节" : compacted;
    }

    private String compactText(String value, int limit) {
        String compacted = value == null ? "" : value.trim().replaceAll("\\s+", " ");
        if (compacted.length() <= limit) return compacted;
        return compacted.substring(0, Math.max(0, limit - 1)) + "…";
    }

    private boolean rememberOnce(String name, String key) {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        Set<String> current = new HashSet<>(prefs.getStringSet(name, Collections.emptySet()));
        if (current.contains(key)) return false;
        current.add(key);
        while (current.size() > MAX_REMEMBERED_KEYS) {
            String first = current.iterator().next();
            current.remove(first);
        }
        prefs.edit().putStringSet(name, current).apply();
        return true;
    }

    private void createNotificationChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel serviceChannel = new NotificationChannel(
            SERVICE_CHANNEL_ID,
            "AgentHub 后台通知守护",
            NotificationManager.IMPORTANCE_LOW
        );
        serviceChannel.setDescription("保持后台轮询，用于发现新的审批和等待回复");
        serviceChannel.setShowBadge(false);
        manager.createNotificationChannel(serviceChannel);

        NotificationChannel alertChannel = new NotificationChannel(
            ALERT_CHANNEL_ID,
            "AgentHub 审批提醒",
            NotificationManager.IMPORTANCE_HIGH
        );
        alertChannel.setDescription("Codex、Claude、Kimi 等会话需要你处理时弹出提醒");
        alertChannel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        alertChannel.enableVibration(true);
        alertChannel.enableLights(true);
        alertChannel.setShowBadge(true);
        Uri defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        if (defaultSoundUri != null) {
            AudioAttributes audioAttributes = new AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                .build();
            alertChannel.setSound(defaultSoundUri, audioAttributes);
        }
        manager.createNotificationChannel(alertChannel);
    }

    private Notification buildForegroundNotification(String body) {
        Notification.Builder builder = notificationBuilder(SERVICE_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_agenthub)
            .setContentTitle("AgentHub 通知守护运行中")
            .setContentText(body)
            .setContentIntent(openAppIntent("foreground"))
            .setOngoing(true)
            .setShowWhen(false);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_LOW);
        }
        return builder.build();
    }

    private void showAlertNotification(String title, String body, String key, String sessionId) {
        Notification.Builder builder = notificationBuilder(ALERT_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_agenthub)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new Notification.BigTextStyle().bigText(body))
            .setContentIntent(openAppIntent(sessionId))
            .setAutoCancel(true)
            .setShowWhen(true);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            builder.setPriority(Notification.PRIORITY_HIGH);
            builder.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE | Notification.DEFAULT_LIGHTS);
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(notificationId(key), builder.build());
    }

    private Notification.Builder notificationBuilder(String channelId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(this, channelId);
        }
        return new Notification.Builder(this);
    }

    private PendingIntent openAppIntent(String sessionId) {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (sessionId != null && !sessionId.isEmpty()) intent.putExtra("sessionId", sessionId);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(this, notificationId("open:" + sessionId), intent, flags);
    }

    private int notificationId(String value) {
        int hash = value == null ? 1 : value.hashCode();
        return hash == 0 ? 1 : hash;
    }

    private String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.trim().isEmpty()) return value.trim();
        }
        return "";
    }

    private String readAll(InputStream input) throws Exception {
        StringBuilder builder = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(input, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) builder.append(line);
        }
        return builder.toString();
    }
}
