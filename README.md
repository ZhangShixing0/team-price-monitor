<div align="center">

<h1>链动小铺 AI 订阅比价</h1>

<img src="docs/media/hero.svg" width="760" alt="2026 年 11 月 18 日的链动小铺归档中，有 ChatGPT Plus、Pro、Team 报价的店铺分别为 31、11、22 家">

<p><strong>在链动小铺买 ChatGPT，哪家卖得便宜，哪家还有货？选 Plus、Pro 或 Team，按同一规格比较多家商户的报价。</strong></p>

<p><a href="docs/shops.md">查看 20 家店铺</a> · <a href="docs/demo.html">试用比价界面</a> · <a href="docs/chatgpt-plans.md">查看历史统计</a> · <a href="docs/operations.md">自建比价页</a></p>

<p><a href="package.json"><img src="docs/badges/version.svg" alt="软件包版本 0.1.0"></a> <a href="docs/operations.md"><img src="docs/badges/runtime.svg" alt="自建运行环境 Node.js 22.13 或更高版本"></a></p>

</div>

## 同规格排序解决什么问题？

在诚心优选、玄奇仙市等链动小铺店铺之间挑套餐，光搜「Team」会碰到 5×、10× 和期限不同的席位；只看「Plus」，又容易拿月付和年付比价格。这个工具把多家商户的公开报价放到一页，保留原店标题、库存和核验时间。选好套餐就能在同规格内按价排序，也可以点商品标题回原店核对。[查看试点店铺名单及原店入口](docs/shops.md)

![比价界面的操作示范。虚构价格用于演示 Plus 月付按价排序、年付另列。](docs/media/price-comparison.png)

截图里的店名和价格只用于演示操作。实际采集时，规格齐全的报价标为「同规格比价」，仍有条件待核对的标为「仅列原店标价」。商家写「支持 Codex」只说明功能；K12 和 Steam 也会从 ChatGPT Team 结果里排除。

## 快速开始

1. 打开[单文件演示](docs/demo.html)，点击 GitHub 文件页右上角的 **Download raw file**，双击下载的 `demo.html`。如果下载了整个项目，解压后打开 `docs/demo.html` 即可。
2. 品牌选 **ChatGPT**，点 **Plus、Pro 或 Team**。列表上方会显示有多少件商品、来自多少家店。
3. 在「排序」里选组内价格升序或降序；用库存筛选或店名搜索缩小范围。演示里的 3 家店和 8 件商品都是虚构的，断网也能操作。

**要看商家现在的报价**，可以从[店铺目录](docs/shops.md)直接进入原店。想把多家报价放在同一页，请按[自建指南](docs/operations.md)运行采集。仓库目前提供离线演示和自建程序。

## 历史样本覆盖了哪些店

2026 年 11 月 18 日的归档记录了 **143 家店、259 个分类**。离线复算 4,562 件原始商品后，能够归到 ChatGPT 的部分如下。

| 套餐 | 商品 | 店铺 | 核验当时有货 |
| --- | ---: | ---: | ---: |
| Plus | 199 件 | 31 家 | 122 件 |
| Pro | 35 件 | 11 家 | 33 件 |
| Team | 203 件 | 22 家 | 110 件 |

这批店铺来自原先的 Team 巡检名单，Plus 和 Pro 的覆盖范围也受这份名单限制。另有 1,451 件 Team 候选的品牌待核，单独展示。历史样本中，以上 437 件归类商品都还有规格条件待核对。[统计口径与离线回放方法](docs/chatgpt-plans.md)

下次续费前还想找回这份店铺目录，可以点仓库右上角的 **Star** 收藏。发现漏收的链动小铺商家，或看到月卡被分进年卡，欢迎附上公开店铺链接和商品标题。[反馈店铺或分类问题](https://github.com/ZhangShixing0/team-price-monitor/issues)

## 自建与验证

在项目目录安装依赖，完成首轮采集后启动本地页面。需要 **Node.js 22.13+**；Windows 默认使用已安装的 Edge，Linux 的浏览器安装步骤见[自建指南](docs/operations.md)。

```sh
npm ci
npm run hourly
npm run preview
```

在同一台电脑打开[本地比价页](http://127.0.0.1:8768/)。默认配置核验 20 家试点店的已知分类。维护端可按小时运行，访客搜索和排序直接读取已经发布的报价。遇到原店验证或分页未读全时，已有网站继续显示上次完整报价及其核验时间。

本地运行 `npm test` 可以用固定样本检查套餐分类、排序和采集失败后的报价保留。[20 店采集实测](docs/pilot.md)

### 公开部署与数据安全

访客只需读取报价文件。部署时把写入凭据留在采集端，通过环境变量配置；网站对外提供只读页面。[定时运行与故障处理](docs/operations.md) · [云端发布配置](hosting/README.md)
