import { useEffect, useState } from "react";
import { Box, Button, Dialog, DialogContent, DialogTitle, IconButton, Stack, Tooltip, Typography } from "@mui/material";
import { CloseRounded, DescriptionOutlined, DeveloperBoardRounded, DriveFolderUploadRounded, MenuBookRounded, PauseRounded, PlayArrowRounded, ReplayRounded } from "@mui/icons-material";
import "./featureGuide.css";

type GuideTopic = "slave" | "xml" | "drop" | "manual";
const guides = {
  slave: {
    title: "从站右键烧录",
    subtitle: "在 BenchCAT 中直接打开快速烧录窗口",
    steps: [
      ["右键目标从站", "在左侧从站列表中，找到并右键需要烧录的从站。"],
      ["选择“烧录 EEPROM”", "点击右键菜单中的“烧录 EEPROM”，打开快速烧录窗口。"],
      ["选择烧录文件", "点击“选择 XML/BIN”，也可以将文件拖入快速烧录窗口。"],
      ["确认从站与 XML Device", "对照当前从站和待烧录目标；XML 包含多个 Device 时，明确选择需要的设备。"],
      ["准备好后点击“烧录”", "确认目标和配置后点击“烧录”。也可以进入 EEPROM 详情查看数据。"],
    ],
  },
  xml: {
    title: "XML 右键烧录",
    subtitle: "从 Windows 资源管理器把 XML 交给 BenchCAT",
    steps: [
      ["找到设备 XML", "在 Windows 资源管理器中找到准备使用的 EtherCAT ESI XML 文件。"],
      ["右键 XML 文件", "安装 BenchCAT 后，XML 右键菜单会增加“烧录EEPROM”。Windows 11 中若未看到，可展开“显示更多选项”。"],
      ["选择“烧录EEPROM”", "菜单会打开 BenchCAT 并带入该 XML；软件已运行时，会交给现有窗口。"],
      ["确认目标从站与 Device", "文件已自动带入。连接并扫描从站后，确认要烧录的从站和 XML Device。"],
      ["准备好后点击“烧录”", "确认目标和配置后点击“烧录”。XML 右键入口只带入文件，不会自动烧录。"],
    ],
  },
  drop: {
    title: "拖入 XML/BIN",
    subtitle: "EEPROM 页面和快速烧录窗口都支持拖入 XML/BIN",
    steps: [
      ["进入 EEPROM 页面", "选择目标从站，点击左侧“EEPROM”。XML 和 BIN 都可直接拖入此页面，也可拖入快速烧录窗口。"],
      ["按住 XML 文件", "在资源管理器中，用鼠标左键按住 XML 文件。"],
      ["拖到 EEPROM 页面", "按住鼠标，将 XML 文件拖入 EEPROM 页面；待写入目标区会提示“松开以加载 XML/BIN”。"],
      ["松开鼠标，加载 XML", "EEPROM 页面会显示待写入目标和 XML 配置。确认当前设备，并选择需要烧录的 Device。"],
      ["快速烧录窗口同样支持拖入", "也可以右键从站打开“快速烧录 EEPROM”，将 XML 或 BIN 拖入弹窗。下面以 BIN 为例。"],
      ["将 BIN 拖入快速烧录窗口", "按住 BIN 文件，将它拖入快速烧录窗口，再松开鼠标。"],
      ["查看 BIN 原始数据目标", "松开后显示 BIN 文件信息。BIN 按文件原始内容写入，确认目标后再点击“烧录”。"],
    ],
  },
  manual: {
    title: "寄存器参考手册",
    subtitle: "从寄存器详情直接打开对应参考手册",
    steps: [
      ["打开寄存器页面", "选择从站后，点击左侧“寄存器”入口。"],
      ["选择需要了解的寄存器", "可按名称或地址搜索，点击寄存器行，打开右侧详情。"],
      ["点击“参考手册”中的文件链接", "向下滚动寄存器详情，找到“参考手册”，点击所需文档的文件名。"],
      ["在软件内阅读对应内容", "手册在内置阅读窗口中打开；有页码索引时，会定位到对应寄存器页面。"],
      ["使用目录、页码和搜索", "可以展开目录、调整 PDF 页码和缩放，也可以搜索寄存器名称或地址。"],
    ],
  },
};

function DemoCursor({ x, y, label, pulseKey }: { x: number; y: number; label?: string; pulseKey: string }) {
  return <g className="guide-cursor" style={{ transform: `translate(${x}px, ${y}px)` }}>
    <circle key={pulseKey} className="guide-click" r="19" fill="none" stroke="#365ccf" strokeWidth="2" />
    <path d="M0 0L0 26L7 20L13 32L18 29L12 18L22 17Z" fill="#172033" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
    {label && <g><rect x="24" y="10" width="50" height="25" rx="12" fill="#365ccf" /><text x="49" y="27" textAnchor="middle" fill="#fff" fontSize="12">{label}</text></g>}
  </g>;
}

