/**
 * Host half of the Read Aloud bundle: offline neural speech synthesis.
 *
 * The browser half speaks with the system voice. When at least one
 * sherpa-onnx voice model is installed, this half synthesizes the reply as
 * WAV audio on the Host and serves it to the page, which gives real neural
 * voices instead of the one or two SAPI voices a browser can reach.
 *
 * Why the Host and not the page: the model is a native ONNX addon that only
 * runs in Node, and `sherpa-onnx-node` ships inside the Harness installation.
 * A plugin directory cannot resolve it through normal `import`, so it is
 * loaded from the Harness `node_modules` that owns the running process.
 *
 * Everything is optional. With no model installed, `/voices` reports an empty
 * list and the page keeps using the system voice exactly as before.
 *
 * Routes (all under the Connection `/api` channel, always read with a
 * relative URL so Desktop and Web both work):
 *
 *   GET  /api/dsh-read-aloud/voices   installed neural voices
 *   POST /api/dsh-read-aloud/speech   { text, voice, rate } -> audio/wav
 *
 * @module @local/dsh-read-aloud
 */

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

/** Route prefix owned by this plugin. */
const ROUTE_BASE = '/api/dsh-read-aloud'

/** Where installed voice models live, under the DSH home. */
const VOICES_DIRNAME = 'read-aloud-voices'

/** Model-file extensions that are never reported as a missing model. */
const MANIFEST_FILE = 'plugin.json'

/** Reserved cloud-TTS configuration, optional and off unless present. */
const CLOUD_CONFIG_FILE = 'cloud.json'

/** Prefix marking a voice that is synthesized by a remote provider. */
const CLOUD_VOICE_PREFIX = 'cloud:'

/** Longest text one request may synthesize. */
const MAX_TEXT = 6000

/** Per-request synthesis ceiling, in milliseconds. */
const GENERATE_TIMEOUT_MS = 120000

/** How long the waveform cache keeps one entry. */
const CACHE_TTL_MS = 10 * 60 * 1000

/** How many synthesized waveforms to keep. */
const CACHE_LIMIT = 32

/**
 * Resolve the Harness `node_modules` that owns this process, which is where
 * `sherpa-onnx-node` and its platform binary are installed.
 * @returns {string} absolute path used as a `createRequire` base.
 */
function harnessRequireBase() {
  // <...>/resources/app.asar/dsh/node_modules lives beside the app root.
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
  if (resources.length > 0) return path.join(resources, 'app.asar', 'dsh', 'node_modules')
  // A non-packaged Harness: <root>/node_modules/@deepseek-ai/<pkg>/...
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const marker = `${path.sep}node_modules${path.sep}`
  const at = here.lastIndexOf(marker)
  if (at > 0) return here.slice(0, at + marker.length)
  return here
}

/**
 * Load the offline TTS addon, or report why it is unavailable.
 * @returns {{ Tts: object | null, GenerationConfig: object | null, error: string | null }} constructors and a reason.
 */
function loadAddon() {
  try {
    const requireFromHarness = createRequire(path.join(harnessRequireBase(), 'noop.js'))
    const mod = requireFromHarness('sherpa-onnx-node/non-streaming-tts.js')
    return {
      Tts: mod.OfflineTts ?? null,
      GenerationConfig: mod.GenerationConfig ?? null,
      error: mod.OfflineTts ? null : 'sherpa-onnx-node 缺少 OfflineTts',
    }
  } catch (error) {
    return {
      Tts: null,
      GenerationConfig: null,
      error: `无法加载 sherpa-onnx-node：${String(error?.message ?? error).split('\n')[0]}`,
    }
  }
}

/**
 * Per-voice synthesizer owner: loads a model on first use, keeps one instance
 * alive, and serializes generation because one native handle is not reentrant.
 */
