package com.inkscreen.rss;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.widget.ArrayAdapter;
import androidx.appcompat.app.AlertDialog;
import androidx.core.content.ContextCompat;
import com.google.android.material.dialog.MaterialAlertDialogBuilder;
import java.util.ArrayList;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.function.Consumer;

@SuppressLint("MissingPermission") // All entry points check the version-specific runtime permissions.
final class BleController {
    private static final UUID EPD_SERVICE = UUID.fromString("13187b10-eba9-a3ba-044e-83d3217d9a38");
    private static final UUID EPD_CHAR = UUID.fromString("4b646063-6264-f3a7-8941-e65356ea82fe");
    private static final UUID CONTROL_SERVICE = UUID.fromString("00001f10-0000-1000-8000-00805f9b34fb");
    private static final UUID CONTROL_CHAR = UUID.fromString("00001f1f-0000-1000-8000-00805f9b34fb");
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
    private final Activity activity;
    private final Handler main;
    private final Json.Sink sink;
    private final SharedPreferences preferences;
    final BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic image, control;
    private BluetoothDevice device;
    private String connectId;
    private boolean ready, scanning, closed;
    private int mtu = 23;
    private AlertDialog picker;
    private final List<BluetoothDevice> discovered = new ArrayList<>();
    private ArrayAdapter<String> names;
    private final Deque<Operation> queue = new ArrayDeque<>();
    private Operation active;
    private Runnable operationTimeout, connectionTimeout, scanTimeout, selectionTimeout;

