# Paseo Codex Bridge

在 Paseo 中管理真实的 Codex Desktop 会话。作为普通 Provider 使用，支持模型和推理强度选择、流式输出、停止、导入与恢复，以及原生子 agent 列表和归档同步。

- 插件显示名：Paseo Codex Bridge
- 安装 ID：`paseo-codex-desktop`（保留已有安装兼容性）
- Provider：`chatgpt-desktop`，显示为 ChatGPT Desktop
- Paseo 0.11.4 或更新版本；本机 Codex Desktop 必须保持运行。

## 安装与连接

在 Paseo 设置中启用插件，然后安装：

```sh
paseo plugin install github:disturbwe/paseo-codex-bridge
```

插件通过 Codex Desktop 的本地内部接口调用工具。首次使用需要指定一个属于当前用户、本机 Desktop 的调用上下文聊天 ID。可在该 Desktop 聊天中让 Codex 输出 `CODEX_THREAD_ID`。该 ID 只用于工具调用上下文；完成回传的目标聊天由每个绑定单独指定。

配置文件位置：`~/.paseo/plugin-data/paseo-codex-bridge/config.json`。在 Windows，`~` 为当前用户目录；在 macOS，通常为 `/Users/<用户名>`。若 daemon 设置了 `PASEO_HOME`，则使用 `$PASEO_HOME/plugin-data/paseo-codex-bridge/config.json`。

```json
{
  "callerThreadId": "替换为本机 Codex Desktop 聊天 UUID"
}
```

也可克隆仓库后运行跨平台配置脚本：

```sh
git clone https://github.com/disturbwe/paseo-codex-bridge.git
cd paseo-codex-bridge
node scripts/configure.mjs <Desktop聊天UUID>
paseo plugin reload paseo-codex-desktop
```

配置脚本保留原有配置。需要选择特定 daemon 时，所有 Paseo 命令添加 `--host <地址>`。

在 Providers 中启用 ChatGPT Desktop，刷新模型列表；新建 agent 时选择该 Provider 即可。模型来自本机 Desktop 当前可用列表。导入或恢复旧聊天时，可能需要先在 Desktop 中打开它。

## 读图记录

Desktop 的公开 imageView 事件会在 Paseo 时间线显示“已查看 1 张图像”，展开后显示紧凑缩略图和文件名，点击预览打开随窗口大小适配的图片查看器。查看器按原图比例显示图片，支持放大/缩小、缩放百分比、100% 原始尺寸、适应窗口及拖动平移；桌面滚轮围绕鼠标位置缩放，双击切换适应窗口与原始尺寸，触屏支持双指缩放。提供图片尺寸、复制路径及关闭操作；桌面支持 Esc 或点击查看器外关闭。缩放上限为 800%，缩小时不会把图片拖出视野。主会话实时事件、后台原生子任务及历史回放均支持。预览按点击加载，没有定时刷新；只允许读取该会话或其原生后代中真实读图事件引用的文件，不接受任意文件路径。

预览支持不超过 4 MiB 的 PNG、JPEG、GIF、WebP。原图移动或删除后会显示加载失败；同一路径的文件被覆盖时，预览显示当前文件内容。升级前已缓存的历史需要通过 Paseo 的 Reload agent 重新回放；若首次只恢复了旧缓存，可再执行一次 Reload agent。

## 目标状态

Desktop agent 的输入框附近显示“目标 · 未设置 / 进行中 / 已暂停 / 已完成”等状态。点击打开目标面板，查看目标内容和更新时间；也可输入 `/desktop-goal` 或在 Command Center 选择“查看 Desktop 目标”。Desktop 中设置、恢复、完成或清除目标后，面板通过原生会话事件和 Paseo 的认证事件流同步，没有定时刷新。重新打开或重连会读取一次权威快照；断线时明确显示“未同步”，保留的信息可能已过时。没有原生目标数据时不会从普通聊天文本推断目标。

“暂停目标并停止执行”已接入 Desktop 的原生 user-stop 操作；它会暂停活动目标、停止当前轮次并清理后台终端。只有收到 Desktop 的状态变更后才确认结果；暂停失败会报错。该操作不同于只中断某一轮次的普通停止。

当前对照版本的外部会话通道没有专用的目标设置、恢复或清除方法，app-tools 也未提供对应工具；这些操作请用“在 Desktop 中管理”打开原会话完成。插件没有通过普通提示词模拟这些控制，也没有创建额外目标执行循环。本版本只为 ChatGPT Desktop provider 增加目标展示；Paseo 原生 Codex 的 `/goal` 不受影响。

## 原生子 agent 与归档

Desktop 主聊天调用原生 `spawn_agent` 后，子任务显示在 Paseo 输入框上方的 subagent 列表中，可查看独立输出。插件不自动创建 Settings → Agents 中的启动配置。

