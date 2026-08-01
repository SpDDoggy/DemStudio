# 测试分层

- `unit/`：纯函数、渲染策略、地形几何、光照和驻留逻辑。
- `contracts/`：页面结构、设置语义和静态绑定契约。
- `perf/`：性能样本生成与独立验证工具。
- `fixtures/`：Runtime Harness 使用的确定性输入。

Node 测试通过根目录 `npm run verify` 执行；Python 性能工具测试单独执行。
