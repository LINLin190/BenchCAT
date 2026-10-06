# TwinCAT ESI → SII 转换规则与接口线索

日期：2026-10-06。本文围绕 XML 转换为 EEPROM 原始镜像；BIN 文件仍原样写入。

## Group 与字符串索引

BenchCAT 的 Group 选择顺序：

1. 使用设备 `GroupType` 精确匹配 `Descriptions/Groups/Group/Type`。
2. 未匹配且有可选 Group 时，采用 XML 中第一个组的 Type 和本地化显示名称。
3. 没有 Group 定义时，保留设备原始引用。

解析后的 Group Type 和显示名称进入同一个字符串表。General、PDO、DC 的名称索引均从该表生成；类别删减时重新生成字符串表及其引用。

当前 YS-PWM XML 的设备 GroupType 为 `YS_PWM`，唯一 Group 的 Type 为 `YS_Device`，显示名称为 `YS_PWM`。TwinCAT BIN 包含后两个字符串。BenchCAT 采用唯一 Group 后，其 General 组名称索引及 PDO/DC 名称索引随之对应。

本机 DLL 的 RVA `0x00765AAD–0x00765ACE` 明确包含“匹配对象为空、组数量大于零、取下标 0”的路径，因此回退规则也适用于多组 XML，不需要按显示名称猜测。

## 本机离线接口调查

候选实现：`C:\TwinCAT\3.1\Components\Base\Build_4024.0\TwinCAT System Manager.dll`。

- DLL FileVersion：`3.1.0.4302`，PE Machine：`0x014C`（32 位原生代码）。
- 首选 ImageBase：`0x10000000`。下表使用 RVA，避免运行时加载地址变化。
- DLL 导出的是 COM 注册及对象创建入口，没有命名为 ESI/SII/EEPROM 镜像生成的直接导出。
- 已读取 Base 和 TypeLib 下 2.1、3.1、3.2、3.3 的 `TCatSysManager.tlb`，类型数量分别为 194、140、192、208、217。
- 这些类型库没有显式声明 EEPROM/SII 镜像生成方法。通用 XML 方法仍可能承载内部命令，单凭方法名不能排除这种可能。

与离线调用相关的实际方法参数名称：

| 接口 | 方法及参数 | 含义边界 |
|---|---|---|
| ITcSmTreeItem | ProduceXml(bRecursive, pXML) | 导出树节点配置 XML，没有专门的命令输入参数 |
| ITcSmTreeItem | ConsumeXml(bstrXML) | 接收配置 XML，内部命令是否能通过它到达需继续追踪 |
| ITcSysManager5 | SelectECatModuleByIdent(moduleIdent, bstrCaption, currentOid) | 名称和参数不能证明它返回 EEPROM 镜像 |
| ITcSmExtensionOwner | ProduceExtensionXml(ipExtension, pXML) | 扩展对象 XML 导出，需要对应扩展对象 |
| ITcSmExtensionOwner | ConsumeExtensionXml(ipExtension, bstrXML) | 扩展对象 XML 输入，不能直接等同于转换入口 |
| ITcSmCommands | ExportXMLDescription() | 描述 XML 导出，不是公开的 BIN 生成方法 |

类型库清单和读取脚本位于工作区 `build/twincat-analysis/`，使用 `LoadTypeLibEx(REGKIND_NONE)`，仅读取接口元数据。

## DLL 内部命令

定位到内部字符串 `cmd_GetFlbTermEtherCATEEprom`，以及它的实际分派与处理函数。

| 项目 | RVA / 偏移 | 已能解释的行为 |
|---|---|---|
| 命令字符串 | `0x0140AE98` | `cmd_GetFlbTermEtherCATEEprom` |
| 命令分派函数 | `0x00802880` | 查找输入中的命令字段，再调用虚表方法 |
| 分派跳转入口 | `0x0000FC72` | 跳转至上述函数 |
| 所属对象 | CIoConfigDoc | RTTI 和虚表关联得到的对象名称 |
| 虚表 | `0x01425C34` | 命令分派槽偏移 `0x420`，EEPROM 处理槽偏移 `0x428` |
| EEPROM 命令处理函数 | `0x00802C30` | 读取 Type 下的 VendorId、ProductCode、RevisionNo，查找描述对象 |
| 描述查找调用入口 | `0x0002C381` | 参与按设备身份取得描述对象；完整参数类型仍需恢复 |
| 描述对象成员 | `+0x19C`、`+0x1A0` | 前者作为非空缓冲区指针，后者作为长度传入输出函数 |
| 输出调用入口 | `0x0002F482` | 将缓冲区交给名为 Eeprom 的输出字段；文本编码仍需恢复 |

