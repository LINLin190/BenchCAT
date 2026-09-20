# BenchCAT 在线更新

BenchCAT 使用 Tauri 2 官方 updater 插件，从 GitHub Release 的静态 `latest.json` 获取 Windows x64 更新。

## 发布前配置

在 GitHub 仓库 Actions secrets 中配置：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri signer 生成的私钥文本
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码；无密码时留空

私钥不得提交到仓库。`desktop/src-tauri/tauri.conf.json` 中只保存公开公钥。

## 发布流程

1. 将 `pyproject.toml`、`desktop/package.json`、`desktop/src-tauri/Cargo.toml` 和 `desktop/src-tauri/tauri.conf.json` 的版本统一。
2. 创建并推送形如 `v1.3.0` 的 Git tag。
3. `.github/workflows/release.yml` 在 Windows runner 上构建 NSIS 安装包和 updater 签名文件。
4. Tauri Action 创建 Draft Release 并上传安装包、`.sig` 和 `latest.json`。
5. 检查 Release 说明和资产后，将 Draft Release 发布为正式版本。

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
