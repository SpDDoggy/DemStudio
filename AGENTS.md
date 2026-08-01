# DEM Studio Agent 入口

## 默认 Meta-Skill

- Default Skill: `agent-causal-kernel`
- Default Skill Version: `0.4.3-draft`
- Source Path: `unknown`
- Installed Path: `C:\Users\Administrator\.codex\skills\agent-causal-kernel\v0.4.3-draft`
- Last Validated: `2026-07-27`
- Activation Status: `unknown`

进入本项目处理工程任务时，必须先读取上述 Installed Path 下的 `SKILL.md`，并由它按风险和任务类型路由后续协议。用户当前明确指令和本文件的项目约束优先于通用 Skill；更近路径的 `AGENTS.md` 可以补充或收紧规则，但不得削弱安全、权限、范围锁、验证和高稳定区保护。

## 项目约束

- 修改前先检查真实文件、调用链、现有决策和 Git 工作区，缺少文档不构成重新设计的授权。
- Core、公开 API、数据结构、业务逻辑、兼容性相关配置、构建、CI、依赖锁、迁移、发布及默认入口变更属于高风险；先提交影响、替代方案、验证与回滚说明，取得确认后再执行。
- 删除、覆盖、移动正式资产，安装或联网下载，读取敏感信息，修改生产数据或发布产物，必须取得针对具体动作的明确确认。
- 完成结论必须区分静态检查、自动化测试、构建、运行时和目标平台实机证据；没有对应证据不得宣称已完成。
- 只修改已授权范围；保留用户已有改动，不顺手重构或清理无关文件。

## 当前验证边界

`2026-07-27` 对 Installed Path 执行 `python scripts/validate_all.py`：结构、清单哈希和 17 个 Agent Harness 用例通过；路由检查失败，Forward Tests 尚未运行。失败来自 `check_routes.py` 将协议定义为可选的 `LOCAL_MANIFEST.md` 判为缺失引用。因此，本项目已确认该 Skill 为默认 Meta-Skill，但在路由校验缺陷解决并重新通过完整验证前，Activation Status 保持 `unknown`，不得写成 `active`。

长期决定及回滚依据见 `docs/adr/0003-agent-causal-kernel-as-meta-skill.md`。
