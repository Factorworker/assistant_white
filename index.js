// 助理白 · LeanCloud 云引擎后端（Express）
// 保留原 Cloudflare Worker 的全部功能，前端零改动（数据层模拟自增整数 id）
const express = require('express')
const path = require('path')
const { webcrypto } = require('crypto')
const store = require('./store')
require('dotenv').config()

const crypto = webcrypto
const POINTS_PER_CHECKIN = 10

if (!process.env.MONGODB_URI) {
  console.error('[助理白] 缺少 MONGODB_URI，请在 .env 中配置后再启动')
}
store.init(process.env.MONGODB_URI).catch((e) => console.error('[助理白] MongoDB 连接失败：', e.message))

const app = express()
app.use(express.json({ limit: '5mb' }))

// ---------------- 工具函数 ----------------

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return hex(new Uint8Array(digest))
}

async function hashPassword(password, saltHex) {
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256)
  return hex(new Uint8Array(bits))
}

async function makePasswordRecord(password) {
  const salt = new Uint8Array(16)
  crypto.getRandomValues(salt)
  const saltHex = hex(salt)
  const hash = await hashPassword(password, saltHex)
  return `pbkdf2$${saltHex}$${hash}`
}

async function verifyPassword(password, record) {
  if (!record) return false
  const parts = record.split('$')
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false
  const hash = await hashPassword(password, parts[1])
  return hash === parts[2]
}

function randomToken() {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return hex(bytes)
}

function localDate() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shiftDate(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + delta)
  const yy = dt.getFullYear()
  const mm = String(dt.getMonth() + 1).padStart(2, '0')
  const dd = String(dt.getDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}

function rangeStartUtc(range, now = new Date()) {
  if (range === 'all') return null
  const days = { today: 0, week: 6, month: 29, year: 364 }[range]
  if (days === undefined) return null
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, 0, 0, 0)
  return start.toISOString().replace('T', ' ').slice(0, 19)
}

function rangeLabel(range) {
  return { today: '今天', week: '最近一周', month: '最近一月', year: '最近一年', all: '全部' }[range] || '所选时段'
}

// ---------------- 认证 ----------------

async function currentToken(req) {
  const h = req.get('authorization') || ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

async function checkAuth(req) {
  const token = await currentToken(req)
  if (!token) return false
  const stored = await store.getSetting('auth_token')
  if (!stored || stored !== token) return false
  const exp = Number((await store.getSetting('auth_token_expiry')) || 0)
  return exp === 0 || Date.now() < exp
}

// 认证中间件（登录、设置口令、状态 放行）
app.use('/api', async (req, res, next) => {
  const p = req.path
  const open = p === '/auth/login' || p === '/auth/setup' || p === '/auth/status'
  if (open) return next()
  try {
    const ok = await checkAuth(req)
    if (!ok) return res.status(401).json({ error: 'unauthorized' })
    return next()
  } catch (e) {
    return res.status(500).json({ error: 'server_error', message: e.message })
  }
})

// ---------------- 统计 ----------------

async function statsOf(date) {
  const days = await store.distinct('checkins', 'date')
  const points = (await store.count('checkins')) * POINTS_PER_CHECKIN
  const today = date || localDate()
  let streak = 0
  let cursor = today
  if (!days.has(cursor)) cursor = shiftDate(cursor, -1)
  while (days.has(cursor)) {
    streak += 1
    cursor = shiftDate(cursor, -1)
  }
  return { streak, points, checkinDays: [...days] }
}

// ---------------- AI ----------------

async function runAI(messages) {
  const raw = await store.getSetting('ai_config')
  if (!raw) return { ok: false, error: 'AI 未配置：请到「设置」填写模型接口（OpenAI 兼容）' }
  let cfg
  try { cfg = JSON.parse(raw) } catch { return { ok: false, error: 'AI 配置损坏，请到设置重新填写' } }
  const baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '')
  const model = cfg.model || 'gpt-4o-mini'
  if (!baseUrl) return { ok: false, error: 'AI 未配置：缺少接口地址' }
  const url = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
  try {
    const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ model, messages }) })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return { ok: false, error: `模型接口返回 ${resp.status}: ${text.slice(0, 200)}` }
    }
    const data = await resp.json()
    const content = data?.choices?.[0]?.message?.content
    if (!content) return { ok: false, error: '模型未返回内容' }
    return { ok: true, content }
  } catch (e) {
    return { ok: false, error: `请求模型失败：${e.message}` }
  }
}

