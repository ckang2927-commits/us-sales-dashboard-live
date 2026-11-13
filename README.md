# 美国站经营数据看板

固定网址（GitHub Pages）：https://ckang2927-commits.github.io/us-sales-dashboard-live/

本仓库仅用于公开网页发布。用户已授权任何拿到链接的人查看经营看板；完整源业务文件及交付备份仍位于私有仓库 `ckang2927-commits/us-sales-dashboard`。

更新时继续把发布资产提交到本仓库的 `main` 分支根目录。Pages 配置为该分支根目录后，每次提交会更新同一个网址，不需要重新转发链接。网页内容是最近发布的版本，不会自行抓取业务平台数据。

`index.html` 和 `loader.js` 加载当前 `dashboard-manifest.json`，校验并恢复完整 HTML；三个二进制分片为无损 gzip 内容。入口与业务数据均需一起更新，保留内容哈希命名，禁止上传凭据。
