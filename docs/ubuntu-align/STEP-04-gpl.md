# Step 4 — GPL 合规登记

## 完成内容

`THIRD_PARTY_NOTICES.md` 末尾「非 dpkg 手工维护段」补登记 Operit proot/loader：

| 组件 | 许可证 | 来源 |
|---|---|---|
| proot (Operit build) | GPL-2.0 | proot-me/proot，经 AAswordman/Operit terminal 子模块编译 |
| proot loader | GPL-2.0 | 同上（proot 编译产物） |

## 合规说明

- `check-third-party.mjs` 只扫快照 dpkg 清单（`matrix.packages` 完整性 + copyleft 全文在场），**不会自动发现** assets/native 里的新二进制，故需手工段登记（与 @napi-rs/canvas 同机制）。
- `third-party-licenses.json` 已有 `"proot": "GPL-2.0"`（对应 Termux 快照 proot），Operit proot 许可证同为 GPL-2.0，无需新增条目。
- `LICENSES/GPL-2.0.txt` 全文已在场（copyleft 义务满足）。
- 区分：Operit 项目本体是 LGPL-3.0，但引入的 proot/loader 二进制许可证是 GPL-2.0（来自 proot-me/proot 上游）。

## 涉及文件

- `THIRD_PARTY_NOTICES.md`（补手工维护段）