function cursorPosition(topic: GuideTopic, step: number) {
  if (topic === "drop") return [[336, 214], [177, 164], [677, 261], [723, 276], [177, 211], [600, 365], [805, 472]][step];
  if (topic === "manual") return [[29, 163], [256, 197], [739, 405], [628, 285], [665, 142]][step];
  const explorer = topic === "xml";
  if (step >= (explorer ? 3 : 2)) return step === 2 ? [174, 426] : step === 3 ? [651, 355] : [811, 466];
  return explorer ? step === 2 ? [437, 291] : [365, 198] : step === 1 ? [228, 209] : [129, 165];
}

function FileDropScene({ step }: { step: number }) {
  const quickFlash = step >= 4;
  const loaded = step === 3 || step === 6;
  const dragging = step === 1 || step === 2 || step === 5;
  const cursor = cursorPosition("drop", step);
  return <svg className="guide-scene" viewBox="0 0 960 520" preserveAspectRatio="xMidYMin meet" role="img" aria-label={`拖入 XML/BIN：${guides.drop.steps[step][0]}`}>
    <rect width="960" height="520" rx="12" fill="#f4f6fa" />
    <text x="22" y="30" fontSize="17" fontWeight="700">从资源管理器拖入 BenchCAT</text>
    <rect x="18" y="56" width="280" height="444" rx="10" fill="#fff" stroke="#e2e6ef" />
    <text x="35" y="85" fontWeight="700">文件资源管理器</text>
    <rect x="30" y="100" width="256" height="29" rx="5" fill="#f4f6fa" /><text x="43" y="120" fontSize="12" fill="#647087">此电脑　 ›　 EtherCAT　 ›　 ESI</text>
    <rect x="30" y={quickFlash ? 190 : 143} width="256" height="43" rx="5" fill="#e9eeff" />
    <path d="M44 150H58L65 158V174H44ZM44 197H58L65 205V221H44Z" fill="#fff" stroke="#365ccf" />
    <text x="76" y="168" fontWeight="650">Device.xml</text><text x="76" y="215" fontWeight="650">Device-backup.bin</text>
    <text x="35" y="478" fontSize="12" fill="#647087">XML / BIN 文件</text>
    {quickFlash ? <g>
    <rect x="317" y="56" width="625" height="444" rx="10" fill="#fff" stroke={step === 5 ? "#365ccf" : "#d5dcea"} strokeWidth={step === 5 ? 3 : 1} />
    <text x="337" y="86" fontWeight="750" fontSize="18">快速烧录 EEPROM</text><text x="337" y="108" fontSize="12" fill="#647087">从站 1 · 示例从站 · LAN9252</text><text x="916" y="86" fill="#647087">×</text>
    <path d="M317 124H942M493 124V451M317 451H942" stroke="#e2e6ef" />
    <rect x="318" y="125" width="174" height="325" fill="#fbfcfe" />
    <text x="332" y="152" fontSize="12" fill="#647087">最近烧录　 固定列表</text>
    {loaded && <g className="guide-appear">
      <rect x="330" y="175" width="150" height="58" rx="5" fill="#e9eeff" />
      <text x="340" y="199" fontSize="11" fontWeight="700">Device-backup.bin</text>
      <text x="340" y="220" fontSize="11" fill="#647087">BIN · 原始数据</text>
    </g>}
    <rect x="330" y="400" width="150" height="29" rx="5" fill="#fff" stroke="#365ccf" /><text x="405" y="420" textAnchor="middle" fontSize="12" fill="#365ccf">选择 XML/BIN</text>
    <rect x="510" y="143" width="414" height="105" rx="7" fill="#f8f9fb" stroke="#d7dce3" />
    <text x="526" y="169" fontWeight="700">当前从站 · 设备实际值</text><text x="526" y="204" fontWeight="650">从站 1 · 示例从站　⌄</text><text x="526" y="231" fontSize="12" fill="#647087">实际 EEPROM ConfigData</text>
    {loaded ? <g className="guide-appear">
      <rect x="510" y="267" width="414" height="164" rx="7" fill="#fafbfd" stroke="#365ccf" />
      <text x="526" y="294" fontWeight="700">选中 BIN · 待烧录目标</text>
      <text x="526" y="327" fontWeight="700">Device-backup.bin</text>
      <text x="526" y="357" fontSize="13" fill="#647087">BIN · 文件原始字节</text>
      <path d="M526 371H908" stroke="#e2e6ef" />
      <text x="526" y="403" fontSize="12" fill="#647087">从 EEPROM 地址 0 开始写入原始内容</text>
    </g> : <g>
      <rect x="510" y="267" width="414" height="164" rx="7" fill={step === 5 ? "#eef2ff" : "#fafbfd"} stroke={step === 5 ? "#365ccf" : "#d7dce3"} strokeWidth={step === 5 ? 2 : 1} strokeDasharray={step === 5 ? "6 5" : undefined} />
      <text x="717" y="323" textAnchor="middle" fontSize="18" fill="#365ccf">↓</text>
      <text x="717" y="354" textAnchor="middle" fontSize="14" fontWeight="650" fill="#647087">{step === 5 ? "松开以加载 XML/BIN" : "将 XML/BIN 拖入此窗口"}</text>
      <text x="717" y="383" textAnchor="middle" fontSize="12" fill="#647087">也可以点击“选择 XML/BIN”</text>
    </g>}
    <text x="334" y="478" fontSize="12" fill="#365ccf">进入 EEPROM 详情</text><text x="766" y="478" fontSize="12" fill="#647087">取消</text>
    <rect x="816" y="460" width="108" height="27" rx="5" fill={loaded ? "#365ccf" : "#cbd2df"} /><text x="870" y="479" textAnchor="middle" fontSize="12" fill="#fff">烧录</text>
    </g> : <g>
      <rect x="317" y="56" width="625" height="444" rx="10" fill="#f4f6fa" stroke="#d5dcea" />
      <rect x="318" y="57" width="623" height="43" rx="10" fill="#fff" /><text x="333" y="84" fontWeight="700">BenchCAT</text><text x="717" y="83" fontSize="12" fill="#647087">从站 1 · 示例从站</text>
      <rect x="318" y="100" width="35" height="399" fill="#fbfcfe" />
      <text x="336" y="147" textAnchor="middle" fontSize="8" fill="#647087">概览</text><text x="336" y="187" textAnchor="middle" fontSize="8" fill="#647087">寄存器</text><rect x="321" y="200" width="29" height="40" rx="4" fill="#e9eeff" /><text x="336" y="224" textAnchor="middle" fontSize="7" fill="#365ccf">EEPROM</text>
      <text x="368" y="125" fontWeight="750" fontSize="18">EEPROM</text>
      <rect x="367" y="140" width="559" height="37" rx="6" fill={step === 2 ? "#eef2ff" : "#fff"} stroke={step === 2 ? "#365ccf" : "#e2e6ef"} />
      <text x="378" y="164" fontSize="11" fill="#365ccf">选择/拖入XML/BIN</text><text x="552" y="164" fontSize="11" fill="#647087">{step === 2 ? "松开以加载 XML/BIN" : loaded ? "Device.xml　 ·　 XML" : "文件选择"}</text>
      <rect x="367" y="190" width="260" height="162" rx="7" fill="#fff" stroke="#e2e6ef" /><text x="382" y="215" fontWeight="700">当前设备</text><path d="M367 226H627" stroke="#e2e6ef" /><text x="382" y="252" fontSize="12">从站 1 · 示例从站</text><text x="382" y="282" fontSize="12" fill="#647087">设备身份与容量</text><text x="382" y="326" fontSize="12" fill="#647087">实际 ConfigData</text>
      <rect x="640" y="190" width="286" height="162" rx="7" fill={step === 2 ? "#eef2ff" : "#fff"} stroke={step >= 2 ? "#365ccf" : "#e2e6ef"} />
      <text x="655" y="215" fontWeight="700">待写入目标</text><path d="M640 226H926" stroke="#e2e6ef" />
      {step === 2 && <rect x="641" y="227" width="284" height="124" rx="6" fill="none" stroke="#365ccf" strokeWidth="2" strokeDasharray="6 5" />}
      {loaded ? <g className="guide-appear"><text x="655" y="252" fontSize="12" fontWeight="650">Device：示例设备　⌄</text><text x="655" y="282" fontSize="12" fill="#647087">Device.xml · XML</text><text x="655" y="326" fontSize="12" fill="#647087">XML ConfigData · 待写入配置</text></g>
        : <g><text x="783" y="251" textAnchor="middle" fontSize="12" fill={step === 2 ? "#365ccf" : "#647087"}>{step === 2 ? "松开以加载 XML/BIN" : "尚未选择 XML/BIN"}</text>{step !== 2 && <text x="783" y="332" textAnchor="middle" fontSize="11" fill="#647087">选择或拖入文件后显示待写入信息</text>}</g>}
      <rect x="367" y="369" width="559" height="116" rx="7" fill="#fff" stroke="#e2e6ef" /><text x="382" y="395" fontWeight="700">EEPROM 原始数据</text><path d="M367 407H926" stroke="#e2e6ef" /><text x="382" y="434" fontSize="12" fill="#647087">读取范围　　完整读取　⌄</text><text x="797" y="434" fontSize="12" fill="#365ccf">读取　 保存 BIN</text><text x="382" y="468" fontSize="12" fill="#647087">尚未读取 EEPROM 数据</text>
    </g>}
    {/* Keep the preview mounted so it follows the cursor; reveal it after the XML pickup movement. */}
    <g className="guide-drag-file" style={{ transform: `translate(${cursor[0] + 25}px, ${cursor[1] + 20}px)`, opacity: dragging ? 1 : 0, transitionDelay: step === 1 ? "0ms, 550ms" : "0ms" }}>
      <rect width={quickFlash ? 136 : 90} height="37" rx="6" fill="#e9eeff" stroke="#365ccf" opacity=".95" /><text x="12" y="24" fontSize="12" fontWeight="650" fill="#365ccf">{quickFlash ? "Device-backup.bin" : "Device.xml"}</text>
    </g>
  </svg>;
}

