# baw2lock · 币安 Agentic Wallet 工具（baw）的版本锁

一键安装用这两个档把 `@binance/agentic-wallet` 锁在一个确切版本（`package.json` 写版本、`package-lock.json` 写每个依赖的 sha512）：

- 第 1 个钱包：`npm install -g @binance/agentic-wallet@<这里的版本>`，装完核对 `baw --version` 要等于这个版本。
- 第 2 个以后的钱包：把这两个档复制到 `baw2pkg/`，`npm ci --prefix baw2pkg`（只照 lock 档装，任何一个依赖内容不符就中止）。

这两个档在官方签名清单（`radar/official.json`）里；被改过的话雷达的「官方版检查」会显示。要升级 baw 版本：改 `package.json` 的版本，在 `baw2lock/` 里跑 `npm install --package-lock-only`，再重签。