async function ensureDailyTasks(date) {
  const existing = await store.find('daily_tasks', { conds: [{ key: 'date', val: date }], limit: 1 })
  if (existing.length > 0) return
  const tasks = await store.find('tasks', { conds: [{ key: 'period', val: 'week' }] })
  let sort = 0
  for (const t of tasks) {
    sort += 1
    await store.create('daily_tasks', {
      goal_id: t.goal_id, task_id: t.id, content: t.name,
      minutes: t.minutes || 15, status: 'todo', date, sort,
    })
  }
}

function toApiContent(stored) {
  try { const j = JSON.parse(stored); if (Array.isArray(j)) return j } catch {}
  return stored
}

function titleFrom(stored) {
  let text = stored
  try {
    const j = JSON.parse(stored)
    if (Array.isArray(j)) {
      const t = j.filter((p) => p && p.type === 'text' && p.text).map((p) => p.text).join(' ')
      if (t) text = t
    }
  } catch {}
  const clean = String(text).replace(/\s+/g, ' ').trim()
  if (!clean) return '图片对话'
  return clean.length > 16 ? clean.slice(0, 16) + '…' : clean
}

async function makeTitle(stored) {
  const fallback = titleFrom(stored)
  try {
    const ai = await runAI([
      { role: 'system', content: '你是对话标题生成器。只输出一个不超过14个字的中文标题，概括下面这句提问的主题。不要标点、不要引号、不要解释、不要换行。' },
      { role: 'user', content: titleFrom(stored) },
    ])
    if (ai.ok) {
      const t = String(ai.content).replace(/["“”\n\r]/g, '').trim()
      if (t && t.length <= 20) return t
    }
  } catch {}
  return fallback
}

// ---------------- 要闻常量 ----------------

const NEWS_FEEDS = [
  { url: 'http://www.chinanews.com.cn/rss/scroll-news.xml', cat: 'general', source: '中国新闻网' },
  { url: 'http://www.chinanews.com.cn/rss/world.xml', cat: 'general', source: '中国新闻网' },
  { url: 'http://www.chinanews.com.cn/rss/finance.xml', cat: 'life', source: '中国新闻网' },
  { url: 'http://www.chinanews.com.cn/rss/edu.xml', cat: 'education', source: '中国新闻网' },
  { url: 'http://www.chinanews.com.cn/rss/society.xml', cat: 'life', source: '中国新闻网' },
  { url: 'https://feeds.bbci.co.uk/zhongwen/simp/rss.xml', cat: 'general', source: 'BBC中文' },
  { url: 'https://rss.dw.com/rdf/rss-chi-all', cat: 'general', source: '德国之声中文' },
  { url: 'https://www3.nhk.or.jp/nhkworld/zh/news/rss.xml', cat: 'general', source: 'NHK中文' },
]

function rssInner(tag, body) {
  const re = new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i')
  const m = re.exec(body)
  if (!m) return ''
  return (m[1] || m[2] || '').trim()
}

function parseRSS(xml) {
  const items = []
  const blockRe = /<item>([\s\S]*?)<\/item>/gi
  let m
  while ((m = blockRe.exec(xml)) !== null) {
    const body = m[1]
    const title = rssInner('title', body)
    if (!title) continue
    const link = rssInner('link', body)
    const pubDate = rssInner('pubDate', body)
    let desc = rssInner('description', body).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (desc.length > 120) desc = desc.slice(0, 120) + '…'
    let dateStr = ''
    if (pubDate) {
      const t = new Date(pubDate).getTime()
      if (!isNaN(t)) {
        const d = new Date(t + 8 * 3600 * 1000)
        dateStr = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
      }
    }
    items.push({ title, link, pubDate, summary: desc, dateStr: dateStr || localDate() })
  }
  return items
}

function classifyNews(text) {
  const has = (kws) => kws.some((k) => text.includes(k))
  if (has(['教育', '学校', '大学', '考研', '高考', '教师', '学生', '中小学', '招生', '留学', '培训', '作业', '教育考试'])) return 'education'
  if (has(['科技', '人工智能', 'AI', '芯片', '软件', '互联网', '机器人', '手机', '航天', '卫星', '数字化', '数据', '算法', '模型', '算力', '新能源', '电动汽车', '5G', '半导体', '大模型'])) return 'tech'
  if (has(['安全', '地震', '台风', '暴雨', '洪水', '事故', '爆炸', '火灾', '疫情', '军事', '冲突', '袭击', '灾害', '预警', '塌陷', '中毒', '起火', '极端天气'])) return 'security'
  if (has(['经济', '股市', '房价', '物价', '工资', '养老金', '医保', '社保', '利率', '就业', '消费', '补贴', '减税', '关税', '楼市', '油价', '能源'])) return 'life'
  return 'general'
}

async function fetchNewsText(feed) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const resp = await fetch(feed.url, { signal: controller.signal })
    if (!resp.ok) return null
    return await resp.text()
  } catch { return null } finally { clearTimeout(timer) }
}

