# cyan-panel

轻量 Linux 服务器管理面板，基于 FastAPI、SQLite 和原生 HTML / CSS / JavaScript，无前端构建步骤。

- 资源概览：CPU、内存、磁盘、网络与进程监控。
- 文件管理：文件树、搜索、上传下载、编辑，以及文件夹占用统计。
- 系统信息：磁盘分类分析、网络信息与操作记录。
- SSH 会话查看和断开、Web 终端与终端会话管理。
- 明暗模式、成套配色、透明度设置、动态壁纸和手机布局。

当前版本：**0.2.0**。面板使用独立数据库和运行环境，不依赖其他站点业务。

## 安装

适用于 Linux，建议 Python 3.11 或更新版本。以下为 Debian / Ubuntu 示例，在管理员终端执行：

```bash
apt install -y git python3-venv
git clone https://github.com/lay-zhu-02/cyan-panel.git /opt/cyan-panel
cd /opt/cyan-panel
python3 -m venv venv
venv/bin/pip install -r requirements.txt
cp data/config.example.json data/config.json
chmod 600 data/config.json
venv/bin/python -m app.cli user-add admin '替换为至少8位的强密码'
install -m 644 deploy/cyan-panel.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now cyan-panel
```

默认只监听 `127.0.0.1:8899`。可先通过 SSH 隧道访问：

```bash
ssh -L 8899:127.0.0.1:8899 user@your-server
# 本地浏览器打开 http://127.0.0.1:8899
```

公网使用时，请配置自己的 HTTPS 反向代理，并限制管理入口访问。Web 终端以服务用户身份运行，默认服务用户为 root。

## 环境适配

- **域名与代理**：参考 [Nginx 示例](deploy/nginx.example.conf)，替换域名并配置 HTTPS；保留 WebSocket 转发。使用可信反向代理时开启 `trust_proxy`。
- **安装位置**：自定义目录时，同步修改 systemd 单元中的 `WorkingDirectory`、`ExecStart` 和 `Documentation`。默认从代码根目录读取 `data/`；`CYAN_PANEL_BASE_DIR` 覆盖的是应用根目录，包含静态文件与数据。
- **文件和终端范围**：在 `data/config.json` 修改 `file_root`、`terminal_cwd`、`terminal_shell`、`terminal_max`。修改后端配置后重启服务。
- **静态资源**：修改前端后执行 `bash panel.sh bump`，统一更新主题、图标等资源版本；纯静态修改无需重启服务。
- **进程数**：当前使用单进程；采样、扫描任务和终端会话保存在进程内，不直接配置多个 worker。

常用命令：`bash panel.sh status` 查看状态，`bash panel.sh logs` 查看日志，`bash panel.sh restart` 重启面板。

## Wallpaper Engine 壁纸

支持从本机的 Wallpaper Engine 项目目录导入，项目需包含 `project.json`：

| 项目类型 | 支持范围 |
|---|---|
| Video | 浏览器可解码的视频，静音循环播放 |
| Web | 在隔离 iframe 中运行 HTML / CSS / JavaScript |
| Scene | 显示项目封面，不运行 Wallpaper Engine 原生场景 |

```bash
cd /opt/cyan-panel
venv/bin/python tools/import_wallpapers.py /path/to/myprojects --library data/themes/library
```

导入后刷新面板，在「设置 → 外观」选择。Web 项目的桌面专有接口、音频响应等原生功能不保证兼容；这不是完整的 Wallpaper Engine 运行时。

**仓库不包含任何壁纸、视频或预览素材**，这些文件均被 `.gitignore` 排除。请自行准备有权使用的素材；导入不会修改原始项目。没有壁纸时可正常使用纯色主题，壁纸库异常也不会阻止面板启动。

主题模块可独立移植，见 [Cyan Theme](app/static/vendor/cyan-theme/README.md)；离线导入器见 [theme_engine](theme_engine/README.md)。

## 项目结构

```text
app/             后端功能与前端静态文件
theme_engine/    可独立使用的壁纸导入器
tools/           离线导入与静态版本工具
deploy/          服务单元、代理示例与备份工具
data/            本机配置和运行数据，仅发布配置示例
```

账号、会话与审计数据保存在本机 SQLite 中。配置、凭据、数据库、测试和本地运维记录不纳入版本管理；备份说明见 [deploy/BACKUPS.md](deploy/BACKUPS.md)。