在主 agent 输入 `/desktop-archive`，或通过 Command Center 的“归档 Desktop 子 agent 会话”打开归档面板。单独归档子会话时，其后代一起归档。归档 Paseo agent 时，其 Desktop 主会话及后代一起归档；归档 Paseo 工作区时，按工作区 ID 回收它所属的会话，保留聊天历史并释放事件/文件监听。其他工作区不会因为目录相同被归档。

最后一个 Desktop agent 归档后，如果其 Paseo 工作区只有已归档的 Desktop agents、没有终端且未置顶，插件会同步归档空工作区，让它从活动侧栏移除。包含其他 Provider、仍有未归档 agent 或属于受管理 worktree 的工作区会保留。旧版本遗留的空工作区可通过后端 RPC `desktop.archive.empty-workspace`，传入 `{ workspaceId }` 执行同样的范围检查与回收。

恢复主 agent 时，同步恢复此前随它一起归档的子会话；用户单独归档的子会话继续保持归档。Desktop 暂时不可用时，插件保存待处理操作，在下一次插件启动/重载或显式归档时重试，没有定时重试循环。Paseo 原生归档对 Provider 失败采用 best effort，Paseo 本身可能已归档而 Desktop 同步仍待处理，需查看插件日志。

## Windows 和 macOS

| 系统 | 工具通道 | 主会话事件通道 |
| --- | --- | --- |
| Windows | `\\.\pipe\codex-app-tools-<UUID>` | `\\.\pipe\codex-ipc` |
| macOS | `/tmp/codex-app-tools/<UUID>.sock` | `$CODEX_HOME/ipc/ipc.sock`，兼容旧的临时目录 socket |

两个系统都使用 Node 的本地 socket、同样的长度帧协议，以及 `fs.watch` 子任务公开 rollout 事件。目录、配置和测试不依赖 PowerShell 或 Windows 安装位置。`CODEX_HOME` 默认 `~/.codex`。

macOS 传输适配依据 Desktop 内部实现编写，仓库 CI 在 Windows/macOS 上执行类型检查和自动测试。Windows 已完成真实 Desktop 会话与归档验证；尚未在实体 Mac 上验证 Desktop 端到端。某些 macOS Desktop 发行版会验证连接进程签名并拒绝第三方客户端，插件无法绕过这种限制。遇到连接被关闭时，应保留日志并核对该发行版的接口可用性。

可在配置中指定 `toolsSocket`、`eventsSocket`，用于多实例或自定义地址。对应 daemon 环境变量：`PASEO_CODEX_BRIDGE_CALLER_THREAD_ID`、`PASEO_CODEX_BRIDGE_TOOLS_SOCKET`、`PASEO_CODEX_BRIDGE_EVENTS_SOCKET`、`PASEO_CODEX_BRIDGE_DATA_DIR`。环境变量优先于配置文件。

## 事件与完成回传

主会话使用 Desktop 的订阅推送，后台原生子任务使用 rollout 文件变化通知。没有任务状态轮询。一次性会话列举、历史分页、用户点击刷新和归档核对属于显式操作。连接断开后报告错误，由用户恢复 agent 或重载插件重新连接。

后端 RPC `desktop.watch-completion` 接受 `{ agentId, threadId, verificationId }`，将已授权的 Paseo 任务完成结果发送到指定 Desktop 聊天。目标正在执行时，等到空闲事件再发送；结束本轮后可由完成消息自动唤醒。用户需授权向目标聊天回传。未知投递结果不会自动重复发送。

## 开发和验证

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run smoke:desktop
```

最后一项需要已运行并完成配置的真实 Desktop，只列举工具/会话并订阅一次聊天快照，不发送消息。CI 只执行前三项，不启动 Desktop，也不使用账号凭据。

## 已知边界

- 使用非公开 Desktop 协议，当前对照版本为 Codex Desktop 26.1013.4894.0、Paseo 0.11.4；更新可能需要协议适配。
- 目标功能已在 Windows、Paseo 0.12.0-beta.2 上验证真实目标创建后的事件展示和原生暂停；设置、恢复、清除的插件控制入口仍未接入。
- Desktop 审批、附件、环境变量与 MCP 设置仍由 Desktop 管理，Paseo 配置不会覆盖它们。
- Paseo 目录匹配 Desktop 已保存项目时使用该项目；否则 Desktop 分配独立聊天目录，可能与 Paseo 目录不同。
- 原生子任务实时同步需要 `collabAgentToolCall/spawnAgent` 事件中的 rollout 路径；仅提供 `subAgentActivity` 而没有路径的版本尚未覆盖。
- 归档同步从显式操作或生命周期事件触发；在 Desktop 里手动归档不会自动反向归档 Paseo 工作区。
- 配置、归档索引、回传记录和日志只保存在本机数据目录，不应提交 Git。插件只展示公开消息、命令输出和生命周期，不复制私有推理。