function parseTrending(xml) {
  const repos = []
  const blockRe = /<article class="Box-row">([\s\S]*?)<\/article>/gi
  let m
  while ((m = blockRe.exec(xml)) !== null) {
    const body = m[1]
    const repoM = /<a[^>]*href="\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)"[^>]*data-view-component="true" class="Link"/.exec(body)
    if (!repoM) continue
    const full = repoM[1]
    let desc = ''
    const dM = /<p class="col-9 color-fg-muted my-1[^"]*">([\s\S]*?)<\/p>/.exec(body)
    if (dM) desc = dM[1].replace(/<[^>]+>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim()
    let lang = ''
    const lM = /<span itemprop="programmingLanguage">([^<]+)<\/span>/.exec(body)
    if (lM) lang = lM[1]
    let stars = ''
    const sM = /\/stargazers"[^>]*>[\s\S]*?<\/svg>\s*([\d,]+)<\/a>/.exec(body)
    if (sM) stars = sM[1]
    let today = ''
    const tM = /float-sm-right">[\s\S]*?<\/svg>\s*([\d,]+) stars today/.exec(body)
    if (tM) today = tM[1]
    repos.push({ full, owner: full.split('/')[0], repo: full.split('/')[1], url: `https://github.com/${full}`, desc, language: lang, stars, todayStars: today })
  }
  return repos
}

// ---------------- 路由 ----------------

const router = express.Router()

// ---- 认证 ----
router.get('/auth/status', async (req, res) => {
  const pw = await store.getSetting('auth_pw')
  res.json({ setup: pw !== null, authed: await checkAuth(req) })
})

router.post('/auth/setup', async (req, res) => {
  if (await store.getSetting('auth_pw')) return res.status(400).json({ error: 'already_setup' })
  const { password } = req.body || {}
  if (!password || password.length < 4) return res.status(400).json({ error: 'password_too_short' })
  await store.setSetting('auth_pw', await makePasswordRecord(password))
  const token = randomToken()
  await store.setSetting('auth_token', token)
  await store.setSetting('auth_token_expiry', String(Date.now() + 30 * 24 * 3600 * 1000))
  res.json({ ok: true, token })
})

router.post('/auth/login', async (req, res) => {
  const { password } = req.body || {}
  const record = await store.getSetting('auth_pw')
  if (!record) return res.status(400).json({ error: 'not_setup' })
  if (!(await verifyPassword(password, record))) return res.status(401).json({ error: 'bad_credentials' })
  const token = randomToken()
  await store.setSetting('auth_token', token)
  await store.setSetting('auth_token_expiry', String(Date.now() + 30 * 24 * 3600 * 1000))
  res.json({ ok: true, token })
})

// ---- 目标 ----
router.get('/goals', async (req, res) => {
  const goals = await store.find('goals', { desc: 'priority' })
  const milestones = await store.find('milestones', { asc: 'id' })
  const tasks = await store.find('tasks', { asc: 'id' })
  res.json({ goals, milestones, tasks })
})

router.post('/goals', async (req, res) => {
  const b = req.body || {}
  const r = await store.create('goals', {
    name: b.name, type: b.type || 'input', done_criteria: b.done_criteria || '',
    priority: b.priority || 0, status: b.status || 'active',
  })
  res.json({ ok: true, id: r.id })
})

router.put('/goals/:id', async (req, res) => {
  const b = req.body || {}
  await store.updateByIntId('goals', req.params.id, {
    name: b.name, type: b.type || 'input', done_criteria: b.done_criteria || '',
    priority: b.priority || 0, status: b.status || 'active',
  })
  res.json({ ok: true })
})

