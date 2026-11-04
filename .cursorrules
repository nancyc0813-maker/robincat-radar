# 给 AI 的话（Claude Code／Codex／Cursor 等会自动读这个档）

这是「罗宾猫雷达」的资料夹。玩家想加功能或改设定时，**请先完整读 `AI说明书.md`**，照里面的规矩做：
不准碰私钥、不准转钱、改之前先用白话说明影响并等玩家同意、改完执行 `node --check watch.mjs` 确认还能跑。

规矩：程式里不留任何官方数字；买卖功能＝开关＋玩家自己填的数字、预设关、读不到资料只能「不买」或玩家选的备用条件（没有偷偷的备用路径）、矛盾的开关要互斥、要接逐条判断日志；能做成外挂（plugins/*.mjs）就做成外挂。详见 `AI说明书.md`。

v1.0.0（NEW-100）：全新产品，没有内建数字——买／卖／跳过／排除／通知／标签都只能是「开关＋玩家自己填的数字」，预设关；画面灰色建议字只是提示、引擎不读；官方来源只写在 `repo.cjs`。

**防破坏（GATE-1／GATE-2）**：AI **不准**直接写 `data/plugins_ok.json`、`data/guard.json`、`data/guard_key.bin`、`data/radar_orders.json`（下单档：没有主程式签章的单引擎不执行），也不准在 `data/radar_settings.json` 改 `plug.*.on`、`phone.*`、`auto.allowApproval`、`auto.sendOnPreviewFail`，不准拿掉 `estop`（紧急全停只有玩家在画面「重新设定」才能解除）——这些只能玩家在雷达画面自己按（会跳视窗确认），直接改档引擎会当作没开并发 TG。所有买／卖／授权都要经过 `watch.mjs` 的统一动作闸门 `actionGate`，不准绕过、不准改闸门。新增功能后一定要跑 `node --check <档>` 和 `node tools/guard_check.mjs --plugin <档>`（改了核心档就跑 `node tools/guard_check.mjs --local`），把结果原文给玩家看。
