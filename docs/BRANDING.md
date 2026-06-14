# Branding

AgentHub 的图标源文件放在：

- `assets/brand/agenthub-icon.svg`：App 图标源文件，用于 Android launcher 和 Windows desktop 图标。
- `assets/brand/agenthub-icon.png`：从 App 图标生成的 1024px PNG，方便预览和发布页使用。
- `assets/brand/agenthub-mark.svg`：终端窗口品牌标记，用于 Web favicon、官网、README hero、架构图、标题锁定和其它白底文档场景。
- `assets/brand/agenthub-mark.png`：从终端品牌标记生成的 1024px PNG。

![AgentHub icon](../assets/brand/agenthub-icon.png)

当前品牌标记采用终端窗口图形，和产品定位一致：AgentHub 是跨设备控制本机 agent runtime 的入口。App 图标是在同一个终端标记外套一层白色圆角底，用于系统 launcher；文档、官网和浏览器 tab 使用 `agenthub-mark`，保持和页面标题锁定一致。

## 生成派生资源

如果要调整 Logo，先改 `scripts/generate-brand-assets.py` 里的图形参数，然后运行：

```bash
python scripts/generate-brand-assets.py
```

脚本会同步更新：

- Web favicon：`apps/web/public/favicon.svg`
- Android launcher / adaptive icon / notification icon
- Windows desktop 打包图标：`apps/desktop/assets/icon.ico`
- README 和架构图里的 AgentHub mark

不要只手动替换某一端的 PNG，否则不同客户端会重新出现图标不一致的问题。
