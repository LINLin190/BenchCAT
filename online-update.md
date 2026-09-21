# BenchCAT 在线更新

BenchCAT 使用 Tauri 2 官方 updater 插件，从 GitHub Release 的静态 `latest.json` 获取 Windows x64 更新。

## 发布前配置

在 GitHub 仓库 Actions secrets 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri signer 生成的私钥文本
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；无密码时留空

私钥不得提交到仓库。`desktop/src-tauri/tauri.conf.json` 中只保存公开公钥。

## 发布流程

### 发布正式 `1.3.x` 版本

以下操作只能在 `master` 分支进行。以发布 `1.3.1` 为例：

1. 将版本统一改为 `1.3.1`：
   - `pyproject.toml`
   - `desktop/package.json`
   - `desktop/src-tauri/Cargo.toml`
   - `desktop/src-tauri/Cargo.lock`
   - `desktop/src-tauri/tauri.conf.json`
   - `src/ethercat_debug_tool/__init__.py`
2. 新增对应版本的中文发布说明文件：

   - `.github/release-notes/v1.3.1.md`

   GitHub Actions 会使用该文件同时生成 Release 描述和 `latest.json` 的 `notes` 字段；后续版本将文件名替换为对应 tag，例如 `.github/release-notes/v1.3.2.md`。
3. 提交功能、版本和发布说明改动，然后创建并推送 tag：

   ```powershell
   git checkout master
   git pull --ff-only origin master
   git add <本次功能修改的文件> pyproject.toml desktop/package.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/tauri.conf.json src/ethercat_debug_tool/__init__.py
   git commit -m "Release BenchCAT v1.3.1"
   git tag -a v1.3.1 -m "Release BenchCAT v1.3.1"
   git push origin master
   git push origin v1.3.1
   ```

4. 推送 tag 后，`.github/workflows/release.yml` 会在 GitHub 的 Windows Runner 上自动构建并创建带中文说明的 Draft Release。
5. 打开 Draft Release，检查本次变更说明和安装包资产，然后点击 **Publish release**。

不要手工构建或上传安装包。发布工作流会生成并上传：

- `BenchCAT_1.3.1_x64-setup.exe`：用户手工安装时下载的 Windows 安装包。
- `BenchCAT_1.3.1_x64-setup.exe.sig`：安装包签名，供更新器验证更新来源与完整性。
- `latest.json`：更新清单，包含版本、安装包地址与签名。

`.sig` 和 `latest.json` 必须保留在正式 Release 中，但用户不需要手工下载它们。

如推送 tag 后没有创建工作流，可在 GitHub 仓库的 **Actions → Release BenchCAT → Run workflow** 中手动运行：选择 `master`，并在 `release_tag` 中填写 `v1.3.1`。

正式版本的客户端读取：

```text
https://github.com/LINLin190/BenchCAT/releases/latest/download/latest.json
```

## 客户端行为

- “设置 → 通用”中可以开启或关闭“自动检查更新”，默认关闭；关闭时若启动检查发现新版本，只在右下角短暂提示，不显示更新弹窗。“设置 → 关于”始终可以手工检查更新。
- 启动后延迟 25 秒自动检查一次；没有更新或自动检查失败时不弹窗。手动检查过后，本次启动不再自动重复检查。
- 发现更新时显示当前版本、新版本、发布时间和完整更新说明；若正在执行 EEPROM 或其他设备操作，自动提醒会延后至操作结束。
- “取消”、关闭按钮和 Esc 只关闭本次弹窗，下次启动仍可提醒；“忽略本次更新”将版本号保存在本地，同一版本不再自动弹窗，更高版本仍可提醒。手工检查或“查看更新”仍可以安装已忽略的版本。
- 安装前会停止周期通信、断开网卡并结束 Python Bridge。
- 开始更新后暂时禁用设备操作，避免后台更新期间重新连接或读写设备；失败后恢复操作入口，已断开的设备不会自动重连。
- 下载时显示百分比和已下载大小；总大小未知时显示活动进度条。下载完成后切换为“准备安装”，后续安装进度由 Windows 安装器显示。
- 更新期间可以关闭弹窗或点击“后台运行”，右下角保留进度与“查看进度”入口。此时仍需保持 BenchCAT 运行，退出整个软件不会继续下载。
- Windows 安装器安装更新时会退出当前应用，然后重新启动 BenchCAT。
- 在软件中点击“立即更新”后会自动完成下载、安装和重启，无需手动运行安装包。
- 检查更新的请求超时为 15 秒，下载请求超时为 15 分钟。失败时显示对应阶段与原因，并提供重试、打开下载页面和关闭按钮；重试更新会重新下载更新包。

`v1.3.0` 是首个包含 updater 的正式版本，仍需要用户手工安装；从该版本开始，后续正式 `1.3.x` Release 才能在线升级。

## 版本线

- `master` 是正式版本线，`v1.3.0` 起增加在线更新功能，后续使用 `1.3.1`、`1.3.2` 等版本号通过 GitHub Release 在线升级。

## GitHub Actions 是什么

GitHub Actions 是 GitHub 提供的自动化运行平台。仓库中的 `.github/workflows/release.yml` 定义了一个名为 **Release BenchCAT** 的工作流：当推送 `v1.3.1` 这类 tag，或在网页中手动运行工作流时，GitHub 会临时提供一台 Windows Runner，并按工作流定义自动完成：

1. 拉取 BenchCAT 源代码。
2. 安装 Python、Node.js、pnpm 以及项目依赖。
3. 构建 Python Bridge 和 BenchCAT Windows NSIS 安装包。
4. 使用 `TAURI_SIGNING_PRIVATE_KEY` 为更新包生成签名。
5. 创建 GitHub Draft Release，并上传安装包、`.sig` 和 `latest.json`。

因此发布者只需维护源代码、版本号、tag 和 Release 说明；无需在本地构建后再上传安装包。用户安装 `1.3.0` 后，之后每个已发布的正式 `1.3.x` Release 都会成为客户端可检测的在线更新。