router.post('/goals/:id/ai-breakdown', async (req, res) => {
  const b = req.body || {}
  const goal = await store.findByIntId('goals', req.params.id)
  if (!goal) return res.status(404).json({ error: 'goal_not_found' })
  const focus = String(b.focus || '').trim()
  const userAsk = `【目标】${goal.name}${goal.done_criteria ? `（完成标准：${goal.done_criteria}）` : ''}\n${focus ? `【我的说明】${focus}` : ''}`
  const messages = [
    { role: 'system', content: '你是目标拆解助手。把用户的长期目标拆成阶段里程碑和每日/每周量化小任务，用于日常打卡执行。只输出一个 JSON 对象，禁止输出任何其他文字、注释或代码块标记。JSON 结构：\n{"milestones":[{"name":"阶段名","due":"YYYY-MM-DD","condition":"达成标准"}],"tasks":[{"dimension":"能力维度","name":"可量化的每日/每周小任务，含具体完成量","minutes":建议每日分钟数}]}\n要求：3~5 个阶段里程碑；4~8 个每日/每周小任务；小任务的 name 必须可量化（含数字完成量，如"背雅思核心词50个""精听1篇"）；minutes 为 15~120 的整数。' },
    { role: 'user', content: userAsk },
  ]
  const ai = await runAI(messages)
  if (!ai.ok) return res.json({ ok: false, error: ai.error })
  let parsed = null
  try { parsed = JSON.parse(ai.content) } catch {
    const a = ai.content.indexOf('{')
    const z = ai.content.lastIndexOf('}')
    if (a >= 0 && z > a) { try { parsed = JSON.parse(ai.content.slice(a, z + 1)) } catch {} }
  }
  if (!parsed || !Array.isArray(parsed.milestones) || !Array.isArray(parsed.tasks)) {
    return res.json({ ok: false, error: 'AI 输出格式不正确，请重试或换模型' })
  }
  let msAdded = 0
  for (const m of (parsed.milestones || []).slice(0, 8)) {
    if (!m || !m.name) continue
    await store.create('milestones', { goal_id: goal.id, name: String(m.name).trim(), due: String(m.due || '').trim(), done_condition: String(m.condition || '').trim(), status: 'open' })
    msAdded += 1
  }
  let taskAdded = 0
  for (const t of (parsed.tasks || []).slice(0, 12)) {
    if (!t || !t.name) continue
    const min = Math.max(5, Math.min(120, Number(t.minutes) || 15))
    await store.create('tasks', { goal_id: goal.id, dimension: String(t.dimension || '').trim(), name: String(t.name).trim(), period: 'week', minutes: min })
    taskAdded += 1
  }
  res.json({ ok: true, milestones: msAdded, tasks: taskAdded })
})

// ---- 里程碑 ----
router.post('/goals/:id/milestones', async (req, res) => {
  const b = req.body || {}
  const r = await store.create('milestones', { goal_id: Number(req.params.id), name: b.name, due: b.due || '', done_condition: b.done_condition || '', status: b.status || 'open' })
  res.json({ ok: true, id: r.id })
})

router.put('/milestones/:id', async (req, res) => {
  const b = req.body || {}
  await store.updateByIntId('milestones', req.params.id, { name: b.name, due: b.due || '', done_condition: b.done_condition || '', status: b.status || 'open' })
  res.json({ ok: true })
})

// ---- 周任务 ----
router.post('/tasks', async (req, res) => {
  const b = req.body || {}
  const r = await store.create('tasks', { goal_id: b.goal_id, milestone_id: b.milestone_id || null, dimension: b.dimension || '', name: b.name, period: b.period || 'week' })
  res.json({ ok: true, id: r.id })
})

router.delete('/tasks/:id', async (req, res) => {
  await store.deleteByIntId('tasks', req.params.id)
  res.json({ ok: true })
})

// ---- 每日任务 ----
router.get('/daily', async (req, res) => {
  const date = req.query.date || localDate()
  await ensureDailyTasks(date)
  let dailies = await store.find('daily_tasks', { conds: [{ key: 'date', val: date }] })
  dailies.sort((a, b) => (a.sort - b.sort) || (a.id - b.id))
  const allGoals = await store.find('goals')
  const allTasks = await store.find('tasks')
  const gmap = {}; allGoals.forEach((g) => { gmap[g.id] = g })
  const tmap = {}; allTasks.forEach((t) => { tmap[t.id] = t })
  const tasks = dailies.map((d) => ({
    ...d,
    goal_name: d.goal_id && gmap[d.goal_id] ? gmap[d.goal_id].name : null,
    goal_type: d.goal_id && gmap[d.goal_id] ? gmap[d.goal_id].type : null,
    task_name: d.task_id && tmap[d.task_id] ? tmap[d.task_id].name : null,
  }))
  const stats = await statsOf(date)
  res.json({ date, tasks, stats })
})

