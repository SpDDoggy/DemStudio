# ADR-0003：采用 Agent Causal Kernel 作为默认 Meta-Skill

- 状态：已确认并建立入口
- 日期：2026-07-27
- 决策来源：用户明确要求并确认影响评估

## 背景

DEM Studio 已有前端、Tauri 宿主、Rust DEM Core、测试、构建脚本、迁移契约和跨平台发布边界，但项目根目录此前没有 `AGENTS.md` 或 `Agent.md`。后续 Agent 因而没有稳定的项目级治理入口，无法仅凭仓库状态确定高风险变更、权限确认、验证分层和因果回写规则。

## 问题

项目需要一个默认 Meta-Skill 来约束工程任务如何读取现状、控制范围、处理高稳定区、验证结果并记录长期决定。该入口必须保持轻量，不能复制完整协议，也不能把尚未通过验证的本机 Skill 虚报为已经完全激活。

## 最终决定

在项目根目录建立 `AGENTS.md`，将以下本机路径声明为 DEM Studio 的默认 Meta-Skill：

```text
C:\Users\Administrator\.codex\skills\agent-causal-kernel\v0.4.3-draft
```

Agent 进入项目后必须先读取该路径下的 `SKILL.md`，再按任务和风险加载必要的协议。`AGENTS.md` 只保存每次进入项目都必须知道的入口和硬约束，功能行为继续归属产品文档，架构决定继续归属 ADR，验证事实继续归属测试或验证记录。

由于当前完整验证没有全部通过，入口中的 `Activation Status` 标记为 `unknown`。这表示“默认治理选择已经确认”，不表示“Skill 的全部路由和 Forward Tests 已验证通过”。

## 因果理由

- 项目已有 Core、宿主、发布矩阵和迁移边界，错误的范围扩张可能同时影响业务语义与多平台交付。
- 项目级入口能让后续 Agent 在写入前看到同一组权限、范围、验证和高稳定区规则。
- 将完整流程保留在 Skill 内，可以避免 `AGENTS.md` 膨胀为项目百科。
- 如实保留 `unknown` 状态，可以阻止“文件存在”等同于“协议已完整验证”的错误推断。

## 替代方案与放弃原因

### 不建立项目入口

依赖每次会话手工指定 Skill，无法保证后续任务稳定进入同一治理链。

### 将完整 Skill 内容复制进仓库

会产生双重来源和版本漂移；项目入口只应引用默认 Skill 并保存项目级硬约束。

### 立即标记为 `active`

当前证据不足。`validate_all.py` 的路由检查失败，Forward Tests 也尚未运行，标记为 `active` 会制造虚假完成状态。

### 同时修复或替换已安装 Skill

这会把项目入口变更扩大为 Skill 源协议或安装路径变更，超出本次确认范围。

## 约束与影响

- 用户当前明确指令优先于项目入口；项目入口优先于通用 Skill。
- 子目录入口只能补充或收紧根规则，不能削弱安全、权限、验证和高稳定区保护。
- 本 ADR 不改变 DEM Studio 的产品方向、业务逻辑、Core/API、数据结构、构建配置或发布状态。
- 本机绝对路径不可直接证明其他机器已安装相同 Skill；跨机器使用时必须重新核验路径和版本。
- `0.4.3-draft` 是预发布版本，升级或更换默认版本需要新的影响评估与用户确认。

## 验证

2026-07-27 在指定 Installed Path 执行：

```powershell
python scripts/validate_all.py
```

结果：

- `check_structure`：通过，134 个必需文件、17 个 Agent 用例、10 个 Forward 用例存在；
- `check_manifest_hashes`：通过；
- `run_agent_harness`：通过，17/17；
- `check_routes`：失败；
- Forward Tests：`NOT_RUN`。

路由失败的直接原因是 `check_routes.py` 把反引号中的 `LOCAL_MANIFEST.md` 当作必须存在的本地引用，而协议与 Manifest 明确规定该文件是可选本机状态资产。这是校验器与协议可选性之间的不一致；本 ADR 不修复该 Skill。

项目侧验证要求：

- 根目录只存在一个已确认主入口 `AGENTS.md`；
- 默认 Skill 名称、版本、路径、日期和激活状态字段齐全；
- `AGENTS.md` 能链接到本 ADR；
- 本次 Git 差异只包含本 ADR 和根入口。

## 可推翻条件

- 用户决定更换或停用默认 Meta-Skill；
- 指定路径失效、版本被替换或与项目需要不兼容；
- Skill 的治理成本持续高于其风险控制收益；
- 项目采用了经确认的其他治理入口。

## 回滚与同步

回滚时删除本次新增的根目录 `AGENTS.md` 和本 ADR，即可恢复到此前没有项目级默认 Meta-Skill 的状态；不需要修改业务代码或用户数据。若以后修复 Skill 校验并通过完整验证，应同步更新 `AGENTS.md` 的 `Last Validated`、`Activation Status`，并在本 ADR 或后续 ADR 中记录证据。若更换默认 Skill 或路径，必须重新确认，不得静默覆盖。
