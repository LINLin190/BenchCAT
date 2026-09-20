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
2. 提交功能与版本改动，然后创建并推送 tag：

   ```powershell
   git checkout master
   git pull --ff-only origin master
   git add <本次功能修改的文件> pyproject.toml desktop/package.json desktop/src-tauri/Cargo.toml desktop/src-tauri/Cargo.lock desktop/src-tauri/tauri.conf.json src/ethercat_debug_tool/__init__.py
   git commit -m "Release BenchCAT v1.3.1"
   git tag -a v1.3.1 -m "Release BenchCAT v1.3.1"
   git push origin master
   git push origin v1.3.1
   ```

3. 推送 tag 后，`.github/workflows/release.yml` 会在 GitHub 的 Windows Runner 上自动构建并创建 Draft Release。
4. 打开 Draft Release，填写或检查本次变更说明，然后点击 **Publish release**。

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

- “设置 → 关于”中可以手工检查更新。
- 启动后会延迟检查一次；没有更新时不弹窗。
- 安装前会停止周期通信、断开网卡并结束 Python Bridge。
- Windows 安装器安装更新时会退出当前应用，然后重新启动 BenchCAT。
- 在软件中点击“立即更新”后会自动完成下载、安装和重启，无需手动运行安装包。
- 在线更新失败时仍可以打开 GitHub 页面手工下载。

`v1.3.0` 是首个包含 updater 的正式版本，仍需要用户手工安装；从该版本开始，后续正式 `1.3.x` Release 才能在线升级。

## 版本线

- `fae/1.2.x` 分支仅供客户 FAE 使用，起始版本为 `1.2.0`，后续使用 `1.2.1`、`1.2.2` 等版本号手工发布，不包含在线更新功能。
- `master` 是正式版本线，`v1.3.0` 起增加在线更新功能，后续使用 `1.3.1`、`1.3.2` 等版本号通过 GitHub Release 在线升级。

## GitHub Actions 是什么

GitHub Actions 是 GitHub 提供的自动化运行平台。仓库中的 `.github/workflows/release.yml` 定义了一个名为 **Release BenchCAT** 的工作流：当推送 `v1.3.1` 这类 tag，或在网页中手动运行工作流时，GitHub 会临时提供一台 Windows Runner，并按工作流定义自动完成：

1. 拉取 BenchCAT 源代码。
2. 安装 Python、Node.js、pnpm 以及项目依赖。
3. 构建 Python Bridge 和 BenchCAT Windows NSIS 安装包。
4. 使用 `TAURI_SIGNING_PRIVATE_KEY` 为更新包生成签名。
5. 创建 GitHub Draft Release，并上传安装包、`.sig` 和 `latest.json`。

因此发布者只需维护源代码、版本号、tag 和 Release 说明；无需在本地构建后再上传安装包。用户安装 `1.3.0` 后，之后每个已发布的正式 `1.3.x` Release 都会成为客户端可检测的在线更新。