class VoiceRuntime {
  /**
   * @param {object} manifest - installed voice manifest.
   * @param {object} addon - `{ Tts, GenerationConfig }` loaded from the Harness.
   * @param {string} directory - absolute model directory.
   */
  constructor(manifest, addon, directory) {
    this.manifest = manifest
    this.addon = addon
    this.Tts = addon.Tts
    this.directory = directory
    /** @type {object | null} */
    this.instance = null
    /** @type {Promise<unknown>} tail of the serialized queue. */
    this.queue = Promise.resolve()
    /** @type {string | null} */
    this.failure = null
  }

  /**
   * Build OfflineTts from the manifest's model declaration.
   *
   * Two families are supported through the same manifest shape:
   *  - `kind: 'vits'` (default): Piper-style single-speaker Chinese voices,
   *    driven by a pinyin lexicon;
   *  - `kind: 'kokoro'`: multilingual Chinese+English voice packs with many
   *    speakers, selected per request by `sid`.
   * @returns {object} the OfflineTts instance.
   */
  async open() {
    if (this.instance !== null) return this.instance
    if (this.failure !== null) throw new Error(this.failure)
    const model = this.manifest.model || {}
    const kind = model.kind === 'kokoro' ? 'kokoro' : model.kind === 'matcha' ? 'matcha' : 'vits'
    const resolve = (name) => (name === undefined ? undefined : path.join(this.directory, name))
    const config = {
      model: {
        numThreads: 2,
        debug: false,
        provider: 'cpu',
      },
    }
    if (kind === 'kokoro') {
      config.model.kokoro = {
        model: resolve(model.file),
        voices: resolve(model.voices),
        tokens: resolve(model.tokens),
        /* Kokoro's lexicons are a comma-separated list (English + Chinese). */
        lexicon: Array.isArray(model.lexicons)
          ? model.lexicons.map((name) => path.join(this.directory, name)).join(',')
          : resolve(model.lexicon),
        dataDir: model.dataDir === undefined ? path.join(this.directory, 'espeak-ng-data') : resolve(model.dataDir),
        lang: model.lang,
      }
    } else if (kind === 'matcha') {
      /* Matcha is two-stage: an acoustic model plus a separate neural vocoder.
         The vocoder is shared between voices, so it may live in the pack. */
      config.model.matcha = {
        acousticModel: resolve(model.file),
        vocoder: resolve(model.vocoder),
        tokens: resolve(model.tokens),
        lexicon: resolve(model.lexicon),
        dataDir: model.dataDir === undefined ? path.join(this.directory, 'espeak-ng-data') : resolve(model.dataDir),
        dictDir: this.directory,
      }
    } else {
      config.model.vits = {
        model: resolve(model.file),
        tokens: resolve(model.tokens),
        lexicon: resolve(model.lexicon),
        dictDir: this.directory,
      }
    }
    const rules = (this.manifest.ruleFsts || []).map((name) => path.join(this.directory, name))
    if (rules.length > 0) config.ruleFsts = rules.join(',')
    try {
      this.instance = new this.Tts(config)
      return this.instance
    } catch (error) {
      this.failure = `模型加载失败：${String(error?.message ?? error).split('\n')[0]}`
      throw new Error(this.failure)
    }
  }