router.post('/daily', async (req, res) => {
  const b = req.body || {}
  const r = await store.create('daily_tasks', { goal_id: b.goal_id || null, content: b.content, minutes: b.minutes || 15, status: 'todo', date: b.date || localDate(), sort: b.sort || 0 })
  res.json({ ok: true, id: r.id })
})

router.post('/daily/:id/checkin', async (req, res) => {
  const id = Number(req.params.id)
  const d = await store.findByIntId('daily_tasks', id)
  if (!d) return res.status(404).json({ error: 'not_found' })
  await store.create('checkins', { daily_task_id: id, result: 'done', date: localDate() })
  await store.updateByIntId('daily_tasks', id, { status: 'done' })
  const stats = await statsOf(d.date)
  res.json({ ok: true, stats })
})

router.post('/daily/:id/skip', async (req, res) => {
  const b = req.body || {}
  const status = b.status || 'skipped'
  await store.updateByIntId('daily_tasks', req.params.id, { status })
  res.json({ ok: true })
})

router.delete('/daily/:id', async (req, res) => {
  await store.deleteByIntId('daily_tasks', req.params.id)
  res.json({ ok: true })
})

// ---- 统计 ----
router.get('/stats', async (req, res) => {
  const date = req.query.date || localDate()
  const stats = await statsOf(date)
  const since = shiftDate(date, -6)
  const rows = await store.findSince('daily_tasks', 'date', since)
  const byDate = {}
  for (const r of rows) {
    if (!byDate[r.date]) byDate[r.date] = { date: r.date, total: 0, done: 0 }
    byDate[r.date].total += 1
    if (r.status === 'done') byDate[r.date].done += 1
  }
  const week = Object.keys(byDate).sort().map((d) => byDate[d])
  res.json({ stats, week })
})

// ---- 笔记 ----
router.get('/notes', async (req, res) => {
  const type = req.query.type || ''
  const q = req.query.q || ''
  let notes
  if (q) {
    notes = await store.findLike('notes', 'content', q, { desc: 'updated_at' })
  } else {
    const conds = type ? [{ key: 'type', val: type }] : []
    notes = await store.find('notes', { conds, desc: 'updated_at' })
  }
  const goals = await store.find('goals')
  const gmap = {}; goals.forEach((g) => { gmap[g.id] = g })
  notes = notes.map((n) => ({ ...n, goal_name: n.goal_id && gmap[n.goal_id] ? gmap[n.goal_id].name : null }))
  res.json({ notes })
})

router.post('/notes', async (req, res) => {
  const b = req.body || {}
  const r = await store.create('notes', { type: b.type || 'study', content: b.content, tags: b.tags || '', goal_id: b.goal_id || null, task_id: b.task_id || null, updated_at: localDate() })
  res.json({ ok: true, id: r.id })
})

router.post('/notes/:id/discuss', async (req, res) => {
  const b = req.body || {}
  const note = await store.findByIntId('notes', req.params.id)
  if (!note) return res.status(404).json({ error: 'note_not_found' })
  const question = String(b.question || '').trim()
  if (!question) return res.status(400).json({ error: 'empty' })
  const typeLabel = note.type === 'inspiration' ? '灵感笔记' : '学习笔记'
  const ai = await runAI([
    { role: 'system', content: `你是结合笔记内容与用户讨论的学习助手。围绕下面这条笔记回答用户的问题或展开讨论：\n【${typeLabel}】${note.content}` },
    { role: 'user', content: question },
  ])
  res.json({ ok: ai.ok, reply: ai.ok ? ai.content : ai.error, error: ai.ok ? null : ai.error })
})

