# ChijiChat

一个纯静态 **AI 聊天室**，基于 **Supabase** 作为后端，可部署到 **GitHub Pages**。

## 项目结构

```
chijichat-chatroom/
├── index.html       # 页面结构
├── style.css        # 样式（含登录层、Markdown 内容样式）
├── app.js           # 应用逻辑（状态管理、Realtime、流式 AI 调用）
└── .gitignore
```

## 无需服务器

使用 **Supabase** 作为后端服务：

- **数据库** — Supabase PostgreSQL 存储对话消息
- **实时订阅** — Supabase Realtime 同步消息
- **AI 接口** — 浏览器直接调用兼容 OpenAI 格式的 API，支持流式输出

**不需要 Node.js 服务器，纯静态！**

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
-- 消息表
CREATE TABLE IF NOT EXISTS messages (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    username TEXT NOT NULL,
    text TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'user'
);

-- 可选：AI 共享配置表
-- （仅当你希望把 AI 配置"同步到聊天室"共享给所有访客时才需要）
CREATE TABLE IF NOT EXISTS ai_config (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    api_endpoint TEXT NOT NULL,
    api_key TEXT NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT DEFAULT ''
);

-- RLS 策略
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "允许所有人读取消息" ON messages FOR SELECT USING (true);
CREATE POLICY "允许所有人发送消息" ON messages FOR INSERT WITH CHECK (true);
CREATE POLICY "允许所有人删除消息" ON messages FOR DELETE USING (true);

CREATE POLICY "允许所有人读取配置" ON ai_config FOR SELECT USING (true);
CREATE POLICY "允许所有人写入配置" ON ai_config FOR INSERT WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at);

-- 管理员密码表（存 bcrypt 哈希，不存明文）
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS admin_settings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    admin_password TEXT NOT NULL
);

ALTER TABLE admin_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "允许读取密码配置" ON admin_settings FOR SELECT USING (true);
CREATE POLICY "允许写入密码配置" ON admin_settings FOR INSERT WITH CHECK (true);

-- 校验管理员密码（表为空 → 返回 true，允许首次配置）
CREATE OR REPLACE FUNCTION verify_admin_password(pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    stored TEXT;
BEGIN
    SELECT admin_password INTO stored FROM admin_settings ORDER BY created_at DESC LIMIT 1;
    IF stored IS NULL OR stored = '' THEN
        RETURN TRUE;
    END IF;
    RETURN crypt(pwd, stored) = stored;
END;
$$;

-- 设置 / 修改 / 清除管理员密码（存 bcrypt 哈希）
-- 注意：Supabase 防护触发器禁止无 WHERE 的 DELETE，必须加 WHERE true
CREATE OR REPLACE FUNCTION set_admin_password(pwd TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM admin_settings WHERE true;
    IF pwd IS NULL OR length(pwd) < 4 THEN
        RETURN TRUE;
    END IF;
    INSERT INTO admin_settings (admin_password) VALUES (crypt(pwd, gen_salt('bf')));
    RETURN TRUE;
END;
$$;
```

> ⚠️ **安全提示**：`ai_config` 表对所有访客可读。因此 **API Key 默认只保存在浏览器 localStorage**，不会上传。只有当你在设置面板勾选 **"同步到聊天室"** 时，配置（含 Key）才会写入该表共享给所有人 —— 请仅在明确知道风险的情况下使用。
>
> 🔒 **管理员密码**：以 bcrypt 哈希存储在 `admin_settings` 表，前端仅通过 RPC 函数 `verify_admin_password` / `set_admin_password` 校验与设置，**任何访问者都无法从数据库读到密码明文**。忘记密码时，在 SQL Editor 执行 `DELETE FROM admin_settings;` 即可重置（重新打开设置可设置新密码）。

### 3️⃣ 启用 Realtime

1. 进入 Supabase Dashboard → **Database** → **Replication**
2. 找到 `messages` 表，点击开关启用 Realtime

### 4️⃣ 配置前端

1. 进入 Supabase Dashboard → **Settings** → **API**
2. 复制 **Project URL** 和 **anon public key**
3. 修改 `app.js` 顶部的配置：

```js
const SUPABASE_URL = 'https://你的项目.supabase.co';
const SUPABASE_ANON_KEY = '你的匿名密钥';
```

### 5️⃣ 部署到 GitHub Pages

1. 将修改后的文件推送到 `chijichan/chijichan.github.io` 仓库的 `main` 分支
2. 仓库已有 GitHub Actions 工作流，自动部署
3. 访问 `https://chijichan.github.io` 即可使用

### 6️⃣ 配置 AI 接口

进入聊天室后，点击右上角 **设置**，填写：

- **API 地址** — 兼容 OpenAI 的 API 端点
- **API Key** — 你的 API 密钥（仅保存在本地浏览器，除非勾选共享）
- **模型** — 如 gpt-4o-mini, deepseek-chat, claude-3-haiku 等
- **系统提示词** — AI 的角色设定
- **同步到聊天室** — 可选，勾选后配置共享给所有访客
- **管理员密码** — 设置后，打开设置需输入密码验证（密码存数据库哈希，前端不可读）

---

## ✨ 功能

- ✅ 实时消息收发（Supabase Realtime，按消息 id 去重，不重复不吞消息）
- ✅ 历史消息记录（PostgreSQL，加载最近 100 条）
- ✅ AI 流式回复（SSE，实时显示，失败自动降级为普通 JSON）
- ✅ Markdown 渲染（代码块、行内代码、粗体、斜体、链接、标题、列表）
- ✅ 昵称系统 + 暗色主题 + 响应式设计
- ✅ AI 请求超时控制（120s）与取消（清除对话时自动中止）
- ✅ 管理员密码保护设置（数据库存储 bcrypt 哈希，RPC 校验）
- ✅ 无需后端服务器，完全静态

---

## 📦 技术栈

| 技术 | 用途 |
|------|------|
| HTML + CSS + JS | 前端界面（无框架，按文件拆分） |
| Supabase | 数据库 + 实时同步 + 可选共享配置 |
| OpenAI API | AI 对话（兼容格式，支持流式） |
| GitHub Pages | 静态托管 |