  /**
   * Synthesize text, one call at a time.
   *
   * Kokoro needs `generationConfig` (sid/speed); the Piper path takes the flat
   * request shape. Both go through the same serialized queue because one native
   * handle is not reentrant.
   * @param {string} text - text to speak.
   * @param {number} rate - speed multiplier.
   * @param {number} sid - speaker id (used by multi-speaker models).
   * @returns {Promise<{ samples: Float32Array, sampleRate: number }>} waveform.
   */
  generate(text, rate, sid) {
    const run = this.queue.then(async () => {
      const tts = await this.open()
      const speaker = Number.isInteger(sid) ? sid : 0
      /* Electron refuses Buffer-backed float arrays, so the sample array must
         be allocated by the addon itself. */
      let result
      if (this.manifest.model && this.manifest.model.kind === 'kokoro' && this.addon.GenerationConfig !== null) {
        const GenerationConfig = this.addon.GenerationConfig
        result = tts.generate({
          text,
          generationConfig: new GenerationConfig({ sid: speaker, speed: rate, silenceScale: 0.2 }),
          enableExternalBuffer: false,
        })
      } else {
        result = tts.generate({ text, sid: speaker, speed: rate, enableExternalBuffer: false })
      }
      return { samples: result.samples, sampleRate: result.sampleRate }
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * Synthesize text as a stream, handing each fragment to `onChunk`.
   *
   * `generateAsync` reports fragments while it produces them, so the caller can
   * start playing before the whole sentence exists. Measured on the Piper
   * voices: the first fragment arrives at roughly 0.55x the total time, covering
   * more than half of the audio.
   * @param {string} text - text to speak.
   * @param {number} rate - speed multiplier.
   * @param {number} sid - speaker id.
   * @param {(samples: Float32Array) => void} onChunk - receives each fragment.
   * @returns {Promise<{ samples: Float32Array, sampleRate: number }>} the full waveform.
   */
  stream(text, rate, sid, onChunk) {
    const run = this.queue.then(async () => {
      const tts = await this.open()
      const speaker = Number.isInteger(sid) ? sid : 0
      const request = {
        text,
        enableExternalBuffer: false,
        onProgress: (info) => {
          if (info && info.samples && info.samples.length > 0) onChunk(info.samples)
          /* Returning true keeps generation going. */
          return true
        },
      }
      if (this.manifest.model && this.manifest.model.kind === 'kokoro' && this.addon.GenerationConfig !== null) {
        const GenerationConfig = this.addon.GenerationConfig
        request.generationConfig = new GenerationConfig({ sid: speaker, speed: rate, silenceScale: 0.2 })
      } else {
        request.sid = speaker
        request.speed = rate
      }
      const result = await tts.generateAsync(request)
      return { samples: result.samples, sampleRate: result.sampleRate }
    })
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * Read installed voice manifests.
 * @param {string} root - voices directory.
 * @returns {{ manifests: object[], error: string | null }} usable manifests.
 */
function readManifests(root) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { manifests: [], error: null }
    return { manifests: [], error: `无法读取音色目录：${String(error?.message ?? error)}` }
  }
  const manifests = []
  const problems = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = path.join(root, entry.name)
    const manifestPath = path.join(directory, MANIFEST_FILE)
    let raw
    try {
      /* Strip a UTF-8 BOM: manifests are often written by Windows editors and
         PowerShell's UTF8 encoding adds one, which JSON.parse rejects. */
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      if (error?.code !== 'ENOENT') problems.push(`${entry.name}: plugin.json 无法解析`)
      continue
    }
    if (raw === null || typeof raw !== 'object') continue
    const model = raw.model
    if (model === undefined || typeof model.file !== 'string' || typeof model.tokens !== 'string') {
      problems.push(`${entry.name}: plugin.json 缺少 model.file / model.tokens`)
      continue
    }
    const isKokoro = model.kind === 'kokoro'
    if (isKokoro && typeof model.voices !== 'string') {
      problems.push(`${entry.name}: Kokoro 模型缺少 model.voices`)
      continue
    }
    const isMatcha = model.kind === 'matcha'
    if (isMatcha && typeof model.vocoder !== 'string') {
      problems.push(`${entry.name}: Matcha 模型缺少 model.vocoder`)
      continue
    }
    const lexiconNames = Array.isArray(model.lexicons)
      ? model.lexicons
      : [model.lexicons === undefined ? model.lexicon : model.lexicons]
    const required = [model.file, model.vocoder, model.tokens, ...lexiconNames, ...(raw.ruleFsts || [])].filter(
      (name) => typeof name === 'string',
    )
    const missing = required.filter((name) => !fs.existsSync(path.join(directory, name)))
    if (missing.length > 0) {
      problems.push(`${entry.name}: 缺少文件 ${missing.join(', ')}`)
      continue
    }
    /* Kokoro keeps its espeak data in a subdirectory; a missing one is a broken install. */
    if (isKokoro || isMatcha) {
      const dataDir = model.dataDir === undefined ? 'espeak-ng-data' : model.dataDir
      if (!fs.existsSync(path.join(directory, dataDir))) {
        problems.push(`${entry.name}: 缺少 ${dataDir}`)
        continue
      }
    }
    manifests.push({
      id: entry.name,
      directory,
      label: typeof raw.label === 'string' ? raw.label : entry.name,
      description: typeof raw.description === 'string' ? raw.description : '',
      language: typeof raw.language === 'string' ? raw.language : 'zh-CN',
      license: typeof raw.license === 'string' ? raw.license : null,
      engine: isKokoro ? 'kokoro' : isMatcha ? 'matcha' : 'vits',
      /* The page warns before a user picks a voice that is slow to synthesize. */
      slow: raw.slow === true || isKokoro,
      /* Multi-speaker models let the page pick a speaker id per voice entry. */
      speakers: Array.isArray(raw.speakers) ? raw.speakers : null,
      manifest: raw,
    })
  }
  manifests.sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'))
  return { manifests, error: problems.length > 0 ? problems.join('; ') : null }
}

/**
 * Encode float samples as a 16-bit mono PCM WAV file.
 * @param {Float32Array} samples - audio samples in [-1, 1].
 * @param {number} sampleRate - sample rate in Hz.
 * @returns {Buffer} WAV bytes.
 */
function encodeWav(samples, sampleRate) {
  const frames = samples.length
  const buffer = Buffer.allocUnsafe(44 + frames * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(frames * 2, 40)
  for (let index = 0; index < frames; index += 1) {
    const value = Math.max(-1, Math.min(1, samples[index]))
    buffer.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), 44 + index * 2)
  }
  return buffer
}

/**
 * Bound a number to a range.
 * @param {unknown} value - candidate.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @param {number} fallback - used when the candidate is not a number.
 * @returns {number} clamped value.
 */
function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number.parseFloat(String(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

/**
 * Register the read-aloud Host routes.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 */
export function apply(ctx) {
  const addon = loadAddon()
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), '.dsh')
  const voicesRoot = path.join(home, VOICES_DIRNAME)

  /** @type {Map<string, VoiceRuntime>} */
  const runtimes = new Map()
  /** @type {Map<string, { at: number, wav: Buffer, sampleRate: number }>} */
  const cache = new Map()

  const listVoices = () => {
    const { manifests, error } = readManifests(voicesRoot)
    const cloud = readCloudConfig()
    const local = manifests.map(({ manifest, directory, ...rest }) => rest)
    const remote = cloud === null ? [] : cloud.voices
    const voices = local.concat(remote)
    return {
      ok: true,
      value: {
        available: voices.length > 0,
        engine: remote.length > 0 ? 'sherpa-onnx+cloud' : local.length > 0 ? 'sherpa-onnx' : 'system',
        reason: addon.error ?? error ?? (voices.length === 0 ? '尚未安装离线音色模型' : null),
        voicesRoot,
        streaming: addon.Tts !== null,
        cloudConfigured: remote.length > 0,
        voices,
      },
    }
  }

  const runtimeFor = (id) => {
    const existing = runtimes.get(id)
    if (existing !== undefined) return existing
    const { manifests } = readManifests(voicesRoot)
    const found = manifests.find((candidate) => candidate.id === id)
    if (found === undefined) return undefined
    const runtime = new VoiceRuntime(found.manifest, addon, found.directory)
    runtimes.set(id, runtime)
    return runtime
  }

  /**
   * Read the reserved cloud-TTS configuration.
   *
   * Cloud voices are off until `cloud.json` exists next to the voice packs, so
   * the local pipeline keeps working with no account and no network. The file
   * shape follows the OpenAI audio API, which is what SiliconFlow, Aliyun
   * Bailian and most domestic providers expose:
   *
   *   { "provider": "openai", "baseUrl": "https://api.siliconflow.cn/v1",
   *     "apiKey": "sk-...", "model": "...", "voices": [{ "id": "...", "label": "..." }] }
   * @returns {{ provider: string, baseUrl: string, apiKey: string, model: string, voices: object[] } | null}
   */
  const readCloudConfig = () => {
    const file = path.join(voicesRoot, CLOUD_CONFIG_FILE)
    let raw
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    } catch (error) {
      return null
    }
    if (raw === null || typeof raw !== 'object') return null
    if (typeof raw.apiKey !== 'string' || raw.apiKey.length === 0) return null
    /* Only the OpenAI-compatible shape is wired up today; 火山 needs its own
       binary streaming client and is reserved rather than half-implemented. */
    if (raw.provider !== undefined && raw.provider !== 'openai') return null
    const baseUrl = typeof raw.baseUrl === 'string' && raw.baseUrl.length > 0
      ? raw.baseUrl.replace(/\/+$/, '')
      : 'https://api.siliconflow.cn/v1'
    return {
      provider: 'openai',
      baseUrl,
      apiKey: raw.apiKey,
      model: typeof raw.model === 'string' ? raw.model : '',
      voices: Array.isArray(raw.voices)
        ? raw.voices.filter((voice) => voice && typeof voice.id === 'string').map((voice) => ({
            id: 'cloud:' + voice.id,
            label: typeof voice.label === 'string' ? voice.label : voice.id,
            language: typeof voice.language === 'string' ? voice.language : 'zh-CN',
            license: typeof voice.license === 'string' ? voice.license : null,
            engine: 'cloud',
            slow: false,
            remoteVoice: voice.id,
          }))
        : [],
    }
  }

