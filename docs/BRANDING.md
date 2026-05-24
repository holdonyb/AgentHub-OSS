# Branding

AgentHub 的图标源文件放在：

- `assets/brand/agenthub-icon.svg`：主源文件，优先用于文档、网页和设计稿。
- `assets/brand/agenthub-icon.png`：从源图标生成的 1024px PNG，方便预览和发布页使用。

![AgentHub icon](../assets/brand/agenthub-icon.png)

当前图标采用 Android APK 图标的样式：白色圆角方形、浅色网格底纹、浅蓝交叉标记。

## 生成派生资源

如果要调整 Logo，先改 `scripts/generate-brand-assets.py` 里的图形参数，然后运行：

```bash
python scripts/generate-brand-assets.py
```

脚本会同步更新：

- Web favicon：`apps/web/public/favicon.svg`
- Android launcher / adaptive icon / notification icon
- Windows desktop 打包图标：`apps/desktop/assets/icon.ico`
- README 和架构图里的 AgentHub Logo

不要只手动替换某一端的 PNG，否则不同客户端会重新出现图标不一致的问题。