function RegisterManualScene({ step }: { step: number }) {
  const details = step >= 1;
  const reader = step >= 3;
  return <svg className="guide-scene" viewBox="0 0 960 520" preserveAspectRatio="xMidYMin meet" role="img" aria-label={`寄存器参考手册：${guides.manual.steps[step][0]}`}>
    <rect width="960" height="520" rx="12" fill="#f4f6fa" />
    <rect width="960" height="46" rx="12" fill="#fff" /><path d="M0 34H960V46H0Z" fill="#fff" /><text x="22" y="29" fontSize="17" fontWeight="700">BenchCAT</text><text x="882" y="28" fill="#647087">−　□　×</text>
    <rect y="47" width="58" height="473" fill="#fbfcfe" />
    {["概览", "寄存器", "EEPROM"].map((label, i) => <g key={label}><rect x="12" y={84 + i * 68} width="34" height="26" rx="6" fill={i === 1 ? "#dbe4ff" : "#e2e6ef"} /><text x="29" y={126 + i * 68} textAnchor="middle" fontSize="10" fill={i === 1 ? "#365ccf" : "#647087"}>{label}</text></g>)}
    <text x="80" y="78" fontWeight="650">从站 1 · 示例从站 · LAN9252</text>
    <text x="81" y="115" fontSize="13" fill="#365ccf">常用　 全部　 收藏</text>
    <rect x="271" y="94" width="420" height="32" rx="5" fill="#fff" stroke={step === 1 ? "#365ccf" : "#e2e6ef"} /><text x="286" y="115" fontSize="12" fill="#647087">{details ? "0x0502" : "搜索名称、地址或地址范围"}</text><text x="718" y="115" fontSize="12" fill="#647087">原始地址访问　 刷新全部</text>
    <rect x="77" y="143" width={details ? 463 : 863} height="355" rx="8" fill="#fff" stroke="#e2e6ef" />
    <text x="95" y="169" fontSize="12" fill="#647087">地址　　　　　　 名称</text>
    <rect x="87" y="183" width={details ? 443 : 843} height="41" rx="5" fill="#e9eeff" /><text x="98" y="208" fontSize="13" fill="#365ccf">0x0502　 EEPROM Control/Status</text>
    {!details && <><text x="98" y="255" fontSize="13" fill="#647087">0x0500　 EEPROM Configuration</text><text x="98" y="300" fontSize="13" fill="#647087">0x0504　 EEPROM Address</text></>}
    {details && <g className="guide-appear">
      <rect x="553" y="143" width="387" height="355" rx="8" fill="#fff" stroke="#e2e6ef" />
      <text x="570" y="173" fontWeight="700">EEPROM Control/Status</text><text x="570" y="198" fontSize="12" fill="#647087">0x0502–0x0503</text><path d="M570 214H922" stroke="#e2e6ef" />
      <text x="570" y="243" fontWeight="650">基本信息</text><text x="570" y="271" fontSize="13" fill="#647087">EEPROM 控制与状态</text>
      <text x="570" y="311" fontWeight="650">位字段说明</text><text x="570" y="339" fontSize="13" fill="#647087">查看字段名称与含义</text>
      <rect x="563" y="361" width="365" height="98" rx="6" fill={step === 2 ? "#eef2ff" : "#fff"} stroke={step === 2 ? "#365ccf" : "#e2e6ef"} />
      <text x="576" y="386" fontWeight="700">参考手册</text><text x="648" y="386" fontSize="11" fill="#647087">（点击打开文档）</text>
      <text x="576" y="415" fontSize="11" fill="#365ccf">microchip_lan9252_register_en.pdf · PDF 第 261 页</text><path d="M576 418H912" stroke="#365ccf" />
      <text x="576" y="445" fontSize="11" fill="#365ccf">microchip_lan9252_register_zh.pdf</text>
      <rect x="932" y="214" width="3" height="267" rx="2" fill="#edf0f5" /><rect x="932" y="364" width="3" height="94" rx="2" fill="#bac5d8" />
    </g>}
    {reader && <g className="guide-appear">
      <rect y="46" width="960" height="474" fill="#172033" opacity=".18" />
      <rect x="35" y="62" width="890" height="439" rx="10" fill="#fff" stroke="#d5dcea" /><text x="53" y="89" fontWeight="700">LAN9252 参考手册</text><text x="53" y="110" fontSize="11" fill="#647087">EEPROM Control/Status · 0x0502–0x0503 · 章节 12.14.49</text><text x="894" y="87" fill="#647087">×</text>
      <path d="M35 119H925" stroke="#e2e6ef" />
      <rect x="48" y="126" width="58" height="28" rx="5" fill={step === 4 ? "#e9eeff" : "#f4f6fa"} /><text x="77" y="146" textAnchor="middle" fontSize="12" fill="#365ccf">目录</text>
      <text x="124" y="146" fontSize="12" fill="#647087">‹</text><rect x="145" y="126" width="67" height="28" rx="5" fill="#fff" stroke="#e2e6ef" /><text x="156" y="145" fontSize="12">261</text><text x="224" y="146" fontSize="12" fill="#647087">/ 332　 ›</text>
      <rect x="306" y="126" width="104" height="28" rx="5" fill="#fff" stroke="#e2e6ef" /><text x="320" y="145" fontSize="12" fill="#647087">适合宽度　⌄</text>
      <rect x="563" y="126" width="210" height="28" rx="5" fill="#fff" stroke={step === 4 ? "#365ccf" : "#e2e6ef"} /><text x="576" y="145" fontSize="12" fill="#647087">{step === 4 ? "EEPROM" : "搜索名称或地址"}</text><text x="790" y="146" fontSize="12" fill="#365ccf">上一个　 下一个</text>
      <rect x="36" y="164" width="888" height="326" fill="#525659" />
      {step === 4 && <g><rect x="36" y="164" width="228" height="326" fill="#fff" /><text x="51" y="190" fontWeight="650">目录</text><text x="51" y="226" fontSize="12" fill="#647087">⌄　EtherCAT 寄存器</text><text x="70" y="262" fontSize="11" fill="#647087">12.14.49</text><rect x="45" y="273" width="208" height="45" rx="5" fill="#e9eeff" /><text x="58" y="291" fontSize="11" fill="#365ccf">EEPROM Control/Status</text><text x="58" y="307" fontSize="11" fill="#365ccf">0x0502–0x0503</text></g>}
      <g transform={`translate(${step === 4 ? 330 : 195}, 182)`}>
        <rect width="455" height="297" fill="#fff" /><text x="28" y="36" fontSize="19" fontWeight="700">LAN9252</text><path d="M28 49H427" stroke="#e2e6ef" /><text x="28" y="79" fontWeight="700">12.14.49　EEPROM CONTROL/STATUS</text><text x="28" y="104" fontSize="12" fill="#647087">Register address: 0x0502–0x0503</text>
        {step === 4 && <rect x="110" y="64" width="66" height="19" fill="#ffecad" opacity=".65" />}
        <rect x="28" y="125" width="399" height="30" fill="#f4f6fa" /><text x="43" y="146" fontSize="12">寄存器描述与位字段</text>
        {[178, 208, 238, 268].map(y => <g key={y}><path d={`M28 ${y}H427`} stroke="#e2e6ef" /><rect x="42" y={y - 15} width="72" height="5" rx="2" fill="#cbd2df" /><rect x="135" y={y - 15} width="255" height="5" rx="2" fill="#e2e6ef" /></g>)}
      </g>
    </g>}
  </svg>;
}