    BleController(Activity activity, Handler main, Json.Sink sink) {
        this.activity = activity; this.main = main; this.sink = sink;
        preferences = activity.getSharedPreferences("ble", Activity.MODE_PRIVATE);
        adapter = activity.getSystemService(BluetoothManager.class).getAdapter();
    }
    boolean permitted() {
        if (Build.VERSION.SDK_INT >= 31) return granted(Manifest.permission.BLUETOOTH_SCAN) && granted(Manifest.permission.BLUETOOTH_CONNECT);
        return granted(Manifest.permission.ACCESS_FINE_LOCATION);
    }
    private boolean granted(String permission) { return ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED; }
    void select(String id) {
        if (!validate(id)) return;
        connectId = id;
        names = new ArrayAdapter<>(activity, android.R.layout.simple_list_item_1);
        discovered.clear();
        picker = new MaterialAlertDialogBuilder(activity)
                .setTitle("选择墨水屏 · 扫描 15 秒")
                .setAdapter(names, (dialog, index) -> {
                    BluetoothDevice chosen = discovered.get(index);
                    stopScan();
                    main.removeCallbacks(selectionTimeout);
                    picker = null;
                    connect(chosen);
                })
                .setNegativeButton("取消", (dialog, which) -> failConnect("cancelled", "已取消选择设备"))
                .setOnCancelListener(dialog -> failConnect("cancelled", "已取消选择设备"))
                .create();
        picker.show();
        try {
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) throw new IllegalStateException("蓝牙扫描不可用，请重新打开蓝牙");
            scanning = true;
            scanner.startScan(null, new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scan);
            scanTimeout = () -> {
                stopScan();
                if (picker != null) picker.setTitle(discovered.isEmpty()
                        ? "未发现 NRF- 设备，请确认设备开启后重试" : "扫描结束 · 请选择设备");
            };
            main.postDelayed(scanTimeout, 15000);
            selectionTimeout = () -> failConnect("timeout", "设备选择超时，请重新连接");
            main.postDelayed(selectionTimeout, 120000);
        } catch (Exception e) { failConnect("scan_failed", e.getMessage()); }
    }
    void reconnect(String id) {
        String address = preferences.getString("address", null);
        if (address == null) { sink.failure(id, "no_device", "首次使用请点击「连接墨水屏」"); return; }
        if (!validate(id)) return;
        connectId = id;
        try { connect(adapter.getRemoteDevice(address)); }
        catch (Exception e) { failConnect("connect_failed", e.getMessage()); }
    }
    void lastDevice(String id) {
        String address = preferences.getString("address", null);
        if (address == null) { sink.failure(id, "no_device", "首次使用请点击「连接墨水屏」"); return; }
        sink.success(id, Json.object("id", address, "name", preferences.getString("name", "NRF 设备")));
    }
    private boolean validate(String id) {
        if (closed) return false;
        if (connectId != null) { sink.failure(id, "busy", "已有蓝牙连接操作正在进行"); return false; }
        if (adapter == null) { sink.failure(id, "unsupported", "此设备不支持蓝牙"); return false; }
        if (!permitted()) { sink.failure(id, "permission", "请点击连接并允许蓝牙权限"); return false; }
        if (!adapter.isEnabled()) { sink.failure(id, "bluetooth_off", "请打开蓝牙后连接"); return false; }
        return true;
    }
    private final ScanCallback scan = new ScanCallback() {
        @Override public void onScanResult(int type, ScanResult result) { main.post(() -> add(result)); }
        @Override public void onBatchScanResults(List<ScanResult> results) { main.post(() -> { for (ScanResult result : results) add(result); }); }
        @Override public void onScanFailed(int code) { main.post(() -> { if (scanning) failConnect("scan_failed", "蓝牙扫描失败（" + code + "）"); }); }
    };
    private void add(ScanResult result) {
        if (!scanning || !permitted()) return;
        BluetoothDevice found = result.getDevice();
        String name = result.getScanRecord() == null ? null : result.getScanRecord().getDeviceName();
        if (name == null) name = found.getName();
        if (name == null || !name.startsWith("NRF-") || discovered.contains(found)) return;
        discovered.add(found);
        names.add(name + "\n" + found.getAddress());
    }
    private void stopScan() {
        if (scanTimeout != null) main.removeCallbacks(scanTimeout);
        if (scanning && scanner != null) try { scanner.stopScan(scan); } catch (Exception ignored) { /* Permission may have been revoked. */ }
        scanning = false; scanner = null;
    }
    private void connect(BluetoothDevice selected) {
        closeGatt("连接已重置");
        device = selected; mtu = 23;
        sink.event("log", "正在连接墨水屏…");
        connectionTimeout = () -> failConnect("timeout", "连接或服务发现超时，请重试");
        main.postDelayed(connectionTimeout, 25000);
        try {
            gatt = selected.connectGatt(activity, false, callbacks, BluetoothDevice.TRANSPORT_LE);
            if (gatt == null) failConnect("connect_failed", "无法创建蓝牙连接");
        } catch (Exception e) { failConnect("connect_failed", e.getMessage()); }
    }
    private final BluetoothGattCallback callbacks = new BluetoothGattCallback() {
        @Override public void onConnectionStateChange(BluetoothGatt source, int status, int state) {
            main.post(() -> {
                if (source != gatt) return;
                if (status == BluetoothGatt.GATT_SUCCESS && state == BluetoothProfile.STATE_CONNECTED) {
                    try { if (!source.requestMtu(247)) discover(source); }
                    catch (Exception e) { failConnect("connect_failed", e.getMessage()); }
                } else if (state == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    if (connectId != null) failConnect("connect_failed", "蓝牙连接失败（" + status + "），请确认墨水屏可连接");
                    else { boolean notify = ready; closeGatt("连接已断开"); if (notify) sink.event("disconnected", Json.object()); }
                }
            });
        }
        @Override public void onMtuChanged(BluetoothGatt source, int value, int status) { main.post(() -> {
            if (source != gatt) return;
            mtu = status == BluetoothGatt.GATT_SUCCESS ? Math.max(23, value) : 23;
            discover(source);
        }); }
        @Override public void onServicesDiscovered(BluetoothGatt source, int status) { main.post(() -> {
            if (source != gatt) return;
            if (status != BluetoothGatt.GATT_SUCCESS) { failConnect("services", "发现蓝牙服务失败（" + status + "）"); return; }
            BluetoothGattService service = source.getService(EPD_SERVICE);
            image = service == null ? null : service.getCharacteristic(EPD_CHAR);
            if (!writable(image)) { failConnect("services", "设备没有可写入的墨水屏图像通道"); return; }
            BluetoothGattService controlService = source.getService(CONTROL_SERVICE);
            control = controlService == null ? null : controlService.getCharacteristic(CONTROL_CHAR);
            if (!writable(control)) control = null;
            subscribe(source);
        }); }
        @Override public void onDescriptorWrite(BluetoothGatt source, BluetoothGattDescriptor descriptor, int status) { main.post(() -> {
            if (source == gatt && active != null && active.descriptor == descriptor) finishOperation(status == BluetoothGatt.GATT_SUCCESS ? null : "订阅通知失败（" + status + "）");
        }); }
        @Override public void onCharacteristicWrite(BluetoothGatt source, BluetoothGattCharacteristic characteristic, int status) { main.post(() -> {
            if (source == gatt && active != null && active.characteristic == characteristic) finishOperation(status == BluetoothGatt.GATT_SUCCESS ? null : "蓝牙写入失败（" + status + "）");
        }); }
        @Override public void onCharacteristicChanged(BluetoothGatt source, BluetoothGattCharacteristic characteristic, byte[] value) {
            notifyValue(source, characteristic.getUuid(), value.clone());
        }
        @SuppressWarnings("deprecation")
        @Override public void onCharacteristicChanged(BluetoothGatt source, BluetoothGattCharacteristic characteristic) {
            byte[] value = characteristic.getValue();
            if (value != null) notifyValue(source, characteristic.getUuid(), value.clone());
        }
    };
    private void notifyValue(BluetoothGatt source, UUID uuid, byte[] value) { main.post(() -> {
        if (source == gatt && uuid.equals(EPD_CHAR)) sink.event("notification", hex(value));
    }); }
    private void discover(BluetoothGatt source) {
        if (!source.discoverServices()) failConnect("services", "无法启动蓝牙服务发现");
    }
    private static boolean writable(BluetoothGattCharacteristic characteristic) {
        return characteristic != null && (characteristic.getProperties() & (BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0;
    }
    private void subscribe(BluetoothGatt source) {
        int properties = image.getProperties();
        BluetoothGattDescriptor descriptor = image.getDescriptor(CCCD);
        boolean indications = (properties & BluetoothGattCharacteristic.PROPERTY_NOTIFY) == 0 && (properties & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0;
        if (descriptor == null || (properties & (BluetoothGattCharacteristic.PROPERTY_NOTIFY | BluetoothGattCharacteristic.PROPERTY_INDICATE)) == 0) { connected(); return; }
        try {
            if (!source.setCharacteristicNotification(image, true)) { sink.event("log", "通知订阅不可用，仍可传图"); connected(); return; }
            enqueue(new Operation(descriptor, indications ? BluetoothGattDescriptor.ENABLE_INDICATION_VALUE : BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE, error -> {
                if (error != null) sink.event("log", error);
                connected();
            }));
        } catch (Exception e) { sink.event("log", "通知订阅失败，仍可传图"); connected(); }
    }
    private void connected() {
        if (gatt == null || connectId == null) return;
        if (connectionTimeout != null) main.removeCallbacks(connectionTimeout);
        ready = true;
        String id = connectId; connectId = null;
        String name = device.getName();
        preferences.edit().putString("address", device.getAddress()).putString("name", name == null ? "NRF 设备" : name).apply();
        sink.success(id, Json.object("id", device.getAddress(), "name", name == null ? "NRF 设备" : name,
                "control", control != null, "maxPayload", Math.min(244, mtu - 3)));
    }
    void write(String id, String channel, String data) {
        if (!ready || gatt == null || !permitted()) { sink.failure(id, "disconnected", "墨水屏未连接或蓝牙权限已取消"); return; }
        BluetoothGattCharacteristic target;
        if ("image".equals(channel)) target = image;
        else if ("control".equals(channel)) target = control;
        else { sink.failure(id, "invalid", "未知蓝牙通道"); return; }
        if (target == null) { sink.failure(id, "services", "控制通道不可用"); return; }
        if (data.isEmpty() || data.length() % 2 != 0 || !data.matches("[0-9a-fA-F]+")) { sink.failure(id, "invalid", "无效蓝牙数据"); return; }
        byte[] bytes = new byte[data.length() / 2];
        if (bytes.length > Math.min(244, mtu - 3)) { sink.failure(id, "mtu", "数据包超过当前蓝牙通道容量"); return; }
        for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) Integer.parseInt(data.substring(i * 2, i * 2 + 2), 16);
        enqueue(new Operation(target, bytes, error -> {
            if (error == null) sink.success(id, Json.object());
            else sink.failure(id, "write_failed", error);
        }));
    }
    private static final class Operation {
        final BluetoothGattCharacteristic characteristic;
        final BluetoothGattDescriptor descriptor;
        final byte[] bytes;
        final Consumer<String> done;
        Operation(BluetoothGattCharacteristic characteristic, byte[] bytes, Consumer<String> done) { this.characteristic = characteristic; this.descriptor = null; this.bytes = bytes; this.done = done; }
        Operation(BluetoothGattDescriptor descriptor, byte[] bytes, Consumer<String> done) { this.characteristic = null; this.descriptor = descriptor; this.bytes = bytes; this.done = done; }
    }
    private void enqueue(Operation operation) {
        if (queue.size() >= 64) { operation.done.accept("蓝牙队列已满，请稍后再试"); return; }
        queue.add(operation); startOperation();
    }
    @SuppressWarnings("deprecation")
    private void startOperation() {
        if (active != null || queue.isEmpty() || gatt == null) return;
        active = queue.remove();
        operationTimeout = () -> {
            if (connectId != null) failConnect("timeout", "蓝牙初始化超时，请重新连接");
            else { boolean notify = ready; closeGatt("蓝牙写入超时，请重新连接"); if (notify) sink.event("disconnected", Json.object()); }
        };
        main.postDelayed(operationTimeout, 12000);
        try {
            boolean accepted;
            if (active.descriptor != null) {
                if (Build.VERSION.SDK_INT >= 33) accepted = gatt.writeDescriptor(active.descriptor, active.bytes) == BluetoothStatusCodes.SUCCESS;
                else { active.descriptor.setValue(active.bytes); accepted = gatt.writeDescriptor(active.descriptor); }
            } else {
                int type = (active.characteristic.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) != 0
                        ? BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT : BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
                if (Build.VERSION.SDK_INT >= 33) accepted = gatt.writeCharacteristic(active.characteristic, active.bytes, type) == BluetoothStatusCodes.SUCCESS;
                else { active.characteristic.setWriteType(type); active.characteristic.setValue(active.bytes); accepted = gatt.writeCharacteristic(active.characteristic); }
            }
            if (!accepted) finishOperation("系统拒绝蓝牙写入，请重试");
        } catch (Exception e) { finishOperation("蓝牙写入失败：" + e.getMessage()); }
    }
    private void finishOperation(String error) {
        if (active == null) return;
        main.removeCallbacks(operationTimeout);
        Operation operation = active; active = null;
        operation.done.accept(error);
        startOperation();
    }
    private void failConnect(String code, String message) {
        String id = connectId; connectId = null;
        stopScan();
        if (selectionTimeout != null) main.removeCallbacks(selectionTimeout);
        if (picker != null) { picker.dismiss(); picker = null; }
        closeGatt("连接未完成");
        if (id != null) sink.failure(id, code, message == null ? "蓝牙操作失败" : message);
    }
    void disconnect(String id) {
        if (connectId != null) failConnect("cancelled", "连接已取消");
        boolean notify = ready;
        closeGatt("连接已断开");
        if (notify) sink.event("disconnected", Json.object());
        sink.success(id, Json.object());
    }
    private void closeGatt(String reason) {
        if (connectionTimeout != null) main.removeCallbacks(connectionTimeout);
        if (operationTimeout != null) main.removeCallbacks(operationTimeout);
        BluetoothGatt previous = gatt;
        gatt = null; ready = false; image = null; control = null;
        List<Operation> aborted = new ArrayList<>();
        if (active != null) { aborted.add(active); active = null; }
        aborted.addAll(queue); queue.clear();
        if (previous != null) {
            try { previous.disconnect(); } catch (Exception ignored) { /* Already disconnected. */ }
            previous.close();
        }
        for (Operation operation : aborted) operation.done.accept(reason);
    }
    void close() {
        closed = true; failConnect("cancelled", "应用已关闭");
        closeGatt("应用已关闭");
    }
    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder();
        for (byte item : value) result.append(String.format(Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }
}
