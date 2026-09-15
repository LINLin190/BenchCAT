# 概览页 UI / 信息架构重构（已实施 v5）

> 状态：**已实施，1600×1200 + 真实从站（LAN9252）实测验收通过**。记录 v1 → v5 的演进与最终方案。

---

## 0. 前置说明

开工时 `git status` 显示 `start-desktop.ps1` 有未提交改动（+43/-5，Vite 进程清理逻辑重构，与本任务无关）。
经确认：**保留该改动、继续实施**，本次未触碰该文件。

---

## 1. 演进过程

| 版本 | 布局 | 关键问题 → 解法 |
|---|---|---|
| v1 | 6 卡平铺 3 列，ESC 卡独占整行 1288px | ESC 卡右侧 700px 全空 → 按内容宽度重新分配 |
| v2 | 行1 三卡 / 行2 ESC+配置区 / 行3 控制状态全宽 | 行3 独高 344px → 合并 EEPROM 两张卡 |
| v3 | 行1 三卡 / 行2 ESC + EEPROM（跨 2 列） | 明细表被挤在 416px 内折行 → 列序改为 `Name/Value/Bit/Description` |
| v4 | 同上，EEPROM 卡内改为通栏堆叠 | 配置表在 380px 栏内折行 → 配置区与状态区各占整卡宽度 |
| **v5** | 同上；EEPROM 默认态回归「两条 PDI + 状态信号」，Word 表移入展开 | 默认态信息过载 → 按"折叠回答两个问题、展开才给全量"分层 |

**空白的根因**不是间距，而是：① 同行卡片被拉伸；② 卡片最小可行宽度与列宽不匹配。
v4 的解法是「按内容宽度分配跨列」+「让需要宽度的表格占据整卡宽度」。

## 2. 最终布局（实测）

```
┌─────────────────┬─────────────────┬─────────────────┐
│ 运行摘要         │ 状态请求         │ 设备身份         │  x=296/724/1152  w=416
│                 │ 诊断与恢复       │  (无序列号)      │  top=129 bottom=314
├─────────────────┴─────────────────┼─────────────────┤
│ EEPROM 诊断（跨 2 列，844px）       │ ESC 硬件信息     │  x=724 / x=296 w=416
│  配置区 16 字节 + Word 表（通栏）    │  型号/字节/      │  top=326
│  控制状态 Raw/Binary + 信号表（通栏）│  硅版本/Strap    │
└───────────────────────────────────┴─────────────────┘
```

- 行 1 三卡严格共线（`top=129 / bottom=314`，宽均 416）。
- `ESC 硬件信息` 用 `align-self: start` 保持自然高度（245px），不再被 EEPROM 卡拉伸。
- 2 行 5 卡；页面内容高约 1026px（可视 992px），**仅需极少量滚动**。

## 3. EEPROM 诊断卡（v5 核心）

### 默认态（收起）—— 回答两个问题

**左栏 · 配置区**
```
0000: 8D 0E 03 44 88 13 00 00 00 00 00 00 00 00 E4 00
PDI Control（0x0140）        0x8D · HBI Index 16bit
PDI Configuration（0x0150）  0x03
```

**右栏 · 控制 / 状态寄存器 0x0502–0x0503**
```
Raw value 0x0081   Binary 0000 0000 1000 0001
信号                    状态
EEPROM Algorithm        2-byte address
EEPROM Emulation        Physical I²C EEPROM
EEPROM Availability     Present
Checksum Error          Checksum OK
Loading Status          EEPROM loaded
```

### 展开态（标题行右侧单一 `展开详细解析` 按钮）

**配置区 · 前 16 字节解析** —— 7 行 Word 表（`Word | 16-bit 值 | 解析`）：

