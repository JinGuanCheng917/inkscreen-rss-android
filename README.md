# 墨水屏一体机 · Android v1.0.1

基于已在实机生产环境验证的 Android v1.0.0 项目，合入 2026-11-28 工作区最新版「墨水屏一体机-RSS.html」。本机不安装 Android SDK，使用 GitHub Actions 构建 APK。Material UI 和前端脚本均在本地打包，应用启动无需下载界面资源。

## v1.0.1 更新

- Android 原生扫描和浏览器连接同时支持 NRF_、NRF- 名称前缀。
- 依据实际可写的 GATT 特征识别 legacy / NRF_EPD 图像协议；NRF_EPD_ 名称优先检测 NRF 服务，仍兼容旧设备。
- 原生读取固件版本、订阅并转发通知，缓存首次驱动配置，支持对应的旧版、现代和四色图像封包。没有读取到驱动配置时阻止 NRF 上传并给出提示。
- NRF 设备的图片、日历、时钟、强制刷新与时间同步经正确图像通道发送；不支持的旧固件专属控制项禁用。
- 控制器和运行日志默认隐藏，通过菜单或手机顶部按钮展开；支持关闭、遮罩和 Escape。
- 同步最新网页的多行内容防挤压规则和加宽进度条。Android 沿用连续滚动编辑布局，手机键盘打开后仍可滚动访问输入项。
- 保留无网跳过 RSS、错误保稿、草稿和开关持久化，以及“不退出应用刷新”。刷新不会重载网页或主动断开 BLE。
- 保留按 MTU 分包、串行写入、重连次数限制、上传期间控制互斥及双平面快照一致性。

## 安装与升级

支持 Android 8.0 及以上。版本号 1.0.1，versionCode 2，包名保持 com.inkscreen.rss。

本项目构建的是可安装的 debug 测试 APK。v1.0.0 使用云端临时签名，本地未保存其私钥；v1.0.1 如与旧版签名不同，必须先卸载旧版再安装。卸载会清除草稿、RSS 地址、开关和设备记录。用户已选择保留原包名、卸载后安装的方式。请在卸载前保存需要的文字和设置。

长期覆盖升级需要由应用所有者保管的固定签名；不要将签名私钥或访问凭据提交到源码仓库。当前仓库并不自动解决跨次云构建的签名连续性。

## 使用

1. 点击“连接墨水屏”，允许所需权限，选择 NRF_ 或 NRF- 开头的设备。Android 12+ 使用附近设备权限；Android 8–11 还需定位权限及系统定位开关。
2. 按实际屏幕选择规格，编辑文字并查看预览，然后上传。NRF_EPD 使用完整屏幕规格，不使用 legacy 的日历小图规格。
3. 使用顶部“控制器”“运行日志”（桌面也可使用左侧菜单）打开工具面板。不同协议可用的控制指令不同。
4. 无网或 RSS 超时、HTTP 错误、XML 解析失败时保留当前草稿。联网后点击“不退出应用刷新”重试。
5. 获取 RSS 时发生的手动编辑会被保留，不被迟到的结果覆盖。RSS 只支持 HTTPS，通过原生网络层获取。

传图时请保持应用前台。后台进程回收、设备固件差异和真实屏幕显示效果仍需设备验证。

## 构建

运行 npm ci、npm run build:web、npm test 可打包并验证前端。Windows 测试默认使用已安装的 Chrome，也可通过 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定浏览器。

GitHub Actions 的 Build installable APK 工作流在 main/master 提交或手动运行时构建。先执行界面与协议测试，再在云端使用 Java 17、Android SDK 35、AGP 8.9.2、Gradle 8.11.1 编译和 Lint；产物 InkScreen-RSS-APK 包含 InkScreen-RSS-1.0.1.apk、SHA256SUMS.txt 和 APK-SIGNATURE.txt。

## 项目结构

- web/：界面源文件、离线 Material UI、原生 RPC 适配与图像协议。
- app/src/main/assets/：通过 npm run build:web 生成的应用内资源。
- app/src/main/java/com/inkscreen/rss/：原生 BLE、权限、RSS 请求和受限 WebView 桥。
- tests/：模拟原生接口的浏览器回归测试，不等同于 BLE 实机验证。
- .github/workflows/build-apk.yml：云端编译、Lint、签名验证和校验值生成。

v1.0.0 的实机验证结论来自用户此前反馈，不能直接作为 v1.0.1 新增 NRF_EPD 协议的实机验证结论。当前版本具体测试结果随交付的验证记录提供。
