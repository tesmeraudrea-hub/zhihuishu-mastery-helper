# 历史版本归档

这里保存目前在本地找到的 8 个完整发布包，以及从各包提取的原版脚本。按版本归档，不修改旧代码，也不把旧代码冒充为重新测试过的版本。日常安装请使用仓库根目录的最新版。

| 版本 | 原版源码 | 完整发布包 |
| --- | --- | --- |
| v1.5.2（发布草稿） | [查看源码](v1.5.2/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.5.2/%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E7%BB%83%E4%B9%A0%E5%8A%A9%E6%89%8B-v1.5.2-%E5%8F%91%E5%B8%83%E8%8D%89%E7%A8%BF.zip) |
| v1.5.3 | [查看源码](v1.5.3/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.5.3/%E7%9F%A5%E5%88%B0%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E6%BB%A1%E5%88%86%E5%8A%A9%E6%89%8B-v1.5.3.zip) |
| v1.5.4 | [查看源码](v1.5.4/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.5.4/%E7%9F%A5%E5%88%B0%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E6%BB%A1%E5%88%86%E5%8A%A9%E6%89%8B-v1.5.4.zip) |
| v1.6.0 | [查看源码](v1.6.0/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.6.0/%E7%9F%A5%E5%88%B0%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E6%BB%A1%E5%88%86%E5%8A%A9%E6%89%8B-v1.6.0.zip) |
| v1.6.1 | [查看源码](v1.6.1/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.6.1/%E7%9F%A5%E5%88%B0%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E6%BB%A1%E5%88%86%E5%8A%A9%E6%89%8B-v1.6.1.zip) |
| v1.7.0 | [查看源码](v1.7.0/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.7.0/%E7%9F%A5%E5%88%B0%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E6%BB%A1%E5%88%86%E5%8A%A9%E6%89%8B-v1.7.0.zip) |
| v1.8.0 | [查看源码](v1.8.0/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.8.0/%E7%9F%A5%E5%88%B0%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E6%BB%A1%E5%88%86%E5%8A%A9%E6%89%8B-v1.8.0.zip) |
| v1.8.1 | [查看源码](v1.8.1/zhihuishu-mastery.user.js) | [下载原始 ZIP](v1.8.1/%E7%9F%A5%E5%88%B0%E6%99%BA%E6%85%A7%E6%A0%91%E6%8E%8C%E6%8F%A1%E5%BA%A6%E6%BB%A1%E5%88%86%E5%8A%A9%E6%89%8B-v1.8.1.zip) |

## 归档范围

v1.5.2 以前只找到更新说明与测试产物，未找到可核实的完整源码或发布包。因此本仓库尚不能提供那些版本的完整安装文件，也没有按更新说明倒推重造旧代码。主要变化见根目录 [CHANGELOG.md](../CHANGELOG.md)。

独立测试版目前只保留了 [v1.8.1](../testing/zhihuishu-mastery-test.user.js)，更早测试版的完整源码暂缺。

## 完整性与使用

[manifest.json](manifest.json) 记录每份源码和原始发布包的 SHA256，可检查下载文件是否与归档一致。历史源码通过语法解析检查，ZIP 与本地原发布包逐字节一致；这不代表旧版本适用于今天的网站页面。

归档未包含个人题库、答题过程记录或账户凭据。旧包中的版本名、说明和历史行为按原样保留，可能与最新版不同。
