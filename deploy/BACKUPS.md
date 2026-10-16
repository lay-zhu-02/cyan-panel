# 部署备份

部署前用 `backup.py` 保存代码 Git bundle、运行配置与凭据、SQLite 一致性快照。
脚本不重复复制 `data/themes/`，也不嵌套复制 `data/backups/`。
凭据与数据库仅保存在服务器，目录权限 700、文件 600，不进 Git 或本地测试。

壁纸素材使用独立的共享备份，先比对文件名、大小和 SHA-256，并在其父目录保存
`manifest.json` 文件清单；只有素材变更时才更新素材备份。
每份部署恢复点的 `wallpaper-backup.json` 记录其素材备份路径。

```sh
python3 deploy/backup.py /opt/cyan-panel \
  /var/backups/cyan-panel/release-YYYYMMDDTHHMMSSZ \
  --wallpapers /var/backups/cyan-panel/wallpaper-assets-TIMESTAMP/themes
```

保留最近三份部署恢复点、一份最初迁移基线和仍被保留版本引用的素材副本。
清理时先校验待保留的数据库、代码 bundle 与素材，明确列出删除目录，确认解析路径
位于 `/var/backups/cyan-panel/` 内；不删除线上运行目录，不把备份目录整体递归备份。
首次迁移基线与不认识的备份不参与自动淘汰。

恢复时先停止面板，按 `previous-commit` 从 bundle 恢复代码，再恢复 `data/`，
根据 `wallpaper-backup.json` 将共享素材复制到 `data/themes/`，修复权限后启动并验证。
无需覆盖当前壁纸时可以保留在线素材；不要用磁盘文件复制代替在线数据库快照。