  const cacheGet = (key) => {
    const hit = cache.get(key)
    if (hit === undefined) return undefined
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      cache.delete(key)
      return undefined
    }
    return hit
  }

  const cachePut = (key, value) => {
    cache.set(key, value)
    while (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  /**
   * Handle one synthesis request.
   * @param {Request} request - POSTed JSON body.
   * @returns {Promise<Response>} WAV audio or a JSON error.
   */
  const synthesize = async (request) => {
    if (addon.Tts === null) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/no-engine', message: addon.error } },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    }
    let body
    try {
      body = await request.json()
    } catch (error) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/bad-json', message: '请求体不是合法 JSON' } },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text.length === 0) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/empty-text', message: '没有可朗读的文本' } },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }
    if (text.length > MAX_TEXT) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/text-too-long', message: `一次最多朗读 ${MAX_TEXT} 个字符` } },
        { status: 413, headers: { 'cache-control': 'no-store' } },
      )
    }
    const id = typeof body?.voice === 'string' ? body.voice : ''
    const rate = clamp(body?.rate, 0.5, 2, 1)
    /* Multi-speaker packs expose one manifest but many `sid`s. */
    const rawSpeaker = body?.sid
    const sid = Number.isInteger(rawSpeaker) ? rawSpeaker : Number.parseInt(String(rawSpeaker), 10)
    /* Cloud voices are keyed `cloud:<remote id>` and never touch the native addon. */
    if (id.startsWith(CLOUD_VOICE_PREFIX)) {
      return synthesizeCloud(id.slice(CLOUD_VOICE_PREFIX.length), text, rate)
    }
    const voice = runtimeFor(id)
    if (voice === undefined) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/unknown-voice', message: `没有安装音色 ${id || '(空)'}` } },
        { status: 404, headers: { 'cache-control': 'no-store' } },
      )
    }
    const speaker = Number.isInteger(sid) && sid >= 0 ? sid : 0
    const key = `${id}\u0000${speaker}\u0000${rate}\u0000${text}`
    const cached = cacheGet(key)
    if (cached !== undefined) {
      return new Response(new Uint8Array(cached.wav), {
        status: 200,
        headers: { 'content-type': 'audio/wav', 'cache-control': 'no-store', 'x-read-aloud-cache': 'hit' },
      })
    }
    try {
      const audio = await Promise.race([
        voice.generate(text, rate, speaker),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('合成超时')), GENERATE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      const wav = encodeWav(audio.samples, audio.sampleRate || 22050)
      cachePut(key, { at: Date.now(), wav, sampleRate: audio.sampleRate })
      return new Response(new Uint8Array(wav), {
        status: 200,
        headers: {
          'content-type': 'audio/wav',
          'cache-control': 'no-store',
          'x-read-aloud-voice': id,
          'x-read-aloud-sample-rate': String(audio.sampleRate),
        },
      })
    } catch (error) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/synthesis-failed', message: String(error?.message ?? error) } },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      )
    }
  }

  /**
   * Proxy one request to an OpenAI-compatible speech endpoint.
   *
   * Reserved cloud path: works with SiliconFlow, Aliyun Bailian and any other
   * provider exposing `POST /audio/speech`. It is used only when `cloud.json`
   * names voices, so the offline pipeline never depends on the network.
   * @param {string} remoteVoice - provider-side voice id.
   * @param {string} text - text to speak.
   * @param {number} rate - speed multiplier.
   * @returns {Promise<Response>} audio bytes or a JSON error.
   */
  const synthesizeCloud = async (remoteVoice, text, rate) => {
    const cloud = readCloudConfig()
    if (cloud === null) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/cloud-unconfigured', message: '云端音色未配置' } },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    }
    const declared = cloud.voices.find((candidate) => candidate.remoteVoice === remoteVoice)
    if (declared === undefined) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/unknown-voice', message: `云端没有音色 ${remoteVoice}` } },
        { status: 404, headers: { 'cache-control': 'no-store' } },
      )
    }
    const key = 'cloud:' + remoteVoice + '\u0000' + rate + '\u0000' + text
    const cached = cacheGet(key)
    if (cached !== undefined) {
      return new Response(new Uint8Array(cached.wav), {
        status: 200,
        headers: { 'content-type': cached.contentType || 'audio/mpeg', 'cache-control': 'no-store', 'x-read-aloud-cache': 'hit' },
      })
    }
    try {
      const response = await fetch(cloud.baseUrl + '/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cloud.apiKey },
        body: JSON.stringify({
          model: cloud.model,
          input: text,
          voice: remoteVoice,
          speed: rate,
          response_format: 'mp3',
        }),
      })
      if (!response.ok) {
        let detail = ''
        try {
          detail = (await response.text()).slice(0, 300)
        } catch (error) {
          detail = ''
        }
        return Response.json(
          {
            ok: false,
            error: {
              code: 'read-aloud/cloud-failed',
              message: `云端合成失败 (${response.status})${detail ? ': ' + detail : ''}`,
            },
          },
          { status: 502, headers: { 'cache-control': 'no-store' } },
        )
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') || 'audio/mpeg'
      cachePut(key, { at: Date.now(), wav: bytes, contentType })
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': contentType, 'cache-control': 'no-store', 'x-read-aloud-voice': 'cloud:' + remoteVoice },
      })
    } catch (error) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/cloud-network', message: String(error?.message ?? error) } },
        { status: 502, headers: { 'cache-control': 'no-store' } },
      )
    }
  }

  /**
   * Stream one localized sentence as framed PCM.
   *
   * Frame layout, little endian: magic `DRS1`, uint32 sample rate, uint32
   * format (1 = mono int16), then repeated { uint32 byteLength, int16 samples }.
   * A framed stream lets the page start playing the first fragment instead of
   * waiting for the whole sentence.
   * @param {Request} request - POSTed JSON body.
   * @returns {Promise<Response>} a framed PCM stream.
   */
  const streamSpeech = async (request) => {
    if (addon.Tts === null) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/no-engine', message: addon.error } },
        { status: 503, headers: { 'cache-control': 'no-store' } },
      )
    }
    let body
    try {
      body = await request.json()
    } catch (error) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/bad-json', message: '请求体不是合法 JSON' } },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text.length === 0 || text.length > MAX_TEXT) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/bad-text', message: '文本为空或过长' } },
        { status: 400, headers: { 'cache-control': 'no-store' } },
      )
    }
    const id = typeof body?.voice === 'string' ? body.voice : ''
    const rate = clamp(body?.rate, 0.5, 2, 1)
    const rawSpeaker = body?.sid
    const sid = Number.isInteger(rawSpeaker) ? rawSpeaker : Number.parseInt(String(rawSpeaker), 10)
    const voice = runtimeFor(id)
    if (voice === undefined) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/unknown-voice', message: `没有安装音色 ${id || '(空)'}` } },
        { status: 404, headers: { 'cache-control': 'no-store' } },
      )
    }
    const speaker = Number.isInteger(sid) && sid >= 0 ? sid : 0
    let sampleRate
    try {
      const instance = await Promise.race([
        voice.open(),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('模型加载超时')), GENERATE_TIMEOUT_MS)
          timer.unref?.()
        }),
      ])
      sampleRate = instance.sampleRate || 22050
    } catch (error) {
      return Response.json(
        { ok: false, error: { code: 'read-aloud/model-failed', message: String(error?.message ?? error) } },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      )
    }
    let cancelled = false
    const stream = new ReadableStream({
      start: async (controller) => {
        const write = (bytes) => {
          if (cancelled) return
          try {
            controller.enqueue(new Uint8Array(bytes))
          } catch (error) {
            cancelled = true
          }
        }
        const header = Buffer.alloc(12)
        header.write('DRS1', 0, 'ascii')
        header.writeUInt32LE(sampleRate, 4)
        header.writeUInt32LE(1, 8)
        write(header)
        try {
          await Promise.race([
            voice.stream(text, rate, speaker, (samples) => {
              if (cancelled) return
              const frame = Buffer.allocUnsafe(4 + samples.length * 2)
              frame.writeUInt32LE(samples.length * 2, 0)
              for (let index = 0; index < samples.length; index += 1) {
                const value = Math.max(-1, Math.min(1, samples[index]))
                frame.writeInt16LE(Math.round(value < 0 ? value * 32768 : value * 32767), 4 + index * 2)
              }
              write(frame)
            }),
            new Promise((_, reject) => {
              const timer = setTimeout(() => reject(new Error('合成超时')), GENERATE_TIMEOUT_MS)
              timer.unref?.()
            }),
          ])
          if (!cancelled) controller.close()
        } catch (error) {
          if (!cancelled) {
            try {
              controller.error(error)
            } catch (nested) {
              /* stream already closed by the peer */
            }
          }
        }
      },
      cancel() {
        cancelled = true
      },
    })
    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'application/x-read-aloud-pcm',
        'cache-control': 'no-store',
        'x-read-aloud-sample-rate': String(sampleRate),
      },
    })
  }

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: `${ROUTE_BASE}/voices`,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => Response.json(listVoices(), { headers: { 'cache-control': 'no-store' } }),
      }),
    'read-aloud: voice directory route',
  )

  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: `${ROUTE_BASE}/speech`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: synthesize,
      }),
    'read-aloud: synthesis route',
  )
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: `${ROUTE_BASE}/stream`,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: streamSpeech,
      }),
    'read-aloud: streaming synthesis route',
  )

  // Drop loaded models when the plugin unloads: a native handle holds memory.
  ctx.effect(
    () => () => {
      runtimes.clear()
      cache.clear()
    },
    'read-aloud: release models',
  )
}

/** The Host half needs the Connection fetch-route owner. */
export const inject = ['connection']
