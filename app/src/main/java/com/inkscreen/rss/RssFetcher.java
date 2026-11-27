package com.inkscreen.rss;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Handler;
import android.os.SystemClock;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.HttpsURLConnection;

final class RssFetcher {
    private final ConnectivityManager networks;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main;
    private final Json.Sink sink;
    private volatile boolean closed;
    private volatile HttpsURLConnection active;
    RssFetcher(Context context, Handler main, Json.Sink sink) {
        this.networks = context.getSystemService(ConnectivityManager.class);
        this.main = main;
        this.sink = sink;
    }
    boolean online() {
        NetworkCapabilities caps = networks.getNetworkCapabilities(networks.getActiveNetwork());
        return caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
    }
    void fetch(String id, String address) {
        if (!online()) { sink.failure(id, "offline", "未联网，已跳过 RSS"); return; }
        executor.execute(() -> {
            try {
                String text = download(address);
                main.post(() -> { if (!closed) sink.success(id, Json.object("text", text)); });
            } catch (Exception e) {
                main.post(() -> {
                    if (!closed) sink.failure(id, online() ? "rss_failed" : "offline",
                            online() ? (e.getMessage() == null ? "RSS 请求失败" : e.getMessage()) : "未联网，已跳过 RSS");
                });
            }
        });
    }
    private String download(String address) throws Exception {
        URL url = new URL(address);
        long deadline = SystemClock.elapsedRealtime() + 10000;
        for (int redirect = 0; redirect <= 4; redirect++) {
            if (closed || Thread.currentThread().isInterrupted()) throw new Exception("请求已取消");
            if (!"https".equalsIgnoreCase(url.getProtocol())) throw new Exception("RSS 地址及重定向必须使用 HTTPS");
            HttpsURLConnection connection = (HttpsURLConnection) url.openConnection();
            active = connection;
            try {
                connection.setConnectTimeout(remaining(deadline));
                connection.setReadTimeout(remaining(deadline));
                connection.setInstanceFollowRedirects(false);
                connection.setRequestProperty("User-Agent", "InkScreenRSS/1.0 Android");
                connection.setRequestProperty("Accept", "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5");
                connection.setRequestProperty("Cache-Control", "no-cache");
                int code = connection.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String location = connection.getHeaderField("Location");
                    if (location == null) throw new Exception("RSS 重定向缺少地址");
                    url = new URL(url, location);
                    continue;
                }
                if (code < 200 || code >= 300) throw new Exception("HTTP " + code);
                try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                    byte[] buffer = new byte[8192];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        if (SystemClock.elapsedRealtime() >= deadline) throw new Exception("RSS 请求超时");
                        if (output.size() + count > 1024 * 1024) throw new Exception("RSS 超过 1 MB，已跳过");
                        output.write(buffer, 0, count);
                        connection.setReadTimeout(remaining(deadline));
                    }
                    Charset charset = StandardCharsets.UTF_8;
                    String type = connection.getContentType();
                    if (type != null) {
                        Matcher match = Pattern.compile("charset=([\\w-]+)", Pattern.CASE_INSENSITIVE).matcher(type);
                        if (match.find()) try { charset = Charset.forName(match.group(1)); } catch (Exception ignored) { /* UTF-8 fallback */ }
                    }
                    return new String(output.toByteArray(), charset);
                }
            } finally { connection.disconnect(); active = null; }
        }
        throw new Exception("RSS 重定向次数过多");
    }
    private static int remaining(long deadline) throws Exception {
        long value = deadline - SystemClock.elapsedRealtime();
        if (value <= 0) throw new Exception("RSS 请求超时");
        return (int) Math.min(4000, value);
    }
    void close() {
        closed = true;
        if (active != null) active.disconnect();
        executor.shutdownNow();
    }
}
