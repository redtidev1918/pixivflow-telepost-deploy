# TelePost RBAC Evolution Plan

Status: PLANNED
Scope: TelePost
Type: Architecture evolution / RBAC model

---

# 1. 当前实际模型

```text
普通用户
  ↓
submitter

ADMIN_IDS
  ↓
reviewer / 管理员

OWNER_ID
  ↓
admin / owner（拥有 reviewer 全部能力 + owner-only 敏感操作）
```

事实：

- `ADMIN_IDS` 是逗号分隔列表，可多个管理员。
- `OWNER_ID` 是单值，一个 Bot 只能有一个 Owner。
- `OWNER_ID` 自动进入 reviewer/admin 集合。
- 多 Bot 部署支持 `BOT1_OWNER_ID / BOT1_ADMIN_IDS`、`BOT2_OWNER_ID / BOT2_ADMIN_IDS`。
- 当前实现等价于：

```text
reviewer_ids() = OWNER_ID + ADMIN_IDS
admin          = OWNER_ID only
can_administer() 只认这个高级 role
```

Linux 类比：

```text
OWNER_ID  ≈ root
ADMIN_IDS ≈ privileged operators / sudoers
普通用户   ≈ normal users
```

区别：`ADMIN_IDS` 不是真 sudo，是固定 RBAC 的“角色”，不能临时提升成 Owner。

---

# 2. 不做的事

- 不简单把 `OWNER_ID` 改成 `OWNER_IDS` 并让所有 Owner 拥有无差别 root 权限。
- 不把权限永久绑死环境变量作为最终形态。

---

# 3. 目标模型

```text
                    TelePost RBAC

                       ROOT
                        │
                 break-glass owner
                        │
              ┌─────────┴─────────┐
              │                   │
            ADMIN              REVIEWER
              │                   │
      系统/用户/API治理          审核投稿
      Moderation                approve
      配置策略                  reject
      权限管理                  refetch
              │
              └─────────┬─────────┘
                        │
                     SUBMITTER
```

对应 Unix：

```text
root
  ↓
sudoers（可临时提升到 root 执行）
  ↓
groups / permissions
  ↓
users
```

角色清单：

```text
owner
admin
reviewer
submitter
service
```

原则：

- 保留一个真正 break-glass root Owner。
- 多个管理员相当于 sudoers，而不是多个无法约束的 root。

---

# 4. Role Binding

最终形态应逐渐从环境变量迁移到显式 Role Binding：

```text
Principal
├── telegram:123
│     └── owner
├── telegram:456
│     └── admin
├── telegram:789
│     └── reviewer
└── service:pixivflow
      └── submission_service
```

---

# 5. Permission 清单

```text
review.read
review.approve
review.reject
review.refetch

submission.read_all

moderation.manage
api.manage
user.manage

system.status
system.policy

rbac.manage
```

角色默认授予：

```text
owner  → *
admin  → moderation.*, api.*, user.*, review.*
reviewer → review.*
submitter → submission.create, submission.read_own
```

---

# 6. 迁移顺序

```text
现在：OWNER_ID + ADMIN_IDS
  ↓
Role Binding（Principal → Role）
  ↓
owner / admin / reviewer / submitter / service
  ↓
Permission
  ↓
Audit
```

实现时机：Admin Control Plane 阶段一起正式化，不单独赶在眼前。

---

# 7. 验收禁止

当前代码里继续散落：

```python
if user_id == OWNER_ID
```

形式的权限判断上限为现状（兼容），不作为长期架构目标。正式 RBAC 落地时必须以 `identity + role + permission` 实现，并保留 root break-glass。

---

# 8. Status

- 当前模型：VERIFIED（生产现状）
- Role Binding / Permission 模型：PLANNED（Admin Control Plane 一起做）
