# 墨水屏一体机 · Android v1.0.2

基于 v1.0.1 增加多 RSS 源管理和 Material 壁纸动态取色，仅支持 Android 12（API 31）及以上。本机不安装 Android SDK，使用 GitHub Actions 云端编译。界面、Material UI 和脚本随应用离线打包。

## 本版更新

- 桌面菜单和手机顶部新增 RSS 入口。首次安装默认关闭，无预置链接。开启后可以新建、命名、修改、保存、选择和删除多个 HTTPS 源。
- 开关、链接及当前选择保存在本地。首次开启不自动请求；点击“拉取”获取已保存的所选源。保持开启后，启动或“不退出应用刷新”使用该源。未保存的表单不影响当前源。
- 关闭 RSS、切换、修改或删除源时使旧请求失效。离线、失败、请求期间手动编辑时保留草稿。支持 RSS、Atom、HTML 摘要转纯文本及仅含标题的订阅。
- 默认开启 Material 壁纸取色，原生弹窗、系统栏、WebView、CSS 与 MUI 按钮使用系统动态颜色。RSS 面板底部“界面配色”可关闭并记忆设置。系统不支持时回退固定 Material 配色。
- 返回应用时重新同步调色板。切换颜色不会重载 WebView 或主动断开 BLE，不改变墨水屏画布黑、白、红像素。
- minSdk 31，仅适配 Android 12+。移除旧版蓝牙和定位权限路径，扫描连接使用“附近设备”权限。

## 保留功能

沿用 v1.0.1 的 NRF_／NRF- 扫描、legacy／NRF_EPD 服务识别、版本与驱动读取、旧新固件及四色封包、按 MTU 分包、串行写入、断线重连、控制互斥和双平面快照。控制器和日志保留菜单抽屉；编辑区保留连续滚动与六行正文。

## 安装与升级

版本号 1.0.2，versionCode 3，包名 com.inkscreen.rss，最低 Android 12。Android 11 及以下无法安装。

当前是可安装的 debug 测试 APK，未配置跨次构建共用的固定私钥。请以本版签名校验记录为准；签名不同不能覆盖安装，按此前选择保留原包名、先卸载再安装。卸载会清除文字、RSS 设置及设备记录，请先保存需要的内容。正常退出、重启不会清除设置。后续持续覆盖升级需要由应用所有者保管固定签名。

## 使用

1. 连接墨水屏并允许附近设备权限，选择 NRF_ 或 NRF- 设备。
2. 选择实际屏幕规格，编辑文字、预览并上传。NRF_EPD 使用完整屏幕规格，不使用 legacy 的日历小图规格。
3. 打开 RSS 并启用，填写 HTTPS 链接和可选名称，点击“保存源”。用“新建”添加其他源，下拉选择一个已保存源，再点击“拉取”。
4. 离线或失败保留草稿，联网后点击“不退出应用刷新”。保存后的链接才会用于拉取。
5. 在 RSS 面板底部切换“Material 壁纸取色”。不支持动态色的系统保持可用的固定配色。

## 构建与验证

npm ci、npm run build:web、npm test 可打包并验证前端。Windows 测试默认使用已安装 Chrome，可通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定浏览器。测试模拟原生桥，不能代替 Android 和 BLE 实机测试。

GitHub Actions 的 Build installable APK 在 main/master 提交或手动执行时运行测试，然后使用 Java 17、Android SDK 35、AGP 8.9.2、Gradle 8.11.1 编译和 Lint，并验证 APK 签名和包信息。产物包括 InkScreen-RSS-1.0.2.apk、SHA256SUMS.txt、APK-SIGNATURE.txt、APK-METADATA.txt、BUILD-INFO.json。

## 目录

- web/：界面源文件；app/src/main/assets/：build:web 生成的打包资源。
- app/src/main/java/com/inkscreen/rss/：原生 BLE、权限、RSS、动态颜色和受限 WebView 桥。
- tests/：界面、RSS、持久化、颜色和协议回归测试。
- .github/workflows/：云构建及产物导出。

真实设备仍需验证壁纸调色板、系统权限弹窗、蓝牙通信和墨水屏显示。旧版实机反馈不能直接作为本版新增功能的实机结论。
