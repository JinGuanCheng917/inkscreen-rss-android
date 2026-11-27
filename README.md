# 墨水屏一体机 · Android

保留原网页的画布渲染、屏幕规格、图像协议与控制指令，通过 Android 原生 BLE 扫描和连接 NRF- 设备。

## 已实现

- Android 8.0 及以上；Android 12+ 使用“附近设备”权限，Android 8–11 使用系统要求的定位权限和定位开关。
- 本地打包的 React + Material UI 按钮、Material 3 原生设备选择弹窗。无需联网下载界面、字体或脚本。
- 默认启用 RSS，可关闭并保存设置。未联网时不发起 RSS 请求；网络、HTTP、解析或超时错误均跳过本次 RSS，保留文字。
- 始终显示“不退出应用刷新”：重新检查网络、按开关决定是否重试 RSS，同时刷新预览。不会重载网页或主动断开 BLE。
- RSS 请求期间手动修改的文字不会被迟到的结果覆盖。支持 HTTPS 源，应用内原生请求不受网页 CORS 限制。
- 依据协商 MTU 调整图像分包，串行等待写入回调；断连重试最多六次。
- 草稿及 RSS 开关保存在应用数据中。原始 HTML 不作修改。

## 云端生成可安装 APK（电脑无需 Android SDK）

1. 在 GitHub 新建私人仓库，将此目录中的所有源码上传，包含隐藏目录 .github/workflows/。
2. 打开仓库的 **Actions → Build installable APK**。提交到 main/master 会自动构建，也可点击 **Run workflow**。
3. 构建通过后，在该次运行的 Artifacts 下载 **InkScreen-RSS-APK**。
4. 解压得到 InkScreen-RSS-1.0.0.apk 和 SHA256SUMS.txt。将 APK 传到安卓手机，允许用于打开文件的应用安装未知来源应用，然后安装。

工作流会先打包 Material UI、执行离线/刷新/分包测试，然后在 GitHub runner 中安装所需的 JDK/Android SDK/Gradle，编译并运行 Android Lint。Android 工具不会安装在本机。

工作流产物为已签名的 **debug 测试 APK**，可以直接安装。每次云端构建的测试签名可能不同；后续需要持续覆盖升级时应配置由你保管的固定签名。不要把正式签名私钥提交到仓库。

## 手机首次使用

1. 打开墨水屏电源，确认设备未被其他程序占用。
2. 点击“连接墨水屏”，授予系统请求的蓝牙权限，选择扫描到的 NRF- 设备。
3. 按实际设备选择屏幕规格，编辑或拉取文字，查看预览后上传。
4. 无网时可以继续编辑和使用 BLE。恢复网络后点击“不退出应用刷新”重试 RSS。

请在传图期间保持应用前台。系统后台省电或回收进程时不保证持续传输。RSS 文字只在本地生成位图，联网仅用于获取所填写的 RSS 源。

## 项目结构

- web/：可编辑的界面、原网页逻辑和原生 RPC 适配。
- app/src/main/assets/：已打包的离线界面；npm run build:web 会从 web 重新生成。
- app/src/main/java/com/inkscreen/rss/：BLE、权限、网络请求和受限 WebView 桥。
- tests/：浏览器自动化验证，使用模拟原生接口，不等同于 BLE 实机测试。
- .github/workflows/build-apk.yml：完整云端构建流程。

## 验证边界

已验证前端离线行为、RSS 错误处理、应用内刷新、Material UI 按钮状态、20/244 字节通道容量下的传图内容和偏移。Android 编译结果须以 GitHub Actions 成功记录为准。BLE 扫描、系统权限弹窗、设备固件对分包的支持及真实刷新效果仍需手机和墨水屏实测。

依赖固定在 package-lock.json 与 Gradle 配置中。主要版本：Material UI 7.3.5、React 19.2.0、AGP 8.9.2、Gradle 8.11.1、Java 17、compile/target SDK 35。