router.post('/notes/summarize', async (req, res) => {
  const b = req.body || {}
  const range = ['today', 'week', 'month', 'year', 'all'].includes(b.range) ? b.range : 'all'
  const start = rangeStartUtc(range)
  const list = start
    ? await store.findSince('notes', 'created_at', start)
    : await store.find('notes', { asc: 'created_at' })
  if (list.length === 0) return res.json({ ok: true, reply: `「${rangeLabel(range)}」暂无笔记，无可总结的内容。`, count: 0 })
  const lines = list
    .map((n, i) => `${i + 1}. [${n.type === 'inspiration' ? '灵感' : '学习'}] (${(n.created_at || '').slice(0, 10)}) ${n.content}`)
    .join('\n')
  const ai = await runAI([
    { role: 'system', content: '你是笔记整理助手。根据用户提供的若干笔记，输出结构化总结：1) 要点归纳 2) 主题/类别分布 3) 可沉淀的结论或待办 4) 值得注意的关联。语言简洁、分点输出。' },
    { role: 'user', content: `以下是「${rangeLabel(range)}」的笔记列表（共 ${list.length} 条）：\n${lines}\n\n请总结。` },
  ])
  res.json({ ok: ai.ok, reply: ai.ok ? ai.content : ai.error, count: list.length, error: ai.ok ? null : ai.error })
})

router.put('/notes/:id', async (req, res) => {
  const b = req.body || {}
  await store.updateByIntId('notes', req.params.id, { type: b.type || 'study', content: b.content, tags: b.tags || '', goal_id: b.goal_id || null, task_id: b.task_id || null, updated_at: localDate() })
  res.json({ ok: true })
})

router.delete('/notes/:id', async (req, res) => {
  await store.deleteByIntId('notes', req.params.id)
  res.json({ ok: true })
})

// ---- AI 对话 ----
router.get('/chat/sessions', async (req, res) => {
  const sessions = await store.find('chat_sessions', { desc: 'created_at' })
  res.json({ sessions })
})

router.post('/chat/sessions', async (req, res) => {
  const b = req.body || {}
  const r = await store.create('chat_sessions', { title: b.title || '新对话' })
  res.json({ ok: true, id: r.id })
})

router.delete('/chat/sessions/:id', async (req, res) => {
  const id = Number(req.params.id)
  await store.deleteWhere('chat_messages', [{ key: 'session_id', val: id }])
  await store.deleteByIntId('chat_sessions', id)
  res.json({ ok: true })
})

router.post('/chat/:id/messages', async (req, res) => {
  const b = req.body || {}
  const sessionId = Number(req.params.id)
  const userText = String(b.content || '').trim()
  let storedUser
  if (b.image) {
    const parts = []
    if (userText) parts.push({ type: 'text', text: userText })
    parts.push({ type: 'image_url', image_url: { url: b.image } })
    if (parts.length === 0) parts.push({ type: 'text', text: '请识别这张图片' })
    storedUser = JSON.stringify(parts)
  } else {
    if (!userText) return res.status(400).json({ error: 'empty' })
    storedUser = userText
  }
  const hist = await store.find('chat_messages', { conds: [{ key: 'session_id', val: sessionId }], asc: 'id' })
  const messages = hist.map((m) => ({ role: m.role, content: toApiContent(m.content) }))
  messages.push({ role: 'user', content: toApiContent(storedUser) })
  const isFirst = hist.length === 0
  await store.create('chat_messages', { session_id: sessionId, role: 'user', content: storedUser })
  const ai = await runAI(messages)
  let reply = ''
  if (ai.ok) {
    reply = ai.content
    await store.create('chat_messages', { session_id: sessionId, role: 'assistant', content: reply })
  }
  if (isFirst) {
    const title = await makeTitle(storedUser)
    await store.updateByIntId('chat_sessions', sessionId, { title })
  }
  res.json({ ok: ai.ok, reply, error: ai.ok ? null : ai.error })
})

router.get('/chat/:id/messages', async (req, res) => {
  const messages = await store.find('chat_messages', { conds: [{ key: 'session_id', val: Number(req.params.id) }], asc: 'id' })
  res.json({ messages })
})

// ---- 要闻 ----
router.post('/news/fetch', async (req, res) => {
  const minDate = shiftDate(localDate(), -6)
  const existing = await store.findSince('news', 'date', minDate)
  const seen = new Set(existing.map((r) => r.title.replace(/\s+/g, '')))
  const fresh = []
  for (const feed of NEWS_FEEDS) {
    const xml = await fetchNewsText(feed)
    if (!xml) continue
    for (const it of parseRSS(xml)) {
      const key = it.title.replace(/\s+/g, '')
      if (seen.has(key)) continue
      if (it.dateStr < minDate) continue
      seen.add(key)
      fresh.push({ title: it.title, summary: it.summary, category: classifyNews(`${it.title} ${it.summary}`) || feed.cat, date: it.dateStr, source: feed.source })
    }
  }
  let inserted = 0
  const cap = Math.min(fresh.length, 60)
  for (let i = 0; i < cap; i++) {
    const n = fresh[i]
    await store.create('news', { title: n.title, summary: n.summary, category: n.category, date: n.date, source: n.source })
    inserted += 1
  }
  res.json({ ok: true, added: inserted, total: inserted })
})

