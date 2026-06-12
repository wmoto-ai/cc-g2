// 共有可変状態の単一所有モジュール + JSONL 永続化プリミティブ + log。
// 可変状態は必ず store オブジェクトのプロパティとして持つ
// （ESM のモジュール間 let export は再代入が他モジュールから見えないため）。
// 他モジュールはコレクション（Array/Map/Set）を参照で受け取り、
// 再代入される値（lastLocation）は store.lastLocation 経由で読み書きする。
import { mkdir, readFile, appendFile } from 'node:fs/promises'
import { dataDir, imagesDir } from './config.mjs'

/** @typedef {{id:string,source:'moshi'|'claude-code',title:string,summary:string,fullText:string,createdAt:string,replyCapable:boolean,raw?:unknown,metadata?:Record<string, unknown>}} NotificationItem */
/** @typedef {{id:string,notificationId:string,replyText:string,createdAt:string,status:'stubbed'|'forwarded'|'failed',action?:'approve'|'deny'|'comment',resolvedAction?:'approve'|'deny'|'comment',result?:'resolved'|'relayed'|'ignored',ignoredReason?:'approval-not-pending'|'approval-link-not-found',comment?:string,source?:string,error?:string}} ReplyRecord */
/** @typedef {{id:string,notificationId:string,source:string,toolName:string,toolInput:unknown,toolId:string,cwd:string,reason:string,agentName:string,status:'pending'|'decided'|'expired',decision?:'approve'|'deny',resolution?:'superseded'|'session-ended'|'terminal-disconnect',comment?:string,decidedBy?:string,createdAt:string,decidedAt?:string,deliveredAt?:string}} ApprovalRecord */
/** @typedef {'active'|'idle'|'error'|'dead'} SessionActivityState */

const store = {
  /** @type {NotificationItem[]} */
  notifications: [],
  /** @type {Map<string, NotificationItem>} */
  notificationsById: new Map(),
  /** @type {ReplyRecord[]} */
  replies: [],
  /** @type {Set<string>} */
  notificationExternalIds: new Set(),
  /** @type {Map<string, number>} */
  permissionThreadSeenAt: new Map(),
  /** @type {Map<string, {sessionId:string,cwd:string,usedPercentage:number,model:string,updatedAt:string}>} */
  contextStatusBySession: new Map(),
  /** @type {ApprovalRecord[]} */
  approvals: [],
  /** @type {Map<string, ApprovalRecord>} */
  approvalsById: new Map(),
  /** @type {Map<string, ApprovalRecord>} */
  approvalsByNotificationId: new Map(),
  /** @type {Map<string, number>} */
  uiSessions: new Map(),
  /** @type {{lat:number,lng:number,altitude:number|null,timestamp:string,speed:number|null,battery:number|null,receivedAt:string}|null} */
  lastLocation: null,
  /** @type {Set<import('node:http').ServerResponse>} */
  sseClients: new Set(),
  /** @type {Map<string, {tmuxTarget:string, label:string, state:SessionActivityState, updatedAt:string}>} */
  sessionActivity: new Map(),
  /** @type {Map<string, {file:string,contentType:string,createdAt:string}>} */
  imagesById: new Map(),
}

async function ensureDataDir() {
  await mkdir(dataDir, { recursive: true })
  await mkdir(imagesDir, { recursive: true })
}

async function loadJsonl(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return []
    throw err
  }
}

async function appendJsonl(filePath, obj) {
  await appendFile(filePath, `${JSON.stringify(obj)}\n`, 'utf8')
}

function log(...args) {
  console.log(new Date().toISOString(), ...args)
}

export { store, ensureDataDir, loadJsonl, appendJsonl, log }
