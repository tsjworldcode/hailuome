# `db/migrations/` — 搬家 staging 全表 schema（A7-DB-RETIRE）

> **权威运行时目录**（业务读写）：
> - **`db/migrations-identity/`** — IDENTITY_DB
> - **`db/migrations-governance/`** — GOVERNANCE_DB
> - **`db/migrations-content/`** — CONTENT_DB
> - `db/messaging-migrations/` / `db/messaging-shard-migrations/` — 不动
>
> 完整归属见 [`../../../docs/m-opt-split-plan.md`](../../../docs/m-opt-split-plan.md) §3.3。  
> **DB_IMPORT 评估**：[`../../../docs/m-opt-split-a7-db-import-eval.md`](../../../docs/m-opt-split-a7-db-import-eval.md)。

## 本目录谁还在用

| Binding | 是否引用本目录 | 说明 |
|---|---|---|
| **`DB_IMPORT`** | ✅ **必须** | M9-7 搬家 staging：**单库全表**容器；正规 `POST /api/node/import` 整包写入。schema 必须是 IDENTITY∪GOVERNANCE∪CONTENT 并集，**不能**改挂仅 `migrations-identity` |
| **`DB`** | ❌ **已移除**（A7-DB-RETIRE） | wrangler 三 env 已无 `binding = "DB"`；切流改为 `POST /api/node/import/promote-staging` |

## 不做什么

- ❌ 不要在本目录新增 migration（新表写入 identity/governance/content；staging 同步策略另议）
- ❌ 不要修改本目录内既有 `.sql`
- ❌ 不要把 `DB_IMPORT` 的 `migrations_dir` 改成只挂三库之一
- ❌ 不要把 `binding = "DB"` 加回 wrangler（除非有新评估文档）

## 切流（A7-DB-RETIRE）

1. staging 对账 `import_ready=true`
2. `POST /api/node/import/promote-staging`（或 `scripts/cutover-db-import.ps1`）按表灌入三库
3. deploy：`migrations apply DB_IMPORT` + IDENTITY/GOVERNANCE/CONTENT（不再 apply DB）
