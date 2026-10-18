# Paseo Codex Bridge

将真实的本机 Codex Desktop 聊天接入 Paseo 普通 Provider 和 agent。支持选择 Desktop 当前可用模型与推理强度、发送消息、流式输出、停止、导入与恢复；Desktop 原生子 agent 出现在输入框上方的 subagent 列表中。

需要 Paseo 0.11.4 或更新版本，并保持 Codex Desktop 运行。首次连接需在本机插件数据目录的 config.json 中配置 callerThreadId，详见仓库 README。插件显示名为 Paseo Codex Bridge，安装 ID 保留 paseo-codex-desktop，Provider ID 为 chatgpt-desktop，显示为 ChatGPT Desktop。

## 读图展示

同步 Desktop 的真实读图事件，显示“已查看 1 张图像”。展开显示缩略图和文件名，点击打开图片查看器，支持放大/缩小、100% 原始尺寸、适应窗口、拖动、滚轮缩放和双击切换；支持实时同步和历史回放。预览按需读取当前图片文件，支持不超过 4 MiB 的 PNG、JPEG、GIF、WebP。文件移动、删除或覆盖会影响预览。升级前缓存的聊天可用 Reload agent 重新回放。

## 目标状态

Desktop agent 输入框旁显示目标状态，点击或使用 /desktop-goal 可查看目标内容、更新时间和连接状态。目标变更通过 Desktop 与 Paseo 事件流同步，重连读取一次快照，没有状态轮询。支持“暂停目标并停止执行”，使用原生 user-stop 暂停目标并停止当前执行、清理后台终端；只有原生状态确认后才视为成功。设置、恢复和清除暂未发现可用的外部接口，通过“在 Desktop 中管理”回到原会话操作，结果自动同步。断线保留目标信息并标记未同步。

## 子会话归档

主 agent 输入 /desktop-archive 或在 Command Center 选择“归档 Desktop 子 agent 会话”，可单独归档原生子会话及其后代。归档 Paseo agent 或工作区时，自动归档其所属 Desktop 主会话和后代，保留历史并释放订阅。工作区范围按 ID 确定，不根据共享目录扩大范围。

最后一个 Desktop agent 归档后，未置顶且无终端、只含已归档 Desktop agents 的普通本地工作区也会自动归档，避免侧栏残留空行。包含其他 Provider 或未归档 agent 的工作区，以及受管理 worktree 会保留。

恢复主 agent 时，同步恢复随它归档的子会话；单独归档的子会话继续保持归档。同步失败保存本地待处理记录，下次插件启动、重载或显式归档时重试。Paseo 自身的归档可能先完成，Desktop 同步失败需查看插件日志，没有定时重试循环。

## 系统与连接

支持 Windows 命名管道和 macOS Unix socket 传输；后台子任务通过 fs.watch 文件变化通知同步公开消息、命令和生命周期，无任务状态轮询。Windows 已真实验证；macOS 传输和自动测试已适配，尚待真实 Desktop 端到端验证。部分 macOS 发行版的连接进程签名限制可能拒绝第三方客户端，插件无法绕过。

协议对照版本为 Codex Desktop 26.1013.4894.0 和 Paseo 0.11.4。Desktop 更新可能改变内部接口。权限审批、附件、环境变量和 MCP 设置由 Desktop 管理。恢复旧聊天可能需要先在 Desktop 打开它；没有匹配已保存项目的新聊天由 Desktop 分配独立目录。

子任务实时同步依赖原生 spawnAgent 事件中的 rollout 路径，仅有 subAgentActivity 而无路径的版本尚未覆盖。Desktop 中手动归档尚不反向归档 Paseo 工作区。

后端可将用户已授权的 Paseo 任务完成事件发送到指定 Desktop 聊天，目标忙碌时等空闲事件再投递，从而自动唤醒聊天。配置、回传绑定、归档索引和日志只保存在本机插件数据目录。私有推理、系统和开发者消息不进入 Paseo 时间线。
