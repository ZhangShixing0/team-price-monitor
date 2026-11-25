# 可选的网站发布

网友从同一个网址打开网页和报价。网页只读，每小时采集任务可单独把完整报价发到这个站点。未设置站点地址和发布凭据时，本地采集照常运行。

## 上线时的配置

1. 在自己的 Cloudflare 账户创建私有 R2 存储桶。将本目录的 `wrangler.example.toml` 作为 Wrangler 配置模板，修改 Worker 名称与 `bucket_name`。静态网页使用 `../site`；其中的本地报价文件由 `.assetsignore` 排除。
2. 在 Worker 的 Secrets 中设置随机生成的 `PUBLISH_TOKEN`，绑定对应存储桶为 `QUOTES`，按模板部署 Worker 和静态网页。桶内的 `manifest.json` 和 `snapshots/` 是线上报价，保留仍被清单引用的版本。
3. 为运行采集任务的环境设置 `PRICE_SITE_URL`（HTTPS 站点根地址）和 `PRICE_SITE_TOKEN`（与 Worker 的发布口令相同）。此口令仅控制本网站的报价发布；无需给采集程序 Cloudflare 账号令牌。用 Muse 或其他任务系统提供的私密变量保存口令，仓库中仅保留变量名。

[Cloudflare 静态资源](https://developers.cloudflare.com/workers/static-assets/binding/) · [R2 条件写入](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

## 一次发布

每次先向 `POST /_publish` 发本轮清单，若该版本还没有存入，站点返回 428，发布程序补传版本文件。Worker 校验文件哈希、商品标识、字段与数量，先写入不可变文件，再以当前清单的 ETag 为条件切换版本。原店未采全时，本地任务不会产生新的完整版本。发布中断或旧轮抢写时，先前线上版本仍能打开。同一轮可以安全重发。出现 409 时检查网站已经接受的核验时间，优先使用较新的完整轮次。

站点的 `GET /data/manifest.json` 返回最近成功发布的清单。`GET /data/snapshots/<sha256>.json` 返回对应版本。浏览器按版本缓存报价。此配置提供带认证的发布端和公开只读端，部署、域名绑定和费用由站点所有者管理。

从仅有 Team 的旧站升级时，先发布新版 Worker 和网页，再更新采集任务。新版网页可继续打开旧版快照。采集任务首次完整核验后，清单会升级为第二版，报价记录带有套餐、品牌依据和规格说明。升级后的站点只接受新版采集任务产生的实时核验清单。历史回放可在本地预览，保留归档时的核验日期。

## 重传最近一次成功版本

在仓库根目录，使用已设置站点地址和发布口令的任务环境运行以下命令。它只读取原有报价文件，无须重新访问店铺。

```shell
node hosting/send.mjs
```

默认从 `site/data/` 读取。若采集程序把数据保存到其他位置，可用 `node hosting/send.mjs --output-dir 报价目录`。程序只读取该目录的 `manifest.json` 和其声明的固定哈希路径；远端失败可稍后用同一命令重试。
