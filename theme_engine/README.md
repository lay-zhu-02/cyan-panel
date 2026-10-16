# Wallpaper Engine 离线导入器

`Library(path)` 只依赖 Python 标准库，不导入 FastAPI、账号系统或面板配置，可独立移植。

接口包括 `import_directory(path)`、`import_tree(path)`、`import_zip(file)`、`catalog()`、`manifest(id)` 和 `asset(id, path)`。命令行入口为 `tools/import_wallpapers.py`，使用方法见项目 README。

导入识别 Video / Web / Scene；Scene 只复制封面。导入在临时目录完成后原子发布，不修改原始项目；拒绝越界、符号链接和特殊文件，并限制导入大小与文件数量。素材库属于本机运行数据，不纳入 Git。

`app/themes.py` 是 FastAPI 适配器，仅提供登录后的清单和带时效签名的资源读取，不提供在线导入或上传接口。Web 壁纸在 opaque-origin iframe 中运行，资源 CSP 限于自身项目路径，不能访问父页面、主机文件或其他 API。壁纸目录故障仅使主题接口暂不可用。

资源签名密钥目前在进程内，服务重启后需刷新页面获取新链接；多进程部署需要额外设计共享状态。前端独立模块和移植示例位于 `app/static/vendor/cyan-theme/`。