该处理函数本身没有显式调用在线 EEPROM 读取函数，而是取得描述对象持有的缓冲区。因此它是从目录描述取得镜像的有力候选路径。描述查找函数的内部行为，以及从公开 COM/扩展对象到此命令的入口，仍不能仅凭这一段代码确定。

不能把 `WriteEEprom`、`ReadEEprom`、`UpdateEeprom` 等内部名称直接作为公开离线 API 调用。这些命令另有处理路径，可能执行在线操作。

## 原生镜像生成路径

描述对象解析 XML 时生成固定区和类别，主要代码位于 RVA `0x00767D68–0x0076938E`。以下规则来自该路径及其字段解析代码，均针对本机上述 DLL 版本。

| 路径 | RVA | 规则 |
|---|---|---|
| 固定区和邮箱 | `0x00767D68–0x00768098` | 前 128 字节清零；ConfigData 补零并重新生成 CRC；BootStrap 仅在长度为 8 时复制；Eeprom/Mailbox 存在时优先使用其 8 字节数据，长度不符则保持零；未声明该字段时仅从首两个、依次为 MBoxOut/MBoxIn 的 SM 生成邮箱 |
| 显式类别 | `0x00768098–0x007683D0` | Eeprom/Category 按 XML 顺序先写入，不与后续标准类别合并；CatNo 对应类别编号；支持 Data、DataString、DataUINT、DataUDINT |
| General | `0x007688F3–0x00768AE0` | SoE 通道数位于字节 8；EBusCurrent 位于字节 12–13；非 0x0134 的 IdentificationAdo 位于字节 18–19；对应标志位分别为 3、4 |
| 物理类型 | `0x0029FB00–0x0029FBEC` | General 字节 4 来自端口描述的分类表：Y=6、YY=1、YYY=4、YKY=2 等；未知组合返回零 |
| Physics 字符 | `0x00762C80–0x00762CB7` | Y=1、B=2、K=3、H=4，各占一个四位描述；长度超过四个字符时不编码，避免截断 |
| SoE | `0x00764DA9` 起 | SoE 默认 ChannelCount=1，可由属性覆盖；零通道不设置 SoE 协议位 |
| AoE | `0x00764436` 起 | AdsRouter=true 将内部类型设为 3；固定区类型为 3、5、8 时设置 AoE 位。BenchCAT 实现明确的 AdsRouter=true 路径；TcSmClass 等其他分类入口尚未恢复完整映射 |
| General 标志 | `0x0076553A–0x007655AF` | Type/TcCfgModeSafeOp 和 Type/UseLrdLwr 属性参与最终 General 标志；无需 Mailbox 节点；Mailbox/DataLinkLayer 对应 General 位 2 |

显式 Category 的 Data 只复制偶数字节；奇数字节数据按该 DLL 的处理生成空类别。DataString 保留首尾空格并包含 NUL 结束符，奇数字节总长度补 FF。UINT/UDINT 取低 16/32 位，以小端排列。同号类别保留声明顺序，不自动覆盖标准类别。

TwinCAT 此版本在 CoE/SoE 设备容量不足时会同时移除 TxPDO/RxPDO 并删掉相关字符串；非 CoE/SoE 的部分设备另有去掉 PDO 名称而保留映射的路径。BenchCAT 遵循用户已指定的完整类别裁剪策略，不采用去掉 PDO 名称的分支：依次尝试完整 PDO+DC、仅 DC、仅 PDO、两者均移除；每次重建引用字符串。仍然放不下时，从最后一个显式类别开始整类移除。镜像始终保持 ByteSize，裁剪信息只保留在内部报告中。

## 已采用的转换规则

