# Windows 电脑端补丁备份

本分支保存本机已部署的电脑端修复，包括队列和实时状态协议、手机按需打开桌面聊天、切换提速、附件、技能命令、通知与自动标题，以及快捷方式慢启动修复。

## 换电脑时恢复

1. 下载并解压作者 Release 的 Windows 桌面插件 ZIP。备份基于官方 **0.5.0**，请用该版本作为恢复底包。
2. 下载本分支的 ZIP 并解压。把本分支的 `server`、`desktop` 目录覆盖到官方 ZIP 解压目录下的 `plugins/codex-lan-desktop/`，保留官方包里的运行时、EasyTier 和其他文件。
3. 从官方 ZIP 解压目录运行 `install-desktop-plugin.ps1`。安装完后，把本分支的 `scripts/open-phone-settings.ps1` 复制为 `%LOCALAPPDATA%\CodexLAN\open-settings.ps1`。已有同名文件时先备份。
4. 打开「手机连接设置」，按新电脑的地址配置 EasyTier 并扫码配对。更换 Codex 桌面版本后，先用一条聊天确认连接、发送和排队是否正常。

分支 ZIP 是源码备份，需搭配官方 Windows 插件 ZIP。配对信息、证书、聊天记录、EasyTier 密钥和个人配置应单独保存在本地。
