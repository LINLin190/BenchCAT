# BenchCAT Desktop

新的主界面使用 Tauri 2、React、TypeScript、Material UI 和 Emotion。EtherCAT Master、Worker、EEPROM 与寄存器安全逻辑继续由 Python 核心唯一持有，Rust 宿主通过持久化 JSON 通道与 Python 桥接进程通信。

## 开发运行

需要 Node.js 20+、pnpm、Python 3.11+、Rust MSVC 工具链和 Windows WebView2。

```powershell
pnpm install
pnpm tauri:dev
```

也可以从仓库根目录运行 `./start-desktop.ps1`。

在独立浏览器中连接实际 EtherCAT 设备：

```powershell
pnpm dev
```

打开 `http://127.0.0.1:1420`。Vite 会同时启动仅监听本机的 Python Bridge；浏览器与 Tauri 使用同一个 Python Core，但传输层分别为 HTTP/SSE 和 Tauri IPC。请勿同时运行浏览器开发服务器和 Tauri 桌面程序，以免两个 EtherCAT Master 竞争同一网卡。

只执行构建检查：

```powershell
pnpm build
```

## 布局基准

- 主目标：2560 × 1440、1920 × 1080。
- 最小窗口：1280 × 720。
- 2560 宽度下主内容最大 1840 px，避免超宽表格损害可读性。
- 主导航与从站上下文固定，工作区独立滚动。
