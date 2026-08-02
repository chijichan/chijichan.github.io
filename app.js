/* =====================================================================
 * ChijiChat - AI 聊天室
 *
 * 架构说明：
 *  - Supabase：消息存储 + Realtime 实时同步（可选：AI 配置共享）
 *  - AI 配置：默认保存在浏览器 localStorage（安全），
 *             可选勾选"同步到聊天室"共享到 Supabase 供所有人使用
 *  - AI 调用：兼容 OpenAI 格式的 /chat/completions 接口，支持流式输出
 *
 * 主要 Bug 修复：
 *  1. 消息重复显示 → 用消息 id 集合去重（不再依赖 username 判断）
 *  2. API Key 公开泄露 → 配置默认存 localStorage，仅显式勾选才同步
 *  3. Markdown 不渲染 → 内置轻量安全的 Markdown 渲染器
 *  4. AI 请求无超时 → AbortController 超时 + 可取消
 * ===================================================================== */

(() => {
    'use strict';

    /* ============================ 配置 ============================ */
    const SUPABASE_URL = 'https://vmhgtscgmidoctmagyup.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_XoICZcNrmikaX2QQemfGHg_ECdSh38n';
    const CONFIG_LOCAL_KEY = 'chijichat.aiConfig.v1';
    const MAX_MESSAGE_LENGTH = 2000;
    const HISTORY_LIMIT = 100;   // 历史消息加载上限
    const CONTEXT_LIMIT = 20;    // 给 AI 的最近对话条数
    const AI_TIMEOUT_MS = 120000;

    const { createClient } = supabase;
    const supabaseClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        realtime: { params: { eventsPerSecond: 10 } },
    });

    /* ============================ 状态 ============================ */
    const state = {
        username: '',
        isAiResponding: false,
        isSubscribed: false,
        renderedIds: new Set(), // 已渲染消息 id，用于 Realtime 去重
        aiController: null,     // 当前 AI 请求的 AbortController
    };

    /* ============================ DOM ============================ */
    const $ = (id) => document.getElementById(id);
    const els = {
        loginOverlay: $('loginOverlay'),
        usernameInput: $('usernameInput'),
        loginBtn: $('loginBtn'),
        messagesEl: $('messages'),
        emptyState: $('emptyState'),
        messageInput: $('messageInput'),
        sendBtn: $('sendBtn'),
        connectionStatus: $('connectionStatus'),
        settingsOverlay: $('settingsOverlay'),
        settingsBtn: $('settingsBtn'),
        settingsCloseBtn: $('settingsCloseBtn'),
        settingsSaveBtn: $('settingsSaveBtn'),
        settingsEndpoint: $('settingsEndpoint'),
        settingsKey: $('settingsKey'),
        settingsModel: $('settingsModel'),
        settingsPrompt: $('settingsPrompt'),
        settingsSync: $('settingsSync'),
        settingsStatus: $('settingsStatus'),
        settingsLockOverlay: $('settingsLockOverlay'),
        settingsLockPwd: $('settingsLockPwd'),
        settingsLockBtn: $('settingsLockBtn'),
        settingsLockCancel: $('settingsLockCancel'),
        settingsLockStatus: $('settingsLockStatus'),
        adminPwdInput: $('adminPwdInput'),
        adminPwdSaveBtn: $('adminPwdSaveBtn'),
        modelBadge: $('modelBadge'),
        typingIndicator: $('typingIndicator'),
        clearBtn: $('clearBtn'),
    };

    /* ============================ 工具 ============================ */

    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function scrollToBottom() {
        requestAnimationFrame(() => {
            els.messagesEl.scrollTop = els.messagesEl.scrollHeight;
        });
    }

    function formatTime(iso) {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
            });
        } catch {
            return '';
        }
    }

    function setStatus(type, text) {
        els.connectionStatus.className = 'connection-status ' + type;
        els.connectionStatus.textContent = text;
    }

    function setInputEnabled(enabled) {
        state.isAiResponding = !enabled;
        els.messageInput.disabled = !enabled;
        els.sendBtn.disabled = !enabled;
    }

    /* ============================ Markdown 渲染 ============================
     * 轻量、安全的 Markdown 子集渲染器：
     * 支持代码块、行内代码、粗体、斜体、链接、标题、无序/有序列表。
     * 先转义 HTML，再按白名单规则转换，保证不会注入任意 HTML。
     * ===================================================================== */

    function renderMarkdown(raw) {
        const source = String(raw);

        // 1. 先保护代码块（避免代码块内部的 <think> 等被误处理）
        const codeBlocks = [];
        const noCode = source.replace(/```([\s\S]*?)```/g, (m, code) => {
            codeBlocks.push('<pre><code>' + escapeHtml(code) + '</code></pre>');
            return '\u0000' + (codeBlocks.length - 1) + '\u0000';
        });

        // 2. 提取 <think>...</think> 思考块：
        //    - 结构完整（成对的 <think> 与 </think>）→ 折叠显示
        //    - 结构不完全（有 <think> 但未闭合）→ 思考内容不显示，改为"正在思考"提示
        const thinkBlocks = [];
        let noThink = noCode.replace(/<think>([\s\S]*?)<\/think>/g, (m, content) => {
            const c = content.trim();
            if (!c) return ''; // 空思考块直接忽略
            thinkBlocks.push(c);
            return '\u0001' + (thinkBlocks.length - 1) + '\u0001';
        });
        // 未闭合的 <think>：丢弃其后的思考内容，替换为"正在思考"占位符
        noThink = noThink.replace(/<think>[\s\S]*$/, () => '\u0002');
        // 兜底：移除孤立的 </think> 闭合标签
        noThink = noThink.replace(/<\/think>/g, '');

        // 3. 转义剩余 HTML，防止注入
        const text = escapeHtml(noThink);

        // 4. 行内格式
        const inline = text
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
                '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

        // 5. 按行重组块级结构（标题 / 列表 / 段落 / 代码块）
        const lines = inline.split('\n');
        const blocks = [];
        let paraLines = [];

        const flushParagraph = () => {
            if (paraLines.length) {
                blocks.push('<p>' + paraLines.join('<br>') + '</p>');
                paraLines = [];
            }
        };

        const closeList = (list) => {
            if (list) blocks.push('</' + list.type + '>');
            return null;
        };

        let openList = null;

        for (const line of lines) {
            // 代码块占位符独占一行 → 独立块
            const codeHit = line.match(/^\u0000(\d+)\u0000$/);
            if (codeHit) {
                flushParagraph();
                openList = closeList(openList);
                blocks.push('\u0000' + codeHit[1] + '\u0000');
                continue;
            }

            // think 占位符（可带行尾正文）→ 思考块独立成块
            const thinkHit = line.match(/^\u0001(\d+)\u0001(.*)$/);
            if (thinkHit) {
                flushParagraph();
                openList = closeList(openList);
                blocks.push('\u0001' + thinkHit[1] + '\u0001');
                if (thinkHit[2]) paraLines.push(thinkHit[2]);
                continue;
            }

            // 空行 → 结束段落与列表
            if (!line.trim()) {
                flushParagraph();
                openList = closeList(openList);
                continue;
            }

            // 标题
            const h = line.match(/^(#{1,3}) (.*)$/);
            if (h) {
                flushParagraph();
                openList = closeList(openList);
                const level = h[1].length;
                blocks.push('<h' + level + '>' + h[2] + '</h' + level + '>');
                continue;
            }

            // 无序列表
            const ul = line.match(/^[ \t]*[-*] (.*)$/);
            if (ul) {
                flushParagraph();
                if (openList && openList.type === 'ul') {
                    blocks.push('<li>' + ul[1] + '</li>');
                } else {
                    openList = closeList(openList);
                    openList = { type: 'ul' };
                    blocks.push('<ul><li>' + ul[1] + '</li>');
                }
                continue;
            }

            // 有序列表
            const ol = line.match(/^[ \t]*\d+\. (.*)$/);
            if (ol) {
                flushParagraph();
                if (openList && openList.type === 'ol') {
                    blocks.push('<li>' + ol[1] + '</li>');
                } else {
                    openList = closeList(openList);
                    openList = { type: 'ol' };
                    blocks.push('<ol><li>' + ol[1] + '</li>');
                }
                continue;
            }

            // 普通行 → 段落
            paraLines.push(line);
        }

        flushParagraph();
        openList = closeList(openList);

        // 6. 先恢复思考块（think 内容中可能含有代码块占位符 \u0000N\u0000）
        let html = blocks.join('');
        html = html.replace(/\u0001(\d+)\u0001/g, (m, i) =>
            '<details class="think-block"><summary>思考过程</summary>' +
            '<div class="think-content">' + escapeHtml(thinkBlocks[Number(i)]) + '</div></details>');

        // 7. 恢复"正在思考"占位（未闭合的 think）
        html = html.replace(/\u0002/g, '<span class="thinking-inline">正在思考…</span>');

        // 8. 再恢复代码块占位符（同时覆盖 think 内容内的代码块）
        html = html.replace(/\u0000(\d+)\u0000/g, (m, i) => codeBlocks[Number(i)]);

        return html;
    }

    /* ============================ 消息渲染 ============================ */

    function hideEmptyState() {
        if (els.emptyState) els.emptyState.style.display = 'none';
    }

    function renderMessage(msg) {
        // msg: { id, username, text, created_at, type }
        state.renderedIds.add(msg.id);

        if (msg.type === 'system') {
            appendSystemMessage(msg.text);
            return;
        }

        const isUser = msg.type === 'user';
        const sender = isUser ? (msg.username || '用户') : 'AI';

        const div = document.createElement('div');
        div.className = 'message ' + (isUser ? 'user' : 'ai');
        div.dataset.msgId = msg.id;
        div.innerHTML =
            '<div class="sender">' + escapeHtml(sender) + '</div>' +
            '<div class="bubble">' +
            renderMarkdown(msg.text || '') +
            '<div class="time">' + formatTime(msg.created_at) + '</div>' +
            '</div>';

        els.messagesEl.appendChild(div);
        scrollToBottom();
    }

    function appendSystemMessage(text, isError) {
        const div = document.createElement('div');
        div.className = 'message system' + (isError ? ' error' : '');
        div.innerHTML = '<div class="bubble">' + escapeHtml(text) + '</div>';
        els.messagesEl.appendChild(div);
        scrollToBottom();
    }

    /* ============================ 登录 ============================ */

    function enterChat() {
        const name = els.usernameInput.value.trim();
        if (!name) return;
        state.username = name;
        els.loginOverlay.style.display = 'none';
        initChat();
    }

    /* ============================ AI 配置 ============================
     * 配置存储优先级：
     *   1. localStorage（当前浏览器，安全）
     *   2. Supabase ai_config（仅当用户勾选了"同步到聊天室"共享时存在）
     * ================================================================= */

    function getLocalConfig() {
        try {
            const raw = localStorage.getItem(CONFIG_LOCAL_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    function setLocalConfig(cfg) {
        try {
            localStorage.setItem(CONFIG_LOCAL_KEY, JSON.stringify(cfg));
        } catch (err) {
            console.warn('无法保存配置到本地:', err);
        }
    }

    function fillSettingsForm(cfg) {
        if (!cfg) return;
        els.settingsEndpoint.value = cfg.api_endpoint || '';
        els.settingsKey.value = cfg.api_key || '';
        els.settingsModel.value = cfg.model || '';
        els.settingsPrompt.value = cfg.system_prompt || '';
        updateModelBadge();
    }

    async function loadAiConfig() {
        // 优先本地配置
        const local = getLocalConfig();
        if (local && local.api_endpoint && local.api_key && local.model) {
            fillSettingsForm(local);
            return;
        }

        // 回退：读取 Supabase 最新一条共享配置
        try {
            const { data, error } = await supabaseClient
                .from('ai_config')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(1);

            if (!error && data && data.length > 0) {
                fillSettingsForm(data[0]);
            }
        } catch (err) {
            console.warn('读取共享配置失败:', err);
        }
    }

    function updateModelBadge() {
        const model = els.settingsModel.value.trim();
        els.modelBadge.textContent = model || '未配置';
        els.modelBadge.title = model ? '当前模型: ' + model : '尚未配置模型';
    }

    async function saveAiConfig() {
        const endpoint = els.settingsEndpoint.value.trim();
        const key = els.settingsKey.value.trim();
        const model = els.settingsModel.value.trim();
        const prompt = els.settingsPrompt.value.trim();
        const syncToServer = els.settingsSync.checked;

        if (!endpoint || !key || !model) {
            showSettingsStatus('请填写 API 地址、API Key 和模型', 'error');
            return;
        }

        const cfg = {
            api_endpoint: endpoint,
            api_key: key,
            model: model,
            system_prompt: prompt || '你是一个有用的助手',
        };

        // 总是保存到本地
        setLocalConfig(cfg);

        // 仅勾选时才同步到 Supabase（避免密钥泄露给所有访问者）
        if (syncToServer) {
            try {
                const { error } = await supabaseClient
                    .from('ai_config')
                    .insert(cfg);
                if (error) {
                    showSettingsStatus('本地已保存，但同步到聊天室失败: ' + error.message, 'error');
                    return;
                }
            } catch (err) {
                showSettingsStatus('本地已保存，但同步到聊天室失败: ' + err.message, 'error');
                return;
            }
        }

        updateModelBadge();
        showSettingsStatus(syncToServer ? '保存成功，已同步到聊天室' : '保存成功（仅保存在此浏览器）', 'success');
        setTimeout(() => els.settingsOverlay.classList.remove('open'), 800);
    }

    function showSettingsStatus(text, type) {
        els.settingsStatus.textContent = text;
        els.settingsStatus.className = 'settings-status ' + type;
    }

    /* ============================ 管理员密码 ============================
     * 密码只以 bcrypt 哈希形式存于 Supabase admin_settings 表，
     * 前端仅通过 RPC 校验 / 设置，永远接触不到密码明文。
     * ================================================================= */

    function showLockStatus(text, type) {
        els.settingsLockStatus.textContent = text;
        els.settingsLockStatus.className = 'settings-status ' + type;
    }

    // 校验管理员密码（返回 Promise<boolean>）
    async function verifyAdminPassword(pwd) {
        const { data, error } = await supabaseClient.rpc('verify_admin_password', {
            pwd: pwd,
        });
        if (error) {
            throw new Error('密码校验失败: ' + error.message +
                '（请确认已在数据库创建 verify_admin_password 函数）');
        }
        return data === true;
    }

    // 设置 / 修改 / 清除管理员密码（返回 Promise<boolean>）
    async function saveAdminPassword(pwd) {
        const { data, error } = await supabaseClient.rpc('set_admin_password', {
            pwd: pwd,
        });
        if (error) {
            throw new Error('保存失败: ' + error.message +
                '（请确认已在数据库创建 set_admin_password 函数）');
        }
        return data === true;
    }

    // 打开设置：先验证密码，通过后进入设置面板
    async function openSettings() {
        els.settingsLockOverlay.classList.add('open');
        els.settingsLockPwd.value = '';
        showLockStatus('', '');
        els.settingsLockPwd.focus();

        // 若无密码记录（首次），直接放行
        try {
            const unlocked = await verifyAdminPassword('');
            if (unlocked) {
                unlockSettings();
            }
        } catch {
            // 校验失败静默，等待用户输入
        }
    }

    function unlockSettings() {
        els.settingsLockOverlay.classList.remove('open');
        els.settingsOverlay.classList.add('open');
        els.settingsStatus.style.display = 'none';
    }

    async function handleLockSubmit() {
        const pwd = els.settingsLockPwd.value;
        if (!pwd) {
            showLockStatus('请输入管理员密码', 'error');
            return;
        }
        try {
            const ok = await verifyAdminPassword(pwd);
            if (ok) {
                unlockSettings();
            } else {
                showLockStatus('密码错误', 'error');
                els.settingsLockPwd.focus();
            }
        } catch (err) {
            showLockStatus(err.message, 'error');
        }
    }

    async function handleAdminPwdSave() {
        const pwd = els.adminPwdInput.value;

        // 留空 → 清除密码（需确认）
        if (!pwd) {
            if (!confirm('确定清除管理员密码？清除后任何人都能打开设置。')) return;
        } else if (pwd.length < 4) {
            showSettingsStatus('密码至少 4 位', 'error');
            return;
        }

        try {
            const ok = await saveAdminPassword(pwd);
            if (!ok) {
                showSettingsStatus('保存失败：密码无效', 'error');
                return;
            }
            els.adminPwdInput.value = '';
            showSettingsStatus(pwd ? '管理员密码已更新' : '管理员密码已清除', 'success');
        } catch (err) {
            showSettingsStatus(err.message, 'error');
        }
    }

    /* ============================ 历史加载 ============================ */

    async function loadHistory() {
        try {
            const { data, error } = await supabaseClient
                .from('messages')
                .select('*')
                .order('created_at', { ascending: true })
                .limit(HISTORY_LIMIT);

            if (error) {
                console.error('加载历史失败:', error);
                appendSystemMessage('加载历史消息失败: ' + error.message, true);
                return;
            }

            if (data && data.length > 0) {
                hideEmptyState();
                data.forEach(renderMessage);
            }
            scrollToBottom();
        } catch (err) {
            console.error('加载历史失败:', err);
        }
    }

    /* ============================ Realtime 订阅 ============================
     * 用 renderedIds 去重：
     *  - 自己发送/接收的消息（本地已显示）→ 跳过
     *  - 其他人或自己的 AI 回复（本地未显示）→ 正常渲染
     * 彻底避免"重复显示"和"同昵称消息互吞"两个问题。
     * ===================================================================== */

    function subscribeMessages() {
        if (state.isSubscribed) return;
        state.isSubscribed = true;

        supabaseClient
            .channel('messages-channel')
            .on('postgres_changes',
                { event: 'INSERT', schema: 'public', table: 'messages' },
                (payload) => {
                    const msg = payload.new;
                    if (!msg || state.renderedIds.has(msg.id)) return;
                    hideEmptyState();
                    renderMessage(msg);
                }
            )
            .subscribe((status) => {
                if (status === 'SUBSCRIBED') {
                    setStatus('connected', '已连接');
                } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    setStatus('disconnected', '实时连接失败，正在重连...');
                } else if (status === 'CLOSED') {
                    setStatus('disconnected', '连接已断开');
                }
            });
    }

    /* ============================ 发送消息 ============================ */

    async function sendMessage() {
        const text = els.messageInput.value.trim();
        if (!text) return;
        if (text.length > MAX_MESSAGE_LENGTH) {
            appendSystemMessage('消息过长（最多 ' + MAX_MESSAGE_LENGTH + ' 字）', true);
            return;
        }
        if (state.isAiResponding) return;

        setInputEnabled(false);

        try {
            // 1. 保存用户消息（.select() 取回 id 用于去重）
            const { data: userInserted, error: userErr } = await supabaseClient
                .from('messages')
                .insert({ username: state.username, text: text, type: 'user' })
                .select('id, username, text, created_at, type')
                .single();

            if (userErr) {
                appendSystemMessage('发送失败: ' + userErr.message, true);
                setInputEnabled(true);
                return;
            }

            // 2. 本地立即显示（加入去重集合）
            hideEmptyState();
            renderMessage(userInserted);
            els.messageInput.value = '';

            // 3. 显示输入指示器
            els.typingIndicator.style.display = 'flex';
            scrollToBottom();

            // 4. 获取 AI 配置（本地优先，回退共享）
            const cfg = getLocalConfig();
            const aiCfg = cfg && cfg.api_endpoint && cfg.api_key && cfg.model
                ? cfg
                : await fetchSharedConfig();

            if (!aiCfg) {
                els.typingIndicator.style.display = 'none';
                appendSystemMessage('请先在右上角"设置"中配置 AI 接口', true);
                setInputEnabled(true);
                return;
            }

            // 5. 构建对话上下文（最近 N 条非系统消息）
            const context = await buildContext(text, userInserted.id);

            // 6. 调用 AI（流式输出，失败自动降级）
            const bubble = createStreamingBubble();
            const aiText = await fetchAiCompletion(aiCfg, context, bubble);

            // 7. 保存并显示 AI 回复
            const { data: aiInserted, error: aiErr } = await supabaseClient
                .from('messages')
                .insert({ username: 'AI', text: aiText, type: 'ai' })
                .select('id, username, text, created_at, type')
                .single();

            if (aiErr) {
                console.error('保存 AI 回复失败:', aiErr);
            } else {
                finalizeStreamingBubble(bubble, aiInserted);
            }

        } catch (err) {
            els.typingIndicator.style.display = 'none';
            if (err && err.name === 'AbortError') {
                appendSystemMessage('AI 响应已取消', true);
            } else {
                appendSystemMessage('请求失败: ' + (err && err.message ? err.message : err), true);
            }
            removeStreamingBubble();
        }

        setInputEnabled(true);
        els.messageInput.focus();
    }

    async function fetchSharedConfig() {
        try {
            const { data, error } = await supabaseClient
                .from('ai_config')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(1);
            if (error || !data || data.length === 0) return null;
            const cfg = data[0];
            return cfg.api_endpoint && cfg.api_key && cfg.model ? cfg : null;
        } catch {
            return null;
        }
    }

    async function buildContext(currentText, excludeId) {
        try {
            // 降序取最近的 N 条（升序 + limit 在历史很长时取到的是"最早"的消息，是 bug）
            const { data, error } = await supabaseClient
                .from('messages')
                .select('*')
                .neq('type', 'system')
                .order('created_at', { ascending: false })
                .limit(CONTEXT_LIMIT + 1);

            const history = [];
            if (data && !error) {
                // 反转回时间升序
                [...data].reverse().forEach((m) => {
                    if (m.id === excludeId) return; // 排除自己刚发的消息
                    if (m.type === 'user') {
                        history.push({ role: 'user', content: m.text });
                    } else if (m.type === 'ai') {
                        history.push({ role: 'assistant', content: m.text });
                    }
                });
            }

            // 保证最后一条是当前用户消息（避免上下文全是 AI 消息导致 API 报错）
            history.push({ role: 'user', content: currentText });
            return history;
        } catch {
            return [{ role: 'user', content: currentText }];
        }
    }

    /* ---- 流式气泡 ----
     * 流式过程中显示纯文本（避免 Markdown 反复重渲染闪烁），
     * 结束后一次性渲染为 Markdown。
     * 流式期间跟踪 <think> 状态：
     *   - 处于思考阶段（<think> 已出现、</think> 未闭合）→ 显示"正在思考"，
     *     思考内容不显示
     *   - 正常阶段 → 逐字显示
     * ----------------- */

    function createStreamingBubble() {
        els.typingIndicator.style.display = 'none';

        const div = document.createElement('div');
        div.className = 'message ai streaming';
        div.innerHTML =
            '<div class="sender">AI</div>' +
            '<div class="bubble streaming"><span class="stream-text"></span></div>';
        els.messagesEl.appendChild(div);
        scrollToBottom();
        return div.querySelector('.bubble');
    }

    function updateStreamingBubble(bubbleEl, delta) {
        const textEl = bubbleEl.querySelector('.stream-text') || bubbleEl;
        textEl.textContent += delta;
        scrollToBottom();
    }

    function setStreamingThinking(bubbleEl, on) {
        if (on) {
            if (!bubbleEl.querySelector('.stream-thinking')) {
                const span = document.createElement('span');
                span.className = 'stream-thinking';
                span.textContent = '正在思考';
                bubbleEl.appendChild(span);
            }
        } else {
            const el = bubbleEl.querySelector('.stream-thinking');
            if (el) el.remove();
        }
        scrollToBottom();
    }

    // think 闭合时：把缓存的思考内容渲染为"思考过程"折叠块，
    // 插入到正文（.stream-text）之前，流式中即可见
    function showStreamingThinkBlock(bubbleEl, content) {
        const details = document.createElement('details');
        details.className = 'think-block';
        details.innerHTML =
            '<summary>思考过程</summary>' +
            '<div class="think-content">' + escapeHtml(content) + '</div>';
        const textEl = bubbleEl.querySelector('.stream-text');
        if (textEl && textEl.parentNode) {
            bubbleEl.insertBefore(details, textEl);
        } else {
            bubbleEl.appendChild(details);
        }
        scrollToBottom();
    }

    // think 状态机：处理任意文本块，区分思考阶段与正文阶段
    //  - 思考阶段：内容缓存不显示，仅显示"正在思考"
    //  - </think> 闭合：渲染"思考过程"折叠块（含已缓存内容）
    //  - 正文阶段：逐字显示
    //  - 标签跨 chunk 边界（SSE 把 <think> 拆开）：尾部前缀暂存到下一 chunk
    function createThinkStreamer(bubbleEl) {
        const THINK_OPEN = '<think>';
        const THINK_CLOSE = '</think>';
        let inThink = false;
        let thinkBuffer = '';
        let pending = ''; // 疑似标签前缀，等待下一个 chunk 补齐

        // 返回 str 尾部是否以 tag 的某个真前缀结尾；是则返回该前缀长度
        const trailingPrefixLen = (str, tag) => {
            for (let n = 1; n < tag.length; n++) {
                if (str.endsWith(tag.slice(0, n))) return n;
            }
            return 0;
        };

        const flushPending = () => {
            if (!pending) return;
            if (inThink) {
                thinkBuffer += pending;
            } else {
                updateStreamingBubble(bubbleEl, pending);
            }
            pending = '';
        };

        const processor = (chunk) => {
            let rest = pending + chunk;
            pending = '';

            while (rest) {
                if (!inThink) {
                    const idx = rest.indexOf(THINK_OPEN);
                    if (idx === -1) {
                        const keep = trailingPrefixLen(rest, THINK_OPEN);
                        if (keep > 0) {
                            const flush = rest.slice(0, -keep);
                            if (flush) updateStreamingBubble(bubbleEl, flush);
                            pending = rest.slice(-keep);
                            rest = '';
                        } else {
                            updateStreamingBubble(bubbleEl, rest);
                            rest = '';
                        }
                    } else {
                        if (idx > 0) updateStreamingBubble(bubbleEl, rest.slice(0, idx));
                        inThink = true;
                        thinkBuffer = '';
                        setStreamingThinking(bubbleEl, true);
                        rest = rest.slice(idx + THINK_OPEN.length);
                    }
                } else {
                    const idx = rest.indexOf(THINK_CLOSE);
                    if (idx === -1) {
                        const keep = trailingPrefixLen(rest, THINK_CLOSE);
                        if (keep > 0) {
                            thinkBuffer += rest.slice(0, -keep);
                            pending = rest.slice(-keep);
                            rest = '';
                        } else {
                            thinkBuffer += rest; // 缓存思考内容（不显示）
                            rest = '';
                        }
                    } else {
                        thinkBuffer += rest.slice(0, idx);
                        inThink = false;
                        setStreamingThinking(bubbleEl, false);
                        showStreamingThinkBlock(bubbleEl, thinkBuffer);
                        thinkBuffer = '';
                        rest = rest.slice(idx + THINK_CLOSE.length);
                    }
                }
            }
        };

        processor.flush = flushPending;
        return processor;
    }

    function finalizeStreamingBubble(bubbleEl, msg) {
        state.renderedIds.add(msg.id);
        const time = formatTime(msg.created_at);
        bubbleEl.innerHTML = renderMarkdown(msg.text || '') +
            '<div class="time">' + time + '</div>';
        scrollToBottom();
    }

    function removeStreamingBubble() {
        const el = els.messagesEl.querySelector('.message.ai.streaming');
        if (el) el.remove();
    }

    /* ---- AI 请求（流式 + 降级）---- */

    async function fetchAiCompletion(cfg, messages, bubbleEl) {
        const controller = new AbortController();
        state.aiController = controller;
        const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

        try {
            const res = await fetch(cfg.api_endpoint + '/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + cfg.api_key,
                },
                body: JSON.stringify({
                    model: cfg.model,
                    messages: messages,
                    max_tokens: 2048,
                    stream: true,
                }),
                signal: controller.signal,
            });

            if (!res.ok) {
                const errText = await res.text();
                throw new Error('AI 响应错误 (' + res.status + '): ' + errText.slice(0, 200));
            }

            const contentType = res.headers.get('content-type') || '';

            // 服务端不支持流式 → 降级为 JSON 模式
            if (!res.body || !contentType.includes('text/event-stream')) {
                const json = await res.json();
                const content = json.choices && json.choices[0] && json.choices[0].message
                    ? json.choices[0].message.content
                    : 'AI 返回了空响应';

                // 与流式一致：think 阶段显示"正在思考"，闭合后显示思考块
                const pushChunk = createThinkStreamer(bubbleEl);
                pushChunk(content || '');
                pushChunk.flush();
                return content;
            }

            // 解析 SSE 流
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullText = '';
            const pushChunk = createThinkStreamer(bubbleEl);

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });

                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed.startsWith('data:')) continue;
                    const data = trimmed.slice(5).trim();
                    if (data === '[DONE]') {
                        pushChunk.flush();
                        return fullText;
                    }

                    try {
                        const json = JSON.parse(data);
                        const delta = json.choices && json.choices[0] && json.choices[0].delta
                            ? json.choices[0].delta.content
                            : '';
                        if (delta) {
                            fullText += delta;
                            pushChunk(delta);
                        }
                    } catch {
                        // 忽略无法解析的事件
                    }
                }
            }

            pushChunk.flush();

            // 流结束后若 think 仍未闭合，保持"正在思考"占位（finalize 时由
            // renderMarkdown 渲染为"正在思考…"）
            return fullText;
        } finally {
            clearTimeout(timer);
            if (state.aiController === controller) state.aiController = null;
        }
    }

    /* ============================ 清除对话 ============================ */

    async function clearConversation() {
        if (!confirm('确定清除所有对话记录？')) return;

        // 中止进行中的 AI 请求
        if (state.aiController) state.aiController.abort();
        els.typingIndicator.style.display = 'none';
        removeStreamingBubble();
        setInputEnabled(true);

        try {
            const { error } = await supabaseClient
                .from('messages')
                .delete()
                .neq('id', 0);
            if (error) {
                appendSystemMessage('清除失败: ' + error.message, true);
                return;
            }
        } catch (err) {
            appendSystemMessage('清除失败: ' + err.message, true);
            return;
        }

        // 只移除消息节点，保留空状态节点
        els.messagesEl.querySelectorAll('.message').forEach((el) => el.remove());
        state.renderedIds.clear();
        els.emptyState.style.display = 'flex';
    }

    /* ============================ 初始化 ============================ */

    async function initChat() {
        setStatus('connecting', '连接中...');
        await loadAiConfig();
        await loadHistory();
        subscribeMessages();
        setStatus('connected', '已连接');
        setInputEnabled(true);
        els.messageInput.focus();
    }

    /* ============================ 事件绑定 ============================ */

    // 登录
    els.loginBtn.addEventListener('click', enterChat);
    els.usernameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') enterChat();
    });

    // 设置（需管理员密码验证）
    els.settingsBtn.addEventListener('click', openSettings);
    els.settingsCloseBtn.addEventListener('click', () => {
        els.settingsOverlay.classList.remove('open');
    });
    els.settingsSaveBtn.addEventListener('click', saveAiConfig);
    els.settingsKey.addEventListener('input', updateModelBadge);

    // 管理员密码验证层
    els.settingsLockBtn.addEventListener('click', handleLockSubmit);
    els.settingsLockPwd.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleLockSubmit();
    });
    els.settingsLockCancel.addEventListener('click', () => {
        els.settingsLockOverlay.classList.remove('open');
    });
    els.adminPwdSaveBtn.addEventListener('click', handleAdminPwdSave);

    // 发送
    els.sendBtn.addEventListener('click', sendMessage);
    els.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    // 清除
    els.clearBtn.addEventListener('click', clearConversation);

    // 登录界面允许通过按钮提交表单（回车）
    els.usernameInput.focus();
})();
