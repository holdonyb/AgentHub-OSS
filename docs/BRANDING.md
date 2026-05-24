# Branding

AgentHub 的图标源文件放在：

- `assets/brand/agenthub-icon.svg`：App 图标源文件，用于 Android launcher、Windows desktop 图标和 Web favicon。
- `assets/brand/agenthub-icon.png`：从 App 图标生成的 1024px PNG，方便预览和发布页使用。
- `assets/brand/agenthub-mark.svg`：几何 hub 品牌标记，用于 README hero、架构图、标题锁定和其它白底文档场景。
- `assets/brand/agenthub-mark.png`：从纯品牌标记生成的 1024px PNG。

![AgentHub icon](../assets/brand/agenthub-icon.png)

当前 App 图标采用 Android APK 图标的样式：白色圆角方形、浅色网格底纹、浅蓝交叉标记。文档和图表不要直接使用完整 App 图标，否则在白底上会像一个按钮；应使用 `agenthub-mark` 这种更像产品 Logo 的几何标记。

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
