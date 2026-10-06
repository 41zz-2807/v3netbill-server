/**
 * Simulasi Agent PC untuk pengujian.
 *
 * ⚠️ ALASAN BERKAS INI ADA: fitur auto-matikan PC (dan fitur lain yang
 * bergantung pada heartbeat) mustahil diuji andal di server produksi,
 * karena:
 *
 * - PC asli dipakai pelanggan sungguhan, dan mematikan PC-nya saat diuji
 *   berarti memutus sesi orang.
 * - Agent asli hanya jalan di Windows, sedangkan server ini Linux.
 * - Kalau Tes-TEST dipakai PC asli, `registerAgent()` akan saling menendang
 *   dengan agent asli (satu socket per agentToken) — yang pernah terjadi
 *   13 kali dalam 2 menit.
 *
 * Jadi skrip ini membaca protokol agent yang sama persis dengan
 * `Agent.Core/ServerConnection.cs`: handshake `pcId` + `agentToken` di query
 * URL, lalu `agent:heartbeat` tiap 15 detik, dan mendengarkan
 * `admin:lock` / `admin:shutdown`.
 *
 * Pemakaian (dari host):
 *   docker cp simulasi-agent.mjs v3netbill-backend:/app/
 *   docker compose exec v3netbill-backend node /app/simulasi-agent.mjs <pcId> <agentToken> [durasiDetik]
 *
 * ⚠️ Selalu pakai PC uji yang dibuat khusus. JANGAN pernah memberikannya
 * `pcId` + `agentToken` PC sungguhan.
 */
import { io } from 'socket.io-client'

const pcId = process.argv[2]
const agentToken = process.argv[3]
const durasiDetik = Number(process.argv[4] ?? 180)

if (!pcId || !agentToken) {
  console.error('Pemakaian: node simulasi-agent.mjs <pcId> <agentToken> [durasiDetik]')
  process.exit(1)
}

const stempel = () => new Date().toISOString().slice(11, 19)
const server = process.env.SERVER_URL || 'http://localhost:3000'
const url = `${server.replace(/\/$/, '')}/session`

// Samakan dengan agent asli: 15 detik, mengikuti HEARTBEAT_INTERVAL_DETIK di
// Agent.Core/ServerConnection.cs:31.
const INTERVAL_HEARTBEAT_MS = 15_000

const socket = io(url, {
  transports: ['websocket'],
  // ⚠️ WAJIB lewat query, bukan `auth` — `handleConnection()` membaca
  // `client.handshake.query.pcId`. Kalau dikirim lewat `auth`, agent tidak
  // pernah terdaftar di `pcSocketMap` dan tidak akan pernah menerima perintah.
  query: { pcId, agentToken },
})

let shutdownDiterima = false
let jumlahHeartbeat = 0

socket.on('connect', () => {
  console.log(`[${stempel()}] tersambung sebagai agent simulasi`)
  // Heartbeat pertama langsung, supaya tidak menunggu 15 detik.
  kirimHeartbeat()
  socket.emit('agent:register', { pcId, agentToken }, (balasan) => {
    console.log(`[${stempel()}] agent:register ->`, JSON.stringify(balasan))
  })
})

function kirimHeartbeat() {
  jumlahHeartbeat++
  socket.emit('agent:heartbeat', { pcId })
}

socket.on('admin:shutdown', (p) => {
  shutdownDiterima = true
  console.log(`[${stempel()}] <<< admin:shutdown DITERIMA untuk ${p?.pcId} (sesi ke-${jumlahHeartbeat})`)
  console.log(`[${stempel()}] agent asli akan menjalankan: shutdown /s /f /t 10`)
})

socket.on('admin:lock', (p) => {
  console.log(`[${stempel()}] <<< admin:lock diterima untuk ${p?.pcId}`)
})

socket.on('session:start', (p) => {
  console.log(`[${stempel()}] <<< session:start, durasi ${p?.durasiDetikTersedia} dtk`)
})

socket.on('session:tick', (p) => {
  console.log(`[${stempel()}] <<< session:tick sisa ${p?.sisaDetik} dtk`)
})

socket.on('session:stop', (p) => {
  console.log(`[${stempel()}] <<< session:stop alasan ${p?.alasan}`)
})

socket.on('connect_error', (e) => {
  console.error(`[${stempel()}] gagal konek: ${e.message}`)
  process.exit(1)
})

socket.on('disconnect', (alasan) => {
  console.log(`[${stempel()}] terputus: ${alasan}`)
})

const interval = setInterval(kirimHeartbeat, INTERVAL_HEARTBEAT_MS)

setTimeout(() => {
  console.log(`---`)
  console.log(`[${stempel()}] ringkasan: heartbeat terkirim ${jumlahHeartbeat}, admin:shutdown diterima: ${shutdownDiterima}`)
  clearInterval(interval)
  socket.close()
  process.exit(shutdownDiterima ? 0 : 1)
}, durasiDetik * 1000)
