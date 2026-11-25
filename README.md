<div align="center">

<h1>AI 订阅比价</h1>

<img src="docs/media/hero.svg" width="760" alt="两家示例店的 ChatGPT Plus 月付报价放在一起比较">

<p><strong>选好 ChatGPT 套餐，在相同规格下比较各家店铺的价格和库存。</strong></p>

<p><a href="docs/demo.html">获取免安装演示</a> · <a href="#快速开始">第一次使用</a> · <a href="docs/chatgpt-plans.md">查看历史统计</a> · <a href="docs/operations.md">自建比价页</a></p>

<p><a href="package.json"><img src="docs/badges/version.svg" alt="软件包版本 0.1.0"></a> <a href="docs/operations.md"><img src="docs/badges/runtime.svg" alt="自建运行环境 Node.js 22.13 或更高版本"></a></p>

</div>

## 同规格排序解决什么问题？

同样写着「Plus」，商家卖的可能是一张月卡，也可能是一整年的订阅。选中 **ChatGPT → Plus** 后，月付和年付各有一栏。下面的实际演示页面里，示例店乙的月付是 **¥76**，店甲是 **¥90**。切换排序就能调换先后，年付仍留在自己的栏里。

![免安装演示内的 Plus 报价。两家示例店的月付同组排列，年付单独展示。](docs/media/price-comparison.png)

列表保留原店标题。规格齐全的报价标为「同规格比价」，还有条件待核对的标为「仅列原店标价」。例如，Team 的 5× 和 10× 分栏，标题里写「支持 Codex」只说明功能，商品仍按实际交付的套餐归类。

## 快速开始

1. 打开[单文件演示](docs/demo.html)，点击 GitHub 文件页右上角的 **Download raw file**，双击下载的 `demo.html`。如果下载了整个项目，解压后打开 `docs/demo.html` 即可。
2. 品牌选 **ChatGPT**，点 **Plus、Pro 或 Team**。列表上方会显示有多少件商品、来自多少家店。
3. 在「排序」里选组内价格升序或降序；用库存筛选或店名搜索缩小范围。演示里的 3 家店和 8 件商品都是虚构的，断网也能操作。

**真实报价需要自行采集。** 仓库目前提供离线演示和自建程序。自建后，访客可以打开维护者提供的网址查价，看到每次核验的时间。

## 历史样本覆盖了哪些店

2026 年 11 月 18 日的归档记录了 **143 家店、259 个分类**。离线复算 4,562 件原始商品后，能够归到 ChatGPT 的部分如下。

| 套餐 | 商品 | 店铺 | 核验当时有货 |
| --- | ---: | ---: | ---: |
| Plus | 199 件 | 31 家 | 122 件 |
| Pro | 35 件 | 11 家 | 33 件 |
| Team | 203 件 | 22 家 | 110 件 |

这批店铺来自原先的 Team 巡检名单，Plus 和 Pro 的覆盖范围也受这份名单限制。另有 1,451 件 Team 候选的品牌待核，单独展示。历史样本中，以上 437 件归类商品都还有规格条件待核对。[统计口径与离线回放方法](docs/chatgpt-plans.md)

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