function DemoScene({ topic, step }: { topic: GuideTopic; step: number }) {
  if (topic === "drop") return <FileDropScene step={step} />;
  if (topic === "manual") return <RegisterManualScene step={step} />;
  const explorer = topic === "xml";
  const flashOpen = step >= (explorer ? 3 : 2);
  const fileLoaded = explorer || step >= 3;
  const menuOpen = explorer ? step === 1 || step === 2 : step === 1;

  return <svg className="guide-scene" viewBox="0 0 960 520" preserveAspectRatio="xMidYMin meet" role="img" aria-label={`${guides[topic].title}：${guides[topic].steps[step][0]}`}>
    <rect width="960" height="520" rx="12" fill="#f4f6fa" />
    <rect width="960" height="46" rx="12" fill="#fff" />
    <path d="M0 34H960V46H0Z" fill="#fff" />
    <text x="22" y="29" fontSize="17" fontWeight="700">{explorer ? "文件资源管理器" : "BenchCAT"}</text>
    <text x="882" y="28" fill="#647087">−　□　×</text>
    {explorer ? <g>
      <rect x="18" y="60" width="924" height="38" rx="6" fill="#fff" stroke="#e2e6ef" />
      <text x="36" y="84" fill="#647087">‹　 ›　 ↑　　此电脑　 ›　 EtherCAT　 ›　 ESI</text>
      <rect x="18" y="110" width="178" height="390" rx="8" fill="#fff" />
      {["主页", "桌面", "下载", "文档", "此电脑"].map((label, i) => <text key={label} x="42" y={145 + i * 44} fill="#647087">{label}</text>)}
      <text x="224" y="137" fill="#647087" fontSize="13">名称</text><text x="650" y="137" fill="#647087" fontSize="13">类型</text>
      <rect x="215" y="166" width="722" height="48" rx="5" fill="#e9eeff" stroke="#bccafa" />
      <path d="M236 176H252L260 184V203H236Z" fill="#fff" stroke="#365ccf" />
      <text x="276" y="197" fontWeight="650">Device.xml</text><text x="650" y="197" fill="#647087">XML 文档</text>
      <text x="276" y="249" fill="#647087">Device-backup.bin</text><text x="650" y="249" fill="#647087">BIN 文件</text>
      <text x="223" y="473" fill="#647087" fontSize="13">已选中 1 个文件</text>
    </g> : <g>
      <rect x="0" y="47" width="58" height="473" fill="#fbfcfe" />
      {["概览", "寄存器", "EEPROM"].map((label, i) => <g key={label}><rect x="12" y={84 + i * 68} width="34" height="26" rx="6" fill={i ? "#e2e6ef" : "#dbe4ff"} /><text x="29" y={126 + i * 68} textAnchor="middle" fontSize="10" fill="#647087">{label}</text></g>)}
      <rect x="59" y="47" width="901" height="47" fill="#fff" />
      <rect x="75" y="59" width="95" height="25" rx="12" fill="#e7f5ee" /><text x="88" y="77" fill="#16845b" fontSize="12">网卡已连接</text>
      <text x="191" y="77" fill="#647087" fontSize="13">Ethernet　⌄　　 扫描　　 断开</text>
      <rect x="59" y="95" width="192" height="425" fill="#fff" /><text x="77" y="121" fill="#647087" fontSize="12">从站 · 2</text>
      <rect x="70" y="140" width="168" height="54" rx="6" fill="#e9eeff" stroke="#bccafa" />
      <text x="84" y="161" fill="#365ccf" fontWeight="700">1 · 示例从站</text><text x="84" y="180" fill="#647087" fontSize="12">LAN9252 · INIT</text>
      <text x="84" y="220" fill="#647087">2 · 示例从站</text><text x="84" y="239" fill="#647087" fontSize="12">LAN9252 · INIT</text>
      <text x="280" y="131" fontWeight="700" fontSize="19">从站概览</text>
      <rect x="277" y="150" width="655" height="177" rx="8" fill="#fff" stroke="#e2e6ef" />
      <text x="299" y="182" fontWeight="700">身份与状态</text>
      <text x="299" y="220" fill="#647087">当前从站</text><text x="483" y="220">1 · 示例从站</text>
      <text x="299" y="255" fill="#647087">ESC 型号</text><text x="483" y="255">LAN9252</text>
      <text x="299" y="290" fill="#647087">AL 状态</text><text x="483" y="290" fill="#16845b">无错误</text>
      <rect x="277" y="343" width="655" height="148" rx="8" fill="#fff" stroke="#e2e6ef" /><text x="299" y="376" fontWeight="700">EEPROM</text><text x="299" y="410" fill="#647087">设备配置与 SII 信息</text>
    </g>}
    {menuOpen && <g className="guide-appear" key={`${topic}-menu`}>
      <rect x={explorer ? 344 : 119} y={explorer ? 216 : 182} width="240" height={explorer ? 182 : 57} rx="9" fill="#172033" opacity=".08" transform="translate(0 5)" />
      <rect x={explorer ? 344 : 119} y={explorer ? 216 : 182} width="240" height={explorer ? 182 : 57} rx="9" fill="#fff" stroke="#d5dcea" />
      {explorer && <><text x="366" y="245" fill="#647087">打开</text><path d="M356 259H572" stroke="#e2e6ef" /><text x="366" y="343" fill="#647087">复制</text><text x="366" y="377" fill="#647087">属性</text></>}
      <rect x={explorer ? 352 : 127} y={explorer ? 270 : 190} width="224" height="36" rx="5" fill="#e9eeff" />
      <text x={explorer ? 368 : 143} y={explorer ? 294 : 214} fill="#365ccf" fontWeight="700">{explorer ? "烧录EEPROM" : "烧录 EEPROM"}</text>
    </g>}
    {flashOpen && <g className="guide-appear" key={`${topic}-flash`}>
      <rect y="46" width="960" height="474" fill="#172033" opacity=".18" />
      <rect x="72" y="74" width="816" height="424" rx="12" fill="#fff" stroke="#d5dcea" />
      <text x="94" y="104" fontSize="19" fontWeight="750">快速烧录 EEPROM</text><text x="94" y="126" fontSize="12" fill="#647087">从站 1 · 示例从站 · LAN9252</text><text x="855" y="104" fill="#647087">×</text>
      <path d="M72 139H888M72 450H888M287 139V450" stroke="#e2e6ef" />
      <rect x="73" y="140" width="213" height="309" fill="#fbfcfe" /><text x="89" y="167" fontSize="13" fill="#647087">最近烧录　　 固定列表</text>
      <rect x="86" y="182" width="186" height="29" rx="5" fill="#fff" stroke="#e2e6ef" /><text x="96" y="202" fontSize="12" fill="#94a0b2">搜索 XML/BIN、Device…</text>
      {fileLoaded && <g><rect x="86" y="224" width="186" height="60" rx="6" fill="#e9eeff" /><text x="98" y="247" fontWeight="700">Device.xml</text><text x="98" y="268" fontSize="12" fill="#647087">示例设备 · XML</text></g>}
      <rect x="87" y="407" width="185" height="31" rx="5" fill={fileLoaded ? "#fff" : "#e9eeff"} stroke="#365ccf" strokeWidth={fileLoaded ? 1 : 2} /><text x="179" y="428" textAnchor="middle" fontSize="13" fontWeight="650" fill="#365ccf">选择 XML/BIN</text>
      <rect x="305" y="157" width="564" height="119" rx="8" fill="#f8f9fb" stroke="#d7dce3" /><text x="321" y="181" fontWeight="700">当前从站 · 设备实际值</text>
      <rect x="321" y="195" width="255" height="62" rx="6" fill="#fff" stroke={step >= 3 ? "#365ccf" : "#e2e6ef"} /><text x="334" y="215" fontSize="11" fill="#647087">当前 Device</text><text x="334" y="241" fontWeight="650">从站 1 · 示例从站　⌄</text>
      <text x="601" y="219" fontSize="12" fill="#647087">实际 EEPROM ConfigData</text><text x="601" y="244" fontSize="12" fill="#647087">设备当前配置</text>
      {fileLoaded ? <g>
        <rect x="305" y="291" width="564" height="137" rx="8" fill="#fafbfd" stroke="#365ccf" /><text x="321" y="316" fontWeight="700">选中 XML · 待烧录目标</text>
        <text x="321" y="346" fontWeight="650">Device.xml</text><text x="321" y="372" fontSize="13" fill="#647087">Device：示例设备　⌄</text>
        <text x="601" y="346" fontSize="12" fill="#647087">XML ConfigData</text><text x="601" y="372" fontSize="12" fill="#647087">待烧录配置</text><path d="M321 385H853" stroke="#e2e6ef" /><text x="321" y="411" fontSize="12" fill="#647087">XML ConfigData解析</text>
      </g> : <g><text x="587" y="342" textAnchor="middle" fontWeight="650" fill="#647087">选择文件，或将 XML/BIN 拖入此窗口</text><text x="587" y="372" textAnchor="middle" fontSize="13" fill="#647087">XML 可临时修改 ConfigData；BIN 按原始内容写入</text></g>}
      <text x="93" y="479" fontSize="13" fill="#365ccf">进入 EEPROM 详情</text><text x="705" y="479" fontSize="13" fill="#647087">取消</text>
      {step === 4 && <rect x="752" y="453" width="117" height="39" rx="7" fill="none" stroke="#365ccf" strokeWidth="2" />}
      <rect x="758" y="459" width="105" height="27" rx="5" fill={fileLoaded ? "#365ccf" : "#cbd2df"} /><text x="810" y="478" textAnchor="middle" fontSize="13" fontWeight="650" fill="#fff">烧录</text>
    </g>}
    <rect x="808" y="7" width="68" height="30" rx="15" fill="#eef2ff" /><text x="842" y="27" textAnchor="middle" fill="#365ccf" fontSize="12">示例演示</text>
  </svg>;
}

