# ChijiChat 💬

一个纯静态实时聊天室，基于 **Supabase** 作为后端，可部署到 **GitHub Pages**。

## 项目结构

```
chijichat-chatroom/
├── index.html       # 聊天室前端（所有代码都在一个文件）
└── .gitignore
```

## 无需服务器

聊天室使用 **Supabase** 作为后端服务：
- **数据库** — Supabase PostgreSQL 存储消息
- **实时订阅** — Supabase Realtime 实现实时消息推送
- **在线状态** — Supabase Presence 追踪在线人数

**不需要 Node.js 服务器，不需要 WebSocket 服务器，纯静态！**

---

## 🚀 部署步骤

### 1️⃣ 创建 Supabase 项目

1. 注册 [Supabase](https://supabase.com)（免费）
2. 点击 **New project**，填写项目名称
3. 设置数据库密码（保存好）
4. 等待项目创建完成（约 1-2 分钟）

### 2️⃣ 创建数据库表

进入 Supabase Dashboard → **SQL Editor**，运行以下 SQL：

```sql
-- 创建消息表
CREATE TABLE messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'chat'
);

-- 允许匿名用户读取和插入消息
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "允许所有人读取消息"
    ON messages FOR SELECT
    USING (true);

CREATE POLICY "允许所有人发送消息"
    ON messages FOR INSERT
    WITH CHECK (true);

-- 创建索引以加速历史查询
CREATE INDEX idx_messages_created_at ON messages (created_at);
```

### 3️⃣ 启用 Realtime

1. 进入 Supabase Dashboard → **Database** → **Replication**
2. 找到 `messages` 表，点击开关启用 Realtime

### 4️⃣ 配置前端

1. 进入 Supabase Dashboard → **Settings** → **API**
2. 复制 **Project URL**（`https://xxx.supabase.co`）和 **anon public key**
3. 修改 `index.html` 中的配置：

```js
const SUPABASE_URL = 'https://你的项目.supabase.co';
const SUPABASE_ANON_KEY = '你的匿名密钥';
```

### 5️⃣ 部署到 GitHub Pages

1. 将修改后的 `index.html` 推送到 `chijichan/chijichan.github.io` 仓库的 `main` 分支
2. 仓库已有 GitHub Actions 工作流，自动部署
3. 访问 `https://chijichan.github.io` 即可聊天！

---

## 📦 技术栈

| 技术 | 用途 |
|------|------|
| HTML + CSS + JS | 前端界面（无框架） |
| Supabase | 数据库 + 实时消息 + 在线状态 |
| GitHub Pages | 静态托管 |

## ✨ 功能

- ✅ 实时消息收发（Supabase Realtime）
- ✅ 在线人数显示（Supabase Presence）
- ✅ 消息历史记录（PostgreSQL）
- ✅ 昵称系统
- ✅ 暗色主题，响应式设计
- ✅ 无需后端服务器，完全静态