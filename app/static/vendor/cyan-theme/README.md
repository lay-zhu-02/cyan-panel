# Cyan Theme v1

无框架、无构建步骤、无 panel API 依赖。`core.js` 管理状态、CSS 变量、持久化和壁纸生命周期；`settings.js` / `settings.css` 是可选设置面板；`theme.css` 提供背景层。主题包不读取账号、Cookie、文件管理或终端状态。

## 移植

复制本目录到另一个项目，加载 `theme.css`、`settings.css`、`core.js`、`settings.js`。`example.html` 是可独立运行的示例，使用普通 HTTP 静态服务器打开即可，不需要 panel 后端。

```js
const theme = new CyanTheme({storageKey:'your-app.appearance.v1'});
theme.start();
const settings = new CyanThemeSettings(theme, {
  trigger: document.querySelector('#your-appearance-button'),
  loadCatalog: async () => ({schema:1, items:yourWallpapers}),
});
```

宿主用 CSS 将自身语义变量映射到 `--ct-base`、`--ct-surface`、`--ct-shell`、`--ct-raised`、`--ct-input`、`--ct-fg`、`--ct-muted`、`--ct-line`、`--ct-accent`、`--ct-accent-soft`、`--ct-danger`、`--ct-success` 等；按钮填充使用 `--ct-accent-solid` 搭配 `--ct-on-accent`。背景层位于 body 的隔离层中，不操作宿主 DOM 内容。透明度默认 18%，可设 0–100%；背景透明度 `backgroundTransparency` 为独立的 0–100%，直接控制背景遮罩：0% 为纯色，100% 为无遮挡的原始壁纸。旧浏览器偏好的 `wallpaperOpacity` 字段会沿用数值，后续保存为新字段。

`theme.update({mode:'light',accent:'#34d399',transparency:30})` 即时修改。模式可为 `dark`、`light`、`auto`。设置自动保存；同源跨标签页同步；存储不可用时仍在当前页面生效。不提供设置文件导入导出；持久化仍沿用 `cyan-theme/v1` 存储格式，保留已有偏好。`theme.reset()` 恢复默认。

预设现在是包含四个协调颜色的配色方案，选择或自定义 accent 会同步生成明暗适配的数据色和中性表面。图表 token 为 `--ct-chart-cpu`、`--ct-chart-memory`、`--ct-chart-rx`、`--ct-chart-tx`、`--ct-chart-read`、`--ct-chart-write`、`--ct-chart-load`；同一指标在曲线、图例和 SVG 中使用同一 token。成功 / 警告 / 危险的语义独立保留。`CyanTheme.palette(accent,mode)` 返回四个适配后的颜色，预设 `colors` 数组可用于多色色板预览，无需更换存储格式。

设置 UI 可传 `title`（默认“主题与壁纸”），宿主可将它作为“设置”中的外观区；`open()` 记录实际触发控件，关闭时恢复焦点，支持宿主多个设置入口。模块仍不包含 panel 的 DOM 选择器或 API。

界面透明度统一影响 `--ct-surface`、`--ct-shell` 和 `--ct-raised`，100% 时这些表面 alpha 为 0；`--ct-blur` 同步由 18px 降至 0，宿主可用作表面 backdrop-filter。输入与浮层可使用实色 `--ct-input` 保持可操作性；系统减少透明度的偏好仍生效。两个透明度控件相互独立，100% 偏好可保存、重载和跨标签同步。

选择壁纸后，字色根据 `transparency × backgroundTransparency` 渐进增强：正文接近当前模式的黑 / 白，辅助色适度增强但保留层级。`--ct-text-shadow` 仅在深色高透明时提供单层、最高 18% 的黑色轻投影；浅色、无壁纸、实色界面或壁纸隐藏时为 none。文字、图标与 Canvas 不加反向描边或发光滤镜；实色浮层、输入框、主按钮和终端取消继承的文字投影。此机制不采样图片 / 视频像素，不访问隔离 Web，也不改变表面 alpha、壁纸遮罩或媒体滤镜；不保证任意壁纸上的文字对比度。

订阅 `change`、`catalog`、`warning` 事件；关闭账号或页面时可 `suspend()`，重新进入时 `start()`，卸载时 `destroy()`。设置面板也有 `destroy()`，没有强制全局路由或框架状态。

## 壁纸清单

```json
{"schema":1,"items":[{"id":"my-wallpaper","title":"名称","kind":"video","render":"video","source":"/media/clip.mp4","preview":"/media/cover.jpg","note":"静音循环"}]}
```

`render` 为 `video` / `web` / `image` / `none`。`kind` 保留原项目类型。`setCatalog(items)` 只接受配置的 `allowedOrigins`（默认当前源）下的 HTTP(S) 资源。设置只保存 `wallpaperId`，跨项目时由宿主提供匹配素材。

视频静音循环，后台暂停；遵循系统减少动态效果偏好，用户可显式选择播放。Web 使用仅允许脚本的 opaque-origin iframe，不开启 same-origin、表单、弹窗或顶层导航权限；暂停时卸载 iframe 并显示封面，恢复时重新载入。导入 Web 的服务端也必须提供隔离 CSP 和资源白名单，不能仅依赖 iframe 属性。宿主的全局键盘 / history 事件与主题模块相互独立。

## panel 适配层

`../../theme-panel.js` 负责实际 API、登录生命周期和按钮接入；`../../theme-panel.css` 负责宿主变量映射。后端 `theme_engine` 是标准库导入器，`app/themes.py` 是 FastAPI / 登录适配器，两者可分开移植。用户素材不在这个目录，不随代码发布。

背景透明度与界面透明度分开调整；背景 100% 时完整显示清晰壁纸。“不使用壁纸”是图库首张特殊卡片，选中后保留纯色背景，原有 12 张壁纸不变。

视频首次加载直接等待真实首帧，不使用图库缩略图作播放前 poster，避免方形 / 裁切封面切换到宽屏视频时出现视觉缩放。等待期间显示主题底色，媒体容器始终固定铺满视口；解码失败仍回退封面，减少动态效果 / 关闭动态时仍使用静态封面。