router.post('/news/digest', async (req, res) => {
  const b = req.body || {}
  const days = Math.max(1, Math.min(Number(b.days) || 3, 7))
  const fromDate = shiftDate(localDate(), -(days - 1))
  const list = await store.findSince('news', 'date', fromDate, { desc: 'date' })
  if (list.length === 0) return res.json({ ok: true, reply: '近几天还没有要闻。点「抓取今日要闻」从新闻网站自动收集后再整理。', count: 0 })
  const lines = list
    .map((n, i) => `${i + 1}. [${n.category}] (${n.date}) ${n.title}${n.summary ? '：' + n.summary : ''}`)
    .join('\n')
  const ai = await runAI([
    { role: 'system', content: '你是每日要闻整理助手。把用户提供的若干条新闻归纳成一份简洁的「今日要闻」：按 安全 / 科技 / 教育 / 生活 / 影响个人的重大事件 分组；每条用一句话说明为什么值得关注；最后给一句整体趋势判断。用分点输出，不要编造新闻。' },
    { role: 'user', content: `【近期新闻（近 ${days} 天，共 ${list.length} 条）】\n${lines}\n\n请整理成今日要闻摘要。` },
  ])
  res.json({ ok: ai.ok, reply: ai.ok ? ai.content : ai.error, count: list.length, error: ai.ok ? null : ai.error })
})

router.get('/news', async (req, res) => {
  const date = req.query.date || ''
  const q = req.query.q || ''
  const limit = Math.min(Number(req.query.limit || 200), 500)
  let news
  if (q) {
    news = await store.findLike('news', 'title', q, { desc: 'date' })
    news = news.slice(0, limit)
  } else if (date) {
    news = await store.find('news', { conds: [{ key: 'date', val: date }], desc: 'id' })
  } else {
    news = await store.find('news', { desc: 'id' })
    news = news.slice(0, limit)
  }
  res.json({ news })
})

router.post('/news', async (req, res) => {
  const b = req.body || {}
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'empty_title' })
  const r = await store.create('news', { title: String(b.title).trim(), summary: String(b.summary || '').trim(), category: b.category || 'general', date: b.date || localDate(), source: String(b.source || '').trim() })
  res.json({ ok: true, id: r.id })
})

router.post('/news/suggest-goals', async (req, res) => {
  const b = req.body || {}
  const days = Math.max(1, Math.min(Number(b.days) || 30, 90))
  const start = new Date()
  start.setDate(start.getDate() - (days - 1))
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`
  const news = await store.findSince('news', 'date', startStr, { desc: 'date' })
  const goals = await store.find('goals', { conds: [{ key: 'status', val: 'active' }], asc: 'id' })
  if (news.length === 0) return res.json({ ok: true, reply: '近 30 天暂无要闻。先在「要闻」里收集几条重要新闻，AI 才能据此给出目标建议。', count: 0 })
  const newsLines = news.map((n, i) => `${i + 1}. [${n.category}] (${n.date}) ${n.title}${n.summary ? '：' + n.summary : ''}`).join('\n')
  const goalLines = goals.length ? goals.map((g, i) => `${i + 1}. ${g.name}（类型 ${g.type}${g.done_criteria ? '，标准：' + g.done_criteria : ''}）`).join('\n') : '（暂无现有目标）'
  const ai = await runAI([
    { role: 'system', content: '你是个人成长规划助手。根据近期重要新闻和用户现有目标，判断哪些新闻可能催生新的长期目标、或提示对现有目标做调整。输出：\n一、新增目标建议（每条给出：目标名称、类型、完成标准、由哪条新闻触发、为什么值得做）\n二、现有目标调整建议（指出目标名称、建议调整什么、由哪条新闻触发）\n三、一句总体判断。\n只基于给定新闻给出有依据的建议，不要编造新闻内容；若无相关，明说。' },
    { role: 'user', content: `【近期要闻（近 ${days} 天，共 ${news.length} 条）】\n${newsLines}\n\n【我当前的长期目标】\n${goalLines}\n\n请给出新目标或现有目标的调整建议。` },
  ])
  res.json({ ok: ai.ok, reply: ai.ok ? ai.content : ai.error, count: news.length, error: ai.ok ? null : ai.error })
})

router.put('/news/:id', async (req, res) => {
  const b = req.body || {}
  if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'empty_title' })
  await store.updateByIntId('news', req.params.id, { title: String(b.title).trim(), summary: String(b.summary || '').trim(), category: b.category || 'general', date: b.date || localDate(), source: String(b.source || '').trim() })
  res.json({ ok: true })
})

router.delete('/news/:id', async (req, res) => {
  await store.deleteByIntId('news', req.params.id)
  res.json({ ok: true })
})

// ---- GitHub 开源榜 ----
router.post('/github/trending', async (req, res) => {
  const b = req.body || {}
  const since = ['daily', 'weekly', 'monthly'].includes(b.since) ? b.since : 'daily'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 25000)
  try {
    const resp = await fetch(`https://github.com/trending?since=${since}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: controller.signal,
    })
    if (!resp.ok) return res.json({ ok: false, error: `GitHub 返回 ${resp.status}` })
    const text = await resp.text()
    const repos = parseTrending(text).slice(0, 10)
    if (repos.length === 0) return res.json({ ok: false, error: '未能解析到项目，页面结构可能已变化' })
    return res.json({ ok: true, since, repos })
  } catch {
    return res.json({ ok: false, error: '抓取 GitHub 超时或失败（国内网络较慢），请稍后重试' })
  } finally { clearTimeout(timer) }
})