| Word | 16-bit 值 | 解析 |
|---|---|---|
| 0x0000 | 0x0E8D | `0x8D：PDI = HBI Index 16bit；0x0E：Device Emulation=0、Enhanced Link Detection All Ports=1、DC SYNC Out=1、DC Latch In=1、Enhanced Link Port 0=0…` |
| 0x0001 | 0x4403 | `0x03：PDI 接口配置（BUSY output driver / polarity = …）；0x44：SYNC0，Push-pull active low、SYNC1，Push-pull active low，SYNC0/LATCH0=SYNC output…` |
| 0x0002 | 0x1388 | `0x1388 = 5000，SYNC脉宽 50us` |
| 0x0003 | 0x0000 | `扩展 PDI 配置为 0，无额外配置` |
| 0x0004 | 0x0000 | `Station Alias = 0，未预设固定别名地址` |
| 0x0005 | 0x0000 | `ESC 扩展配置，全部为默认值 0` |
| 0x0007 | 0x00E4 | `CRC校验 = 0xE4` |

**控制 / 状态 · 完整位域** —— 11 个有定义的位（`Name | Value | Bit | Description`）。

> 默认态只列 **0x0140 / 0x0150** 两个配置字节（值取该字节本身，不是 16-bit word 值）；
> Word 表与位域表都属于展开明细。**0x0006 Reserved 不列出**，校验和只显示原值。
> 配置区不再有 word 级 bit 表 —— 7 行 Word 表的「解析」列已把它讲清楚。

## 4. 其他卡片

| 卡片 | 内容 |
|---|---|
| 运行摘要 | 当前状态 / AL 状态码 / 过程数据（周期行已删） |
| 状态请求 | 4 个状态按钮 + 分隔线 + 诊断与恢复（无标题、无说明文字） |
| 设备身份 | 配置地址 / 厂商 ID / 产品代码 / 修订版本（**序列号已删**，标签右对齐） |
| ESC 硬件信息 | `ESC 型号` 下拉 + `0x0E00–0x0E07` 字节 + `硅版本` + `Product ID`（ET1100）/ `Chip ID · ESC 型号`（LAN925x）+ `Strap`；字号统一 body2；展开给全位域 |

> ET1100 在 0x0E02 没有 Microchip Chip ID，故标签改为 `Product ID`，避免显示恒为 0x0000 的误导性 Chip ID。

## 5. 改动文件

| 文件 | 改动 |
|---|---|
| `desktop/src/eepromDiagnostics.ts` | 前 16 字节改为 3 列 Word 表 + 一行中文解析；`groups` 与 `EepromWordGroup` 已移除 |
| `desktop/src/escHardware.ts` | 输出 `revision` / `chipId` / `strap` 摘要 |
| `desktop/src/OverviewDisclosure.tsx`（新） | `useDisclosure()` + `CardHeading`（支持标题行操作槽） |
| `desktop/src/OverviewEeprom.tsx` | 单卡通栏堆叠 + 卡级单一展开 |
| `desktop/src/OverviewEeprom.test.tsx`（新） | 5 项布局/内容断言（防回归） |
| `desktop/src/EscHardwareCard.tsx` | 字号统一、`Product ID` 条件标签、`ov-self-start` |
| `desktop/src/App.tsx` | v4 网格；删除序列号/标题/说明/周期行 |
| `desktop/src/styles.css` | 等宽栅格、`ov-self-start`、`ov-word-table` 列宽与行高 |

## 6. 验收证据（1600×1200 实测 + 真实硬件）

- 行 1：三卡 `x=296/724/1152, w=416, top=129, bottom=314`
- 行 2：`ESC 硬件信息 x=296 w=416 top=326 bottom=571`；`EEPROM 诊断 x=724 w=844 top=326 bottom=665`
- 默认态行高实测：配置摘要 36–37px、状态信号 34px；卡片区总高 **665px < 可视 992px → 首屏看全无需滚动**
- **真实从站（LAN9252）验证**：`PDI Control（0x0140）0x8D · HBI Index 16bit`、`PDI Configuration（0x0150）0x03`、
  `Raw value 0x0081`、`硅版本 0x0001 / Chip ID · ESC 型号 0x9252 / Strap 0x001C`
- 测试：`tsc --noEmit` 通过；`vitest` **58/58** 通过（9 个文件）；`pytest` 全量通过

### 已知边界

- 展开「详细解析」后内容超出首屏，需要滚动；这是展开明细的正常代价。
- 卡片区底部仍有余量空白（按确认不动）。
