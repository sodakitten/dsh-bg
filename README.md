# dsh-bg

给 **DeepSeek Harness** 用的本地背景插件：图片 / 视频壁纸、画面裁切、界面透明度、背景轮播。

**不含任何出站网络请求** —— 这是它和上游 `beauticode-dsh` 最主要的区别。

> A local-only background plugin for DeepSeek Harness. Image/video wallpapers, visual
> framing, interface transparency and a background carousel — with no outbound
> network requests at all. Fork of `beauticode-dsh` (MIT); see [NOTICE](./NOTICE).

---

## 派生说明

本项目派生自 [beauticode-dsh](https://github.com/starsstreaming/beautiCode)（MIT）。
原版权声明与 `LICENSE` 均已保留，具体改动列在 [NOTICE](./NOTICE)。

`themes/internal-beyond/` 下的内置壁纸来自上游，随上游一并分发。

---

## 特性

### 去联网

删除了上游的在线皮肤中心（`gallery.js` / `gallery-host.mjs` / `skin-center.json`
以及 `/__beauticode/ui/gallery/*` 路由），**全插件没有任何出站请求**。

### 画面裁切

上游用 `object-fit: cover` 居中裁切，你无法选择保留哪一部分。本插件改为把媒体元素
放大到 `cover` 应有的尺寸再做变换，因此可以自由平移与缩放，够得到 `cover` 本来会丢弃的区域。

- **抽屉式**，默认收起 —— 编辑面不占面板第一层，避免误触
- **只用滑块缩放**（滚轮的误触代价太大，已移除）
- **重置按钮在行上**，一键回默认并持久化
- **画窗预设下也生效** —— 该预设有自己的一层背景，裁切会作用到实际显示的那一层

### 界面透明度

- **侧边栏跟随内容**（默认开）—— 左栏与右栏共用同一层材质
- **工作时浓度**（默认 150%）—— 开始对话后界面变实，可调
- **弹窗浓度固定** —— 对话框是前景面，不随浓度滑块缩放，否则背后的正文会透上来叠字

### 窗口控制区透明

Windows 的原生窗口控制区（右上角最小化/最大化/关闭）底色来自网页探针。
本插件把探针色设为 `rgba(255,255,255,0.01)` —— Electron 44 兑现 alpha，
于是那三个按钮不再有白块，壁纸完整透出。

### 输入框磨砂

输入框是半透明的，滚动时聊天记录会和输入框文字叠在一起。本插件模糊输入框**背后**的内容
并加一层薄底，字不再打架；**DSH 提问时的提问卡片同样覆盖**。

### 背景轮播

- **分组**：新建 / 改名 / 删除，一个分组就是一个轮播列表
- **背景项**：从**已保存主题**和**内置预设**里挑选，可排序、可移出；失效项会划掉并标注
- **间隔**：5 秒 – 24 小时
- **顺序 / 随机**：随机模式不会连续抽到同一张
- **下一张**：手动推进
- **启用即应用**：打开开关立刻应用第一张，而不是空等一个间隔
- **每张背景各自记住自己的裁切** —— 轮播切换时带着各自的构图上场

### 其它

- 面板内「刷新页面」按钮 —— DSH 桌面版本身没有任何刷新入口
- 已移除上游的「自动全屏」（保留手动全屏）

---

## 安装

需要 DSH 的 `desktop` profile。插件是**源码形式**安装的，不是拖进应用里。

```powershell
dsh plugin --profile desktop add file:<解压路径>\dsh-bg
```

**必须同时存在** `%LOCALAPPDATA%\beautiCode`（DSH 侧的数据目录）——
背景、已保存主题、轮播分组都在那里，不在插件包内。

装好后在 **设置 → 背景** 里使用。

### 注意

- **服务端代码**（`index.mjs` / `ui-host.mjs` / `carousel.mjs` / `browser-injection.mjs`）
  只在 DSH 进程启动时加载一次 —— 改这些需要**完全退出并重启 DSH**。
- **客户端脚本**（`client.js` / `console.js` / `framing.js` / `atmosphere.js`）
  每次请求重读，**刷新页面**即可。

---

## 一些实现上的取舍

这几处不是随手写的，值得记下来：

### 一个自定义属性挂在公共祖先上的代价

`--dsw-specific-sidebar-fill` 在 Windows 上有**四个**消费者（见
`dsh-client-ui-layout/lib/client.js`）：窗口底衬 `.BynINW_frame`、40px 顶栏
`.BynINW_frame:before`、左侧栏 `.BynINW_sidebarCol`，以及侧栏模块根 `._2H3hWW_root`。

自定义属性会向下继承并遵循层叠，所以把它声明在 `body` 上等于同时改这四处。
「侧边栏跟随内容」原本正是这么写的 —— 关掉时整个窗口底衬一起回落，
观感是"整个界面变实"，而不是"侧边栏变了"。

现在别名在**开**时仍声明在 `body`（保持原有观感），在**关**时下移到侧边栏列，
值直接采用 beautiCode 自己的公式。声明在列上就只影响列子树，祖先 `_frame` 不受影响。

### 子串选择器只在"另一半唯一"时才安全

修上面那条问题时，有一版用 `[class*="_frame"]` 去选布局框架 —— 结果在聊天记录上蒙了一层白。

因为 `_frame` **不唯一**：构建产物里有 **11 个**类名含它，分布在 8 个模块中，
其中 `dsh-client-ui-chat` 里也有。

同一批探针里 `_sidebarCol` 只有 **1 个**，可以这么用；`_frame` 不行。
判断标准是"另一半是否唯一"，不是"我这次是否匹配上了"。

### 同一类错误在上游代码里也有一个

`client.js` 里带着一条：

```css
html[data-bc-active="true"] [class*="_fade"]{display:none!important}
```

作者以为 `_fade` 是"淡入装饰"。构建产物里含它的类只有 5 个，而且**分成两种东西**：

```
_fadeTop / _fadeBottom   滚动边缘遮罩，由标记加在【滚动元素自己】身上
_fade                    独立装饰层（会话列表底部那 24px 渐变）
```

`ChatGroupSeat`（可折叠的推理分组）把 `fadeTop` / `fadeBottom` 加在**承载展开体的同一个 `div`** 上 ——
于是 `display:none` 在滚动边缘变化时把整个推理块隐藏掉 ✓ 而推理流式输出期间这个标志一直在翻 ✓
表现为**思考块不停地开合闪屏** ✓

修法是**缩小范围**而不是删掉：

```css
[class*="_fade"]:not([class*="_fadeTop"]):not([class*="_fadeBottom"]){display:none!important}
```

我第一版直接删了整条规则 —— 结果连那个装饰层也回来了 ✓ 侧栏底部冒出一个白色渐变方块 ✓
**"误杀"的正确处理是收窄条件，不是取消规则。**

### 关于背景磨砂边缘那圈亮边

`filter: blur()` 会**采样元素边界之外** ✓ 而背景图是满屏铺满的 ✓
于是最外圈像素混合到透明 ✓ 背后的页面底色（白）透出来 ✓ 成为细细一圈亮边 ✓

这是 `filter: blur` 的固有行为 ✓ **不是故障** ✓ 但如果不想看到 ✓ 让模糊层**溢出视口**即可：

```css
html[data-bc-gallery="true"] #beauticode-gallery-bg img{
  filter:blur(var(--bc-bg-blur,0px));
  transform:scale(1.06);   /* 把淡出的那一圈推到视口外 */
}
```

（模糊半径越大，需要的溢出越多 ✓ 所以按最大半径给余量 ✓）

### 裁切为什么能跟着轮播走

轮播调用 `actions.useTheme` / `actions.applyPreset` —— 就是面板点击时调的同一批动作。
客户端按**身份**存构图（主题 `theme:<id>`、预设 `atmo:<id>`、裸图 `src:<path>`），
所以切换落地后，新背景带着自己的那份上来，**不需要为轮播写任何裁切代码**。

### 切换时的时序

背景切换时，媒体元素会被替换。缓存命中的图片**立刻就能测量**，
所以先绘制、后取身份的话，会用**上一张的构图**先画一帧 —— 大约三分之一秒后才纠正。

现在的顺序是：**先取身份、装好 frame、再绘制**。

---

## 开发

```
index.mjs              插件入口，注册路由与浏览器注入
ui-host.mjs            UI 路由 + 轮播引擎接线 + 身份持久化
carousel.mjs           轮播引擎（分组、游标、跳过失效项、上限保护）
framing.js             注入到页面：画面裁切、界面透明度、轮播面板、若干运行时探测
console.js             注入到页面：背景设置页的整体框架
client.js / atmosphere.js / transport.js   上游的桥接与氛围层
vendor/                DSH 适配器与核心（媒体服务、应用事务、存储）
themes/                内置壁纸
```

测试分三层，缺一层都会漏东西：

| 层 | 覆盖什么 |
|---|---|
| 引擎单测 | 轮播引擎自身：持久化、悬空跳过、间隔钳制、随机不重复、省略字段不被重置 |
| 源码级身份链校验 | 裁切兼容所依赖的那串不变量：主题 id 的产生与透传、预设身份、持久化契约、客户端优先级 |
| 路由形状集成测试 | 接口实际返回什么（改动接口把状态嵌在 `state` 里、GET 是平铺的 —— 这一层就是为了抓这类不一致） |

### 打包白名单是个陷阱

`package.json` 的 `files` 决定 `file:` 依赖安装后**哪些文件真的会到**。
pnpm 按它过滤 —— 没列进去的文件不会出现在 `node_modules\dsh-bg\` 里。

**5.3.0 就栽在这上面**：`carousel.mjs` 没进白名单 ✗，而 `ui-host.mjs` import 它 ✓，
于是**全新安装启动即 `ERR_MODULE_NOT_FOUND`** ✓

本地一直没发现，是因为改完是**手工复制**到 profile 的 ✓ —— 那条路绕过白名单 ✓
校验永远通过 ✓ —— **要测的是"按包定义干净安装一次"，而不是复制** ✗

改完白名单或增删源文件后跑一次：

```sh
node tools/verify-package.mjs
```

它展开 `files` 与真实目录比对 ✓ 并逐条检查每个相对导入的目标是否**既在磁盘上、又被白名单覆盖** ✓
（后者才是真正会让启动崩掉的那一类 ✓）

---

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-bg
```

## 安全边界

与上游一致：控制端点仅接受同源请求；媒体 URL 只允许带令牌的回环地址。

本插件**不含任何出站请求**，唯一的 `fetch` 是向 `127.0.0.1` 自己的回环端口。

### 一个容易删错的同名物

包里还有个叫 `gallery` 的东西 —— `builtin-gallery` 内置主题（画窗），以及
`effectsForPreset("gallery")` 氛围预设。那是**本地**的、不联网，**被保留了**。

被移除的只有**在线皮肤中心**：`gallery.js` / `gallery-host.mjs` / `skin-center.json`，
以及 `/__beauticode/ui/gallery/config|catalog|install` 和 `/__beauticode/gallery.js`。
（上游的 `skin-center.json` 出厂就指向第三方站点，会拉取远程目录并下载安装皮肤。）

---

## 许可

MIT，见 [LICENSE](./LICENSE)。派生自 `beauticode-dsh`，原版权保留，见 [NOTICE](./NOTICE)。
