// 数据层：MongoDB（Mongoose）数据存储封装
// 设计目标：保持前端零改动——数据库主键是 ObjectId，但前端路由全部使用数字 id，
// 因此为每个 Collection 维护自增整数 id 字段，接口与原有 store 保持一致。
const mongoose = require('mongoose')

let connected = false

// 严格集合名，不做复数化
const schemaCache = new Map()

function modelFor(className) {
  if (mongoose.models[className]) return mongoose.model(className)
  const schema = new mongoose.Schema({}, { strict: false, id: false, versionKey: false })
  schemaCache.set(className, schema)
  return mongoose.model(className, schema, className)
}

async function init(uri) {
  if (connected) return
  mongoose.set('strictQuery', false)
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 20000,
  })
  connected = true
}

function nowStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// 取某 Collection 当前最大整数 id + 1（单用户并发低，足够）
async function nextId(className) {
  const M = modelFor(className)
  const top = await M.findOne({ id: { $exists: true } }).sort({ id: -1 }).lean()
  return (top && Number(top.id) ? Number(top.id) : 0) + 1
}

// 通用：新建文档，自动分配整数 id 并补时间戳
async function create(className, data) {
  const M = modelFor(className)
  const payload = { ...data }
  payload.id = await nextId(className)
  if (!payload.created_at) payload.created_at = nowStr()
  if (!payload.updated_at) payload.updated_at = nowStr()
  const doc = await M.create(payload)
  return { objectId: doc._id.toString(), id: Number(doc.id) }
}

// 通用：按整数 id 查单条，返回带 id 的 plain 对象或 null
async function findByIntId(className, intId) {
  const M = modelFor(className)
  const doc = await M.findOne({ id: Number(intId) }).lean()
  return doc ? toPlain(doc) : null
}

// 通用：按条件查多条（conds: [{key, val}] 相等条件；desc/asc 排序字段）
async function find(className, { conds = [], desc = '', asc = '', limit = 1000 } = {}) {
  const M = modelFor(className)
  const filter = {}
  for (const c of conds) filter[c.key] = c.val
  let q = M.find(filter)
  if (desc) q = q.sort({ [desc]: -1 })
  else if (asc) q = q.sort({ [asc]: 1 })
  q = q.limit(limit)
  const docs = await q.lean()
  return docs.map(toPlain)
}

// 通用：全文模糊搜索（两个字段任一命中，如 content/tags、title/summary）
async function findLike(className, field, keyword, { desc = '', limit = 1000 } = {}) {
  const M = modelFor(className)
  const second = field.replace(/content/, 'tags').replace(/title/, 'summary')
  const re = new RegExp(escapeReg(keyword), 'i')
  const filter = { $or: [{ [field]: re }, { [second]: re }] }
  let q = M.find(filter)
  if (desc) q = q.sort({ [desc]: -1 })
  q = q.limit(limit)
  const docs = await q.lean()
  return docs.map(toPlain)
}

function escapeReg(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 通用：更新按整数 id 定位的对象
async function updateByIntId(className, intId, data) {
  const M = modelFor(className)
  const r = await M.updateOne({ id: Number(intId) }, { $set: { ...data, updated_at: nowStr() } })
  return r.matchedCount > 0
}

// 通用：删除按整数 id 定位的对象
async function deleteByIntId(className, intId) {
  const M = modelFor(className)
  const r = await M.deleteOne({ id: Number(intId) })
  return r.deletedCount > 0
}

// 通用：删除满足相等条件的全部对象
async function deleteWhere(className, conds = []) {
  const M = modelFor(className)
  const filter = {}
  for (const c of conds) filter[c.key] = c.val
  await M.deleteMany(filter)
}

// settings 键值对
async function getSetting(key) {
  const M = modelFor('settings')
  const doc = await M.findOne({ key }).lean()
  return doc ? doc.value : null
}

async function setSetting(key, value) {
  const M = modelFor('settings')
  await M.updateOne({ key }, { $set: { key, value, updated_at: nowStr() } }, { upsert: true })
}

// 某字段去重值集合（如 checkins 的 date）
async function distinct(className, field, { conds = [] } = {}) {
  const M = modelFor(className)
  const filter = {}
  for (const c of conds) filter[c.key] = c.val
  const vals = await M.distinct(field, filter)
  const set = new Set()
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== '') set.add(String(v))
  }
  return set
}

// 统计计数
async function count(className, { conds = [] } = {}) {
  const M = modelFor(className)
  const filter = {}
  for (const c of conds) filter[c.key] = c.val
  return M.countDocuments(filter)
}

// 按 >= 条件查（date / created_at 范围），用于区间查询
async function findSince(className, field, min, { desc = '', limit = 1000 } = {}) {
  const M = modelFor(className)
  const filter = { [field]: { $gte: min } }
  let q = M.find(filter)
  if (desc) q = q.sort({ [desc]: -1 })
  q = q.limit(limit)
  const docs = await q.lean()
  return docs.map(toPlain)
}

// 把文档转成带整数 id 的 plain 对象
function toPlain(doc) {
  const p = { objectId: String(doc._id) }
  for (const k in doc) {
    if (k === '_id' || k === '__v') continue
    p[k] = doc[k]
  }
  p.id = Number(doc.id !== undefined ? doc.id : doc._id)
  return p
}

module.exports = {
  init, nextId, create, findByIntId, find, findLike, updateByIntId,
  deleteByIntId, deleteWhere, getSetting, setSetting, distinct, count,
  findSince, toPlain,
}
