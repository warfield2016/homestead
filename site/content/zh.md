# 三条命令，拥有你自己的 Farcaster

<p class="lede">租一台服务器，在上面运行 Snapchain 只读节点（read node），再用一个直接从这个节点读取、也通过它发帖的客户端。不需要任何人的 API 密钥。每个协议概念都会在你用到它的那一刻讲清楚。</p>

<div class="quick">

## 快速开始

你需要一个带有 `bash`、`curl`、`ssh` 和 `jq` 的终端（Mac 自带这四个）、一个 [Hetzner Cloud](https://www.hetzner.com/cloud) 或 [DigitalOcean](https://www.digitalocean.com) 账户，以及一个**已经有存储空间的测试用** Farcaster 账户。

```bash
git clone {{REPO}} && cd homestead
```

```bash
./homestead provision   # 0. rent a server
./homestead node        # 1. start a read node
./homestead client      # 2. start your client
```

0. **provision**：找到最便宜的、满足 4 核以上、16 GB 内存、2 TB 磁盘的服务器，显示实时价格，只有在你输入 `PROVISION` 后才会创建。
1. **node**：以只读节点方式安装 Farcaster 官方的 Snapchain。先恢复快照，再追上最新区块：需要几个小时，无需值守。
2. **client**：在你的服务器上构建客户端，打印出 `https://<你的IP>.sslip.io` 和登录口令。

在电脑或手机上打开这个网址，登录，连接你的测试账户。客户端会获得它自己的应用密钥（app key，不花 gas，不发交易），之后你就可以读时间线、发帖、关注、点赞、转发，并自己决定看哪些应用发出的内容。

用完之后：`./homestead destroy`。在 Hetzner 上测试一天大约花费 4–7 欧元，取决于当时哪些机型有货。

</div>

本页按这三条命令的顺序展开。每一步都会说明运行了什么、花多少钱、要多久，以及涉及协议的哪些部分。如果你只想跑起来，带框的内容可以跳过；如果你想把 Farcaster 理解到足以自己写一个客户端，请读它们。

> [!NOTE] 完成后你会拥有
> - 一份完整的 Farcaster 数据（约 9.14 亿条消息、330 万个账户），存放在你自己控制的机器上，由你的节点持续更新。
> - 一个运行在你自己 HTTPS 地址上的客户端，桌面和手机都能用。它只从你的节点读取数据，也只把你的写操作发给你的节点。
> - 一把属于这个客户端的应用密钥：只能发帖、删帖、互动和关注，别的都不能做；长时间不用会自动过期。

## 开始之前

### 你需要什么

| | |
|---|---|
| 一台电脑 | macOS 或 Linux。Windows 可在 WSL 中使用。Mac 上无需安装任何东西。 |
| 一个云服务账户 | Hetzner Cloud（最便宜）或 DigitalOcean。或者任何你已有的、4 核 16 GB 内存、2 TB 空闲磁盘的 Linux 机器（[自带机器](#自带机器)）。 |
| 一个有存储空间的 Farcaster **测试**账户 | 任何你丢了也无所谓的账户。见[获取测试账户](#获取测试账户)。 |
| 时间 | 大约 15 分钟的操作，加上节点同步时几个小时的等待。 |
| 费用 | 按 Hetzner 2026 年 10 月的价格：每月约 130–200 欧元（取决于库存），按小时计费，测试一天约 4–7 欧元。大部分是 2 TB 存储卷的费用。脚本会先显示实时价格并等待你确认。 |

> [!WARNING] 请使用测试账户
> 在第 2 步中，你要么在客户端里输入助记词（recovery phrase），要么用钱包签名。助记词能完全控制一个账户：拿到它的人可以拿走账户、用户名以及该钱包里的一切。请像对待 `rm -rf /` 一样对待它：威力巨大，偶尔必须，绝不随手。请用一个一次性账户，并在把助记词粘贴到任何地方之前（包括这里）先读[关于助记词，实话实说](#关于助记词-实话实说)。

### 获取测试账户

Homestead 导入的是*已有*账户，不负责创建，因为创建账户需要在 OP Mainnet 上发一笔交易、花一点 ETH。两种简单的方法：

- **Farcaster 应用。** 在 [Farcaster 应用](https://farcaster.xyz)里再注册一个账户，它自带存储空间。助记词在应用的设置里。
- **自己上链注册。** 在 OP Mainnet 上通过 IdGateway 合约注册一个 FID，注册时附带一个存储单元。2026-10-19 的价格是 0.0000841 ETH，约 0.2 美元（可自行查询 `IdGateway.price()`）。代码见[官方教程](https://snapchain.farcaster.xyz/guides/writing-messages)。

### 一张图看懂 Farcaster

> [!CONCEPT] 两套系统，一个账户
> Farcaster 由两部分组成。
>
> **账户在链上，位于 OP Mainnet**（以太坊二层网络）。几份合约记录了谁拥有什么：
> - **IdRegistry** 给每个账户分配一个编号，即 **FID**（Farcaster ID），并记录哪个以太坊地址拥有它：**托管地址（custody address）**。
> - **KeyRegistry** 记录托管地址授权过的**应用密钥**（旧的链上方式）。
> - **StorageRegistry** 记录每个 FID 租用了多少**存储空间**。
>
> **人们说的、做的一切都在 Snapchain 上**：发帖（cast）、点赞、转发、关注、个人资料。这些都是**消息（message）**，每条都由一把应用密钥签名。Snapchain 是一个专门构建的网络，把这些消息排序打包成区块，并在每个节点上保存一份副本。
>
> Snapchain 节点会监听 OP Mainnet 上的合约，把这些**链上事件**一并写进区块。所以你的节点知道每个 FID、托管地址、应用密钥和存储单元，你不需要运行以太坊节点，也不需要付费 RPC。

---

## 0. 准备服务器

```bash
./homestead provision            # Hetzner Cloud (default)
./homestead provision digitalocean
./homestead provision byo root@203.0.113.7
```

### 节点需要什么，为什么

这是 [Snapchain 公布的配置要求](https://snapchain.farcaster.xyz/getting-started)：4 个 CPU 核心、16 GB 内存、2 TB 空闲磁盘，并且 3381–3383 端口可从外部访问。

磁盘这一项最值得说。2026-10-18 时，主网快照共 5,691 个分块，每块约 70 MB，压缩后约 400 GB；解包后的数据库约 550 GB。你需要的空间比两者之和还多，原因在于恢复的方式。根据 [`snapshot.rs`](https://github.com/farcasterxyz/snapchain/blob/main/src/storage/db/snapshot.rs)，对每个分片，节点会：

1. 把所有压缩分块下载到 `.rocks.snapshot/`；
2. 把它们全部解压成一个 `.tar` 文件，同样放在 `.rocks.snapshot/`；
3. 把 tar 解包到数据库目录；

并且直到最后一个分片完成后才删除 `.rocks.snapshot/`。峰值时，压缩分块、未压缩的 tar 和数据库同时存在：约 1.5 TB。之后数据库还会继续增长。

> [!WHY] 为什么要单独的 2 TB 存储卷
> Hetzner 没有任何云主机套餐自带 2 TB 本地磁盘，所以 Homestead 会挂载一个 2 TB 的块存储卷，挂在 Snapchain 存放数据的位置（`/root/snapchain`）。以后不够用时，可以直接扩容，不必动服务器。

### 这条命令做了什么

在 Hetzner 上，`./homestead provision` 会：

1. 请你输入 API 令牌（输入不回显，永不写入磁盘）。请在一个**新的空项目**里，于 *Security → API tokens* 下创建，这样令牌碰不到别的东西；
2. 列出你所在地区此刻有货的机型，筛选出 4 核以上、16 GB 以上内存的，选最便宜的。Snapchain 同时发布 `arm64` 和 `amd64` 镜像，所以 ARM 机器也行。按 Hetzner 2026 年 10 月公布的价格，最便宜的是 CX43（每月 15.99 欧元）和 CAX31（20.99 欧元），但这两个系列自 9 月起经常缺货；缺货时，下一个选择是 CCX23（85.99 欧元）。2 TB 存储卷每月约 114 欧元；
3. 从 API 读取实时价格，打印每月总价和一天的费用，然后等你输入 `PROVISION`；
4. 依次创建：一把 Homestead 专用的 SSH 密钥（放在 `.homestead/ssh/`，不碰你的 `~/.ssh`）、一个防火墙、一个 2 TB 存储卷，以及一台挂载了两者的 Ubuntu 24.04 服务器；
5. 等到能 SSH 登录后，检查 CPU 和内存。

它创建的所有东西都记录在 `.homestead/state`（里面没有任何密钥），命令 1、2 和 `destroy` 就是靠它找到服务器的。

防火墙只开放这些端口：

| 端口 | 用途 | 谁来连接 |
|---|---|---|
| 22/tcp | SSH | 你 |
| 80/tcp、443/tcp | 通过 HTTPS 访问客户端（80 用于证书验证） | 你，任何设备 |
| 3382/udp | Snapchain gossip 通信（基于 QUIC 的 libp2p） | 其他节点。必需。 |
| 3381/tcp | Snapchain HTTP API | 任何人。Snapchain 文档建议开放。 |
| 3383/tcp | Snapchain gRPC API | 任何人。Snapchain 文档建议开放。 |

> [!NOTE] 你的节点 API 是公开的
> 开放 3381 和 3383 后，任何人都能从你的节点读取数据，也能向它提交消息。网络本来就是这样设计的：读到的都是公开数据，而每次写入都必须带有效签名。如果你不想为陌生人服务，可以删掉这两条防火墙规则；你自己的客户端通过 localhost 访问节点，不需要它们。

想不创建任何东西先看一遍？运行 `HOMESTEAD_DRY_RUN=1 ./homestead provision`：它会显示方案，并打印本来要发出的 API 请求。

### 自带机器

任何支持 Docker、4 核以上、16 GB 内存、2 TB 空闲磁盘的 Linux 机器都可以：家里的服务器、Netcup 或 OVH 的独立服务器、EC2 实例。

```bash
./homestead provision byo root@your.server        # uses your normal SSH setup
./homestead provision byo ubuntu@your.server ~/.ssh/key.pem
```

请自行在路由器或云防火墙上开放 3382/udp（必需）和 80/443/tcp（客户端用）。

---

## 1. 运行 Snapchain 只读节点

```bash
./homestead node
```

它会问你两件事，和 Farcaster 官方安装脚本问的一样：确认你知道运行节点没有奖励；以及（可选）你的 FID，它只用来决定节点在每周哪一天自动升级，避免所有节点同时升级。

### Snapchain 是什么

> [!CONCEPT] Snapchain：装满消息的区块
> Snapchain 是存储 Farcaster 消息的网络。可以把它想成一条区块链，只不过它的"交易"是发帖、点赞和关注。
>
> - **分片（shard）。** 账户被分散到若干*消息分片*上（目前是两个）。你的 FID 在哪个分片，取决于 `sha256(fid)` 的前四个字节对 2 取模再加 1。发帖、互动、关注和个人资料都进入作者所在的分片。**分片 0** 是*区块分片*：它把其他分片的数据块排成一个统一序列，并保存所有分片都需要的状态，比如免 gas 应用密钥。
> - **区块。** 每个分片大约每秒出一个块（实测：21 秒出了 21 个块）。节点 API 中的事件 ID 编码了区块高度：`id = 高度 × 2^14 + 序号`。
> - **验证者（validator）** 使用 [Malachite](https://github.com/informalsystems/malachite) BFT 共识提议并投票。超过三分之二权重投票后，区块即为最终确定。验证者是固定的、需许可的集合。
> - **只读节点（read node）** 运行同一个程序，只是设置了 `read_node = true`。它从不投票，只从对等节点下载已确定的区块并应用，所以最终状态完全相同，只是稍晚一点。任何人都可以运行。
>
> 你的节点就是只读节点。这就是关键所在：一份完整的、可验证的 Farcaster 副本，无需任何许可。

### 这条命令做了什么

在服务器上，以 root 身份，`./homestead node` 会：

1. 把 2 TB 存储卷挂载到 `/root/snapchain`（只有在卷上没有文件系统时才格式化）；
2. 用 Docker 官方的便捷脚本安装 Docker；
3. 把你的两个回答写进 `/root/snapchain/.env`，让官方安装脚本不再停下来询问；
4. 写一个 `docker-compose.override.yml`，把 Grafana（默认密码 `admin`）和 statsd 绑定到 `127.0.0.1`。官方 compose 文件会把它们暴露在所有网卡上，而 override 文件是[官方文档推荐的](https://snapchain.farcaster.xyz/guides/managing-a-node#customizing-the-node)修改方式；
5. 下载并运行 Farcaster 自己的 [`snapchain.sh upgrade`](https://snapchain.farcaster.xyz/guides/managing-a-node)：它会获取主网 compose 文件和验证者列表、配置 Grafana、安装每周自动升级的 cron 任务，并启动节点。

Homestead 不 fork、不修改 Snapchain。Farcaster 发布新版本时，你的节点会通过每周的 cron 任务自动更新。

### 观察同步进度

```bash
./homestead status --watch
```

同步分两个阶段。

**1. 恢复快照（大部分等待时间）。** 节点依次下载分片 1、2、0，并逐个解包。这时 HTTP API 还没有启动，`status` 会从节点日志中读取进度。输出类似这样（数字仅为示例）：

```console
node: container running (up since 2026-10-19T09:12:04)
snapshot: downloading shard 1: chunk 1204 of 2672 Shard ETA: 0h41m
          (shards restore one after another: 1, 2, then 0; each is unpacked right after it downloads)
disk: 141G used, 1.7T free
```

**2. 追赶。** 恢复完成后，节点从对等节点获取快照之后确定的所有区块并重放。这时 API 已经可以访问，`blockDelay`（每个分片最新区块落后当前时间的秒数）会逐渐减少。例如：

```console
shard 0: height 48337984  catching up: 5120s behind
shard 1: height 49013206  in sync (1s behind)
shard 2: height 48848731  in sync (0s behind)
```

当每个分片都只落后几秒时，同步就完成了。在 Hetzner 上，总共大约需要几个小时，主要是下载。

### 你的第一次查询

节点的 HTTP API 就是普通的 JSON + GET。在服务器上（`./homestead ssh`）：

```bash
curl -s localhost:3381/v1/info | jq '.dbStats'
```

```json
{
  "numMessages": 914249478,
  "numFidRegistrations": 3355205,
  "approxSize": 548710481099
}
```

```bash
curl -s 'localhost:3381/v1/castsByFid?fid=1&pageSize=1&reverse=true' | jq '.messages[0]'
```

这就是一条原始消息，其他一切都由它构成：

```json
{
  "data": {
    "type": "MESSAGE_TYPE_CAST_ADD",
    "fid": 1,
    "timestamp": 182710221,
    "network": "FARCASTER_NETWORK_MAINNET",
    "castAddBody": {
      "text": " ",
      "mentions": [14206, 19960],
      "mentionsPositions": [0, 1],
      "parentCastId": { "fid": 852612, "hash": "0x9d37ece822109756e40b8624abdb0c88e9e8a5d5" },
      "embeds": [],
      "type": "CAST"
    }
  },
  "hash": "0xa7cfccb85b71ecd53945dec4c53161a8a4aed77b",
  "hashScheme": "HASH_SCHEME_BLAKE3",
  "signature": "3muv+tUjyXsmLWMy8Js55K3Iu9dWVtXl3qqBgcn0eJefvYgzj6rA2ih9Ebp+oaH6vrslaowGNDQnV2Pi/peABQ==",
  "signatureScheme": "SIGNATURE_SCHEME_ED25519",
  "signer": "0xb85cf7feef230f30925b101223fd3e3dc4e1120bacd677f5ad3523288f8f7102"
}
```

> [!CONCEPT] 一条消息的结构
> - **`data`** 是说了什么：类型、作者的 FID、时间戳和正文。它以 protobuf 编码后，就是被哈希和签名的内容。
> - **`hash`** 是对编码后的 `data` 做 BLAKE3 哈希取前 20 字节。它是消息的 ID；回复和点赞都指向 `(fid, hash)`。
> - **`signature`** 是用某把**应用密钥**对哈希做的 Ed25519 签名。
> - **`signer`** 是那把应用密钥的公钥。只有当这把密钥当前被授权给这个 FID 时，节点才接受这条消息。
> - **`timestamp`** 是从 Farcaster 纪元（2021-01-01 00:00 UTC）开始的秒数。182710221 对应 2026-10-15。时间戳是作者自己声明的：节点会拒绝超前 15 分钟以上的消息，但旧规则放进来过少数怪异的，主网上甚至有一条"来自" 2061 年的帖子。
> - **提及（mention）不在正文里。** 这条帖子显示为 `@用户1 @用户2`：正文只有一个空格，客户端根据 `mentionsPositions` 中的字节偏移把 `@用户名` 插回去。注意是 UTF-8 *字节*偏移：一个表情符号占四个字节，一个汉字占三个。

---

## 2. 创建客户端

```bash
./homestead client
```

```console
Your client:   https://203-0-113-7.sslip.io
Passphrase:    k7pqm-2xw9v-hc4rt-b8nzf   (shown once — save it in your password manager)
```

节点还在同步时就可以运行这条命令。客户端会先启动，页面会告诉你它在等什么。

### 这条命令做了什么

1. 把本仓库的 `client/` 和 `deploy/` 复制到服务器的 `/opt/homestead`。
2. **在服务器上、用这份源码**构建客户端的 Docker 镜像，并用 Docker Compose 启动。它与 Farcaster 的 compose 项目并列（而非嵌入其中），所以 `snapchain.sh upgrade` 永远不会覆盖它。
3. 在前面启动 [Caddy](https://caddyserver.com) 提供 HTTPS。你不需要域名：`203-0-113-7.sslip.io` 是一个 [sslip.io](https://sslip.io) 域名，会解析到 `203.0.113.7`，Caddy 会自动为它申请 Let's Encrypt 证书。用 `--domain` 可以换成你自己的域名。
4. 生成一个登录口令（约 95 位熵），通过 SSH 的标准输入发到服务器，这样它不会出现在进程列表里；服务器只保存它的 scrypt 哈希。

`--private` 会跳过 Caddy，把客户端绑定在服务器的 `127.0.0.1` 上。用 `./homestead tunnel` 后访问 `http://localhost:8080`。

> [!WHY] 为什么客户端是个服务器，而不只是网页
> 客户端持有一把能以你的身份发帖的私钥。把它放在你的服务器上，你的手机和电脑就不需要存储它，所有设备登录后共用同一把密钥。客户端还能通过 localhost 访问节点、保持与节点事件流的长连接，并缓存它学到的东西。浏览器那部分只是一层很薄的界面。

### 连接你的账户

登录后，客户端会请你连接一个账户。这里 Farcaster 的密钥模型就很关键了。

> [!CONCEPT] FID、托管地址和应用密钥
> - **FID** 是你的账户编号。用户名（fname，如 `@alice`；或 ENS 名，如 `alice.eth`）指向 FID；FID 本身永不改变。
> - FID 归一个**托管地址**所有，它是一个以太坊账户。你的助记词（BIP-39）沿标准以太坊路径 `m/44'/60'/0'/0/0` 推导出这个账户的私钥。托管密钥可以转移 FID、修改恢复地址、授权密钥。它是万能钥匙。
> - 应用永远拿不到托管密钥。托管密钥会授权一把**应用密钥**（协议里叫 *signer*）：由应用自己生成并保管的 Ed25519 密钥对。每一次发帖、点赞和关注都由应用密钥签名。
> - 每把应用密钥都记录着是哪个应用申请的，用那个应用自己的 FID（`requestFid`）表示。因此任何人都能看出一条帖子是"通过"哪个应用发出的，下文的过滤功能正是基于这一点。

**第一步：找到你的账户。** 你可以粘贴助记词，也可以连接浏览器钱包。两种方式都由浏览器算出托管地址，只把地址发给你的服务器。服务器去问*你的节点*：

```bash
curl -s 'localhost:3381/v1/onChainIdRegistryEventByAddress?address=0x6b0bda3f2ffed5efc83fa8c024acff1dd45793f1' | jq '{fid, to: .idRegisterEventBody.to}'
```

然后再核实这个地址仍是*当前的*托管地址（账户可以被转移），并且账户有存储空间。它会把找到的 FID、用户名和存储情况显示给你。

**第二步：签两条消息。** 服务器生成一对新的 Ed25519 密钥，请浏览器用托管密钥签署两个 [EIP-712](https://eips.ethereum.org/EIPS/eip-712) 结构化数据。页面会在你签名前把它们展示出来，内容类似这样：

```json
[
  {
    "domain": { "name": "Farcaster KeyAdd", "version": "1", "chainId": 1 },
    "primaryType": "SignedKeyRequest",
    "message": { "requestFid": "1234567", "key": "0x7f3c…a21e", "deadline": "182796043" }
  },
  {
    "domain": { "name": "Farcaster KeyAdd", "version": "1", "chainId": 1 },
    "primaryType": "KeyAdd",
    "message": {
      "fid": "1234567", "key": "0x7f3c…a21e", "keyType": 1,
      "scopes": [1, 2, 3, 4, 5, 6], "ttl": 2592000,
      "nonce": 1, "deadline": "182796043"
    }
  }
]
```

- **SignedKeyRequest** 的意思是：*应用 FID `requestFid` 申请密钥 `key`*。Homestead 用你自己的 FID 充当应用；一个有品牌的客户端会注册自己的应用 FID，并用那个 FID 的托管密钥签署这一条。
- **KeyAdd** 的意思是：*FID `fid` 授权 `key` 签署这些类型的消息，有效这么久*。`scopes` 1–6 分别是发帖/删帖、添加/取消互动、添加/取消关注（link）。`ttl` 为 30 天。`nonce` 是节点报告的计数器加一，因此这份授权无法被重放。

**第三步：服务器构建并提交 `KEY_ADD`。** 它先验证两个签名都能恢复出你的托管地址，再把它们打包进一条 `KEY_ADD` 消息，**用这把新的应用密钥自己给消息外层签名**（证明提交者确实持有这把密钥），然后提交给你的节点，并等待节点报告这把密钥：

```bash
curl -s 'localhost:3381/v1/signersByFid?fid=1234567' | jq '.signers[] | {source, key, requestFid, scopes, addedAt, expiresAt}'
```

```json
{
  "source": "SIGNER_SOURCE_OFFCHAIN",
  "key": "0x7f3c…a21e",
  "requestFid": 1234567,
  "scopes": ["MESSAGE_TYPE_CAST_ADD", "MESSAGE_TYPE_CAST_REMOVE", "MESSAGE_TYPE_REACTION_ADD", "MESSAGE_TYPE_REACTION_REMOVE", "MESSAGE_TYPE_LINK_ADD", "MESSAGE_TYPE_LINK_REMOVE"],
  "addedAt": 1792350494,
  "expiresAt": 1794942494
}
```

读这些记录时有个坑：`addedAt`、`lastUsedAt` 和 `expiresAt` 是 **Unix** 秒，而消息时间戳是从 Farcaster 纪元起算的。`expiresAt − lastUsedAt` 就是 TTL。


没有交易，没有 gas，大约一秒。

> [!CONCEPT] 免 gas 应用密钥（引擎 V16，2026-05-07 起在主网生效）
> 过去，添加应用密钥需要向 OP Mainnet 上的 KeyRegistry 合约发一笔交易。这种方式仍然可用，这些**链上**密钥也照常签名，但要付 gas、要等出块。**免 gas** 密钥改用一条 `KEY_ADD` 消息添加，有三点不同：
>
> - **权限范围（scope）。** 免 gas 密钥会列出它可以签署的消息类型。Homestead 的密钥不能修改你的资料，不能添加验证地址；任何密钥都永远不能添加或删除其他密钥。
> - **滑动有效期（TTL）。** 密钥在 `ttl` 秒（最长 90 天）未使用后过期。每签一条消息就重新计时。被遗弃的密钥会自己退役。
> - **Nonce。** 每个 FID 有一个计数器；每次 `KEY_ADD` 必须使用比上次更大的数。
>
> 每个 FID 最多可以有 1,000 把免 gas 密钥。`KEY_ADD` 和 `KEY_REMOVE` 被路由到分片 0，因为每个分片都需要知道哪些密钥有效。
>
> 如果你自己实现，有一个坑：免 gas 的 `SignedKeyRequest` 在 `"Farcaster KeyAdd"` 域上签名（`chainId` 为 1，没有 `verifyingContract`）；旧的链上流程则在链 10 上签 `"Farcaster SignedKeyRequestValidator"`。两者的签名互不通用。请使用 `getGaslessSignedKeyRequestMetadata`，而不是 `getSignedKeyRequestMetadata`。

### 关于助记词，实话实说

Balaji 在[补充说明](https://farcaster.xyz/balajis.eth/0x50184b62)里说得好：开发者教程对待助记词，应当像 Unix 教程对待 `rm -rf` 一样。所以，直说：

- **用测试账户。** 不要用主账户，不要用你在乎用户名的账户，不要用钱包里有资产的账户。
- **只把助记词粘贴到你读过代码、或信任其开发者的软件里。** 对 Homestead 也一样，不要只听本页的一面之词。
- **优先使用委托签名。** 客户端的*用浏览器钱包签名*选项会把同样的两个签名请求发给你已经信任的钱包（钱包背后再接一个硬件钱包更好）。助记词完全不经过 Homestead。只要你的托管地址在这样的钱包里，就用这种方式。

Homestead 如何处理助记词，方便你核查：

1. 助记词输入在**你自己的**服务器提供的页面里。相关代码全部在一个文件中：[`client/src/web/signing.ts`]({{REPO}}/blob/main/client/src/web/signing.ts)，约 110 行。
2. 浏览器在内存中推导出托管账户，签署上面两条数据，然后清空输入框。**助记词不会被发送到任何地方**：打开浏览器的网络面板，你只会看到发出了一个地址，然后是两个签名。
3. 签名前，这个文件会检查数据是否恰好是 `"Farcaster KeyAdd"` 域上的这两种类型之一，其他一律拒绝。被攻破的服务器也无法骗这个页面去签别的东西，比如转移你的账户。
4. 服务器只保存新的应用密钥，从不保存助记词或托管密钥。

万一出了问题，暴露的也只有应用密钥：在你撤销之前它能以你的名义发帖，但拿不走你的账户。客户端的 **Keys** 页面有一个*撤销*按钮，不需要助记词（见下文）。

### 读：时间线是怎么来的

Farcaster 没有"时间线 API"。客户端要用原始消息自己拼出来。Homestead 分三步，全部针对你的节点：

1. **你关注了谁？** `GET /v1/linksByFid?fid=<你>&link_type=follow`，读完所有分页。
2. **回填。** 对你关注的每个账户，`GET /v1/castsByFid?fid=<对方>&reverse=true&pageSize=10`，每次并发 8 个请求。对着 localhost 上的节点，即使关注了几千人也只要几秒。
3. **保持实时。** 对每个分片，从当前区块开始读取节点的事件流：`GET /v1/events?shard_index=1&from_event_id=<高度 × 2^14>`。每个 `MERGE_MESSAGE` 事件都是你的节点刚从某个区块中接受的消息。你关注的人的帖子进入时间线；删除的帖子移出；你自己的关注和点赞（即使来自别的应用）也会同步到客户端。

**Live** 标签页直接展示第 3 步：你的节点合并的每一条帖子，实时到达。这是你的节点所看到的网络，不排序、不推荐；对一个全新的测试账户来说，也是找人关注的最好地方。

### 写：你的帖子去了哪里

当你点击 *Cast*：

1. 服务器用你的正文、提及（在你的节点上解析成 FID）和嵌入链接构建一条 `CAST_ADD`，用应用密钥签名，把 protobuf 字节 `POST` 到你节点的 `/v1/submitMessage`。
2. 你的节点像验证者一样检查它：签名有效、密钥有效且有相应权限、存储空间足够。通过后，节点**在 `mempool` 主题上把它 gossip 给验证者**。只读节点没有自己的内存池，此时什么也不存。
3. 某个验证者把它打包进区块，验证者们达成共识。你的节点收到这个区块并合并这条消息，它就出现在事件流里。

客户端会在角落显示一张回执，例如 *accepted by your node in 40 ms → in block 49,013,227 (shard 1) after 1.6 s*：前一个数字是你的节点验证所用的时间，后一个是直到你的节点在已确定区块中看到这条消息的时间。

> [!WARNING] 被接受不等于被打包
> `submitMessage` 返回 `200` 的意思是*已验证并转发*，不是*已进入区块*。如果 gossip 丢失，消息永远不会上链，你需要重新提交。这就是为什么 Homestead 在事件流里等待这条消息出现，而不是相信返回值。需要以太坊 L1 检查的只读节点提交（ENS 名字、智能合约钱包验证）在高负载时最容易被丢弃。

关注（`LINK_ADD`）、点赞和转发（`REACTION_ADD`）以及它们的取消，流程完全相同。删帖发送的是 `CAST_REMOVE`；原帖会变成一个"墓碑"，在被挤出之前仍然占用你的存储额度。

### 存储租金

> [!CONCEPT] 存储空间就是反垃圾机制
> 每个 FID 都必须从 StorageRegistry 合约租用存储空间，以**单元**计。现在租一个单元约 **0.2 美元**（2026-10-19 为 0.0000841 ETH；价格以美元锚定），有效期**一年**。每个单元对每种消息类型有固定的条数上限。某一类型存满后，你最旧的那类消息会被修剪掉以腾出空间。存储到期后有一段宽限期，之后你的消息可能被删除。
>
> 不同时期租的单元容量不同，因为协议已经两次重新划分单位。上限来自 [`stores.rs`](https://github.com/farcasterxyz/snapchain/blob/main/src/storage/store/stores.rs)：
>
> | 单元类型 | 租用时间 | 帖子 | 互动 | 关注 | 资料字段 |
> |---|---|---|---|---|---|
> | Legacy | 2024 年 8 月之前 | 5,000 | 2,500 | 2,500 | 50 |
> | 2024 | 2024 年 8 月 – 2025 年 7 月 | 2,000 | 1,000 | 1,000 | 50 |
> | 2025 | 2025 年 7 月以后 | 100 | 200 | 200 | 25 |
>
> 旧的单元还被延长过有效期：协议升级把 legacy 单元延长到了四年。任何账户的确切情况，你的节点都知道：

```bash
curl -s 'localhost:3381/v1/storageLimitsByFid?fid=1' | jq '{units, unitDetails, casts: (.limits[] | select(.name == "CASTS"))}'
```

```json
{
  "units": 22,
  "unitDetails": [
    { "unitType": "UnitTypeLegacy", "unitSize": 19 },
    { "unitType": "UnitType2024", "unitSize": 3 },
    { "unitType": "UnitType2025", "unitSize": 0 }
  ],
  "casts": { "name": "CASTS", "limit": 101000, "used": 3797 }
}
```

19 个 legacy 单元 × 5,000 + 3 个 2024 单元 × 2,000 = 101,000 条帖子。一个全新账户只有一个 2025 单元，只能存 100 条帖子，所以在测试账户上，旧帖子很快就会被修剪。

### 选择看哪些应用的内容

Homestead 里每条帖子都标明了是哪个应用发出的：*via Warpcast*、*via Firefly App*、*via Neynar*，或者 *own key*（作者在运行自己的客户端，就像你现在这样）。

消息里并没有"客户端"字段。Homestead 是通过应用密钥推算出来的，原理见[上面的概念框](#连接你的账户)：

```
cast.signer  →  GET /v1/signer?fid=<author>&signer=<key>  →  requestFid  →  that FID's profile
```

对免 gas 密钥，节点直接返回 `requestFid`。对旧的链上密钥，它藏在当初随 KeyRegistry 交易提交的、ABI 编码的 `SignedKeyRequestMetadata` 里，Homestead 会自己解码。例如 @dwr 的一把密钥的元数据解码后是 `requestFid: 9152`，即 Farcaster 应用。一把密钥对应的应用永不改变，所以每次查询结果都会永久缓存。

在 **Filter apps** 页面，你可以*隐藏*勾选的应用发出的帖子，或者*只显示*它们发出的帖子。屏蔽自动发帖的机器人，或者只看人们在小众独立客户端里写的内容。数据由你的节点提供，规则由你决定。

### 撤销密钥

三种方式，从温和到强硬：

1. **不再使用。** 免 gas 密钥在 TTL（这里是 30 天）内未使用就会过期。
2. **紧急按钮。** *Keys → Revoke this client's key* 会发送一条由这把密钥自己签名的 `KEY_REMOVE`。免 gas 密钥可以在没有托管密钥的情况下撤销自己，并使用按申请应用区分的独立 nonce 计数器，因此被攻破的应用可以迅速废掉自己的所有密钥。
3. **用托管地址。** 由托管密钥签名的 `KEY_REMOVE` 可以删除免 gas 密钥；KeyRegistry 的 `remove` 交易可以删除链上密钥（Farcaster 钱包里"已连接应用"页面做的就是这个）。

Keys 页面还会列出你账户上的每一把密钥（链上的和免 gas 的），以及申请它的应用。值得看一眼：大多数人连接过的应用比自己记得的多。

---

## 日常使用

| 命令 | 作用 |
|---|---|
| `./homestead status` | 每个分片的同步状态 |
| `./homestead logs node` · `logs client` | 查看日志 |
| `./homestead ssh` | 登录服务器 |
| `./homestead tunnel` | `localhost:8080` → 客户端，`localhost:3000` → Grafana（账号 `admin`/`admin`，请修改） |
| `./homestead client` | `git pull` 后重新部署；保留口令和密钥（`--new-passphrase` 可更换口令） |
| `./homestead destroy` | 删除服务器、存储卷、防火墙和密钥，停止计费 |

**升级。** 节点每周自动升级（cron 运行 `snapchain.sh autoupgrade`）。协议升级按引擎版本和时间戳排期，长期不升级的节点最终会跟不上链。长时间离开后，请检查一下 `./homestead status`。

**备份。** 节点数据库随时可以从快照重建。唯一值得备份的是客户端的 Docker 卷（`homestead_client-data`）：里面是应用密钥和口令哈希。丢了也只需重新连接一次。

**费用。** Hetzner 按小时计费，月费封顶。最大的一项是 2 TB 存储卷（按 2026 年 10 月价格每月约 114 欧元）。测试结束后，用 `./homestead destroy` 删除一切。

### 故障排查

| 现象 | 原因与解决 |
|---|---|
| `provision` 提示没有可用机型 | 该地区缺货。试试 `HOMESTEAD_LOCATION=nbg1`（或 `hel1`、`ash`、`hil`）。 |
| `status` 长时间停在同一个分块 | 下载卡住了。`./homestead logs node`；重启容器会断点续传。 |
| 恢复过程中磁盘不足 | 空闲空间不到约 1.5 TB。扩容存储卷，或用更大的卷重来（`HOMESTEAD_DISK_GB`）。 |
| HTTPS 一直起不来 | 80/443 端口被挡，或 Let's Encrypt 限流。查看 `./homestead logs client`。期间可用 `--private`。 |
| *No Farcaster account for this address* | 助记词或账户序号不对，或者节点还没同步完。Farcaster 应用使用序号 0。 |
| *Signatures don't match this account's custody address* | 钱包用来签名的地址与查询的地址不同。在钱包里切换账户后重试。 |
| 帖子一直没进区块 | gossip 中丢失了。重新提交；回执会显示它何时上链。 |
| 反复提示口令错误 | 尝试 10 次后登录会暂停 10 分钟。`./homestead client --new-passphrase` 可以设置新口令。 |

---

## 参考

### 术语表

| 术语 | 含义 |
|---|---|
| **FID** | Farcaster ID：账户的永久编号，由 OP Mainnet 上的 IdRegistry 发放。 |
| **托管地址** | 拥有某个 FID 的以太坊地址。它的私钥就是万能钥匙。 |
| **助记词** | 推导出托管密钥的 12 或 24 个 BIP-39 单词。 |
| **恢复地址** | 在托管地址丢失时，有权把 FID 转移到新托管地址的地址。 |
| **应用密钥 / signer** | 被授权为某个 FID 签署消息的 Ed25519 密钥。分链上（KeyRegistry）和免 gas（`KEY_ADD`）两种。 |
| **requestFid** | 申请某把应用密钥的应用的 FID。 |
| **消息** | 一次签名的操作：`CAST_ADD`、`REACTION_ADD`、`LINK_ADD`、`USER_DATA_ADD`…… |
| **存储单元** | 按 FID、按消息类型租用的容量。一年，约 0.2 美元。 |
| **fname** | 链下用户名，如 `@alice`，由 Farcaster 的域名服务器签发。节点保存它的签名证明，任何客户端都能解析。 |
| **Snapchain** | 把消息排序并按区块存储的网络。 |
| **分片** | Snapchain 的一个分区。分片 0 给其余分片排序；消息分片保存账户数据。 |
| **验证者** | 需许可集合中负责提议区块并投票的节点。 |
| **只读节点** | 跟随链但不投票的节点。会验证并转发写操作。 |
| **blockDelay** | 你的节点上某个分片的最新区块比当前时间落后的秒数。 |
| **Farcaster 纪元** | 2021-01-01T00:00:00Z。消息时间戳从此刻起计秒。 |

### Homestead 用到的节点接口

每次读取都是一个你可以自己对 `localhost:3381` 运行的 GET 请求：

| 接口 | 用途 |
|---|---|
| `/v1/info` | 同步状态、分片高度 |
| `/v1/onChainIdRegistryEventByAddress?address=` | 托管地址 → FID |
| `/v1/onChainEventsByFid?fid=&event_type=EVENT_TYPE_ID_REGISTER` | 这个地址还是托管地址吗？ |
| `/v1/storageLimitsByFid?fid=` | 存储单元和上限 |
| `/v1/signersByFid?fid=` | 所有应用密钥（链上和免 gas），以及下一个 `KEY_ADD` 的 nonce |
| `/v1/signer?fid=&signer=` | 单把密钥及其 `requestFid` |
| `/v1/linksByFid?fid=&link_type=follow` | 你关注的人 |
| `/v1/castsByFid`、`/v1/castById`、`/v1/castsByParent`、`/v1/castsByMention` | 帖子、讨论串、提及 |
| `/v1/reactionsByFid`、`/v1/reactionsByCast` | 点赞和转发 |
| `/v1/userDataByFid?fid=` | 个人资料 |
| `/v1/userNameProofByName?name=` | `@用户名` → FID，用于提及 |
| `/v1/events?shard_index=&from_event_id=` | 实时事件流 |
| `POST /v1/submitMessage` | 所有写操作，以 protobuf 字节提交 |

### 我们发现的过时文档

做这个项目时，我们把每个说法都对照了 Snapchain 源码。以下是文档已经过时的地方，以及我们准备的修正（[详情与进展]({{REPO}}/blob/main/docs/upstream/README.md)）：

- Snapchain 的 HTTP API 参考文档没有收录 `/v1/signersByFid` 和 `/v1/signer`，而免 gas 密钥指南恰恰要你使用这两个接口。
- 它的 JavaScript 分页示例传的是 `nextPageToken`（参数名其实是 `pageToken`），读取的是 `response.messages` 而不是 `response.data.messages`。
- `signersByFid` 的 `requesterFids` 要写成 `requesterFids[]=123`（节点用 `serde_qs` 解析查询参数）。源码注释建议的重复写法 `requesterFids=1&requesterFids=2` 会被拒绝，而百分号编码的方括号会被静默忽略，导致完全拿不到 nonce。
- `/v1/events` 不提供分片 0 的事件（返回 `Shard not found`），所以无法在那里监听免 gas 的 `KEY_ADD`；请改为轮询 `/v1/signer`。
- docs.farcaster.xyz 仍只列出 legacy 存储上限（每单元 5,000 条帖子）和 7 美元的单价；2025 单元只能存 100 条帖子，价格约 0.2 美元。
- docs.farcaster.xyz 说一条帖子最多 2 个嵌入；自引擎 V20（2026-08-13）起，所有账户都可以用 4 个。
- docs.farcaster.xyz 的 hello-world 仍用链上交易注册应用密钥，还在讲"hub"；Snapchain 版本的同一指南已改用免 gas 密钥。

### 资料来源

- [Snapchain 文档](https://snapchain.farcaster.xyz)：入门、节点管理、节点类型、写入消息、HTTP API
- [Snapchain 源码](https://github.com/farcasterxyz/snapchain)，尤其是 `src/storage/db/snapshot.rs`、`src/mempool/routing.rs`、`src/storage/store/stores.rs`、`src/network/http_server.rs`
- [`@farcaster/core`](https://github.com/farcasterxyz/hub-monorepo/tree/main/packages/core) 0.20.0：消息构建函数、`gaslessKeys.ts`
- [Farcaster 文档](https://docs.farcaster.xyz)：架构、账户、消息
- 悬赏原帖：[balajis.eth/0x50184b62](https://farcaster.xyz/balajis.eth/0x50184b62)

### 测试情况

- 客户端已对接真实主网节点测试（时间线、实时流、讨论串、应用来源识别、节点状态），并有单元测试，其中包括一个离线端到端检查：用浏览器签名构建的 `KEY_ADD` 能通过 `@farcaster/core` 的校验。见 [`docs/TESTING.md`]({{REPO}}/blob/main/docs/TESTING.md)。
- 命令 0 已对照 Hetzner API 的模拟服务测试（资源创建顺序、防火墙规则、价格计算、`destroy`）。
- 三条命令在全新机器上的完整运行记录见 [`docs/test-runs/`]({{REPO}}/tree/main/docs/test-runs)，每次都注明日期和 Snapchain 版本。

基于 Snapchain 0.14.2–0.14.3（引擎 V20）、`@farcaster/core` 0.20.0 和 Ubuntu 24.04。最后核对于 2026-10-19。
