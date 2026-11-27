package com.inkscreen.rss;

import android.Manifest;
import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Map;

public final class MainActivity extends AppCompatActivity implements Json.Sink {
    private static final String ORIGIN = "https://appassets.androidplatform.net";
    private static final String START_URL = ORIGIN + "/assets/index.html";
    private final Handler main = new Handler(Looper.getMainLooper());
    private WebView web;
    private BleController ble;
    private RssFetcher rss;
    private JavaScriptReplyProxy reply;
    private ConnectivityManager networks;
    private boolean destroyed, callbackRegistered;
    private String pendingSelect;

    private final ActivityResultLauncher<String[]> permissions = registerForActivityResult(
            new ActivityResultContracts.RequestMultiplePermissions(), result -> {
                if (pendingSelect == null) return;
                if (ble.permitted()) ensureBluetooth();
                else finishSelection("permission", "未获得蓝牙权限；仍可编辑文字，授权后可连接墨水屏");
            });
    @SuppressLint("MissingPermission") // Called only after ble.permitted() succeeds.
    private final ActivityResultLauncher<Intent> enableBluetooth = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                if (pendingSelect == null) return;
                if (ble.adapter != null && ble.permitted() && ble.adapter.isEnabled()) startSelection();
                else finishSelection("bluetooth_off", "蓝牙未开启，请开启后重试");
            });
    private final ConnectivityManager.NetworkCallback networkCallback = new ConnectivityManager.NetworkCallback() {
        @Override public void onAvailable(Network network) { networkChanged(); }
        @Override public void onLost(Network network) { networkChanged(); }
        @Override public void onCapabilitiesChanged(Network network, NetworkCapabilities capabilities) { networkChanged(); }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        ble = new BleController(this, main, this);
        rss = new RssFetcher(this, main, this);
        networks = getSystemService(ConnectivityManager.class);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        FrameLayout container = new FrameLayout(this);
        web = new WebView(this);
        web.setBackgroundColor(0xfff9f9ff);
        container.addView(web, new FrameLayout.LayoutParams(-1, -1));
        ViewCompat.setOnApplyWindowInsetsListener(container, (view, insets) -> {
            androidx.core.graphics.Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        setContentView(container);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        WebView.setWebContentsDebuggingEnabled(false);
        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClientCompat() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if ("https".equals(url.getScheme()) && "appassets.androidplatform.net".equals(url.getHost())) {
                    WebResourceResponse resource = loader.shouldInterceptRequest(url);
                    if (resource != null) return resource;
                }
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(),
                        new ByteArrayInputStream("外部网页资源已禁用".getBytes(StandardCharsets.UTF_8)));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !START_URL.equals(request.getUrl().toString());
            }
        });
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            new MaterialAlertDialogBuilder(this).setTitle("请更新 Android System WebView")
                    .setMessage("系统网页组件版本过旧，无法使用应用内蓝牙接口。更新 Android System WebView 或 Chrome 后重新打开本应用。")
                    .setPositiveButton("知道了", (dialog, which) -> finish()).setCancelable(false).show();
            return;
        }
        WebViewCompat.addWebMessageListener(web, "InkNative", Collections.singleton(ORIGIN),
                (view, message, source, isMainFrame, proxy) -> {
                    if (!isMainFrame || !"https".equals(source.getScheme())
                            || !"appassets.androidplatform.net".equals(source.getHost())
                            || (source.getPort() != -1 && source.getPort() != 443) || destroyed) return;
                    reply = proxy;
                    String data = message.getData();
                    if (data == null || data.length() > 12000) return;
                    dispatch(data);
                });
        web.loadUrl(START_URL);
        try { networks.registerDefaultNetworkCallback(networkCallback); callbackRegistered = true; }
        catch (Exception ignored) { /* Explicit refresh still rechecks connectivity. */ }
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() { moveTaskToBack(true); }
        });
    }
    private void dispatch(String data) {
        String id = "";
        try {
            JSONObject request = new JSONObject(data);
            id = request.getString("id");
            if (!id.matches("[0-9]{1,12}")) return;
            JSONObject params = request.optJSONObject("params");
            if (params == null) params = new JSONObject();
            switch (request.getString("method")) {
                case "network": success(id, Json.object("online", rss.online())); break;
                case "rss":
                    String url = params.getString("url");
                    if (url.length() > 2048) throw new IllegalArgumentException("RSS 地址过长");
                    rss.fetch(id, url); break;
                case "selectConnect": requestSelection(id); break;
                case "connectLast": ble.reconnect(id); break;
                case "lastDevice": ble.lastDevice(id); break;
                case "write": ble.write(id, params.getString("channel"), params.getString("hex")); break;
                case "disconnect": ble.disconnect(id); break;
                default: failure(id, "invalid", "未知应用操作");
            }
        } catch (Exception e) { failure(id, "invalid", e.getMessage() == null ? "应用操作失败" : e.getMessage()); }
    }
    private void requestSelection(String id) {
        if (pendingSelect != null) { failure(id, "busy", "请先完成当前权限或蓝牙操作"); return; }
        if (ble.adapter == null || !getPackageManager().hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)) {
            failure(id, "unsupported", "此设备不支持低功耗蓝牙"); return;
        }
        pendingSelect = id;
        if (ble.permitted()) ensureBluetooth();
        else permissions.launch(Build.VERSION.SDK_INT >= 31
                ? new String[]{Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT}
                : new String[]{Manifest.permission.ACCESS_FINE_LOCATION});
    }
    @SuppressLint("MissingPermission")
    private void ensureBluetooth() {
        if (!ble.adapter.isEnabled()) enableBluetooth.launch(new Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE));
        else startSelection();
    }
    private void startSelection() {
        if (Build.VERSION.SDK_INT <= 30) {
            android.location.LocationManager locations = getSystemService(android.location.LocationManager.class);
            boolean enabled = Build.VERSION.SDK_INT >= 28 ? locations.isLocationEnabled()
                    : locations.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) || locations.isProviderEnabled(android.location.LocationManager.NETWORK_PROVIDER);
            if (!enabled) { finishSelection("location_off", "Android 8–11 扫描蓝牙需要开启系统定位开关；开启后请重新连接"); return; }
        }
        String id = pendingSelect; pendingSelect = null;
        if (id != null) ble.select(id);
    }
    private void finishSelection(String code, String message) {
        String id = pendingSelect; pendingSelect = null;
        if (id != null) failure(id, code, message);
    }
    private void networkChanged() { main.post(() -> { if (!destroyed) event("network", Json.object("online", rss.online())); }); }
    @Override public void success(String id, JSONObject result) { send(Json.object("id", id, "result", result)); }
    @Override public void failure(String id, String code, String message) { send(Json.object("id", id, "error", Json.object("code", code, "message", message))); }
    @Override public void event(String name, Object value) { send(Json.object("event", name, "data", value)); }
    private void send(JSONObject message) {
        if (destroyed || reply == null) return;
        try { reply.postMessage(message.toString()); } catch (IllegalStateException ignored) { /* Page has been detached. */ }
    }
    @Override protected void onDestroy() {
        destroyed = true;
        if (callbackRegistered) networks.unregisterNetworkCallback(networkCallback);
        if (ble != null) ble.close();
        if (rss != null) rss.close();
        main.removeCallbacksAndMessages(null);
        if (web != null) { web.stopLoading(); web.destroy(); }
        super.onDestroy();
    }
}