| 内容 | BenchCAT 当前规则 | 依据边界 |
|---|---|---|
| ConfigData | 保留 1–14 个字节，补零至 14 字节，CRC 位于字节 14，字节 15 为零 | SOEM CRC 源码、SII 固定区结构与已有 TwinCAT 样本 |
| 身份和邮箱 | 固定区写入 XML 身份；支持 Eeprom/Mailbox 显式值及有序 SM 对；BootStrap 必须完整 8 字节；0x003A 起保留区填零 | 本机 DLL 固定区生成路径 |
| FMMU | Outputs=1，Inputs=2，MBoxState=3 | SOEM 类别读取和已有 TwinCAT 样本 |
| General | 引用解析后的组 Type、组显示名称、设备 Type 和设备名称；填写端口分类、SoE 通道数、带符号 EBusCurrent、识别寄存器及已明确的标志 | 本机 DLL General 路径；TcSmClass 字节 10 尚未实现 |
| 字符串 | Type、组 Type、组显示名称、设备名称、DC 名称、TxPDO 及条目、RxPDO 及条目；相同字符串共用索引 | 已有 TwinCAT 样本；非 ASCII、过长文本和多语言需补充 |
| PDO | 8 字节头，DC 同步字段和名称索引各占 1 字节；条目占 8 字节 | SOEM 类别读取和已有 TwinCAT 样本 |
| DC | 24 字节记录；SYNC1 因子、AssignActivate、SYNC0 因子和名称索引按各自位置写入 | 已有 TwinCAT 样本；复杂周期组合需补充 |
| SyncUnit | XML 显式 Su 元素才生成 0x002B；空 Su 输出 F0，奇数字节补 FF | 已有 TwinCAT 样本；保留位 F0 不是全部设备的通用结论 |
| 容量 | 使用 XML ByteSize；优先整类移除 PDO，再尝试 DC 组合；最后整类移除尾部显式类别，同时重建字符串引用 | 用户指定策略；保留与 TwinCAT 特殊名称裁剪分支的差异 |
| 排列与填充 | 显式 Category 在前，随后 Strings、General、FMMU、SM、SyncUnit、TxPDO、RxPDO、DC；类别奇数长度补 FF，FFFF 结束，余下补 FF | 本机 DLL 类别生成路径与已有 TwinCAT 样本 |

这些规则覆盖已有输入类型，不意味着已恢复 TwinCAT 的所有 ESI 转换行为。

## 单字段对照队列

每次只改变下列一个输入，保留原始 XML、所选设备、TwinCAT 输出及组件版本。设备身份相同的不同 XML 不应同时作为同一次目录选择的候选，以免源文件选择和缓存影响结果。

| 顺序 | 单项变化 | 要取得的规则 |
|---|---|---|
| 1 | 只更改 AoE AdsRouter 或 Type/TcSmClass | 补全内部设备类型与 AoE 协议位映射 |
| 2 | 仅增加或改变 Eeprom/Category | 非 ASCII DataString 编码及特殊标准编号行为 |
| 3 | 删除 Physics 或改为非法长度 | 补全缺省端口配置及非法输入的细节 |
| 4 | 仅更改组的某个语言 Name | 组显示名称语言优先级 |
| 5 | 仅修改一个 PDO/DC 名称，使其与已有字符串相同 | 字符串去重以及索引顺序 |
| 6 | 仅修改一个名称为非 ASCII 或超长文本 | 编码、长度上限及截断方式 |
| 7 | 仅减少 ByteSize，让 PDO 类别跨越容量边界 | 用户完整类别策略与不同 TwinCAT 设备类型裁剪分支的差异 |
| 8 | 仅启用 Su 的一个属性 | SyncUnit 位定义与保留位来源 |
| 9 | 仅修改一个 DC 周期或因子 | SYNC1、SYNC0 的周期/因子转换和不可表示值处理 |

下一步应先恢复内部目录命令的调用入口及输出编码。如果能够离线取出镜像，以上变化可以直接围绕转换过程进行；否则继续使用对应的 TwinCAT BIN 输出，不把 BenchCAT 自己产生的结果当作 TwinCAT 规则来源。

## 参考

- SOEM：`SOEM-2.0.0/samples/eepromtool/eepromtool.c`、`src/ec_main.c`、`src/ec_config.c`。
- [Beckhoff ESC Access](https://infosys.beckhoff.com/content/1033/tc3_io_intro/1358008331.html)：EEPROM 固定区、字寻址与加载行为。
- [Beckhoff ESI device description](https://infosys.beckhoff.com/content/1033/el5122/1036998411.html)：ESI 文件加载、缓存及复杂设备的 EEPROM 描述限制。
- [Beckhoff Automation Interface](https://infosys.beckhoff.com/content/1033/tc3_automationinterface/242737035.html)：EtherCAT 配置自动化接口。
