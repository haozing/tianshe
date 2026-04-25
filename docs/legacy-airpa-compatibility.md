# Legacy Airpa Compatibility

日期：2026-04-25

本文档记录拆分后的 Tianshe client 中仍保留的 `airpa` 标识。结论是：这些名字不是新的产品边界，而是兼容层。后续迁移时先补新名字，再保留旧名字一段窗口，最后按 release note 移除。

## 保留原则

可以保留：

- 数据库表、历史字段、迁移记录、缓存 key、旧用户数据目录中已经落盘的标识。
- 对外自动化脚本可能仍在使用的 CLI flag，例如 `--airpa-*`。
- 历史插件协议、浏览器扩展消息、trace header，例如 `x-airpa-trace-id`。
- 测试 fixture 里的旧实体名，例如 `airpa_contact`，只要它不是产品文案。

应该迁移：

- 新增 UI 文案、帮助文档、错误提示中的产品名称。
- 新增云端接口、云端 catalog、云端 runtime、部署配置中的产品 namespace。
- 新增 IPC channel、preload API、renderer store 名称，除非正在做显式兼容桥。

## 双名策略

新能力优先使用 `tianshe` 命名。若旧自动化或旧插件仍依赖 `airpa` 名称，按以下顺序处理：

1. 增加新入口，例如 `--tianshe-http-port`。
2. 保留旧入口，例如 `--airpa-http-port`，内部归一到同一配置对象。
3. 在 release note 中声明旧入口进入兼容期。
4. 有真实迁移窗口后，再移除旧入口。

## 当前兼容清单

- CLI：`--airpa-enable-http`、`--airpa-http-port`、`--airpa-user-data-dir`。
- Headers / meta：`x-airpa-trace-id`、`airpa/toolSurface`。
- 临时目录：`airpa-cloud-plugin-install`、`airpa-cloud-browser-extension-install`。
- 插件和扩展消息：`airpa-get-relay-config`、`airpa-exec`。
- 测试 fixture：`airpa_contact` 等历史实体代码。

## 边界要求

- open 仓可以保留本地兼容标识，但不能重新引入真实私有云实现。
- private overlay 可以消费兼容标识，但新增云端协议必须走 Tianshe cloud namespace。
- 兼容标识不能作为新产品文案继续扩散。
- 每次新增 `airpa` 字符串时，需要能归类到“历史兼容”或“测试 fixture”。
