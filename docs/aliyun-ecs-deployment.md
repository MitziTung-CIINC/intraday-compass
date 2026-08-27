# 阿里云 ECS 部署说明

本项目可以部署在 Debian/Ubuntu ECS 上。公开版本默认通过项目自带的行情桥读取免费公开行情，不需要填写任何个人 API Key。

## 运行结构

- Nginx：对外提供 HTTP/HTTPS。
- Web 服务：仅监听 `127.0.0.1:4173`。
- 免费行情桥：仅监听 `127.0.0.1:8765`。
- 转债午盘发布器：交易日北京时间 11:35 生成，未成功时于 11:45、11:55 重试。
- 访客持仓和真实操作台账：保存在各自浏览器本地，不进入共享数据库。

仓库内的 `deploy/` 目录包含 systemd 和 Nginx 模板。部署时需安装 Node.js 22、pnpm、Git、Nginx 和 Certbot，再将仓库放到 `/opt/intraday-compass`，执行 `pnpm install --frozen-lockfile` 与 `pnpm build`。

在全新 Debian/Ubuntu ECS 上，也可以由 root 审阅后执行仓库中的 `deploy/install-aliyun.sh`。脚本只新增本项目的系统用户、Web/行情服务、转债午盘定时器和 `00t00.com` 站点文件，不会修改其他域名的 Nginx 文件；HTTPS 证书应在 HTTP 验证通过后单独签发。

午盘发布要求快照交易日期为当天、分钟数据至少到 11:30，并且所有发布候选都具有完整的转债/正股映射、分钟路径和评分字段。非交易日自动跳过；任一校验失败都会保留上一份有效快照。

## 更新版本

```bash
cd /opt/intraday-compass
sudo -u intraday-compass git pull --ff-only
sudo -u intraday-compass pnpm install --frozen-lockfile
sudo -u intraday-compass pnpm build
systemctl restart intraday-compass-quote intraday-compass-web
```

更新后先检查 `systemctl status` 和本机 `/quote` 响应，再对外开放。不要把券商、东方财富或其他 L2 API Key 写进仓库、前端代码或 Nginx 配置。