router.post('/github/trending/summary', async (req, res) => {
  const b = req.body || {}
  const repos = Array.isArray(b.repos) ? b.repos.slice(0, 10) : []
  if (repos.length === 0) return res.json({ ok: false, error: '没有可解读的项目' })
  const lines = repos.map((r, i) => `${i + 1}. ${r.full}: ${r.desc || '（无描述）'}`).join('\n')
  const ai = await runAI([
    { role: 'system', content: '你是开源项目介绍助手。用简体中文为下面每个 GitHub 热门项目写一句话功能简介（讲清它是什么、解决什么问题），按编号分点输出，不要编造，描述缺失的写"暂缺描述"。' },
    { role: 'user', content: lines },
  ])
  res.json({ ok: ai.ok, reply: ai.ok ? ai.content : ai.error, error: ai.ok ? null : ai.error })
})

// ---- 设置 ----
router.get('/settings', async (req, res) => {
  const raw = await store.getSetting('ai_config')
  let cfg = { baseUrl: '', model: 'gpt-4o-mini', hasKey: false }
  if (raw) { try { cfg = { ...cfg, ...JSON.parse(raw), hasKey: !!JSON.parse(raw).apiKey } } catch {} }
  res.json({ ai: cfg })
})

router.put('/settings/ai', async (req, res) => {
  const b = req.body || {}
  const prev = await store.getSetting('ai_config')
  let prevCfg = {}
  if (prev) { try { prevCfg = JSON.parse(prev) } catch {} }
  const next = { baseUrl: b.baseUrl || '', apiKey: b.apiKey !== undefined ? b.apiKey : (prevCfg.apiKey || ''), model: b.model || 'gpt-4o-mini' }
  await store.setSetting('ai_config', JSON.stringify(next))
  res.json({ ok: true, hasKey: !!next.apiKey })
})

router.put('/settings/password', async (req, res) => {
  const b = req.body || {}
  if (!b.newPassword || b.newPassword.length < 4) return res.status(400).json({ error: 'password_too_short' })
  await store.setSetting('auth_pw', await makePasswordRecord(b.newPassword))
  res.json({ ok: true })
})

router.use((req, res) => res.status(404).json({ error: 'not_found' }))

app.use('/api', router)

// 静态前端（vite 构建产物）
const DIST = path.join(__dirname, 'dist')
app.use(express.static(DIST))
app.get('*splat', (req, res) => {
  res.sendFile(path.join(DIST, 'index.html'))
})

// 启动（云引擎注入 LEANCLOUD_APP_PORT，本地默认 8787）
const port = Number(process.env.LEANCLOUD_APP_PORT || process.env.PORT || 8787)
app.listen(port, () => {
  console.log(`[助理白] LeanCloud 云引擎已启动，端口 ${port}`)
})