export function FeatureGuideDialog({ onClose }: { onClose: () => void }) {
  const [topic, setTopic] = useState<GuideTopic>("slave");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(() => !window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const guide = guides[topic];
  const cursor = cursorPosition(topic, step);

  // The guide owns only presentation state; it never opens the live programming dialog.
  useEffect(() => {
    if (!playing) return;
    const lastStep = step === guide.steps.length - 1;
    // Hold the final step for its normal duration plus a four-second replay pause.
    const timer = window.setTimeout(() => {
      setStep(lastStep ? 0 : step + 1);
    }, 2600 + (lastStep ? 4000 : 0));
    return () => window.clearTimeout(timer);
  }, [playing, step, guide]);

  const selectTopic = (value: GuideTopic) => { setTopic(value); setStep(0); setPlaying(!window.matchMedia("(prefers-reduced-motion: reduce)").matches); };
  const replay = () => { setStep(0); setPlaying(true); };

  return <Dialog open onClose={onClose} fullWidth maxWidth="lg" aria-labelledby="feature-guide-title" PaperProps={{ sx: { width: "calc(100% - 32px)", maxWidth: 1200, height: 940, maxHeight: "calc(100% - 32px)", m: 2, borderRadius: 2 } }}>
    <DialogTitle id="feature-guide-title" sx={{ px: 3, py: 1 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography component="span" fontSize={20} fontWeight={750}>功能导览</Typography>
        <IconButton aria-label="关闭功能导览" onClick={onClose}><CloseRounded /></IconButton>
      </Stack>
    </DialogTitle>
    <DialogContent sx={{ display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden", gap: 1, px: 3, pt: "0 !important", pb: 1 }}>
      <Stack direction="row" useFlexGap flexWrap="wrap" spacing={1} sx={{ flexShrink: 0 }}>
        {(["slave", "xml", "drop", "manual"] as const).map(value => <Button key={value} variant={topic === value ? "contained" : "outlined"} aria-pressed={topic === value} onClick={() => selectTopic(value)} startIcon={value === "slave" ? <DeveloperBoardRounded /> : value === "xml" ? <DescriptionOutlined /> : value === "drop" ? <DriveFolderUploadRounded /> : <MenuBookRounded />}>{guides[value].title}</Button>)}
      </Stack>
      <Typography fontWeight={700} sx={{ flexShrink: 0 }}>{guide.subtitle}</Typography>
      <Box className={`guide-stage${playing ? "" : " guide-paused"}`}>
        <DemoScene topic={topic} step={step} />
        {/* A shared cursor layer preserves movement across all guide topics. */}
        <svg className="guide-scene guide-cursor-layer" viewBox="0 0 960 520" preserveAspectRatio="xMidYMin meet" aria-hidden="true">
          <DemoCursor x={cursor[0]} y={cursor[1]} pulseKey={`${topic}-${step}`} label={topic === "slave" && step === 0 || topic === "xml" && step === 1 ? "右键" : topic === "xml" && step === 0 ? "XML" : undefined} />
        </svg>
      </Box>
      <Box sx={{ flexShrink: 0 }} aria-live={playing ? "off" : "polite"}>
        <Typography fontWeight={750}><Box component="span" sx={{ color: "primary.main", mr: 1 }}>{step + 1} / {guide.steps.length}</Box>{guide.steps[step][0]}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{guide.steps[step][1]}</Typography>
      </Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexShrink: 0 }}>
        <Button variant="outlined" startIcon={playing ? <PauseRounded /> : <PlayArrowRounded />} onClick={() => playing ? setPlaying(false) : step === guide.steps.length - 1 ? replay() : setPlaying(true)}>{playing ? "暂停" : step === guide.steps.length - 1 ? "再次播放" : "播放"}</Button>
        <Tooltip title="从头重播"><IconButton aria-label="从头重播" onClick={replay}><ReplayRounded /></IconButton></Tooltip>
        <Box sx={{ display: "flex", flex: 1, gap: 0.75, ml: "12px !important" }}>
          {guide.steps.map(([title], index) => <button key={index} className={`guide-progress${index <= step ? " guide-progress-filled" : ""}`} aria-label={`第 ${index + 1} 步：${title}`} aria-current={index === step ? "step" : undefined} title={title} onClick={() => { setPlaying(false); setStep(index); }} />)}
        </Box>
      </Stack>
    </DialogContent>
  </Dialog>;
}
